import { store, persistSelectedModel, persistHiddenModels, persistAutoNameModel, isPreserveEnabled, setPreserveEnabled } from './storage.js';
import { applyActiveTokenLimit, updateTokenCount } from './tokens.js';
import { getAutoNameCandidates, resolveAutoNameModel, isCopilotNamingModel } from './autoName.js';

const PICKER_MODE_CHAT = 'chat';
const PICKER_MODE_AUTONAME = 'autoName';

// Which selection the shared Model Matrix modal is currently performing.
// Always reset by closeModelModal so a stale mode cannot leak into a later
// render triggered from elsewhere (model refresh, cross-tab preference sync).
let activePickerMode = PICKER_MODE_CHAT;
let showHiddenModels = false;

function currentPickerSelection() {
    return activePickerMode === PICKER_MODE_AUTONAME ? store.autoNameModel : store.selectedModel;
}

/**
 * Reflects the resolved naming/foldering model on its trigger button and gates
 * the bulk Auto Name / Auto Folder buttons. Re-run whenever the candidate set
 * or the stored choice can change (fetch, hide, unhide, remote sync).
 */
export function renderAutoNameControls() {
    const modelBtn = document.getElementById('auto-name-model-btn');
    const textEl = document.getElementById('auto-name-model-text');
    const badgeEl = document.getElementById('auto-name-model-badge');
    const autoNameBtn = document.getElementById('auto-name-btn');
    const autoFolderBtn = document.getElementById('auto-folder-btn');

    const candidates = getAutoNameCandidates();
    const hasCandidates = candidates.length > 0;

    if (autoNameBtn) autoNameBtn.classList.toggle('hidden', !hasCandidates);
    if (autoFolderBtn) autoFolderBtn.classList.toggle('hidden', !hasCandidates);
    if (!modelBtn) return;

    modelBtn.classList.toggle('hidden', !hasCandidates);
    if (!hasCandidates) {
        if (textEl) textEl.textContent = 'No models';
        if (badgeEl) badgeEl.classList.add('hidden');
        return;
    }

    const resolved = resolveAutoNameModel();
    const model = candidates.find(m => m.id === resolved) || null;
    const costly = model ? isCopilotNamingModel(model.id) : false;

    if (textEl) {
        textEl.textContent = model ? (model.display_name || model.id) : 'Select model';
        textEl.title = model ? model.id : '';
    }

    // The multiplier badge only appears for credit-consuming models, so its
    // presence alone signals cost at a glance.
    if (badgeEl) {
        badgeEl.classList.toggle('hidden', !costly);
        badgeEl.textContent = (model && model.multiplier_label) ? model.multiplier_label : '1x';
    }

    modelBtn.title = model
        ? 'Naming & foldering model: ' + model.id + (costly ? ' (consumes Copilot premium credits)' : ' (custom endpoint, 0 credits)')
        : 'Select the model used to auto-name and auto-folder chats';

    const busy = store.isAutoNaming === true;
    modelBtn.disabled = busy;
    modelBtn.classList.toggle('opacity-50', busy);
    modelBtn.classList.toggle('cursor-not-allowed', busy);
}

/**
 * Whether the chat page should request a streamed response for this model.
 * Web UI only: it reflects the per-endpoint Stream checkbox in Settings and
 * has no bearing on what external API clients may ask for.
 *
 * Unknown model ids, and servers predating the stream_enabled field, default
 * to streaming so the behaviour can never flip silently.
 */
export function isStreamingModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return true;
    const model = store.allModels.find(m => m && m.id === modelId);
    if (!model) return true;
    return model.stream_enabled !== false;
}

export function updateSelectedModelUI() {
    const btnText = document.getElementById('selected-model-text');
    if (!btnText) return;
    const model = store.allModels.find(m => m.id === store.selectedModel);
    btnText.textContent = model
        ? `${model.id} (${model.multiplier_label || '1x'})`
        : 'Select a model...';
}

export async function fetchModels() {
    const btnText = document.getElementById('selected-model-text');
    try {
        if (btnText) btnText.textContent = 'Loading models...';
        const res = await fetch('/v1/models');
        const data = await res.json();
        store.allModels = data.data || [];
        store.allProviders = data.providers || [];

        const isSelectedValid = store.selectedModel
            && store.allModels.some(m => m.id === store.selectedModel)
            && !store.hiddenModels.includes(store.selectedModel);

        if (!isSelectedValid) {
            const available = store.allModels.find(m => !store.hiddenModels.includes(m.id));
            if (available) {
                store.selectedModel = available.id;
                persistSelectedModel();
            }
        }

        applyActiveTokenLimit();
        updateSelectedModelUI();
        renderModelMatrix();
        updateTokenCount();
    } catch (e) {
        console.error('Failed to fetch models', e);
        if (btnText) btnText.textContent = 'Error loading models';
    }
}

export function toggleShowHiddenModels() {
    showHiddenModels = !showHiddenModels;
    renderModelMatrix();
}

export function renderModelMatrix() {
    const container = document.getElementById('model-matrix-container');
    if (!container) return;
    container.innerHTML = '';

    const showHiddenBtn = document.getElementById('show-hidden-models-btn');
    if (showHiddenBtn) {
        if (store.hiddenModels.length > 0) {
            showHiddenBtn.classList.remove('hidden');
            const labelEl = document.getElementById('show-hidden-label');
            if (labelEl) {
                labelEl.textContent = `${showHiddenModels ? 'Hide hidden' : 'Show hidden'} (${store.hiddenModels.length})`;
            }
            const iconEl = showHiddenBtn.querySelector('i');
            if (iconEl) {
                iconEl.setAttribute('data-lucide', showHiddenModels ? 'eye-off' : 'eye');
            }
        } else {
            showHiddenBtn.classList.add('hidden');
            showHiddenModels = false;
        }
    }

    const groups = {};
    store.allProviders.forEach(p => { groups[p.id] = Object.assign({}, p, { models: [] }); });
    if (!groups['other']) groups['other'] = { id: 'other', name: 'Other', models: [] };

    store.allModels.forEach(m => {
        const isHidden = store.hiddenModels.includes(m.id);
        if (isHidden && !showHiddenModels) return;
        const pid = m.provider_id || 'other';
        if (groups[pid]) groups[pid].models.push(m);
        else groups['other'].models.push(m);
    });

    Object.values(groups).forEach(group => {
        if (group.models.length === 0) return;

        const section = document.createElement('div');
        section.className = 'flex flex-col gap-4';

        const header = document.createElement('div');
        header.className = 'flex items-center gap-3 border-b border-gb-bgLight2 pb-2';

        if (group.logo && group.logo !== '') {
            const img = document.createElement('img');
            img.src = group.logo;
            img.alt = group.name;
            img.className = 'w-6 h-6 object-contain bg-white rounded-sm p-0.5';
            header.appendChild(img);
        } else {
            const icon = document.createElement('i');
            icon.setAttribute('data-lucide', 'box');
            icon.className = 'w-6 h-6 text-gb-fgDark';
            header.appendChild(icon);
        }

        const title = document.createElement('h3');
        title.className = 'text-lg font-bold text-gb-fgLightest';
        title.textContent = group.name;
        header.appendChild(title);
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';

        group.models.forEach(m => {
            const btn = document.createElement('div');
            const isHidden = store.hiddenModels.includes(m.id);
            const isSelected = m.id === currentPickerSelection();
            let cardStyle = isSelected ? 'bg-gb-blueAccent/10 border-gb-blueAccent shadow-md hover:bg-gb-blueAccent/20' : 'bg-gb-bgDarkest border-gb-bgLight2 hover:border-gb-blueAccent hover:bg-gb-bgLight1';
            if (isHidden) {
                cardStyle += ' opacity-40 hover:opacity-80 border-dashed';
            }
            btn.className = `group flex flex-col text-left p-3 rounded-lg border transition-all duration-200 cursor-pointer ${cardStyle}`;

            btn.onclick = () => applyPickerSelection(m.id);

            const topRow = document.createElement('div');
            topRow.className = 'flex justify-between items-start gap-2 mb-2 w-full';

            const nameSpan = document.createElement('span');
            nameSpan.className = `text-sm font-bold truncate flex-1 ${isSelected ? 'text-gb-blueAccent' : 'text-gb-fgLight'}`;
            nameSpan.textContent = m.display_name || m.id;
            topRow.appendChild(nameSpan);

            if (m.multiplier_label) {
                const multBadge = document.createElement('span');
                multBadge.className = `text-xs px-1.5 py-0.5 rounded font-mono shrink-0 ${parseFloat(m.multiplier) > 1.0 ? 'bg-gb-red/20 text-gb-redAccent border border-gb-red/30' : 'bg-gb-bgLight2 text-gb-fgDark border border-gb-bgLight3'}`;
                multBadge.textContent = m.multiplier_label;
                topRow.appendChild(multBadge);
            }
            btn.appendChild(topRow);

            const bottomRow = document.createElement('div');
            bottomRow.className = 'flex justify-between items-center w-full mt-1';

            const idRow = document.createElement('div');
            idRow.className = 'text-xs text-gb-fgDark font-mono truncate flex-1';
            idRow.textContent = m.id;
            bottomRow.appendChild(idRow);

            // Per-model thinking preservation. Off unless explicitly enabled.
            const preserveOn = isPreserveEnabled(m.id);
            const preserveBtn = document.createElement('button');
            preserveBtn.className = `transition-opacity p-1 rounded hover:bg-gb-bgLight2 shrink-0 ${preserveOn ? 'text-gb-aquaAccent opacity-100' : 'text-gb-fgDark opacity-0 group-hover:opacity-100 hover:text-gb-aquaAccent'}`;
            preserveBtn.innerHTML = '<i data-lucide="brain" class="w-3.5 h-3.5"></i>';
            preserveBtn.title = preserveOn
                ? 'Thinking is replayed into context for this model (click to disable)'
                : 'Replay this model\u2019s thinking into context on later turns';
            preserveBtn.onclick = (e) => {
                e.stopPropagation();
                setPreserveEnabled(m.id, !preserveOn);
                renderModelMatrix();
            };
            // Thinking preservation is a chat-completion concept, so it is not
            // offered while picking a naming model.
            if (activePickerMode === PICKER_MODE_CHAT) {
                bottomRow.appendChild(preserveBtn);
            }

            const hideBtn = document.createElement('button');
            if (isHidden) {
                hideBtn.className = 'opacity-100 transition-opacity text-gb-aquaAccent hover:text-gb-fgLightest p-1 rounded hover:bg-gb-bgLight2 shrink-0';
                hideBtn.innerHTML = '<i data-lucide="eye" class="w-3.5 h-3.5"></i>';
                hideBtn.title = 'Unhide Model';
                hideBtn.onclick = (e) => {
                    e.stopPropagation();
                    store.hiddenModels = store.hiddenModels.filter(id => id !== m.id);
                    persistHiddenModels();
                    renderModelMatrix();
                };
            } else {
                hideBtn.className = 'opacity-0 group-hover:opacity-100 transition-opacity text-gb-fgDark hover:text-gb-redAccent p-1 rounded hover:bg-gb-bgLight2 shrink-0';
                hideBtn.innerHTML = '<i data-lucide="eye-off" class="w-3.5 h-3.5"></i>';
                hideBtn.title = 'Hide Model';
                hideBtn.onclick = (e) => {
                    e.stopPropagation();
                    store.hiddenModels.push(m.id);
                    persistHiddenModels();
                    if (store.selectedModel === m.id) {
                        const available = store.allModels.find(am => !store.hiddenModels.includes(am.id));
                        store.selectedModel = available ? available.id : '';
                        persistSelectedModel();
                        applyActiveTokenLimit();
                        updateSelectedModelUI();
                        updateTokenCount();
                    }
                    renderModelMatrix();
                };
            }
            if (activePickerMode === PICKER_MODE_CHAT) {
                bottomRow.appendChild(hideBtn);
            }
            btn.appendChild(bottomRow);

            grid.appendChild(btn);
        });

        section.appendChild(grid);
        container.appendChild(section);
    });

    renderAutoNameControls();
    lucide.createIcons();
}

/** Title, subtitle and the Copilot-cost warning, per picker mode. */
function updateModalChrome() {
    const isNaming = activePickerMode === PICKER_MODE_AUTONAME;
    const titleEl = document.getElementById('model-modal-title');
    const subtitleEl = document.getElementById('model-modal-subtitle');
    const warnEl = document.getElementById('model-modal-cost-warning');

    if (titleEl) {
        titleEl.textContent = isNaming ? 'Select Naming & Foldering Model' : 'Select AI Model';
    }
    if (subtitleEl) {
        subtitleEl.textContent = isNaming
            ? 'Used by Auto Name and Auto Folder'
            : 'Used for chat completions';
    }
    if (warnEl) {
        const showWarn = isNaming && isCopilotNamingModel(store.autoNameModel);
        warnEl.classList.toggle('hidden', !showWarn);
    }
}

/** Writes the picked model to whichever target the modal was opened for. */
function applyPickerSelection(modelId) {
    if (!modelId || typeof modelId !== 'string') return;

    if (activePickerMode === PICKER_MODE_AUTONAME) {
        store.autoNameModel = modelId;
        persistAutoNameModel();
        renderModelMatrix();
        closeModelModal();
        return;
    }

    store.selectedModel = modelId;
    persistSelectedModel();
    applyActiveTokenLimit();
    updateSelectedModelUI();
    renderModelMatrix();
    updateTokenCount();
    closeModelModal();
}

export function openModelModal(mode) {
    const nextMode = mode === PICKER_MODE_AUTONAME ? PICKER_MODE_AUTONAME : PICKER_MODE_CHAT;

    // Changing the chat model mid-generation breaks the in-flight request;
    // changing the naming model mid-run breaks the naming loop instead.
    if (nextMode === PICKER_MODE_AUTONAME) {
        if (store.isAutoNaming) {
            alert('A naming run is already in progress. Please wait for it to finish.');
            return;
        }
    } else if (store.isProcessing) {
        alert('Please stop the current generation before changing models.');
        return;
    }

    activePickerMode = nextMode;

    const modal = document.getElementById('model-modal');
    const box = document.getElementById('model-modal-box');
    if (!modal || !box) return;
    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');
    updateModalChrome();
    renderModelMatrix();
}

export function closeModelModal() {
    activePickerMode = PICKER_MODE_CHAT;
    showHiddenModels = false;
    const modal = document.getElementById('model-modal');
    const box = document.getElementById('model-modal-box');
    if (!modal || !box) return;
    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

export async function fetchQuota() {
    const quotaDisplay = document.getElementById('quota-display');
    if (!quotaDisplay) return;
    try {
        const res = await fetch('/usage');
        if (!res.ok) throw new Error('Quota fetch failed');
        const data = await res.json();
        const snapshots = data.quota_snapshots || {};
        const chat = snapshots.chat;
        const comp = snapshots.completions;

        const text = [];
        if (chat) {
            const used = chat.unlimited ? '\u221E' : chat.entitlement - chat.remaining;
            const total = chat.unlimited ? '\u221E' : chat.entitlement;
            text.push(`Chat: ${used}/${total}`);
        }
        if (comp) {
            const used = comp.unlimited ? '\u221E' : comp.entitlement - comp.remaining;
            const total = comp.unlimited ? '\u221E' : comp.entitlement;
            text.push(`Comp: ${used}/${total}`);
        }
        quotaDisplay.textContent = text.join(' | ') || 'No quota info';
    } catch (e) {
        console.error(e);
        quotaDisplay.textContent = 'Quota unavailable';
    }
}
