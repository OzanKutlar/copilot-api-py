import time
import asyncio
from rich.prompt import Confirm
import httpx
import tiktoken
import json
from src.config import logger, state

class HTTPError(Exception):
    def __init__(self, message, status_code, data=None):
        super().__init__(message)
        self.status_code = status_code
        self.data = data or {"message": message}

async def await_approval():
    # Run rich prompt in a separate thread so it doesn't block the async event loop
    approved = await asyncio.to_thread(Confirm.ask, "Accept incoming request?")
    if not approved:
        raise HTTPError("Request rejected", 403)

async def check_rate_limit():
    if state.rate_limit_seconds is None:
        return

    now = time.time()
    if state.last_request_timestamp is None:
        state.last_request_timestamp = now
        return

    elapsed = now - state.last_request_timestamp
    if elapsed > state.rate_limit_seconds:
        state.last_request_timestamp = now
        return

    wait_time = state.rate_limit_seconds - elapsed
    if not state.rate_limit_wait:
        logger.warn(f"Rate limit exceeded. Need to wait {wait_time:.1f} more seconds.")
        raise HTTPError("Rate limit exceeded", 429)

    logger.warn(f"Rate limit reached. Waiting {wait_time:.1f} seconds before proceeding...")
    await asyncio.sleep(wait_time)
    state.last_request_timestamp = time.time()
    logger.info("Rate limit wait completed, proceeding with request")

def generate_env_script(env_vars: dict, command_to_run: str = "") -> str:
    import os
    shell = os.environ.get("SHELL", "sh")
    assignments = []
    
    for k, v in env_vars.items():
        if v is not None:
            assignments.append(f"{k}={v}")

    if "fish" in shell:
        block = "; ".join([f"set -gx {k.split('=')[0]} {k.split('=')[1]}" for k in assignments])
    elif os.name == "nt":
        block = " & ".join([f"set {k}" for k in assignments])
    else:
        block = f"export {' '.join(assignments)}"

    if block and command_to_run:
        separator = " & " if os.name == "nt" else " && "
        return f"{block}{separator}{command_to_run}"
    return block or command_to_run

async def get_vscode_version():
    fallback = "1.104.3"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get("https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin")
            if resp.status_code == 200:
                import re
                match = re.search(r'pkgver=([0-9.]+)', resp.text)
                if match:
                    return match.group(1)
    except Exception:
        pass
    return fallback

async def cache_vscode_version():
    ver = await get_vscode_version()
    state.vscode_version = ver
    logger.info(f"Using VSCode version: {ver}")

class SafeEncoder:
    def __init__(self, encoder):
        self._encoder = encoder

    def encode(self, text, *args, **kwargs):
        if not isinstance(text, str):
            text = str(text)
        kwargs.setdefault("disallowed_special", ())
        return self._encoder.encode(text, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._encoder, name)

def get_tokenizer(model_name: str):
    try:
        enc = tiktoken.encoding_for_model(model_name)
    except KeyError:
        enc = tiktoken.get_encoding("cl100k_base")
    return SafeEncoder(enc)

def calculate_message_tokens(message: dict, encoder) -> int:
    tokens = 3
    for k, v in message.items():
        if isinstance(v, str):
            tokens += len(encoder.encode(v))
        if k == "name":
            tokens += 1
        if k == "content" and isinstance(v, list):
            for part in v:
                if part.get("type") == "image_url":
                    tokens += len(encoder.encode(part["image_url"]["url"])) + 85
                elif part.get("text"):
                    tokens += len(encoder.encode(part["text"]))
        if k == "tool_calls":
            for tool in v:
                tokens += 10
                tokens += len(encoder.encode(json.dumps(tool)))
                tokens += 12
    return tokens

def get_token_count(payload: dict) -> dict:
    model = payload.get("model", "gpt-4o")
    encoder = get_tokenizer(model)
    messages = payload.get("messages", [])
    
    input_msgs = [m for m in messages if m.get("role") != "assistant"]
    output_msgs = [m for m in messages if m.get("role") == "assistant"]
    
    input_tokens = sum(calculate_message_tokens(m, encoder) for m in input_msgs)
    if input_tokens > 0:
        input_tokens += 3
        
    tools = payload.get("tools", [])
    for t in tools:
        input_tokens += 10
        input_tokens += len(encoder.encode(json.dumps(t.get("function", {}))))
        input_tokens += 12

    output_tokens = sum(calculate_message_tokens(m, encoder) for m in output_msgs)
    if output_tokens > 0:
        output_tokens += 3
        
    return {"input": input_tokens, "output": output_tokens}
