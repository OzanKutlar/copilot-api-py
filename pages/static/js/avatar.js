import { store } from './storage.js';

/**
 * Assistant message avatars. A grouped model shows its provider logo from
 * settings.json; anything ungrouped (including custom endpoints, which
 * register with an empty logo) falls back to a colour-coded name pill.
 */

const BLOB_COLORS = ['#83a598', '#8ec07c', '#d3869b', '#b8bb26', '#fb4934', '#fabd2f'];
const MAX_BLOB_CHARS = 10;

/** 'moonshotai/Kimi-K3:fastest' -> 'Kimi-K3' */
export function deriveShortName(modelId) {
    if (typeof modelId !== 'string' || !modelId) return '';
    let name = modelId;

    const slash = name.lastIndexOf('/');
    if (slash !== -1) name = name.slice(slash + 1);

    const colon = name.indexOf(':');
    if (colon !== -1) name = name.slice(0, colon);

    return name.trim() || modelId;
}

function hashString(text) {
    let hash = 0;
    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

/** Deterministic, so a given model keeps the same colour across sessions. */
export function pickBlobColor(modelId) {
    return BLOB_COLORS[hashString(modelId) % BLOB_COLORS.length];
}

function resolveProvider(modelId) {
    if (!Array.isArray(store.allModels) || !Array.isArray(store.allProviders)) return null;
    const model = store.allModels.find(m => m && m.id === modelId);
    if (!model) return null;

    const providerId = model.provider_id || 'other';
    const provider = store.allProviders.find(p => p && p.id === providerId);
    if (provider && provider.logo) return provider;
    return null;
}

function createBlob(modelId) {
    const short = deriveShortName(modelId);
    const color = pickBlobColor(modelId);

    const blob = document.createElement('span');
    blob.className = 'model-avatar-blob shrink-0';
    blob.title = modelId;
    blob.textContent = short.length > MAX_BLOB_CHARS
        ? short.slice(0, MAX_BLOB_CHARS) + '\u2026'
        : short;

    // Alpha suffixes give a tinted fill and border without extra CSS vars.
    blob.style.color = color;
    blob.style.backgroundColor = color + '22';
    blob.style.borderColor = color + '55';
    return blob;
}

export function createModelAvatar(modelId) {
    if (!modelId || typeof modelId !== 'string') {
        const fallback = document.createElement('i');
        fallback.setAttribute('data-lucide', 'bot');
        fallback.className = 'w-5 h-5 text-gb-aquaAccent shrink-0';
        return fallback;
    }

    const provider = resolveProvider(modelId);
    if (!provider) return createBlob(modelId);

    const img = document.createElement('img');
    img.src = provider.logo;
    img.alt = provider.name || modelId;
    img.title = modelId;
    img.className = 'w-5 h-5 rounded-sm object-contain bg-white p-0.5 shrink-0';
    img.onerror = () => {
        if (img.isConnected) img.replaceWith(createBlob(modelId));
    };
    return img;
}
