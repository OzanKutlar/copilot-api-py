import { fetchModels } from './models.js';

let currentSettings = {};

function renderSettingsEndpoints() {
    const list = document.getElementById('endpoints-list');
    if (!list) return;
    list.innerHTML = '';

    const eps = currentSettings.custom_endpoints || [];
    eps.forEach((ep, i) => {
        const row = document.createElement('div');
        row.className = 'flex flex-col sm:flex-row gap-3 items-start sm:items-center bg-gb-bgDarkest p-3 rounded border border-gb-bgLight2 relative';
        row.innerHTML = `
            <div class="flex-1 w-full">
                <label class="text-xs text-gb-fgDark font-semibold uppercase">Name</label>
                <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1" placeholder="Local vLLM" data-idx="${i}" data-field="name">
            </div>
            <div class="flex-1 w-full">
                <label class="text-xs text-gb-fgDark font-semibold uppercase">Base URL</label>
                <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1" placeholder="http://localhost:8000/v1" data-idx="${i}" data-field="url">
            </div>
            <div class="flex-1 w-full">
                <label class="text-xs text-gb-fgDark font-semibold uppercase">API Key (Optional)</label>
                <input type="password" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1" placeholder="sk-..." data-idx="${i}" data-field="api_key">
            </div>
            <button class="text-gb-fgDark hover:text-gb-redAccent p-1 rounded mt-4 sm:mt-5 transition-colors delete-ep-btn" data-idx="${i}" title="Remove Endpoint">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
        `;
        // Assign values via property rather than markup so quotes cannot break out.
        row.querySelector('[data-field="name"]').value = ep.name || '';
        row.querySelector('[data-field="url"]').value = ep.url || '';
        row.querySelector('[data-field="api_key"]').value = ep.api_key || '';
        list.appendChild(row);
    });

    list.querySelectorAll('.delete-ep-btn').forEach(btn => {
        btn.onclick = () => {
            const idx = Number(btn.getAttribute('data-idx'));
            currentSettings.custom_endpoints.splice(idx, 1);
            renderSettingsEndpoints();
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
    currentSettings.custom_endpoints.push({ name: '', url: '', api_key: '' });
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

    try {
        await fetch('/v1/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentSettings)
        });
        closeSettingsModal();
        await fetchModels();
    } catch (e) {
        console.error('Failed to save settings', e);
        alert('Failed to save settings.');
    }
}
