import asyncio
import calendar
import json
import logging
import os
import time
from datetime import date, datetime, timedelta
from typing import Any, Awaitable, Callable, Optional

from plugp100 import (
    AuthCredential,
    DeviceConnectConfiguration,
    TapoDiscovery,
    TapoPlug,
    connect,
    connect_discovered_device,
)
from plugp100.api.requests.tapo_request import TapoRequest
from plugp100.components.energy import EnergyComponent

from .config import data_dir, num

log = logging.getLogger("tapo")

HOURS, DAYS, MONTHS = 60, 1440, 43200
NO_CREDENTIALS = "Faltan TAPO_EMAIL y TAPO_PASSWORD en el archivo .env"


def get_credentials() -> Optional[AuthCredential]:
    email, password = os.environ.get("TAPO_EMAIL"), os.environ.get("TAPO_PASSWORD")
    return AuthCredential(email, password) if email and password else None


def error_text(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:300]


async def connect_by_ip(ip: str, credentials: AuthCredential):
    try:
        discovered = await TapoDiscovery.single_scan(ip, timeout=3)
    except Exception:
        discovered = None
    if discovered is not None:
        device = await connect_discovered_device(discovered, credentials)
    else:
        device = await connect(DeviceConnectConfiguration(host=ip, credentials=credentials))
    await device.update()
    return device


def _ts(d: date) -> int:
    return int(datetime(d.year, d.month, d.day).timestamp())


class PlugEntry:
    def __init__(self, ip: str, name: Optional[str] = None, pos: Optional[list[float]] = None, mac: Optional[str] = None):
        self.ip = ip
        self.name = name
        self.mac = mac
        self.pos = pos
        self.device = None
        self.state: dict[str, Any] = {}
        self.online = False
        self.error: Optional[str] = None
        self.last_update: Optional[float] = None
        self._lock = asyncio.Lock()

    async def _energy(self, credentials: AuthCredential, start: date, end: date, interval: int) -> list[int]:
        async with self._lock:
            if self.device is None:
                self.device = await connect_by_ip(self.ip, credentials)
            request = TapoRequest(
                method="get_energy_data",
                params={"start_timestamp": _ts(start), "end_timestamp": _ts(end), "interval": interval},
            )
            result = (await self.device.client.execute_raw_request(request)).get_or_raise()
        return list(result.get("data", []))

    async def hours(self, credentials: AuthCredential, day: date) -> list[int]:
        return (await self._energy(credentials, day, day + timedelta(days=1), HOURS))[:24]

    async def days_of_month(self, credentials: AuthCredential, year: int, month: int) -> list[int]:
        last = calendar.monthrange(year, month)[1]
        return (await self._energy(credentials, date(year, month, 1), date(year, month, last), DAYS))[:last]

    async def months_of_year(self, credentials: AuthCredential, year: int) -> list[int]:
        return (await self._energy(credentials, date(year, 1, 1), date(year, 12, 31), MONTHS))[:12]

    async def poll(self, credentials: AuthCredential) -> None:
        async with self._lock:
            try:
                await asyncio.wait_for(self._poll(credentials), timeout=num("POLL_TIMEOUT"))
            except asyncio.TimeoutError:
                self.online = False
                self.error = "El enchufe no respondió a tiempo"
                await self.close()

    async def _poll(self, credentials: AuthCredential) -> None:
        try:
            if self.device is None:
                self.device = await connect_by_ip(self.ip, credentials)
            else:
                await self.device.update()
            self.state = snapshot(self.device)
            self.name = self.state.get("nickname") or self.name
            self.mac = self.state.get("mac") or self.mac
            self.online = True
            self.error = None
            self.last_update = time.time()
        except Exception as exc:
            self.online = False
            self.error = error_text(exc)
            await self.close()

    async def close(self) -> None:
        if self.device is not None:
            try:
                await self.device.client.close()
            except Exception:
                pass
            self.device = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ip": self.ip,
            "name": self.name,
            "pos": self.pos,
            "online": self.online,
            "error": self.error,
            "last_update": self.last_update,
            **self.state,
        }


def snapshot(device) -> dict[str, Any]:
    info = device.device_info
    is_plug = isinstance(device, TapoPlug)
    data: dict[str, Any] = {
        "nickname": device.nickname,
        "model": info.model,
        "mac": info.mac,
        "device_id": info.device_id,
        "firmware": info.firmware_version,
        "rssi": info.rssi,
        "signal_level": info.signal_level,
        "is_plug": is_plug,
        "is_on": device.is_on if is_plug else None,
        "energy_monitoring": False,
    }
    energy = device.get_component(EnergyComponent)
    if energy is not None:
        e, p = energy.energy_info, energy.power_info
        power_w = p.current_power if p and p.current_power is not None else None
        if power_w is None and e and e.current_power is not None:
            power_w = e.current_power / 1000
        data.update(
            energy_monitoring=True,
            power_w=power_w,
            today_energy_wh=e.today_energy if e else None,
            month_energy_wh=e.month_energy if e else None,
            today_runtime_min=e.today_runtime if e else None,
            month_runtime_min=e.month_runtime if e else None,
        )
    return data


class PlugRegistry:
    def __init__(self, interval: float):
        self.credentials = get_credentials()
        self.interval = interval
        self.plugs: dict[str, PlugEntry] = {}
        self.file = data_dir() / "plugs.json"
        self._task: Optional[asyncio.Task] = None
        self._load()

    def _load(self) -> None:
        if self.file.exists():
            for item in json.loads(self.file.read_text(encoding="utf-8")):
                self.plugs[item["ip"]] = PlugEntry(item["ip"], item.get("name"), item.get("pos"), item.get("mac"))

    def _save(self) -> None:
        data = [
            {"ip": p.ip, "name": p.name}
            | ({"mac": p.mac} if p.mac else {})
            | ({"pos": p.pos} if p.pos is not None else {})
            for p in self.plugs.values()
        ]
        self.file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def _require_credentials(self) -> AuthCredential:
        if self.credentials is None:
            raise RuntimeError(NO_CREDENTIALS)
        return self.credentials

    async def add(self, ip: str) -> PlugEntry:
        if ip in self.plugs:
            return self.plugs[ip]
        entry = PlugEntry(ip)
        await entry.poll(self._require_credentials())
        if not entry.online:
            await entry.close()
            raise ConnectionError(entry.error or "No se pudo conectar")
        self.plugs[ip] = entry
        self._save()
        return entry

    def set_pos(self, ip: str, pos: Optional[list[float]]) -> Optional[PlugEntry]:
        entry = self.plugs.get(ip)
        if entry is None:
            return None
        entry.pos = [round(pos[0], 1), round(pos[1], 1)] if pos is not None else None
        self._save()
        return entry

    async def remove(self, ip: str) -> bool:
        entry = self.plugs.pop(ip, None)
        if entry is None:
            return False
        await entry.close()
        self._save()
        return True

    async def scan(self, timeout: int = 4) -> list[dict[str, Any]]:
        found = {d.ip: d for d in await TapoDiscovery.scan(timeout=timeout) if d.ip}
        return [
            {"ip": d.ip, "model": d.device_model, "type": d.device_type, "mac": d.mac, "registered": d.ip in self.plugs}
            for d in found.values()
        ]

    async def poll_all(self) -> None:
        if self.credentials is None:
            for p in self.plugs.values():
                p.online, p.error = False, NO_CREDENTIALS
            return
        known = {p.ip: p.mac for p in self.plugs.values()}
        await asyncio.gather(*(p.poll(self.credentials) for p in list(self.plugs.values())))
        if any(p.mac != known.get(p.ip) for p in self.plugs.values()):
            self._save()

    async def _loop(self) -> None:
        while True:
            try:
                await self.poll_all()
            except Exception:
                log.exception("Error en el sondeo")
            await asyncio.sleep(self.interval)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        for p in self.plugs.values():
            await p.close()

    async def history(self, year: int, month: int) -> list[dict[str, Any]]:
        async def fetch(p: PlugEntry, cred: AuthCredential):
            return {"months": await p.months_of_year(cred, year), "days": await p.days_of_month(cred, year, month)}

        return await self._per_plug(fetch)

    async def history_hours(self, day: date) -> list[dict[str, Any]]:
        async def fetch(p: PlugEntry, cred: AuthCredential):
            return {"hours": await p.hours(cred, day)}

        return await self._per_plug(fetch)

    async def _per_plug(self, fetch: Callable[[PlugEntry, AuthCredential], Awaitable[dict]]) -> list[dict[str, Any]]:
        async def one(p: PlugEntry) -> dict[str, Any]:
            base = {"ip": p.ip, "name": p.name}
            if self.credentials is None:
                return {**base, "error": NO_CREDENTIALS}
            if p.online and not p.state.get("energy_monitoring"):
                return {**base, "error": "Sin medición de consumo"}
            try:
                return {**base, **await asyncio.wait_for(fetch(p, self.credentials), timeout=num("REQUEST_TIMEOUT"))}
            except asyncio.TimeoutError:
                await p.close()
                return {**base, "error": "El enchufe tarda demasiado en responder"}
            except Exception as exc:
                return {**base, "error": error_text(exc)}

        return list(await asyncio.gather(*(one(p) for p in list(self.plugs.values()))))

    def list(self) -> list[dict[str, Any]]:
        return [p.to_dict() for p in self.plugs.values()]
