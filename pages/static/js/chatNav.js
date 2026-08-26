import { getActiveConversation } from './storage.js';
import { parseCombineCopyPrompt } from './promptParser.js';

let activeObserver = null;
let currentActiveIndex = 0;

function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.isContentEditable === true;
}

function getMessagePreview(msg) {
    if (!msg || typeof msg.content !== 'string') return '';
    if (msg.role === 'user') {
        const parsed = parseCombineCopyPrompt(msg.content);
        const text = parsed.isStructured ? (parsed.userRequest || '') : msg.content;
        return (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    return msg.content.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function scrollToMessage(index) {
    const container = document.getElementById('chat-container');
    const target = document.getElementById(`msg-wrap-${index}`);
    if (!container || !target) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({
        top: container.scrollTop + delta - 16,
        behavior: prefersReducedMotion ? 'auto' : 'smooth'
    });
    setActiveTick(index);
}

function setActiveTick(index) {
    currentActiveIndex = index;
    const list = document.getElementById('chat-nav-list');
    if (!list) return;

    list.querySelectorAll('.chat-nav-tick').forEach(tick => {
        const tickIdx = Number(tick.getAttribute('data-idx'));
        const isActive = tickIdx === index;
        tick.classList.toggle('chat-nav-tick-active', isActive);
    });
}

function stepNav(direction) {
    const active = getActiveConversation();
    const messages = active ? active.messages : [];
    if (messages.length === 0) return;

    let nextIndex = currentActiveIndex + direction;
    nextIndex = Math.max(0, Math.min(messages.length - 1, nextIndex));
    scrollToMessage(nextIndex);
}

export function destroyChatNav() {
    if (activeObserver) {
        activeObserver.disconnect();
        activeObserver = null;
    }
}

export function renderChatNav() {
    destroyChatNav();

    const rail = document.getElementById('chat-nav-rail');
    const list = document.getElementById('chat-nav-list');
    const container = document.getElementById('chat-container');
    if (!rail || !list || !container) return;

    const active = getActiveConversation();
    const messages = active ? active.messages : [];

    if (messages.length < 2) {
        rail.classList.add('hidden');
        return;
    }

    rail.classList.remove('hidden');
    list.innerHTML = '';

    let userCount = 0;
    let assistantCount = 0;

    messages.forEach((msg, idx) => {
        const isUser = msg.role === 'user';
        const isError = msg.isError === true;
        let label = '';
        let roleClass = 'chat-nav-tick-assistant';

        if (isUser) {
            userCount++;
            label = `U${userCount}`;
            roleClass = 'chat-nav-tick-user';
        } else if (isError) {
            assistantCount++;
            label = `A${assistantCount}`;
            roleClass = 'chat-nav-tick-error';
        } else {
            assistantCount++;
            label = `A${assistantCount}`;
            roleClass = 'chat-nav-tick-assistant';
        }

        const tick = document.createElement('button');
        tick.className = `chat-nav-tick ${roleClass}`;
        tick.setAttribute('data-idx', String(idx));
        tick.textContent = label;
        
        const preview = getMessagePreview(msg);
        const roleName = isUser ? 'User Request' : (isError ? 'Error Response' : 'Assistant Reply');
        tick.title = `[${label}] ${roleName}${preview ? ': ' + preview : ''}`;

        tick.onclick = () => scrollToMessage(idx);
        list.appendChild(tick);
    });

    // Highlight current active index
    if (currentActiveIndex >= messages.length) {
        currentActiveIndex = messages.length - 1;
    }
    setActiveTick(currentActiveIndex);

    // Observe messages to track active position on manual scroll
    if ('IntersectionObserver' in window) {
        activeObserver = new IntersectionObserver((entries) => {
            const visible = entries.filter(e => e.isIntersecting);
            if (visible.length > 0) {
                // Pick topmost visible message
                visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
                const topEl = visible[0].target;
                const idStr = topEl.id || '';
                const idx = parseInt(idStr.replace('msg-wrap-', ''), 10);
                if (!isNaN(idx)) {
                    setActiveTick(idx);
                }
            }
        }, {
            root: container,
            rootMargin: '0px 0px -70% 0px',
            threshold: 0
        });

        messages.forEach((_, idx) => {
            const el = document.getElementById(`msg-wrap-${idx}`);
            if (el) activeObserver.observe(el);
        });
    }

    lucide.createIcons();
}

export function wireChatNav() {
    const prevBtn = document.getElementById('chat-nav-prev');
    const nextBtn = document.getElementById('chat-nav-next');

    if (prevBtn) prevBtn.onclick = () => stepNav(-1);
    if (nextBtn) nextBtn.onclick = () => stepNav(1);

    document.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        if (isEditableTarget(document.activeElement)) return;

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            stepNav(-1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            stepNav(1);
        }
    });
}
