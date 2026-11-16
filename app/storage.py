import asyncio
import logging
import sqlite3
import threading
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import urlsplit

log = logging.getLogger("storage")

SCHEMA = {
    "sqlite": [
        """CREATE TABLE IF NOT EXISTS plugs (
            plug_id TEXT PRIMARY KEY, name TEXT, ip TEXT, model TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""",
        """CREATE TABLE IF NOT EXISTS energy_hourly (
            plug_id TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
            wh INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (plug_id, day, hour))""",
        """CREATE TABLE IF NOT EXISTS energy_daily (
            plug_id TEXT NOT NULL, day TEXT NOT NULL, wh INTEGER NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (plug_id, day))""",
        """CREATE TABLE IF NOT EXISTS energy_monthly (
            plug_id TEXT NOT NULL, year INTEGER NOT NULL, month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
            wh INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (plug_id, year, month))""",
        """CREATE TABLE IF NOT EXISTS prices_hourly (
            day TEXT NOT NULL, hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
            eur_kwh REAL NOT NULL, PRIMARY KEY (day, hour))""",
    ],
    "postgres": [
        """CREATE TABLE IF NOT EXISTS plugs (
            plug_id TEXT PRIMARY KEY, name TEXT, ip TEXT, model TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
        """CREATE TABLE IF NOT EXISTS energy_hourly (
            plug_id TEXT NOT NULL, day DATE NOT NULL, hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
            wh INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (plug_id, day, hour))""",
        """CREATE TABLE IF NOT EXISTS energy_daily (
            plug_id TEXT NOT NULL, day DATE NOT NULL, wh INTEGER NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (plug_id, day))""",
        """CREATE TABLE IF NOT EXISTS energy_monthly (
            plug_id TEXT NOT NULL, year SMALLINT NOT NULL, month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
            wh INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (plug_id, year, month))""",
        """CREATE TABLE IF NOT EXISTS prices_hourly (
            day DATE NOT NULL, hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
            eur_kwh DOUBLE PRECISION NOT NULL, PRIMARY KEY (day, hour))""",
    ],
}


def describe_url(url: str) -> str:
    u = urlsplit(url)
    host = u.hostname or "?"
    port = f":{u.port}" if u.port else ""
    return f"postgres://{host}{port}{u.path or ''}"


class Store:
    def __init__(self, database_url: Optional[str], sqlite_path: Path):
        self.url = (database_url or "").strip()
        self.kind = "postgres" if self.url.startswith(("postgres://", "postgresql://")) else "sqlite"
        self.sqlite_path = sqlite_path
        self.target = describe_url(self.url) if self.kind == "postgres" else str(sqlite_path.name)
        self.greatest = "GREATEST" if self.kind == "postgres" else "MAX"
        self.error: Optional[str] = None
        self.last_sync: Optional[str] = None
        self._conn = None
        self._lock = threading.Lock()

    def _connect(self):
        if self._conn is not None:
            return self._conn
        if self.kind == "postgres":
            import psycopg
            self._conn = psycopg.connect(self.url, autocommit=True, connect_timeout=10)
        else:
            self._conn = sqlite3.connect(self.sqlite_path, check_same_thread=False, isolation_level=None)
            self._conn.execute("PRAGMA journal_mode=WAL")
        for ddl in SCHEMA[self.kind]:
            self._conn.execute(ddl)
        return self._conn

    def _run(self, sql: str, params: Iterable = (), many: bool = False, fetch: bool = False):
        if self.kind == "sqlite":
            sql = sql.replace("%s", "?")
        with self._lock:
            try:
                result = self._execute(self._connect(), sql, params, many, fetch)
            except Exception as exc:
                self.error = f"{type(exc).__name__}: {exc}"[:300]
                self._close_quietly()
                raise
            self.error = None
            return result

    def _execute(self, conn, sql: str, params: Iterable, many: bool, fetch: bool):
        if self.kind == "sqlite":
            if many:
                with conn:
                    conn.execute("BEGIN")
                    conn.executemany(sql, params)
                return None
            cur = conn.execute(sql, tuple(params))
            return cur.fetchall() if fetch else None
        with conn.cursor() as cur:
            if many:
                with conn.transaction():
                    cur.executemany(sql, list(params))
                return None
            cur.execute(sql, tuple(params))
            return cur.fetchall() if fetch else None

    def _close_quietly(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    def _d(self, d: date):
        return d if self.kind == "postgres" else d.isoformat()

    @staticmethod
    def _iso(v) -> str:
        return v.isoformat() if isinstance(v, date) else str(v)

    def _upsert_plug(self, plug_id: str, name: str, ip: str, model: str):
        self._run(
            """INSERT INTO plugs (plug_id, name, ip, model) VALUES (%s, %s, %s, %s)
               ON CONFLICT (plug_id) DO UPDATE SET name = excluded.name, ip = excluded.ip,
               model = excluded.model, updated_at = CURRENT_TIMESTAMP""",
            (plug_id, name, ip, model),
        )

    def _upsert_hourly(self, plug_id: str, rows: list[tuple[date, int, int]]):
        if rows:
            self._run(
                f"""INSERT INTO energy_hourly (plug_id, day, hour, wh) VALUES (%s, %s, %s, %s)
                    ON CONFLICT (plug_id, day, hour) DO UPDATE
                    SET wh = {self.greatest}(energy_hourly.wh, excluded.wh), updated_at = CURRENT_TIMESTAMP""",
                [(plug_id, self._d(d), h, wh) for d, h, wh in rows],
                many=True,
            )

    def _upsert_daily(self, plug_id: str, rows: list[tuple[date, int]]):
        if rows:
            self._run(
                f"""INSERT INTO energy_daily (plug_id, day, wh) VALUES (%s, %s, %s)
                    ON CONFLICT (plug_id, day) DO UPDATE
                    SET wh = {self.greatest}(energy_daily.wh, excluded.wh), updated_at = CURRENT_TIMESTAMP""",
                [(plug_id, self._d(d), wh) for d, wh in rows],
                many=True,
            )

    def _upsert_monthly(self, plug_id: str, year: int, months: list[int]):
        rows = [(plug_id, year, m + 1, int(wh)) for m, wh in enumerate(months[:12]) if wh]
        if rows:
            self._run(
                f"""INSERT INTO energy_monthly (plug_id, year, month, wh) VALUES (%s, %s, %s, %s)
                    ON CONFLICT (plug_id, year, month) DO UPDATE
                    SET wh = {self.greatest}(energy_monthly.wh, excluded.wh), updated_at = CURRENT_TIMESTAMP""",
                rows,
                many=True,
            )

    def _monthly_totals(self, plug_id: str, year: int) -> list[int]:
        out = [0] * 12
        for m, wh in self._run(
            "SELECT month, wh FROM energy_monthly WHERE plug_id = %s AND year = %s", (plug_id, year), fetch=True
        ):
            out[int(m) - 1] = int(wh)
        return out

    def _upsert_prices(self, rows: list[tuple[date, int, float]]):
        if rows:
            self._run(
                """INSERT INTO prices_hourly (day, hour, eur_kwh) VALUES (%s, %s, %s)
                   ON CONFLICT (day, hour) DO UPDATE SET eur_kwh = excluded.eur_kwh""",
                [(self._d(d), h, float(p)) for d, h, p in rows],
                many=True,
            )

    def _prices(self, start: date, end: date) -> dict[str, list]:
        out: dict[str, list] = {}
        for d, h, p in self._run(
            "SELECT day, hour, eur_kwh FROM prices_hourly WHERE day BETWEEN %s AND %s",
            (self._d(start), self._d(end)), fetch=True,
        ):
            out.setdefault(self._iso(d), [None] * 24)[int(h)] = float(p)
        return out

    def _hourly_range(self, plug_id: str, start: date, end: date) -> dict[str, list[int]]:
        out: dict[str, list[int]] = {}
        for d, h, wh in self._run(
            "SELECT day, hour, wh FROM energy_hourly WHERE plug_id = %s AND day BETWEEN %s AND %s",
            (plug_id, self._d(start), self._d(end)), fetch=True,
        ):
            out.setdefault(self._iso(d), [0] * 24)[int(h)] = int(wh)
        return out

    def _export(self, kind: str) -> list[tuple]:
        if kind == "hourly":
            return self._run(
                """SELECT h.day, h.hour, p.name, h.wh, pr.eur_kwh
                   FROM energy_hourly h JOIN plugs p ON p.plug_id = h.plug_id
                   LEFT JOIN prices_hourly pr ON pr.day = h.day AND pr.hour = h.hour
                   ORDER BY h.day, h.hour, p.name""", fetch=True)
        return self._run(
            """SELECT d.day, p.name, d.wh FROM energy_daily d JOIN plugs p ON p.plug_id = d.plug_id
               ORDER BY d.day, p.name""", fetch=True)

    def _hourly(self, plug_id: str, day: date) -> list[int]:
        rows = self._run(
            "SELECT hour, wh FROM energy_hourly WHERE plug_id = %s AND day = %s", (plug_id, self._d(day)), fetch=True
        )
        out = [0] * 24
        for h, wh in rows:
            out[int(h)] = int(wh)
        return out

    def _daily(self, plug_id: str, start: date, end: date) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        for d, wh in self._run(
            "SELECT day, wh FROM energy_daily WHERE plug_id = %s AND day BETWEEN %s AND %s",
            (plug_id, self._d(start), self._d(end)), fetch=True,
        ):
            out[self._iso(d)] = max(out[self._iso(d)], int(wh))
        for d, wh in self._run(
            "SELECT day, SUM(wh) FROM energy_hourly WHERE plug_id = %s AND day BETWEEN %s AND %s GROUP BY day",
            (plug_id, self._d(start), self._d(end)), fetch=True,
        ):
            out[self._iso(d)] = max(out[self._iso(d)], int(wh))
        return dict(out)

    def _stats(self) -> dict[str, Any]:
        (hourly,) = self._run("SELECT COUNT(*) FROM energy_hourly", fetch=True)[0]
        (daily,) = self._run("SELECT COUNT(*) FROM energy_daily", fetch=True)[0]
        first = self._run(
            "SELECT MIN(day) FROM (SELECT day FROM energy_hourly UNION ALL SELECT day FROM energy_daily) t", fetch=True
        )[0][0]
        last = self._run("SELECT MAX(updated_at) FROM energy_hourly", fetch=True)[0][0]
        return {"hourly_rows": int(hourly), "daily_rows": int(daily), "first_day": self._iso(first) if first else None,
                "last_write": local_time(last)}

    async def _bg(self, fn, *args):
        return await asyncio.to_thread(fn, *args)

    async def init(self):
        await self._bg(self._run, "SELECT 1")

    async def upsert_plug(self, *a):
        await self._bg(self._upsert_plug, *a)

    async def upsert_hourly(self, *a):
        await self._bg(self._upsert_hourly, *a)

    async def upsert_daily(self, *a):
        await self._bg(self._upsert_daily, *a)

    async def upsert_monthly(self, *a):
        await self._bg(self._upsert_monthly, *a)

    async def upsert_prices(self, rows):
        await self._bg(self._upsert_prices, rows)

    async def hourly(self, plug_id: str, day: date) -> list[int]:
        return await self._bg(self._hourly, plug_id, day)

    async def hourly_range(self, plug_id: str, start: date, end: date) -> dict[str, list[int]]:
        return await self._bg(self._hourly_range, plug_id, start, end)

    async def daily(self, plug_id: str, start: date, end: date) -> dict[str, int]:
        return await self._bg(self._daily, plug_id, start, end)

    async def prices(self, start: date, end: date) -> dict[str, list]:
        return await self._bg(self._prices, start, end)

    async def export(self, kind: str) -> list[tuple]:
        return await self._bg(self._export, kind)

    async def monthly(self, plug_id: str, year: int) -> list[int]:
        days = await self.daily(plug_id, date(year, 1, 1), date(year, 12, 31))
        out = await self._bg(self._monthly_totals, plug_id, year)
        sums = [0] * 12
        for d, wh in days.items():
            sums[int(d[5:7]) - 1] += wh
        return [max(a, b) for a, b in zip(out, sums)]

    async def status(self) -> dict[str, Any]:
        info: dict[str, Any] = {"backend": self.kind, "target": self.target, "last_sync": self.last_sync}
        try:
            info.update(await self._bg(self._stats))
            info["last_sync"] = self.last_sync or info.pop("last_write", None)
            info.pop("last_write", None)
            info["ok"] = True
        except Exception:
            info["ok"] = False
        info["error"] = self.error
        return info

    def close(self):
        with self._lock:
            self._close_quietly()


def local_time(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    return value.astimezone().strftime("%Y-%m-%dT%H:%M:%S")


def month_range(start: date, end: date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def days_back(n: int, today: Optional[date] = None) -> list[date]:
    today = today or date.today()
    return [today - timedelta(days=i) for i in range(n)]
