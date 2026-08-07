import { store, getActiveConversation } from './storage.js';
import { countTokens, applyActiveTokenLimit, updateTokenCount, learnModelTokenLimitFromError } from './tokens.js';
import { createMessageElement } from './message.js';
import { saveHistory } from './sidebar.js';
import { handlePrunePayload } from './prune.js';
import { fetchQuota } from './models.js';

export function renderChat(preserveScroll = false) {
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;

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

function splitThinking(rawOutput, reasoningSoFar) {
    let cleanContent = rawOutput;
    let extractedThink = reasoningSoFar;

    const closedRegex = /<think>([\s\S]*?)<\/think>/g;
    let match;
    let guard = 0;
    while ((match = closedRegex.exec(rawOutput)) !== null) {
        guard += 1;
        if (guard > 500) break;
        extractedThink += match[1] + '\n';
    }
    cleanContent = cleanContent.replace(closedRegex, '');

    const openIdx = cleanContent.lastIndexOf('<think>');
    if (openIdx !== -1) {
        extractedThink += cleanContent.substring(openIdx + 7);
        cleanContent = cleanContent.substring(0, openIdx);
    }

    return { cleanContent, extractedThink };
}

export async function triggerAPI() {
    const active = getActiveConversation();
    if (!active) return;

    const chatContainer = document.getElementById('chat-container');
    const requestModel = store.selectedModel;
    const assistantIndex = active.messages.length;
    const assistantMsg = { role: 'assistant', content: '' };
    active.messages.push(assistantMsg);

    saveHistory();
    renderChat();

    store.isProcessing = true;
    store.currentAbortController = new AbortController();
    setProcessingUI(true);

    try {
        const cleanHistory = active.messages.slice(0, -1)
            .filter(m => !m.isError)
            .map(m => ({ role: m.role, content: m.content }));

        const res = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: requestModel,
                messages: cleanHistory,
                stream: true,
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
                        if (delta.reasoning_content) {
                            combinedReasoning += delta.reasoning_content;
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

                        const split = splitThinking(rawOutput, combinedReasoning);
                        const thinkingBadge = document.getElementById(`thinking-badge-${assistantIndex}`);
                        const thinkingTextEl = document.getElementById(`thinking-text-${assistantIndex}`);

                        if (split.extractedThink.trim().length > 0) {
                            if (thinkingBadge) thinkingBadge.classList.remove('hidden');
                            if (thinkingTextEl) {
                                const txt = split.extractedThink.replace(/\n/g, ' ').trim();
                                thinkingTextEl.textContent = 'Thinking... ' + txt.slice(-100);
                            }
                        } else if (thinkingBadge) {
                            thinkingBadge.classList.add('hidden');
                        }

                        if (split.cleanContent !== assistantMsg.content && contentEl) {
                            if (!assistantMsg.content) {
                                contentEl.className = 'prose prose-invert prose-gruvbox max-w-none text-sm break-words leading-relaxed';
                                contentEl.innerHTML = '';
                            }
                            assistantMsg.content = split.cleanContent;
                            contentEl.innerHTML = DOMPurify.sanitize(marked.parse(assistantMsg.content || ''));

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
    } catch (e) {
        if (e.name === 'AbortError') {
            if (!assistantMsg.content) {
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
                isError: true
            };
        }
        renderChat();
    } finally {
        store.isProcessing = false;
        store.currentAbortController = null;
        handlePrunePayload(assistantMsg);
        saveHistory();
        renderChat();
        setProcessingUI(false);
        updateTokenCount();
        fetchQuota();
    }
}
