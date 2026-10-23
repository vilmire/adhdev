/**
 * Shared credential and bearer-token redactor used across:
 *   - command history logging (`command-log.ts`),
 *   - runtime debug trace (`debug-trace.ts`, including `traceContent=true`),
 *   - chat debug bundle sanitizer (`chat-commands-debug-bundle.ts`, inline & `daemon_file`),
 *   - artifact secret content scanner (`artifact-path-guard.ts`).
 */

import { createHash } from 'crypto';

const CREDENTIAL_KEY_SET = new Set([
    'token',
    'bind',
    'password',
    'passwd',
    'secret',
    'apiKey',
    'api_key',
    'accessKey',
    'access_key',
    'connectionToken',
    'mcpSessionCredential',
    'sessionCredential',
    'credential',
    'authorization',
    'authToken',
    'accessToken',
    'refreshToken',
    'refresh_token',
    'clientSecret',
    'client_secret',
    'privateKey',
    'private_key',
    'originFetchGrant',
    'cookie',
    'peerSecret',
]);

export const CREDENTIAL_KEY_PATTERN =
    /(?:credential|token|secret|password|passwd|api[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|authorization|cookie|bearer|private[_-]?key|session[_-]?bind|fetch[_-]?grant)/i;

const KEY_VALUE_CREDENTIAL_RE =
    /(?<!\?\s*)(?:api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?credential|mcpSessionCredential|connectionToken|originFetchGrant|peerSecret|credential|token|secret|password|passwd)(?:\s*(?<![=!<>])[:=](?![=>])|["']\s*:(?![=>]))\s*(?:(["'])(?!\[REDACTED|\$\{)(?![a-z][A-Za-z]*\1\s*(?:\||,\s*description\s*:))(?:[^\s"'`\\]{6,}|[^\s"'`\\]*\u2026[^\s"'`\\]*)\1|(?![\"'])(?!\[REDACTED)(?:mcp_sess_|sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|eyJ|(?:adk|adm|adp|shr|wtk|wtt|wsb)_|[A-Za-z0-9_~+/-]*[0-9][A-Za-z0-9_~+/-]*)[A-Za-z0-9_~+/-]{5,}={0,2}(?=$|[\s,;}\]&'"]))/i;

const KEY_VALUE_CREDENTIAL_REDACT_RE =
    /((?<!\?\s*)(?:api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?credential|mcpSessionCredential|connectionToken|originFetchGrant|peerSecret|credential|token|secret|password|passwd|ADHDEV_MCP_SESSION_CREDENTIAL)(?:\s*(?<![=!<>])[:=](?![=>])|["']\s*:(?![=>]))\s*)(?:(["'])(?!\[REDACTED|\$\{)(?![a-z][A-Za-z]*\2\s*(?:\||,\s*description\s*:))(?:[^\s"'`\\]{6,}|[^\s"'`\\]*\u2026[^\s"'`\\]*)\2|(?![\"'])(?!\[REDACTED)(?:mcp_sess_|sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|eyJ|(?:adk|adm|adp|shr|wtk|wtt|wsb)_|[A-Za-z0-9_~+/-]*[0-9][A-Za-z0-9_~+/-]*)[A-Za-z0-9_~+/-]{5,}={0,2}(?=$|[\s,;}\]&'"]))/gi;

const RAW_CREDENTIAL_PATTERNS: readonly RegExp[] = [
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    /\bmcp_sess_[A-Za-z0-9._~+/-]{8,}/,
    /\bmcp(?:\\?[\s"'`+]){0,12}_(?:\\?[\s"'`+]){0,12}sess(?:\\?[\s"'`+]){0,12}_(?:\\?[\s"'`+]){0,12}[A-Za-z0-9._~+/-]{8,}/i,
    /\b(?:adk|adm|adp|shr|wtk|wtt|wsb)_[A-Za-z0-9_-]{8,}\b/,
    /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/,
    /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\bADHDEV_MCP_SESSION_CREDENTIAL\b/,
    /Authorization\s*:\s*Bearer\s+(?!\[REDACTED)[^\s'"`,;]+/i,
    /\bBearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/-]{12,}=*/i,
    KEY_VALUE_CREDENTIAL_RE,
    /[?&](?:api[_-]?key|access[_-]?key|token|secret|password|client_secret|credential|mcpSessionCredential)=(?!\[REDACTED|\$\{)[A-Za-z0-9._~+%/-]{4,}(?=$|[&#\s'")\]};,])/i,
];

const PERCENT_ENCODED_RUN_RE = /(?<![A-Za-z0-9+/_~=%-])(?:[A-Za-z0-9+/_~=-]|%[0-9A-Fa-f]{2}){10,}/g;
const BASE64_RUN_RE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{12,}={0,2}/g;
const SPLIT_BASE64_RUN_RE =
    /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{4,}(?![A-Za-z0-9+/_-])(?:(?:\\[rnt]|[\r\n\t]+|(?:\\?["'`])\s*(?:\+\s*)?(?:\\?["'`])|\\(?:\r?\n))[A-Za-z0-9+/_-]{4,}(?![A-Za-z0-9+/_-]))+={0,2}/g;
const INTRA_TOKEN_SPLIT_RE =
    /(?:\\[rnt]|[\r\n\t])+|(?:\\?["'`])\s*(?:\+\s*)?(?:\\?["'`])|\\(?:\r?\n)/g;

export const MAX_CREDENTIAL_DECODE_DEPTH = 4;
const SCAN_WINDOW_CHARS = 65_536;
const SCAN_WINDOW_OVERLAP_CHARS = 4_096;
const SCAN_WINDOW_STEP_CHARS = SCAN_WINDOW_CHARS - SCAN_WINDOW_OVERLAP_CHARS;
const MAX_BASE64_SLICE_CHARS = 65_536;
const BASE64_SLICE_OVERLAP_CHARS = 4_096;
const BASE64_SLICE_STEP_CHARS = MAX_BASE64_SLICE_CHARS - BASE64_SLICE_OVERLAP_CHARS;
const MAX_DECODABLE_CANDIDATES_PER_WINDOW = 1_024;
const MAX_DECODE_OPS_PER_WINDOW = 2_048;
const MAX_CANDIDATE_RUNS_PER_SUBLAYER = 128;
const MAX_NON_DECODABLE_CACHE_ENTRIES = 4_096;

interface DecodeBudget {
    operations: number;
    maxOperations: number;
    visited: Set<string>;
    nonDecodableCache: Set<string>;
    exhausted: boolean;
}

export function isCredentialKey(key: string): boolean {
    if (!key) return false;
    return CREDENTIAL_KEY_SET.has(key) || CREDENTIAL_KEY_PATTERN.test(key);
}

function getLiveSessionCredential(): string {
    const raw =
        typeof process.env.ADHDEV_MCP_SESSION_CREDENTIAL === 'string'
            ? process.env.ADHDEV_MCP_SESSION_CREDENTIAL.trim()
            : '';
    return raw.length >= 8 ? raw : '';
}

function matchesAnyPattern(text: string, patterns: readonly RegExp[], liveCred: string): boolean {
    if (liveCred && text.includes(liveCred)) return true;
    for (const pattern of patterns) {
        if (pattern.test(text)) return true;
    }
    return false;
}

function decodeOnePercentLayer(input: string): string {
    if (!input.includes('%') || !/%[0-9A-Fa-f]{2}/.test(input)) return input;
    try {
        return decodeURIComponent(input);
    } catch {
        return input.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
        );
    }
}

function isPlausibleDecodedText(str: string): boolean {
    if (!str || str.length < 6) return false;
    const len = Math.min(str.length, 512);
    let asciiPrintable = 0;
    for (let i = 0; i < len; i++) {
        const code = str.charCodeAt(i);
        if (code === 0xfffd) return false;
        if (
            (code >= 0x00 && code <= 0x08) ||
            code === 0x0b ||
            code === 0x0c ||
            (code >= 0x0e && code <= 0x1f) ||
            (code >= 0x7f && code <= 0x9f)
        ) {
            return false;
        }
        if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e)) {
            asciiPrintable++;
        }
    }
    const minRequiredAscii = Math.max(6, Math.ceil(len * 0.8));
    return asciiPrintable >= minRequiredAscii;
}

function isUniformRepeatedChar(s: string): boolean {
    if (s.length <= 1) return true;
    const first = s.charCodeAt(0);
    for (let i = 1; i < s.length; i++) {
        if (s.charCodeAt(i) !== first) return false;
    }
    return true;
}

type DecodedBase64Slice =
    | { kind: 'none' }
    | { kind: 'match' }
    | { kind: 'text'; text: string };

function decodeBase64Slice(
    candidate: string,
    patterns: readonly RegExp[],
    liveCred: string,
): DecodedBase64Slice {
    if (candidate.length < 12 || candidate.length > MAX_BASE64_SLICE_CHARS) return { kind: 'none' };
    const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
    const padMod = normalized.length % 4;
    if (padMod === 1) return { kind: 'none' };
    const padded = padMod === 0 ? normalized : normalized + '='.repeat(4 - padMod);
    try {
        const buf = Buffer.from(padded, 'base64');
        if (buf.byteLength < 6) return { kind: 'none' };
        const decoded = buf.toString('utf8');
        // Always scan the FULL decoded buffer for literal or live credentials regardless of
        // whether a binary prefix is present in the first 512 bytes.
        if (matchesAnyPattern(decoded, patterns, liveCred)) {
            return { kind: 'match' };
        }
        INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
        if (INTRA_TOKEN_SPLIT_RE.test(decoded)) {
            INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
            const collapsed = decoded.replace(INTRA_TOKEN_SPLIT_RE, '');
            if (collapsed && collapsed !== decoded && matchesAnyPattern(collapsed, patterns, liveCred)) {
                return { kind: 'match' };
            }
        }
        const sampleBytes = Math.min(buf.byteLength, 512);
        let controlInPrefix = false;
        for (let i = 0; i < sampleBytes; i++) {
            const b = buf[i]!;
            if (
                (b >= 0x00 && b <= 0x08) ||
                b === 0x0b ||
                b === 0x0c ||
                (b >= 0x0e && b <= 0x1f) ||
                b === 0x7f
            ) {
                controlInPrefix = true;
                break;
            }
        }
        if (!controlInPrefix && isPlausibleDecodedText(decoded)) {
            return { kind: 'text', text: decoded };
        }
        // If a binary prefix preceded an ASCII text block (e.g. binary prefix + nested encoded credential),
        // extract printable ASCII segments of >= 16 chars so deeper layers are still inspected.
        const asciiSegments = decoded.match(/[\x09\x0a\x0d\x20-\x7e]{16,}/g);
        if (asciiSegments && asciiSegments.length > 0) {
            return { kind: 'text', text: asciiSegments.join('\n') };
        }
        return { kind: 'none' };
    } catch {
        return { kind: 'none' };
    }
}

function tryDecodeBase64Slice(candidate: string): string | null {
    const res = decodeBase64Slice(candidate, RAW_CREDENTIAL_PATTERNS, getLiveSessionCredential());
    if (res.kind === 'match') return candidate;
    if (res.kind === 'text') return res.text;
    return null;
}

function rememberNonDecodable(budget: DecodeBudget, run: string): void {
    if (budget.nonDecodableCache.size < MAX_NON_DECODABLE_CACHE_ENTRIES) {
        budget.nonDecodableCache.add(run);
    }
}

function* iterateBase64Slices(run: string): Generator<string> {
    if (run.length <= MAX_BASE64_SLICE_CHARS) {
        yield run;
        return;
    }
    for (let offset = 0; offset < run.length; offset += BASE64_SLICE_STEP_CHARS) {
        const alignedStart = offset - (offset % 4);
        const rawEnd = Math.min(run.length, alignedStart + MAX_BASE64_SLICE_CHARS);
        const alignedEnd = rawEnd < run.length ? rawEnd - (rawEnd % 4) : rawEnd;
        if (alignedEnd - alignedStart >= 12) {
            yield run.slice(alignedStart, alignedEnd);
        }
        if (rawEnd >= run.length) break;
    }
}

/**
 * Classifies decoded text from a percent or base64 layer:
 * - `'match'`: directly contains a literal/live credential (or split credential).
 * - `'plausible'`: contains a further decodable layer (percent-encoding or a decodable base64 sub-run).
 * - `'benign'`: cannot contain credential-shaped content at any deeper layer; must NOT count toward
 *   per-window candidate exhaustion.
 */
function classifyDecodedCandidate(
    decodedText: string,
    patterns: readonly RegExp[],
    liveCred: string,
    budget: DecodeBudget,
): 'match' | 'plausible' | 'benign' {
    if (!decodedText) return 'benign';
    if (matchesAnyPattern(decodedText, patterns, liveCred)) return 'match';

    let collapsed = '';
    INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
    if (INTRA_TOKEN_SPLIT_RE.test(decodedText)) {
        INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
        collapsed = decodedText.replace(INTRA_TOKEN_SPLIT_RE, '');
        if (collapsed && collapsed !== decodedText && matchesAnyPattern(collapsed, patterns, liveCred)) {
            return 'match';
        }
    }

    if (decodedText.includes('%') && /%[0-9A-Fa-f]{2}/.test(decodedText)) {
        const nextPercent = decodeOnePercentLayer(decodedText);
        if (nextPercent !== decodedText) {
            if (matchesAnyPattern(nextPercent, patterns, liveCred)) return 'match';
            return 'plausible';
        }
    }

    const targets = collapsed && collapsed !== decodedText ? [decodedText, collapsed] : [decodedText];
    for (const target of targets) {
        for (const match of target.matchAll(BASE64_RUN_RE)) {
            const subRun = match[0];
            if (isUniformRepeatedChar(subRun)) continue;
            if (subRun.length <= MAX_BASE64_SLICE_CHARS && budget.nonDecodableCache.has(subRun)) continue;
            for (const slice of iterateBase64Slices(subRun)) {
                if (budget.nonDecodableCache.has(slice)) continue;
                const subDecoded = decodeBase64Slice(slice, patterns, liveCred);
                if (subDecoded.kind === 'match') return 'match';
                if (subDecoded.kind === 'text') return 'plausible';
                rememberNonDecodable(budget, slice);
            }
        }
    }

    return 'benign';
}

function examineBase64Run(
    run: string,
    patterns: readonly RegExp[],
    liveCred: string,
    depth: number,
    budget: DecodeBudget,
    onPlausibleCandidate: () => boolean,
): boolean {
    if (isUniformRepeatedChar(run)) return false;
    if (run.length <= MAX_BASE64_SLICE_CHARS && budget.nonDecodableCache.has(run)) {
        return false;
    }
    let anyDecoded = false;
    for (const slice of iterateBase64Slices(run)) {
        if (budget.nonDecodableCache.has(slice)) continue;
        const decodedRes = decodeBase64Slice(slice, patterns, liveCred);
        if (decodedRes.kind === 'none') {
            rememberNonDecodable(budget, slice);
            continue;
        }
        if (decodedRes.kind === 'match') {
            return true;
        }
        anyDecoded = true;
        const classification = classifyDecodedCandidate(decodedRes.text, patterns, liveCred, budget);
        if (classification === 'match') {
            return true;
        }
        if (classification === 'benign') {
            continue;
        }
        if (!onPlausibleCandidate()) {
            budget.exhausted = true;
            return true;
        }
        if (checkLayerRecursive(decodedRes.text, patterns, liveCred, depth + 1, budget)) {
            return true;
        }
    }
    if (!anyDecoded && run.length <= MAX_BASE64_SLICE_CHARS) {
        rememberNonDecodable(budget, run);
    }
    return budget.exhausted;
}

function examineWindowTransforms(
    windowText: string,
    patterns: readonly RegExp[],
    liveCred: string,
    depth: number,
    budget: DecodeBudget,
): boolean {
    if (windowText.includes('%') && /%[0-9A-Fa-f]{2}/.test(windowText)) {
        let cur = windowText;
        for (let d = depth; d < MAX_CREDENTIAL_DECODE_DEPTH; d++) {
            if (!cur.includes('%') || !/%[0-9A-Fa-f]{2}/.test(cur)) break;
            const next = decodeOnePercentLayer(cur);
            if (next === cur) break;
            if (matchesAnyPattern(next, patterns, liveCred)) {
                return true;
            }
            INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
            if (INTRA_TOKEN_SPLIT_RE.test(next)) {
                INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
                const nextCollapsed = next.replace(INTRA_TOKEN_SPLIT_RE, '');
                if (nextCollapsed && nextCollapsed !== next && matchesAnyPattern(nextCollapsed, patterns, liveCred)) {
                    return true;
                }
            }
            cur = next;
        }
    }

    return budget.exhausted;
}

function computeVisitKey(depth: number, rawText: string): string {
    if (rawText.length <= 256) {
        return `${depth}:raw:${rawText}`;
    }
    const digest = createHash('sha256').update(rawText).digest('base64url');
    return `${depth}:${rawText.length}:${digest}`;
}

function scanPercentRuns(
    text: string,
    patterns: readonly RegExp[],
    liveCred: string,
    depth: number,
    budget: DecodeBudget,
): boolean {
    if (!text.includes('%') || !/%[0-9A-Fa-f]{2}/.test(text)) return false;
    let pctCount = 0;
    let currentWindowIdx = 0;
    const maxPerScope =
        depth === 0 ? MAX_DECODABLE_CANDIDATES_PER_WINDOW : MAX_CANDIDATE_RUNS_PER_SUBLAYER;
    for (const match of text.matchAll(PERCENT_ENCODED_RUN_RE)) {
        const run = match[0];
        if (!run.includes('%') || !/%[0-9A-Fa-f]{2}/.test(run)) continue;
        if (depth === 0) {
            const winIdx = Math.floor((match.index ?? 0) / SCAN_WINDOW_STEP_CHARS);
            if (winIdx !== currentWindowIdx) {
                currentWindowIdx = winIdx;
                pctCount = 0;
            }
        }
        const decodedRun = decodeOnePercentLayer(run);
        if (decodedRun === run) continue;
        const classification = classifyDecodedCandidate(decodedRun, patterns, liveCred, budget);
        if (classification === 'match') {
            return true;
        }
        if (classification === 'benign') {
            continue;
        }
        if (
            depth >= MAX_CREDENTIAL_DECODE_DEPTH ||
            ++pctCount > maxPerScope ||
            budget.operations >= budget.maxOperations
        ) {
            budget.exhausted = true;
            return true;
        }
        if (checkLayerRecursive(decodedRun, patterns, liveCred, depth + 1, budget)) {
            return true;
        }
    }
    return budget.exhausted;
}

function scanBase64Runs(
    text: string,
    patterns: readonly RegExp[],
    liveCred: string,
    depth: number,
    budget: DecodeBudget,
): boolean {
    let b64Count = 0;
    let currentWindowIdx = 0;
    const maxPerScope =
        depth === 0 ? MAX_DECODABLE_CANDIDATES_PER_WINDOW : MAX_CANDIDATE_RUNS_PER_SUBLAYER;
    for (const match of text.matchAll(BASE64_RUN_RE)) {
        const run = match[0];
        if (depth === 0) {
            const winIdx = Math.floor((match.index ?? 0) / SCAN_WINDOW_STEP_CHARS);
            if (winIdx !== currentWindowIdx) {
                currentWindowIdx = winIdx;
                b64Count = 0;
            }
        }
        if (
            examineBase64Run(run, patterns, liveCred, depth, budget, () => {
                if (
                    depth >= MAX_CREDENTIAL_DECODE_DEPTH ||
                    ++b64Count > maxPerScope ||
                    budget.operations >= budget.maxOperations
                ) {
                    return false;
                }
                return true;
            })
        ) {
            return true;
        }
    }
    return budget.exhausted;
}

function checkLayerRecursive(
    rawText: string,
    patterns: readonly RegExp[],
    liveCred: string,
    depth: number,
    budget: DecodeBudget,
): boolean {
    if (!rawText) return false;
    // Full-input linear literal scan with no character cap.
    if (matchesAnyPattern(rawText, patterns, liveCred)) return true;

    if (budget.operations >= budget.maxOperations) {
        budget.exhausted = true;
        return true;
    }

    const visitKey = computeVisitKey(depth, rawText);
    if (budget.visited.has(visitKey)) return false;
    budget.visited.add(visitKey);
    budget.operations++;

    // 0. Window-independent streaming split-separator collapse across the full input.
    // Catches credentials (or encoded runs) split by arbitrary-length newline/escape/concat runs
    // even when the separator exceeds SCAN_WINDOW_OVERLAP_CHARS (4,096) across a window boundary.
    let fullCollapsed = '';
    INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
    if (INTRA_TOKEN_SPLIT_RE.test(rawText)) {
        INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
        fullCollapsed = rawText.replace(INTRA_TOKEN_SPLIT_RE, '');
        if (fullCollapsed && fullCollapsed !== rawText && matchesAnyPattern(fullCollapsed, patterns, liveCred)) {
            return true;
        }
    }

    // 1. Windowed whole-window percent decoding
    if (rawText.length <= SCAN_WINDOW_CHARS) {
        if (examineWindowTransforms(rawText, patterns, liveCred, depth, budget)) {
            return true;
        }
    } else {
        for (let offset = 0; offset < rawText.length; offset += SCAN_WINDOW_STEP_CHARS) {
            const windowText = rawText.slice(offset, Math.min(rawText.length, offset + SCAN_WINDOW_CHARS));
            if (examineWindowTransforms(windowText, patterns, liveCred, depth, budget)) {
                return true;
            }
            if (offset + SCAN_WINDOW_CHARS >= rawText.length) break;
        }
    }

    // 2. Percent-encoded candidate runs across the full input
    if (scanPercentRuns(rawText, patterns, liveCred, depth, budget)) {
        return true;
    }

    // 3. Base64 / Base64url candidate runs across the full input
    if (scanBase64Runs(rawText, patterns, liveCred, depth, budget)) {
        return true;
    }

    // 4. Split-collapsed percent and base64 runs across the full input (window-independent)
    if (fullCollapsed && fullCollapsed !== rawText) {
        for (const match of rawText.matchAll(SPLIT_BASE64_RUN_RE)) {
            INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
            const collapsedRun = match[0].replace(INTRA_TOKEN_SPLIT_RE, '');
            if (
                examineBase64Run(collapsedRun, patterns, liveCred, depth, budget, () => {
                    if (depth + 1 >= MAX_CREDENTIAL_DECODE_DEPTH || budget.operations >= budget.maxOperations) {
                        return false;
                    }
                    return true;
                })
            ) {
                return true;
            }
        }
        if (scanPercentRuns(fullCollapsed, patterns, liveCred, depth, budget)) {
            return true;
        }
    }

    return budget.exhausted;
}

export function containsEncodedOrRawSecret(
    value: string,
    extraPatterns: readonly RegExp[] = [],
): boolean {
    if (!value) return false;
    const patterns =
        extraPatterns.length > 0 ? [...RAW_CREDENTIAL_PATTERNS, ...extraPatterns] : RAW_CREDENTIAL_PATTERNS;
    const liveCred = getLiveSessionCredential();
    const numWindows = Math.max(1, Math.ceil(value.length / SCAN_WINDOW_STEP_CHARS));
    const budget: DecodeBudget = {
        operations: 0,
        maxOperations: numWindows * MAX_DECODE_OPS_PER_WINDOW,
        visited: new Set(),
        nonDecodableCache: new Set(),
        exhausted: false,
    };
    return checkLayerRecursive(value, patterns, liveCred, 0, budget);
}

export function containsCredentialValue(value: unknown): value is string {
    return typeof value === 'string' && containsEncodedOrRawSecret(value);
}

export function redactCredentialString(value: string): string {
    if (!value) return value;
    const liveCred = getLiveSessionCredential();
    let redacted = value;
    if (liveCred && redacted.includes(liveCred)) {
        redacted = redacted.split(liveCred).join('[REDACTED:mcp-session-credential]');
    }
    redacted = redacted
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s'"`,;]+/gi, '$1[REDACTED:bearer]')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[REDACTED:bearer]')
        .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[REDACTED:github-token]')
        .replace(/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]')
        .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]')
        .replace(/\bmcp_sess_[A-Za-z0-9._~+/-]{8,}/g, '[REDACTED:mcp-session-credential]')
        .replace(
            /\bmcp(?:\\?[\s"'`+]){0,12}_(?:\\?[\s"'`+]){0,12}sess(?:\\?[\s"'`+]){0,12}_(?:\\?[\s"'`+]){0,12}[A-Za-z0-9._~+/-]{8,}/gi,
            '[REDACTED:mcp-session-credential]',
        )
        .replace(/\b(?:adk|adm|adp|shr|wtk|wtt|wsb)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:adhdev-token]')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]')
        .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]')
        .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:api-key]')
        .replace(KEY_VALUE_CREDENTIAL_REDACT_RE, '$1[REDACTED:secret]')
        .replace(
            /([?&](?:api[_-]?key|access[_-]?key|token|secret|password|client_secret|credential|mcpSessionCredential)=)(?!\[REDACTED|\$\{)[A-Za-z0-9._~+%/-]{4,}(?=$|[&#\s'")\]};,])/gi,
            '$1[REDACTED:secret]',
        );

    if (redacted.includes('%')) {
        redacted = redacted.replace(PERCENT_ENCODED_RUN_RE, (run) => {
            if (!run.includes('%')) return run;
            if (containsEncodedOrRawSecret(run)) {
                return '[REDACTED:encoded-credential]';
            }
            return run;
        });
    }

    redacted = redacted.replace(SPLIT_BASE64_RUN_RE, (run) => {
        if (containsEncodedOrRawSecret(run)) {
            return '[REDACTED:encoded-credential]';
        }
        return run;
    });

    const nonDecodableSeen = new Set<string>();
    redacted = redacted.replace(BASE64_RUN_RE, (run) => {
        if (isUniformRepeatedChar(run) || nonDecodableSeen.has(run)) return run;
        if (run.length <= MAX_BASE64_SLICE_CHARS && !tryDecodeBase64Slice(run)) {
            if (nonDecodableSeen.size < MAX_NON_DECODABLE_CACHE_ENTRIES) {
                nonDecodableSeen.add(run);
            }
            return run;
        }
        if (containsEncodedOrRawSecret(run)) {
            return '[REDACTED:encoded-credential]';
        }
        return run;
    });

    if (containsEncodedOrRawSecret(redacted)) {
        return '[REDACTED:encoded-credential]';
    }

    return redacted;
}
