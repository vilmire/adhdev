/**
 * Shared credential and bearer-token redactor used across:
 *   - command history logging (`command-log.ts`),
 *   - runtime debug trace (`debug-trace.ts`, including `traceContent=true`),
 *   - chat debug bundle sanitizer (`chat-commands-debug-bundle.ts`, inline & `daemon_file`),
 *   - artifact secret content scanner (`artifact-path-guard.ts`).
 */

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

const RAW_CREDENTIAL_PATTERNS: readonly RegExp[] = [
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    /\bmcp_sess_[A-Za-z0-9._~+/-]{8,}/,
    /\bmcp(?:\\?[\s"'`+._-]){0,12}sess_?(?:\\?[\s"'`+._-]){0,12}[A-Za-z0-9._~+/-]{8,}/i,
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
    /(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|client[_-]?secret|mcpSessionCredential|sessionCredential|connectionToken)\s*["']?\s*[:=]\s*["']?(?!\[REDACTED)[^\s,'"`}&;]{6,}/i,
    /[?&](?:api[_-]?key|access[_-]?key|token|secret|password|client_secret|credential|mcpSessionCredential)=(?!\[REDACTED)[^&#\s]+/i,
];

const PERCENT_ENCODED_RUN_RE = /(?<![A-Za-z0-9+/_~=%-])(?:[A-Za-z0-9+/_~=-]|%[0-9A-Fa-f]{2}){10,}/g;
const BASE64_RUN_RE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{12,}={0,2}/g;
const SPLIT_BASE64_RUN_RE =
    /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{4,}(?![A-Za-z0-9+/_-])(?:(?:\\[rnt]|[\r\n\t]+|(?:\\?["'`])\s*(?:\+\s*)?(?:\\?["'`]))[A-Za-z0-9+/_-]{4,}(?![A-Za-z0-9+/_-]))+={0,2}/g;
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

function tryDecodeBase64Slice(candidate: string): string | null {
    if (candidate.length < 12 || candidate.length > MAX_BASE64_SLICE_CHARS) return null;
    const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
    const padMod = normalized.length % 4;
    if (padMod === 1) return null;
    const padded = padMod === 0 ? normalized : normalized + '='.repeat(4 - padMod);
    try {
        const buf = Buffer.from(padded, 'base64');
        if (buf.byteLength < 6) return null;
        const sampleBytes = Math.min(buf.byteLength, 512);
        for (let i = 0; i < sampleBytes; i++) {
            const b = buf[i]!;
            if (
                (b >= 0x00 && b <= 0x08) ||
                b === 0x0b ||
                b === 0x0c ||
                (b >= 0x0e && b <= 0x1f) ||
                b === 0x7f
            ) {
                return null;
            }
        }
        const decoded = buf.toString('utf8');
        if (!isPlausibleDecodedText(decoded)) return null;
        return decoded;
    } catch {
        return null;
    }
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

function examineBase64Run(
    run: string,
    patterns: readonly RegExp[],
    liveCred: string,
    depth: number,
    budget: DecodeBudget,
    onDecodedCandidate: () => boolean,
): boolean {
    if (isUniformRepeatedChar(run)) return false;
    if (run.length <= MAX_BASE64_SLICE_CHARS && budget.nonDecodableCache.has(run)) {
        return false;
    }
    let anyDecoded = false;
    for (const slice of iterateBase64Slices(run)) {
        if (budget.nonDecodableCache.has(slice)) continue;
        const decoded = tryDecodeBase64Slice(slice);
        if (!decoded) {
            rememberNonDecodable(budget, slice);
            continue;
        }
        anyDecoded = true;
        if (!onDecodedCandidate()) {
            budget.exhausted = true;
            return true;
        }
        if (checkLayerRecursive(decoded, patterns, liveCred, depth + 1, budget)) {
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
    let collapsed = '';
    INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
    if (INTRA_TOKEN_SPLIT_RE.test(windowText)) {
        INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
        collapsed = windowText.replace(INTRA_TOKEN_SPLIT_RE, '');
        if (collapsed && collapsed !== windowText && matchesAnyPattern(collapsed, patterns, liveCred)) {
            return true;
        }
    }

    if (windowText.includes('%') && /%[0-9A-Fa-f]{2}/.test(windowText)) {
        if (depth >= MAX_CREDENTIAL_DECODE_DEPTH || budget.operations >= budget.maxOperations) {
            budget.exhausted = true;
            return true;
        }
        budget.operations++;
        const wholeDecoded = decodeOnePercentLayer(windowText);
        if (wholeDecoded !== windowText) {
            if (matchesAnyPattern(wholeDecoded, patterns, liveCred)) {
                return true;
            }
            if (wholeDecoded.includes('%') && /%[0-9A-Fa-f]{2}/.test(wholeDecoded)) {
                if (checkLayerRecursive(wholeDecoded, patterns, liveCred, depth + 1, budget)) {
                    return true;
                }
            } else {
                let b64Count = 0;
                const maxSubCandidates =
                    depth === 0 ? MAX_DECODABLE_CANDIDATES_PER_WINDOW : MAX_CANDIDATE_RUNS_PER_SUBLAYER;
                for (const match of wholeDecoded.matchAll(BASE64_RUN_RE)) {
                    const run = match[0];
                    if (
                        examineBase64Run(run, patterns, liveCred, depth + 1, budget, () => {
                            if (
                                depth + 1 >= MAX_CREDENTIAL_DECODE_DEPTH ||
                                ++b64Count > maxSubCandidates ||
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
            }
        }
    }

    if (collapsed && collapsed !== windowText) {
        let collapsedCount = 0;
        const maxSubCandidates =
            depth === 0 ? MAX_DECODABLE_CANDIDATES_PER_WINDOW : MAX_CANDIDATE_RUNS_PER_SUBLAYER;
        for (const match of collapsed.matchAll(BASE64_RUN_RE)) {
            const run = match[0];
            if (
                examineBase64Run(run, patterns, liveCred, depth, budget, () => {
                    if (
                        depth >= MAX_CREDENTIAL_DECODE_DEPTH ||
                        ++collapsedCount > maxSubCandidates ||
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

    const visitKey = `${depth}:${rawText.length}:${rawText.slice(0, 128)}:${rawText.slice(-64)}`;
    if (budget.visited.has(visitKey)) return false;
    budget.visited.add(visitKey);
    budget.operations++;

    // 1. Windowed transforms (intra-token split collapse + whole-window percent decoding)
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
    if (rawText.includes('%') && /%[0-9A-Fa-f]{2}/.test(rawText)) {
        let pctCount = 0;
        let currentWindowIdx = 0;
        const maxPerScope =
            depth === 0 ? MAX_DECODABLE_CANDIDATES_PER_WINDOW : MAX_CANDIDATE_RUNS_PER_SUBLAYER;
        for (const match of rawText.matchAll(PERCENT_ENCODED_RUN_RE)) {
            const run = match[0];
            if (!run.includes('%') || !/%[0-9A-Fa-f]{2}/.test(run) || run === rawText) continue;
            if (depth === 0) {
                const winIdx = Math.floor((match.index ?? 0) / SCAN_WINDOW_STEP_CHARS);
                if (winIdx !== currentWindowIdx) {
                    currentWindowIdx = winIdx;
                    pctCount = 0;
                }
            }
            const decodedRun = decodeOnePercentLayer(run);
            if (decodedRun === run) continue;
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
    }

    // 3. Base64 / Base64url candidate runs across the full input
    let b64Count = 0;
    let currentWindowIdx = 0;
    const maxPerScope =
        depth === 0 ? MAX_DECODABLE_CANDIDATES_PER_WINDOW : MAX_CANDIDATE_RUNS_PER_SUBLAYER;
    for (const match of rawText.matchAll(BASE64_RUN_RE)) {
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
            /\bmcp(?:\\?[\s"'`+._-]){0,12}sess_?(?:\\?[\s"'`+._-]){0,12}[A-Za-z0-9._~+/-]{8,}/gi,
            '[REDACTED:mcp-session-credential]',
        )
        .replace(/\b(?:adk|adm|adp|shr|wtk|wtt|wsb)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:adhdev-token]')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]')
        .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]')
        .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:api-key]')
        .replace(
            /((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|client[_-]?secret|mcpSessionCredential|sessionCredential|connectionToken|ADHDEV_MCP_SESSION_CREDENTIAL)\s*["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s,'"`}&;]+/gi,
            '$1[REDACTED:secret]',
        )
        .replace(
            /([?&](?:api[_-]?key|access[_-]?key|token|secret|password|client_secret|credential|mcpSessionCredential)=)(?!\[REDACTED)[^&#\s]+/gi,
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
