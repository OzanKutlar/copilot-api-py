import { store, persistSelectedModel, persistHiddenModels, isPreserveEnabled, setPreserveEnabled } from './storage.js';
import { applyActiveTokenLimit, updateTokenCount } from './tokens.js';

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

        const hasLocal = store.allModels.some(m => {
            const pid = m.provider_id || 'other';
            return !['openai', 'anthropic', 'google'].includes(pid);
        });
        const autoNameBtn = document.getElementById('auto-name-btn');
        if (autoNameBtn) {
            autoNameBtn.classList.toggle('hidden', !hasLocal);
        }

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

export function renderModelMatrix() {
    const container = document.getElementById('model-matrix-container');
    if (!container) return;
    container.innerHTML = '';

    const unhideBtn = document.getElementById('unhide-models-btn');
    if (unhideBtn) {
        if (store.hiddenModels.length > 0) {
            unhideBtn.classList.remove('hidden');
            const countEl = document.getElementById('unhide-count');
            if (countEl) countEl.textContent = `Unhide (${store.hiddenModels.length})`;
        } else {
            unhideBtn.classList.add('hidden');
        }
    }

    const groups = {};
    store.allProviders.forEach(p => { groups[p.id] = Object.assign({}, p, { models: [] }); });
    if (!groups['other']) groups['other'] = { id: 'other', name: 'Other', models: [] };

    store.allModels.forEach(m => {
        if (store.hiddenModels.includes(m.id)) return;
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
            const isSelected = m.id === store.selectedModel;
            btn.className = `group flex flex-col text-left p-3 rounded-lg border transition-all duration-200 cursor-pointer ${isSelected ? 'bg-gb-blueAccent/10 border-gb-blueAccent shadow-md hover:bg-gb-blueAccent/20' : 'bg-gb-bgDarkest border-gb-bgLight2 hover:border-gb-blueAccent hover:bg-gb-bgLight1'}`;

            btn.onclick = () => {
                store.selectedModel = m.id;
                persistSelectedModel();
                applyActiveTokenLimit();
                updateSelectedModelUI();
                renderModelMatrix();
                updateTokenCount();
                closeModelModal();
            };

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
            bottomRow.appendChild(preserveBtn);

            const hideBtn = document.createElement('button');
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
            bottomRow.appendChild(hideBtn);
            btn.appendChild(bottomRow);

            grid.appendChild(btn);
        });

        section.appendChild(grid);
        container.appendChild(section);
    });

    lucide.createIcons();
}

export function openModelModal() {
    if (store.isProcessing) {
        alert('Please stop the current generation before changing models.');
        return;
    }
    const modal = document.getElementById('model-modal');
    const box = document.getElementById('model-modal-box');
    if (!modal || !box) return;
    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');
    renderModelMatrix();
}

export function closeModelModal() {
    const modal = document.getElementById('model-modal');
    const box = document.getElementById('model-modal-box');
    if (!modal || !box) return;
    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

export function unhideAllModels() {
    store.hiddenModels = [];
    persistHiddenModels();
    if (!store.selectedModel || !store.allModels.some(m => m.id === store.selectedModel)) {
        const available = store.allModels[0];
        store.selectedModel = available ? available.id : '';
        persistSelectedModel();
    }
    applyActiveTokenLimit();
    updateSelectedModelUI();
    renderModelMatrix();
    updateTokenCount();
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
