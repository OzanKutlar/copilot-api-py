import { createModelAvatar } from './avatar.js';

let lastCounterData = null;
let modelFilterQuery = '';

export function openTokenCounterModal() {
    const modal = document.getElementById('token-counter-modal');
    const box = document.getElementById('token-counter-modal-box');
    if (!modal || !box) return;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');

    fetchAndRenderTokenCounter();
}

export function closeTokenCounterModal() {
    const modal = document.getElementById('token-counter-modal');
    const box = document.getElementById('token-counter-modal-box');
    if (!modal || !box) return;

    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

function renderProviderImage(logoUrl, name) {
    const wrap = document.createElement('div');
    wrap.className = 'w-5 h-5 rounded flex items-center justify-center shrink-0 overflow-hidden bg-white p-0.5 border border-gb-bgLight3';
    if (logoUrl) {
        const img = document.createElement('img');
        img.src = logoUrl;
        img.alt = name || 'Provider';
        img.className = 'w-full h-full object-contain';
        img.onerror = () => {
            wrap.className = 'w-5 h-5 rounded flex items-center justify-center shrink-0 bg-gb-bgLight1 text-gb-aquaAccent';
            wrap.innerHTML = '<i data-lucide="box" class="w-3.5 h-3.5"></i>';
            lucide.createIcons({ root: wrap });
        };
        wrap.appendChild(img);
    } else {
        wrap.className = 'w-5 h-5 rounded flex items-center justify-center shrink-0 bg-gb-bgLight1 text-gb-aquaAccent';
        wrap.innerHTML = '<i data-lucide="box" class="w-3.5 h-3.5"></i>';
    }
    return wrap;
}

function renderCacheInfo(cache) {
    const el = document.getElementById('tc-cache-info');
    if (!el) return;

    if (!cache || typeof cache !== 'object') {
        el.textContent = 'Calculated using model tokenizer encoding';
        return;
    }

    const hits = cache.hits || 0;
    const misses = cache.misses || 0;
    const total = hits + misses;
    const secs = typeof cache.elapsed_seconds === 'number' ? cache.elapsed_seconds.toFixed(2) : '?';

    if (cache.forced) {
        el.textContent = `Full rebuild \u00b7 ${total.toLocaleString()} chats re-tokenized in ${secs}s`;
        return;
    }
    el.textContent = `${hits.toLocaleString()} of ${total.toLocaleString()} chats served from cache \u00b7 calculated in ${secs}s`;
}

export async function fetchAndRenderTokenCounter(force = false) {
    const refreshBtn = document.getElementById(force ? 'force-token-counter-btn' : 'refresh-token-counter-btn');
    const grandTotalEl = document.getElementById('tc-grand-total');
    const totalInputEl = document.getElementById('tc-total-input');
    const totalOutputEl = document.getElementById('tc-total-output');
    const turnsSummaryEl = document.getElementById('tc-turns-summary');
    const providersTbody = document.getElementById('tc-providers-tbody');
    const modelsTbody = document.getElementById('tc-models-tbody');

    // Captured so whichever button was clicked is restored to its own label.
    const originalHtml = refreshBtn ? refreshBtn.innerHTML : '';
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Working...';
        lucide.createIcons();
    }

    try {
        const url = force ? '/v1/token_counter?refresh=true' : '/v1/token_counter';
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        lastCounterData = data;

        const totals = data.totals || {};
        if (grandTotalEl) grandTotalEl.textContent = (totals.total_tokens || 0).toLocaleString();
        if (totalInputEl) totalInputEl.textContent = (totals.input_tokens || 0).toLocaleString();
        if (totalOutputEl) totalOutputEl.textContent = (totals.output_tokens || 0).toLocaleString();
        if (turnsSummaryEl) {
            turnsSummaryEl.textContent = `${(totals.turns || 0).toLocaleString()} generation turns across ${(totals.conversations || 0).toLocaleString()} chats`;
        }

        renderCacheInfo(data.cache);
        renderProvidersTable(data.by_provider || []);
        renderModelsTable(data.by_model || []);
    } catch (e) {
        console.error('Failed to load token counter data', e);
        if (providersTbody) {
            providersTbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-gb-redAccent">Error loading token counts: ${e.message}</td></tr>`;
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = originalHtml;
            lucide.createIcons();
        }
    }
}

function renderProvidersTable(providers) {
    const tbody = document.getElementById('tc-providers-tbody');
    const countEl = document.getElementById('tc-provider-count');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (countEl) countEl.textContent = `${providers.length} provider${providers.length === 1 ? '' : 's'}`;

    if (providers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gb-fgDark italic">No provider token records found in chat history.</td></tr>';
        return;
    }

    providers.forEach(p => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gb-bgLight1/40 transition-colors';

        const provCell = document.createElement('td');
        provCell.className = 'p-3 flex items-center gap-2.5';
        provCell.appendChild(renderProviderImage(p.logo, p.name));
        const nameSpan = document.createElement('span');
        nameSpan.className = 'font-bold text-gb-fgLightest';
        nameSpan.textContent = p.name || p.provider_id;
        provCell.appendChild(nameSpan);
        tr.appendChild(provCell);

        const inpCell = document.createElement('td');
        inpCell.className = 'p-3 text-right text-gb-blueAccent font-semibold';
        inpCell.textContent = (p.input_tokens || 0).toLocaleString();
        tr.appendChild(inpCell);

        const outCell = document.createElement('td');
        outCell.className = 'p-3 text-right text-gb-greenAccent font-semibold';
        outCell.textContent = (p.output_tokens || 0).toLocaleString();
        tr.appendChild(outCell);

        const totCell = document.createElement('td');
        totCell.className = 'p-3 text-right text-gb-fgLightest font-bold';
        totCell.textContent = (p.total_tokens || 0).toLocaleString();
        tr.appendChild(totCell);

        const turnCell = document.createElement('td');
        turnCell.className = 'p-3 text-right text-gb-fgDark';
        turnCell.textContent = (p.turns || 0).toLocaleString();
        tr.appendChild(turnCell);

        tbody.appendChild(tr);
    });
    lucide.createIcons();
}

function renderModelsTable(models) {
    const tbody = document.getElementById('tc-models-tbody');
    const countEl = document.getElementById('tc-model-count');
    if (!tbody) return;
    tbody.innerHTML = '';

    const q = modelFilterQuery.trim().toLowerCase();
    const filtered = models.filter(m => {
        if (!q) return true;
        return (m.model_id || '').toLowerCase().includes(q) || (m.provider_name || '').toLowerCase().includes(q);
    });

    if (countEl) countEl.textContent = `${filtered.length} of ${models.length} model${models.length === 1 ? '' : 's'}`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gb-fgDark italic">${models.length === 0 ? 'No model tokens recorded yet.' : 'No models matched your filter.'}</td></tr>`;
        return;
    }

    filtered.forEach(m => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gb-bgLight1/40 transition-colors';

        // Model ID & Avatar
        const modelCell = document.createElement('td');
        modelCell.className = 'p-3 flex items-center gap-2.5 max-w-[280px] min-w-0';
        const avatar = createModelAvatar(m.model_id);
        modelCell.appendChild(avatar);
        const modelName = document.createElement('span');
        modelName.className = 'truncate font-bold text-gb-fgLight';
        modelName.textContent = m.model_id;
        modelName.title = m.model_id;
        modelCell.appendChild(modelName);
        tr.appendChild(modelCell);

        // Provider
        const provCell = document.createElement('td');
        provCell.className = 'p-3';
        const provBadge = document.createElement('div');
        provBadge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-gb-bgLight1 border border-gb-bgLight2 text-[11px] text-gb-fgLight';
        provBadge.appendChild(renderProviderImage(m.provider_logo, m.provider_name));
        const pText = document.createElement('span');
        pText.textContent = m.provider_name;
        provBadge.appendChild(pText);
        provCell.appendChild(provBadge);
        tr.appendChild(provCell);

        // Input Tokens
        const inpCell = document.createElement('td');
        inpCell.className = 'p-3 text-right text-gb-blueAccent font-semibold';
        inpCell.textContent = (m.input_tokens || 0).toLocaleString();
        tr.appendChild(inpCell);

        // Output Tokens
        const outCell = document.createElement('td');
        outCell.className = 'p-3 text-right text-gb-greenAccent font-semibold';
        outCell.textContent = (m.output_tokens || 0).toLocaleString();
        tr.appendChild(outCell);

        // Total Tokens
        const totCell = document.createElement('td');
        totCell.className = 'p-3 text-right text-gb-fgLightest font-bold';
        totCell.textContent = (m.total_tokens || 0).toLocaleString();
        tr.appendChild(totCell);

        // Turns
        const turnCell = document.createElement('td');
        turnCell.className = 'p-3 text-right text-gb-fgDark';
        turnCell.textContent = (m.turns || 0).toLocaleString();
        tr.appendChild(turnCell);

        tbody.appendChild(tr);
    });
    lucide.createIcons();
}

export function wireTokenCounterModal() {
    const openBtn = document.getElementById('token-counter-btn');
    const closeBtn = document.getElementById('close-token-counter-btn');
    const doneBtn = document.getElementById('close-token-counter-done-btn');
    const refreshBtn = document.getElementById('refresh-token-counter-btn');
    const forceBtn = document.getElementById('force-token-counter-btn');
    const modal = document.getElementById('token-counter-modal');
    const filterInput = document.getElementById('tc-model-filter');

    if (openBtn) openBtn.onclick = openTokenCounterModal;
    if (closeBtn) closeBtn.onclick = closeTokenCounterModal;
    if (doneBtn) doneBtn.onclick = closeTokenCounterModal;
    if (refreshBtn) refreshBtn.onclick = () => fetchAndRenderTokenCounter(false);
    if (forceBtn) forceBtn.onclick = () => fetchAndRenderTokenCounter(true);

    if (modal) {
        modal.onclick = (e) => {
            if (e.target === modal) closeTokenCounterModal();
        };
    }

    if (filterInput) {
        filterInput.oninput = (e) => {
            modelFilterQuery = e.target.value || '';
            if (lastCounterData && Array.isArray(lastCounterData.by_model)) {
                renderModelsTable(lastCounterData.by_model);
            }
        };
    }
}
