"""copilot-api command line entry point.

`start` runs the OpenAI- and Anthropic-compatible HTTP proxy. When a CombineWebUI
clone sits inside this repo, `start` opens CombineWebUI's desktop window instead,
with Copilot wired in-process and no port open. `--server` always runs the proxy.
"""
import argparse
import asyncio
import json
import platform
import sys
from pathlib import Path

from copilot_api.config import GITHUB_TOKEN_PATH, PROJECT_ROOT, ensure_paths, logger, state
from copilot_api.services import (
    cache_models, display_usage, get_copilot_usage, setup_copilot_token, setup_github_token
)
from copilot_api.utils import cache_vscode_version, generate_env_script

VERBOSE_LOG_LEVEL = 5
MIN_PORT = 1
MAX_PORT = 65535
DEFAULT_PORT = 4141
EXIT_USAGE = 2
CLAUDE_DEFAULT_MODEL = "gpt-4o"


def _port(value):
    port = int(value)
    if not MIN_PORT <= port <= MAX_PORT:
        raise argparse.ArgumentTypeError(f"port must be between {MIN_PORT} and {MAX_PORT}")
    return port


def _enable_verbose(verbose):
    if verbose:
        logger.level = VERBOSE_LOG_LEVEL
        logger.info("Verbose logging enabled")


# ---------------------------------------------------------------------------
# auth, check-usage, debug
# ---------------------------------------------------------------------------

async def cmd_auth(args):
    _enable_verbose(args.verbose)
    state.show_token = args.show_token
    ensure_paths()
    await setup_github_token(force=True)
    logger.success(f"GitHub token written to {GITHUB_TOKEN_PATH}")


def _summarize_quota(name, snapshot):
    if not snapshot:
        return f"{name}: N/A"
    total = snapshot.get("entitlement", 0)
    used = total - snapshot.get("remaining", 0)
    pct = (used / total * 100) if total > 0 else 0
    remaining = snapshot.get("percent_remaining", 0)
    return f"{name}: {used}/{total} used ({pct:.1f}% used, {remaining:.1f}% remaining)"


async def cmd_check_usage(args):
    ensure_paths()
    await setup_github_token()
    try:
        usage = await get_copilot_usage()
    except Exception as e:
        logger.error(f"Failed to fetch Copilot usage: {e}")
        sys.exit(1)
    snap = usage.get("quota_snapshots", {})
    print(f"Copilot Usage (plan: {usage.get('copilot_plan')})")
    print(f"Quota resets: {usage.get('quota_reset_date')}\n")
    print("Quotas:")
    print(f"  {_summarize_quota('Premium', snap.get('premium_interactions'))}")
    print(f"  {_summarize_quota('Chat', snap.get('chat'))}")
    print(f"  {_summarize_quota('Completions', snap.get('completions'))}")


async def _run_diagnostics(info):
    from copilot_api.services import get_copilot_token, get_github_user, get_models
    diagnostics = info["diagnostics"]
    try:
        user = await get_github_user()
    except Exception as e:
        diagnostics["github_user"] = {"status": "error", "message": str(e)}
        return
    diagnostics["github_user"] = {"status": "ok", "login": user.get("login")}
    try:
        token = await get_copilot_token()
    except Exception as e:
        diagnostics["copilot_token"] = {"status": "error", "message": str(e)}
        return
    state.copilot_token = token.get("token")
    diagnostics["copilot_token"] = {"status": "ok", "expires_at": token.get("expires_at")}
    try:
        models = await get_models()
        diagnostics["models"] = {"status": "ok", "count": len(models.get("data", []))}
    except Exception as e:
        diagnostics["models"] = {"status": "error", "message": str(e)}


def _print_debug(info):
    print("copilot-api debug\n")
    print(f"Version: {info['version']}")
    runtime = info["runtime"]
    print(f"Runtime: {runtime['name']} {runtime['version']} ({runtime['platform']} {runtime['arch']})\n")
    print("Paths:")
    for key, value in info["paths"].items():
        print(f"- {key}: {value}")
    print(f"\nToken exists: {'Yes' if info['tokenExists'] else 'No'}")
    if info["diagnostics"]:
        print("\nDiagnostics:")
        for key, value in info["diagnostics"].items():
            status = f"[{value.get('status', '').upper()}]"
            extra = value.get("login") or value.get("count") or value.get("message") or ""
            print(f"- {key}: {status} {extra}")


async def cmd_debug(args):
    token_exists = GITHUB_TOKEN_PATH.exists() and len(GITHUB_TOKEN_PATH.read_text().strip()) > 0
    from copilot_api.embed.detect import find_combine_webui
    combine_dir = find_combine_webui(PROJECT_ROOT)
    info = {
        "version": "python-port",
        "runtime": {
            "name": "python",
            "version": platform.python_version(),
            "platform": platform.system(),
            "arch": platform.machine()
        },
        "paths": {
            "APP_DIR": str(GITHUB_TOKEN_PATH.parent),
            "GITHUB_TOKEN_PATH": str(GITHUB_TOKEN_PATH),
            "COMBINE_WEBUI": str(combine_dir) if combine_dir else "not found (start runs the HTTP proxy)"
        },
        "tokenExists": token_exists,
        "diagnostics": {}
    }
    if token_exists:
        state.github_token = GITHUB_TOKEN_PATH.read_text().strip()
        await _run_diagnostics(info)
    if args.json:
        print(json.dumps(info, indent=2))
    else:
        _print_debug(info)


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

def _copy_claude_code_command(port):
    print(f"Please select models manually or default to {CLAUDE_DEFAULT_MODEL}.")
    cmd = generate_env_script({
        "ANTHROPIC_BASE_URL": f"http://localhost:{port}",
        "ANTHROPIC_AUTH_TOKEN": "dummy",
        "ANTHROPIC_MODEL": CLAUDE_DEFAULT_MODEL,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": CLAUDE_DEFAULT_MODEL,
        "ANTHROPIC_SMALL_FAST_MODEL": CLAUDE_DEFAULT_MODEL,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": CLAUDE_DEFAULT_MODEL,
        "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }, "claude")
    try:
        import pyperclip
        pyperclip.copy(cmd)
        logger.success("Copied Claude Code command to clipboard!")
    except Exception as e:
        logger.warn(f"Failed to copy to clipboard ({e}). Here is the Claude Code command:")
        print(cmd)


async def _precache_models():
    try:
        await cache_models()
    except Exception as e:
        logger.error(f"Failed to pre-cache models: {e}")
        return
    listing = "\n".join(f"- {m['id']}" for m in (state.models or {}).get("data", []))
    if listing:
        logger.info(f"Available models: \n{listing}")
    else:
        logger.warn("No models available from GitHub Copilot.")


async def _prepare_start(args, embedded=False):
    if args.proxy_env:
        state.use_proxy_env = True
        logger.debug("HTTP proxy configured from environment")

    _enable_verbose(args.verbose)

    state.account_type = args.account_type
    if state.account_type != "individual":
        logger.info(f"Using {state.account_type} plan GitHub account")

    state.manual_approve = args.manual
    state.rate_limit_seconds = args.rate_limit
    state.rate_limit_wait = args.wait
    state.show_token = args.show_token

    ensure_paths()

    await cache_vscode_version()
    if args.github_token:
        state.github_token = args.github_token
        logger.info("Using provided GitHub token")
    else:
        await setup_github_token()
    # The refresh loop starts on the loop that serves requests (server.asgi_app).
    # One started here would die when this short start-up loop closes.
    await setup_copilot_token(start_refresh=False)
    await _precache_models()

    if args.claude_code and not embedded:
        _copy_claude_code_command(args.port)

    await display_usage()


async def _prepare_embedded(args):
    await _prepare_start(args, embedded=True)


def _resolve_ui_dir(args):
    """The CombineWebUI clone to embed, or None to run the HTTP proxy."""
    if args.server:
        return None
    from copilot_api.embed.detect import MARKERS, find_combine_webui, is_combine_webui
    if args.ui_dir:
        path = Path(args.ui_dir).expanduser()
        if not is_combine_webui(path):
            logger.error(f"--ui-dir {path} is not a CombineWebUI clone (it needs {', '.join(MARKERS)}).")
            sys.exit(EXIT_USAGE)
        return path.resolve()
    return find_combine_webui(PROJECT_ROOT)


def _run_server(args):
    import uvicorn
    from copilot_api.server import asgi_app
    asyncio.run(_prepare_start(args))
    display_host = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print(f"\n🌐 OpenAI-compatible API: http://{display_host}:{args.port}/v1\n")
    uvicorn.run(asgi_app, host=args.host, port=args.port, log_level="info" if args.verbose else "warning")


def _run_embedded(args, combine_dir):
    if args.claude_code:
        logger.error("--claude-code needs the HTTP proxy. Run: python main.py start --server --claude-code")
        sys.exit(EXIT_USAGE)
    logger.info(f"Found CombineWebUI at {combine_dir}. Opening its desktop window with Copilot in-process; "
                "nothing will listen on a port. Use --server for the HTTP proxy.")
    from copilot_api.embed.launcher import run_embedded
    sys.exit(run_embedded(args, combine_dir, _prepare_embedded))


def cmd_start(args):
    combine_dir = _resolve_ui_dir(args)
    if combine_dir is None:
        _run_server(args)
    else:
        _run_embedded(args, combine_dir)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(description="Copilot API Proxy")
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_p = subparsers.add_parser("auth", help="Run GitHub auth flow")
    auth_p.add_argument("-v", "--verbose", action="store_true")
    auth_p.add_argument("--show-token", action="store_true")

    subparsers.add_parser("check-usage", help="Show Copilot usage")

    debug_p = subparsers.add_parser("debug", help="Show debug info")
    debug_p.add_argument("--json", action="store_true")

    start_p = subparsers.add_parser("start", help="Start the API server, or CombineWebUI's desktop window when it is cloned inside")
    start_p.add_argument("--host", default="127.0.0.1", help="Host to listen on (server mode)")
    start_p.add_argument("-p", "--port", type=_port, default=DEFAULT_PORT,
                         help="Port to listen on; in embedded mode, the localhost port that is routed in-process")
    start_p.add_argument("-v", "--verbose", action="store_true")
    start_p.add_argument("-a", "--account-type", default="individual")
    start_p.add_argument("--manual", action="store_true")
    start_p.add_argument("-r", "--rate-limit", type=int)
    start_p.add_argument("-w", "--wait", action="store_true")
    start_p.add_argument("-g", "--github-token")
    start_p.add_argument("-c", "--claude-code", action="store_true")
    start_p.add_argument("--show-token", action="store_true")
    start_p.add_argument("--proxy-env", action="store_true")
    start_p.add_argument("--server", action="store_true",
                         help="Always run the HTTP proxy, even when a CombineWebUI clone is present")
    start_p.add_argument("--ui-dir", help="Path to a CombineWebUI clone to embed")
    return parser


def main():
    args = build_parser().parse_args()
    if args.command == "auth":
        asyncio.run(cmd_auth(args))
    elif args.command == "check-usage":
        asyncio.run(cmd_check_usage(args))
    elif args.command == "debug":
        asyncio.run(cmd_debug(args))
    elif args.command == "start":
        cmd_start(args)


if __name__ == "__main__":
    main()
