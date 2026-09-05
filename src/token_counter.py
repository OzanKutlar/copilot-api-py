import json
import time
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor

from src.config import (
    APP_DIR,
    load_settings,
    resolve_logo_to_data_uri,
    logger,
    state
)
from src.utils import get_tokenizer, calculate_message_tokens
from src.history import get_all_history, atomic_write_json

# Bumping this invalidates every cached entry at once. Change it whenever the
# counting logic or the cached shape changes, otherwise stale numbers survive
# an upgrade. Version 2 introduced per-day bucketing.
TOKEN_CACHE_VERSION = 2
TOKEN_CACHE_PATH = APP_DIR / "token_counter_cache.json"

# tiktoken encodes in Rust and releases the GIL, so a small pool is a real
# speedup. Bounded so a huge backlog cannot exhaust threads.
MAX_COUNT_WORKERS = 4
PROGRESS_LOG_EVERY = 25

# Overhead the API adds when priming the assistant's reply.
ASSISTANT_PRIMING_TOKENS = 3

# Prices are expressed per this many tokens, matching how every major provider
# publishes them. Kept here so the frontend and backend cannot disagree.
PRICE_UNIT = 1000000

# Bucket key for turns whose date could not be resolved at all. They still
# count toward all-time totals but are excluded from the daily series, which is
# far better than attributing them to the epoch and skewing every chart.
UNDATED_KEY = ""

_encoder_lock = threading.Lock()
_encoder_cache = {}


def _resolve_encoder(model_id: str):
    """Returns (encoding_name, encoder) for a model, memoized across runs.

    Guarded by a lock because changed conversations are counted in a thread
    pool and would otherwise race on first population.
    """
    key = model_id or "unknown"
    with _encoder_lock:
        cached = _encoder_cache.get(key)
    if cached is not None:
        return cached

    try:
        encoder = get_tokenizer(key)
    except Exception:
        encoder = get_tokenizer("gpt-4o")

    name = getattr(encoder, "name", None) or "cl100k_base"
    entry = (name, encoder)
    with _encoder_lock:
        _encoder_cache[key] = entry
    return entry


def _match_configured_provider(model_lower: str, providers: list):
    """Keyword match against the configured picture groups.

    Checked before custom endpoints on purpose: a model whose id matches a
    provider grouping belongs under that provider's logo regardless of which
    local endpoint happens to be serving it.
    """
    for p in providers:
        if not isinstance(p, dict):
            continue
        p_id = p.get("id", "other")
        if p_id == "other":
            continue
        for kw in (p.get("keywords") or []):
            if not kw:
                continue
            if str(kw).lower() in model_lower:
                return {
                    "id": p_id,
                    "name": p.get("name", str(p_id).capitalize()),
                    "logo": resolve_logo_to_data_uri(p.get("logo", "")),
                    "is_custom": False
                }
    return None


def _match_custom_endpoint(model_id: str, model_lower: str, custom_eps: list):
    for ep in custom_eps:
        if not isinstance(ep, dict):
            continue
        ep_name = ep.get("name", "Custom")
        ep_models = ep.get("models", [])
        if isinstance(ep_models, str):
            ep_models = [m.strip() for m in ep_models.split(",") if m.strip()]
        if not isinstance(ep_models, list):
            ep_models = []

        matches_listed = any(
            isinstance(m, str) and (m.lower() == model_lower or m.lower() in model_lower)
            for m in ep_models
        )
        if matches_listed or f"({str(ep_name).lower()})" in model_lower:
            return {
                "id": str(ep_name).lower().replace(" ", "_"),
                "name": ep_name,
                "logo": resolve_logo_to_data_uri(ep.get("logo", "")),
                "is_custom": True
            }

    if state.models:
        for m in state.models.get("data", []):
            if not isinstance(m, dict):
                continue
            if m.get("id") != model_id and m.get("_raw_model_id") != model_id:
                continue
            ep = m.get("_custom_endpoint")
            if isinstance(ep, dict):
                ep_name = ep.get("name", "Custom")
                return {
                    "id": str(ep_name).lower().replace(" ", "_"),
                    "name": ep_name,
                    "logo": resolve_logo_to_data_uri(ep.get("logo", "")),
                    "is_custom": True
                }
    return None


def resolve_model_provider(model_id: str, settings: dict) -> dict:
    """Resolves the provider id, display name, and logo data for any model ID.

    Resolution order matches the /v1/models endpoint: configured provider
    keywords first, then the custom endpoint that serves the model, then
    coarse prefix heuristics. Deliberately never cached alongside token
    counts, so renaming a provider or editing its keywords takes effect on the
    next read without forcing a full recount.
    """
    model_lower = (model_id or "").lower()

    matched = _match_configured_provider(model_lower, settings.get("providers", []))
    if matched:
        return matched

    matched = _match_custom_endpoint(model_id, model_lower, settings.get("custom_endpoints", []))
    if matched:
        return matched

    if "claude" in model_lower or "anthropic" in model_lower:
        return {"id": "anthropic", "name": "Anthropic", "logo": "", "is_custom": False}
    if "gpt" in model_lower or "o1" in model_lower or "o3" in model_lower or "openai" in model_lower:
        return {"id": "openai", "name": "OpenAI", "logo": "", "is_custom": False}
    if "gemini" in model_lower or "google" in model_lower:
        return {"id": "google", "name": "Google", "logo": "", "is_custom": False}

    return {"id": "other", "name": "Other", "logo": "", "is_custom": False}


def _conversation_fallback_ts(conv: dict) -> int:
    """Best available creation time for a conversation, in epoch milliseconds.

    Prefers the id, which encodes creation time and never changes, over
    `updatedAt`, which moves on every save. Used to date turns written before
    messages carried their own `ts`.
    """
    cid = str(conv.get("id") or "")
    if cid.startswith("conv_"):
        head = cid[5:].split("_")[0]
        if head.isdigit():
            val = int(head)
            if val > 0:
                return val

    updated = conv.get("updatedAt")
    if isinstance(updated, (int, float)) and updated > 0:
        return int(updated)
    return 0


def _message_timestamp(msg: dict, fallback_ms: int) -> int:
    raw = msg.get("ts")
    if isinstance(raw, (int, float)) and raw > 0:
        return int(raw)
    return fallback_ms


def _day_key(ms: int) -> str:
    """Local-time YYYY-MM-DD bucket, or UNDATED_KEY when there is no date."""
    if not ms or ms <= 0:
        return UNDATED_KEY
    try:
        return time.strftime("%Y-%m-%d", time.localtime(ms / 1000.0))
    except (ValueError, OverflowError, OSError):
        return UNDATED_KEY


def _pricing_config(settings: dict) -> dict:
    """Validated pricing map. Entries priced at zero on both sides are dropped
    so an untouched row never looks like a deliberate free model."""
    raw = settings.get("model_pricing")
    if not isinstance(raw, dict):
        raw = {}

    models = raw.get("models")
    if not isinstance(models, dict):
        models = {}

    clean = {}
    for model_id, entry in models.items():
        if not isinstance(entry, dict):
            continue
        try:
            inp = float(entry.get("input", 0) or 0)
            out = float(entry.get("output", 0) or 0)
        except (TypeError, ValueError):
            continue
        if inp <= 0 and out <= 0:
            continue
        clean[str(model_id)] = {"input": inp, "output": out}

    return {
        "currency": str(raw.get("currency") or "USD"),
        "unit": PRICE_UNIT,
        "models": clean
    }


def _cost_for(input_tokens: int, output_tokens: int, price) -> float:
    if not isinstance(price, dict):
        return 0.0
    inp_rate = float(price.get("input", 0.0) or 0.0)
    out_rate = float(price.get("output", 0.0) or 0.0)
    return (input_tokens / PRICE_UNIT) * inp_rate + (output_tokens / PRICE_UNIT) * out_rate


def _conversation_fingerprint(conv: dict) -> str:
    """SHA-256 over only the token-relevant projection of a conversation.

    Volatile fields (title, folderId, reasoningExpanded, derived
    executionInfo/pruneInfo) are excluded on purpose: none of them change the
    token count. The message `ts` and the conversation fallback timestamp are
    included, because both change which day bucket a turn lands in.
    """
    h = hashlib.sha256()
    h.update(str(TOKEN_CACHE_VERSION).encode("utf-8"))
    h.update(str(_conversation_fallback_ts(conv)).encode("utf-8"))
    h.update(b"\x1d")

    messages = conv.get("messages") if isinstance(conv, dict) else None
    if not isinstance(messages, list):
        messages = []

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        projection = {
            "role": msg.get("role"),
            "model": msg.get("model"),
            "isError": bool(msg.get("isError")),
            "ts": msg.get("ts"),
            "content": msg.get("content"),
            "reasoning": msg.get("reasoning")
        }
        encoded = json.dumps(projection, sort_keys=True, ensure_ascii=False, default=str)
        h.update(encoded.encode("utf-8"))
        # Record separator, so two adjacent messages cannot hash the same as
        # one concatenated message.
        h.update(b"\x1e")

    return h.hexdigest()


def _load_cache() -> dict:
    if not TOKEN_CACHE_PATH.exists():
        return {}
    try:
        raw = json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warn(f"[Token Counter] Cache unreadable, rebuilding from scratch: {e}")
        return {}

    if not isinstance(raw, dict) or raw.get("version") != TOKEN_CACHE_VERSION:
        return {}

    entries = raw.get("conversations")
    return entries if isinstance(entries, dict) else {}


def _save_cache(entries: dict) -> None:
    payload = {"version": TOKEN_CACHE_VERSION, "conversations": entries}
    if not atomic_write_json(TOKEN_CACHE_PATH, payload):
        logger.warn("[Token Counter] Failed to persist cache; the next run will recount everything.")


def clear_token_cache() -> bool:
    try:
        if TOKEN_CACHE_PATH.exists():
            TOKEN_CACHE_PATH.unlink()
        return True
    except Exception as e:
        logger.error(f"[Token Counter] Failed to clear cache: {e}")
        return False


def _count_output_tokens(assistant_msg: dict, encoder) -> int:
    """Assistant-generated tokens: visible content plus any reasoning trace."""
    total = 0

    content = assistant_msg.get("content", "")
    if isinstance(content, str) and content:
        total += len(encoder.encode(content))
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("text"):
                total += len(encoder.encode(part["text"]))

    reasoning = assistant_msg.get("reasoning", "")
    if isinstance(reasoning, str) and reasoning.strip():
        total += len(encoder.encode(reasoning.strip()))

    return total


def count_conversation_tokens(conv: dict) -> dict:
    """Walks one conversation once, returning
    {model_id: {day_key: {input, output, turns}}}.

    Input tokens for a turn are the cumulative tokens of every preceding
    message plus the assistant priming overhead, which is what the model
    actually ingested. That running sum is carried forward rather than
    recomputed per turn, keeping the walk linear in message count.

    Running sums are keyed by encoding name, not model id: models sharing an
    encoding share a sum, and a thread that switches to a genuinely different
    encoding pays a single backfill at the point of the switch.
    """
    result = {}

    messages = conv.get("messages") if isinstance(conv, dict) else None
    if not isinstance(messages, list) or not messages:
        return result

    fallback_ms = _conversation_fallback_ts(conv)

    history = []
    running = {}
    active_encoders = {}

    for msg in messages:
        if not isinstance(msg, dict):
            continue

        if msg.get("role") == "assistant" and not msg.get("isError"):
            model_id = msg.get("model") or "unknown"
            enc_name, encoder = _resolve_encoder(model_id)

            if enc_name not in running:
                backfill = 0
                for prior in history:
                    backfill += calculate_message_tokens(prior, encoder)
                running[enc_name] = backfill
                active_encoders[enc_name] = encoder

            input_tokens = (running[enc_name] + ASSISTANT_PRIMING_TOKENS) if history else 0
            output_tokens = _count_output_tokens(msg, encoder)
            day = _day_key(_message_timestamp(msg, fallback_ms))

            days = result.get(model_id)
            if days is None:
                days = {}
                result[model_id] = days
            row = days.get(day)
            if row is None:
                row = {"input": 0, "output": 0, "turns": 0}
                days[day] = row

            row["input"] += input_tokens
            row["output"] += output_tokens
            row["turns"] += 1

        history.append(msg)
        for enc_name, encoder in active_encoders.items():
            running[enc_name] += calculate_message_tokens(msg, encoder)

    return result


def _partition_conversations(conversations, cache, force):
    """Splits conversations into cache hits and entries needing a recount."""
    hits = []
    misses = []

    for conv in conversations:
        conv_id = str(conv.get("id") or "")
        fingerprint = _conversation_fingerprint(conv)
        entry = cache.get(conv_id) if (conv_id and not force) else None

        if entry and entry.get("hash") == fingerprint and isinstance(entry.get("models"), dict):
            hits.append((conv_id, fingerprint, entry["models"]))
        else:
            misses.append((conv_id, fingerprint, conv))

    return hits, misses


def _recount_misses(misses):
    """Recounts changed conversations across a bounded worker pool."""
    computed = []
    if not misses:
        return computed

    workers = min(MAX_COUNT_WORKERS, len(misses))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            (conv_id, fingerprint, pool.submit(count_conversation_tokens, conv))
            for conv_id, fingerprint, conv in misses
        ]
        for idx, (conv_id, fingerprint, future) in enumerate(futures, start=1):
            try:
                computed.append((conv_id, fingerprint, future.result()))
            except Exception as e:
                logger.error(f"[Token Counter] Failed to count conversation '{conv_id}': {e}")
                computed.append((conv_id, fingerprint, {}))
            if idx % PROGRESS_LOG_EVERY == 0:
                logger.info(f"[Token Counter] Recounted {idx}/{len(misses)} changed conversation(s)...")

    return computed


def _accumulate(entries):
    """Folds cached and freshly counted maps into all-time and per-day views."""
    per_model = {}
    daily_map = {}
    undated_turns = 0

    for _, _, models_map in entries:
        if not isinstance(models_map, dict):
            continue
        for model_id, days in models_map.items():
            if not isinstance(days, dict):
                continue
            for day, row in days.items():
                if not isinstance(row, dict):
                    continue
                inp = int(row.get("input", 0) or 0)
                out = int(row.get("output", 0) or 0)
                turns = int(row.get("turns", 0) or 0)

                agg = per_model.get(model_id)
                if agg is None:
                    agg = {"input": 0, "output": 0, "turns": 0}
                    per_model[model_id] = agg
                agg["input"] += inp
                agg["output"] += out
                agg["turns"] += turns

                if not day:
                    undated_turns += turns
                    continue

                day_models = daily_map.get(day)
                if day_models is None:
                    day_models = {}
                    daily_map[day] = day_models
                drow = day_models.get(model_id)
                if drow is None:
                    drow = {"input": 0, "output": 0, "turns": 0}
                    day_models[model_id] = drow
                drow["input"] += inp
                drow["output"] += out
                drow["turns"] += turns

    return per_model, daily_map, undated_turns


def calculate_all_chat_tokens(force: bool = False) -> dict:
    """Retroactively tallies input and output tokens per model and provider,
    bucketed by day so the UI can filter to any window.

    Conversations whose content hash is unchanged since the last run are not
    re-tokenized; their stored counts are added straight back in.
    """
    start_time = time.perf_counter()

    settings = load_settings()
    pricing = _pricing_config(settings)
    price_models = pricing["models"]

    history_data = get_all_history()
    conversations = [c for c in history_data.get("conversations", []) if isinstance(c, dict)]

    cache = {} if force else _load_cache()
    hits, misses = _partition_conversations(conversations, cache, force)

    mode = "forced rebuild" if force else "cached"
    logger.info(
        f"[Token Counter] Scanning {len(conversations)} conversation(s) "
        f"[{mode}] ({len(hits)} cached, {len(misses)} changed)..."
    )

    computed = _recount_misses(misses)

    # Only raw per-model, per-day counts are persisted. Provider attribution
    # and pricing are derived below on every run, so settings edits apply
    # without forcing a recount.
    next_cache = {}
    for conv_id, fingerprint, models_map in hits:
        if conv_id:
            next_cache[conv_id] = {"hash": fingerprint, "models": models_map}
    for conv_id, fingerprint, models_map in computed:
        if conv_id:
            next_cache[conv_id] = {"hash": fingerprint, "models": models_map}

    per_model, daily_map, undated_turns = _accumulate(hits + computed)

    by_model = {}
    by_provider = {}
    model_index = {}
    total_input = 0
    total_output = 0
    total_turns = 0
    total_cost = 0.0

    for model_id, agg in per_model.items():
        prov_info = resolve_model_provider(model_id, settings)
        prov_id = prov_info["id"]
        inp = agg["input"]
        out = agg["output"]
        turns = agg["turns"]
        price = price_models.get(model_id)
        cost = _cost_for(inp, out, price)

        logger.info(f"[Token Counter] Model '{model_id}' (Provider: {prov_info['name']}) \u00b7 {turns} turn(s)")

        model_index[model_id] = {
            "provider_id": prov_id,
            "provider_name": prov_info["name"],
            "provider_logo": prov_info["logo"]
        }

        by_model[model_id] = {
            "model_id": model_id,
            "provider_id": prov_id,
            "provider_name": prov_info["name"],
            "provider_logo": prov_info["logo"],
            "input_tokens": inp,
            "output_tokens": out,
            "total_tokens": inp + out,
            "turns": turns,
            "cost": cost,
            "has_price": bool(price)
        }

        prov = by_provider.get(prov_id)
        if prov is None:
            prov = {
                "provider_id": prov_id,
                "name": prov_info["name"],
                "logo": prov_info["logo"],
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "turns": 0,
                "cost": 0.0,
                "model_count": 0
            }
            by_provider[prov_id] = prov
        prov["input_tokens"] += inp
        prov["output_tokens"] += out
        prov["total_tokens"] += (inp + out)
        prov["turns"] += turns
        prov["cost"] += cost
        prov["model_count"] += 1

        total_input += inp
        total_output += out
        total_turns += turns
        total_cost += cost

    # Entries for conversations that no longer exist are dropped here, so the
    # cache cannot grow unbounded as chats are deleted.
    _save_cache(next_cache)

    providers_list = list(by_provider.values())
    providers_list.sort(key=lambda x: -x["total_tokens"])

    models_list = list(by_model.values())
    models_list.sort(key=lambda x: -x["total_tokens"])

    daily_list = []
    for day in sorted(daily_map.keys()):
        daily_list.append({"date": day, "models": daily_map[day]})

    elapsed = time.perf_counter() - start_time
    logger.success(
        f"[Token Counter] Tally complete: {total_turns} turn(s), "
        f"{total_input:,} input tokens, {total_output:,} output tokens "
        f"across {len(conversations)} conversation(s) ({len(models_list)} models) "
        f"in {elapsed:.2f}s ({len(hits)} from cache, {len(misses)} recounted)"
    )

    return {
        "totals": {
            "input_tokens": total_input,
            "output_tokens": total_output,
            "total_tokens": total_input + total_output,
            "conversations": len(conversations),
            "turns": total_turns,
            "cost": total_cost
        },
        "by_provider": providers_list,
        "by_model": models_list,
        "model_index": model_index,
        "daily": daily_list,
        "pricing": pricing,
        "cache": {
            "hits": len(hits),
            "misses": len(misses),
            "forced": bool(force),
            "undated_turns": undated_turns,
            "elapsed_seconds": round(elapsed, 3)
        }
    }
