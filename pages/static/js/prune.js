import { getActiveConversation } from './storage.js';
import { countTokens } from './tokens.js';
import {
    pruneFilesFromContent,
    collectPrunedPaths,
    getBaseline,
    rebuildMessageContent,
    invalidateFileIndex
} from './pruneManual.js';

// Re-exported so existing importers keep working; the implementation now lives
// in pruneManual.js alongside the rest of the prune core.
export { pruneFilesFromContent };

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
 * Applies a PRUNE payload to every user message above the assistant reply,
 * not just the most recent one, since file context is often split across
 * several turns.
 *
 * The resolved path list is stored on each user message so the model's set can
 * later be toggled or partially cleared without touching the user's own manual
 * prunes. `prunedContent` is still written for backwards compatibility with
 * threads saved by older builds.
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

        const baseline = getBaseline(msg);
        if (!baseline) continue;

        const modelPruned = pruneFilesFromContent(baseline, pruneFiles);
        if (!modelPruned) continue;

        // Diffing the marker sets yields the paths exactly as they appear in the
        // payload's own FILE blocks, rather than as the model spelled them.
        const before = collectPrunedPaths(baseline);
        const after = collectPrunedPaths(modelPruned);
        const paths = {};
        after.forEach((reason, path) => {
            if (!before.has(path)) paths[path] = reason;
        });
        if (Object.keys(paths).length === 0) continue;

        msg.modelPrunedPaths = paths;
        msg.modelPruneActive = true;
        msg.prunedContent = modelPruned;

        totalTokensSaved += Math.max(0, countTokens(baseline) - countTokens(modelPruned));
        rebuildMessageContent(msg);
        targetIndices.push(i);
    }

    if (targetIndices.length === 0) return;
    invalidateFileIndex();

    assistantMsg.pruneInfo = {
        isPruned: true,
        tokensSaved: totalTokensSaved,
        targetIndices,
        // Retained for backwards compatibility with threads saved pre-merge.
        userMsgIndex: targetIndices[0]
    };
}

/**
 * Clears the model's prune set on any user message pruned by responses that
 * are about to be discarded after cutIndex. Manual prunes are deliberately
 * left in place: the user set those, and the discarded reply did not.
 */
export function restorePrunedFromIndex(messages, cutIndex) {
    if (!Array.isArray(messages)) return;

    let touched = false;
    for (let i = cutIndex + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m || !m.pruneInfo) continue;

        const indices = Array.isArray(m.pruneInfo.targetIndices)
            ? m.pruneInfo.targetIndices
            : (m.pruneInfo.userMsgIndex > -1 ? [m.pruneInfo.userMsgIndex] : []);

        indices.forEach(idx => {
            if (idx < 0 || idx > cutIndex || idx >= messages.length) return;
            const userMsg = messages[idx];
            if (!userMsg) return;

            delete userMsg.modelPrunedPaths;
            delete userMsg.prunedContent;
            delete userMsg.modelPruneActive;
            rebuildMessageContent(userMsg);
            touched = true;
        });
    }

    if (touched) invalidateFileIndex();
}
