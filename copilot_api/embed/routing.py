"""Sends httpx requests for chosen origins to an in-process transport.

CombineWebUI creates a fresh httpx.AsyncClient for every upstream call. Wrapping
the constructor adds a mount for each origin, so requests to the Copilot
endpoint CombineWebUI already knows (http://localhost:4141/v1) reach the
in-process app instead of opening a TCP connection. Every other origin is left
alone, so Copilot's own calls to GitHub go out as before.
"""
import functools
import threading

import httpx

MAX_ORIGINS = 16
LOCAL_HOSTS = ("localhost", "127.0.0.1")
ORIGIN_SCHEMES = ("http://", "https://")

_lock = threading.Lock()
_original_init = None


def origins_for_port(port):
    """The loopback origins a local client would use for port."""
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError(f"Invalid port: {port!r}")
    return tuple(f"http://{host}:{port}" for host in LOCAL_HOSTS)


def _check_origins(origins):
    keys = tuple(origins or ())
    if not keys or len(keys) > MAX_ORIGINS:
        raise ValueError(f"Give between 1 and {MAX_ORIGINS} origins")
    for key in keys:
        if not isinstance(key, str) or not key.startswith(ORIGIN_SCHEMES):
            raise ValueError(f"Not an origin: {key!r}")
        if "/" in key.split("://", 1)[1]:
            raise ValueError(f"An origin has no path: {key!r}")
    return keys


def install_routes(transport, origins):
    """Routes origins to transport for every AsyncClient created from now on."""
    global _original_init
    if not isinstance(transport, httpx.AsyncBaseTransport):
        raise TypeError("transport must be an httpx.AsyncBaseTransport")
    keys = _check_origins(origins)
    with _lock:
        if _original_init is not None:
            raise RuntimeError("In-process routes are already installed")
        original = httpx.AsyncClient.__init__

        @functools.wraps(original)
        def init_with_routes(self, *args, **kwargs):
            mounts = dict(kwargs.get("mounts") or {})
            for key in keys:
                mounts.setdefault(key, transport)
            kwargs["mounts"] = mounts
            original(self, *args, **kwargs)

        httpx.AsyncClient.__init__ = init_with_routes
        _original_init = original


def uninstall_routes():
    """Restores the original constructor. Returns False when nothing was installed."""
    global _original_init
    with _lock:
        if _original_init is None:
            return False
        httpx.AsyncClient.__init__ = _original_init
        _original_init = None
        return True


def routes_installed():
    return _original_init is not None
