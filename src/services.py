import asyncio
import httpx
import httpx_sse
import json
from pathlib import Path
from src.config import (
    logger, state, GITHUB_BASE_URL, GITHUB_API_BASE_URL, GITHUB_CLIENT_ID, GITHUB_APP_SCOPES,
    standard_headers, github_headers, copilot_headers, copilot_base_url, GITHUB_TOKEN_PATH
)
from src.utils import HTTPError, get_token_count, get_tokenizer
import time
import sys

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

    client = get_client()

    prompt_tokens = 0
    try:
        prompt_tokens = get_token_count(payload)["input"]
    except Exception:
        pass

    start_time = time.time()

    if not stream:
        async with client:
            resp = await client.post(
                f"{copilot_base_url()}/chat/completions",
                headers=headers,
                json=payload
            )
            if resp.status_code != 200:
                logger.error(f"Failed to create chat completions: {resp.text}")
                try:
                    err_data = resp.json()
                except Exception:
                    err_data = {"message": resp.text}
                raise HTTPError("Failed to create chat completions", resp.status_code, err_data)
            return resp.json()
    else:
        req = client.build_request("POST", f"{copilot_base_url()}/chat/completions", headers=headers, json=payload)
        resp = await client.send(req, stream=True)
        
        ttfb = time.time()
        elapsed_prompt = max(ttfb - start_time, 0.001)
        prompt_speed = prompt_tokens / elapsed_prompt
        logger.info(f"Prompt processing speed: {prompt_speed:.1f} t/s ({prompt_tokens} tokens in {elapsed_prompt:.2f}s)")

        if resp.status_code != 200:
            await resp.aread()
            error_text = resp.text
            await resp.aclose()
            await client.aclose()
            logger.error(f"Failed to create chat completions stream: {error_text}")
            try:
                err_data = resp.json()
            except Exception:
                err_data = {"message": error_text}
            raise HTTPError("Failed to stream chat completions", resp.status_code, err_data)

        async def stream_generator():
            queue = asyncio.Queue()
            metrics = {
                "actual_tokens": 0,
                "simulated_tokens": 0,
                "start_time": time.time(),
                "smoothed_tps": 10.0
            }
            try:
                encoder = get_tokenizer(payload.get("model", "gpt-4o"))
            except Exception:
                encoder = None

            async def producer():
                try:
                    async for sse in httpx_sse.EventSource(resp).aiter_sse():
                        if sse.data != "[DONE]":
                            try:
                                chunk = json.loads(sse.data)
                                content = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                if content and encoder:
                                    metrics["actual_tokens"] += len(encoder.encode(content))
                                elif content:
                                    metrics["actual_tokens"] += int(len(content) / 4)
                            except Exception:
                                pass
                        await queue.put(sse.data)
                        if sse.data == "[DONE]":
                            break
                except Exception as e:
                    logger.error(f"Stream producer error: {e}")
                    await queue.put("[DONE]")
                finally:
                    await resp.aclose()
                    await client.aclose()

            producer_task = asyncio.create_task(producer())
            spinner = ['|', '/', '-', '\\']
            spinner_idx = 0

            try:
                while True:
                    data = await queue.get()
                    if data == "[DONE]":
                        sys.stdout.write("\r" + " " * 80 + "\r")
                        sys.stdout.flush()
                        total_elapsed = max(time.time() - metrics["start_time"], 0.01)
                        avg_out_tps = metrics["actual_tokens"] / total_elapsed
                        logger.info(f"Prompt Finished (Input: {prompt_tokens}, Output: {metrics['actual_tokens']}) (Avg Output: {avg_out_tps:.1f} t/s)")
                        yield "data: [DONE]\n\n"
                        break

                    try:
                        chunk = json.loads(data)
                    except Exception:
                        yield f"data: {data}\n\n"
                        continue

                    choices = chunk.get("choices", [])
                    if not choices:
                        yield f"data: {data}\n\n"
                        continue

                    choice = choices[0]
                    delta = choice.get("delta", {})
                    content = delta.get("content")

                    if not content:
                        yield f"data: {data}\n\n"
                        continue

                    finish_reason = choice.get("finish_reason")
                    choice["finish_reason"] = None
                    
                    usage = chunk.get("usage")
                    if "usage" in chunk:
                        del chunk["usage"]

                    chunk_size = 8
                    for i in range(0, len(content), chunk_size):
                        sub_content = content[i:i+chunk_size]
                        choice["delta"]["content"] = sub_content
                        
                        is_last = (i + chunk_size >= len(content))
                        if is_last:
                            choice["finish_reason"] = finish_reason
                            if usage is not None:
                                chunk["usage"] = usage
                                
                        yield f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"
                        
                        if "tool_calls" in choice["delta"]:
                            del choice["delta"]["tool_calls"]
                        if "role" in choice["delta"]:
                            del choice["delta"]["role"]

                        if encoder:
                            sub_tokens = len(encoder.encode(sub_content))
                        else:
                            sub_tokens = len(sub_content) / 4.0
                            
                        metrics["simulated_tokens"] += sub_tokens

                        elapsed = max(time.time() - metrics["start_time"], 0.01)
                        actual_tps = metrics["actual_tokens"] / elapsed
                        sim_tps = metrics["simulated_tokens"] / elapsed
                        
                        buffer_size = metrics["actual_tokens"] - metrics["simulated_tokens"]
                        target_tps = max(10.0, actual_tps - 10.0)
                        if buffer_size > 40:
                            target_tps = max(target_tps, actual_tps * 1.5)
                            
                        metrics["smoothed_tps"] = (metrics["smoothed_tps"] * 0.9) + (target_tps * 0.1)
                        
                        spin_char = spinner[spinner_idx % len(spinner)]
                        spinner_idx += 1
                        
                        sys.stdout.write(f"\r{spin_char} Replying to prompt: (Actual: {actual_tps:.1f} t/s) (Simulated: {sim_tps:.1f} t/s)")
                        sys.stdout.flush()

                        sleep_time = sub_tokens / max(metrics["smoothed_tps"], 1.0)
                        await asyncio.sleep(sleep_time)
            finally:
                producer_task.cancel()
                
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
