import csv
import io
import ipaddress
import json
import logging
import math
import os
import re
from datetime import date
from itertools import zip_longest

from aiohttp import web

from .antela import BadInput, Bulb, validate_change
from .config import WEB_DIR, data_dir, load_env, num
from .prices import Prices, cost_report, month_bounds
from .recorder import Recorder
from .storage import Store
from .tapo import PlugRegistry

log = logging.getLogger("server")
routes = web.RouteTableDef()


class BadRequest(Exception):
    pass


def error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


@web.middleware
async def middleware(request: web.Request, handler):
    try:
        response = await handler(request)
    except BadRequest as exc:
        return error(str(exc))
    if request.path == "/" or request.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


async def body(request: web.Request) -> dict:
    try:
        data = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("El cuerpo de la petición no es JSON válido")
    if not isinstance(data, dict):
        raise BadRequest("Se esperaba un objeto JSON")
    return data


def year_month(request: web.Request) -> tuple[int, int]:
    today = date.today()
    try:
        year = int(request.query.get("year", today.year))
        month = int(request.query.get("month", today.month))
    except ValueError:
        raise BadRequest("Año o mes no válido")
    if not 1 <= month <= 12 or not 2000 <= year <= 2100:
        raise BadRequest("Año o mes no válido")
    return year, month


def query_day(request: web.Request) -> date:
    try:
        return date.fromisoformat(request.query.get("date", date.today().isoformat()))
    except ValueError:
        raise BadRequest("Fecha no válida (usa AAAA-MM-DD)")


def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_point(p) -> bool:
    return isinstance(p, list) and len(p) == 2 and all(is_number(v) for v in p)


def is_polygon(points) -> bool:
    return isinstance(points, list) and len(points) >= 3 and all(is_point(p) for p in points)


class PlanFiles:
    def __init__(self):
        d = data_dir()
        self.current = d / "plan.json"
        self.original = d / "plan.original.json"
        self.backup = d / "plan.json.bak"

    def load(self):
        if not self.current.exists():
            return {"house": None, "rooms": []}
        return json.loads(self.current.read_text(encoding="utf-8"))

    def save(self, plan: dict) -> None:
        if self.current.exists():
            text = self.current.read_text(encoding="utf-8")
            if not self.original.exists():
                self.original.write_text(text, encoding="utf-8")
            self.backup.write_text(text, encoding="utf-8")
        text = json.dumps(plan, indent=2, ensure_ascii=False)
        self.current.write_text(re.sub(r"\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]", r"[\1, \2]", text), encoding="utf-8")

    def reset(self):
        if not self.original.exists():
            return None
        self.current.write_text(self.original.read_text(encoding="utf-8"), encoding="utf-8")
        return self.load()


def validate_plan(plan) -> dict:
    if not isinstance(plan, dict) or not is_polygon(plan.get("house")) or not isinstance(plan.get("rooms"), list):
        raise BadRequest("El plano necesita 'house' (polígono) y 'rooms' (lista)")
    if not plan["rooms"]:
        raise BadRequest("El plano necesita al menos una sala")
    for r in plan["rooms"]:
        if not isinstance(r, dict) or not r.get("id") or not str(r.get("name", "")).strip() or not is_polygon(r.get("points")):
            label = (str(r.get("name") or "").strip() or r.get("id")) if isinstance(r, dict) else r
            raise BadRequest(f"Sala no válida: {label or 'sin nombre'}")
    if "name" in plan and not isinstance(plan["name"], str):
        raise BadRequest("El nombre de la casa debe ser texto")
    return plan


@routes.get("/")
async def index(_request: web.Request):
    return web.FileResponse(WEB_DIR / "index.html")


@routes.get("/api/plugs")
async def list_plugs(request: web.Request):
    return web.json_response(request.app["registry"].list())


@routes.post("/api/plugs")
async def add_plug(request: web.Request):
    ip = str((await body(request)).get("ip", "")).strip()
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise BadRequest("IP no válida")
    try:
        entry = await request.app["registry"].add(ip)
    except Exception as exc:
        return error(f"No se pudo conectar a {ip}: {exc}", 502)
    return web.json_response(entry.to_dict(), status=201)


@routes.patch("/api/plugs/{ip}")
async def update_plug(request: web.Request):
    pos = (await body(request)).get("pos")
    if pos is not None and not is_point(pos):
        raise BadRequest("pos debe ser [x, y] en cm o null")
    entry = request.app["registry"].set_pos(request.match_info["ip"], pos)
    if entry is None:
        return error("Enchufe no registrado", 404)
    return web.json_response(entry.to_dict())


@routes.delete("/api/plugs/{ip}")
async def delete_plug(request: web.Request):
    ok = await request.app["registry"].remove(request.match_info["ip"])
    return web.json_response({"ok": ok}, status=200 if ok else 404)


@routes.post("/api/scan")
async def scan(request: web.Request):
    try:
        return web.json_response(await request.app["registry"].scan())
    except Exception as exc:
        return error(str(exc), 500)


@routes.get("/api/bulb")
async def bulb_status(request: web.Request):
    return web.json_response(request.app["bulb"].to_dict())


@routes.patch("/api/bulb")
async def bulb_change(request: web.Request):
    try:
        change = validate_change(await body(request))
    except BadInput as exc:
        raise BadRequest(str(exc))
    try:
        return web.json_response(await request.app["bulb"].apply(change))
    except ConnectionError as exc:
        return error(str(exc), 502)


@routes.put("/api/bulb/pos")
async def bulb_pos(request: web.Request):
    pos = (await body(request)).get("pos")
    if pos is not None and not is_point(pos):
        raise BadRequest("pos debe ser [x, y] en cm o null")
    request.app["bulb"].set_pos(pos)
    return web.json_response({"pos": pos})


@routes.put("/api/bulb/schedules")
async def bulb_schedules(request: web.Request):
    data = await body(request)
    try:
        schedules = request.app["bulb"].save_schedules(data.get("schedules"))
    except BadInput as exc:
        raise BadRequest(str(exc))
    return web.json_response({"schedules": schedules})


@routes.get("/api/plan")
async def get_plan(request: web.Request):
    return web.json_response(request.app["plan"].load())


@routes.put("/api/plan")
async def save_plan(request: web.Request):
    plan = validate_plan(await body(request))
    request.app["plan"].save(plan)
    return web.json_response(plan)


@routes.post("/api/plan/reset")
async def reset_plan(request: web.Request):
    plan = request.app["plan"].reset()
    if plan is None:
        return error("No hay cambios guardados: el plano ya es el original", 404)
    return web.json_response(plan)


async def merge_db(app: web.Application, plugs: list[dict], fetch) -> None:
    store: Store = app["store"]
    registry: PlugRegistry = app["registry"]
    for p in plugs:
        entry = registry.plugs.get(p["ip"])
        if entry is None or not entry.mac:
            continue
        try:
            stored = await fetch(store, entry.mac)
        except Exception as exc:
            log.warning("No se pudo leer el historial guardado: %s", exc)
            return
        for field, values in stored.items():
            current = p.get(field) or []
            p[field] = [max(int(a or 0), int(b or 0)) for a, b in zip_longest(current, values, fillvalue=0)][: len(values)]


@routes.get("/api/history")
async def history(request: web.Request):
    year, month = year_month(request)
    first, last = month_bounds(year, month)
    plugs = await request.app["registry"].history(year, month)

    async def from_db(store: Store, mac: str):
        days = await store.daily(mac, first, last)
        return {
            "months": await store.monthly(mac, year),
            "days": [days.get(date(year, month, d).isoformat(), 0) for d in range(1, last.day + 1)],
        }

    await merge_db(request.app, plugs, from_db)
    return web.json_response({"year": year, "month": month, "plugs": plugs})


@routes.get("/api/history/day")
async def history_day(request: web.Request):
    day = query_day(request)
    plugs = await request.app["registry"].history_hours(day)

    async def from_db(store: Store, mac: str):
        return {"hours": await store.hourly(mac, day)}

    await merge_db(request.app, plugs, from_db)
    return web.json_response({"date": day.isoformat(), "plugs": plugs})


@routes.get("/api/prices")
async def prices_day(request: web.Request):
    return web.json_response(await request.app["prices"].day(query_day(request)))


@routes.get("/api/cost")
async def cost(request: web.Request):
    year, month = year_month(request)
    plugs = [(p.ip, p.name, p.mac) for p in request.app["registry"].plugs.values() if p.mac]
    try:
        report = await cost_report(request.app["store"], request.app["prices"], plugs, year, month)
    except Exception as exc:
        log.exception("Error calculando el coste")
        return error(f"No se pudo calcular el coste: {exc}", 500)
    return web.json_response(report)


def decimal(v, digits: int) -> str:
    return "" if v is None else f"{v:.{digits}f}".replace(".", ",")


@routes.get("/api/export")
async def export(request: web.Request):
    kind = request.query.get("kind", "daily")
    if kind not in ("daily", "hourly"):
        raise BadRequest("kind debe ser daily o hourly")
    rows = await request.app["store"].export(kind)
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    if kind == "hourly":
        w.writerow(["fecha", "hora", "enchufe", "wh", "precio_eur_kwh", "coste_eur"])
        for day, hour, name, wh, price in rows:
            w.writerow([str(day), f"{int(hour):02d}:00", name, int(wh), decimal(price, 5),
                        decimal(None if price is None else wh / 1000 * price, 5)])
    else:
        w.writerow(["fecha", "enchufe", "wh"])
        for day, name, wh in rows:
            w.writerow([str(day), name, int(wh)])
    return web.Response(
        body=("﻿" + out.getvalue()).encode("utf-8"),
        content_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="consumo-{kind}-{date.today()}.csv"'},
    )


@routes.post("/api/sync")
async def sync_now(request: web.Request):
    await request.app["recorder"].sync()
    return web.json_response(await request.app["store"].status())


@routes.get("/api/settings")
async def server_settings(request: web.Request):
    registry: PlugRegistry = request.app["registry"]
    return web.json_response({
        "poll_interval": num("POLL_INTERVAL"), "sync_minutes": num("SYNC_MINUTES"),
        "poll_timeout": num("POLL_TIMEOUT"), "request_timeout": num("REQUEST_TIMEOUT"),
        "port": int(num("PORT")), "plugs": len(registry.plugs), "credentials": registry.credentials is not None,
    })


@routes.get("/api/storage")
async def storage_status(request: web.Request):
    return web.json_response(await request.app["store"].status())


async def on_startup(app: web.Application):
    app["plan"] = PlanFiles()
    registry = app["registry"] = PlugRegistry(interval=num("POLL_INTERVAL"))
    if registry.credentials is None:
        log.warning("Faltan TAPO_EMAIL y TAPO_PASSWORD: no se podrá hablar con los enchufes")
    registry.start()
    bulb = app["bulb"] = Bulb()
    bulb.start()

    store = app["store"] = Store(os.environ.get("DATABASE_URL"), data_dir() / os.environ.get("SQLITE_PATH", "consum.db"))
    try:
        await store.init()
        log.info("Historial guardado en %s (%s)", store.kind, store.target)
    except Exception as exc:
        log.error("No se pudo abrir la base de datos %s: %s", store.target, exc)
    app["prices"] = Prices(store)
    recorder = app["recorder"] = Recorder(registry, store, num("SYNC_MINUTES"))
    recorder.start()


async def on_cleanup(app: web.Application):
    await app["recorder"].stop()
    await app["registry"].stop()
    await app["bulb"].stop()
    app["store"].close()


def main():
    logging.basicConfig(level=logging.INFO)
    load_env()
    app = web.Application(middlewares=[middleware])
    app.add_routes(routes)
    app.router.add_static("/assets", WEB_DIR / "assets")
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(num("PORT")))
