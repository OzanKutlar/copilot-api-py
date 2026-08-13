import { store, getActiveConversation } from './storage.js';
import { countTokens, updateTokenCount } from './tokens.js';
import { createModelAvatar, deriveShortName } from './avatar.js';
import { migrateLegacyThinking } from './reasoning.js';
import { parseCombineCopyPrompt } from './promptParser.js';
import { saveHistory } from './sidebar.js';
import { renderChat } from './chat.js';
import { createActionBar, copyTextToClipboard } from './messageActions.js';
import { extractExecutionPayload, stripExecutionBlocks } from './execution.js';

export { copyTextToClipboard } from './messageActions.js';

export function formatMarkdown(text) {
    const cleanHtml = DOMPurify.sanitize(marked.parse(text || ''));
    const parser = new DOMParser();
    const doc = parser.parseFromString(cleanHtml, 'text/html');

    const blockquotes = doc.querySelectorAll('blockquote');
    blockquotes.forEach(bq => {
        const firstP = bq.querySelector('p:first-child');
        if (!firstP) return;

        const match = firstP.innerHTML.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br>|\n)?([\s\S]*)$/i);
        if (match) {
            const type = match[1].toUpperCase();
            const restOfP = match[2];

            const alertDiv = doc.createElement('div');
            alertDiv.className = `not-prose github-alert my-4 p-4 border-l-4 rounded bg-gb-bgDarkest shadow-sm`;

            let borderColor = 'border-gb-fgDark';
            let iconSvg = '';
            let titleColor = 'text-gb-fgLight';

            switch(type) {
                case 'NOTE':
                    borderColor = 'border-gb-blueAccent';
                    titleColor = 'text-gb-blueAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>`;
                    break;
                case 'TIP':
                    borderColor = 'border-gb-greenAccent';
                    titleColor = 'text-gb-greenAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"></path><path d="M9 18h6"></path><path d="M10 22h4"></path></svg>`;
                    break;
                case 'IMPORTANT':
                    borderColor = 'border-gb-purpleAccent';
                    titleColor = 'text-gb-purpleAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
                    break;
                case 'WARNING':
                    borderColor = 'border-gb-redAccent';
                    titleColor = 'text-gb-redAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>`;
                    break;
                case 'CAUTION':
                    borderColor = 'border-gb-red';
                    titleColor = 'text-gb-red';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
                    break;
            }
            alertDiv.classList.add(borderColor);

            const titleDiv = doc.createElement('div');
            titleDiv.className = `flex items-center gap-2 font-bold mb-2 ${titleColor} text-sm uppercase tracking-wide`;
            titleDiv.innerHTML = `${iconSvg}<span>${type}</span>`;

            const contentDiv = doc.createElement('div');
            contentDiv.className = 'text-sm text-gb-fgLight prose prose-invert prose-gruvbox max-w-none';

            firstP.innerHTML = restOfP;
            while(bq.firstChild) {
                contentDiv.appendChild(bq.firstChild);
            }

            if (!restOfP.trim() && contentDiv.firstChild === firstP && !firstP.childNodes.length) {
                firstP.remove();
            }

            alertDiv.appendChild(titleDiv);
            alertDiv.appendChild(contentDiv);

            bq.parentNode.replaceChild(alertDiv, bq);
        }
    });

    return doc.body.innerHTML;
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

            if (f.isPartial && !f.isPruned) {
                const badge = document.createElement('span');
                badge.className = 'file-partial-badge mt-1';
                badge.textContent = 'PARTIAL';
                fItem.appendChild(badge);
            }

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
        const partialCount = parsed.files.filter(f => f.isPartial && !f.isPruned).length;
        const subtitleParts = [];
        if (prunedCount > 0) subtitleParts.push(`${prunedCount} pruned`);
        if (partialCount > 0) subtitleParts.push(`${partialCount} partial`);
        const subtitle = subtitleParts.join(' \u00b7 ');
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

/**
 * Plain (non-combineCopy) text. Anything over ~1000 tokens collapses behind a
 * Show/Hide toggle so a pasted wall of text does not dominate the thread.
 */
function renderPlainUserMessage(content, msg) {
    content.className = 'w-full flex flex-col gap-2';
    const textDiv = document.createElement('div');
    textDiv.className = 'whitespace-pre-wrap font-mono text-sm text-gb-fgLight break-words leading-relaxed';

    const tokens = countTokens(msg.content);
    if (tokens > 1000) {
        textDiv.innerHTML = `
        <div class="flex flex-col gap-2">
            <div class="italic text-gb-fgDark flex items-center justify-between bg-gb-bgDarkest p-3 rounded border border-gb-bgLight2">
                <div class="flex items-center gap-2"><i data-lucide="file-text" class="w-4 h-4"></i> Long message : ${tokens.toLocaleString()} Tokens</div>
                <button class="text-gb-blueAccent hover:text-gb-fgLightest text-xs font-bold uppercase hover:underline btn-toggle-long">Show</button>
            </div>
            <div class="hidden long-text-content whitespace-pre-wrap"></div>
        </div>`;

        const toggleBtn = textDiv.querySelector('.btn-toggle-long');
        const contentContainer = textDiv.querySelector('.long-text-content');
        contentContainer.textContent = msg.content;
        toggleBtn.onclick = () => {
            const hidden = contentContainer.classList.contains('hidden');
            contentContainer.classList.toggle('hidden', !hidden);
            toggleBtn.textContent = hidden ? 'Hide' : 'Show';
        };
    } else {
        textDiv.textContent = msg.content;
    }
    content.appendChild(textDiv);
}

/**
 * Restores or re-applies pruning across every user message the payload touched.
 * `targetIndices` is the current shape; `userMsgIndex` is the legacy single-
 * message field kept so older persisted threads still toggle correctly.
 */
function togglePrunedMessages(msg) {
    const active = getActiveConversation();
    if (!active) return;

    const indices = Array.isArray(msg.pruneInfo.targetIndices)
        ? msg.pruneInfo.targetIndices
        : (msg.pruneInfo.userMsgIndex > -1 ? [msg.pruneInfo.userMsgIndex] : []);

    indices.forEach(idx => {
        if (idx < 0 || idx >= active.messages.length) return;
        const targetUserMsg = active.messages[idx];
        targetUserMsg.content = msg.pruneInfo.isPruned
            ? (targetUserMsg.prunedContent || targetUserMsg.content)
            : (targetUserMsg.originalContent || targetUserMsg.content);
    });
}

function renderAssistantMessage(content, msg) {
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

    if (msg.executionInfo && !msg.executionInfo.parseFailed) {
        const extracted = extractExecutionPayload(displayContent);
        if (extracted) {
            const md = extracted.data && extracted.data.markdown;
            displayContent = (typeof md === 'string' && md.trim())
                ? md
                : stripExecutionBlocks(displayContent, extracted.raw);
        }
    }

    content.innerHTML = formatMarkdown(displayContent);

    if (msg.pruneInfo) {
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
            togglePrunedMessages(msg);
            saveHistory();
            renderChat(true);
            updateTokenCount();
        };

        pruneCard.appendChild(infoDiv);
        pruneCard.appendChild(toggleBtn);
        content.appendChild(pruneCard);
    }

    if (msg.executionInfo) {
        content.appendChild(createExecutionCard(msg));
    }
}

function actionIconFor(action) {
    switch (action) {
        case 'create': return 'file-plus';
        case 'delete': return 'file-x';
        case 'command': return 'terminal';
        default: return 'file-diff';
    }
}

function formatCount(value, approx, sign) {
    if (value === null || value === undefined) return '\u2014';
    return (approx ? '~' : '') + sign + value.toLocaleString();
}

/**
 * Compact card for a detected EXECUTION payload: total file count and
 * aggregate +/- line counts, the commit message, a per-file breakdown, and a
 * copy button that yields the exact original payload (msg.content is never
 * mutated, only the displayed copy is stripped).
 */
function createExecutionCard(msg) {
    const info = msg.executionInfo;
    const card = document.createElement('div');
    card.className = 'mt-4 bg-gb-bgDarkest border border-gb-bgLight2 rounded-lg overflow-hidden shadow-sm not-prose';

    if (info.parseFailed) {
        card.classList.add('border-gb-redAccent/40');
        const warn = document.createElement('div');
        warn.className = 'p-3 flex items-center gap-2 text-sm text-gb-fgLight';
        warn.innerHTML = '<i data-lucide="alert-triangle" class="w-4 h-4 text-gb-redAccent shrink-0"></i> <span>Execution payload detected but could not be parsed.</span>';
        card.appendChild(warn);
        return card;
    }

    const header = document.createElement('div');
    header.className = 'p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gb-bgLight2';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'flex items-center gap-3 min-w-0';
    const fileCount = info.files.length;
    const totalsHtml = info.totals.known
        ? `<span class="exec-stat-add">+${info.totals.added.toLocaleString()}</span> <span class="exec-stat-del">-${info.totals.removed.toLocaleString()}</span>`
        : '<span class="text-gb-fgDark">\u2014</span>';
    infoDiv.innerHTML = `<div class="p-2 bg-gb-bgLight1 rounded-md border border-gb-bgLight3 shrink-0"><i data-lucide="file-diff" class="w-5 h-5 text-gb-aquaAccent"></i></div><div class="flex flex-col min-w-0"><span class="text-sm font-bold text-gb-fgLightest">Execution Payload &middot; ${fileCount} file${fileCount === 1 ? '' : 's'}</span><span class="text-xs font-mono">${totalsHtml}</span></div>`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'h-8 px-3 shrink-0 text-gb-fgDark hover:text-gb-fgLightest rounded-xl hover:bg-gb-bgLight1 transition-all duration-200 active:scale-95 flex items-center justify-center gap-2 text-xs font-bold';
    copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i> <span>Copy Payload</span>';
    copyBtn.onclick = async () => {
        const success = await copyTextToClipboard(msg.content);
        if (!success) return;
        copyBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4 text-gb-greenAccent"></i> <span class="text-gb-greenAccent">Copied</span>';
        lucide.createIcons();
        setTimeout(() => {
            if (!copyBtn.isConnected) return;
            copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i> <span>Copy Payload</span>';
            lucide.createIcons();
        }, 2000);
    };

    header.appendChild(infoDiv);
    header.appendChild(copyBtn);
    card.appendChild(header);

    if (info.commitMessage) {
        const commitRow = document.createElement('div');
        commitRow.className = 'px-4 py-2 text-xs font-mono text-gb-fgDark border-b border-gb-bgLight2 whitespace-pre-wrap break-words';
        commitRow.textContent = info.commitMessage;
        card.appendChild(commitRow);
    }

    const list = document.createElement('div');
    list.className = 'flex flex-col divide-y divide-gb-bgLight2';
    info.files.forEach(f => {
        const row = document.createElement('div');
        row.className = 'exec-file-row flex items-center justify-between gap-3 px-4 py-2 text-xs font-mono';

        const left = document.createElement('div');
        left.className = 'flex items-center gap-2 min-w-0';
        const actionColor = f.action === 'create' ? 'text-gb-greenAccent'
            : f.action === 'delete' ? 'text-gb-redAccent'
            : f.action === 'command' ? 'text-gb-purpleAccent'
            : 'text-gb-blueAccent';
        left.innerHTML = `<i data-lucide="${actionIconFor(f.action)}" class="w-3.5 h-3.5 shrink-0 ${actionColor}"></i> <span class="truncate text-gb-fgLight"></span>`;
        left.querySelector('span').textContent = f.action === 'command' ? f.command : f.path;

        const right = document.createElement('div');
        right.className = 'shrink-0 flex items-center gap-2';
        if (f.action !== 'command') {
            const addText = formatCount(f.added, f.approx, '+');
            const delText = formatCount(f.removed, f.approx, '-');
            right.innerHTML = `<span class="exec-stat-add">${addText}</span><span class="exec-stat-del">${delText}</span>`;
        }

        row.appendChild(left);
        row.appendChild(right);
        list.appendChild(row);
    });
    card.appendChild(list);

    return card;
}

/**
 * Collapsible thinking trace. Body is plain text rather than markdown, so
 * even a very large trace costs nothing beyond a text node.
 */
function createThinkingPanel(msg, index) {
    const prefs = store.thinkingPrefs || {};
    const trace = (typeof msg.reasoning === 'string' ? msg.reasoning : '').trim();

    const panel = document.createElement('div');
    panel.id = `thinking-panel-${index}`;
    panel.className = 'mb-3 border border-gb-bgLight2 rounded-lg bg-gb-bgDarkest overflow-hidden';
    if (!trace || prefs.show === false) panel.classList.add('hidden');

    const head = document.createElement('button');
    head.className = 'w-full flex justify-between items-center gap-3 p-2.5 bg-gb-bgLight1 hover:bg-gb-bgLight2 transition-colors text-xs font-bold text-gb-fgMedium';
    head.innerHTML = `<div class="flex items-center gap-2 shrink-0"><i data-lucide="brain" class="w-4 h-4 text-gb-aquaAccent"></i><span>Thinking</span><span id="thinking-meta-${index}" class="font-mono font-normal text-gb-fgDark"></span></div><span id="thinking-preview-${index}" class="flex-1 truncate text-left font-normal font-mono text-gb-fgDark opacity-70"></span><i data-lucide="chevron-down" class="w-4 h-4 shrink-0 transition-transform duration-300 thinking-chevron"></i>`;

    // Same prose treatment as the assistant's answer body, so traces are read
    // at the same size and with the same formatting rather than as a dump.
    const body = document.createElement('div');
    body.id = `thinking-body-${index}`;
    body.className = 'thinking-body prose prose-invert prose-gruvbox max-w-none text-sm break-words leading-relaxed hidden';

    if (trace) {
        const meta = head.querySelector(`#thinking-meta-${index}`);
        if (meta) meta.textContent = `~${countTokens(trace).toLocaleString()} tok`;
        const preview = head.querySelector(`#thinking-preview-${index}`);
        if (preview) preview.textContent = trace.replace(/\s+/g, ' ').slice(0, 160);
    }

    const expanded = msg.reasoningExpanded === true
        || (msg.reasoningExpanded === undefined && prefs.autoExpand === true);
    if (expanded && trace) {
        // Formatting is deferred until the panel is actually open: parsing a
        // large trace on every render (or every stream delta) is wasted work
        // while it is collapsed.
        body.innerHTML = formatMarkdown(trace);
        body.classList.remove('hidden');
        const chevron = head.querySelector('.thinking-chevron');
        if (chevron) chevron.classList.add('rotate-180');
    }

    head.onclick = () => {
        const willExpand = body.classList.contains('hidden');
        if (willExpand) {
            body.innerHTML = formatMarkdown(msg.reasoning || '');
        }
        body.classList.toggle('hidden', !willExpand);
        msg.reasoningExpanded = willExpand;
        const chevron = head.querySelector('.thinking-chevron');
        if (chevron) chevron.classList.toggle('rotate-180', willExpand);
    };

    panel.appendChild(head);
    panel.appendChild(body);
    return panel;
}

export function createMessageElement(msg, index) {
    const isUser = msg.role === 'user';
    const isError = msg.isError === true;

    // Lifts inline <think> blocks out of threads saved before traces existed.
    if (!isUser && !isError) migrateLegacyThinking(msg);

    const div = document.createElement('div');
    div.className = `flex w-full ${isUser ? 'justify-end' : 'justify-start'} mb-6 animate-fade-in-up`;

    let bgClass = isUser ? 'bg-gb-bgLight1 border-gb-bgLight3' : 'bg-gb-bg border-gb-bgLight2';
    if (isError) bgClass = 'bg-[#321c1a] border-gb-redAccent';

    const inner = document.createElement('div');
    // `group relative` anchors the sticky action pill and drives its hover reveal.
    inner.className = `group relative max-w-5xl w-full flex flex-col gap-3 p-5 rounded-lg border shadow-sm ${bgClass} transition-all duration-300 hover:shadow-md`;

    const header = document.createElement('div');
    header.className = 'flex justify-between items-center border-b pb-3 mb-1 border-gb-bgLight2 text-sm font-bold uppercase tracking-wide text-gb-fgMedium';

    const roleDiv = document.createElement('div');
    roleDiv.className = 'flex items-center gap-2';
    if (isError) {
        roleDiv.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5 text-gb-redAccent"></i> <span class="text-gb-redAccent">Error</span>';
    } else {
        if (isUser) {
            roleDiv.innerHTML = '<i data-lucide="user" class="w-5 h-5 text-gb-blueAccent"></i> <span>User Request</span>';
        } else {
            roleDiv.appendChild(createModelAvatar(msg.model));
            const label = document.createElement('span');
            label.className = 'truncate';
            label.textContent = msg.model ? deriveShortName(msg.model) : 'AI Output';
            label.title = msg.model || '';
            roleDiv.appendChild(label);
        }
    }
    header.appendChild(roleDiv);

    const content = document.createElement('div');
    content.id = `msg-content-${index}`;

    // The old transient badge is gone; createThinkingPanel below serves both
    // the live stream and the persisted trace.

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
        renderAssistantMessage(content, msg);
    }

    inner.appendChild(createActionBar(msg, index, isUser, isError, content));
    inner.appendChild(header);
    if (!isUser && !isError) {
        inner.appendChild(createThinkingPanel(msg, index));
    }
    inner.appendChild(content);

    div.appendChild(inner);
    return div;
}
