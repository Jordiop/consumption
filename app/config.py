import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
WEB_DIR = ROOT / "web"

DEFAULTS = {
    "POLL_INTERVAL": 3,
    "SYNC_MINUTES": 15,
    "POLL_TIMEOUT": 15,
    "REQUEST_TIMEOUT": 45,
    "PORT": 8080,
}


def load_env() -> None:
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def num(name: str) -> float:
    value = os.environ.get(name, "").strip()
    return float(value) if value else float(DEFAULTS[name])


def data_dir() -> Path:
    d = Path(os.environ.get("DATA_DIR") or ROOT / "data")
    d.mkdir(parents=True, exist_ok=True)
    return d
