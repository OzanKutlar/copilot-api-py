/**
 * Parses raw combineCopy payloads into their logical sections so the UI can
 * show the user's request prominently and collapse everything else.
 *
 * Header strings mirror the emitters in combinecopy/prompts.py. Matching is
 * anchored to a full trimmed line, so a header appearing inside a pasted file
 * body cannot split the message.
 */

const HEADERS = [
    { id: 'user_request', title: 'User Request', icon: 'user', match: '--- USER REQUEST ---' },
    { id: 'user_reminder', title: 'User Request (Reminder)', icon: 'repeat', match: '--- USER REQUEST (Reminder) ---' },
    { id: 'ast_map', title: 'Directory AST Map', icon: 'git-branch', match: '--- DIRECTORY AST MAP ---' },
    { id: 'file_context', title: 'File Context', icon: 'folder-open', match: '--- FILE CONTEXT ---' },
    { id: 'git_diff', title: 'Uncommitted Git Diff', icon: 'git-compare', match: '--- CURRENT UNCOMMITTED GIT DIFF ---' },
    { id: 'system_prompt', title: 'System Instructions', icon: 'shield', match: '--- SYSTEM INSTRUCTIONS ---' },
    { id: 'system_reminder', title: 'System Reminder', icon: 'alert-circle', match: '--- SYSTEM REMINDER ---' },
    { id: 'missing_files', title: 'System Note: Missing Files', icon: 'file-x', match: '--- SYSTEM NOTE: MISSING FILES ---' },
    { id: 'prune_note', title: 'System Note: Context Pruning', icon: 'scissors', match: '--- SYSTEM NOTE: CONTEXT PRUNING ---' }
];

const MAX_FILE_BLOCKS = 2000;
const PRUNED_PREFIX = '(Has been removed from context because:';

function fileBlockRegex() {
    return /-{35}\nFILE: (.*?)\n-{35}\n```[a-z0-9]*\n([\s\S]*?)\n```/g;
}

function matchHeader(line) {
    for (let i = 0; i < HEADERS.length; i++) {
        if (line === HEADERS[i].match) return HEADERS[i];
    }
    return null;
}

export function parseFileBlocks(text) {
    const files = [];
    if (typeof text !== 'string' || !text) return files;

    const re = fileBlockRegex();
    let match;
    let guard = 0;
    while ((match = re.exec(text)) !== null) {
        guard += 1;
        if (guard > MAX_FILE_BLOCKS) break;

        const content = (match[2] || '').trim();
        const isPruned = content.startsWith(PRUNED_PREFIX);
        files.push({
            path: (match[1] || '').trim(),
            content,
            isPruned,
            prunedReason: isPruned
                ? content.replace(PRUNED_PREFIX, '').replace(/\)$/, '').trim()
                : ''
        });
    }
    return files;
}

function stripFileBlocks(text) {
    return text.replace(fileBlockRegex(), '').replace(/\n{3,}/g, '\n\n').trim();
}

function emptyResult() {
    return { isStructured: false, userRequest: null, sections: [], files: [] };
}

/**
 * Returns { isStructured, userRequest, sections, files }.
 * When isStructured is false the caller should render the raw text unchanged.
 */
export function parseCombineCopyPrompt(raw) {
    if (typeof raw !== 'string' || !raw) return emptyResult();

    const lines = raw.split('\n');
    const marks = [];
    for (let i = 0; i < lines.length; i++) {
        const def = matchHeader(lines[i].trim());
        if (def) marks.push({ line: i, def });
    }

    // No recognised headers: fall back to a loose file-block scan so batch-mode
    // payloads (which ship file context with no header) still render nicely.
    if (marks.length === 0) {
        const looseFiles = parseFileBlocks(raw);
        if (looseFiles.length === 0) return emptyResult();
        const coreText = stripFileBlocks(raw);
        return {
            isStructured: true,
            userRequest: coreText || null,
            sections: [],
            files: looseFiles
        };
    }

    const sections = [];
    let userRequest = null;
    let files = [];
    let sawFileContext = false;

    for (let m = 0; m < marks.length; m++) {
        const start = marks[m].line + 1;
        const end = (m + 1 < marks.length) ? marks[m + 1].line : lines.length;
        const body = lines.slice(start, end).join('\n').trim();
        const def = marks[m].def;

        // The reminder duplicates the request verbatim; first non-empty wins.
        if (def.id === 'user_request' || def.id === 'user_reminder') {
            if (userRequest === null && body) userRequest = body;
            continue;
        }

        if (def.id === 'file_context') {
            sawFileContext = true;
            files = files.concat(parseFileBlocks(body));
            continue;
        }

        if (!body) continue;
        sections.push({
            id: def.id + '_' + m,
            title: def.title,
            icon: def.icon,
            body
        });
    }

    const isStructured = userRequest !== null || sawFileContext || sections.length > 0;
    if (!isStructured) return emptyResult();

    return { isStructured: true, userRequest, sections, files };
}
