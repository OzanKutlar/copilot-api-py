import { store, persistAutoNameModel } from './storage.js';
import { AUTO_NAME_MAX_CHARS } from './config.js';
import { parseCombineCopyPrompt } from './promptParser.js';

/**
 * Auto-naming support: which model performs the naming, and what text it is
 * allowed to see. The naming basis is deliberately narrow so titles describe
 * the actual task rather than the surrounding prompt scaffolding.
 */

const BUILTIN_PROVIDER_IDS = ['openai', 'anthropic', 'google'];

// Built fresh per call so a stale lastIndex can never leak between callers.
function pruneJsonRegex() {
    return /```(?:json)?\s*\{[\s\S]*?"phase"\s*:\s*"PRUNE"[\s\S]*?\}\s*```/ig;
}

// Anchored to the closing fence rather than the first '}', since an
// EXECUTION payload's file contents can themselves contain literal braces.
function executionJsonRegex() {
    return /```(?:json)?\s*\{[\s\S]*?"phase"\s*:\s*"EXECUTION"[\s\S]*?\n```/ig;
}

function payloadTagRegex() {
    return /<antigravity_payload>[\s\S]*?<\/antigravity_payload>/ig;
}

function isSelectable(model) {
    if (!model || typeof model.id !== 'string' || !model.id) return false;
    return store.hiddenModels.indexOf(model.id) === -1;
}

/**
 * Models eligible to perform auto-naming. Prefers the backend's explicit
 * is_custom flag; only falls back to the old provider-id heuristic when no
 * model reports the flag at all, i.e. an older server build.
 */
export function getAutoNameCandidates() {
    const models = Array.isArray(store.allModels) ? store.allModels : [];

    const flagged = models.filter(m => isSelectable(m) && m.is_custom === true);
    if (flagged.length > 0) return flagged;

    const anyFlagPresent = models.some(m => m && typeof m.is_custom === 'boolean');
    if (anyFlagPresent) return [];

    return models.filter(m => {
        if (!isSelectable(m)) return false;
        const pid = m.provider_id || 'other';
        return BUILTIN_PROVIDER_IDS.indexOf(pid) === -1;
    });
}

/**
 * The user's stored choice when it is still selectable, otherwise the first
 * candidate, persisted so the picker and the naming run never disagree.
 * Returns null when no local or custom endpoint model is available.
 */
export function resolveAutoNameModel() {
    const candidates = getAutoNameCandidates();
    if (candidates.length === 0) return null;

    const stored = store.autoNameModel;
    if (stored && candidates.some(m => m.id === stored)) return stored;

    store.autoNameModel = candidates[0].id;
    persistAutoNameModel();
    return store.autoNameModel;
}

function stripPayloadBlocks(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .replace(pruneJsonRegex(), '')
        .replace(executionJsonRegex(), '')
        .replace(payloadTagRegex(), '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * The user's actual request, with every other payload section discarded.
 * A structured payload with no request text yields '' rather than falling
 * back to the raw content, which would reintroduce the scaffolding.
 */
function firstUserRequest(messages) {
    const msg = messages.find(m => m && m.role === 'user' && typeof m.content === 'string');
    if (!msg) return { text: '', index: -1 };

    const parsed = parseCombineCopyPrompt(msg.content);
    const text = parsed.isStructured ? (parsed.userRequest || '') : msg.content;
    return { text: (text || '').trim(), index: messages.indexOf(msg) };
}

function firstAssistantReply(messages, afterIndex) {
    if (afterIndex < 0) return '';
    for (let i = afterIndex + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m || m.role !== 'assistant' || m.isError === true) continue;
        const cleaned = stripPayloadBlocks(m.content);
        if (cleaned) return cleaned;
    }
    return '';
}

/**
 * The text handed to the naming model: the user's request plus the first
 * assistant reply, concatenated then truncated to AUTO_NAME_MAX_CHARS.
 * Reasoning traces live in their own field and are never included.
 * Returns '' when there is nothing worth naming from.
 */
export function buildNamingBasis(conv) {
    if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) return '';

    const request = firstUserRequest(conv.messages);
    if (!request.text) return '';

    const reply = firstAssistantReply(conv.messages, request.index);
    const combined = reply ? (request.text + '\n\n' + reply) : request.text;
    return combined.slice(0, AUTO_NAME_MAX_CHARS);
}
