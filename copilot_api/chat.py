"""Chat completions against Copilot: learned quirks, Responses routing and paced streaming.

Requests stay in Chat Completions form. The route decides whether one is sent
as is to /chat/completions or translated for /responses (see
copilot_api.responses_translator). A rejection that a quirk rule recognises is
fixed, remembered and retried, at most once per rule, so a model never hits the
same error twice (see copilot_api.quirks).
"""
import asyncio
import json
import sys
import time
from dataclasses import dataclass

import httpx
import httpx_sse

from copilot_api import quirks
from copilot_api import responses_translator as responses
from copilot_api.config import copilot_base_url, copilot_headers, load_settings, logger, state
from copilot_api.services import (
    display_usage, get_client, normalize_reasoning_delta, normalize_reasoning_response, refresh_tokens_on_expired
)
from copilot_api.utils import HTTPError, get_token_count, get_tokenizer, safe_json

ROUTE_PATHS = {quirks.ROUTE_CHAT: "/chat/completions", quirks.ROUTE_RESPONSES: "/responses"}
# The first try, one token refresh and one retry per quirk rule.
MAX_ATTEMPTS = len(quirks.RULES) + 2
STREAM_TIMEOUT_SECONDS = 60.0
DEFAULT_NON_STREAM_TIMEOUT = 240.0
MAX_SCANNED_MESSAGES = 10000
MAX_STREAM_EVENTS = 10000000
SLICE_CHARS = 8
# (buffered tokens below this, target tokens/s). A larger buffer or a finished stream gets FAST_TPS.
PACE_STEPS = ((200, 40.0), (400, 60.0), (600, 80.0))
FAST_TPS = 100.0
SPINNER = ("|", "/", "-", "\\")
DONE = "[DONE]"


@dataclass(frozen=True)
class _Request:
    model_id: str
    vision: bool
    agent: bool


# ---------------------------------------------------------------------------
# Preparing a request
# ---------------------------------------------------------------------------

def _apply_thinking_defaults(payload, settings):
    """Turns thinking on for models matching thinking_defaults, unless the client chose."""
    if "thinking" in payload or "reasoning_effort" in payload:
        return
    conf = settings.get("thinking_defaults", {})
    if not isinstance(conf, dict):
        return
    model_id = str(payload.get("model", "")).lower()
    if not any(keyword in model_id for keyword in conf.get("enabled_keywords", ["opus", "sonnet"])):
        return
    max_completion = conf.get("max_completion_tokens", 16384)
    budget = max_completion if conf.get("unlimited", False) else conf.get("budget_tokens", 4096)
    payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
    payload["max_completion_tokens"] = max_completion
    payload.pop("max_tokens", None)
    logger.debug(f"Applied thinking budget ({budget}) and max_completion_tokens ({max_completion}) for {payload.get('model')}")


def _scanned(messages):
    return [m for m in messages[:MAX_SCANNED_MESSAGES] if isinstance(m, dict)]


def _has_image(messages):
    for message in _scanned(messages):
        content = message.get("content")
        if isinstance(content, list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in content):
            return True
    return False


def _is_agent(messages):
    return any(m.get("role") in ("assistant", "tool") for m in _scanned(messages))


def _request_for(payload):
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        raise HTTPError("'messages' must be a list", 400)
    return _Request(str(payload.get("model") or ""), _has_image(messages), _is_agent(messages))


def _catalog():
    data = state.models.get("data") if isinstance(state.models, dict) else None
    return [m for m in data if isinstance(m, dict)] if isinstance(data, list) else []


def _catalog_entry(model_id):
    return next((m for m in _catalog() if m.get("id") == model_id), None)


def _catalog_route(model_id):
    """ROUTE_RESPONSES when the model list says the model is served only on /responses."""
    entry = _catalog_entry(model_id)
    endpoints = entry.get("supported_endpoints") if entry else None
    if not isinstance(endpoints, list):
        return quirks.ROUTE_CHAT
    names = {str(endpoint).strip().strip("/").lower() for endpoint in endpoints}
    if "responses" in names and "chat/completions" not in names:
        return quirks.ROUTE_RESPONSES
    return quirks.ROUTE_CHAT


# ---------------------------------------------------------------------------
# Sending, with recovery
# ---------------------------------------------------------------------------

def _headers(request):
    headers = copilot_headers(vision=request.vision)
    headers["X-Initiator"] = "agent" if request.agent else "user"
    return headers


def _body(payload, route):
    if route != quirks.ROUTE_RESPONSES:
        return payload
    try:
        return responses.chat_to_responses(payload)
    except ValueError as e:
        raise HTTPError(f"Could not translate the request for /responses: {e}", 400) from e


async def _send(client, payload, route, request, stream):
    url = f"{copilot_base_url()}{ROUTE_PATHS[route]}"
    body = _body(payload, route)
    try:
        upstream = client.build_request("POST", url, headers=_headers(request), json=body)
        return await client.send(upstream, stream=stream)
    except httpx.HTTPError as e:
        raise HTTPError(f"Could not reach Copilot: {e}", 502) from e


async def _error_text(resp):
    """Reads and closes a rejected response. Returns its body, or '' when unreadable."""
    try:
        await resp.aread()
        return resp.text
    except Exception as e:
        logger.debug(f"Could not read the error body: {e}")
        return ""
    finally:
        await resp.aclose()


def _is_expired(status, text):
    return status == 401 or "token expired" in text.lower()


def _missing_model_error(model_id):
    message = (f"Model '{model_id}' is not in your Copilot model list, so Copilot cannot serve it. "
               "It may need a different Copilot plan, or the name may be misspelled. "
               "GET /v1/models lists the models you can use.")
    data = {"error": {"message": message, "type": "invalid_request_error", "code": "model_not_found"}}
    return HTTPError(message, 404, data)


def _upstream_error(status, text, request, route):
    if status == 404 and _catalog() and _catalog_entry(request.model_id) is None:
        error = _missing_model_error(request.model_id)
        logger.error(str(error))
        return error
    logger.error(f"Failed to create chat completions via {ROUTE_PATHS[route]} (HTTP {status}): {text}")
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if not isinstance(data, dict) or "error" not in data:
        data = {"error": {"message": text or f"HTTP {status}", "type": "upstream_error"}}
    return HTTPError(f"Failed to create chat completions (HTTP {status}): {text}", status, data)


async def _send_with_recovery(client, payload, request, stream):
    """(response, route) for the first accepted attempt. Raises HTTPError otherwise."""
    route, applied = quirks.apply_known(payload, request.model_id, _catalog_route(request.model_id))
    if applied:
        logger.debug(f"Applied learned quirks for {request.model_id}: {', '.join(applied)}")
    tried, refreshed = set(applied), False
    for _ in range(MAX_ATTEMPTS):
        resp = await _send(client, payload, route, request, stream)
        if resp.status_code == 200:
            return resp, route
        text = await _error_text(resp)
        if not refreshed and _is_expired(resp.status_code, text):
            refreshed = True
            await refresh_tokens_on_expired()
            continue
        rule = quirks.match_rule(text, payload, route, tried)
        if rule is None:
            raise _upstream_error(resp.status_code, text, request, route)
        tried.add(rule.key)
        quirks.record(rule, request.model_id)
        route = rule.fix(payload, route)
        logger.info(f"Retrying {request.model_id} with fix '{rule.key}' via {ROUTE_PATHS[route]}")
    raise HTTPError(f"Copilot rejected every attempt for {request.model_id}", 502)


# ---------------------------------------------------------------------------
# Non-streaming
# ---------------------------------------------------------------------------

def _non_stream_timeout(settings):
    try:
        return float(settings.get("non_stream_timeout", DEFAULT_NON_STREAM_TIMEOUT))
    except (TypeError, ValueError):
        return DEFAULT_NON_STREAM_TIMEOUT


async def _complete(payload, request, timeout):
    async with get_client(timeout=timeout) as client:
        resp, route = await _send_with_recovery(client, payload, request, stream=False)
        data = safe_json(resp, {})
    if route == quirks.ROUTE_RESPONSES:
        try:
            data = responses.responses_to_chat(data, request.model_id)
        except ValueError as e:
            raise HTTPError(f"Copilot sent an unreadable /responses reply: {e}", 502) from e
    asyncio.create_task(display_usage())
    return normalize_reasoning_response(data)


# ---------------------------------------------------------------------------
# Streaming: upstream events -> chat chunk data strings
# ---------------------------------------------------------------------------

async def _open_stream(payload, request):
    client = get_client(timeout=STREAM_TIMEOUT_SECONDS)
    try:
        resp, route = await _send_with_recovery(client, payload, request, stream=True)
    except BaseException:
        await client.aclose()
        raise
    return client, resp, route


async def _chat_route_events(events):
    count = 0
    async for sse in events:
        count += 1
        if sse.data == DONE or count > MAX_STREAM_EVENTS:
            return
        yield sse.data


async def _responses_route_events(events, model_id):
    stream_state = responses.ResponsesStreamState(model_id)
    count = 0
    try:
        async for sse in events:
            count += 1
            for chunk in responses.event_to_chunks(sse.event, sse.data, stream_state):
                yield json.dumps(chunk, separators=(",", ":"))
            if stream_state.finished or count > MAX_STREAM_EVENTS:
                return
    except responses.ResponsesStreamError as e:
        logger.error(f"Copilot reported a failed /responses stream: {e}")
        yield json.dumps({"error": {"message": str(e), "type": "upstream_error"}})


async def _chat_events(resp, route, model_id):
    """Chat Completions data strings from the upstream stream, always ending with DONE."""
    events = httpx_sse.EventSource(resp).aiter_sse()
    if route == quirks.ROUTE_RESPONSES:
        source = _responses_route_events(events, model_id)
    else:
        source = _chat_route_events(events)
    async for data in source:
        yield data
    yield DONE


# ---------------------------------------------------------------------------
# Streaming: pacing and telemetry
# ---------------------------------------------------------------------------

def _encoder(payload):
    try:
        return get_tokenizer(payload.get("model", "gpt-4o"))
    except Exception as e:
        logger.debug(f"No tokenizer for {payload.get('model')}: {e}")
        return None


def _count_tokens(encoder, text):
    if not text:
        return 0
    if encoder is not None:
        try:
            return len(encoder.encode(text))
        except Exception as e:
            logger.debug(f"Token count fell back to an estimate: {e}")
    return int(len(text) / 4)


def _delta_content(data):
    try:
        content = json.loads(data)["choices"][0]["delta"].get("content")
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        return ""
    return content if isinstance(content, str) else ""


def _new_metrics():
    return {"actual_tokens": 0, "reasoning_tokens": 0, "simulated_tokens": 0.0,
            "start_time": time.time(), "stream_finished": False, "frame": 0}


def _buffered(metrics):
    return max(0.0, metrics["actual_tokens"] - metrics["simulated_tokens"])


def _target_tps(buffered, finished):
    if finished:
        return FAST_TPS
    for limit, tps in PACE_STEPS:
        if buffered < limit:
            return tps
    return FAST_TPS


def _show_progress(metrics):
    elapsed = max(time.time() - metrics["start_time"], 0.01)
    frame = SPINNER[metrics["frame"] % len(SPINNER)]
    metrics["frame"] += 1
    sys.stdout.write(f"\r{frame} Replying to prompt: (Actual: {metrics['actual_tokens'] / elapsed:.1f} t/s) "
                     f"(Simulated: {metrics['simulated_tokens'] / elapsed:.1f} t/s) "
                     f"(Buffer: {_buffered(metrics):.1f} tokens) (Total: {metrics['actual_tokens']} tokens)")
    sys.stdout.flush()


def _finish_line(metrics, prompt_tokens):
    sys.stdout.write("\r" + " " * 80 + "\r")
    sys.stdout.flush()
    elapsed = max(time.time() - metrics["start_time"], 0.01)
    logger.info(f"Prompt Finished (Input: {prompt_tokens}, Output: {metrics['actual_tokens']}, "
                f"Reasoning: {metrics['reasoning_tokens']}) (Avg Output: {metrics['actual_tokens'] / elapsed:.1f} t/s)")


def _sse(chunk):
    return f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"


async def _produce(resp, client, route, model_id, queue, metrics, encoder):
    try:
        async for data in _chat_events(resp, route, model_id):
            metrics["actual_tokens"] += _count_tokens(encoder, _delta_content(data))
            await queue.put(data)
    except Exception as e:
        logger.error(f"Stream producer error: {e}")
        await queue.put(DONE)
    finally:
        metrics["stream_finished"] = True
        await resp.aclose()
        await client.aclose()


async def _emit_sliced(chunk, choice, content, metrics, encoder):
    """Re-emits one content chunk as SLICE_CHARS pieces, paced to the buffer size."""
    finish_reason = choice.get("finish_reason")
    choice["finish_reason"] = None
    usage = chunk.pop("usage", None)
    delta = choice["delta"]
    total_tokens = _count_tokens(encoder, content) or len(content) / 4.0
    for start in range(0, len(content), SLICE_CHARS):
        piece = content[start:start + SLICE_CHARS]
        delta["content"] = piece
        if start + SLICE_CHARS >= len(content):
            choice["finish_reason"] = finish_reason
            if usage is not None:
                chunk["usage"] = usage
        yield _sse(chunk)
        # These belong to the chunk, not to each slice; repeating them would duplicate them.
        for key in ("tool_calls", "role", "reasoning_content"):
            delta.pop(key, None)
        piece_tokens = total_tokens * (len(piece) / len(content))
        metrics["simulated_tokens"] += piece_tokens
        _show_progress(metrics)
        tps = _target_tps(_buffered(metrics), metrics["stream_finished"])
        await asyncio.sleep(piece_tokens / max(tps, 1.0))


async def _emit(data, metrics, encoder):
    """The SSE lines for one upstream data string."""
    raw = f"data: {data}\n\n"
    try:
        chunk = json.loads(data)
    except ValueError:
        yield raw
        return
    choices = chunk.get("choices") if isinstance(chunk, dict) else None
    choice = choices[0] if isinstance(choices, list) and choices else None
    delta = choice.get("delta") if isinstance(choice, dict) else None
    if not isinstance(delta, dict):
        yield raw
        return
    reasoning = normalize_reasoning_delta(delta)
    metrics["reasoning_tokens"] += _count_tokens(encoder, reasoning)
    content = delta.get("content")
    if not isinstance(content, str) or not content:
        # Re-serialised so a renamed reasoning field reaches the client as reasoning_content.
        yield _sse(chunk) if reasoning else raw
        return
    async for line in _emit_sliced(chunk, choice, content, metrics, encoder):
        yield line


async def _paced_stream(resp, client, route, payload, prompt_tokens):
    queue = asyncio.Queue()
    metrics = _new_metrics()
    encoder = _encoder(payload)
    model_id = str(payload.get("model") or "")
    producer = asyncio.create_task(_produce(resp, client, route, model_id, queue, metrics, encoder))
    try:
        for _ in range(MAX_STREAM_EVENTS):
            data = await queue.get()
            if data == DONE:
                _finish_line(metrics, prompt_tokens)
                yield f"data: {DONE}\n\n"
                asyncio.create_task(display_usage())
                return
            async for line in _emit(data, metrics, encoder):
                yield line
    finally:
        producer.cancel()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _prompt_tokens(payload):
    try:
        return get_token_count(payload)["input"]
    except Exception as e:
        logger.debug(f"Could not count prompt tokens: {e}")
        return 0


def _log_prompt_speed(prompt_tokens, started):
    elapsed = max(time.time() - started, 0.001)
    logger.info(f"Prompt processing speed: {prompt_tokens / elapsed:.1f} t/s ({prompt_tokens} tokens in {elapsed:.2f}s)")


async def create_chat_completions(payload: dict, stream: bool = False):
    """A chat completion dict, or an async generator of SSE lines when stream is true."""
    if not isinstance(payload, dict):
        raise HTTPError("The request body must be a JSON object", 400)
    if not state.copilot_token:
        raise HTTPError("Copilot token not found; sign in with `python main.py auth`", 503)
    request = _request_for(payload)
    settings = load_settings()
    _apply_thinking_defaults(payload, settings)
    if not stream:
        return await _complete(payload, request, _non_stream_timeout(settings))
    prompt_tokens = _prompt_tokens(payload)
    started = time.time()
    client, resp, route = await _open_stream(payload, request)
    _log_prompt_speed(prompt_tokens, started)
    return _paced_stream(resp, client, route, payload, prompt_tokens)
