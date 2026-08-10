import { fetchModels } from './models.js';
import { store, persistThinkingPrefs } from './storage.js';
import { renderChat } from './chat.js';

let currentSettings = {};

function renderSettingsEndpoints() {
    const list = document.getElementById('endpoints-list');
    if (!list) return;
    list.innerHTML = '';

    const eps = currentSettings.custom_endpoints || [];
    eps.forEach((ep, i) => {
        const row = document.createElement('div');
        row.className = 'flex flex-col gap-3 bg-gb-bgDarkest p-4 rounded-lg border border-gb-bgLight2 relative animate-fade-in-up transition-all duration-300 transform origin-top';
        row.style.animationDelay = `${i * 0.05}s`;
        row.innerHTML = `
            <div class="flex flex-col sm:flex-row gap-3 w-full items-start sm:items-center">
                <div class="flex-1 w-full">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase">Name</label>
                    <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="Local vLLM" data-idx="${i}" data-field="name">
                </div>
                <div class="flex-1 w-full">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase">Base URL</label>
                    <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="http://localhost:8000/v1" data-idx="${i}" data-field="url">
                </div>
                <div class="flex-1 w-full">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase">API Key (Optional)</label>
                    <input type="password" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="sk-..." data-idx="${i}" data-field="api_key">
                </div>
                <button class="text-gb-fgDark hover:text-gb-redAccent p-1 rounded mt-4 sm:mt-5 transition-colors delete-ep-btn self-end sm:self-auto shrink-0" data-idx="${i}" title="Remove Endpoint">
                    <i data-lucide="trash-2" class="w-5 h-5"></i>
                </button>
            </div>
            <div class="w-full mt-1">
                <label class="text-xs text-gb-fgDark font-semibold uppercase">Models (Optional)</label>
                <div class="flex gap-2 mt-1">
                    <input type="text" class="flex-1 bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1" placeholder="Add model (e.g., deepseek-ai/DeepSeek-V4-Flash...)" id="model-input-${i}">
                    <button class="bg-gb-bgLight2 hover:bg-gb-bgLight3 text-gb-fgLight font-bold px-3 py-1 rounded transition-colors flex items-center justify-center shrink-0 shadow-sm" id="add-model-btn-${i}" title="Add Model">
                        <i data-lucide="plus" class="w-4 h-4 text-gb-aquaAccent"></i>
                    </button>
                </div>
                <div id="models-list-${i}" class="flex flex-wrap gap-2 mt-3 empty:mt-0"></div>
                <p class="text-[10.5px] text-gb-fgDark mt-2 font-medium">If empty, fetches all available models. If provided, forces these exact models to be available.</p>
            </div>
        `;
        // Assign values via property rather than markup so quotes cannot break out.
        row.querySelector('[data-field="name"]').value = ep.name || '';
        row.querySelector('[data-field="url"]').value = ep.url || '';
        row.querySelector('[data-field="api_key"]').value = ep.api_key || '';
        list.appendChild(row);

        const inputEl = document.getElementById(`model-input-${i}`);
        const addBtn = document.getElementById(`add-model-btn-${i}`);
        const modelsListEl = document.getElementById(`models-list-${i}`);

        if (typeof ep.models === 'string') {
            ep.models = ep.models.split(',').map(s => s.trim()).filter(Boolean);
        } else if (!Array.isArray(ep.models)) {
            ep.models = [];
        }

        const renderPills = () => {
            modelsListEl.innerHTML = '';
            ep.models.forEach((m, mIdx) => {
                const pill = document.createElement('div');
                pill.className = 'flex items-center gap-1 bg-gb-bg border border-gb-bgLight3 rounded pl-2 pr-1 py-1 text-xs font-mono text-gb-fgLight animate-fade-in-up';
                pill.innerHTML = `
                    <span class="truncate max-w-[200px]" title="${m}">${m}</span>
                    <button class="text-gb-fgDark hover:text-gb-redAccent rounded hover:bg-gb-bgLight2 p-0.5 transition-colors" title="Remove">
                        <i data-lucide="minus" class="w-3.5 h-3.5"></i>
                    </button>
                `;
                pill.querySelector('button').onclick = () => {
                    ep.models.splice(mIdx, 1);
                    renderPills();
                };
                modelsListEl.appendChild(pill);
            });
            lucide.createIcons();
        };

        const addModel = () => {
            const val = inputEl.value.trim();
            if (val && !ep.models.includes(val)) {
                ep.models.push(val);
                inputEl.value = '';
                renderPills();
            }
        };

        addBtn.onclick = addModel;
        inputEl.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addModel();
            }
        };

        renderPills();
    });

    list.querySelectorAll('.delete-ep-btn').forEach(btn => {
        btn.onclick = () => {
            btn.disabled = true;
            const epObj = currentSettings.custom_endpoints[Number(btn.getAttribute('data-idx'))];
            const row = btn.closest('.animate-fade-in-up');
            
            row.classList.remove('animate-fade-in-up');
            row.classList.add('opacity-0', 'scale-95', '-translate-y-2');
            
            setTimeout(() => {
                const realIdx = currentSettings.custom_endpoints.indexOf(epObj);
                if (realIdx > -1) {
                    currentSettings.custom_endpoints.splice(realIdx, 1);
                    renderSettingsEndpoints();
                }
            }, 300);
        };
    });

    list.querySelectorAll('input').forEach(inp => {
        inp.oninput = (e) => {
            const idx = Number(e.target.getAttribute('data-idx'));
            const field = e.target.getAttribute('data-field');
            currentSettings.custom_endpoints[idx][field] = e.target.value;
        };
    });

    lucide.createIcons();
}

export async function openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const box = document.getElementById('settings-modal-box');
    if (!modal || !box) return;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');

    try {
        const res = await fetch('/v1/settings');
        currentSettings = await res.json();
        if (!currentSettings.custom_endpoints) currentSettings.custom_endpoints = [];
        renderSettingsEndpoints();

        const thinking = currentSettings.thinking_defaults || {};
        document.getElementById('setting-thinking-keywords').value = (thinking.enabled_keywords || []).join(', ');
        document.getElementById('setting-thinking-max-comp').value = thinking.max_completion_tokens || 16384;
        document.getElementById('setting-thinking-budget').value = thinking.budget_tokens || 4096;

        const prefs = store.thinkingPrefs || {};
        document.getElementById('setting-thinking-show').checked = prefs.show !== false;
        document.getElementById('setting-thinking-autoexpand').checked = prefs.autoExpand === true;
        document.getElementById('setting-thinking-tags').value = (prefs.inlineTags || []).join(', ');

        const unlimitedEl = document.getElementById('setting-thinking-unlimited');
        unlimitedEl.checked = thinking.unlimited || false;
        unlimitedEl.onchange = (e) => {
            const budgetEl = document.getElementById('setting-thinking-budget');
            budgetEl.disabled = e.target.checked;
            budgetEl.classList.toggle('opacity-50', e.target.checked);
        };
        unlimitedEl.dispatchEvent(new Event('change'));
    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

export function closeSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const box = document.getElementById('settings-modal-box');
    if (!modal || !box) return;
    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

export function addEndpoint() {
    if (!currentSettings.custom_endpoints) currentSettings.custom_endpoints = [];
    currentSettings.custom_endpoints.push({ name: '', url: '', api_key: '', models: [] });
    renderSettingsEndpoints();
}

export async function saveSettings() {
    const endpoints = currentSettings.custom_endpoints || [];
    for (const ep of endpoints) {
        if (!ep.name || !ep.url) {
            alert('All endpoints must have a Name and Base URL.');
            return;
        }
    }

    currentSettings.thinking_defaults = {
        enabled_keywords: document.getElementById('setting-thinking-keywords').value
            .split(',').map(s => s.trim()).filter(Boolean),
        max_completion_tokens: parseInt(document.getElementById('setting-thinking-max-comp').value, 10) || 16384,
        budget_tokens: parseInt(document.getElementById('setting-thinking-budget').value, 10) || 4096,
        unlimited: document.getElementById('setting-thinking-unlimited').checked
    };

    // Display prefs are per-browser and live in localStorage, not settings.json.
    const tags = document.getElementById('setting-thinking-tags').value
        .split(',')
        .map(s => s.trim().replace(/^<|>$/g, ''))
        .filter(Boolean);

    store.thinkingPrefs = {
        show: document.getElementById('setting-thinking-show').checked,
        autoExpand: document.getElementById('setting-thinking-autoexpand').checked,
        inlineTags: tags.length > 0 ? tags : ['think']
    };
    persistThinkingPrefs();

    try {
        await fetch('/v1/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentSettings)
        });
        closeSettingsModal();
        renderChat(true);
        await fetchModels();
    } catch (e) {
        console.error('Failed to save settings', e);
        alert('Failed to save settings.');
    }
}
