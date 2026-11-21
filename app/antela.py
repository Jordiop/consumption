"""Bombilla Antela (Tuya) por la red local, con horarios programados desde el servidor."""

import asyncio
import colorsys
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime
from typing import Any, Optional

import tinytuya

from .config import data_dir

log = logging.getLogger("antela")

# Puntos de datos (DPS) de una bombilla Tuya RGB+CCT
DP_ON, DP_MODE, DP_BRIGHT, DP_TEMP, DP_COLOUR, DP_COUNTDOWN = "20", "21", "22", "23", "24", "26"
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def pct_to_bright(pct: float) -> int:
    return round(10 + (max(1, min(100, pct)) - 1) / 99 * 990)


def bright_to_pct(v: int) -> int:
    return max(1, min(100, round((v - 10) / 990 * 99 + 1)))


def parse_colour(raw: str) -> tuple[float, float, float]:
    """'hhhhssssvvvv' → (h 0-360, s 0-1, v 0-1)."""
    try:
        return int(raw[0:4], 16), int(raw[4:8], 16) / 1000, int(raw[8:12], 16) / 1000
    except (TypeError, ValueError):
        return 0, 1, 1


def encode_colour(h: float, s: float, v: float) -> str:
    return f"{round(h) % 360:04x}{round(s * 1000):04x}{round(max(.01, v) * 1000):04x}"


def hex_from_hs(h: float, s: float) -> str:
    r, g, b = colorsys.hsv_to_rgb(h / 360, s, 1)
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))


def hs_from_hex(color: str) -> tuple[float, float]:
    r, g, b = (int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, s, _ = colorsys.rgb_to_hsv(r, g, b)
    return h * 360, s


class BadInput(ValueError):
    pass


def validate_change(data: dict) -> dict:
    out: dict[str, Any] = {}
    if "on" in data:
        if not isinstance(data["on"], bool):
            raise BadInput("on debe ser true o false")
        out["on"] = data["on"]
    for key, lo in (("brightness", 1), ("temp", 0)):
        if data.get(key) is not None:
            v = data[key]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not lo <= v <= 100:
                raise BadInput(f"{key} debe estar entre {lo} y 100")
            out[key] = v
    if data.get("color") is not None:
        if not isinstance(data["color"], str) or not HEX_RE.match(data["color"]):
            raise BadInput("color debe ser #rrggbb")
        out["color"] = data["color"].lower()
    if data.get("mode") is not None:
        if data["mode"] not in ("white", "colour"):
            raise BadInput("mode debe ser white o colour")
        out["mode"] = data["mode"]
    return out


def validate_schedules(items) -> list[dict]:
    if not isinstance(items, list) or len(items) > 50:
        raise BadInput("Se esperaba una lista de horarios (máximo 50)")
    out = []
    for s in items:
        if not isinstance(s, dict):
            raise BadInput("Horario no válido")
        t = str(s.get("time", ""))
        if not TIME_RE.match(t):
            raise BadInput(f"Hora no válida: {t or 'vacía'} (usa HH:MM)")
        days = s.get("days")
        if not isinstance(days, list) or not days or not all(isinstance(d, int) and 0 <= d <= 6 for d in days):
            raise BadInput(f"El horario de las {t} necesita al menos un día")
        action = validate_change({k: s.get(k) for k in ("on", "brightness", "temp")})
        if "on" not in action:
            raise BadInput(f"El horario de las {t} necesita encender o apagar")
        out.append({
            "id": str(s.get("id") or uuid.uuid4().hex[:8])[:32],
            "time": t,
            "days": sorted(set(days)),
            "enabled": s.get("enabled", True) is not False,
            **action,
        })
    return sorted(out, key=lambda s: s["time"])


class Bulb:
    def __init__(self, interval: float = 10):
        self.ip = os.environ.get("ANTELA_IP", "").strip()
        self.dev_id = os.environ.get("ANTELA_ID", "").strip()
        self.key = os.environ.get("ANTELA_KEY", "").strip()
        self.version = float(os.environ.get("ANTELA_VERSION") or 3.5)
        self.name = os.environ.get("ANTELA_NAME", "").strip() or "Bombilla"
        self.interval = interval
        self.file = data_dir() / "bulb.json"
        self.schedules: list[dict] = []
        self.pos: Optional[list[float]] = None
        self.dps: dict[str, Any] = {}
        self.online = False
        self.error: Optional[str] = None
        self.updated: Optional[float] = None
        self._lock = asyncio.Lock()
        self._ran: set[str] = set()
        self._tasks: list[asyncio.Task] = []
        self._device = None
        self._load()

    @property
    def configured(self) -> bool:
        return bool(self.ip and self.dev_id and self.key)

    def _load(self) -> None:
        if not self.file.exists():
            return
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
            self.schedules = validate_schedules(data.get("schedules", []))
            pos = data.get("pos")
            self.pos = pos if isinstance(pos, list) and len(pos) == 2 else None
        except Exception as exc:
            log.warning("No se pudo leer %s: %s", self.file, exc)

    def _save(self) -> None:
        data = {"pos": self.pos, "schedules": self.schedules}
        self.file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def save_schedules(self, items) -> list[dict]:
        self.schedules = validate_schedules(items)
        self._save()
        return self.schedules

    def set_pos(self, pos: Optional[list[float]]) -> None:
        self.pos = pos
        self._save()

    # --- comunicación con la bombilla (bloqueante, va en un hilo) ---

    def _dev(self):
        if self._device is None:
            d = tinytuya.BulbDevice(self.dev_id, self.ip, self.key, version=self.version)
            d.set_socketTimeout(5)
            d.set_socketRetryLimit(2)
            self._device = d
        return self._device

    async def _call(self, fn: str, *args) -> dict:
        async with self._lock:
            result = await asyncio.to_thread(getattr(self._dev(), fn), *args)
        if not isinstance(result, dict) or "Error" in result:
            err = (result or {}).get("Error", "sin respuesta") if isinstance(result, dict) else "sin respuesta"
            self.online, self.error = False, f"La bombilla no responde: {err}"
            raise ConnectionError(self.error)
        self.online, self.error, self.updated = True, None, time.time()
        if isinstance(result.get("dps"), dict):
            self.dps.update(result["dps"])
        return result

    async def refresh(self) -> None:
        if self.configured:
            await self._call("status")

    async def apply(self, change: dict) -> dict:
        if not self.configured:
            raise ConnectionError("Faltan ANTELA_IP, ANTELA_ID y ANTELA_KEY en el archivo .env")
        if not self.dps:
            await self.refresh()
        want_white = change.get("mode") == "white" or "temp" in change
        colour = "color" in change or change.get("mode") == "colour" or (
            self.dps.get(DP_MODE) == "colour" and "brightness" in change and not want_white)
        dps: dict[str, Any] = {}
        if colour:
            h, s, v = parse_colour(self.dps.get(DP_COLOUR, ""))
            if "color" in change:
                h, s = hs_from_hex(change["color"])
            if "brightness" in change:
                v = change["brightness"] / 100
            dps[DP_MODE], dps[DP_COLOUR] = "colour", encode_colour(h, s, v)
        else:
            if want_white:
                dps[DP_MODE] = "white"
            if "brightness" in change:
                dps[DP_BRIGHT] = pct_to_bright(change["brightness"])
            if "temp" in change:
                dps[DP_TEMP] = round(change["temp"] * 10)
        if "on" in change:
            dps[DP_ON] = change["on"]
        elif dps:
            dps[DP_ON] = True  # cambiar el color o el brillo enciende la luz
        if dps:
            await self._call("set_multiple_values", dps)
            self.dps.update(dps)
        return self.to_dict()

    def to_dict(self) -> dict[str, Any]:
        d = self.dps
        h, s, v = parse_colour(d.get(DP_COLOUR, ""))
        mode = d.get(DP_MODE, "white")
        return {
            "configured": self.configured,
            "name": self.name,
            "ip": self.ip,
            "online": self.online,
            "error": self.error,
            "on": bool(d.get(DP_ON)),
            "mode": mode,
            "brightness": round(v * 100) if mode == "colour" else bright_to_pct(int(d.get(DP_BRIGHT, 1000))),
            "temp": round(int(d.get(DP_TEMP, 500)) / 10),
            "color": hex_from_hs(h, s),
            "countdown": int(d.get(DP_COUNTDOWN) or 0),
            "updated": self.updated,
            "pos": self.pos,
            "schedules": self.schedules,
        }

    # --- bucles de fondo ---

    async def _poll_loop(self) -> None:
        while True:
            try:
                await self.refresh()
            except Exception as exc:
                self.online, self.error = False, str(exc)[:300]
                self._device = None  # reconectar desde cero la próxima vez
            await asyncio.sleep(self.interval)

    async def _schedule_loop(self) -> None:
        while True:
            now = datetime.now()
            hm, today = now.strftime("%H:%M"), now.date().isoformat()
            for s in self.schedules:
                key = f"{s['id']}:{today}:{s['time']}"
                if not s["enabled"] or s["time"] != hm or now.weekday() not in s["days"] or key in self._ran:
                    continue
                self._ran.add(key)
                action = {k: s[k] for k in ("on", "brightness", "temp") if k in s}
                if not action["on"]:
                    action = {"on": False}
                for attempt in range(3):
                    try:
                        await self.apply(action)
                        log.info("Horario %s aplicado: %s", s["time"], action)
                        break
                    except Exception as exc:
                        log.warning("Horario %s, intento %d fallido: %s", s["time"], attempt + 1, exc)
                        self._device = None
                        await asyncio.sleep(5)
            if len(self._ran) > 500:
                self._ran = {k for k in self._ran if today in k}
            await asyncio.sleep(15)

    def start(self) -> None:
        if not self.configured:
            log.info("Bombilla Antela sin configurar (faltan ANTELA_IP, ANTELA_ID o ANTELA_KEY)")
            return
        self._tasks = [asyncio.create_task(self._poll_loop()), asyncio.create_task(self._schedule_loop())]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._device is not None:
            try:
                self._device.close()
            except Exception:
                pass
