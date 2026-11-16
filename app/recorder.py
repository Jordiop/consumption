import asyncio
import logging
from datetime import date, datetime, timedelta
from typing import Awaitable, TypeVar

from .config import num
from .storage import Store, days_back, month_range
from .tapo import PlugEntry, PlugRegistry

log = logging.getLogger("recorder")

HOURLY_RETENTION_DAYS = 7
DAILY_RETENTION_DAYS = 95
DAILY_SURE_DAYS = 85

T = TypeVar("T")


async def limited(call: Awaitable[T]) -> T:
    return await asyncio.wait_for(call, timeout=num("REQUEST_TIMEOUT"))


class Recorder:
    def __init__(self, registry: PlugRegistry, store: Store, every_minutes: float):
        self.registry = registry
        self.store = store
        self.every = max(1.0, every_minutes) * 60
        self._task: asyncio.Task | None = None
        self._full_done: set[str] = set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        for _ in range(30):
            if all(p.mac for p in self.registry.plugs.values()):
                break
            await asyncio.sleep(2)
        while True:
            try:
                await self.sync()
            except Exception:
                log.exception("Error copiando el historial a la base de datos")
            pending = any(p.mac not in self._full_done for p in self.registry.plugs.values())
            await asyncio.sleep(min(self.every, 60) if pending else self.every)

    async def sync(self) -> None:
        if self.registry.credentials is None:
            return
        for entry in list(self.registry.plugs.values()):
            if not entry.mac:
                continue
            full = entry.mac not in self._full_done
            try:
                await self._sync_plug(entry, full)
                if full:
                    self._full_done.add(entry.mac)
            except Exception as exc:
                log.warning("No se pudo copiar el historial de %s: %s %s", entry.name or entry.ip, type(exc).__name__, exc)
                if isinstance(exc, asyncio.TimeoutError):
                    await entry.close()
        self.store.last_sync = datetime.now().isoformat(timespec="seconds")

    async def _sync_plug(self, entry: PlugEntry, full: bool) -> None:
        cred = self.registry.credentials
        assert cred is not None and entry.mac is not None
        today, now_hour = date.today(), datetime.now().hour
        await self.store.upsert_plug(entry.mac, entry.name, entry.ip, entry.state.get("model"))

        hourly = []
        for d in days_back(HOURLY_RETENTION_DAYS if full else 2, today):
            for h, wh in enumerate(await limited(entry.hours(cred, d))):
                if d == today and h > now_hour:
                    break
                hourly.append((d, h, int(wh or 0)))
        await self.store.upsert_hourly(entry.mac, hourly)

        daily = []
        first = today - timedelta(days=DAILY_RETENTION_DAYS if full else 1)
        for y, m in month_range(first, today):
            for i, wh in enumerate(await limited(entry.days_of_month(cred, y, m))):
                d = date(y, m, i + 1)
                if first <= d <= today and (wh or (today - d).days <= DAILY_SURE_DAYS):
                    daily.append((d, int(wh or 0)))
        await self.store.upsert_daily(entry.mac, daily)

        for y in sorted({today.year - 1, today.year} if full else {today.year}):
            await self.store.upsert_monthly(entry.mac, y, await limited(entry.months_of_year(cred, y)))
        log.info("Historial de %s copiado: %d horas, %d días", entry.name or entry.ip, len(hourly), len(daily))
