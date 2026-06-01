import json

def map_openai_stop_reason_to_anthropic(finish_reason):
    if finish_reason is None:
        return None
    mapping = {
        "stop": "end_turn",
        "length": "max_tokens",
        "tool_calls": "tool_use",
        "content_filter": "end_turn"
    }
    return mapping.get(finish_reason, "end_turn")

def translate_to_openai(anthropic_payload: dict) -> dict:
    model = anthropic_payload.get("model", "gpt-4o")
    if model.startswith("claude-sonnet-4-"):
        model = model.replace("claude-sonnet-4-", "claude-sonnet-4", 1)
    elif model.startswith("claude-opus-"):
        model = model.replace("claude-opus-4-", "claude-opus-4", 1)

    system = anthropic_payload.get("system")
    messages = []
    if system:
        if isinstance(system, str):
            messages.append({"role": "system", "content": system})
        elif isinstance(system, list):
            sys_text = "\n\n".join([b.get("text", "") for b in system if b.get("type") == "text"])
            messages.append({"role": "system", "content": sys_text})

    for msg in anthropic_payload.get("messages", []):
        role = msg.get("role")
        content = msg.get("content")
        
        if role == "user":
            if isinstance(content, list):
                tool_results = [b for b in content if b.get("type") == "tool_result"]
                other_blocks = [b for b in content if b.get("type") != "tool_result"]
                
                for b in tool_results:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": b.get("tool_use_id"),
                        "content": map_content(b.get("content"))
                    })
                if other_blocks:
                    messages.append({"role": "user", "content": map_content(other_blocks)})
            else:
                messages.append({"role": "user", "content": map_content(content)})
                
        elif role == "assistant":
            if not isinstance(content, list):
                messages.append({"role": "assistant", "content": map_content(content)})
                continue
                
            tool_use_blocks = [b for b in content if b.get("type") == "tool_use"]
            text_blocks = [b for b in content if b.get("type") == "text"]
            thinking_blocks = [b for b in content if b.get("type") == "thinking"]
            
            all_text_content = "\n\n".join(
                [b.get("text", "") for b in text_blocks] +
                [b.get("thinking", "") for b in thinking_blocks]
            )
            
            if tool_use_blocks:
                messages.append({
                    "role": "assistant",
                    "content": all_text_content or None,
                    "tool_calls": [{
                        "id": tu.get("id"),
                        "type": "function",
                        "function": {
                            "name": tu.get("name"),
                            "arguments": json.dumps(tu.get("input", {}))
                        }
                    } for tu in tool_use_blocks]
                })
            else:
                messages.append({"role": "assistant", "content": map_content(content)})

    openai_payload = {
        "model": model,
        "messages": messages,
        "max_tokens": anthropic_payload.get("max_tokens"),
    }
    
    if "stop_sequences" in anthropic_payload:
        openai_payload["stop"] = anthropic_payload["stop_sequences"]
    if "stream" in anthropic_payload:
        openai_payload["stream"] = anthropic_payload["stream"]
    if "temperature" in anthropic_payload:
        openai_payload["temperature"] = anthropic_payload["temperature"]
    if "top_p" in anthropic_payload:
        openai_payload["top_p"] = anthropic_payload["top_p"]
    if "metadata" in anthropic_payload and "user_id" in anthropic_payload["metadata"]:
        openai_payload["user"] = anthropic_payload["metadata"]["user_id"]
        
    tools = anthropic_payload.get("tools")
    if tools:
        openai_payload["tools"] = [{
            "type": "function",
            "function": {
                "name": t.get("name"),
                "description": t.get("description"),
                "parameters": t.get("input_schema")
            }
        } for t in tools]
        
    tool_choice = anthropic_payload.get("tool_choice")
    if tool_choice:
        tc_type = tool_choice.get("type")
        if tc_type == "auto":
            openai_payload["tool_choice"] = "auto"
        elif tc_type == "any":
            openai_payload["tool_choice"] = "required"
        elif tc_type == "tool" and tool_choice.get("name"):
            openai_payload["tool_choice"] = {"type": "function", "function": {"name": tool_choice["name"]}}
        elif tc_type == "none":
            openai_payload["tool_choice"] = "none"
            
    return openai_payload

def map_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
        
    has_image = any(b.get("type") == "image" for b in content)
    if not has_image:
        texts = [b.get("text", "") for b in content if b.get("type") == "text"]
        thinking = [b.get("thinking", "") for b in content if b.get("type") == "thinking"]
        return "\n\n".join(texts + thinking)
        
    parts = []
    for b in content:
        t = b.get("type")
        if t == "text":
            parts.append({"type": "text", "text": b.get("text", "")})
        elif t == "thinking":
            parts.append({"type": "text", "text": b.get("thinking", "")})
        elif t == "image":
            source = b.get("source", {})
            mt = source.get("media_type", "image/jpeg")
            d = source.get("data", "")
            parts.append({"type": "image_url", "image_url": {"url": f"data:{mt};base64,{d}"}})
    return parts

def translate_to_anthropic(response: dict) -> dict:
    all_text_blocks = []
    all_tool_use_blocks = []
    
    choices = response.get("choices", [])
    stop_reason = choices[0].get("finish_reason") if choices else None
    
    for choice in choices:
        msg = choice.get("message", {})
        content = msg.get("content")
        tool_calls = msg.get("tool_calls")
        
        if isinstance(content, str):
            all_text_blocks.append({"type": "text", "text": content})
        elif isinstance(content, list):
            for part in content:
                if part.get("type") == "text":
                    all_text_blocks.append({"type": "text", "text": part.get("text", "")})
                    
        if tool_calls:
            for tc in tool_calls:
                args = tc.get("function", {}).get("arguments", "{}")
                try:
                    args = json.loads(args)
                except:
                    args = {}
                all_tool_use_blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id"),
                    "name": tc.get("function", {}).get("name"),
                    "input": args
                })
                
        if choice.get("finish_reason") == "tool_calls" or stop_reason == "stop":
            stop_reason = choice.get("finish_reason")
            
    usage = response.get("usage", {})
    pt = usage.get("prompt_tokens", 0)
    ct = usage.get("completion_tokens", 0)
    
    ans = {
        "id": response.get("id"),
        "type": "message",
        "role": "assistant",
        "model": response.get("model"),
        "content": all_text_blocks + all_tool_use_blocks,
        "stop_reason": map_openai_stop_reason_to_anthropic(stop_reason),
        "stop_sequence": None,
        "usage": {
            "input_tokens": pt,
            "output_tokens": ct
        }
    }
    return ans

def is_tool_block_open(state: dict) -> bool:
    if not state["contentBlockOpen"]:
        return False
    return any(tc["anthropicBlockIndex"] == state["contentBlockIndex"] for tc in state["toolCalls"].values())

def translate_chunk_to_anthropic_events(chunk: dict, state_obj: dict) -> list:
    events = []
    choices = chunk.get("choices", [])
    if not choices:
        return events
        
    choice = choices[0]
    delta = choice.get("delta", {})
    
    if not state_obj["messageStartSent"]:
        usage = chunk.get("usage", {})
        events.append({
            "type": "message_start",
            "message": {
                "id": chunk.get("id"),
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": chunk.get("model"),
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": usage.get("prompt_tokens", 0),
                    "output_tokens": 0
                }
            }
        })
        state_obj["messageStartSent"] = True

    if delta.get("content"):
        if is_tool_block_open(state_obj):
            events.append({"type": "content_block_stop", "index": state_obj["contentBlockIndex"]})
            state_obj["contentBlockIndex"] += 1
            state_obj["contentBlockOpen"] = False
            
        if not state_obj["contentBlockOpen"]:
            events.append({
                "type": "content_block_start",
                "index": state_obj["contentBlockIndex"],
                "content_block": {"type": "text", "text": ""}
            })
            state_obj["contentBlockOpen"] = True
            
        events.append({
            "type": "content_block_delta",
            "index": state_obj["contentBlockIndex"],
            "delta": {"type": "text_delta", "text": delta["content"]}
        })

    tool_calls = delta.get("tool_calls")
    if tool_calls:
        for tc in tool_calls:
            idx = tc.get("index")
            if tc.get("id") and tc.get("function", {}).get("name"):
                if state_obj["contentBlockOpen"]:
                    events.append({"type": "content_block_stop", "index": state_obj["contentBlockIndex"]})
                    state_obj["contentBlockIndex"] += 1
                    state_obj["contentBlockOpen"] = False
                    
                anthropicBlockIndex = state_obj["contentBlockIndex"]
                state_obj["toolCalls"][idx] = {
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    "anthropicBlockIndex": anthropicBlockIndex
                }
                events.append({
                    "type": "content_block_start",
                    "index": anthropicBlockIndex,
                    "content_block": {
                        "type": "tool_use",
                        "id": tc["id"],
                        "name": tc["function"]["name"],
                        "input": {}
                    }
                })
                state_obj["contentBlockOpen"] = True
                
            if tc.get("function", {}).get("arguments"):
                info = state_obj["toolCalls"].get(idx)
                if info:
                    events.append({
                        "type": "content_block_delta",
                        "index": info["anthropicBlockIndex"],
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": tc["function"]["arguments"]
                        }
                    })

    if choice.get("finish_reason"):
        if state_obj["contentBlockOpen"]:
            events.append({"type": "content_block_stop", "index": state_obj["contentBlockIndex"]})
            state_obj["contentBlockOpen"] = False
            
        usage = chunk.get("usage", {})
        events.append({
            "type": "message_delta",
            "delta": {
                "stop_reason": map_openai_stop_reason_to_anthropic(choice["finish_reason"]),
                "stop_sequence": None
            },
            "usage": {
                "input_tokens": usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("completion_tokens", 0)
            }
        })
        events.append({"type": "message_stop"})
        
    return events
