import { fetchModels } from './models.js';
import { store, persistThinkingPrefs } from './storage.js';
import { renderChat } from './chat.js';
import {
    openSaveProgressModal,
    setProviderStatus,
    setModelsStatus,
    finishSaveProgress
} from './saveProgress.js';

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
                <div class="flex items-center gap-2 mt-4 sm:mt-5 self-end sm:self-auto shrink-0">
                    <label class="flex items-center gap-1.5 text-xs font-semibold text-gb-fgLight cursor-pointer select-none whitespace-nowrap" title="Stream replies token-by-token in this web UI. When off, the chat page waits for the full response. Does not affect external API clients.">
                        <input type="checkbox" class="w-4 h-4 rounded border-gb-bgLight2 bg-gb-bgDarkest text-gb-blueAccent focus:ring-gb-blueAccent cursor-pointer" data-idx="${i}" data-field="stream">
                        Stream
                    </label>
                    <button class="check-ep-btn bg-gb-bgLight1 hover:bg-gb-bgLight2 text-gb-fgLight text-xs font-semibold px-2.5 py-1.5 rounded border border-gb-bgLight3 transition-all flex items-center gap-1.5 shadow-sm active:scale-95" data-idx="${i}" title="Check endpoint response time (< 1s)">
                        <i data-lucide="activity" class="w-3.5 h-3.5 text-gb-blueAccent"></i> <span>Check</span>
                    </button>
                    <button class="text-gb-fgDark hover:text-gb-redAccent p-1 rounded transition-colors delete-ep-btn" data-idx="${i}" title="Remove Endpoint">
                        <i data-lucide="trash-2" class="w-5 h-5"></i>
                    </button>
                </div>
            </div>
            <div id="check-status-${i}" class="hidden text-xs font-mono px-2.5 py-1 rounded border"></div>
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
        // Absent key means streaming, so endpoints saved before this setting
        // existed keep their current behaviour rather than silently flipping.
        ep.stream = ep.stream !== false;
        row.querySelector('[data-field="stream"]').checked = ep.stream;
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

    list.querySelectorAll('.check-ep-btn').forEach(btn => {
        btn.onclick = async () => {
            const idx = Number(btn.getAttribute('data-idx'));
            const ep = currentSettings.custom_endpoints[idx];
            const statusDiv = document.getElementById(`check-status-${idx}`);
            const origHtml = btn.innerHTML;

            btn.disabled = true;
            btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin text-gb-blueAccent"></i> <span>Checking...</span>';
            lucide.createIcons();

            if (statusDiv) {
                statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-bgLight1/50 border-gb-bgLight3 text-gb-fgDark flex items-center gap-2';
                statusDiv.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> Ping in progress...';
                statusDiv.classList.remove('hidden');
                lucide.createIcons();
            }

            try {
                const res = await fetch('/v1/settings/check_endpoint', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: ep.url, api_key: ep.api_key })
                });
                const data = await res.json();
                if (statusDiv) {
                    if (data.ok && data.latency_ms <= 1000) {
                        statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-green/20 border-gb-greenAccent/40 text-gb-greenAccent flex items-center gap-2';
                        statusDiv.innerHTML = `<i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> <span>Responded in <b>${data.latency_ms}ms</b> (OK &lt; 1s)</span>`;
                    } else if (data.ok) {
                        statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-red/20 border-gb-redAccent/40 text-gb-redAccent flex items-center gap-2';
                        statusDiv.innerHTML = `<i data-lucide="clock-alert" class="w-3.5 h-3.5"></i> <span>Slow response: <b>${data.latency_ms}ms</b> (exceeds 1s threshold)</span>`;
                    } else {
                        statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-red/20 border-gb-redAccent/40 text-gb-redAccent flex items-center gap-2';
                        statusDiv.innerHTML = `<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> <span>Failed (${data.error || 'No response'} &middot; ${data.latency_ms}ms)</span>`;
                    }
                }
            } catch (e) {
                if (statusDiv) {
                    statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-red/20 border-gb-redAccent/40 text-gb-redAccent flex items-center gap-2';
                    statusDiv.innerHTML = `<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> <span>Check error: ${e.message}</span>`;
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                lucide.createIcons();
            }
        };
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

    // Scoped to [data-field] on purpose. A bare 'input' selector also matches
    // the per-endpoint model-name box, which carries neither attribute, and
    // Number(null) is 0 -- so typing a model name used to write a stray key
    // onto the first endpoint object.
    list.querySelectorAll('input[data-field]').forEach(inp => {
        const idx = Number(inp.getAttribute('data-idx'));
        const field = inp.getAttribute('data-field');
        const ep = currentSettings.custom_endpoints[idx];
        if (!ep || !field) return;

        // Captured by reference rather than by index, so a later splice cannot
        // point a live handler at the wrong endpoint.
        if (inp.type === 'checkbox') {
            inp.onchange = (e) => {
                ep[field] = e.target.checked;
            };
            return;
        }

        inp.oninput = (e) => {
            ep[field] = e.target.value;
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
    currentSettings.custom_endpoints.push({ name: '', url: '', api_key: '', models: [], stream: true });
    renderSettingsEndpoints();
}

async function probeEndpoint(ep, timeoutSec) {
    try {
        const res = await fetch('/v1/settings/check_endpoint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: ep.url, api_key: ep.api_key, timeout: timeoutSec })
        });
        const data = await res.json();
        return data;
    } catch (e) {
        return { ok: false, latency_ms: 0, error: e.message || 'Network check error' };
    }
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

    // 1. Immediately close settings popup and open progress modal
    closeSettingsModal();
    openSaveProgressModal(endpoints);

    // 2. Test each custom endpoint provider with 500ms timeout
    let hasErrors = false;
    const providerPromises = endpoints.map((ep, idx) => {
        return new Promise(async (resolve) => {
            let currentTimeout = 0.5;
            let retryCount = 0;

            const executeCheck = async (timeoutVal) => {
                setProviderStatus(idx, { state: 'checking', timeoutSec: timeoutVal });
                const result = await probeEndpoint(ep, timeoutVal);
                if (result.ok) {
                    setProviderStatus(idx, {
                        state: 'ok',
                        latency_ms: result.latency_ms
                    });
                    resolve(true);
                } else {
                    hasErrors = true;
                    let nextTimeout = null;
                    if (retryCount === 0) nextTimeout = 1.0;
                    else if (retryCount === 1) nextTimeout = 5.0;

                    setProviderStatus(idx, {
                        state: 'fail',
                        error: result.error || 'Unreachable',
                        nextTimeout,
                        onRetry: nextTimeout ? () => {
                            retryCount++;
                            executeCheck(nextTimeout);
                        } : null
                    });
                    resolve(false);
                };
            };

            await executeCheck(currentTimeout);
        });
    });

    // Wait for all providers to complete initial probe
    await Promise.all(providerPromises);

    // 3. Persist settings payload to backend without synchronous model block
    try {
        await fetch('/v1/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, currentSettings, { refresh_models: false }))
        });
    } catch (e) {
        console.error('Failed to persist settings payload:', e);
    }

    // 4. Checking models phase
    setModelsStatus({ state: 'checking' });
    try {
        const refRes = await fetch('/v1/settings/refresh_models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const refData = await refRes.json();
        await fetchModels();
        const count = (refData && typeof refData.model_count === 'number') ? refData.model_count : (store.allModels.length || 0);
        setModelsStatus({ state: 'ok', count });
    } catch (e) {
        console.error('Failed to query models:', e);
        hasErrors = true;
        setModelsStatus({ state: 'fail', error: e.message || 'Failed to fetch models' });
    }

    renderChat(true);
    finishSaveProgress({ allOk: !hasErrors });
}
