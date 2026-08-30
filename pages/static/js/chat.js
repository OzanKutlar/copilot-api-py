import { store, getActiveConversation } from './storage.js';
import { countTokens, applyActiveTokenLimit, updateTokenCount, learnModelTokenLimitFromError } from './tokens.js';
import { createMessageElement, formatMarkdown } from './message.js';
import { saveHistory } from './sidebar.js';
import { handlePrunePayload } from './prune.js';
import { handleExecutionPayload } from './execution.js';
import { fetchQuota, isStreamingModel } from './models.js';
import { extractReasoningDelta, splitInlineThinking, getInlineTags, buildReplayHistory } from './reasoning.js';
import { renderChatNav } from './chatNav.js';

export function updateHeaderTitle() {
    const active = getActiveConversation();
    const titleEl = document.getElementById('header-chat-title');
    const title = (active && active.title) ? active.title : 'New Chat';
    
    if (titleEl) {
        titleEl.textContent = title;
        titleEl.title = title;
    }
    document.title = `${title} - Copilot API`;
}

export function renderChat(preserveScroll = false) {
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;

    updateHeaderTitle();

    // Captured before the wipe so in-place edits do not yank the view downward.
    const oldScroll = chatContainer.scrollTop;
    chatContainer.innerHTML = '';

    const active = getActiveConversation();
    const history = active ? active.messages : [];

    if (history.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'flex flex-col items-center justify-center h-full text-gb-bgLight3 gap-4 mt-20 animate-fade-in-up';
        empty.innerHTML = '<i data-lucide="message-square-dashed" class="w-16 h-16 opacity-50"></i><p class="font-medium text-gb-fgDark">No chat history. Start a conversation below.</p>';
        chatContainer.appendChild(empty);
    } else {
        history.forEach((msg, i) => {
            chatContainer.appendChild(createMessageElement(msg, i));
        });
    }

    if (preserveScroll) {
        chatContainer.scrollTop = oldScroll;
    } else {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    renderChatNav();
    lucide.createIcons();
}

export async function handleSend() {
    const promptInput = document.getElementById('prompt-input');
    if (!promptInput) return;

    const text = promptInput.value.trim();
    if (!text) return;

    applyActiveTokenLimit();
    if (countTokens(text) > store.activeTokenLimit) return;

    const active = getActiveConversation();
    if (!active) return;

    active.messages.push({ role: 'user', content: text });
    promptInput.value = '';
    updateTokenCount();

    await triggerAPI();
}

function setProcessingUI(isProcessing) {
    const sendBtn = document.getElementById('send-btn');
    const continueBtn = document.getElementById('continue-btn');
    if (!sendBtn || !continueBtn) return;

    if (isProcessing) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i data-lucide="square" class="w-5 h-5 text-gb-bgDarkest fill-current"></i> Stop';
        sendBtn.classList.remove('bg-gb-blue', 'hover:bg-gb-blueAccent');
        sendBtn.classList.add('bg-gb-red', 'hover:bg-gb-redAccent');
        continueBtn.disabled = true;
        continueBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        sendBtn.classList.add('bg-gb-blue', 'hover:bg-gb-blueAccent');
        sendBtn.classList.remove('bg-gb-red', 'hover:bg-gb-redAccent');
        sendBtn.innerHTML = '<i data-lucide="send" class="w-5 h-5 text-gb-bgDarkest"></i> Send';
    }
    lucide.createIcons();
}

/**
 * Updates the thinking panel in place during streaming. Full re-renders would
 * collapse the panel and reset scroll on every delta.
 */
function updateThinkingPanel(index, traceText) {
    const panel = document.getElementById(`thinking-panel-${index}`);
    if (!panel) return;

    const trace = (traceText || '').trim();
    if (!trace) {
        panel.classList.add('hidden');
        return;
    }

    const prefs = store.thinkingPrefs || {};
    if (prefs.show !== false) panel.classList.remove('hidden');

    const body = document.getElementById(`thinking-body-${index}`);
    // Only pay for markdown parsing while the panel is actually open. A
    // collapsed panel renders from msg.reasoning when it is expanded.
    if (body && !body.classList.contains('hidden')) {
        const wasAtBottom = body.scrollHeight - body.clientHeight <= body.scrollTop + 40;
        // Code block chrome is skipped mid-stream; the post-stream renderChat()
        // in triggerAPI's finally block reformats with it enabled.
        body.innerHTML = formatMarkdown(trace, { enhanceCode: false });
        if (wasAtBottom) body.scrollTop = body.scrollHeight;
    }

    const meta = document.getElementById(`thinking-meta-${index}`);
    if (meta) meta.textContent = `~${countTokens(trace).toLocaleString()} tok`;

    const preview = document.getElementById(`thinking-preview-${index}`);
    if (preview) preview.textContent = trace.replace(/\s+/g, ' ').slice(-140);
}

/**
 * Reads an SSE response, painting content and thinking traces as deltas
 * arrive. Lifted out of triggerAPI unchanged so the non-streaming path can
 * share everything around it: error handling, abort, and the finally block.
 */
async function consumeStream(res, assistantMsg, assistantIndex, inlineTags, chatContainer) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const contentEl = document.getElementById(`msg-content-${assistantIndex}`);
    let buffer = '';
    let rawOutput = '';
    let combinedReasoning = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n');
        while (boundary !== -1) {
            const line = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 1);

            if (line.startsWith('data: ')) {
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') break;
                try {
                    const parsed = JSON.parse(dataStr);
                    const delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) || {};

                    let hasUpdate = false;

                    const reasoningDelta = extractReasoningDelta(delta);
                    if (reasoningDelta) {
                        combinedReasoning += reasoningDelta;
                        hasUpdate = true;
                    }
                    if (delta.content) {
                        rawOutput += delta.content;
                        hasUpdate = true;
                    }
                    if (!hasUpdate) {
                        boundary = buffer.indexOf('\n');
                        continue;
                    }

                    // Streaming mode lets a dangling open tag be treated as an
                    // in-progress thought. Reconciled once the stream drains.
                    const split = splitInlineThinking(rawOutput, combinedReasoning, inlineTags, { streaming: true });
                    const trace = split.extractedThink.trim();

                    if (trace !== assistantMsg.reasoning) {
                        assistantMsg.reasoning = trace;
                        updateThinkingPanel(assistantIndex, trace);
                    }

                    if (split.cleanContent !== assistantMsg.content && contentEl) {
                        if (!assistantMsg.content) {
                            contentEl.className = 'prose prose-invert prose-gruvbox max-w-none text-sm break-words leading-relaxed';
                            contentEl.innerHTML = '';
                        }
                        assistantMsg.content = split.cleanContent;
                        contentEl.innerHTML = formatMarkdown(assistantMsg.content || '', { enhanceCode: false });

                        if (chatContainer) {
                            const atBottom = chatContainer.scrollHeight - chatContainer.clientHeight <= chatContainer.scrollTop + 100;
                            if (atBottom) chatContainer.scrollTop = chatContainer.scrollHeight;
                        }
                    }
                } catch (e) {
                    // partial chunk, ignore
                }
            }
            boundary = buffer.indexOf('\n');
        }
    }

    // The stream is over, so an open tag that never closed was never a thought.
    // Re-parse strictly and hand that text back to the visible content, which
    // the render in triggerAPI's finally block then paints.
    const finalSplit = splitInlineThinking(rawOutput, combinedReasoning, inlineTags);
    assistantMsg.reasoning = finalSplit.extractedThink.trim();
    assistantMsg.content = finalSplit.cleanContent;
    updateThinkingPanel(assistantIndex, assistantMsg.reasoning);
}

/**
 * Reads a single non-streamed JSON response, used when the model's endpoint
 * has streaming turned off in Settings. Produces the same message shape as
 * consumeStream, in one step rather than many.
 */
async function consumeSingleResponse(res, assistantMsg, assistantIndex, inlineTags, chatContainer) {
    const data = await res.json();
    const choice = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
    const message = (choice && choice.message) ? choice.message : {};
    const rawOutput = typeof message.content === 'string' ? message.content : '';

    // Same extraction the stream uses: structured reasoning fields first, then
    // any inline <think> block lifted out of the visible content.
    const split = splitInlineThinking(rawOutput, extractReasoningDelta(message), inlineTags);
    const trace = split.extractedThink.trim();

    assistantMsg.reasoning = trace;
    updateThinkingPanel(assistantIndex, trace);
    assistantMsg.content = split.cleanContent;

    // triggerAPI's finally block re-renders regardless; this paint only stops
    // the reply flashing blank in the frame between landing and that render.
    const contentEl = document.getElementById(`msg-content-${assistantIndex}`);
    if (contentEl && assistantMsg.content) {
        contentEl.className = 'prose prose-invert prose-gruvbox max-w-none text-sm break-words leading-relaxed';
        contentEl.innerHTML = formatMarkdown(assistantMsg.content, { enhanceCode: false });
    }
    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
}

export async function triggerAPI() {
    const active = getActiveConversation();
    if (!active) return;

    const chatContainer = document.getElementById('chat-container');
    // Captured up front so a mid-stream model switch cannot mislabel the trace.
    const requestModel = store.selectedModel;
    const inlineTags = getInlineTags();
    // Per-endpoint preference from Settings. Copilot models are always true.
    const useStream = isStreamingModel(requestModel);

    const assistantIndex = active.messages.length;
    const assistantMsg = {
        role: 'assistant',
        content: '',
        model: requestModel,
        reasoning: ''
    };
    active.messages.push(assistantMsg);

    saveHistory();
    renderChat();

    store.isProcessing = true;
    store.currentAbortController = new AbortController();
    setProcessingUI(true);

    try {
        const replayHistory = buildReplayHistory(active.messages.slice(0, -1));

        const res = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: requestModel,
                messages: replayHistory,
                stream: useStream,
                max_tokens: 16384
            }),
            signal: store.currentAbortController.signal
        });

        if (!res.ok) {
            let errMsg = `Server returned HTTP ${res.status}`;
            try {
                const errData = await res.json();
                errMsg = (errData.error && errData.error.message)
                    ? errData.error.message
                    : JSON.stringify(errData, null, 2);
            } catch (e) {
                errMsg = await res.text();
            }
            await learnModelTokenLimitFromError(errMsg, requestModel);
            throw new Error(errMsg);
        }

        if (useStream) {
            await consumeStream(res, assistantMsg, assistantIndex, inlineTags, chatContainer);
        } else {
            await consumeSingleResponse(res, assistantMsg, assistantIndex, inlineTags, chatContainer);
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            // Only discard the message when nothing at all was captured. A run
            // stopped mid-reasoning still has a trace worth keeping.
            const hasAnything = Boolean(assistantMsg.content) || Boolean((assistantMsg.reasoning || '').trim());
            if (!hasAnything) {
                const activeConv = getActiveConversation();
                if (activeConv && activeConv.messages[assistantIndex] === assistantMsg) {
                    activeConv.messages.splice(assistantIndex, 1);
                }
            }
        } else {
            await learnModelTokenLimitFromError(e && e.message ? e.message : '', requestModel);
            active.messages[assistantIndex] = {
                role: 'assistant',
                content: e.message,
                model: requestModel,
                isError: true
            };
        }
        renderChat();
    } finally {
        store.isProcessing = false;
        store.currentAbortController = null;
        handlePrunePayload(assistantMsg);
        handleExecutionPayload(assistantMsg, active.messages);
        saveHistory();
        renderChat();
        setProcessingUI(false);
        updateTokenCount();
        fetchQuota();
    }
}
