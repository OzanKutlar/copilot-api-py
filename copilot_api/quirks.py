"""Learned per-model quirks: a rejected request is fixed once, then avoided.

Each rule recognises one kind of Copilot rejection. The first time a model hits
it, the model is recorded in model_quirks.json and the request is retried with
the rule's fix. Every later request for that model gets the fix before it is
sent, so the same error never goes upstream twice.

Requests stay in Chat Completions form throughout; a fix either edits that
payload or switches the route it is sent on.
"""
import json
from dataclasses import dataclass
from typing import Callable

from copilot_api.config import logger, save_model_quirks, state

ROUTE_CHAT = "chat"
ROUTE_RESPONSES = "responses"
ROUTES = (ROUTE_CHAT, ROUTE_RESPONSES)


@dataclass(frozen=True)
class Rule:
    """One recognisable rejection and how to avoid it.

    applies(payload, route) says whether the fix can change anything.
    fix(payload, route) edits the payload in place and returns the route to use.
    codes are matched against the error's code, phrases against its lowercased text.
    """

    key: str
    codes: tuple
    phrases: tuple
    applies: Callable
    fix: Callable


def _uses_chat(payload, route):
    return route == ROUTE_CHAT


def _to_responses(payload, route):
    return ROUTE_RESPONSES


def _has_max_tokens(payload, route):
    return route == ROUTE_CHAT and "max_tokens" in payload


def _swap_max_tokens(payload, route):
    value = payload.pop("max_tokens")
    payload.setdefault("max_completion_tokens", value)
    return route


def _has_reasoning_effort(payload, route):
    return "reasoning_effort" in payload


def _drop_reasoning_effort(payload, route):
    payload.pop("reasoning_effort", None)
    return route


def _has_effort_none(payload, route):
    return payload.get("reasoning_effort") == "none"


# Order matters: a route change comes first, so later rules see the final route,
# and the broad effort rule is checked before the narrow "none" one.
RULES = (
    Rule("responses_only", ("unsupported_api_for_model",),
         ("not accessible via the /chat/completions endpoint",), _uses_chat, _to_responses),
    Rule("requires_max_completion_tokens", (), ("max_completion_tokens",), _has_max_tokens, _swap_max_tokens),
    Rule("no_reasoning_effort", ("invalid_reasoning_effort",),
         ("does not support reasoning effort",), _has_reasoning_effort, _drop_reasoning_effort),
    Rule("rejects_reasoning_effort_none", (), ("reasoning.effort", "reasoning_effort"),
         _has_effort_none, _drop_reasoning_effort),
)


def error_code(error_text):
    """The `code` of a Copilot or OpenAI error body, or None."""
    try:
        data = json.loads(error_text)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    inner = data.get("error")
    code = inner.get("code") if isinstance(inner, dict) else data.get("code")
    return code if isinstance(code, str) and code else None


def match_rule(error_text, payload, route, tried=()):
    """The first untried rule that recognises error_text and can fix payload, or None."""
    if not isinstance(payload, dict) or route not in ROUTES:
        return None
    text = str(error_text or "")
    candidates = [rule for rule in RULES if rule.key not in tried and rule.applies(payload, route)]
    code = error_code(text)
    if code:
        for rule in candidates:
            if code in rule.codes:
                return rule
    lowered = text.lower()
    for rule in candidates:
        if any(phrase in lowered for phrase in rule.phrases):
            return rule
    return None


def _models_for(key):
    models = state.quirks.get(key) if isinstance(state.quirks, dict) else None
    return models if isinstance(models, list) else []


def known_rules(model_id):
    """The rules already recorded for model_id, in rule order."""
    return [rule for rule in RULES if model_id in _models_for(rule.key)]


def apply_known(payload, model_id, route):
    """Applies every recorded fix for model_id. Returns (route, [applied rule keys])."""
    if not isinstance(payload, dict) or route not in ROUTES:
        raise ValueError("apply_known needs a payload dict and a known route")
    applied = []
    for rule in known_rules(model_id):
        if rule.applies(payload, route):
            route = rule.fix(payload, route)
            applied.append(rule.key)
    return route, applied


def record(rule, model_id):
    """Remembers that model_id needs rule. Returns True when this is new."""
    if not model_id:
        return False
    if not isinstance(state.quirks, dict):
        state.quirks = {}
    models = state.quirks.get(rule.key)
    if not isinstance(models, list):
        models = []
        state.quirks[rule.key] = models
    if model_id in models:
        return False
    models.append(model_id)
    save_model_quirks(state.quirks)
    logger.warn(f"Learned quirk '{rule.key}' for {model_id}; later requests avoid this error.")
    return True
