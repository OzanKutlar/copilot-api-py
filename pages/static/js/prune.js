import { getActiveConversation } from './storage.js';
import { countTokens } from './tokens.js';

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
            // fall through to XML
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

export function handlePrunePayload(assistantMsg) {
    if (!assistantMsg || !assistantMsg.content) return;

    const pruneFiles = extractPruneFiles(assistantMsg.content);
    if (pruneFiles.length === 0) return;

    const active = getActiveConversation();
    if (!active || active.messages.length < 2) return;

    let lastUserMsg = null;
    let lastUserMsgIdx = -1;
    for (let i = active.messages.length - 1; i >= 0; i--) {
        if (active.messages[i].role === 'user') {
            lastUserMsg = active.messages[i];
            lastUserMsgIdx = i;
            break;
        }
    }
    if (!lastUserMsg) return;

    if (!lastUserMsg.originalContent) {
        lastUserMsg.originalContent = lastUserMsg.content;
    }

    let mutated = false;
    let rawStr = lastUserMsg.originalContent;

    pruneFiles.forEach(f => {
        if (f.stay === false && f.path && f.reason) {
            const fileRegex = /(-{35}\nFILE: (.*?)\n-{35}\n```[a-z0-9]*\n)([\s\S]*?)(\n```)/g;
            rawStr = rawStr.replace(fileRegex, (match, p1, filePath, p3, p4) => {
                const cleanFilePath = filePath.trim().replace(/\\/g, '/');
                const cleanTarget = f.path.trim().replace(/\\/g, '/');
                if (cleanFilePath === cleanTarget || cleanFilePath.endsWith('/' + cleanTarget)) {
                    if (p3.trim().startsWith('(Has been removed from context because:')) return match;
                    mutated = true;
                    return `${p1}(Has been removed from context because: ${f.reason})${p4}`;
                }
                return match;
            });
        }
    });

    if (!mutated) return;

    lastUserMsg.prunedContent = rawStr;
    lastUserMsg.content = rawStr;

    const origTokens = countTokens(lastUserMsg.originalContent);
    const newTokens = countTokens(lastUserMsg.prunedContent);

    assistantMsg.pruneInfo = {
        isPruned: true,
        tokensSaved: Math.max(0, origTokens - newTokens),
        userMsgIndex: lastUserMsgIdx
    };
}
