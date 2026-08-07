import { store, getActiveConversation, persistActiveConvId, saveHistoryToBackend } from './storage.js';
import { showConfirmModal } from './modals.js';
import { renderChat } from './chat.js';
import { updateTokenCount } from './tokens.js';

const MOVE_MENU_ID = 'move-menu-popup';

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

function closeMoveMenu() {
    const existing = document.getElementById(MOVE_MENU_ID);
    if (existing) existing.remove();
}

function showMoveMenu(conv, anchorEl) {
    closeMoveMenu();

    const menu = document.createElement('div');
    menu.id = MOVE_MENU_ID;

    const targets = [{ id: null, name: 'No Folder (Root)' }].concat(
        store.folders.map(f => ({ id: f.id, name: f.name }))
    );

    targets.forEach(target => {
        const btn = document.createElement('button');
        const isCurrent = (conv.folderId || null) === target.id;
        btn.className = `w-full text-left text-sm px-3 py-2 rounded transition-colors flex items-center gap-2 ${isCurrent ? 'bg-gb-bgLight2 text-gb-fgLightest font-semibold' : 'text-gb-fgLight hover:bg-gb-bgLight1'}`;
        btn.innerHTML = `<i data-lucide="${target.id ? 'folder' : 'inbox'}" class="w-3.5 h-3.5 shrink-0 text-gb-aquaAccent"></i><span class="truncate"></span>`;
        btn.querySelector('span').textContent = target.name;
        btn.onclick = (e) => {
            e.stopPropagation();
            conv.folderId = target.id;
            saveConversations();
            closeMoveMenu();
            renderSidebar();
        };
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    const rect = anchorEl.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 340)}px`;

    lucide.createIcons();

    setTimeout(() => {
        document.addEventListener('click', closeMoveMenu, { once: true });
    }, 0);
}

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

    const moveBtn = document.createElement('button');
    moveBtn.className = 'text-gb-fgDark hover:text-gb-aquaAccent transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    moveBtn.innerHTML = '<i data-lucide="folder-input" class="w-3.5 h-3.5"></i>';
    moveBtn.title = 'Move to folder';
    moveBtn.onclick = (e) => {
        e.stopPropagation();
        showMoveMenu(conv, moveBtn);
    };

    const editBtn = document.createElement('button');
    editBtn.className = 'text-gb-fgDark hover:text-gb-blueAccent transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    editBtn.innerHTML = '<i data-lucide="edit-2" class="w-3.5 h-3.5"></i>';
    editBtn.onclick = (e) => {
        e.stopPropagation();
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
        left.replaceChild(input, titleSpan);
        input.focus();
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'text-gb-fgDark hover:text-gb-redAccent transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    delBtn.innerHTML = '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i>';
    delBtn.onclick = (e) => {
        e.stopPropagation();
        if (store.isProcessing && conv.id === store.activeConvId) {
            alert('Please stop the current generation before deleting this thread.');
            return;
        }
        showConfirmModal('Delete Thread', `Are you sure you want to delete the thread "${conv.title}"?`, () => {
            deleteConversation(conv.id);
        });
    };

    actionsDiv.appendChild(moveBtn);
    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(delBtn);
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
    closeMoveMenu();

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

export async function startAutoNaming() {
    if (store.isAutoNaming) return;

    const localModels = store.allModels.filter(m => {
        const pid = m.provider_id || 'other';
        return !['openai', 'anthropic', 'google'].includes(pid);
    });
    if (localModels.length === 0) return;
    const autoNameModel = localModels[0].id;

    store.isAutoNaming = true;
    const autoNameBtn = document.getElementById('auto-name-btn');
    const originalBtnHtml = autoNameBtn ? autoNameBtn.innerHTML : '';
    if (autoNameBtn) {
        autoNameBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Naming...';
        lucide.createIcons();
    }

    for (let i = 0; i < store.conversations.length; i++) {
        const conv = store.conversations[i];

        let shouldName = false;
        if (!conv.isCustomName && !conv.isAutoNamed) {
            if (conv.title === 'New Chat') {
                shouldName = true;
            } else {
                const firstUser = conv.messages.find(m => m.role === 'user');
                if (firstUser) {
                    const sliced = firstUser.content.slice(0, 30);
                    const expected = sliced + (firstUser.content.length > 30 ? '...' : '');
                    if (conv.title === expected) {
                        shouldName = true;
                    } else {
                        conv.isCustomName = true;
                    }
                } else if (conv.title !== 'New Chat') {
                    conv.isCustomName = true;
                }
            }
        }
        if (!shouldName) continue;

        const firstUser = conv.messages.find(m => m.role === 'user');
        if (!firstUser || !firstUser.content) continue;

        let text = firstUser.content;
        if (text.length > 40000) {
            text = text.substring(0, 20000) + '\n\n...[TRUNCATED]...\n\n' + text.substring(text.length - 20000);
        }

        const iconEl = document.getElementById(`conv-icon-${conv.id}`);
        if (iconEl) {
            iconEl.setAttribute('data-lucide', 'loader-2');
            iconEl.classList.add('animate-spin');
            lucide.createIcons();
        }

        try {
            const res = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: autoNameModel,
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant. Generate a short, one-line title (max 5 words) for the following prompt. Output ONLY the title, no quotes or prefix.' },
                        { role: 'user', content: text }
                    ],
                    stream: false,
                    max_tokens: 15
                })
            });
            if (res.ok) {
                const data = await res.json();
                let title = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
                if (title) {
                    conv.title = title.replace(/^"|"$/g, '');
                    conv.isAutoNamed = true;
                    saveConversations();
                }
            }
        } catch (e) {
            console.error('Auto name failed for', conv.id, e);
        }

        renderSidebar();
    }

    store.isAutoNaming = false;
    if (autoNameBtn) {
        autoNameBtn.innerHTML = originalBtnHtml;
        lucide.createIcons();
    }
}
