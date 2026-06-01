import json
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from src.config import state, logger
from src.utils import HTTPError, await_approval, check_rate_limit, get_token_count, cache_models
from src.services import create_chat_completions, create_embeddings, get_copilot_usage
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
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"message": str(exc.data), "type": "error"}}
    )

@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.error(f"Error occurred: {exc}")
    return JSONResponse(status_code=500, content={"error": {"message": str(exc), "type": "error"}})

@app.get("/")
async def root():
    return Response("Server running")

async def handle_completion(payload: dict):
    await check_rate_limit()
    logger.debug(f"Request payload: {str(payload)[-400:]}")

    try:
        tc = get_token_count(payload)
        logger.info(f"Current token count: {tc}")
    except Exception as e:
        logger.warn(f"Failed to calculate token count: {e}")

    if state.manual_approve:
        await await_approval()

    if "max_tokens" not in payload or payload["max_tokens"] is None:
        payload["max_tokens"] = 4096
        logger.debug(f"Set max_tokens to: {payload['max_tokens']}")

    stream = payload.get("stream", False)
    response_gen = await create_chat_completions(payload, stream)

    if not stream:
        logger.debug(f"Non-streaming response: {str(response_gen)[:400]}")
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
        
    models_list = []
    for m in state.models.get("data", []):
        models_list.append({
            "id": m.get("id"),
            "object": "model",
            "type": "model",
            "created": 0,
            "created_at": "1970-01-01T00:00:00.000Z",
            "owned_by": m.get("vendor"),
            "display_name": m.get("name")
        })
    return JSONResponse({"object": "list", "data": models_list, "has_more": False})

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
    logger.debug(f"Anthropic request payload: {anthropic_payload}")
    
    openai_payload = translate_to_openai(anthropic_payload)
    logger.debug(f"Translated OpenAI request payload: {openai_payload}")
    
    if state.manual_approve:
        await await_approval()
        
    stream = openai_payload.get("stream", False)
    resp = await create_chat_completions(openai_payload, stream)
    
    if not stream:
        logger.debug(f"Non-streaming response from Copilot: {str(resp)[-400:]}")
        anth_resp = translate_to_anthropic(resp)
        logger.debug(f"Translated Anthropic response: {anth_resp}")
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
