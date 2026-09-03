import { store, getActiveConversation } from './storage.js';
import { countTokens, updateTokenCount } from './tokens.js';
import { rebuildMessageContent } from './pruneManual.js';
import { openPruneDrawer } from './pruneDrawer.js';
import { createModelAvatar, deriveShortName } from './avatar.js';
import { migrateLegacyThinking, escapeThinkingTags, getInlineTags } from './reasoning.js';
import { parseCombineCopyPrompt } from './promptParser.js';
import { saveHistory } from './sidebar.js';
import { renderChat } from './chat.js';
import { createActionBar, copyTextToClipboard } from './messageActions.js';
import { extractAllExecutionPayloads, stripExecutionBlocks } from './execution.js';
import { extractAllPrunePayloads } from './prune.js';
import { enhanceCodeBlocks } from './codeblock.js';

export { copyTextToClipboard } from './messageActions.js';

const LATEX_SYMBOL_MAP = [
    { pattern: /\\(?:rightarrow|to)\b/g, replacement: '→' },
    { pattern: /\\(?:leftarrow|gets)\b/g, replacement: '←' },
    { pattern: /\\(?:Rightarrow|implies)\b/g, replacement: '⇒' },
    { pattern: /\\Leftarrow\b/g, replacement: '⇐' },
    { pattern: /\\(?:leftrightarrow|iff)\b/g, replacement: '↔' },
    { pattern: /\\Leftrightarrow\b/g, replacement: '⇔' },
    { pattern: /\\uparrow\b/g, replacement: '↑' },
    { pattern: /\\downarrow\b/g, replacement: '↓' },
    { pattern: /\\mapsto\b/g, replacement: '↦' },
    { pattern: /\\(?:le|leq)\b/g, replacement: '≤' },
    { pattern: /\\(?:ge|geq)\b/g, replacement: '≥' },
    { pattern: /\\(?:neq|ne)\b/g, replacement: '≠' },
    { pattern: /\\approx\b/g, replacement: '≈' },
    { pattern: /\\pm\b/g, replacement: '±' },
    { pattern: /\\times\b/g, replacement: '×' },
    { pattern: /\\cdot\b/g, replacement: '·' },
    { pattern: /\\(?:dots|cdots|ldots)\b/g, replacement: '…' },
    { pattern: /\\in\b/g, replacement: '∈' },
    { pattern: /\\notin\b/g, replacement: '∉' },
    { pattern: /\\subset\b/g, replacement: '⊂' },
    { pattern: /\\subseteq\b/g, replacement: '⊆' },
    { pattern: /\\forall\b/g, replacement: '∀' },
    { pattern: /\\exists\b/g, replacement: '∃' },
    { pattern: /\\infty\b/g, replacement: '∞' }
];

/**
 * Replaces LaTeX math arrows and common relation symbols (e.g. $\rightarrow$, \rightarrow)
 * while protecting code fences and inline backtick code.
 */
export function replaceLatexSymbols(text) {
    if (typeof text !== 'string' || !text) return '';

    // Split text into code blocks/spans and prose segments
    const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

    for (let i = 0; i < parts.length; i += 2) {
        let seg = parts[i];
        if (!seg) continue;

        // 1. Unwrap inline math blocks like `$\rightarrow$` or `$$ \to $$`
        seg = seg.replace(/\$\$?([\s\S]*?)\$\$/g, (match, inner) => {
            let transformed = inner;
            for (const sym of LATEX_SYMBOL_MAP) {
                transformed = transformed.replace(sym.pattern, sym.replacement);
            }
            return transformed.trim();
        });

        // 2. Replace standalone LaTeX commands in prose text
        for (const sym of LATEX_SYMBOL_MAP) {
            seg = seg.replace(sym.pattern, sym.replacement);
        }

        parts[i] = seg;
    }

    return parts.join('');
}

/**
 * `options.enhanceCode` defaults to true. Streaming call sites pass false: the
 * chrome would be torn down and rebuilt on every delta, and the copy target is
 * not final until the fence actually closes.
 */
export function formatMarkdown(text, options) {
    const withSymbols = replaceLatexSymbols(text || '');
    // Thinking tags reaching this point survived extraction, so they are text.
    // DOMPurify would otherwise drop the element and keep only its contents.
    const preprocessed = escapeThinkingTags(withSymbols, getInlineTags());
    const cleanHtml = DOMPurify.sanitize(marked.parse(preprocessed));
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

            let alertBgClass = 'bg-gb-bgDarkest border-gb-fgDark text-gb-fgLight';
            let iconSvg = '';
            let titleColor = 'text-gb-fgLight';

            switch(type) {
                case 'NOTE':
                    alertBgClass = 'bg-gb-blueAccent/15 border-l-4 border-l-gb-blueAccent border border-gb-blueAccent/30 text-gb-fgLight';
                    titleColor = 'text-gb-blueAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>`;
                    break;
                case 'TIP':
                    alertBgClass = 'bg-gb-greenAccent/15 border-l-4 border-l-gb-greenAccent border border-gb-greenAccent/30 text-gb-fgLight';
                    titleColor = 'text-gb-greenAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"></path><path d="M9 18h6"></path><path d="M10 22h4"></path></svg>`;
                    break;
                case 'IMPORTANT':
                    alertBgClass = 'bg-gb-purpleAccent/15 border-l-4 border-l-gb-purpleAccent border border-gb-purpleAccent/30 text-gb-fgLight';
                    titleColor = 'text-gb-purpleAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
                    break;
                case 'WARNING':
                    alertBgClass = 'bg-gb-redAccent/15 border-l-4 border-l-gb-redAccent border border-gb-redAccent/30 text-gb-fgLight';
                    titleColor = 'text-gb-redAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>`;
                    break;
                case 'CAUTION':
                    alertBgClass = 'bg-gb-red/20 border-l-4 border-l-gb-red border border-gb-red/40 text-gb-fgLight';
                    titleColor = 'text-gb-redAccent';
                    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
                    break;
            }
            alertDiv.className = `not-prose github-alert my-4 p-4 rounded-lg shadow-sm ${alertBgClass}`;

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

    if (!options || options.enhanceCode !== false) {
        enhanceCodeBlocks(doc);
    }

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
            fHeader.className = 'flex items-center justify-between gap-2';

            const iconHtml = f.isPruned
                ? '<i data-lucide="scissors" class="w-3.5 h-3.5 text-gb-redAccent shrink-0"></i>'
                : '<i data-lucide="file-code" class="w-3.5 h-3.5 text-gb-aquaAccent shrink-0"></i>';
            const titleClass = f.isPruned ? 'line-through text-gb-fgDark' : 'text-gb-fgLight';
            const tokens = f.tokenCount !== undefined ? f.tokenCount : countTokens(f.content || '');

            fHeader.innerHTML = `<div class="flex items-center gap-2 min-w-0">${iconHtml} <span class="${titleClass} truncate path-label"></span></div><span class="text-[10px] text-gb-fgDark shrink-0">~${tokens.toLocaleString()} tok</span>`;
            fHeader.querySelector('.path-label').textContent = f.path;
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

function renderStructuredUserMessage(content, parsed, index) {
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
        let totalFileTokens = 0;
        parsed.files.forEach(f => {
            f.tokenCount = countTokens(f.content || '');
            totalFileTokens += f.tokenCount;
        });

        const prunedCount = parsed.files.filter(f => f.isPruned).length;
        const partialCount = parsed.files.filter(f => f.isPartial && !f.isPruned).length;
        const subtitleParts = [];
        if (prunedCount > 0) subtitleParts.push(`${prunedCount} pruned`);
        if (partialCount > 0) subtitleParts.push(`${partialCount} partial`);
        subtitleParts.push(`~${totalFileTokens.toLocaleString()} tok`);
        
        const subtitle = subtitleParts.join(' \u00b7 ');
        content.appendChild(createAccordion(
            `${parsed.files.length} Files Provided`,
            'folder-open',
            subtitle,
            buildFilesBody(parsed.files)
        ));

        // Sibling rather than a child of the accordion head, which is itself a
        // <button> and cannot legally nest one.
        const manageRow = document.createElement('div');
        manageRow.className = 'flex justify-end';

        const manageBtn = document.createElement('button');
        manageBtn.className = 'text-xs font-bold text-gb-fgDark hover:text-gb-aquaAccent flex items-center gap-1.5 px-2 py-1 rounded hover:bg-gb-bgLight1 transition-colors';
        manageBtn.innerHTML = '<i data-lucide="scissors" class="w-3.5 h-3.5"></i> Manage files';
        manageBtn.title = 'Open the pruning drawer scoped to this message';
        manageBtn.onclick = () => openPruneDrawer(index);

        manageRow.appendChild(manageBtn);
        content.appendChild(manageRow);
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

    // Flips only the model's set. Rebuilding from the baseline re-applies any
    // files the user pruned by hand, so this toggle no longer discards them.
    indices.forEach(idx => {
        if (idx < 0 || idx >= active.messages.length) return;
        const targetUserMsg = active.messages[idx];
        if (!targetUserMsg) return;
        targetUserMsg.modelPruneActive = msg.pruneInfo.isPruned === true;
        rebuildMessageContent(targetUserMsg);
    });
}

function renderAssistantMessage(content, msg) {
    if (!msg.content) {
        content.className = 'flex items-center gap-2 text-gb-aquaAccent font-semibold animate-pulse py-2';
        content.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i><span>Thinking...</span>';
        return;
    }

    content.className = 'prose prose-invert prose-gruvbox max-w-none text-sm break-words leading-relaxed flex flex-col gap-3';
    content.innerHTML = '';

    const displayContent = msg.content;
    const execInfo = msg.executionInfo;
    const pruneInfo = msg.pruneInfo;

    const execPayloads = (execInfo && !execInfo.parseFailed) ? extractAllExecutionPayloads(displayContent) : [];
    const prunePayloads = extractAllPrunePayloads(displayContent);

    // Merge both execution and prune payload blocks in chronological document order
    const regions = [];
    const execItems = (execInfo && Array.isArray(execInfo.items) && execInfo.items.length > 0) ? execInfo.items : [execInfo];
    execPayloads.forEach((p, idx) => {
        regions.push({
            type: 'exec',
            start: p.start,
            end: p.end,
            payload: p,
            item: execItems[idx] || p
        });
    });

    const pruneItems = (pruneInfo && Array.isArray(pruneInfo.items) && pruneInfo.items.length > 0) ? pruneInfo.items : [];
    prunePayloads.forEach((p, idx) => {
        regions.push({
            type: 'prune',
            start: p.start,
            end: p.end,
            payload: p,
            item: pruneItems[idx] || p
        });
    });

    regions.sort((a, b) => a.start - b.start);

    if (regions.length === 0) {
        const blockDiv = document.createElement('div');
        blockDiv.innerHTML = formatMarkdown(displayContent);
        content.appendChild(blockDiv);

        if (execInfo && execInfo.parseFailed) {
            content.appendChild(createExecutionCard(execInfo, ''));
        }
        if (pruneInfo && !pruneInfo.items) {
            // Legacy fallback if pruneInfo exists without items
            content.appendChild(createPruneCard(null, msg, ''));
        }
        return;
    }

    let cursor = 0;
    regions.forEach(region => {
        const beforeChunk = displayContent.slice(cursor, region.start).trim();
        if (beforeChunk) {
            const beforeDiv = document.createElement('div');
            beforeDiv.innerHTML = formatMarkdown(beforeChunk);
            content.appendChild(beforeDiv);
        }

        if (region.type === 'exec') {
            const p = region.payload;
            const item = region.item;
            const payloadMd = (p.data && typeof p.data.markdown === 'string' && p.data.markdown.trim())
                ? p.data.markdown.trim()
                : (item && item.markdown ? item.markdown.trim() : '');
            if (payloadMd) {
                const mdDiv = document.createElement('div');
                mdDiv.innerHTML = formatMarkdown(payloadMd);
                content.appendChild(mdDiv);
            }
            content.appendChild(createExecutionCard(item, p.fullBlock || p.raw));
        } else if (region.type === 'prune') {
            content.appendChild(createPruneCard(region.item, msg, region.payload.fullBlock || region.payload.raw));
        }

        cursor = region.end;
    });

    const afterChunk = displayContent.slice(cursor).trim();
    if (afterChunk) {
        const afterDiv = document.createElement('div');
        afterDiv.innerHTML = formatMarkdown(afterChunk);
        content.appendChild(afterDiv);
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
/**
 * Compact card for a detected PRUNE payload matching the layout of the Execution card,
 * showing individual dropped files, reason, token savings, and context toggle.
 */
function createPruneCard(item, msg, fallbackRaw) {
    const card = document.createElement('div');
    card.className = 'mt-2 mb-2 bg-gb-bgDarkest border border-gb-bgLight2 rounded-lg overflow-hidden shadow-sm not-prose';

    const pruneInfo = msg.pruneInfo || {};
    const isPruned = pruneInfo.isPruned !== false;
    const dropped = (item && Array.isArray(item.dropped)) ? item.dropped : [];
    const kept = (item && Array.isArray(item.kept)) ? item.kept : [];

    const totalSaved = (item && typeof item.tokensSaved === 'number' && item.tokensSaved > 0)
        ? item.tokensSaved
        : (pruneInfo.tokensSaved || 0);

    const header = document.createElement('div');
    header.className = 'p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gb-bgLight2';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'flex items-center gap-3 min-w-0';
    const droppedCount = dropped.length;
    const titleText = `Context Pruned &middot; ${droppedCount} file${droppedCount === 1 ? '' : 's'}`;
    const savedHtml = totalSaved > 0
        ? `<span class="exec-stat-del">-${totalSaved.toLocaleString()} tok</span>`
        : '<span class="text-gb-fgDark">pruned</span>';

    infoDiv.innerHTML = `<div class="p-2 bg-gb-bgLight1 rounded-md border border-gb-bgLight3 shrink-0"><i data-lucide="scissors" class="w-5 h-5 text-gb-aquaAccent"></i></div><div class="flex flex-col min-w-0"><span class="text-sm font-bold text-gb-fgLightest">${titleText}</span><span class="text-xs font-mono">${savedHtml}</span></div>`;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex items-center gap-2 shrink-0';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = `px-3 py-1.5 rounded font-bold text-xs transition-all duration-300 shadow-md hover:scale-[1.02] active:scale-95 flex items-center gap-1.5 ${isPruned ? 'bg-gb-bgLight2 hover:bg-gb-bgLight3 text-gb-fgLight border border-gb-bgLight3' : 'bg-gb-blue hover:bg-gb-blueAccent text-gb-bgDarkest'}`;
    toggleBtn.innerHTML = isPruned
        ? '<i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i> Re-add Files'
        : '<i data-lucide="scissors" class="w-3.5 h-3.5"></i> Prune Files';

    toggleBtn.onclick = () => {
        pruneInfo.isPruned = !isPruned;
        togglePrunedMessages(msg);
        saveHistory();
        renderChat(true);
        updateTokenCount();
    };
    actionsDiv.appendChild(toggleBtn);

    header.appendChild(infoDiv);
    header.appendChild(actionsDiv);
    card.appendChild(header);

    if (dropped.length > 0) {
        const list = document.createElement('div');
        list.className = 'flex flex-col divide-y divide-gb-bgLight2';

        dropped.forEach(f => {
            const row = document.createElement('div');
            row.className = 'exec-file-row flex flex-col gap-1 px-4 py-2.5 text-xs font-mono';

            const top = document.createElement('div');
            top.className = 'flex items-center justify-between gap-2 min-w-0';

            const left = document.createElement('div');
            left.className = 'flex items-center gap-2 min-w-0';
            left.innerHTML = '<i data-lucide="file-x" class="w-3.5 h-3.5 shrink-0 text-gb-redAccent"></i><span class="truncate text-gb-fgLight font-semibold path-span"></span>';
            left.querySelector('.path-span').textContent = f.path;
            top.appendChild(left);

            if (typeof f.tokens === 'number' && f.tokens > 0) {
                const right = document.createElement('div');
                right.className = 'shrink-0';
                right.innerHTML = `<span class="exec-stat-del">-${f.tokens.toLocaleString()} tok</span>`;
                top.appendChild(right);
            }
            row.appendChild(top);

            if (f.reason) {
                const reasonDiv = document.createElement('div');
                reasonDiv.className = 'text-[11px] text-gb-fgDark italic pl-5.5 whitespace-normal break-words';
                reasonDiv.textContent = f.reason;
                row.appendChild(reasonDiv);
            }

            list.appendChild(row);
        });
        card.appendChild(list);
    }

    if (kept.length > 0) {
        const keptSection = document.createElement('div');
        keptSection.className = 'border-t border-gb-bgLight2 bg-[#1d2021] text-xs';
        keptSection.innerHTML = `
            <button class="w-full flex justify-between items-center px-4 py-2 text-gb-fgDark hover:text-gb-fgMedium font-semibold transition-colors">
                <span>${kept.length} file${kept.length === 1 ? '' : 's'} kept in context</span>
                <i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>
            </button>
            <div class="px-4 pb-3 flex flex-col gap-1 hidden font-mono text-[11px] text-gb-fgDark border-t border-gb-bgLight2 pt-2">
                ${kept.map(k => `<div class="flex items-center gap-2"><i data-lucide="file-check" class="w-3 h-3 text-gb-greenAccent shrink-0"></i><span class="truncate">${k.path}</span></div>`).join('')}
            </div>
        `;
        const btn = keptSection.querySelector('button');
        const drawer = keptSection.querySelector('div');
        btn.onclick = () => {
            drawer.classList.toggle('hidden');
            const icon = btn.querySelector('i');
            if (icon) icon.classList.toggle('rotate-180');
        };
        card.appendChild(keptSection);
    }

    return card;
}

function createExecutionCard(itemOrMsg, fallbackRaw) {
    const info = (itemOrMsg && itemOrMsg.executionInfo) ? itemOrMsg.executionInfo : itemOrMsg;
    const card = document.createElement('div');
    card.className = 'mt-2 mb-2 bg-gb-bgDarkest border border-gb-bgLight2 rounded-lg overflow-hidden shadow-sm not-prose';

    if (!info || info.parseFailed) {
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
    const files = Array.isArray(info.files) ? info.files : [];
    const fileCount = files.length;
    const totals = info.totals || { known: false, added: 0, removed: 0 };
    const totalsHtml = totals.known
        ? `<span class="exec-stat-add">+${totals.added.toLocaleString()}</span> <span class="exec-stat-del">-${totals.removed.toLocaleString()}</span>`
        : '<span class="text-gb-fgDark">\u2014</span>';
    infoDiv.innerHTML = `<div class="p-2 bg-gb-bgLight1 rounded-md border border-gb-bgLight3 shrink-0"><i data-lucide="file-diff" class="w-5 h-5 text-gb-aquaAccent"></i></div><div class="flex flex-col min-w-0"><span class="text-sm font-bold text-gb-fgLightest">Execution Payload &middot; ${fileCount} file${fileCount === 1 ? '' : 's'}</span><span class="text-xs font-mono">${totalsHtml}</span></div>`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'h-8 px-3 shrink-0 text-gb-fgDark hover:text-gb-fgLightest rounded-xl hover:bg-gb-bgLight1 transition-all duration-200 active:scale-95 flex items-center justify-center gap-2 text-xs font-bold';
    copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i> <span>Copy Payload</span>';
    const rawToCopy = info.fullBlock || info.raw || fallbackRaw || (itemOrMsg && itemOrMsg.content) || '';
    copyBtn.onclick = async () => {
        const success = await copyTextToClipboard(rawToCopy);
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
    div.id = `msg-wrap-${index}`;
    div.dataset.role = isUser ? 'user' : 'assistant';
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

            const modelObj = Array.isArray(store.allModels) ? store.allModels.find(m => m && (m.id === msg.model || m.raw_id === msg.model)) : null;
            let epName = (modelObj && modelObj.endpoint_name) ? modelObj.endpoint_name : null;
            if (!epName && msg.model) {
                const epMatch = msg.model.match(/\(([^)]+)\)$/);
                if (epMatch) epName = epMatch[1];
            }
            if (epName) {
                const epBadge = document.createElement('span');
                epBadge.className = 'text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-gb-bgLight2 text-gb-aquaAccent border border-gb-bgLight3 shrink-0 ml-1 flex items-center gap-1';
                epBadge.innerHTML = `<i data-lucide="server" class="w-2.5 h-2.5"></i><span>${epName}</span>`;
                epBadge.title = `Hosted by ${epName}`;
                roleDiv.appendChild(epBadge);
            }
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
            renderStructuredUserMessage(content, parsed, index);
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
