import argparse
import asyncio
import uvicorn
import json
import sys
import os
import pyperclip
from src.config import state, logger, ensure_paths, GITHUB_TOKEN_PATH
from src.services import setup_github_token, setup_copilot_token, get_copilot_usage
from src.utils import generate_env_script, cache_vscode_version
from src.server import app

async def cmd_auth(args):
    if args.verbose:
        logger.level = 5
        logger.info("Verbose logging enabled")
    state.show_token = args.show_token
    ensure_paths()
    await setup_github_token(force=True)
    logger.success(f"GitHub token written to {GITHUB_TOKEN_PATH}")

async def cmd_check_usage(args):
    ensure_paths()
    await setup_github_token()
    try:
        usage = await get_copilot_usage()
        snap = usage.get("quota_snapshots", {})
        premium = snap.get("premium_interactions", {})
        p_ent = premium.get("entitlement", 0)
        p_rem = premium.get("remaining", 0)
        p_used = p_ent - p_rem
        p_pct = (p_used / p_ent * 100) if p_ent > 0 else 0
        p_rem_pct = premium.get("percent_remaining", 0)
        
        def summarize(name, s):
            if not s: return f"{name}: N/A"
            t = s.get("entitlement", 0)
            u = t - s.get("remaining", 0)
            p = (u / t * 100) if t > 0 else 0
            r = s.get("percent_remaining", 0)
            return f"{name}: {u}/{t} used ({p:.1f}% used, {r:.1f}% remaining)"
        
        print(f"Copilot Usage (plan: {usage.get('copilot_plan')})")
        print(f"Quota resets: {usage.get('quota_reset_date')}\n")
        print(f"Quotas:")
        print(f"  Premium: {p_used}/{p_ent} used ({p_pct:.1f}% used, {p_rem_pct:.1f}% remaining)")
        print(f"  {summarize('Chat', snap.get('chat'))}")
        print(f"  {summarize('Completions', snap.get('completions'))}")
    except Exception as e:
        logger.error(f"Failed to fetch Copilot usage: {e}")
        sys.exit(1)

async def cmd_debug(args):
    import platform
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
            "GITHUB_TOKEN_PATH": str(GITHUB_TOKEN_PATH)
        },
        "tokenExists": GITHUB_TOKEN_PATH.exists() and len(GITHUB_TOKEN_PATH.read_text().strip()) > 0
    }
    if args.json:
        print(json.dumps(info, indent=2))
    else:
        print(f"copilot-api debug\n")
        print(f"Version: {info['version']}")
        print(f"Runtime: {info['runtime']['name']} {info['runtime']['version']} ({info['runtime']['platform']} {info['runtime']['arch']})\n")
        print(f"Paths:")
        print(f"- APP_DIR: {info['paths']['APP_DIR']}")
        print(f"- GITHUB_TOKEN_PATH: {info['paths']['GITHUB_TOKEN_PATH']}\n")
        print(f"Token exists: {'Yes' if info['tokenExists'] else 'No'}")

async def cmd_start(args):
    if args.proxy_env:
        state.use_proxy_env = True
        logger.debug("HTTP proxy configured from environment")

    if args.verbose:
        logger.level = 5
        logger.info("Verbose logging enabled")

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

    await setup_copilot_token()

    # Pre-cache models
    from src.services import get_models
    try:
        models = await get_models()
        state.models = models
        m_list = "\n".join(f"- {m['id']}" for m in models.get("data", []))
        logger.info(f"Available models: \n{m_list}")
    except Exception as e:
        logger.error(f"Failed to pre-cache models: {e}")

    server_url = f"http://localhost:{args.port}"

    if args.claude_code:
        print("Please select models manually or default to gpt-4o.")
        selected_model = "gpt-4o"
        selected_small = "gpt-4o"
        
        cmd = generate_env_script({
            "ANTHROPIC_BASE_URL": server_url,
            "ANTHROPIC_AUTH_TOKEN": "dummy",
            "ANTHROPIC_MODEL": selected_model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": selected_model,
            "ANTHROPIC_SMALL_FAST_MODEL": selected_small,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": selected_small,
            "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }, "claude")

        try:
            pyperclip.copy(cmd)
            logger.success("Copied Claude Code command to clipboard!")
        except:
            logger.warn("Failed to copy to clipboard. Here is the Claude Code command:")
            print(cmd)

    print(f"\n🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint={server_url}/usage\n")
    
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info" if args.verbose else "warning")

def main():
    parser = argparse.ArgumentParser(description="Copilot API Proxy")
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_p = subparsers.add_parser("auth", help="Run GitHub auth flow")
    auth_p.add_argument("-v", "--verbose", action="store_true")
    auth_p.add_argument("--show-token", action="store_true")

    check_p = subparsers.add_parser("check-usage", help="Show Copilot usage")
    
    debug_p = subparsers.add_parser("debug", help="Show debug info")
    debug_p.add_argument("--json", action="store_true")

    start_p = subparsers.add_parser("start", help="Start the API server")
    start_p.add_argument("-p", "--port", type=int, default=4141)
    start_p.add_argument("-v", "--verbose", action="store_true")
    start_p.add_argument("-a", "--account-type", default="individual")
    start_p.add_argument("--manual", action="store_true")
    start_p.add_argument("-r", "--rate-limit", type=int)
    start_p.add_argument("-w", "--wait", action="store_true")
    start_p.add_argument("-g", "--github-token")
    start_p.add_argument("-c", "--claude-code", action="store_true")
    start_p.add_argument("--show-token", action="store_true")
    start_p.add_argument("--proxy-env", action="store_true")

    args = parser.parse_args()

    if args.command == "auth":
        asyncio.run(cmd_auth(args))
    elif args.command == "check-usage":
        asyncio.run(cmd_check_usage(args))
    elif args.command == "debug":
        asyncio.run(cmd_debug(args))
    elif args.command == "start":
        asyncio.run(cmd_start(args))

if __name__ == "__main__":
    main()
