import { store, getActiveConversation, persistActiveConvId, saveHistoryToBackend } from './storage.js';
import { showConfirmModal } from './modals.js';
import { renderChat } from './chat.js';
import { updateTokenCount } from './tokens.js';
import { showPopupMenu, closePopupMenu } from './popupMenu.js';
import { resolveAutoNameModel, buildNamingBasis } from './autoName.js';
import { splitInlineThinking, getInlineTags } from './reasoning.js';
import { AUTO_NAME_MAX_TOKENS, AUTO_NAME_REASONING_EFFORT } from './config.js';

const NAMING_SYSTEM_PROMPT = 'You are a helpful assistant. You will be given an excerpt of a conversation containing a user request and the assistant reply to it. Generate a short, one-line title (max 5 words) describing what the exchange is about. Output ONLY the title, no quotes or prefix.';
const AUTO_NAME_BTN_HTML = '<i data-lucide="zap" class="w-3.5 h-3.5"></i> Auto Name';
const NO_NAMING_MODEL_MSG = 'No local or custom endpoint model is available for auto-naming. Add one in Settings.';

export function saveConversations() {
    persistActiveConvId();
    saveHistoryToBackend();
}

export function initConversations() {
    if (!Array.isArray(store.folders)) store.folders = [];
    if (store.conversations.length === 0) {
        createNewChat();
        return;
    }
    if (!store.activeConvId || !store.conversations.some(c => c.id === store.activeConvId)) {
        store.activeConvId = store.conversations[0].id;
    }
    saveConversations();
}

export function createNewChat(folderId) {
    const id = 'conv_' + Date.now();
    store.conversations.unshift({
        id,
        title: 'New Chat',
        messages: [],
        folderId: folderId || null
    });
    store.activeConvId = id;
    saveConversations();
    renderSidebar();
    renderChat();
}

export function createNewFolder() {
    const folder = {
        id: 'folder_' + Date.now(),
        name: 'New Folder',
        collapsed: false
    };
    store.folders.unshift(folder);
    saveConversations();
    renderSidebar();
}

export function saveHistory() {
    const active = getActiveConversation();
    if (!active) return;
    if (active.title === 'New Chat' && active.messages.length > 0) {
        const firstUser = active.messages.find(m => m.role === 'user');
        if (firstUser) {
            const sliced = firstUser.content.slice(0, 30);
            active.title = sliced + (firstUser.content.length > 30 ? '...' : '');
        }
    }
    saveConversations();
    renderSidebar();
}

export function deleteConversation(id) {
    store.conversations = store.conversations.filter(c => c.id !== id);
    if (store.activeConvId === id) {
        store.activeConvId = store.conversations.length > 0 ? store.conversations[0].id : '';
    }
    initConversations();
    saveConversations();
    renderSidebar();
    renderChat();
}

/** Non-destructive: children are moved to root rather than deleted. */
export function deleteFolder(folderId) {
    store.folders = store.folders.filter(f => f.id !== folderId);
    store.conversations.forEach(c => {
        if (c.folderId === folderId) c.folderId = null;
    });
    saveConversations();
    renderSidebar();
}

// ---------------------------------------------------------------------------
// Auto-naming
// ---------------------------------------------------------------------------

function setConvIcon(convId, iconName, spinning) {
    const iconEl = document.getElementById('conv-icon-' + convId);
    if (!iconEl) return;
    iconEl.setAttribute('data-lucide', iconName);
    iconEl.classList.toggle('animate-spin', spinning === true);
    lucide.createIcons();
}

/**
 * Shared busy state for both the bulk run and a single forced rename, so the
 * two paths can never interleave against the same endpoint.
 */
function setAutoNamingState(isActive) {
    store.isAutoNaming = isActive;

    const select = document.getElementById('auto-name-model-select');
    if (select) select.disabled = isActive;

    const btn = document.getElementById('auto-name-btn');
    if (btn) {
        btn.innerHTML = isActive
            ? '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Naming...'
            : AUTO_NAME_BTN_HTML;
    }
    lucide.createIcons();
}

// Statuses a strict OpenAI-compatible server uses to reject an unknown
// top-level field. Anything else is a real failure, not a schema complaint.
const NAMING_RETRY_STATUSES = [400, 422];
const MAX_TITLE_CHARS = 80;

function buildNamingBody(modelId, basis, withEffort) {
    const body = {
        model: modelId,
        messages: [
            { role: 'system', content: NAMING_SYSTEM_PROMPT },
            { role: 'user', content: basis }
        ],
        stream: false,
        max_tokens: AUTO_NAME_MAX_TOKENS
    };
    if (withEffort) body.reasoning_effort = AUTO_NAME_REASONING_EFFORT;
    return body;
}

function postNaming(modelId, basis, withEffort) {
    return fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildNamingBody(modelId, basis, withEffort))
    });
}

/**
 * Two attempts at most, never a loop. The reasoning_effort field is dropped
 * and the call repeated only when the server rejected the schema itself.
 */
async function postNamingRequest(modelId, basis) {
    const first = await postNaming(modelId, basis, true);
    if (first.ok || NAMING_RETRY_STATUSES.indexOf(first.status) === -1) return first;

    console.warn('Naming endpoint rejected reasoning_effort (HTTP ' + first.status + '), retrying without it.');
    return postNaming(modelId, basis, false);
}

/**
 * Pulls a usable title out of a naming response.
 *
 * Inline think blocks are stripped even though reasoning_effort asked for
 * none, since not every server honours the flag. Returns '' when nothing
 * usable survives.
 */
function extractTitle(data) {
    const choice = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
    const message = (choice && choice.message) ? choice.message : null;
    const raw = (message && typeof message.content === 'string') ? message.content : '';
    if (!raw) return '';

    const clean = splitInlineThinking(raw, '', getInlineTags()).cleanContent || '';

    // Last non-empty line: a model that narrates before answering leaves the
    // title at the end, and a well-behaved one emits a single line anyway.
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '';

    return lines[lines.length - 1]
        .replace(/^title\s*:\s*/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim()
        .slice(0, MAX_TITLE_CHARS);
}

function emptyTitleReason(data) {
    const choice = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
    if (choice && choice.finish_reason === 'length') {
        return 'the naming model used its entire token budget before writing a title.';
    }
    return 'the naming model returned an empty title.';
}

/**
 * Names one conversation from its request-plus-reply excerpt.
 * Returns { ok, reason } so the caller decides whether to surface a failure:
 * the bulk run stays quiet, an explicit user action does not.
 */
async function nameConversation(conv, modelId) {
    const basis = buildNamingBasis(conv);
    if (!basis) {
        return { ok: false, reason: 'there is no user request text to name it from.' };
    }

    setConvIcon(conv.id, 'loader-2', true);

    try {
        const res = await postNamingRequest(modelId, basis);
        if (!res.ok) {
            return { ok: false, reason: 'the naming model returned HTTP ' + res.status + '.' };
        }

        const data = await res.json();
        const title = extractTitle(data);
        if (!title) {
            return { ok: false, reason: emptyTitleReason(data) };
        }

        conv.title = title;
        conv.isAutoNamed = true;
        // Cleared so a forced rename does not permanently exclude the thread
        // from later bulk runs.
        conv.isCustomName = false;
        saveConversations();
        return { ok: true, reason: '' };
    } catch (e) {
        console.error('Auto name failed for', conv.id, e);
        return { ok: false, reason: (e && e.message) ? e.message : 'the request failed.' };
    } finally {
        setConvIcon(conv.id, 'message-square', false);
    }
}

/**
 * Bulk-run eligibility. Marks anything with a title the user must have typed
 * as custom, so it is skipped now and on every later run.
 */
function shouldAutoName(conv) {
    if (!conv || conv.isCustomName || conv.isAutoNamed) return false;
    if (conv.title === 'New Chat') return true;

    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const firstUser = messages.find(m => m && m.role === 'user');
    if (!firstUser || typeof firstUser.content !== 'string') {
        conv.isCustomName = true;
        return false;
    }

    const sliced = firstUser.content.slice(0, 30);
    const expected = sliced + (firstUser.content.length > 30 ? '...' : '');
    if (conv.title === expected) return true;

    conv.isCustomName = true;
    return false;
}

export async function startAutoNaming() {
    if (store.isAutoNaming) return;

    const modelId = resolveAutoNameModel();
    if (!modelId) {
        alert(NO_NAMING_MODEL_MSG);
        return;
    }

    setAutoNamingState(true);
    try {
        for (let i = 0; i < store.conversations.length; i++) {
            const conv = store.conversations[i];
            if (!shouldAutoName(conv)) continue;
            await nameConversation(conv, modelId);
            renderSidebar();
        }
    } finally {
        setAutoNamingState(false);
        renderSidebar();
    }
}

/**
 * Forced single-conversation rename. Deliberately skips the eligibility gate,
 * so it works on threads that were named manually or automatically before.
 */
export async function autoNameConversation(convId) {
    if (store.isAutoNaming) return;

    const conv = store.conversations.find(c => c.id === convId);
    if (!conv) return;

    const modelId = resolveAutoNameModel();
    if (!modelId) {
        alert(NO_NAMING_MODEL_MSG);
        return;
    }

    setAutoNamingState(true);
    try {
        const result = await nameConversation(conv, modelId);
        if (!result.ok) {
            alert('Could not name this thread: ' + result.reason);
        }
    } finally {
        setAutoNamingState(false);
        renderSidebar();
    }
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function switchToConversation(convId) {
    if (store.isProcessing) {
        alert('Please stop the current generation before switching threads.');
        return;
    }
    store.activeConvId = convId;
    saveConversations();
    renderSidebar();
    renderChat();
    updateTokenCount();
}

/**
 * Swaps the title span for an input in place. Extracted so a menu item can
 * trigger it after the popup has closed.
 */
function beginInlineRename(conv, container, titleSpan) {
    if (!container || !titleSpan || !titleSpan.isConnected) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-sm font-medium bg-gb-bgDarkest text-gb-fgLight border border-gb-blueAccent rounded px-1 outline-none w-full mr-2';
    input.value = conv.title;
    input.onclick = (ev) => ev.stopPropagation();
    input.onkeydown = (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') {
            input.value = conv.title;
            input.blur();
        }
    };
    input.onblur = () => {
        const newTitle = input.value.trim() || 'Untitled';
        if (conv.title !== newTitle) {
            conv.title = newTitle;
            conv.isCustomName = true;
            conv.isAutoNamed = false;
        }
        saveConversations();
        renderSidebar();
    };

    container.replaceChild(input, titleSpan);
    input.focus();
    input.select();
}

function buildMoveMenuItems(conv, anchorEl, beginRename) {
    const items = [{
        icon: 'arrow-left',
        label: 'Back',
        onSelect: () => {
            showPopupMenu(buildConversationMenuItems(conv, anchorEl, beginRename), anchorEl);
            return 'keep-open';
        }
    }];

    const targets = [{ id: null, name: 'No Folder (Root)' }].concat(
        store.folders.map(f => ({ id: f.id, name: f.name }))
    );

    targets.forEach(target => {
        items.push({
            icon: target.id ? 'folder' : 'inbox',
            label: target.name,
            active: (conv.folderId || null) === target.id,
            onSelect: () => {
                conv.folderId = target.id;
                saveConversations();
                renderSidebar();
            }
        });
    });

    return items;
}

function buildConversationMenuItems(conv, anchorEl, beginRename) {
    let nameDisabled = false;
    let nameTitle = 'Generate a title for this thread using the naming model';

    if (store.isAutoNaming) {
        nameDisabled = true;
        nameTitle = 'A naming run is already in progress';
    } else if (!resolveAutoNameModel()) {
        nameDisabled = true;
        nameTitle = 'No local or custom endpoint model is configured for naming';
    }

    return [
        {
            icon: 'sparkles',
            label: 'Name with AI',
            disabled: nameDisabled,
            title: nameTitle,
            onSelect: () => {
                autoNameConversation(conv.id);
            }
        },
        {
            icon: 'edit-2',
            label: 'Rename',
            onSelect: () => {
                beginRename();
            }
        },
        {
            icon: 'folder-input',
            label: 'Move to folder',
            onSelect: () => {
                showPopupMenu(buildMoveMenuItems(conv, anchorEl, beginRename), anchorEl);
                return 'keep-open';
            }
        },
        {
            icon: 'trash-2',
            label: 'Delete',
            danger: true,
            onSelect: () => {
                if (store.isProcessing && conv.id === store.activeConvId) {
                    alert('Please stop the current generation before deleting this thread.');
                    return;
                }
                showConfirmModal('Delete Thread', 'Are you sure you want to delete the thread "' + conv.title + '"?', () => {
                    deleteConversation(conv.id);
                });
            }
        }
    ];
}

function createConversationRow(conv) {
    const isActive = conv.id === store.activeConvId;
    const item = document.createElement('div');
    item.className = `group flex justify-between items-center p-3 rounded-lg cursor-pointer transition-all duration-300 sidebar-item ${isActive ? 'bg-gb-bgLight1 border border-gb-bgLight3 text-gb-fgLightest shadow-sm scale-[1.02]' : 'text-gb-fgDark hover:bg-gb-bgLight1/40 hover:text-gb-fgLight hover:translate-x-1'}`;

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2 overflow-hidden flex-1';
    left.innerHTML = `<i id="conv-icon-${conv.id}" data-lucide="message-square" class="w-4 h-4 shrink-0 ${isActive ? 'text-gb-aquaAccent' : 'opacity-60'} transition-all"></i>`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'text-sm truncate font-medium';
    titleSpan.textContent = conv.title;
    left.appendChild(titleSpan);

    left.onclick = () => switchToConversation(conv.id);
    item.appendChild(left);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0';

    const moreBtn = document.createElement('button');
    moreBtn.className = 'text-gb-fgDark hover:text-gb-fgLightest transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    moreBtn.innerHTML = '<i data-lucide="more-vertical" class="w-3.5 h-3.5"></i>';
    moreBtn.title = 'More options';
    moreBtn.onclick = (e) => {
        e.stopPropagation();
        const beginRename = () => beginInlineRename(conv, left, titleSpan);
        showPopupMenu(buildConversationMenuItems(conv, moreBtn, beginRename), moreBtn);
    };

    actionsDiv.appendChild(moreBtn);
    item.appendChild(actionsDiv);

    return item;
}

function createFolderRow(folder, childCount) {
    const row = document.createElement('div');
    row.className = 'group flex justify-between items-center p-2 rounded-lg cursor-pointer transition-all duration-200 text-gb-fgMedium hover:bg-gb-bgLight1/40';

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2 overflow-hidden flex-1';
    left.innerHTML = `<i data-lucide="${folder.collapsed ? 'chevron-right' : 'chevron-down'}" class="w-3.5 h-3.5 shrink-0 opacity-70"></i><i data-lucide="${folder.collapsed ? 'folder' : 'folder-open'}" class="w-4 h-4 shrink-0 text-gb-aquaAccent"></i>`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'text-sm truncate font-bold';
    nameSpan.textContent = folder.name;
    left.appendChild(nameSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'text-xs font-mono text-gb-fgDark shrink-0';
    countSpan.textContent = String(childCount);
    left.appendChild(countSpan);

    left.onclick = () => {
        folder.collapsed = !folder.collapsed;
        saveConversations();
        renderSidebar();
    };
    row.appendChild(left);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0';

    const addBtn = document.createElement('button');
    addBtn.className = 'text-gb-fgDark hover:text-gb-greenAccent transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    addBtn.innerHTML = '<i data-lucide="plus" class="w-3.5 h-3.5"></i>';
    addBtn.title = 'New chat in folder';
    addBtn.onclick = (e) => {
        e.stopPropagation();
        if (store.isProcessing) {
            alert('Please stop the current generation before starting a new chat.');
            return;
        }
        folder.collapsed = false;
        createNewChat(folder.id);
    };

    const editBtn = document.createElement('button');
    editBtn.className = 'text-gb-fgDark hover:text-gb-blueAccent transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    editBtn.innerHTML = '<i data-lucide="edit-2" class="w-3.5 h-3.5"></i>';
    editBtn.onclick = (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-sm font-bold bg-gb-bgDarkest text-gb-fgLight border border-gb-blueAccent rounded px-1 outline-none w-full mr-2';
        input.value = folder.name;
        input.onclick = (ev) => ev.stopPropagation();
        input.onkeydown = (ev) => {
            if (ev.key === 'Enter') input.blur();
            if (ev.key === 'Escape') {
                input.value = folder.name;
                input.blur();
            }
        };
        input.onblur = () => {
            folder.name = input.value.trim() || 'Untitled Folder';
            saveConversations();
            renderSidebar();
        };
        left.replaceChild(input, nameSpan);
        input.focus();
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'text-gb-fgDark hover:text-gb-redAccent transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    delBtn.innerHTML = '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i>';
    delBtn.onclick = (e) => {
        e.stopPropagation();
        showConfirmModal(
            'Delete Folder',
            `Delete the folder "${folder.name}"? Its ${childCount} conversation(s) will be moved to the root, not deleted.`,
            () => deleteFolder(folder.id)
        );
    };

    actionsDiv.appendChild(addBtn);
    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(delBtn);
    row.appendChild(actionsDiv);

    return row;
}

export function renderSidebar() {
    const convList = document.getElementById('conv-list');
    if (!convList) return;
    convList.innerHTML = '';
    closePopupMenu();

    const folderIds = new Set(store.folders.map(f => f.id));

    store.folders.forEach(folder => {
        const children = store.conversations.filter(c => c.folderId === folder.id);
        convList.appendChild(createFolderRow(folder, children.length));

        if (folder.collapsed) return;

        const childWrap = document.createElement('div');
        childWrap.className = 'folder-children flex flex-col gap-2';
        if (children.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.className = 'text-xs text-gb-bgLight3 italic px-3 py-1';
            emptyHint.textContent = 'Empty';
            childWrap.appendChild(emptyHint);
        } else {
            children.forEach(conv => childWrap.appendChild(createConversationRow(conv)));
        }
        convList.appendChild(childWrap);
    });

    // Conversations with no folder, or a dangling folderId, render at root.
    store.conversations
        .filter(c => !c.folderId || !folderIds.has(c.folderId))
        .forEach(conv => convList.appendChild(createConversationRow(conv)));

    lucide.createIcons();
}
