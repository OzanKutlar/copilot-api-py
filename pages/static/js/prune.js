import { getActiveConversation } from './storage.js';
import { countTokens } from './tokens.js';

const PRUNED_PREFIX = '(Has been removed from context because:';

function extractPruneFiles(assistantText) {
    const pruneFiles = [];

    const jsonRegex = /```(?:json)?\s*(\{[\s\S]*?"phase"\s*:\s*"PRUNE"[\s\S]*?\})\s*```/i;
    const jsonMatch = jsonRegex.exec(assistantText);
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            if (data.files && Array.isArray(data.files)) {
                return data.files;
            }
        } catch (e) {
            console.warn('Malformed PRUNE JSON payload', e);
        }
        return pruneFiles;
    }

    const xmlRegex = /<antigravity_payload>[\s\S]*?<phase>PRUNE<\/phase>[\s\S]*?<files>([\s\S]*?)<\/files>[\s\S]*?<\/antigravity_payload>/i;
    const xmlMatch = xmlRegex.exec(assistantText);
    if (!xmlMatch) return pruneFiles;

    const fileRegex = /<file>[\s\S]*?<path>(.*?)<\/path>[\s\S]*?<stay>(.*?)<\/stay>[\s\S]*?<reason>([\s\S]*?)<\/reason>[\s\S]*?<\/file>/gi;
    let fMatch;
    let guard = 0;
    while ((fMatch = fileRegex.exec(xmlMatch[1])) !== null) {
        guard += 1;
        if (guard > 2000) break;
        pruneFiles.push({
            path: fMatch[1].trim(),
            stay: fMatch[2].trim().toLowerCase() === 'true',
            reason: fMatch[3].trim()
        });
    }
    return pruneFiles;
}

/**
 * Returns the rewritten string when at least one file block was replaced,
 * otherwise null so callers can cheaply skip untouched messages.
 */
export function pruneFilesFromContent(content, pruneFiles) {
    if (!content || typeof content !== 'string') return null;

    let mutated = false;
    let rawStr = content;

    pruneFiles.forEach(f => {
        if (f.stay !== false || !f.path || !f.reason) return;

        const fileRegex = /(-{35}\nFILE: (.*?)\n-{35}\n```[a-z0-9]*\n)([\s\S]*?)(\n```)/g;
        rawStr = rawStr.replace(fileRegex, (match, p1, filePath, body, p4) => {
            const cleanFilePath = filePath.trim().replace(/\\/g, '/');
            const cleanTarget = f.path.trim().replace(/\\/g, '/');
            if (cleanFilePath !== cleanTarget && !cleanFilePath.endsWith('/' + cleanTarget)) {
                return match;
            }
            if (body.trim().startsWith(PRUNED_PREFIX)) return match;
            mutated = true;
            return `${p1}${PRUNED_PREFIX} ${f.reason})${p4}`;
        });
    });

    return mutated ? rawStr : null;
}

/**
 * Applies a PRUNE payload to every user message above the assistant reply,
 * not just the most recent one, since file context is often split across
 * several turns.
 */
export function handlePrunePayload(assistantMsg) {
    if (!assistantMsg || !assistantMsg.content) return;

    const pruneFiles = extractPruneFiles(assistantMsg.content);
    if (pruneFiles.length === 0) return;

    const active = getActiveConversation();
    if (!active || active.messages.length < 2) return;

    const assistantIdx = active.messages.indexOf(assistantMsg);
    const maxSearchIdx = assistantIdx > -1 ? assistantIdx : active.messages.length;

    const targetIndices = [];
    let totalTokensSaved = 0;

    for (let i = maxSearchIdx - 1; i >= 0; i--) {
        const msg = active.messages[i];
        if (!msg || msg.role !== 'user') continue;

        const newContent = pruneFilesFromContent(msg.content, pruneFiles);
        if (!newContent) continue;

        if (!msg.originalContent) {
            msg.originalContent = msg.content;
        }

        const origTokens = countTokens(msg.originalContent);
        msg.prunedContent = newContent;
        msg.content = newContent;
        totalTokensSaved += Math.max(0, origTokens - countTokens(newContent));
        targetIndices.push(i);
    }

    if (targetIndices.length === 0) return;

    assistantMsg.pruneInfo = {
        isPruned: true,
        tokensSaved: totalTokensSaved,
        targetIndices,
        // Retained for backwards compatibility with threads saved pre-merge.
        userMsgIndex: targetIndices[0]
    };
}

/**
 * Restores original content across any user message pruned by responses
 * that are about to be discarded after cutIndex.
 */
export function restorePrunedFromIndex(messages, cutIndex) {
    if (!Array.isArray(messages)) return;
    for (let i = cutIndex + 1; i < messages.length; i++) {
        const m = messages[i];
        if (m && m.pruneInfo && m.pruneInfo.isPruned) {
            const indices = Array.isArray(m.pruneInfo.targetIndices)
                ? m.pruneInfo.targetIndices
                : (m.pruneInfo.userMsgIndex > -1 ? [m.pruneInfo.userMsgIndex] : []);
            indices.forEach(idx => {
                if (idx >= 0 && idx <= cutIndex && idx < messages.length) {
                    const userMsg = messages[idx];
                    if (userMsg && userMsg.originalContent) {
                        userMsg.content = userMsg.originalContent;
                        delete userMsg.prunedContent;
                    }
                }
            });
        }
    }
}
