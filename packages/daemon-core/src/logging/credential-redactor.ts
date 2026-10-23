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

const PERCENT_ENCODED_RUN_RE = /(?:[A-Za-z0-9_~.-]|%[0-9A-Fa-f]{2}){10,}/g;
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

export function isCredentialKey(key: string): boolean {
    if (!key) return false;
    return CREDENTIAL_KEY_SET.has(key) || CREDENTIAL_KEY_PATTERN.test(key);
}

function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
    for (const pattern of patterns) {
        if (pattern.test(text)) return true;
    }
    return false;
}

function decodePercentLoosely(input: string): string {
    if (!input.includes('%')) return input;
    let current = input;
    for (let pass = 0; pass < 2; pass++) {
        if (!/%[0-9A-Fa-f]{2}/.test(current)) break;
        let next: string;
        try {
            next = decodeURIComponent(current);
        } catch {
            next = current.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
            );
        }
        if (next === current) break;
        current = next;
    }
    return current;
}

function tryDecodeBase64Run(candidate: string): string | null {
    if (candidate.length < 16 || candidate.length > 16_384) return null;
    const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
    const padMod = normalized.length % 4;
    if (padMod === 1) return null;
    const padded = padMod === 0 ? normalized : normalized + '='.repeat(4 - padMod);
    try {
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        if (!decoded) return null;
        return decoded;
    } catch {
        return null;
    }
}

function isDecodedSecretRun(decoded: string, patterns: readonly RegExp[]): boolean {
    if (!decoded) return false;
    if (matchesAnyPattern(decoded, patterns)) return true;
    if (decoded.includes('%')) {
        const percentDecoded = decodePercentLoosely(decoded);
        if (percentDecoded !== decoded && matchesAnyPattern(percentDecoded, patterns)) {
            return true;
        }
    }
    return false;
}

export function containsEncodedOrRawSecret(
    value: string,
    extraPatterns: readonly RegExp[] = [],
): boolean {
    if (!value) return false;
    const patterns = extraPatterns.length > 0 ? [...RAW_CREDENTIAL_PATTERNS, ...extraPatterns] : RAW_CREDENTIAL_PATTERNS;
    if (matchesAnyPattern(value, patterns)) return true;

    if (value.includes('%')) {
        const wholeDecoded = decodePercentLoosely(value);
        if (wholeDecoded !== value && matchesAnyPattern(wholeDecoded, patterns)) {
            return true;
        }
        for (const match of value.matchAll(PERCENT_ENCODED_RUN_RE)) {
            const run = match[0];
            if (!run.includes('%')) continue;
            const decoded = decodePercentLoosely(run);
            if (decoded !== run && isDecodedSecretRun(decoded, patterns)) {
                return true;
            }
        }
    }

    for (const match of value.matchAll(BASE64_RUN_RE)) {
        const run = match[0];
        const decoded = tryDecodeBase64Run(run);
        if (decoded && isDecodedSecretRun(decoded, patterns)) {
            return true;
        }
    }

    return false;
}

export function containsCredentialValue(value: unknown): value is string {
    return typeof value === 'string' && containsEncodedOrRawSecret(value);
}

export function redactCredentialString(value: string): string {
    if (!value) return value;
    let redacted = value
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s'"`,;]+/gi, '$1[REDACTED:bearer]')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[REDACTED:bearer]')
        .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[REDACTED:github-token]')
        .replace(/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]')
        .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]')
        .replace(/\bmcp_sess_[A-Za-z0-9._~+/-]{8,}/g, '[REDACTED:mcp-session-credential]')
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
            const decoded = decodePercentLoosely(run);
            if (decoded !== run && isDecodedSecretRun(decoded, RAW_CREDENTIAL_PATTERNS)) {
                return '[REDACTED:encoded-credential]';
            }
            return run;
        });
    }

    redacted = redacted.replace(BASE64_RUN_RE, (run) => {
        const decoded = tryDecodeBase64Run(run);
        if (decoded && isDecodedSecretRun(decoded, RAW_CREDENTIAL_PATTERNS)) {
            return '[REDACTED:encoded-credential]';
        }
        return run;
    });

    return redacted;
}
