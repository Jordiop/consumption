import calendar
import logging
import time
from datetime import date, timedelta
from typing import Any, Optional

import aiohttp

from .storage import Store

log = logging.getLogger("prices")

REE_URL = "https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real"
PVPC_ID = "1001"
RETRY_SECONDS = 600

FIXED_HOLIDAYS = {(1, 1), (1, 6), (5, 1), (8, 15), (10, 12), (11, 1), (12, 6), (12, 8), (12, 25)}
PERIODS = ("P1", "P2", "P3")


def period(day: date, hour: int) -> str:
    if day.weekday() >= 5 or (day.month, day.day) in FIXED_HOLIDAYS or hour < 8:
        return "P3"
    if 10 <= hour < 14 or 18 <= hour < 22:
        return "P1"
    return "P2"


def complete(prices: Optional[list]) -> bool:
    return bool(prices) and sum(p is not None for p in prices) >= 23


def mean(values) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def empty_periods() -> dict[str, dict[str, float]]:
    return {p: {"wh": 0, "eur": 0.0} for p in PERIODS}


async def fetch_ree(start: date, end: date) -> list[tuple[date, int, float]]:
    params = {"start_date": f"{start}T00:00", "end_date": f"{end}T23:59", "time_trunc": "hour"}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25)) as session:
        async with session.get(REE_URL, params=params, headers={"Accept": "application/json"}) as resp:
            data = await resp.json(content_type=None)
    if "errors" in data:
        raise RuntimeError(f"REE: {data['errors']}")
    series = next((i for i in data.get("included", []) if str(i.get("id")) == PVPC_ID), None)
    if series is None:
        return []
    buckets: dict[tuple[str, int], list[float]] = {}
    for v in series["attributes"]["values"]:
        ts = v["datetime"]
        buckets.setdefault((ts[:10], int(ts[11:13])), []).append(float(v["value"]) / 1000)
    return [(date.fromisoformat(d), h, sum(p) / len(p)) for (d, h), p in sorted(buckets.items())]


class Prices:
    def __init__(self, store: Store):
        self.store = store
        self._last_try: dict[date, float] = {}

    async def range(self, start: date, end: date) -> dict[str, list]:
        have = await self.store.prices(start, end)
        need_end = min(end, date.today() + timedelta(days=1))
        days = [start + timedelta(days=i) for i in range((need_end - start).days + 1)]
        missing = [d for d in days if not complete(have.get(d.isoformat()))]
        if not missing:
            return have
        now = time.monotonic()
        if now - self._last_try.get(missing[0], -RETRY_SECONDS) < RETRY_SECONDS:
            return have
        self._last_try[missing[0]] = now
        try:
            await self.store.upsert_prices(await fetch_ree(missing[0], missing[-1]))
            have = await self.store.prices(start, end)
        except Exception as exc:
            log.warning("No se pudieron descargar los precios PVPC: %s %s", type(exc).__name__, exc)
        return have

    async def day(self, d: date) -> dict[str, Any]:
        prices = (await self.range(d, d)).get(d.isoformat(), [None] * 24)
        return {"date": d.isoformat(), "eur_kwh": prices, "periods": [period(d, h) for h in range(24)],
                "published": complete(prices)}


async def month_cost(store: Store, mac: str, year: int, month: int,
                     month_prices: dict[str, list], month_total_wh: int) -> dict[str, Any]:
    first_d, last_d = month_bounds(year, month)
    days_wh = await store.daily(mac, first_d, last_d)
    hours = await store.hourly_range(mac, first_d, last_d)
    month_mean = mean(p for day in month_prices.values() for p in day)

    days_eur: list[Optional[float]] = []
    exact: list[Optional[bool]] = []
    per = empty_periods()
    exact_wh = 0
    for d in range(1, last_d.day + 1):
        dd = date(year, month, d)
        iso = dd.isoformat()
        wh = days_wh.get(iso, 0)
        pr = month_prices.get(iso)
        day_mean = mean(pr) if pr else None
        if not wh or day_mean is None or pr is None:
            days_eur.append(0.0 if not wh else None)
            exact.append(None)
            continue
        hrs = hours.get(iso)
        if hrs and sum(hrs) >= 0.9 * wh:
            eur = 0.0
            for h, h_wh in enumerate(hrs):
                cost = h_wh / 1000 * (pr[h] if pr[h] is not None else day_mean)
                eur += cost
                slot = per[period(dd, h)]
                slot["wh"] += h_wh
                slot["eur"] += cost
            exact_wh += sum(hrs)
            exact.append(True)
        else:
            eur = wh / 1000 * day_mean
            exact.append(False)
        days_eur.append(round(eur, 4))

    counted = sum(days_wh.values())
    total_wh = max(month_total_wh, counted)
    rest_wh = total_wh - counted
    month_eur = sum(e for e in days_eur if e) + (rest_wh / 1000 * month_mean if rest_wh > 0 and month_mean else 0)
    return {"days": days_eur, "exact": exact, "month": round(month_eur, 4), "wh": total_wh,
            "exact_wh": exact_wh, "periods": per}


async def cost_report(store: Store, prices: Prices, plugs: list[tuple[str, str, str]], year: int, month: int) -> dict[str, Any]:
    today = date.today()
    price_cache: dict[int, dict[str, list]] = {}

    async def prices_of(m: int) -> dict[str, list]:
        if m not in price_cache:
            price_cache[m] = await prices.range(*month_bounds(year, m))
        return price_cache[m]

    out_plugs = []
    totals = empty_periods()
    exact_wh = total_wh = 0
    for ip, name, mac in plugs:
        yearly = await store.monthly(mac, year)
        months = [0.0] * 12
        cur: dict[str, Any] = {}
        for m in range(1, 13):
            if m != month and (date(year, m, 1) > today or not yearly[m - 1]):
                continue
            result = await month_cost(store, mac, year, m, await prices_of(m), yearly[m - 1])
            months[m - 1] = result["month"]
            if m == month:
                cur = result
        for p in PERIODS:
            totals[p]["wh"] += cur["periods"][p]["wh"]
            totals[p]["eur"] += cur["periods"][p]["eur"]
        exact_wh += cur["exact_wh"]
        total_wh += cur["wh"]
        out_plugs.append({"ip": ip, "name": name, "months": [round(v, 4) for v in months],
                          "days": cur["days"], "exact": cur["exact"], "periods": cur["periods"]})

    by_period: dict[str, list[float]] = {p: [] for p in PERIODS}
    for iso, day in (await prices_of(month)).items():
        d = date.fromisoformat(iso)
        for h, v in enumerate(day):
            if v is not None:
                by_period[period(d, h)].append(v)
    return {
        "year": year, "month": month, "plugs": out_plugs, "periods": totals,
        "avg_price": {p: mean(v) for p, v in by_period.items()} | {"all": mean(x for v in by_period.values() for x in v)},
        "coverage": exact_wh / total_wh if total_wh else 0,
    }
