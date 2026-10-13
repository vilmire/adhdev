import { detectAuthFailureOnlyReply, stripAnsi, type ProviderFailure } from './provider-failure-classifier.js';

const PROVIDER_MARKERS: Record<string, RegExp> = {
    'codex-cli': /chatgpt\.com|backend-api\/|wham\/usage|\bcodex(?:-cli)?\b|\bopenai\b/i,
    'claude-cli': /\banthropic\b|\bclaude(?:-cli)?\b|claude\.ai/i,
    'antigravity-cli': /\bantigravity(?:-cli)?\b|\bagy\b|cloudcode-pa\.googleapis/i,
    'kimi': /\bkimi(?:-cli)?\b|\bmoonshot\b/i,
    'cursor-cli': /\bcursor-(?:agent|cli)\b|cursor\.(?:com|sh)\b/i,
    'grok-cli': /\bgrok(?:-cli)?\b|\bx\.ai\b/i,
    'opencode': /\bopencode\b/i,
};

/** A label starts a provider's own statement, unlike a provider name inside JSON. */
const PROVIDER_LABEL = /\b(?:codex(?:-cli)?|openai|claude(?:-cli)?|anthropic|antigravity(?:-cli)?|agy|kimi(?:-cli)?|moonshot|cursor-(?:agent|cli)|grok(?:-cli)?|opencode)\b/gi;

/**
 * Paragraphs and quote containers bound attribution, not byte/line distances.
 * Keep a quote's introduction with its fenced/blockquote body (including blank
 * lines), then close the block at the fence/quote end. An unclosed fence is
 * conservatively bounded by the input tail. No state survives between calls.
 */
function logicalBlocks(text: string): string[] {
    const blocks: string[] = [];
    let pending: string[] = [];
    let fence: string | undefined;
    let quoted = false;
    const flush = () => { if (pending.length) blocks.push(pending.join('\n')); pending = []; };
    const attachIntroduction = () => {
        const prior = blocks[blocks.length - 1];
        if (!pending.length && prior?.trimEnd().endsWith(':')
            && Object.values(PROVIDER_MARKERS).some(marker => marker.test(prior))) pending.push(blocks.pop()!);
    };
    for (const line of text.split('\n')) {
        const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
        if (fence) {
            pending.push(line);
            if (delimiter && delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length) {
                fence = undefined;
                flush();
            }
            continue;
        }
        if (quoted && !/^\s*>/.test(line)) { flush(); quoted = false; }
        if (delimiter) { attachIntroduction(); fence = delimiter[1]; pending.push(line); continue; }
        if (!line.trim()) { flush(); continue; }
        quoted = /^\s*>/.test(line);
        if (quoted) attachIntroduction();
        pending.push(line);
    }
    flush();
    return blocks;
}

/**
 * Split explicit provider declarations outside strings/fences: a line beginning
 * with a provider, a provider after a clause delimiter, or `Antigravity: ...`
 * on a mixed line. Wrapped bodies remain attached to their declaration no
 * matter how long they are. Labels inside quoted error JSON cannot escape the
 * surrounding foreign block.
 */
function labelledStatements(cliType: string, block: string): string[] {
    const boundaries = [0];
    let quotedBy = '';
    let fence: string | undefined;
    let offset = 0;
    for (const line of block.split('\n')) {
        const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
        if (delimiter) {
            if (!fence) fence = delimiter[1];
            else if (delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length) fence = undefined;
            offset += line.length + 1;
            continue;
        }
        if (fence || /^\s*>/.test(line)) { offset += line.length + 1; continue; }
        // An explicitly own-labelled banner above a foreign discussion is a
        // separate statement even when the foreign name is mid-line.
        const prior = block.slice(boundaries[boundaries.length - 1], offset).trimStart();
        const ownAtStart = prior.match(PROVIDER_MARKERS[cliType]!);
        if (!quotedBy && offset > 0 && ownAtStart?.index === 0
            && Object.entries(PROVIDER_MARKERS).some(([provider, marker]) => provider !== cliType && marker.test(line))) {
            boundaries.push(offset);
        }
        PROVIDER_LABEL.lastIndex = 0;
        const labels = [...line.matchAll(PROVIDER_LABEL)];
        let scanned = 0;
        for (const label of labels) {
            const index = label.index!;
            for (; scanned < index; scanned++) {
                const c = line[scanned]!;
                if (c === '\\') { scanned++; continue; }
                if (quotedBy) { if (c === quotedBy) quotedBy = ''; }
                else if (c === '"' || c === '`' || (c === "'" && (scanned === 0 || !/[a-z0-9]/i.test(line[scanned - 1]!)))) quotedBy = c;
            }
            const before = line.slice(0, index);
            const after = line.slice(index + label[0].length);
            const declaration = /^\s*(?:[-*]\s*)?$/.test(before)
                || /[;·]\s*$/.test(before)
                || (/^\s*:\s+/.test(after) && /\s$/.test(before));
            const prefix = block.slice(boundaries[boundaries.length - 1], offset + index);
            // A neutral prefix (e.g. `API Error: 401` before the provider URL)
            // belongs to the FIRST declaration, never an independent own error.
            if (!quotedBy && declaration && offset + index > 0
                && Object.values(PROVIDER_MARKERS).some(marker => marker.test(prefix))) boundaries.push(offset + index);
        }
        // Finish scanning so a multiline JSON string remains a quote, while a
        // closed string does not hide the following line's explicit banner.
        for (; scanned < line.length; scanned++) {
            const c = line[scanned]!;
            if (c === '\\') { scanned++; continue; }
            if (quotedBy) { if (c === quotedBy) quotedBy = ''; }
            else if (c === '"' || c === '`' || (c === "'" && (scanned === 0 || !/[a-z0-9]/i.test(line[scanned - 1]!)))) quotedBy = c;
        }
        offset += line.length + 1;
    }
    return boundaries.map((start, i) => block.slice(start, boundaries[i + 1] ?? block.length));
}

/**
 * Foreign-only or ambiguously mixed error blocks are unknown for this CLI.
 * Explicit own-provider declarations form separate statements even directly
 * adjacent to a foreign error. Unlabelled banners in an unrelated paragraph
 * retain the established provider-neutral behavior. Providers not in the table
 * retain that behavior too; this function never infers healthy authentication.
 */
export function maskForeignProviderText(cliType: string, text: string): string {
    if (!(cliType in PROVIDER_MARKERS) || !text) return text;
    const clean = stripAnsi(text);
    const foreign = Object.entries(PROVIDER_MARKERS).filter(([provider]) => provider !== cliType);
    if (!foreign.some(([, marker]) => marker.test(clean))) return text;
    return logicalBlocks(clean).flatMap(block => labelledStatements(cliType, block))
        .map(statement => foreign.some(([, marker]) => marker.test(statement)) ? '' : statement)
        .join('\n');
}

/**
 * A turn verdict must pass the strict WHOLE-reply rule before attribution, and
 * again afterwards. Otherwise removing a foreign quote/prose could manufacture
 * an auth-only reply from an ordinary assistant answer. Foreign-only evidence
 * becomes empty/unknown; genuine own-only banners still fail the turn.
 */
export function classifyOwnAuthFailureOnlyReply(cliType: string, reply: string): ProviderFailure | null {
    if (!detectAuthFailureOnlyReply(reply)) return null;
    return detectAuthFailureOnlyReply(maskForeignProviderText(cliType, reply));
}
