import { store, isPreserveEnabled } from './storage.js';
import { countTokens } from './tokens.js';

/**
 * Shared reasoning/thinking parsing. Both the live stream and historical
 * re-render go through here so they can never drift apart.
 */

const REASONING_KEYS = ['reasoning_content', 'reasoning', 'reasoning_text', 'thinking'];
const MAX_TAG_MATCHES = 500;

function coerceReasoningValue(value) {
    if (typeof value === 'string') return value || '';
    if (value && typeof value === 'object') {
        const nested = value.text || value.content || value.reasoning;
        if (typeof nested === 'string' && nested) return nested;
    }
    return '';
}

/**
 * Mirrors the backend normalizer as defence in depth, in case a response ever
 * reaches the UI through a path that skipped proxy-side normalization.
 */
export function extractReasoningDelta(delta) {
    if (!delta || typeof delta !== 'object') return '';
    for (let i = 0; i < REASONING_KEYS.length; i++) {
        const text = coerceReasoningValue(delta[REASONING_KEYS[i]]);
        if (text) return text;
    }
    return '';
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getInlineTags() {
    const prefs = store.thinkingPrefs || {};
    const raw = Array.isArray(prefs.inlineTags) ? prefs.inlineTags : [];
    const cleaned = raw
        .map(tag => String(tag).trim().replace(/^<|>$/g, ''))
        .filter(tag => /^[a-zA-Z0-9_-]+$/.test(tag));
    return cleaned.length > 0 ? cleaned : ['think'];
}

/**
 * Pulls inline <think>-style blocks out of raw model output.
 *
 * `reasoningSoFar` is the trace already gathered from structured deltas; the
 * return value is a fresh derivation each call, never appended in place, so
 * repeated invocations against a growing rawOutput cannot double-count.
 */
export function splitInlineThinking(rawOutput, reasoningSoFar, tags) {
    let cleanContent = typeof rawOutput === 'string' ? rawOutput : '';
    let extractedThink = typeof reasoningSoFar === 'string' ? reasoningSoFar : '';
    const tagList = (Array.isArray(tags) && tags.length > 0) ? tags : ['think'];

    for (let t = 0; t < tagList.length; t++) {
        const tag = tagList[t];
        const safe = escapeRegex(tag);
        const closedRegex = new RegExp('<' + safe + '>([\\s\\S]*?)<\\/' + safe + '>', 'g');

        let match;
        let guard = 0;
        while ((match = closedRegex.exec(cleanContent)) !== null) {
            guard += 1;
            if (guard > MAX_TAG_MATCHES) break;
            extractedThink += match[1] + '\n';
        }
        cleanContent = cleanContent.replace(closedRegex, '');

        // A trailing unclosed tag means the model is still mid-thought.
        const openTag = '<' + tag + '>';
        const openIdx = cleanContent.lastIndexOf(openTag);
        if (openIdx !== -1) {
            extractedThink += cleanContent.substring(openIdx + openTag.length);
            cleanContent = cleanContent.substring(0, openIdx);
        }
    }

    return { cleanContent, extractedThink };
}

/**
 * Threads saved before traces were a first-class field still carry their
 * thinking inline in content. Lift it out on first render. Idempotent.
 */
export function migrateLegacyThinking(msg) {
    if (!msg || msg.role !== 'assistant') return false;
    if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) return false;
    if (typeof msg.content !== 'string' || msg.content.indexOf('<') === -1) return false;

    const split = splitInlineThinking(msg.content, '', getInlineTags());
    const trace = split.extractedThink.trim();
    if (!trace) return false;

    msg.reasoning = trace;
    msg.content = split.cleanContent;
    return true;
}

export function estimateReasoningTokens(text) {
    return countTokens(text || '');
}

/**
 * Builds the messages array sent to the API.
 *
 * Traces are re-inlined as <think> blocks rather than sent back in their
 * native field, because most OpenAI-compatible servers reject or silently
 * drop an assistant-side `reasoning_content`. Gated per originating model, so
 * you can preserve on one model and strip on another within the same thread.
 */
export function buildReplayHistory(messages) {
    if (!Array.isArray(messages)) return [];
    const tag = getInlineTags()[0];

    return messages
        .filter(m => m && !m.isError && typeof m.role === 'string')
        .map(m => {
            const base = { role: m.role, content: m.content || '' };
            if (m.role !== 'assistant') return base;

            const trace = typeof m.reasoning === 'string' ? m.reasoning.trim() : '';
            if (!trace) return base;
            if (!isPreserveEnabled(m.model)) return base;

            base.content = '<' + tag + '>\n' + trace + '\n</' + tag + '>\n\n' + base.content;
            return base;
        });
}
