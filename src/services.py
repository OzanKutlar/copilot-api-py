import asyncio
import httpx
import httpx_sse
from pathlib import Path
from src.config import (
    logger, state, GITHUB_BASE_URL, GITHUB_API_BASE_URL, GITHUB_CLIENT_ID, GITHUB_APP_SCOPES,
    standard_headers, github_headers, copilot_headers, copilot_base_url, GITHUB_TOKEN_PATH
)
from src.utils import HTTPError

def get_client():
    # If proxy_env is requested, httpx handles HTTP_PROXY/HTTPS_PROXY implicitly by default unless overridden.
    return httpx.AsyncClient(trust_env=state.use_proxy_env, timeout=60.0)

async def get_device_code() -> dict:
    async with get_client() as client:
        resp = await client.post(
            f"{GITHUB_BASE_URL}/login/device/code",
            headers=standard_headers(),
            json={"client_id": GITHUB_CLIENT_ID, "scope": GITHUB_APP_SCOPES}
        )
        if resp.status_code != 200:
            raise HTTPError("Failed to get device code", resp.status_code, resp.json() if resp.text else {})
        return resp.json()

async def poll_access_token(device_code: dict) -> str:
    sleep_duration = device_code["interval"] + 1
    logger.debug(f"Polling access token with interval of {sleep_duration}s")
    
    async with get_client() as client:
        while True:
            resp = await client.post(
                f"{GITHUB_BASE_URL}/login/oauth/access_token",
                headers=standard_headers(),
                json={
                    "client_id": GITHUB_CLIENT_ID,
                    "device_code": device_code["device_code"],
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
                }
            )
            if resp.status_code != 200:
                await asyncio.sleep(sleep_duration)
                logger.error(f"Failed to poll access token: {resp.text}")
                continue
            
            data = resp.json()
            logger.debug(f"Polling access token response: {data}")
            
            if "access_token" in data:
                return data["access_token"]
            
            await asyncio.sleep(sleep_duration)

async def get_github_user():
    async with get_client() as client:
        headers = standard_headers()
        headers["authorization"] = f"token {state.github_token}"
        resp = await client.get(f"{GITHUB_API_BASE_URL}/user", headers=headers)
        if resp.status_code != 200:
            raise HTTPError("Failed to get GitHub user", resp.status_code, resp.json() if resp.text else {})
        return resp.json()

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
    logger.debug(f"Device code response: {device_code}")
    logger.info(f"Please enter the code \"{device_code['user_code']}\" in {device_code['verification_uri']}")
    
    token = await poll_access_token(device_code)
    GITHUB_TOKEN_PATH.write_text(token)
    state.github_token = token
    
    if state.show_token:
        logger.info(f"GitHub token: {token}")
    user = await get_github_user()
    logger.info(f"Logged in as {user.get('login')}")

async def get_copilot_token() -> dict:
    async with get_client() as client:
        resp = await client.get(
            f"{GITHUB_API_BASE_URL}/copilot_internal/v2/token",
            headers=github_headers()
        )
        if resp.status_code != 200:
            raise HTTPError("Failed to get Copilot token", resp.status_code, resp.json() if resp.text else {})
        return resp.json()

async def setup_copilot_token():
    data = await get_copilot_token()
    state.copilot_token = data["token"]
    logger.debug("GitHub Copilot Token fetched successfully!")
    if state.show_token:
        logger.info(f"Copilot token: {data['token']}")
        
    async def refresh_loop(refresh_in):
        while True:
            interval = max(refresh_in - 60, 60)
            await asyncio.sleep(interval)
            logger.debug("Refreshing Copilot token")
            try:
                new_data = await get_copilot_token()
                state.copilot_token = new_data["token"]
                refresh_in = new_data["refresh_in"]
                logger.debug("Copilot token refreshed")
                if state.show_token:
                    logger.info(f"Refreshed Copilot token: {new_data['token']}")
            except Exception as e:
                logger.error(f"Failed to refresh Copilot token: {e}")
                await asyncio.sleep(60)
                
    asyncio.create_task(refresh_loop(data["refresh_in"]))

async def get_copilot_usage() -> dict:
    async with get_client() as client:
        resp = await client.get(
            f"{GITHUB_API_BASE_URL}/copilot_internal/user",
            headers=github_headers()
        )
        if resp.status_code != 200:
            raise HTTPError("Failed to get Copilot usage", resp.status_code, resp.json() if resp.text else {})
        return resp.json()

async def get_models() -> dict:
    async with get_client() as client:
        resp = await client.get(
            f"{copilot_base_url()}/models",
            headers=copilot_headers()
        )
        if resp.status_code != 200:
            raise HTTPError("Failed to get models", resp.status_code, resp.json() if resp.text else {})
        return resp.json()

async def cache_models():
    models = await get_models()
    state.models = models

async def create_chat_completions(payload: dict, stream: bool = False):
    if not state.copilot_token:
        raise Exception("Copilot token not found")
        
    enable_vision = False
    for msg in payload.get("messages", []):
        if isinstance(msg.get("content"), list):
            for part in msg["content"]:
                if part.get("type") == "image_url":
                    enable_vision = True
                    break

    is_agent = any(m.get("role") in ["assistant", "tool"] for m in payload.get("messages", []))
    
    headers = copilot_headers(vision=enable_vision)
    headers["X-Initiator"] = "agent" if is_agent else "user"

    if not stream:
        async with get_client() as client:
            resp = await client.post(
                f"{copilot_base_url()}/chat/completions",
                headers=headers,
                json=payload
            )
            if resp.status_code != 200:
                logger.error(f"Failed to create chat completions: {resp.text}")
                raise HTTPError("Failed to create chat completions", resp.status_code, resp.json() if resp.text else {})
            return resp.json()
    else:
        # Streaming generator
        async def stream_generator():
            async with get_client() as client:
                async with client.stream("POST", f"{copilot_base_url()}/chat/completions", headers=headers, json=payload) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        logger.error(f"Failed to create chat completions stream: {error_text}")
                        raise HTTPError("Failed to stream chat completions", response.status_code)
                    
                    async for sse in httpx_sse.aevents(response):
                        if sse.data == "[DONE]":
                            yield "data: [DONE]\n\n"
                            break
                        yield f"data: {sse.data}\n\n"
                        
        return stream_generator()

async def create_embeddings(payload: dict):
    if not state.copilot_token:
        raise Exception("Copilot token not found")
        
    async with get_client() as client:
        resp = await client.post(
            f"{copilot_base_url()}/embeddings",
            headers=copilot_headers(),
            json=payload
        )
        if resp.status_code != 200:
            raise HTTPError("Failed to create embeddings", resp.status_code, resp.json() if resp.text else {})
        return resp.json()
