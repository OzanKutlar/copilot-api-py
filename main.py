import argparse
import asyncio
import uvicorn
import json
import sys
import os
import pyperclip
from src.config import state, logger, ensure_paths, GITHUB_TOKEN_PATH
from src.services import setup_github_token, setup_copilot_token, get_copilot_usage, display_usage
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

async def cmd_token_counter(args):
    from src.token_counter import calculate_all_chat_tokens
    from rich.table import Table
    from rich.panel import Panel
    ensure_paths()
    try:
        stats = calculate_all_chat_tokens()
        if args.json:
            print(json.dumps(stats, indent=2))
            return

        totals = stats.get("totals", {})
        total_inp = totals.get("input_tokens", 0)
        total_out = totals.get("output_tokens", 0)
        grand_total = totals.get("total_tokens", 0)
        total_turns = totals.get("turns", 0)
        total_convs = totals.get("conversations", 0)

        console.print("\n[bold green]📊 Chat Log Token Counter Summary[/bold green]")
        console.print(Panel(
            f"[bold]Total Tokens:[/bold] {grand_total:,}  |  " +
            f"[bold cyan]Input:[/bold cyan] {total_inp:,}  |  " +
            f"[bold green]Output:[/bold green] {total_out:,}\n" +
            f"[dim]Scanned {total_convs:,} conversations ({total_turns:,} assistant turns)[/dim]",
            expand=False
        ))

        # Provider Table
        p_table = Table(title="Token Usage by Provider", header_style="bold cyan")
        p_table.add_column("Provider", style="bold")
        p_table.add_column("Input Tokens", justify="right", style="cyan")
        p_table.add_column("Output Tokens", justify="right", style="green")
        p_table.add_column("Total Tokens", justify="right", style="bold yellow")
        p_table.add_column("Turns", justify="right", style="dim")

        for p in stats.get("by_provider", []):
            p_table.add_row(
                p["name"],
                f"{p['input_tokens']:,}",
                f"{p['output_tokens']:,}",
                f"{p['total_tokens']:,}",
                f"{p['turns']:,}"
            )
        console.print(p_table)

        # Model Table
        m_table = Table(title="Token Usage by Model", header_style="bold magenta")
        m_table.add_column("Model ID", style="bold")
        m_table.add_column("Provider", style="dim")
        m_table.add_column("Input Tokens", justify="right", style="cyan")
        m_table.add_column("Output Tokens", justify="right", style="green")
        m_table.add_column("Total Tokens", justify="right", style="bold yellow")
        m_table.add_column("Turns", justify="right", style="dim")

        for m in stats.get("by_model", []):
            m_table.add_row(
                m["model_id"],
                m["provider_name"],
                f"{m['input_tokens']:,}",
                f"{m['output_tokens']:,}",
                f"{m['total_tokens']:,}",
                f"{m['turns']:,}"
            )
        console.print(m_table)
        print("")
    except Exception as e:
        logger.error(f"Failed to tally chat tokens: {e}")
        sys.exit(1)

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
    token_exists = GITHUB_TOKEN_PATH.exists() and len(GITHUB_TOKEN_PATH.read_text().strip()) > 0
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
        "tokenExists": token_exists,
        "diagnostics": {}
    }
    
    if token_exists:
        state.github_token = GITHUB_TOKEN_PATH.read_text().strip()
        try:
            from src.services import get_github_user, get_copilot_token, get_models
            user = await get_github_user()
            info["diagnostics"]["github_user"] = {"status": "ok", "login": user.get("login")}
            try:
                c_tok = await get_copilot_token()
                state.copilot_token = c_tok.get("token")
                info["diagnostics"]["copilot_token"] = {"status": "ok", "expires_at": c_tok.get("expires_at")}
                try:
                    models = await get_models()
                    m_count = len(models.get("data", []))
                    info["diagnostics"]["models"] = {"status": "ok", "count": m_count}
                except Exception as me:
                    info["diagnostics"]["models"] = {"status": "error", "message": str(me)}
            except Exception as ce:
                info["diagnostics"]["copilot_token"] = {"status": "error", "message": str(ce)}
        except Exception as ue:
            info["diagnostics"]["github_user"] = {"status": "error", "message": str(ue)}
            
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
        if "diagnostics" in info and info["diagnostics"]:
            print("\nDiagnostics:")
            for k, v in info["diagnostics"].items():
                status_str = f"[{v.get('status').upper()}]"
                extra = v.get('login') or v.get('count') or v.get('message') or ''
                print(f"- {k}: {status_str} {extra}")

async def _prepare_start(args):
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
    state.only_endpoint = getattr(args, "endpoint_only", False)

    ensure_paths()

    if state.only_endpoint:
        logger.info("Starting in Endpoint-Only mode (skipping GitHub Copilot auth)")
    else:
        await cache_vscode_version()
        if args.github_token:
            state.github_token = args.github_token
            logger.info("Using provided GitHub token")
        else:
            await setup_github_token()
        await setup_copilot_token()

    # Pre-cache models
    from src.services import cache_models
    try:
        await cache_models()
        m_list = "\n".join(f"- {m['id']}" for m in state.models.get("data", []))
        if m_list:
            logger.info(f"Available models: \n{m_list}")
        else:
            logger.warn("No models available. Add custom endpoints in Settings.")
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

    if not state.only_endpoint:
        await display_usage()

def cmd_start(args):
    asyncio.run(_prepare_start(args))
    server_url = f"http://{args.host}:{args.port}" if args.host != "0.0.0.0" else f"http://localhost:{args.port}"
    print(f"\n🌐 Usage Viewer: {server_url}/\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info" if args.verbose else "warning")

def main():
    parser = argparse.ArgumentParser(description="Copilot API Proxy")
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_p = subparsers.add_parser("auth", help="Run GitHub auth flow")
    auth_p.add_argument("-v", "--verbose", action="store_true")
    auth_p.add_argument("--show-token", action="store_true")

    check_p = subparsers.add_parser("check-usage", help="Show Copilot usage")

    token_p = subparsers.add_parser("token-counter", help="Tally tokens from chat logs by model and provider")
    token_p.add_argument("--json", action="store_true", help="Output token counter stats as JSON")
    
    debug_p = subparsers.add_parser("debug", help="Show debug info")
    debug_p.add_argument("--json", action="store_true")

    start_p = subparsers.add_parser("start", help="Start the API server")
    start_p.add_argument("--host", default="127.0.0.1", help="Host to listen on")
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
    start_p.add_argument("-e", "--endpoint-only", action="store_true", help="Run only with custom endpoints (no GitHub Copilot)")

    args = parser.parse_args()

    if args.command == "auth":
        asyncio.run(cmd_auth(args))
    elif args.command == "check-usage":
        asyncio.run(cmd_check_usage(args))
    elif args.command == "token-counter":
        asyncio.run(cmd_token_counter(args))
    elif args.command == "debug":
        asyncio.run(cmd_debug(args))
    elif args.command == "start":
        cmd_start(args)

if __name__ == "__main__":
    main()
