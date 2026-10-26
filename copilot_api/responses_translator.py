"""Chat Completions <-> OpenAI Responses API, for models Copilot serves only on /responses.

Clients keep speaking Chat Completions. A request is translated just before it is
sent, and the reply (whole or streamed) is translated back, so pacing, telemetry
and reasoning normalisation downstream see ordinary chat completion chunks.
Chat options with no safe Responses equivalent (n, logprobs, temperature, ...)
are dropped.
"""
import json
import time

MAX_MESSAGES = 10000
MAX_PARTS = 1000
MAX_TOOLS = 1000
MAX_OUTPUT_ITEMS = 1000
DEFAULT_PARAMETERS = {"type": "object", "properties": {}}
PASSTHROUGH_KEYS = ("parallel_tool_calls",)
FALLBACK_ID = "chatcmpl-responses"


class ResponsesStreamError(RuntimeError):
    """The upstream Responses stream reported a failure."""


def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# Request: Chat Completions -> Responses
# ---------------------------------------------------------------------------

def _plain_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    texts = [part.get("text") for part in content[:MAX_PARTS] if isinstance(part, dict)]
    return "".join(text for text in texts if isinstance(text, str))


def _image_part(value):
    url = value if isinstance(value, str) else (value.get("url") if isinstance(value, dict) else None)
    if not isinstance(url, str) or not url:
        return None
    detail = value.get("detail") if isinstance(value, dict) else None
    return {"type": "input_image", "image_url": url, "detail": detail if isinstance(detail, str) else "auto"}


def _content_parts(role, content):
    text_type = "output_text" if role == "assistant" else "input_text"
    if isinstance(content, str):
        return [{"type": text_type, "text": content}] if content else []
    if not isinstance(content, list):
        return []
    parts = []
    for part in content[:MAX_PARTS]:
        kind = part.get("type") if isinstance(part, dict) else None
        if kind == "text" and isinstance(part.get("text"), str):
            parts.append({"type": text_type, "text": part["text"]})
        elif kind == "image_url" and role != "assistant":
            image = _image_part(part.get("image_url"))
            if image:
                parts.append(image)
    return parts


def _message_item(role, content):
    parts = _content_parts(role, content)
    return {"type": "message", "role": role, "content": parts} if parts else None


def _function_call_item(call):
    function = call.get("function") if isinstance(call, dict) else None
    if not isinstance(function, dict) or not function.get("name"):
        return None
    arguments = function.get("arguments")
    if isinstance(arguments, dict):
        arguments = json.dumps(arguments)
    return {
        "type": "function_call",
        "call_id": str(call.get("id") or ""),
        "name": str(function["name"]),
        "arguments": arguments if isinstance(arguments, str) and arguments else "{}",
    }


def _assistant_items(msg):
    items = []
    message = _message_item("assistant", msg.get("content"))
    if message:
        items.append(message)
    calls = msg.get("tool_calls")
    for call in (calls if isinstance(calls, list) else [])[:MAX_TOOLS]:
        item = _function_call_item(call)
        if item:
            items.append(item)
    return items


def _tool_output(msg):
    return {
        "type": "function_call_output",
        "call_id": str(msg.get("tool_call_id") or ""),
        "output": _plain_text(msg.get("content")),
    }


def _translate_messages(messages):
    """(instructions, input items) for a list of chat messages."""
    instructions, items = [], []
    for msg in messages[:MAX_MESSAGES]:
        role = msg.get("role") if isinstance(msg, dict) else None
        if role in ("system", "developer"):
            text = _plain_text(msg.get("content"))
            if text:
                instructions.append(text)
        elif role == "tool":
            items.append(_tool_output(msg))
        elif role == "assistant":
            items.extend(_assistant_items(msg))
        elif role == "user":
            item = _message_item("user", msg.get("content"))
            if item:
                items.append(item)
    return "\n\n".join(instructions), items


def _translate_tools(tools):
    result = []
    for tool in (tools if isinstance(tools, list) else [])[:MAX_TOOLS]:
        if not isinstance(tool, dict) or tool.get("type", "function") != "function":
            continue
        function = tool.get("function")
        if not isinstance(function, dict) or not function.get("name"):
            continue
        entry = {"type": "function", "name": function["name"],
                 "parameters": function.get("parameters") or dict(DEFAULT_PARAMETERS)}
        if function.get("description"):
            entry["description"] = function["description"]
        if "strict" in function:
            entry["strict"] = function["strict"]
        result.append(entry)
    return result


def _translate_tool_choice(choice):
    if isinstance(choice, str):
        return choice
    if isinstance(choice, dict):
        function = choice.get("function")
        if isinstance(function, dict) and function.get("name"):
            return {"type": "function", "name": function["name"]}
    return None


def _max_output_tokens(payload):
    for key in ("max_completion_tokens", "max_tokens"):
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return None


def chat_to_responses(payload):
    """The /responses request body for a Chat Completions payload. Raises ValueError."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be a dict")
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        raise ValueError("payload.messages must be a list")
    instructions, items = _translate_messages(messages)
    body = {"model": payload.get("model"), "input": items, "stream": bool(payload.get("stream")), "store": False}
    if instructions:
        body["instructions"] = instructions
    max_output = _max_output_tokens(payload)
    if max_output:
        body["max_output_tokens"] = max_output
    tools = _translate_tools(payload.get("tools"))
    if tools:
        body["tools"] = tools
        choice = _translate_tool_choice(payload.get("tool_choice"))
        if choice is not None:
            body["tool_choice"] = choice
    effort = payload.get("reasoning_effort")
    if isinstance(effort, str) and effort:
        body["reasoning"] = {"effort": effort, "summary": "auto"}
    for key in PASSTHROUGH_KEYS:
        if payload.get(key) is not None:
            body[key] = payload[key]
    return body


# ---------------------------------------------------------------------------
# Whole reply: Responses -> chat.completion
# ---------------------------------------------------------------------------

def _output_texts(item):
    texts = []
    content = item.get("content")
    for part in (content if isinstance(content, list) else [])[:MAX_PARTS]:
        kind = part.get("type") if isinstance(part, dict) else None
        text = part.get("text") if kind == "output_text" else (part.get("refusal") if kind == "refusal" else None)
        if isinstance(text, str):
            texts.append(text)
    return texts


def _reasoning_texts(item):
    summary = item.get("summary")
    parts = summary if isinstance(summary, list) else []
    return [part["text"] for part in parts[:MAX_PARTS] if isinstance(part, dict) and isinstance(part.get("text"), str)]


def _chat_tool_call(item):
    arguments = item.get("arguments")
    return {
        "id": str(item.get("call_id") or item.get("id") or ""),
        "type": "function",
        "function": {"name": str(item.get("name") or ""), "arguments": arguments if isinstance(arguments, str) else "{}"},
    }


def _finish_reason(response, has_calls):
    if response.get("status") == "incomplete":
        details = response.get("incomplete_details")
        reason = details.get("reason") if isinstance(details, dict) else None
        return "content_filter" if reason == "content_filter" else "length"
    return "tool_calls" if has_calls else "stop"


def _usage(usage):
    if not isinstance(usage, dict):
        return None
    prompt = _int(usage.get("input_tokens"))
    completion = _int(usage.get("output_tokens"))
    result = {"prompt_tokens": prompt, "completion_tokens": completion,
              "total_tokens": _int(usage.get("total_tokens")) or prompt + completion}
    details = usage.get("output_tokens_details")
    if isinstance(details, dict) and details.get("reasoning_tokens") is not None:
        result["completion_tokens_details"] = {"reasoning_tokens": _int(details.get("reasoning_tokens"))}
    return result


def responses_to_chat(data, model):
    """A chat.completion dict for a whole /responses reply. Raises ValueError."""
    if not isinstance(data, dict):
        raise ValueError("the reply is not a JSON object")
    texts, reasoning, calls = [], [], []
    output = data.get("output")
    for item in (output if isinstance(output, list) else [])[:MAX_OUTPUT_ITEMS]:
        kind = item.get("type") if isinstance(item, dict) else None
        if kind == "message":
            texts.extend(_output_texts(item))
        elif kind == "reasoning":
            reasoning.extend(_reasoning_texts(item))
        elif kind == "function_call":
            calls.append(_chat_tool_call(item))
    message = {"role": "assistant", "content": "".join(texts) if texts or not calls else None}
    if reasoning:
        message["reasoning_content"] = "\n\n".join(reasoning)
    if calls:
        message["tool_calls"] = calls
    reply = {
        "id": str(data.get("id") or FALLBACK_ID),
        "object": "chat.completion",
        "created": _int(data.get("created_at")) or int(time.time()),
        "model": str(data.get("model") or model or ""),
        "choices": [{"index": 0, "message": message, "finish_reason": _finish_reason(data, bool(calls))}],
    }
    usage = _usage(data.get("usage"))
    if usage:
        reply["usage"] = usage
    return reply


# ---------------------------------------------------------------------------
# Streamed reply: Responses events -> chat.completion.chunk
# ---------------------------------------------------------------------------

class ResponsesStreamState:
    """What event_to_chunks remembers across one streamed reply."""

    def __init__(self, model):
        self.model = str(model or "")
        self.id = FALLBACK_ID
        self.created = int(time.time())
        self.role_sent = False
        self.finished = False
        self.saw_tool_call = False
        self.tool_count = 0
        self.tool_by_item = {}
        self.tool_by_output = {}


def _chunk(state, delta, finish_reason=None, usage=None):
    if not state.role_sent:
        delta = {"role": "assistant", **delta}
        state.role_sent = True
    chunk = {
        "id": state.id, "object": "chat.completion.chunk", "created": state.created, "model": state.model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage:
        chunk["usage"] = usage
    return chunk


def _on_created(data, state):
    response = data.get("response")
    if isinstance(response, dict):
        state.id = str(response.get("id") or state.id)
        state.model = str(response.get("model") or state.model)
        created = _int(response.get("created_at"))
        if created:
            state.created = created
    return []


def _on_text(data, state):
    delta = data.get("delta")
    return [_chunk(state, {"content": delta})] if isinstance(delta, str) and delta else []


def _on_reasoning(data, state):
    delta = data.get("delta")
    return [_chunk(state, {"reasoning_content": delta})] if isinstance(delta, str) and delta else []


def _on_summary_part(data, state):
    index = data.get("summary_index")
    if isinstance(index, int) and not isinstance(index, bool) and index > 0:
        return [_chunk(state, {"reasoning_content": "\n\n"})]
    return []


def _on_item_added(data, state):
    item = data.get("item")
    if not isinstance(item, dict) or item.get("type") != "function_call":
        return []
    index = state.tool_count
    state.tool_count += 1
    state.saw_tool_call = True
    if isinstance(item.get("id"), str):
        state.tool_by_item[item["id"]] = index
    if isinstance(data.get("output_index"), int):
        state.tool_by_output[data["output_index"]] = index
    call = {"index": index, "id": str(item.get("call_id") or item.get("id") or ""), "type": "function",
            "function": {"name": str(item.get("name") or ""), "arguments": ""}}
    return [_chunk(state, {"tool_calls": [call]})]


def _tool_index(data, state):
    item_id = data.get("item_id")
    if isinstance(item_id, str) and item_id in state.tool_by_item:
        return state.tool_by_item[item_id]
    output_index = data.get("output_index")
    return state.tool_by_output.get(output_index) if isinstance(output_index, int) else None


def _on_arguments(data, state):
    delta = data.get("delta")
    index = _tool_index(data, state)
    if index is None or not isinstance(delta, str) or not delta:
        return []
    return [_chunk(state, {"tool_calls": [{"index": index, "function": {"arguments": delta}}]})]


def _on_done(data, state):
    response = data.get("response") if isinstance(data.get("response"), dict) else {}
    state.finished = True
    reason = _finish_reason(response, state.saw_tool_call)
    return [_chunk(state, {}, reason, _usage(response.get("usage")))]


def _failure_message(data):
    response = data.get("response")
    error = response.get("error") if isinstance(response, dict) else data.get("error")
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    if data.get("message"):
        return str(data["message"])
    return "The Responses stream failed"


def _on_failed(data, state):
    state.finished = True
    raise ResponsesStreamError(_failure_message(data))


HANDLERS = {
    "response.created": _on_created,
    "response.in_progress": _on_created,
    "response.output_text.delta": _on_text,
    "response.refusal.delta": _on_text,
    "response.reasoning_summary_text.delta": _on_reasoning,
    "response.reasoning_text.delta": _on_reasoning,
    "response.reasoning_summary_part.added": _on_summary_part,
    "response.output_item.added": _on_item_added,
    "response.function_call_arguments.delta": _on_arguments,
    "response.completed": _on_done,
    "response.incomplete": _on_done,
    "response.failed": _on_failed,
    "error": _on_failed,
}


def event_to_chunks(event_name, raw_data, state):
    """Chat completion chunks for one Responses SSE event. Raises ResponsesStreamError."""
    if not isinstance(state, ResponsesStreamState):
        raise TypeError("state must be a ResponsesStreamState")
    try:
        data = json.loads(raw_data) if raw_data else {}
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    handler = HANDLERS.get(data.get("type") or event_name)
    return handler(data, state) if handler else []
