"""Finds a CombineWebUI clone inside this repo. Only looks at files; never imports."""
import os
from pathlib import Path

from copilot_api.config import logger

ENV_VAR = "COMBINE_WEBUI_DIR"
PREFERRED_NAMES = ("CombineWebUI", "combinewebui", "combine-webui")
MARKERS = ("main.py", "pages/index.html", "src/desktop/app.py")
MAX_SCANNED = 64
SKIPPED_NAMES = frozenset(("copilot_api", "src", "tests", "scripts", "node_modules", "__pycache__"))


def is_combine_webui(path):
    """True when path holds every CombineWebUI marker file."""
    try:
        root = Path(path)
        return root.is_dir() and all((root / marker).is_file() for marker in MARKERS)
    except (OSError, TypeError, ValueError):
        return False


def _from_env(environ):
    raw = str(environ.get(ENV_VAR, "") or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if is_combine_webui(path):
        return path.resolve()
    logger.warn(f"{ENV_VAR}={raw} is not a CombineWebUI clone; looking inside the repo instead")
    return None


def _preferred(base):
    for name in PREFERRED_NAMES:
        candidate = base / name
        if is_combine_webui(candidate):
            return candidate.resolve()
    return None


def _scan(base):
    try:
        entries = sorted(base.iterdir())
    except OSError as e:
        logger.debug(f"Could not list {base}: {e}")
        return None
    scanned = 0
    for entry in entries:
        if scanned >= MAX_SCANNED:
            break
        if entry.name.startswith(".") or entry.name in SKIPPED_NAMES:
            continue
        try:
            if not entry.is_dir():
                continue
        except OSError:
            continue
        scanned += 1
        if is_combine_webui(entry):
            return entry.resolve()
    return None


def find_combine_webui(root, env=None):
    """The CombineWebUI clone to embed, or None.

    Checks the COMBINE_WEBUI_DIR variable, then the preferred folder names, then
    up to MAX_SCANNED other non-hidden subfolders of root.
    """
    environ = os.environ if env is None else env
    found = _from_env(environ)
    if found is not None:
        return found
    base = Path(root)
    if not base.is_dir():
        return None
    return _preferred(base) or _scan(base)
