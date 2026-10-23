"""Embedded mode: CombineWebUI's desktop window and the Copilot app in one process.

Nothing listens on a port. CombineWebUI serves its page over an in-process
app:// scheme and reaches its own FastAPI app over QWebChannel. Here, its calls
to the Copilot endpoint (http://localhost:<port>/v1) are routed to this repo's
FastAPI app through InProcessTransport, so the only network traffic left is
outbound HTTPS to GitHub and Copilot.
"""
import asyncio
import importlib
import importlib.util
import sys
from pathlib import Path

from copilot_api.config import logger, state
from copilot_api.embed.routing import install_routes, origins_for_port, uninstall_routes
from copilot_api.embed.transport import InProcessTransport

COMBINE_PACKAGE = "src"
COMBINE_VERBOSE_LEVEL = 4
DESKTOP_REQUIREMENTS = "requirements-desktop.txt"
EXIT_FAILURE = 1
EXIT_INTERRUPTED = 130


class EmbedError(RuntimeError):
    """Embedded mode cannot start. The message is shown to the user as is."""


def _package_dir(module):
    origin = getattr(module, "__file__", None)
    return Path(origin).resolve().parent if origin else None


def activate_combine(combine_dir):
    """Makes `src` resolve to the clone's package. Raises EmbedError otherwise."""
    root = Path(combine_dir).resolve()
    expected = root / COMBINE_PACKAGE
    loaded = sys.modules.get(COMBINE_PACKAGE)
    if loaded is not None:
        if _package_dir(loaded) == expected:
            return root
        raise EmbedError(f"A different '{COMBINE_PACKAGE}' package is already loaded "
                         f"({_package_dir(loaded)}); CombineWebUI cannot be embedded in this process.")
    entry = str(root)
    if entry in sys.path:
        sys.path.remove(entry)
    sys.path.insert(0, entry)
    importlib.invalidate_caches()
    spec = importlib.util.find_spec(COMBINE_PACKAGE)
    location = Path(spec.origin).resolve().parent if spec is not None and spec.origin else None
    if location != expected:
        raise EmbedError(f"'{COMBINE_PACKAGE}' resolves to {location}, not to {expected}.")
    return root


def _configure_combine(verbose):
    """What CombineWebUI's own `main.py desktop` would set up before the window."""
    combine_config = importlib.import_module(f"{COMBINE_PACKAGE}.config")
    if verbose:
        combine_config.logger.level = COMBINE_VERBOSE_LEVEL
    combine_config.state.use_proxy_env = bool(state.use_proxy_env)
    combine_config.ensure_paths()


def _load_desktop(root):
    try:
        return importlib.import_module(f"{COMBINE_PACKAGE}.desktop.app")
    except ImportError as e:
        raise EmbedError(f"CombineWebUI's desktop mode could not load ({e}). "
                         f"Install it with: pip install -r {root / DESKTOP_REQUIREMENTS}") from e


def _prepare(args, prepare):
    """Sign-in, token and model cache, on a short start-up loop. Returns an exit code or None."""
    try:
        asyncio.run(prepare(args))
    except KeyboardInterrupt:
        logger.warn("Start-up cancelled.")
        return EXIT_INTERRUPTED
    except Exception as e:
        logger.error(f"Copilot start-up failed: {type(e).__name__}: {e}")
        return EXIT_FAILURE
    return None


def run_embedded(args, combine_dir, prepare):
    """Runs Copilot start-up, then CombineWebUI's window. Returns the exit code.

    prepare is an async callable taking args: the same start-up as server mode.
    """
    if not callable(prepare):
        raise TypeError("prepare must be an async callable")
    failed = _prepare(args, prepare)
    if failed is not None:
        return failed
    from copilot_api.server import asgi_app
    try:
        root = activate_combine(combine_dir)
        install_routes(InProcessTransport(asgi_app), origins_for_port(args.port))
    except (EmbedError, RuntimeError, TypeError, ValueError) as e:
        logger.error(str(e))
        return EXIT_FAILURE
    try:
        _configure_combine(args.verbose)
        desktop = _load_desktop(root)
        logger.success(f"Copilot is wired in-process for http://localhost:{args.port}/v1. Opening the window.")
        return int(desktop.run_desktop() or 0)
    except EmbedError as e:
        logger.error(str(e))
        return EXIT_FAILURE
    finally:
        uninstall_routes()
