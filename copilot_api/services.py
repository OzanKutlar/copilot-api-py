"""Calls to GitHub and Copilot: auth, tokens, models, usage and embeddings.

Chat completions live in copilot_api.chat. create_chat_completions here is a
thin alias for code that still imports it from this module.
"""
import asyncio
import time
import urllib.parse

import httpx

from copilot_api.config import (
    logger, state, GITHUB_BASE_URL, GITHUB_API_BASE_URL, GITHUB_CLIENT_ID, GITHUB_APP_SCOPES,
    standard_headers, github_headers, copilot_headers, copilot_base_url, GITHUB_TOKEN_PATH
)
from copilot_api.utils import HTTPError, safe_json, log_http_request, log_http_response

# GitHub expires a device code after 15 minutes, so this many polls is plenty.
MAX_POLL_ATTEMPTS = 300
# Copilot token refresh. The loop is bounded, but the bound covers years of uptime.
DEFAULT_REFRESH_SECONDS = 1500
REFRESH_MARGIN_SECONDS = 60
REFRESH_RETRY_SECONDS = 60
MIN_REFRESH_DELAY_SECONDS = 5
MAX_REFRESH_CYCLES = 100000
USAGE_CACHE_SECONDS = 60


def get_client(timeout: float = 60.0):
    # With proxy_env, httpx reads HTTP_PROXY / HTTPS_PROXY from the environment.
    return httpx.AsyncClient(trust_env=state.use_proxy_env, timeout=timeout)


async def get_device_code() -> dict:
    url = f"{GITHUB_BASE_URL}/login/device/code"
    payload = {"client_id": GITHUB_CLIENT_ID, "scope": GITHUB_APP_SCOPES}
    headers = standard_headers()
    log_http_request("POST", url, headers, payload)
    async with get_client() as client:
        resp = await client.post(url, headers=headers, json=payload)
        log_http_response(resp, "device_code")
        if resp.status_code != 200:
            err_data = safe_json(resp, {"raw": resp.text})
            raise HTTPError(f"Failed to get device code (HTTP {resp.status_code}): {resp.text}", resp.status_code, err_data)
        data = safe_json(resp)
        if not isinstance(data, dict) or "device_code" not in data:
            raise HTTPError(f"Invalid device code response (HTTP {resp.status_code}): {resp.text}", resp.status_code, data)
        return data


async def poll_access_token(device_code: dict) -> str:
    sleep_duration = device_code.get("interval", 5) + 1
    logger.debug(f"Polling access token with interval of {sleep_duration}s")
    url = f"{GITHUB_BASE_URL}/login/oauth/access_token"
    payload = {
        "client_id": GITHUB_CLIENT_ID,
        "device_code": device_code["device_code"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
    }
    headers = standard_headers()

    async with get_client() as client:
        for _ in range(MAX_POLL_ATTEMPTS):
            log_http_request("POST", url, headers, payload)
            resp = await client.post(url, headers=headers, json=payload)
            log_http_response(resp, "poll_access_token")
            if resp.status_code != 200:
                logger.error(f"Failed to poll access token (HTTP {resp.status_code}): {resp.text}")
                await asyncio.sleep(sleep_duration)
                continue

            data = safe_json(resp)
            # Fallback for url-encoded responses if the JSON accept header is ignored upstream
            if not isinstance(data, dict) and resp.text:
                parsed_qs = urllib.parse.parse_qs(resp.text)
                if "access_token" in parsed_qs:
                    data = {"access_token": parsed_qs["access_token"][0]}

            # Only the keys: the values can include the new access token.
            shown = sorted(data) if isinstance(data, dict) else type(data).__name__
            logger.debug(f"Polling access token response fields: {shown}")

            if isinstance(data, dict):
                if "access_token" in data:
                    return data["access_token"]
                if data.get("error") == "authorization_pending":
                    await asyncio.sleep(sleep_duration)
                    continue
                if data.get("error") == "slow_down":
                    sleep_duration += 5
                    await asyncio.sleep(sleep_duration)
                    continue
                if "error" in data:
                    logger.warn(f"OAuth polling status: {data.get('error_description') or data.get('error')}")

            await asyncio.sleep(sleep_duration)
    raise HTTPError("Timed out waiting for GitHub authorization. Run the command again to get a new code.", 408)


async def get_github_user():
    url = f"{GITHUB_API_BASE_URL}/user"
    headers = github_headers()
    max_retries = 3
    for attempt in range(max_retries):
        log_http_request("GET", url, headers)
        async with get_client() as client:
            resp = await client.get(url, headers=headers)
            log_http_response(resp, f"get_github_user_attempt_{attempt + 1}")
            if resp.status_code in (502, 503, 504) and attempt < max_retries - 1:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            if resp.status_code != 200:
                err_data = safe_json(resp, {"raw": resp.text})
                raise HTTPError(f"Failed to get GitHub user (HTTP {resp.status_code}): {resp.text}", resp.status_code, err_data)
            data = safe_json(resp)
            if not isinstance(data, dict) or "login" not in data:
                raise HTTPError(f"Invalid user response from GitHub (HTTP {resp.status_code}): {resp.text}", resp.status_code, data)
            return data


async def setup_github_token(force: bool = False):
    github_token = None
    if GITHUB_TOKEN_PATH.exists():
        github_token = GITHUB_TOKEN_PATH.read_text().strip()

    if github_token and not force:
        state.github_token = github_token
        if state.show_token:
            logger.info(f"GitHub token: {github_token}")
        try:
            user = await get_github_user()
            logger.info(f"Logged in as {user.get('login')}")
            return
        except Exception as e:
            logger.warn(f"Cached token invalid or failed to get user: {e}")

    logger.info("Not logged in, getting new access token")
    device_code = await get_device_code()
    logger.debug(f"Device code issued; it expires in {device_code.get('expires_in')}s")
    logger.info(f"Please enter the code \"{device_code['user_code']}\" in {device_code['verification_uri']}")

    token = await poll_access_token(device_code)
    GITHUB_TOKEN_PATH.write_text(token)
    state.github_token = token

    if state.show_token:
        logger.info(f"GitHub token: {token}")
    try:
        user = await get_github_user()
        logger.info(f"Logged in as {user.get('login')}")
    except Exception as e:
        logger.warn(f"Could not fetch GitHub user profile: {e}")
        logger.info("Authenticated successfully.")


async def get_copilot_token() -> dict:
    url = f"{GITHUB_API_BASE_URL}/copilot_internal/v2/token"
    headers = github_headers()
    log_http_request("GET", url, headers)
    async with get_client() as client:
        resp = await client.get(url, headers=headers)
        log_http_response(resp, "get_copilot_token")
        if resp.status_code != 200:
            err_data = safe_json(resp, {"raw": resp.text})
            raise HTTPError(f"Failed to get Copilot token (HTTP {resp.status_code}): {resp.text}", resp.status_code, err_data)
        data = safe_json(resp)
        if not isinstance(data, dict) or "token" not in data:
            raise HTTPError(f"Invalid response from Copilot token endpoint (HTTP {resp.status_code})", resp.status_code, data)
        return data


# ---------------------------------------------------------------------------
# Copilot token refresh
#
# The loop must run on the event loop that serves requests. Start-up happens in
# a short asyncio.run(), whose loop closes before uvicorn (server mode) or
# CombineWebUI's bridge thread (embedded mode) takes over, so a task created
# there would silently die. server.asgi_app calls ensure_refresh_loop() instead.
# ---------------------------------------------------------------------------

def _refresh_seconds(data):
    value = data.get("refresh_in") if isinstance(data, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return DEFAULT_REFRESH_SECONDS
    return int(value)


def _store_copilot_token(data):
    state.copilot_token = data["token"]
    state.copilot_refresh_in = _refresh_seconds(data)
    state.copilot_token_fetched_at = time.monotonic()


def _first_refresh_delay():
    refresh_in = state.copilot_refresh_in or DEFAULT_REFRESH_SECONDS
    fetched = state.copilot_token_fetched_at
    elapsed = (time.monotonic() - fetched) if fetched is not None else 0.0
    return max(refresh_in - REFRESH_MARGIN_SECONDS - elapsed, MIN_REFRESH_DELAY_SECONDS)


async def _refresh_loop(first_delay):
    delay = first_delay
    for _ in range(MAX_REFRESH_CYCLES):
        await asyncio.sleep(delay)
        logger.debug("Refreshing Copilot token")
        try:
            data = await get_copilot_token()
        except Exception as e:
            logger.error(f"Failed to refresh Copilot token: {e}")
            delay = REFRESH_RETRY_SECONDS
            continue
        _store_copilot_token(data)
        delay = max(state.copilot_refresh_in - REFRESH_MARGIN_SECONDS, REFRESH_RETRY_SECONDS)
        logger.debug("Copilot token refreshed")
        if state.show_token:
            logger.info(f"Refreshed Copilot token: {data['token']}")
    logger.warn("The Copilot token refresh loop reached its cycle limit; tokens now refresh only when a request is rejected.")


def _cancel_refresh_task():
    task = state.refresh_task
    state.refresh_task = None
    if task is None or task.done():
        return
    try:
        task.cancel()
    except RuntimeError as e:
        # The task belongs to a loop that has already closed.
        logger.debug(f"Old refresh task could not be cancelled: {e}")


def start_refresh_loop():
    """Starts the refresh loop on the running event loop, replacing any older one."""
    _cancel_refresh_task()
    loop = asyncio.get_running_loop()
    state.refresh_task = loop.create_task(_refresh_loop(_first_refresh_delay()))
    return state.refresh_task


def ensure_refresh_loop():
    """Starts the refresh loop unless one is already live on the running loop.

    Must be called from inside a coroutine. Returns True when a loop was started.
    """
    if not state.copilot_token or not state.copilot_refresh_in:
        return False
    loop = asyncio.get_running_loop()
    task = state.refresh_task
    if task is not None and not task.done() and task.get_loop() is loop:
        return False
    start_refresh_loop()
    return True


async def setup_copilot_token(start_refresh: bool = True):
    """Fetches a Copilot token. start_refresh=False leaves the refresh loop to
    ensure_refresh_loop(), for callers running on a short-lived start-up loop."""
    data = await get_copilot_token()
    _store_copilot_token(data)
    logger.debug("GitHub Copilot Token fetched successfully!")
    if state.show_token:
        logger.info(f"Copilot token: {data['token']}")
    if start_refresh:
        start_refresh_loop()


async def refresh_tokens_on_expired():
    logger.warn("Token expired or unauthorized error detected. Refreshing session...")
    await setup_copilot_token()
    logger.success("Session refreshed successfully.")


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

_usage_cache = {"data": None, "timestamp": 0}
_usage_lock = None
_usage_lock_loop = None


def _get_usage_lock():
    """A lock bound to the running loop. Start-up and serving use different loops."""
    global _usage_lock, _usage_lock_loop
    loop = asyncio.get_running_loop()
    if _usage_lock is None or _usage_lock_loop is not loop:
        _usage_lock = asyncio.Lock()
        _usage_lock_loop = loop
    return _usage_lock


async def get_copilot_usage() -> dict:
    async with _get_usage_lock():
        now = time.time()
        if _usage_cache["data"] and (now - _usage_cache["timestamp"] < USAGE_CACHE_SECONDS):
            return _usage_cache["data"]

        async with get_client() as client:
            resp = await client.get(
                f"{GITHUB_API_BASE_URL}/copilot_internal/user",
                headers=github_headers()
            )
            is_expired = (resp.status_code == 401)
            if not is_expired and resp.status_code != 200:
                is_expired = "token expired" in resp.text.lower()

            if is_expired:
                # Verify if token is ACTUALLY expired by checking the standard /user endpoint
                user_resp = await client.get(
                    f"{GITHUB_API_BASE_URL}/user",
                    headers=github_headers()
                )
                if user_resp.status_code == 401:
                    await setup_github_token(force=True)
                    async with get_client() as retry_client:
                        resp = await retry_client.get(
                            f"{GITHUB_API_BASE_URL}/copilot_internal/user",
                            headers=github_headers()
                        )
                else:
                    logger.warn("Copilot internal API returned 401, but GitHub token is still valid. Ignoring re-auth.")

            if resp.status_code != 200:
                if _usage_cache["data"]:
                    return _usage_cache["data"]
                err_data = safe_json(resp, {"raw": resp.text})
                raise HTTPError(f"Failed to get Copilot usage (HTTP {resp.status_code}): {resp.text}", resp.status_code, err_data)

            data = safe_json(resp, {})
            _usage_cache["data"] = data
            _usage_cache["timestamp"] = time.time()
            return data


async def display_usage():
    try:
        usage = await get_copilot_usage()
        snap = usage.get("quota_snapshots", {})
        premium = snap.get("premium_interactions", {})

        def summarize(name, s):
            if not s:
                return f"{name}: N/A"
            t = s.get("entitlement", 0)
            r = s.get("remaining", 0)
            u = t - r
            if s.get("unlimited"):
                return f"{name}: {u}/∞"
            return f"{name}: {u}/{t}"

        chat_str = summarize("Chat", snap.get("chat"))
        comp_str = summarize("Completions", snap.get("completions"))
        p_str = summarize("Premium", premium)
        logger.info(f"Usage Stats | {chat_str} | {comp_str} | {p_str}")
    except Exception as e:
        logger.warn(f"Failed to fetch usage stats: {e}")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

async def get_models() -> dict:
    async with get_client() as client:
        resp = await client.get(
            f"{copilot_base_url()}/models",
            headers=copilot_headers()
        )
        log_http_response(resp, "get_models")
        is_expired = (resp.status_code == 401)
        if not is_expired and resp.status_code != 200:
            is_expired = "token expired" in resp.text.lower()
        if is_expired:
            await refresh_tokens_on_expired()
            async with get_client() as retry_client:
                resp = await retry_client.get(
                    f"{copilot_base_url()}/models",
                    headers=copilot_headers()
                )
                log_http_response(resp, "get_models_retry")
        if resp.status_code != 200:
            err_data = safe_json(resp, {"raw": resp.text})
            raise HTTPError(f"Failed to get models (HTTP {resp.status_code}): {resp.text}", resp.status_code, err_data)
        data = safe_json(resp, {"data": []})
        return data


async def cache_models():
    try:
        logger.info("Fetching models from GitHub Copilot...")
        copilot_models = await get_models()
    except Exception as e:
        logger.error(f"Failed to get copilot models: {e}")
        copilot_models = {"data": []}

    raw = copilot_models.get("data", []) if isinstance(copilot_models, dict) else []
    data = [m for m in raw if isinstance(m, dict) and m.get("id")]
    for m in data:
        m["_raw_model_id"] = m.get("id")
        logger.debug(f"[+] Copilot model available: '{m.get('id')}'")

    state.models = {"data": data}
    logger.success(f"Model catalog updated: {len(data)} Copilot model(s) available")


# ---------------------------------------------------------------------------
# Reasoning normalization
# ---------------------------------------------------------------------------

_REASONING_KEYS = ("reasoning_content", "reasoning", "reasoning_text", "thinking")


def _coerce_reasoning_value(value):
    """Reasoning arrives either as a bare string or as a {"text": ...} object."""
    if isinstance(value, str):
        return value or None
    if isinstance(value, dict):
        for nested_key in ("text", "content", "reasoning"):
            nested = value.get(nested_key)
            if isinstance(nested, str) and nested:
                return nested
    return None


def normalize_reasoning_delta(delta):
    """Rewrite any provider-specific reasoning field onto `reasoning_content`.

    Works on both streaming `delta` objects and non-streaming `message`
    objects. Mutates in place and returns the extracted text, or None.
    Bounded by the fixed _REASONING_KEYS tuple, so no unbounded iteration.
    """
    if not isinstance(delta, dict):
        return None
    for key in _REASONING_KEYS:
        if key not in delta:
            continue
        text = _coerce_reasoning_value(delta.get(key))
        if key != "reasoning_content":
            delta.pop(key, None)
        if text:
            delta["reasoning_content"] = text
            return text
    return None


def normalize_reasoning_response(data):
    """Apply normalize_reasoning_delta across every choice in a payload."""
    if not isinstance(data, dict):
        return data
    for choice in data.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        normalize_reasoning_delta(choice.get("message"))
        normalize_reasoning_delta(choice.get("delta"))
    return data


# ---------------------------------------------------------------------------
# Chat completions (moved) and embeddings
# ---------------------------------------------------------------------------

async def create_chat_completions(payload: dict, stream: bool = False):
    """Moved to copilot_api.chat; kept so older imports keep working."""
    from copilot_api.chat import create_chat_completions as create
    return await create(payload, stream)


async def create_embeddings(payload: dict):
    if not state.copilot_token:
        raise Exception("Copilot token not found")

    async with get_client() as client:
        resp = await client.post(
            f"{copilot_base_url()}/embeddings",
            headers=copilot_headers(),
            json=payload
        )
        is_expired = (resp.status_code == 401)
        if not is_expired and resp.status_code != 200:
            is_expired = "token expired" in resp.text.lower()
        if is_expired:
            await refresh_tokens_on_expired()
            async with get_client() as retry_client:
                resp = await retry_client.post(
                    f"{copilot_base_url()}/embeddings",
                    headers=copilot_headers(),
                    json=payload
                )
        if resp.status_code != 200:
            err_data = safe_json(resp, {"raw": resp.text})
            raise HTTPError(f"Failed to create embeddings (HTTP {resp.status_code}): {resp.text}", resp.status_code, err_data)
        return safe_json(resp, {})
