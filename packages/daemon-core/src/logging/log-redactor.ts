/**
 * Log redactor — mask secrets before a raw daemon log line leaves the machine.
 *
 * Daemon logs can incidentally contain credentials: ADHDev API keys (adk_*),
 * machine secrets (adm_*), provider keys (adp_*), bearer tokens, JWTs, TURN
 * `username:credential` pairs, and `SECRET=...` style env dumps. The mesh
 * `get_mesh_node_logs` command ships a log tail over P2P to the coordinator, so
 * every line MUST pass through redactLogLine() first — otherwise a secret in a
 * remote daemon's log is exfiltrated to whoever is driving the coordinator.
 *
 * Patterns are intentionally conservative: each masks the secret material while
 * preserving enough surrounding shape that the line stays useful for debugging
 * (e.g. `adk_••••1234`, `Bearer ••••redacted`). When in doubt, mask.
 */

const MASK = '••••redacted';

/** Keep the last 4 chars of a token so logs stay correlatable without leaking it. */
function maskKeepTail(token: string): string {
    if (token.length <= 8) return MASK;
    return `${MASK}${token.slice(-4)}`;
}

interface RedactionRule {
    readonly name: string;
    readonly pattern: RegExp;
    readonly replace: (match: string, ...groups: string[]) => string;
}

// NOTE: order matters — more specific rules (key=value, Bearer, TURN) run before
// the bare-token rules so the structured forms aren't half-masked by a greedy
// generic rule.
const RULES: RedactionRule[] = [
    // `JWT_SECRET=...`, `TOKEN=...`, `API_KEY=...`, `password: ...` env/config dumps.
    // Captures the key + delimiter and masks only the value.
    {
        name: 'key_value_secret',
        pattern: /\b([A-Z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|CLIENT[_-]?SECRET)[A-Z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"',;]+)\3/gi,
        replace: (_m, key: string, delim: string, quote: string) => `${key}${delim}${quote}${MASK}${quote}`,
    },
    // Authorization: Bearer <token>
    {
        name: 'bearer_token',
        pattern: /\b(Bearer\s+)([A-Za-z0-9._\-+/=]{8,})/g,
        replace: (_m, prefix: string, token: string) => `${prefix}${maskKeepTail(token)}`,
    },
    // ADHDev credential prefixes: API key (adk_), machine secret (adm_), provider key (adp_).
    {
        name: 'adhdev_prefixed_secret',
        pattern: /\b(ad[kmp]_)([A-Za-z0-9]{6,})/g,
        replace: (_m, prefix: string, token: string) => `${prefix}${maskKeepTail(prefix + token)}`,
    },
    // JWT: three base64url segments separated by dots, header starts with eyJ.
    {
        name: 'jwt',
        pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
        replace: () => MASK,
    },
    // TURN credential: a long credential value following a `credential` key in
    // any common shape — `credential: x`, `credential=x`, or `credential "x"`.
    // Mask the credential value only, preserving the key + delimiter/quote.
    {
        name: 'turn_credential',
        pattern: /\b(credential["']?\s*(?:[:=]\s*)?["']?)([^\s"',;]{6,})/gi,
        replace: (_m, prefix: string) => `${prefix}${MASK}`,
    },
    // TURN REST username:credential of the form `<expiry-ts>:<base64hmac>`,
    // where the hmac part is long base64. Mask the hmac.
    {
        name: 'turn_rest_pair',
        pattern: /\b(\d{10,}:)([A-Za-z0-9+/]{20,}={0,2})\b/g,
        replace: (_m, prefix: string) => `${prefix}${MASK}`,
    },
];

/**
 * Mask secrets in a single log line. Idempotent-ish: re-running over an
 * already-masked line leaves the MASK token in place (it contains no secret
 * shape). Never throws — a redaction failure must not crash the log path.
 */
export function redactLogLine(line: string): string {
    if (!line) return line;
    let out = line;
    for (const rule of RULES) {
        try {
            out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: any[]) => string);
        } catch {
            // A pathological line must never break log shipping — skip this rule.
        }
    }
    return out;
}

/** Redact an array of log lines in place-safe fashion (returns a new array). */
export function redactLogLines(lines: string[]): string[] {
    return lines.map((line) => redactLogLine(line));
}

/** Exposed for tests/introspection: the rule names applied, in order. */
export const LOG_REDACTION_RULE_NAMES: readonly string[] = RULES.map((r) => r.name);
