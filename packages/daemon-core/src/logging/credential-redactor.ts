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

const PERCENT_ENCODED_RUN_RE = /(?:[A-Za-z0-9+/_~=-]|%[0-9A-Fa-f]{2}){10,}/g;
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{12,}={0,2}/g;
const SPLIT_BASE64_RUN_RE =
    /[A-Za-z0-9+/_-]{4,}(?:(?:\\[rnt]|[\r\n\t]+|(?:\\?["'`])\s*(?:\+\s*)?(?:\\?["'`]))[A-Za-z0-9+/_-]{4,})+={0,2}/g;
const INTRA_TOKEN_SPLIT_RE =
    /(?:\\[rnt]|[\r\n\t])+|(?:\\?["'`])\s*(?:\+\s*)?(?:\\?["'`])|\\(?:\r?\n)/g;

export const MAX_CREDENTIAL_DECODE_DEPTH = 4;
const MAX_SCAN_INPUT_CHARS = 65_536;
const MAX_COLLAPSE_CHARS = 16_384;
const MAX_DECODE_OPERATIONS = 256;
const MAX_CANDIDATE_RUNS_PER_LAYER = 64;

interface DecodeBudget {
    operations: number;
    visited: Set<string>;
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
        if (code >= 0x20 && code <= 0x7e) {
            asciiPrintable++;
        }
    }
    return asciiPrintable >= 4;
}

function tryDecodeBase64Run(candidate: string): string | null {
    if (candidate.length < 12 || candidate.length > 16_384) return null;
    const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
    const padMod = normalized.length % 4;
    if (padMod === 1) return null;
    const padded = padMod === 0 ? normalized : normalized + '='.repeat(4 - padMod);
    try {
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        if (!isPlausibleDecodedText(decoded)) return null;
        return decoded;
    } catch {
        return null;
    }
}

function checkLayerRecursive(
    rawText: string,
    patterns: readonly RegExp[],
    liveCred: string,
    depth: number,
    budget: DecodeBudget,
): boolean {
    if (!rawText || budget.operations >= MAX_DECODE_OPERATIONS) return false;
    const text = rawText.length > MAX_SCAN_INPUT_CHARS ? rawText.slice(0, MAX_SCAN_INPUT_CHARS) : rawText;
    const visitKey = `${depth}:${text.length}:${text.slice(0, 128)}:${text.slice(-64)}`;
    if (budget.visited.has(visitKey)) return false;
    budget.visited.add(visitKey);
    budget.operations++;

    if (matchesAnyPattern(text, patterns, liveCred)) return true;

    let collapsed = '';
    if (text.length <= MAX_COLLAPSE_CHARS && INTRA_TOKEN_SPLIT_RE.test(text)) {
        INTRA_TOKEN_SPLIT_RE.lastIndex = 0;
        collapsed = text.replace(INTRA_TOKEN_SPLIT_RE, '');
        if (collapsed && collapsed !== text && matchesAnyPattern(collapsed, patterns, liveCred)) {
            return true;
        }
    }

    if (depth >= MAX_CREDENTIAL_DECODE_DEPTH || budget.operations >= MAX_DECODE_OPERATIONS) {
        return false;
    }

    // 1. Percent-encoding transitions (whole string + candidate percent runs)
    if (text.includes('%')) {
        const wholeDecoded = decodeOnePercentLayer(text);
        if (
            wholeDecoded !== text &&
            checkLayerRecursive(wholeDecoded, patterns, liveCred, depth + 1, budget)
        ) {
            return true;
        }
        let pctCount = 0;
        for (const match of text.matchAll(PERCENT_ENCODED_RUN_RE)) {
            if (++pctCount > MAX_CANDIDATE_RUNS_PER_LAYER || budget.operations >= MAX_DECODE_OPERATIONS) break;
            const run = match[0];
            if (!run.includes('%') || run === text) continue;
            const decodedRun = decodeOnePercentLayer(run);
            if (
                decodedRun !== run &&
                checkLayerRecursive(decodedRun, patterns, liveCred, depth + 1, budget)
            ) {
                return true;
            }
        }
    }

    // 2. Base64 / Base64url transitions (contiguous runs + collapsed split runs)
    let b64Count = 0;
    for (const match of text.matchAll(BASE64_RUN_RE)) {
        if (++b64Count > MAX_CANDIDATE_RUNS_PER_LAYER || budget.operations >= MAX_DECODE_OPERATIONS) break;
        const run = match[0];
        const decoded = tryDecodeBase64Run(run);
        if (decoded && checkLayerRecursive(decoded, patterns, liveCred, depth + 1, budget)) {
            return true;
        }
    }

    if (collapsed && collapsed !== text && budget.operations < MAX_DECODE_OPERATIONS) {
        let collapsedCount = 0;
        for (const match of collapsed.matchAll(BASE64_RUN_RE)) {
            if (++collapsedCount > 16 || budget.operations >= MAX_DECODE_OPERATIONS) break;
            const run = match[0];
            const decoded = tryDecodeBase64Run(run);
            if (decoded && checkLayerRecursive(decoded, patterns, liveCred, depth + 1, budget)) {
                return true;
            }
        }
    }

    return false;
}

export function containsEncodedOrRawSecret(
    value: string,
    extraPatterns: readonly RegExp[] = [],
): boolean {
    if (!value) return false;
    const patterns =
        extraPatterns.length > 0 ? [...RAW_CREDENTIAL_PATTERNS, ...extraPatterns] : RAW_CREDENTIAL_PATTERNS;
    const liveCred = getLiveSessionCredential();
    const budget: DecodeBudget = { operations: 0, visited: new Set() };
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

    redacted = redacted.replace(BASE64_RUN_RE, (run) => {
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
