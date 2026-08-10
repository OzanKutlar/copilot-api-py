import {
    STORAGE_KEY_CONVS,
    STORAGE_KEY_ACTIVE,
    STORAGE_KEY_MODEL,
    STORAGE_KEY_AUTONAME_MODEL,
    STORAGE_KEY_HIDDEN,
    DEFAULT_TOKEN_LIMIT,
    MODEL_LIMITS_DB_NAME,
    MODEL_LIMITS_DB_VERSION,
    MODEL_LIMITS_STORE,
    CHAT_DB_NAME,
    CHAT_DB_VERSION,
    CHAT_STORE,
    STORAGE_KEY_THINKING_PREFS,
    STORAGE_KEY_PRESERVE_MODELS,
    DEFAULT_THINKING_PREFS
} from './config.js';

function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
        return fallback;
    }
}

function loadThinkingPrefs() {
    const raw = safeParse(localStorage.getItem(STORAGE_KEY_THINKING_PREFS), {});
    const prefs = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
        show: typeof prefs.show === 'boolean' ? prefs.show : DEFAULT_THINKING_PREFS.show,
        autoExpand: typeof prefs.autoExpand === 'boolean' ? prefs.autoExpand : DEFAULT_THINKING_PREFS.autoExpand,
        inlineTags: (Array.isArray(prefs.inlineTags) && prefs.inlineTags.length > 0)
            ? prefs.inlineTags.slice()
            : DEFAULT_THINKING_PREFS.inlineTags.slice()
    };
}

function loadPreserveModels() {
    const raw = safeParse(localStorage.getItem(STORAGE_KEY_PRESERVE_MODELS), {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
}

export const store = {
    conversations: [],
    folders: [],
    activeConvId: localStorage.getItem(STORAGE_KEY_ACTIVE) || '',
    selectedModel: localStorage.getItem(STORAGE_KEY_MODEL) || '',
    autoNameModel: localStorage.getItem(STORAGE_KEY_AUTONAME_MODEL) || '',
    hiddenModels: safeParse(localStorage.getItem(STORAGE_KEY_HIDDEN), []),
    thinkingPrefs: loadThinkingPrefs(),
    preserveModels: loadPreserveModels(),
    allModels: [],
    allProviders: [],
    isProcessing: false,
    isAutoNaming: false,
    currentAbortController: null,
    modelLimitsDb: null,
    chatDb: null,
    modelTokenLimits: {},
    activeTokenLimit: DEFAULT_TOKEN_LIMIT
};

export function getActiveConversation() {
    return store.conversations.find(c => c.id === store.activeConvId) || null;
}

export function persistActiveConvId() {
    localStorage.setItem(STORAGE_KEY_ACTIVE, store.activeConvId);
}

export function persistSelectedModel() {
    localStorage.setItem(STORAGE_KEY_MODEL, store.selectedModel);
}

export function persistHiddenModels() {
    localStorage.setItem(STORAGE_KEY_HIDDEN, JSON.stringify(store.hiddenModels));
}

export function persistAutoNameModel() {
    localStorage.setItem(STORAGE_KEY_AUTONAME_MODEL, store.autoNameModel || '');
}

export function persistThinkingPrefs() {
    localStorage.setItem(STORAGE_KEY_THINKING_PREFS, JSON.stringify(store.thinkingPrefs));
}

export function persistPreserveModels() {
    localStorage.setItem(STORAGE_KEY_PRESERVE_MODELS, JSON.stringify(store.preserveModels));
}

/** Absent key means off, so preservation is opt-in without seeding defaults. */
export function isPreserveEnabled(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    return store.preserveModels[modelId] === true;
}

export function setPreserveEnabled(modelId, enabled) {
    if (!modelId || typeof modelId !== 'string') return;
    if (enabled) {
        store.preserveModels[modelId] = true;
    } else {
        delete store.preserveModels[modelId];
    }
    persistPreserveModels();
}

// ---------------------------------------------------------------------------
// Chat history persistence
// ---------------------------------------------------------------------------

export function saveHistoryToBackend() {
    const payload = {
        folders: store.folders,
        conversations: store.conversations
    };
    return fetch('/v1/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.error('Backend history sync failed', e));
}

/**
 * Accepts either the legacy bare array of conversations or the current
 * { folders, conversations } object. Returns null when the payload is
 * unusable so callers can fall back to another source.
 */
export function normalizeHistory(raw) {
    if (Array.isArray(raw)) {
        return { folders: [], conversations: raw, needsResave: raw.length > 0 };
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.conversations)) {
        return {
            folders: Array.isArray(raw.folders) ? raw.folders : [],
            conversations: raw.conversations,
            needsResave: !Array.isArray(raw.folders)
        };
    }
    return null;
}

export async function loadHistoryFromBackend() {
    try {
        const res = await fetch('/v1/history');
        if (!res.ok) return null;
        const data = await res.json();
        return normalizeHistory(data);
    } catch (e) {
        console.error('Failed to load history from backend', e);
        return null;
    }
}

export function openChatDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB is not supported'));
            return;
        }
        const request = window.indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(CHAT_STORE)) {
                db.createObjectStore(CHAT_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open Chat DB'));
    });
}

export function loadConversationsFromDb() {
    return new Promise((resolve, reject) => {
        if (!store.chatDb) {
            resolve([]);
            return;
        }
        const tx = store.chatDb.transaction(CHAT_STORE, 'readonly');
        const objStore = tx.objectStore(CHAT_STORE);
        const request = objStore.get('all_conversations');
        request.onsuccess = () => {
            if (request.result && request.result.data) {
                resolve(request.result.data);
            } else {
                resolve([]);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

export function readLegacyLocalStorageConversations() {
    const oldData = localStorage.getItem(STORAGE_KEY_CONVS);
    if (!oldData) return null;
    const parsed = safeParse(oldData, null);
    localStorage.removeItem(STORAGE_KEY_CONVS);
    return Array.isArray(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Per-model token limit persistence
// ---------------------------------------------------------------------------

export function openModelLimitsDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB is not supported in this browser'));
            return;
        }
        const request = window.indexedDB.open(MODEL_LIMITS_DB_NAME, MODEL_LIMITS_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(MODEL_LIMITS_STORE)) {
                db.createObjectStore(MODEL_LIMITS_STORE, { keyPath: 'model' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    });
}

function loadAllModelTokenLimits() {
    return new Promise((resolve, reject) => {
        if (!store.modelLimitsDb) {
            resolve({});
            return;
        }
        const tx = store.modelLimitsDb.transaction(MODEL_LIMITS_STORE, 'readonly');
        const objStore = tx.objectStore(MODEL_LIMITS_STORE);
        const request = objStore.getAll();
        request.onsuccess = () => {
            const rows = Array.isArray(request.result) ? request.result : [];
            const mapped = {};
            rows.forEach((row) => {
                if (!row || typeof row.model !== 'string') return;
                const limit = Number(row.limit);
                if (Number.isFinite(limit) && limit > 0) {
                    mapped[row.model] = limit;
                }
            });
            resolve(mapped);
        };
        request.onerror = () => reject(request.error || new Error('Failed to load model token limits'));
    });
}

export async function initModelLimitStorage() {
    try {
        store.modelLimitsDb = await openModelLimitsDb();
        store.modelTokenLimits = await loadAllModelTokenLimits();
    } catch (e) {
        console.error('Failed to initialize model token limit storage', e);
        store.modelLimitsDb = null;
        store.modelTokenLimits = {};
    }
}

export function getStoredTokenLimit(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    const limit = store.modelTokenLimits[modelId];
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return limit;
}

export function saveModelTokenLimit(modelId, limit) {
    return new Promise((resolve, reject) => {
        if (!modelId || typeof modelId !== 'string') {
            reject(new Error('Model ID is required to save a token limit'));
            return;
        }
        const normalizedLimit = Number(limit);
        if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) {
            reject(new Error('Token limit must be a positive number'));
            return;
        }
        store.modelTokenLimits[modelId] = normalizedLimit;
        if (!store.modelLimitsDb) {
            resolve();
            return;
        }
        const tx = store.modelLimitsDb.transaction(MODEL_LIMITS_STORE, 'readwrite');
        const objStore = tx.objectStore(MODEL_LIMITS_STORE);
        const request = objStore.put({ model: modelId, limit: normalizedLimit, updatedAt: Date.now() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error('Failed to save model token limit'));
    });
}
