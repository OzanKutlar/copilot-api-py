import { store, getActiveConversation } from './storage.js';
import { countTokens, updateTokenCount } from './tokens.js';
import { parseCombineCopyPrompt } from './promptParser.js';
import { showConfirmModal } from './modals.js';
import { saveHistory } from './sidebar.js';
import { renderChat, triggerAPI } from './chat.js';

export async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn('Clipboard API failed, trying fallback...', err);
        }
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        textArea.remove();
        return true;
    } catch (err) {
        console.error('Fallback clipboard failed', err);
        textArea.remove();
        return false;
    }
}

function blockedWhileProcessing(actionLabel) {
    if (store.isProcessing) {
        alert(`Please stop the current generation before ${actionLabel}.`);
        return true;
    }
    return false;
}

/**
 * Generic collapsed panel. The body is built lazily on first expand so large
 * system prompts cost nothing until the user actually opens them.
 */
function createAccordion(title, iconName, subtitle, buildBody) {
    const wrap = document.createElement('div');
    wrap.className = 'mt-3 border border-gb-bgLight2 rounded-lg bg-gb-bgDarkest overflow-hidden';

    const head = document.createElement('button');
    head.className = 'w-full flex justify-between items-center p-3 bg-gb-bgLight1 hover:bg-gb-bgLight2 transition-colors text-sm font-bold text-gb-fgMedium';

    const subtitleHtml = subtitle
        ? `<span class="text-xs font-mono text-gb-fgDark font-normal">${subtitle}</span>`
        : '';
    head.innerHTML = `<div class="flex items-center gap-2"><i data-lucide="${iconName}" class="w-4 h-4 text-gb-blueAccent"></i> <span>${title}</span>${subtitleHtml}</div><i data-lucide="chevron-down" class="w-4 h-4 transition-transform duration-300 accordion-icon"></i>`;

    const body = document.createElement('div');
    body.className = 'hidden flex-col gap-1 p-2 bg-gb-bgDarkest max-h-96 overflow-y-auto scrollbar-hide';

    let built = false;
    head.onclick = () => {
        if (!built) {
            try {
                buildBody(body);
            } catch (e) {
                console.error('Failed to build accordion body', e);
            }
            built = true;
            lucide.createIcons();
        }
        body.classList.toggle('hidden');
        body.classList.toggle('flex');
        const icon = head.querySelector('.accordion-icon');
        if (icon) icon.classList.toggle('rotate-180');
    };

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
}

function buildFilesBody(files) {
    return (bodyDiv) => {
        files.forEach(f => {
            const fItem = document.createElement('div');
            fItem.className = `flex flex-col gap-1 p-2 rounded border transition-colors text-xs font-mono ${f.isPruned ? 'bg-gb-bg border-gb-bgLight2 opacity-60' : 'bg-gb-bgLight1 border-gb-bgLight3'}`;

            const fHeader = document.createElement('div');
            fHeader.className = 'flex items-center justify-between';

            const iconHtml = f.isPruned
                ? '<i data-lucide="scissors" class="w-3.5 h-3.5 text-gb-redAccent"></i>'
                : '<i data-lucide="file-code" class="w-3.5 h-3.5 text-gb-aquaAccent"></i>';
            const titleClass = f.isPruned ? 'line-through text-gb-fgDark' : 'text-gb-fgLight';

            fHeader.innerHTML = `<div class="flex items-center gap-2">${iconHtml} <span class="${titleClass} truncate"></span></div>`;
            fHeader.querySelector('span').textContent = f.path;
            fItem.appendChild(fHeader);

            if (f.isPruned) {
                const reasonDiv = document.createElement('div');
                reasonDiv.className = 'mt-1 text-gb-fgMedium text-[11px] bg-[#321c1a] p-1.5 rounded border border-gb-redAccent/30 italic whitespace-normal';
                reasonDiv.textContent = f.prunedReason;
                fItem.appendChild(reasonDiv);
            }

            bodyDiv.appendChild(fItem);
        });
    };
}

function buildSectionBody(text) {
    return (bodyDiv) => {
        const pre = document.createElement('pre');
        pre.className = 'prompt-section-body';
        pre.textContent = text;
        bodyDiv.appendChild(pre);
    };
}

function renderStructuredUserMessage(content, parsed) {
    content.className = 'w-full flex flex-col gap-2';

    const textDiv = document.createElement('div');
    textDiv.className = 'whitespace-pre-wrap font-mono text-sm text-gb-fgLight break-words leading-relaxed';
    if (parsed.userRequest) {
        textDiv.textContent = parsed.userRequest;
    } else {
        textDiv.innerHTML = '<div class="italic text-gb-fgDark flex items-center gap-2 bg-gb-bgDarkest p-3 rounded border border-gb-bgLight2"><i data-lucide="info" class="w-4 h-4"></i> No user request text in this payload.</div>';
    }
    content.appendChild(textDiv);

    if (parsed.files.length > 0) {
        const prunedCount = parsed.files.filter(f => f.isPruned).length;
        const subtitle = prunedCount > 0 ? `${prunedCount} pruned` : '';
        content.appendChild(createAccordion(
            `${parsed.files.length} Files Provided`,
            'folder-open',
            subtitle,
            buildFilesBody(parsed.files)
        ));
    }

    parsed.sections.forEach(section => {
        const approxTokens = countTokens(section.body);
        content.appendChild(createAccordion(
            section.title,
            section.icon,
            `~${approxTokens.toLocaleString()} tok`,
            buildSectionBody(section.body)
        ));
    });
}

function renderPlainUserMessage(content, msg) {
    content.className = 'w-full flex flex-col gap-2';
    const textDiv = document.createElement('div');
    textDiv.className = 'whitespace-pre-wrap font-mono text-sm text-gb-fgLight break-words leading-relaxed';

    const tokens = countTokens(msg.content);
    if (tokens > 1000) {
        textDiv.innerHTML = `<div class="italic text-gb-fgDark flex items-center gap-2 bg-gb-bgDarkest p-3 rounded border border-gb-bgLight2"><i data-lucide="file-text" class="w-4 h-4"></i> Long message : ${tokens.toLocaleString()} Tokens</div>`;
    } else {
        textDiv.textContent = msg.content;
    }
    content.appendChild(textDiv);
}

function createMessageActions(msg, index, isUser, isError, contentDiv) {
    const container = document.createElement('div');
    container.className = 'flex items-center gap-2 flex-wrap';

    if (isUser) {
        const rerunBtn = document.createElement('button');
        rerunBtn.className = 'flex items-center gap-1.5 text-xs text-gb-fgDark hover:text-gb-greenAccent transition-all bg-gb-bgDarkest hover:bg-gb-bgLight1 px-3 py-1.5 rounded border border-gb-bgLight2 font-semibold hover:scale-105';
        rerunBtn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> Re-run';
        rerunBtn.onclick = () => {
            if (blockedWhileProcessing('re-running')) return;
            const active = getActiveConversation();
            if (!active) return;
            const idx = active.messages.indexOf(msg);
            if (idx < 0) return;
            showConfirmModal('Re-run Prompt', 'Re-running this prompt will permanently discard all subsequent messages in this thread. Proceed?', () => {
                active.messages = active.messages.slice(0, idx + 1);
                saveHistory();
                renderChat();
                triggerAPI();
            });
        };
        container.appendChild(rerunBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.className = `edit-btn-${index} flex items-center gap-1.5 text-xs text-gb-fgDark hover:text-gb-blueAccent transition-all bg-gb-bgDarkest hover:bg-gb-bgLight1 px-3 py-1.5 rounded border border-gb-bgLight2 font-semibold hover:scale-105`;
    editBtn.innerHTML = '<i data-lucide="edit-2" class="w-4 h-4"></i> Edit';
    editBtn.onclick = () => {
        if (blockedWhileProcessing('editing messages')) return;
        const isEditing = contentDiv.querySelector('.edit-textarea') !== null;
        if (!isEditing) {
            const currentText = msg.content || '';
            contentDiv.innerHTML = '';
            const editTextArea = document.createElement('textarea');
            editTextArea.className = 'edit-textarea w-full bg-gb-bgDarkest border border-gb-bgLight2 text-gb-fgLight text-sm rounded-lg focus:ring-1 focus:ring-gb-blueAccent outline-none p-4 font-mono resize-y mt-2';
            editTextArea.rows = Math.max(3, currentText.split('\n').length);
            editTextArea.value = currentText;
            contentDiv.appendChild(editTextArea);

            document.querySelectorAll(`.edit-btn-${index}`).forEach(btn => {
                btn.innerHTML = '<i data-lucide="save" class="w-4 h-4 text-gb-greenAccent"></i> Save';
                btn.classList.replace('hover:text-gb-blueAccent', 'hover:text-gb-greenAccent');
            });
            lucide.createIcons();
        } else {
            const editTextArea = contentDiv.querySelector('.edit-textarea');
            if (!editTextArea) return;
            msg.content = editTextArea.value;
            delete msg.originalContent;
            delete msg.prunedContent;
            saveHistory();
            renderChat();
            updateTokenCount();
        }
    };
    container.appendChild(editBtn);

    if (!isError && (msg.content || msg.role === 'assistant')) {
        const copyBtn = document.createElement('button');
        copyBtn.className = `copy-btn-${index} flex items-center gap-1.5 text-xs text-gb-fgDark hover:text-gb-blueAccent transition-all bg-gb-bgDarkest hover:bg-gb-bgLight1 px-3 py-1.5 rounded border border-gb-bgLight2 font-semibold hover:scale-105`;
        copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i> Copy Raw';
        copyBtn.onclick = async () => {
            // Always copies the FULL untouched payload, not the trimmed display text.
            const success = await copyTextToClipboard(msg.content);
            if (!success) return;
            document.querySelectorAll(`.copy-btn-${index}`).forEach(btn => {
                btn.innerHTML = '<i data-lucide="check" class="w-4 h-4 text-gb-greenAccent"></i> Copied';
                btn.classList.replace('hover:text-gb-blueAccent', 'hover:text-gb-greenAccent');
            });
            lucide.createIcons();
            setTimeout(() => {
                document.querySelectorAll(`.copy-btn-${index}`).forEach(btn => {
                    btn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i> Copy Raw';
                    btn.classList.replace('hover:text-gb-greenAccent', 'hover:text-gb-blueAccent');
                });
                lucide.createIcons();
            }, 2000);
        };
        container.appendChild(copyBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'flex items-center gap-1.5 text-xs text-gb-fgDark hover:text-gb-redAccent transition-all bg-gb-bgDarkest hover:bg-gb-bgLight1 px-3 py-1.5 rounded border border-gb-bgLight2 font-semibold hover:scale-105';
    deleteBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i> Delete';
    deleteBtn.onclick = () => {
        if (blockedWhileProcessing('deleting messages')) return;
        showConfirmModal('Delete Message', 'Are you sure you want to delete this specific message from the history?', () => {
            const active = getActiveConversation();
            if (!active) return;
            const idx = active.messages.indexOf(msg);
            if (idx < 0) return;
            active.messages.splice(idx, 1);
            saveHistory();
            renderChat();
            updateTokenCount();
        });
    };
    container.appendChild(deleteBtn);

    return container;
}

function renderAssistantMessage(content, msg, index, inner) {
    if (!msg.content) {
        content.className = 'flex items-center gap-2 text-gb-aquaAccent font-semibold animate-pulse py-2';
        content.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i><span>Thinking...</span>';
        return;
    }

    content.className = 'prose prose-invert prose-gruvbox max-w-none text-sm break-words leading-relaxed';

    let displayContent = msg.content;
    if (msg.pruneInfo) {
        displayContent = displayContent.replace(/```(?:json)?\s*(\{[\s\S]*?"phase"\s*:\s*"PRUNE"[\s\S]*?\})\s*```/ig, '');
        displayContent = displayContent.replace(/<antigravity_payload>[\s\S]*?<phase>PRUNE<\/phase>[\s\S]*?<\/antigravity_payload>/ig, '');
    }

    content.innerHTML = marked.parse(displayContent);

    if (!msg.pruneInfo) return;

    const pruneCard = document.createElement('div');
    pruneCard.className = 'mt-4 bg-gb-bgDarkest border border-gb-bgLight2 rounded-lg p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between shadow-sm gap-4 not-prose';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'flex items-center gap-3';
    infoDiv.innerHTML = `<div class="p-2 bg-gb-bgLight1 rounded-md border border-gb-bgLight3 shrink-0"><i data-lucide="scissors" class="w-5 h-5 text-gb-aquaAccent"></i></div><div class="flex flex-col"><span class="text-sm font-bold text-gb-fgLightest">Context Pruned</span><span class="text-xs font-mono text-gb-fgDark">${msg.pruneInfo.tokensSaved.toLocaleString()} tokens saved</span></div>`;

    const toggleBtn = document.createElement('button');
    const isPruned = msg.pruneInfo.isPruned;
    toggleBtn.className = `px-4 py-2 rounded font-bold text-sm transition-all duration-300 shadow-md hover:scale-[1.02] active:scale-95 flex items-center gap-2 shrink-0 ${isPruned ? 'bg-gb-bgLight2 hover:bg-gb-bgLight3 text-gb-fgLight border border-gb-bgLight3' : 'bg-gb-blue hover:bg-gb-blueAccent text-gb-bgDarkest'}`;
    toggleBtn.innerHTML = isPruned
        ? '<i data-lucide="rotate-ccw" class="w-4 h-4"></i> Re-add Files'
        : '<i data-lucide="scissors" class="w-4 h-4"></i> Prune Files';

    toggleBtn.onclick = () => {
        msg.pruneInfo.isPruned = !msg.pruneInfo.isPruned;
        const active = getActiveConversation();
        if (!active) return;
        const targetIdx = msg.pruneInfo.userMsgIndex;
        if (targetIdx < 0 || targetIdx >= active.messages.length) return;
        const targetUserMsg = active.messages[targetIdx];
        targetUserMsg.content = msg.pruneInfo.isPruned
            ? targetUserMsg.prunedContent
            : targetUserMsg.originalContent;
        saveHistory();
        renderChat();
        updateTokenCount();
    };

    pruneCard.appendChild(infoDiv);
    pruneCard.appendChild(toggleBtn);
    content.appendChild(pruneCard);
}

export function createMessageElement(msg, index) {
    const isUser = msg.role === 'user';
    const isError = msg.isError === true;

    const div = document.createElement('div');
    div.className = `flex w-full ${isUser ? 'justify-end' : 'justify-start'} mb-6 animate-fade-in-up`;

    let bgClass = isUser ? 'bg-gb-bgLight1 border-gb-bgLight3' : 'bg-gb-bg border-gb-bgLight2';
    if (isError) bgClass = 'bg-[#321c1a] border-gb-redAccent';

    const inner = document.createElement('div');
    inner.className = `max-w-5xl w-full flex flex-col gap-3 p-5 rounded-lg border shadow-sm ${bgClass} transition-all duration-300 hover:shadow-md`;

    const header = document.createElement('div');
    header.className = 'flex justify-between items-center border-b pb-3 mb-1 border-gb-bgLight2 text-sm font-bold uppercase tracking-wide text-gb-fgMedium';

    const roleDiv = document.createElement('div');
    roleDiv.className = 'flex items-center gap-2';
    if (isError) {
        roleDiv.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5 text-gb-redAccent"></i> <span class="text-gb-redAccent">Error</span>';
    } else {
        roleDiv.innerHTML = `<i data-lucide="${isUser ? 'user' : 'bot'}" class="w-5 h-5 ${isUser ? 'text-gb-blueAccent' : 'text-gb-aquaAccent'}"></i> <span>${isUser ? 'User Request' : 'AI Output'}</span>`;
    }
    header.appendChild(roleDiv);

    const content = document.createElement('div');
    content.id = `msg-content-${index}`;

    if (!isUser && !isError) {
        const thinkingContainer = document.createElement('div');
        thinkingContainer.id = `thinking-badge-${index}`;
        thinkingContainer.className = 'hidden mb-4 text-xs text-gb-fgDark font-mono bg-gb-bgDarkest/70 p-3 rounded-lg border border-gb-bgLight2 flex items-center gap-3 transition-all duration-300 shadow-inner w-full max-w-full';
        thinkingContainer.innerHTML = `<i data-lucide="cpu" class="w-4 h-4 animate-pulse text-gb-aquaAccent shrink-0"></i><span class="truncate overflow-hidden opacity-80" id="thinking-text-${index}"></span>`;
        inner.appendChild(thinkingContainer);
    }

    if (isError) {
        content.className = 'whitespace-pre-wrap font-mono text-sm text-gb-fgLight break-words leading-relaxed';
        content.textContent = msg.content;
    } else if (isUser) {
        const parsed = parseCombineCopyPrompt(msg.content);
        if (parsed.isStructured) {
            renderStructuredUserMessage(content, parsed);
        } else {
            renderPlainUserMessage(content, msg);
        }
    } else {
        renderAssistantMessage(content, msg, index, inner);
    }

    header.appendChild(createMessageActions(msg, index, isUser, isError, content));
    inner.appendChild(header);
    inner.appendChild(content);

    const footer = document.createElement('div');
    footer.className = 'flex justify-end pt-3 mt-2 border-t border-gb-bgLight2';
    footer.appendChild(createMessageActions(msg, index, isUser, isError, content));
    inner.appendChild(footer);

    div.appendChild(inner);
    return div;
}
