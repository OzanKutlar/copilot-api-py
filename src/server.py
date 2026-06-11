import json
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
import os
from fastapi.responses import JSONResponse, StreamingResponse, HTMLResponse
from src.config import state, logger, load_pricing_config, get_model_multiplier
from src.utils import HTTPError, await_approval, check_rate_limit, get_token_count
from src.services import create_chat_completions, create_embeddings, get_copilot_usage, cache_models
from src.anthropic_translator import translate_to_openai, translate_to_anthropic, translate_chunk_to_anthropic_events

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(HTTPError)
async def http_error_handler(request: Request, exc: HTTPError):
    logger.error(f"HTTP error: {exc.data}")
    if isinstance(exc.data, dict) and "error" in exc.data:
        content = exc.data
    else:
        content = {"error": {"message": str(exc.data), "type": "error"}}
    return JSONResponse(
        status_code=exc.status_code,
        content=content
    )

@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.error(f"Error occurred: {exc}")
    return JSONResponse(status_code=500, content={"error": {"message": str(exc), "type": "error"}})

@app.get("/")
async def root():
    index_path = os.path.join("pages", "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return Response("Server running")

async def handle_completion(payload: dict):
    await check_rate_limit()
    model = payload.get("model", "unknown")
    messages_count = len(payload.get("messages", []))
    logger.debug(f"OpenAI request - Model: {model}, Messages: {messages_count}")

    try:
        tc = get_token_count(payload)
        logger.info(f"Current token count: {tc}")
    except Exception as e:
        logger.warn(f"Failed to calculate token count: {e}")

    if state.manual_approve:
        await await_approval()

    if ("max_tokens" not in payload or payload["max_tokens"] is None) and \
       ("max_completion_tokens" not in payload or payload["max_completion_tokens"] is None):
        payload["max_tokens"] = 16384
        logger.debug("Set max_tokens to: 16384")

    stream = payload.get("stream", False)
    response_gen = await create_chat_completions(payload, stream)

    if not stream:
        logger.debug("Non-streaming response completed successfully")
        return JSONResponse(response_gen)

    logger.debug("Streaming response")
    return StreamingResponse(response_gen, media_type="text/event-stream")

@app.post("/chat/completions")
@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    payload = await request.json()
    return await handle_completion(payload)

@app.get("/models")
@app.get("/v1/models")
async def models(request: Request):
    if not state.models:
        await cache_models()
        
    pricing_config = load_pricing_config()
    providers = pricing_config.get("providers", [])
        
    models_list = []
    for m in state.models.get("data", []):
        model_id = m.get("id")
        multiplier_val, multiplier_label = get_model_multiplier(model_id, pricing_config)
        
        provider_id = "other"
        for p in providers:
            if p.get("id") == "other": continue
            if any(kw.lower() in model_id.lower() for kw in p.get("keywords", [])):
                provider_id = p["id"]
                break
        
        models_list.append({
            "id": model_id,
            "object": "model",
            "type": "model",
            "created": 0,
            "created_at": "1970-01-01T00:00:00.000Z",
            "owned_by": m.get("vendor"),
            "display_name": m.get("name"),
            "multiplier": multiplier_val,
            "multiplier_label": multiplier_label,
            "provider_id": provider_id
        })
        
    # Sort by highest multiplier first, then alphabetically by ID
    models_list.sort(key=lambda x: (-x["multiplier"], x["id"]))
        
    return JSONResponse({"object": "list", "data": models_list, "providers": providers, "has_more": False})

@app.post("/embeddings")
@app.post("/v1/embeddings")
async def embeddings(request: Request):
    payload = await request.json()
    resp = await create_embeddings(payload)
    return JSONResponse(resp)

@app.get("/usage")
async def usage(request: Request):
    usage_data = await get_copilot_usage()
    return JSONResponse(usage_data)

@app.get("/token")
async def get_token(request: Request):
    return JSONResponse({"token": state.copilot_token})

@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    await check_rate_limit()
    anthropic_payload = await request.json()
    model = anthropic_payload.get("model", "unknown")
    messages_count = len(anthropic_payload.get("messages", []))
    logger.debug(f"Anthropic request - Model: {model}, Messages: {messages_count}")
    
    openai_payload = translate_to_openai(anthropic_payload)
    logger.debug(f"Translated to OpenAI - Model: {openai_payload.get('model')}")
    
    if state.manual_approve:
        await await_approval()
        
    stream = openai_payload.get("stream", False)
    resp = await create_chat_completions(openai_payload, stream)
    
    if not stream:
        logger.debug("Non-streaming response from Copilot completed successfully")
        anth_resp = translate_to_anthropic(resp)
        return JSONResponse(anth_resp)
        
    logger.debug("Streaming response from Copilot")
    
    async def sse_translator():
        stream_state = {
            "messageStartSent": False,
            "contentBlockIndex": 0,
            "contentBlockOpen": False,
            "toolCalls": {}
        }
        async for chunk_str in resp:
            if chunk_str.startswith("data: "):
                data_str = chunk_str[6:].strip()
                if data_str == "[DONE]":
                    break
                if not data_str:
                    continue
                try:
                    chunk_json = json.loads(data_str)
                    events = translate_chunk_to_anthropic_events(chunk_json, stream_state)
                    for ev in events:
                        logger.debug(f"Translated Anthropic event: {ev}")
                        yield f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n"
                except Exception as e:
                    logger.error(f"Stream parse error: {e}")
    
    return StreamingResponse(sse_translator(), media_type="text/event-stream")

@app.post("/v1/count_tokens")
@app.post("/count_tokens")
async def count_tokens_endpoint(request: Request):
    try:
        payload = await request.json()
        tc = get_token_count(payload)
        return JSONResponse({"total_tokens": tc.get("input", 0) + tc.get("output", 0)})
    except Exception as e:
        logger.error(f"Token count error: {e}")
        return JSONResponse({"total_tokens": 0})

@app.post("/v1/messages/count_tokens")
async def anthropic_count_tokens(request: Request):
    anthropic_payload = await request.json()
    anthropic_beta = request.headers.get("anthropic-beta", "")
    
    openai_payload = translate_to_openai(anthropic_payload)
    token_count = get_token_count(openai_payload)
    
    tools = anthropic_payload.get("tools", [])
    if tools:
        mcp_exist = False
        if anthropic_beta.startswith("claude-code"):
            mcp_exist = any(t.get("name", "").startswith("mcp__") for t in tools)
        if not mcp_exist:
            if anthropic_payload.get("model", "").startswith("claude"):
                token_count["input"] += 346
            elif anthropic_payload.get("model", "").startswith("grok"):
                token_count["input"] += 480
                
    final = token_count["input"] + token_count["output"]
    if anthropic_payload.get("model", "").startswith("claude"):
        final = int(final * 1.15)
    elif anthropic_payload.get("model", "").startswith("grok"):
        final = int(final * 1.03)
        
    logger.info(f"Token count: {final}")
    return JSONResponse({"input_tokens": final})
