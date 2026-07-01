import asyncio
import httpx
import httpx_sse
import json
from pathlib import Path
from src.config import (
    logger, state, GITHUB_BASE_URL, GITHUB_API_BASE_URL, GITHUB_CLIENT_ID, GITHUB_APP_SCOPES,
    standard_headers, github_headers, copilot_headers, copilot_base_url, GITHUB_TOKEN_PATH,
    save_model_quirks, load_settings
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
                
    if getattr(state, "refresh_task", None) is not None:
        try:
            state.refresh_task.cancel()
        except Exception:
            pass
    state.refresh_task = asyncio.create_task(refresh_loop(data["refresh_in"]))

async def refresh_tokens_on_expired():
    logger.warn("Token expired or unauthorized error detected. Refreshing session...")
    await setup_copilot_token()
    logger.success("Session refreshed successfully.")

_usage_cache = {"data": None, "timestamp": 0}
_usage_lock = None

async def get_copilot_usage() -> dict:
    global _usage_lock
    if _usage_lock is None:
        _usage_lock = asyncio.Lock()

    async with _usage_lock:
        now = time.time()
        if _usage_cache["data"] and (now - _usage_cache["timestamp"] < 60):
            return _usage_cache["data"]

        async with get_client() as client:
            resp = await client.get(
                f"{GITHUB_API_BASE_URL}/copilot_internal/user",
                headers=github_headers()
            )
            is_expired = (resp.status_code == 401)
            if not is_expired and resp.status_code != 200:
                try:
                    is_expired = "token expired" in resp.text.lower()
                except Exception:
                    pass
            
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
                raise HTTPError("Failed to get Copilot usage", resp.status_code, resp.json() if resp.text else {})
            
            data = resp.json()
            _usage_cache["data"] = data
            _usage_cache["timestamp"] = time.time()
            return data

async def display_usage():
    try:
        usage = await get_copilot_usage()
        snap = usage.get("quota_snapshots", {})
        premium = snap.get("premium_interactions", {})
        
        def summarize(name, s):
            if not s: return f"{name}: N/A"
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

async def get_models() -> dict:
    async with get_client() as client:
        resp = await client.get(
            f"{copilot_base_url()}/models",
            headers=copilot_headers()
        )
        is_expired = (resp.status_code == 401)
        if not is_expired and resp.status_code != 200:
            try:
                is_expired = "token expired" in resp.text.lower()
            except Exception:
                pass
        if is_expired:
            await refresh_tokens_on_expired()
            async with get_client() as retry_client:
                resp = await retry_client.get(
                    f"{copilot_base_url()}/models",
                    headers=copilot_headers()
                )
        if resp.status_code != 200:
            raise HTTPError("Failed to get models", resp.status_code, resp.json() if resp.text else {})
        return resp.json()

async def cache_models():
    try:
        copilot_models = await get_models()
    except Exception as e:
        logger.error(f"Failed to get copilot models: {e}")
        copilot_models = {"data": []}
        
    settings = load_settings()
    custom_endpoints = settings.get("custom_endpoints", [])
    merged_data = copilot_models.get("data", [])
    
    for ep in custom_endpoints:
        try:
            async with get_client() as client:
                headers = {}
                if ep.get("api_key"):
                    headers["Authorization"] = f"Bearer {ep['api_key']}"
                url = ep.get("url", "").rstrip("/")
                resp = await client.get(f"{url}/models", headers=headers, timeout=10.0)
                if resp.status_code == 200:
                    ep_models = resp.json().get("data", [])
                    for m in ep_models:
                        m["_custom_endpoint"] = ep
                        m["vendor"] = ep.get("name", "Custom")
                    merged_data.extend(ep_models)
        except Exception as e:
            logger.warn(f"Failed to fetch models from custom endpoint {ep.get('name')}: {e}")
            
    state.models = {"data": merged_data}

async def create_custom_chat_completions(payload: dict, stream: bool, endpoint: dict):
    client = get_client()
    url = endpoint.get("url", "").rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if endpoint.get("api_key"):
        headers["Authorization"] = f"Bearer {endpoint['api_key']}"
    
    if not stream:
        async with client:
            resp = await client.post(url, headers=headers, json=payload, timeout=120.0)
            if resp.status_code != 200:
                raise HTTPError(f"Custom endpoint error: {resp.text}", resp.status_code)
            return resp.json()

    req = client.build_request("POST", url, headers=headers, json=payload, timeout=120.0)
    resp = await client.send(req, stream=True)
    if resp.status_code != 200:
        err_text = await resp.aread()
        await resp.aclose()
        await client.aclose()
        raise HTTPError(f"Custom endpoint stream error: {err_text.decode('utf-8', errors='ignore')}", resp.status_code)

    async def stream_generator():
        try:
            async for sse in httpx_sse.EventSource(resp).aiter_sse():
                if sse.data == "[DONE]":
                    yield "data: [DONE]\n\n"
                    break
                yield f"data: {sse.data}\n\n"
        finally:
            await resp.aclose()
            await client.aclose()

    return stream_generator()

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
    exact_model_id = payload.get("model", "")
    model_id = exact_model_id.lower()

    settings = load_settings()
    thinking_conf = settings.get("thinking_defaults", {})
    thinking_keywords = thinking_conf.get("enabled_keywords", ["opus", "sonnet"])
    
    if any(k in model_id for k in thinking_keywords):
        budget = thinking_conf.get("budget_tokens", 4096)
        max_comp = thinking_conf.get("max_completion_tokens", 16384)
        if thinking_conf.get("unlimited", False):
            budget = max_comp
            
        payload["thinking"] = {
            "type": "enabled",
            "budget_tokens": budget
        }
        payload["max_completion_tokens"] = max_comp
        if "max_tokens" in payload:
            payload.pop("max_tokens")
        logger.debug(f"Applied thinking budget ({budget}) and max_completion_tokens ({max_comp}) for {exact_model_id}")

    req_quirks = state.quirks.get("requires_max_completion_tokens", [])
    if exact_model_id in req_quirks and "max_tokens" in payload:
        payload["max_completion_tokens"] = payload.pop("max_tokens")
        logger.debug(f"Pre-flight quirk applied: swapped max_tokens to max_completion_tokens for {exact_model_id}")

    # Check if this model belongs to a custom endpoint
    is_custom = False
    custom_ep = None
    if state.models:
        for m in state.models.get("data", []):
            if m.get("id") == exact_model_id and "_custom_endpoint" in m:
                is_custom = True
                custom_ep = m["_custom_endpoint"]
                break
                
    if is_custom:
        logger.info(f"Routing request to custom endpoint: {custom_ep.get('name')}")
        return await create_custom_chat_completions(payload, stream, custom_ep)

    if "codex" in model_id or "agent" in model_id:
        base_intent = "copilot-agent"
        base_path = "/agent/chat/completions"
    else:
        base_intent = "conversation-panel"
        base_path = "/chat/completions"

    headers = copilot_headers(vision=enable_vision, intent=base_intent)
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
                f"{copilot_base_url()}{base_path}",
                headers=headers,
                json=payload
            )
            
            if resp.status_code != 200 and "not accessible via the /chat/completions endpoint" in resp.text:
                logger.warn("Auto-correcting endpoint for agent/codex model...")
                headers = copilot_headers(vision=enable_vision, intent="copilot-agent")
                headers["X-Initiator"] = "agent" if is_agent else "user"
                base_path = "/agent/chat/completions"
                resp = await client.post(
                    f"{copilot_base_url()}{base_path}",
                    headers=headers,
                    json=payload
                )

            if resp.status_code != 200 and "max_completion_tokens" in resp.text:
                logger.warn(f"Model {exact_model_id} requires max_completion_tokens. Saving quirk and retrying...")
                if exact_model_id not in state.quirks.setdefault("requires_max_completion_tokens", []):
                    state.quirks["requires_max_completion_tokens"].append(exact_model_id)
                    save_model_quirks(state.quirks)
                
                if "max_tokens" in payload:
                    payload["max_completion_tokens"] = payload.pop("max_tokens")
                
                resp = await client.post(
                    f"{copilot_base_url()}{base_path}",
                    headers=headers,
                    json=payload
                )

            is_expired = (resp.status_code == 401)
            if not is_expired and resp.status_code != 200:
                try:
                    is_expired = "token expired" in resp.text.lower()
                except Exception:
                    pass
            if is_expired:
                await refresh_tokens_on_expired()
                new_headers = copilot_headers(vision=enable_vision, intent=base_intent if base_path != "/agent/chat/completions" else "copilot-agent")
                new_headers["X-Initiator"] = "agent" if is_agent else "user"
                resp = await client.post(
                    f"{copilot_base_url()}{base_path}",
                    headers=new_headers,
                    json=payload
                )
            if resp.status_code != 200:
                logger.error(f"Failed to create chat completions: {resp.text}")
                try:
                    err_data = resp.json()
                except Exception:
                    err_data = {"message": resp.text}
                raise HTTPError("Failed to create chat completions", resp.status_code, err_data)
            
            data = resp.json()
            asyncio.create_task(display_usage())
            return data
    else:
        req = client.build_request("POST", f"{copilot_base_url()}{base_path}", headers=headers, json=payload)
        resp = await client.send(req, stream=True)
        
        if resp.status_code != 200:
            body_bytes = await resp.aread()
            body_text = body_bytes.decode("utf-8", errors="ignore")
            if "not accessible via the /chat/completions endpoint" in body_text:
                await resp.aclose()
                logger.warn("Auto-correcting stream endpoint for agent/codex model...")
                headers = copilot_headers(vision=enable_vision, intent="copilot-agent")
                headers["X-Initiator"] = "agent" if is_agent else "user"
                base_path = "/agent/chat/completions"
                req = client.build_request("POST", f"{copilot_base_url()}{base_path}", headers=headers, json=payload)
                resp = await client.send(req, stream=True)

        if resp.status_code != 200:
            body_bytes = await resp.aread()
            body_text = body_bytes.decode("utf-8", errors="ignore")
            if "max_completion_tokens" in body_text:
                await resp.aclose()
                logger.warn(f"Model {exact_model_id} requires max_completion_tokens. Saving quirk and retrying stream...")
                if exact_model_id not in state.quirks.setdefault("requires_max_completion_tokens", []):
                    state.quirks["requires_max_completion_tokens"].append(exact_model_id)
                    save_model_quirks(state.quirks)
                
                if "max_tokens" in payload:
                    payload["max_completion_tokens"] = payload.pop("max_tokens")
                
                req = client.build_request("POST", f"{copilot_base_url()}{base_path}", headers=headers, json=payload)
                resp = await client.send(req, stream=True)

        is_expired = (resp.status_code == 401)
        if not is_expired and resp.status_code != 200:
            try:
                body_bytes = await resp.aread()
                body_text = body_bytes.decode("utf-8", errors="ignore")
                is_expired = "token expired" in body_text.lower()
            except Exception:
                pass
                
        if is_expired:
            await resp.aclose()
            await refresh_tokens_on_expired()
            new_headers = copilot_headers(vision=enable_vision, intent=base_intent if base_path != "/agent/chat/completions" else "copilot-agent")
            new_headers["X-Initiator"] = "agent" if is_agent else "user"
            req = client.build_request("POST", f"{copilot_base_url()}{base_path}", headers=new_headers, json=payload)
            resp = await client.send(req, stream=True)

        if resp.status_code != 200:
            await resp.aread()
            error_text = resp.text
            await resp.aclose()
            await client.aclose()
            logger.error(f"Failed to create chat completions stream: {error_text}")
            try:
                err_data = json.loads(error_text)
            except Exception:
                err_data = {"message": error_text}
            raise HTTPError("Failed to stream chat completions", resp.status_code, err_data)

        ttfb = time.time()
        elapsed_prompt = max(ttfb - start_time, 0.001)
        prompt_speed = prompt_tokens / elapsed_prompt
        logger.info(f"Prompt processing speed: {prompt_speed:.1f} t/s ({prompt_tokens} tokens in {elapsed_prompt:.2f}s)")

        async def stream_generator():
            queue = asyncio.Queue()
            metrics = {
                "actual_tokens": 0,
                "simulated_tokens": 0,
                "start_time": time.time(),
                "smoothed_tps": 40.0,
                "stream_finished": False
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
                            metrics["stream_finished"] = True
                            break
                except Exception as e:
                    logger.error(f"Stream producer error: {e}")
                    metrics["stream_finished"] = True
                    await queue.put("[DONE]")
                finally:
                    metrics["stream_finished"] = True
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
                        asyncio.create_task(display_usage())
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

                    if encoder:
                        total_content_tokens = len(encoder.encode(content))
                    else:
                        total_content_tokens = len(content) / 4.0

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

                        sub_tokens = total_content_tokens * (len(sub_content) / len(content))
                            
                        metrics["simulated_tokens"] += sub_tokens

                        elapsed = max(time.time() - metrics["start_time"], 0.01)
                        actual_tps = metrics["actual_tokens"] / elapsed
                        sim_tps = metrics["simulated_tokens"] / elapsed
                        
                        buffer_size = max(0.0, metrics["actual_tokens"] - metrics["simulated_tokens"])
                        if metrics["stream_finished"]:
                            target_tps = 100.0
                        elif buffer_size < 200:
                            target_tps = 40.0
                        elif buffer_size < 400:
                            target_tps = 60.0
                        elif buffer_size < 600:
                            target_tps = 80.0
                        else:
                            target_tps = 100.0
                            
                        metrics["smoothed_tps"] = target_tps
                        
                        spin_char = spinner[spinner_idx % len(spinner)]
                        spinner_idx += 1
                        
                        sys.stdout.write(f"\r{spin_char} Replying to prompt: (Actual: {actual_tps:.1f} t/s) (Simulated: {sim_tps:.1f} t/s) (Buffer: {buffer_size:.1f} tokens) (Total: {metrics['actual_tokens']} tokens)")
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
        is_expired = (resp.status_code == 401)
        if not is_expired and resp.status_code != 200:
            try:
                is_expired = "token expired" in resp.text.lower()
            except Exception:
                pass
        if is_expired:
            await refresh_tokens_on_expired()
            async with get_client() as retry_client:
                resp = await retry_client.post(
                    f"{copilot_base_url()}/embeddings",
                    headers=copilot_headers(),
                    json=payload
                )
        if resp.status_code != 200:
            raise HTTPError("Failed to create embeddings", resp.status_code, resp.json() if resp.text else {})
        return resp.json()
