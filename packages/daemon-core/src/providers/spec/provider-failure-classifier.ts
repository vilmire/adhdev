// See the matching helper in cli-adapters/provider-cli-shared.ts for the full
// rationale. Kept as a separate copy deliberately: `check:boundaries` forbids a
// value import between providers/ and cli-adapters/, so sharing it would mean
// breaking a layer boundary to save a few lines.
// eslint-disable-next-line no-control-regex
const ANSI_OSC_DCS_RE = /\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Strip ANSI escape sequences. Byte-for-byte identical to the previous
 * three-pass chain. The CSI pass stays last and separate because deleting an
 * OSC/DCS can leave a dangling `ESC[` newly adjacent to following text, which
 * only a fresh scan will then match; a fused alternation advances past that
 * position and never revisits it.
 */
export function stripAnsi(text: string): string {
    const s = String(text || '');
    if (s.indexOf('\x1B') === -1) return s;
    return s.replace(ANSI_OSC_DCS_RE, '').replace(ANSI_CSI_RE, '');
}

/** Canonical auth-failure copy (see the SELF-MATCH GUARD in detectProviderFailure). */
const AUTH_FAILURE_MESSAGE = 'Provider credential was rejected by the CLI. Re-authenticate this CLI in this environment before retrying.';

export interface ProviderFailure {
    errorReason: 'auth_failed' | 'billing_failed' | 'quota_exceeded';
    failureKind: 'auth' | 'billing' | 'quota';
    message: string;
}

/**
 * Provider failure classifier (formerly `kimi-auth-billing.ts` /
 * `detectKimiAuthBillingFailure`, renamed 2026-09-22 — the kimi-only name had
 * been false since AUTH-EXPIRY-GENERALIZATION made the AUTH axis serve every
 * spec CLI, and the misnomer hid that blast radius in review).
 *
 * Scope per axis: AUTH wording is provider-neutral and admitted for every spec
 * CLI; BILLING and QUOTA wording is Kimi's entitlement vocabulary and is
 * admitted for kimi only. That admission rule, and what the daemon may DO about
 * a match (live = suspicion/advisory, exit = verdict), is live-auth-advisory.ts;
 * this file only answers "does this text look like a provider failure?".
 *
 * KIMI-AUTH-BILLING-LIVE: classify only strong failure markers.
 *
 * Spec-backed CLIs run inside one PTY, so stdout and stderr are intentionally
 * merged by node-pty. The live adapter therefore retains a small output tail
 * and applies this classifier both as chunks arrive and when the process exits.
 * A bare 403 is deliberately absent, and so is a bare `[provider.auth_error]`
 * tag: Kimi answers 403 for managed-usage exhaustion as well as for real
 * authorization faults, so the verdict comes from the accompanying entitlement
 * wording, exactly as the quota fetcher decides it from the response body. That
 * is why the live line "[provider.auth_error] 403 You've reached your 5-hour
 * usage limit" classifies as QUOTA exhaustion rather than billing or auth —
 * misreading it as auth would send an operator to re-login against a credential
 * that is actually fine, and misreading it as billing (an incident fixed
 * 2026-08-29: the classifier folded quota wording into the billing bucket and
 * told the operator to "renew the subscription" when the account was current
 * and merely rate-limited by usage) suppresses automatic recovery FOREVER for a
 * condition that heals on its own once the window resets. Billing stays a
 * separate, genuinely non-retryable bucket for wording that names the account
 * itself as the problem (expired/cancelled subscription, payment required,
 * insufficient credits) rather than a spent usage window.
 * Canonical messages never echo the raw PTY tail (which may contain credentials
 * or user data).
 */
/**
 * True when the tail carries a machine-emitted provider failure envelope, as
 * opposed to prose that merely mentions limits. This is the live-PTY stand-in
 * for the quota fetcher's "we already know this is a 403" precondition: it is
 * what separates the incident line "[provider.auth_error] 403 You've reached
 * your 5-hour usage limit" from an agent narrating the quota source file.
 */
function hasProviderFailureEnvelope(text: string): boolean {
    return /\bprovider\.[a-z_]*error\b/.test(text)
        || /\b(?:http\s*)?(?:40[23])\b\s*(?:[-:—]|\bforbidden\b|\bpayment\b|you\b|your\b)/.test(text)
        || /\bstatus(?:\s+code)?\s*[:=]?\s*40[23]\b/.test(text);
}

const CLEAR_PROVIDER_CHROME_RE = /^[ \t]*(?:[⏺✻✢✳✶✽✷✸✹❯›](?:\s|$)|─{10,}[ \t]*$)/;
const SIGN_IN_SCREEN_HEADER_RE = /^[ \t]*(?:[╭╰┌└┏┗│┃]|[›❯>▸]\s*(?:\d+\.\s*)?(?:Sign in|API key login is disabled|Press Enter to sign in)|(?:Claude Code\b|Welcome to (?:Claude Code|Cursor Agent|Grok CLI|Antigravity CLI)\b|Select login method:|Anthropic Console account\b|How do you want to sign in\?|Opening browser to sign in|Cloud gateway\s*[·•]\s*sign in\b|Browser didn't open\?|Paste code here if prompted\s*>|Sign in with ChatGPT to use Codex\b|Finish signing in via your browser\b|Preparing device code login\b|Use your own OpenAI API key\b|Paste or type your API key below\b|(?:Welcome back!\s+)?You are currently not signed in\.|Select Google Cloud sign-in method:|Authentication required\.\s+Please visit the URL to log in:|If you aren't automatically redirected, paste the authorization code below:|Signing in(?:\s+to your Google account)?(?:\.{3}|…)?|Cursor Agent\b|Sign in required\b|Signing in with the browser\b|If your browser didn't open,\s*click this link to log in:|Press q to show a QR code to log in\b|Press Enter to sign in\b|Sign in to Grok Build\b|Approve in your browser\b|Waiting for approval\.\.\.|Paste your xAI API key\b|Enter your (?:xAI )?API key\b|Sign in to Kimi Code\b|Visit the URL below in your browser to authorize:|Verification code:\s+[A-Z0-9-]+|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Waiting for authorization|Your key will be saved to [^\n]*config\.toml))/i;
const TOOL_HEADER_LINE_RE = /^[ \t]*[⏺●•]\s+(?:Bash|Read|Edit|Write|Grep|Glob|LS|Task|MultiEdit|NotebookEdit|WebFetch|WebSearch|Ran|Explored|Edited|Wrote)\b/;
const CLAUDE_ERROR_ENVELOPE_LINE_RE = /^[ \t]*⏺\s+api\s+error\s*:\s*(?:(?:http\s*)?40[123]\b|[^\n]*(?:"authentication_error"|"token_revoked"|"invalid_api_key"|"token_expired"|"invalid_token"))/i;
const TRUNCATED_OUTPUT_LINE_RE = /^[ \t]*(?:…|\.\.\.)\s+\+\d+\s+lines\b/i;
const STRONG_TURN_BOUNDARY_LINE_RE = /^[ \t]{0,2}(?:⏺(?:\s|$)|[✻✢✳✶✽✷✸✹](?:\s|$))/;
const COMPOSER_DIVIDER_LINE_RE = /^[ \t]*─{10,}[ \t]*$/;
const COL0_COMPOSER_DIVIDER_LINE_RE = /^─{10,}[ \t]*$/;
const COMPOSER_PROMPT_LINE_RE = /^[ \t]*[❯›>](?:\s|$)/;
const MAX_OPEN_BLOCK_SPAN_LINES = 40;
const MAX_CLOSED_BLOCK_LOOKAHEAD_LINES = 512;

function findMatchingClosingFence(lines: string[], openIdx: number, ch: '`' | '~', openLen = 3): number {
    const closeRe = new RegExp(`^${ch}{${openLen},}\\s*$`);
    for (let j = openIdx + 1; j < lines.length; j += 1) {
        const candidate = lines[j];
        if (TRUNCATED_OUTPUT_LINE_RE.test(candidate)) {
            return -1;
        }
        if (closeRe.test(candidate.trim())) {
            return j;
        }
    }
    return -1;
}

function findClosedDiffHunkEnd(lines: string[], openIdx: number): number {
    const headerMatch = lines[openIdx].trim().match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    const expectedOld = headerMatch ? Number(headerMatch[2] ?? 1) : 0;
    const expectedNew = headerMatch ? Number(headerMatch[4] ?? 1) : 0;
    let oldSeen = 0;
    let newSeen = 0;
    let sawDiffChange = false;
    let lastDiffIdx = -1;
    const limit = Math.min(lines.length, openIdx + 1 + MAX_CLOSED_BLOCK_LOOKAHEAD_LINES);
    for (let j = openIdx + 1; j < limit; j += 1) {
        const candidate = lines[j];
        const trimmed = candidate.trim();
        if (
            TRUNCATED_OUTPUT_LINE_RE.test(candidate)
            || STRONG_TURN_BOUNDARY_LINE_RE.test(candidate)
            || TOOL_HEADER_LINE_RE.test(candidate)
            || (
                COL0_COMPOSER_DIVIDER_LINE_RE.test(candidate)
                && j + 1 < lines.length
                && COMPOSER_PROMPT_LINE_RE.test(lines[j + 1])
            )
        ) {
            return expectedOld > 0 && expectedNew > 0 && oldSeen >= expectedOld && newSeen >= expectedNew
                ? lastDiffIdx
                : -1;
        }
        if (/^(?:diff --git\b|index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|---\s+\S|\+\+\+\s+\S|@@\s+-\d+|```+|~~~+)/i.test(trimmed)) {
            return (oldSeen > 0 || newSeen > 0) ? lastDiffIdx : -1;
        }
        if (candidate.startsWith('+')) {
            newSeen += 1;
            sawDiffChange = true;
            lastDiffIdx = j;
            continue;
        }
        if (candidate.startsWith('-')) {
            oldSeen += 1;
            sawDiffChange = true;
            lastDiffIdx = j;
            continue;
        }
        if (candidate.startsWith(' ')) {
            if (expectedOld > 0 && expectedNew > 0 && oldSeen >= expectedOld && newSeen >= expectedNew && SIGN_IN_SCREEN_HEADER_RE.test(candidate)) {
                break;
            }
            oldSeen += 1;
            newSeen += 1;
            lastDiffIdx = j;
            continue;
        }
        if (candidate.startsWith('\\ No newline')) {
            lastDiffIdx = j;
            continue;
        }
        break;
    }
    if (lastDiffIdx === -1 || !sawDiffChange) return -1;
    return lastDiffIdx;
}

/**
 * Strip lines that are clearly tool-result blocks, diffs, line-numbered file
 * dumps, code comments, JSON properties, or unit-test assertions so code/tool
 * output containing "401", "Unauthorized", or "not signed in" cannot trigger
 * live provider failure suspicions.
 */
export function stripToolAndCodeLines(raw: string): string {
    let inToolBlock = false;
    let inAssistantProseBlock = false;
    let inFence: '`' | '~' | null = null;
    let inFenceLen = 0;
    let fenceCloseIdx = -1;
    let fenceLines = 0;
    let inDiffHunk = false;
    let diffHunkCloseIdx = -1;
    let diffHunkLines = 0;
    const out: string[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (inFence !== null && fenceCloseIdx !== -1) {
            if (i < fenceCloseIdx) {
                continue;
            }
            inFence = null;
            inFenceLen = 0;
            fenceCloseIdx = -1;
            fenceLines = 0;
            continue;
        }
        if (inDiffHunk && diffHunkCloseIdx !== -1) {
            if (i <= diffHunkCloseIdx) {
                continue;
            }
            inDiffHunk = false;
            diffHunkCloseIdx = -1;
            diffHunkLines = 0;
        }
        if (TRUNCATED_OUTPUT_LINE_RE.test(line)) {
            inFence = null;
            inFenceLen = 0;
            fenceCloseIdx = -1;
            fenceLines = 0;
            inDiffHunk = false;
            diffHunkCloseIdx = -1;
            diffHunkLines = 0;
            inToolBlock = false;
            inAssistantProseBlock = false;
            continue;
        }
        const fenceMatch = trimmed.match(/^(```+|~~~+)/);
        if (fenceMatch) {
            const ch = fenceMatch[1][0] as '`' | '~';
            const fenceLen = fenceMatch[1].length;
            if (inFence === null) {
                inFence = ch;
                inFenceLen = fenceLen;
                fenceCloseIdx = findMatchingClosingFence(lines, i, ch, fenceLen);
                fenceLines = 0;
                inDiffHunk = false;
                diffHunkCloseIdx = -1;
                diffHunkLines = 0;
                inAssistantProseBlock = false;
                continue;
            }
            if (inFence === ch && fenceLen >= inFenceLen && new RegExp(`^${ch}{${inFenceLen},}\\s*$`).test(trimmed)) {
                inFence = null;
                inFenceLen = 0;
                fenceCloseIdx = -1;
                fenceLines = 0;
                continue;
            }
        }
        if (inFence !== null) {
            const isStrongTurnBoundary = STRONG_TURN_BOUNDARY_LINE_RE.test(line) || TOOL_HEADER_LINE_RE.test(line);
            const isComposerBoundary = COMPOSER_DIVIDER_LINE_RE.test(line)
                && i + 1 < lines.length
                && COMPOSER_PROMPT_LINE_RE.test(lines[i + 1]);
            fenceLines += 1;
            if (isStrongTurnBoundary || isComposerBoundary || fenceLines > MAX_OPEN_BLOCK_SPAN_LINES) {
                inFence = null;
                inFenceLen = 0;
                fenceCloseIdx = -1;
                fenceLines = 0;
            } else {
                continue;
            }
        }
        if (/^(?:diff --git\b|index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|---\s+\S|\+\+\+\s+\S)/i.test(trimmed)) {
            inDiffHunk = false;
            diffHunkCloseIdx = -1;
            diffHunkLines = 0;
            inAssistantProseBlock = false;
            continue;
        }
        if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(trimmed)) {
            inDiffHunk = true;
            diffHunkCloseIdx = findClosedDiffHunkEnd(lines, i);
            diffHunkLines = 0;
            inAssistantProseBlock = false;
            continue;
        }
        if (inDiffHunk) {
            const isStrongTurnBoundary = STRONG_TURN_BOUNDARY_LINE_RE.test(line) || TOOL_HEADER_LINE_RE.test(line);
            const isComposerBoundary = COL0_COMPOSER_DIVIDER_LINE_RE.test(line)
                && i + 1 < lines.length
                && COMPOSER_PROMPT_LINE_RE.test(lines[i + 1]);
            diffHunkLines += 1;
            if (isStrongTurnBoundary || isComposerBoundary || SIGN_IN_SCREEN_HEADER_RE.test(line) || diffHunkLines > MAX_OPEN_BLOCK_SPAN_LINES) {
                inDiffHunk = false;
                diffHunkCloseIdx = -1;
                diffHunkLines = 0;
            } else if (/^(?:[ +-]|\\ No newline)/.test(line)) {
                continue;
            } else {
                inDiffHunk = false;
                diffHunkCloseIdx = -1;
                diffHunkLines = 0;
            }
        }
        if (CLEAR_PROVIDER_CHROME_RE.test(line)) {
            inToolBlock = false;
            inAssistantProseBlock = false;
            if (TOOL_HEADER_LINE_RE.test(line)) {
                inToolBlock = true;
                continue;
            }
            if (/^[ \t]*⏺(?:\s|$)/.test(line) && !CLAUDE_ERROR_ENVELOPE_LINE_RE.test(line)) {
                inAssistantProseBlock = true;
                continue;
            }
        }
        if (!trimmed) {
            inAssistantProseBlock = false;
            continue;
        }
        if (/^(?:⎿|[└├](?:─(?!─))?\s)/.test(trimmed) || TOOL_HEADER_LINE_RE.test(line)) {
            inToolBlock = true;
            inAssistantProseBlock = false;
            continue;
        }
        if (inToolBlock) {
            if (/^[ \t]{2,}/.test(line) && !CLEAR_PROVIDER_CHROME_RE.test(line)) {
                continue;
            }
            inToolBlock = false;
        }
        if (inAssistantProseBlock) {
            if (
                /^[ \t]{2,}/.test(line)
                && !CLEAR_PROVIDER_CHROME_RE.test(line)
                && !CLAUDE_ERROR_ENVELOPE_LINE_RE.test(line)
                && !SIGN_IN_SCREEN_HEADER_RE.test(line)
            ) {
                continue;
            }
            inAssistantProseBlock = false;
        }
        if (/^(?:(?!40[123]\b)\d+\s*[:→│]\s|[+-]\s+\S)/.test(trimmed)) continue;
        if (/^(?:\/\/|\/\*|\*\s)/.test(trimmed)) continue;
        if (/^(?:"[^"]+"\s*:|(?:const|let|var|function|return|throw)\s+\S|(?:if|else\s+if|expect|it|test|describe|assert)\s*(?:\(|\.[a-z]+\s*\())/.test(trimmed)) continue;
        out.push(line);
    }
    return out.join('\n');
}

export function detectProviderFailure(output: string, _exitCode?: number): ProviderFailure | null {
    const stripped = stripAnsi(output).replace(/\r\n?/g, '\n');
    const filtered = stripToolAndCodeLines(stripped);
    const linesText = filtered.replace(/[ \t]+/g, ' ').trim().toLowerCase();
    const text = linesText.replace(/\s+/g, ' ').trim();
    if (!text) return null;

    // Entitlement EXHAUSTION — the account is fine, the usage window is spent.
    // The wording mirrors the quota fetcher's USAGE_LIMIT_BODY_PATTERN
    // (quota/fetchers/kimi.ts) so the live path and the polled path agree on
    // what "the plan is spent" looks like, but it is NOT reused verbatim: the
    // fetcher matches an HTTP error body already known to be a 403, whereas
    // this scans merged PTY output from a coding agent that frequently
    // *discusses* quota code ("reading kimi.ts to understand the usage limit
    // pattern"). Bare limit wording is therefore not sufficient — it must be
    // carried by an actual provider failure envelope (a provider error tag or
    // an HTTP 403/402 status), which is the structural equivalent of the
    // fetcher's status precondition.
    //
    // Kimi states the limit as a rolling window ("your 5-hour usage limit") as
    // well as per cycle ("usage limit for this billing cycle"), and the
    // qualifier sits between the noun and "limit", so the reached/exceeded verb
    // stays optional after it. This bucket is checked BEFORE billing so a
    // usage-limit envelope never falls through into the non-retryable bucket
    // below — the incident this file exists to prevent.
    const quota = hasProviderFailureEnvelope(text) && [
        /\b(?:usage|quota|credit)\s+limit\b/,
        /\bquota\s*(?:exhausted|refresh)/,
        /\bbilling\s+cycle\b/,
    ].some(pattern => pattern.test(text));
    if (quota) {
        return {
            errorReason: 'quota_exceeded',
            failureKind: 'quota',
            message: 'Kimi usage quota reached — the current window is exhausted but the account itself is fine. It will resume automatically once the quota resets.',
        };
    }

    const billing = [
        /\b(?:kimi code\s+)?(?:subscription|membership|plan)\s+(?:has\s+|is\s+)?(?:expired|inactive|suspended|cancelled|canceled)\b/,
        /\b(?:payment|billing)\s+(?:is\s+)?(?:required|failed|overdue)\b/,
        /\bpayment_required\b/,
        /\binsufficient\s+(?:balance|credits?)\b/,
    ].some(pattern => pattern.test(text));
    if (billing) {
        return {
            errorReason: 'billing_failed',
            failureKind: 'billing',
            message: 'Kimi billing/subscription failed. Renew the subscription or payment entitlement before retrying.',
        };
    }

    const auth = [
        // Native provider error JSON payloads (Anthropic authentication_error, OpenAI/Codex token_revoked/invalid_api_key)
        /"type"\s*:\s*"authentication_error"/,
        /"error"\s*:\s*\{[^}]*"code"\s*:\s*"(?:token_revoked|invalid_api_key|token_expired|invalid_token)"/,
        // Anchored CLI / HTTP 401 error banners (never bare "401" or "Unauthorized" in code/tool output)
        /(?:^|[.!?·:;\n]\s*)(?:(?:[●✗✖⚠!]\s+)?(?:api\s+error|http\s+error|error)|⏺\s+api\s+error)\s*:\s*(?:http\s*)?401\b(?:\s+unauthorized\b|\s*[—–\-:]|\s*\{)/,
        /(?:^|\n)\s*(?:[●✗✖⚠!]\s+)?(?:codex|claude|antigravity|agy|kimi|cursor|grok)\b[^\n:]{0,40}(?:error|failed)\s*:\s*(?:http\s*)?401\s+unauthorized\b/,
        /\bhttps?:\/\/(?:api\.anthropic\.com|chatgpt\.com\/backend-api|api\.openai\.com|open\.bigmodel\.cn|api\.moonshot\.(?:cn|ai)|api\.x\.ai)\/[^\s;]*\s+failed:\s*401\s+unauthorized\b/,
        // Anchored CLI auth / token / not-signed-in statements
        /(?:^|[.!?·:;\n]\s*|"message"\s*:\s*"\s*)(?:[●✗✖⚠!]\s+)?(?:(?:api\s+error|http\s+error|error)\s*:\s*)?invalid\s+(?:authentication\s+credentials|api\s+key)\b/,
        /(?:^|[.!?·:;\n]\s*)(?:[●✗✖⚠!]\s+)?(?:authentication|authorization|login)\s+(?:error|failed|required)(?:\s*[:.!—–\-·;\n]|$)/,
        /(?:^|[.!?·:;\n]\s*)(?:[●✗✖⚠!]\s+)?(?:(?:your|the)\s+)?(?:oauth|access|refresh|auth(?:entication)?)\s+token\s+(?:has\s+|is\s+)(?:expired|invalid|rejected|revoked)(?:\s*[.!·:;\n—–-]|$)/,
        /(?:^|[.!?·:;\n]\s*)(?:[●✗✖⚠!]\s+)?(?:you\s+are\s+(?:currently\s+)?)?not\s+(?:logged|signed)\s+in(?:\s*(?:[.!·:;\n—–-]|to\s+(?:claude|codex|antigravity|kimi|cursor|grok)\b)|$)/,
        /(?:^|[.!?·:;\n]\s*)(?:[●✗✖⚠!]\s+)?please\s+(?:run\s+)?(?:`?(?:kimi|codex|claude|agy)`?\s+)?\/?login\b/,
        /(?:^|\n)\s*\[(?:provider\.auth_error|auth\.(?:login_required|token_unauthorized|token_missing))\]\s+(?!403\b)\S/,
        // AUTH-EXPIRY-GENERALIZATION (D4). Statement-anchored expired-login / /login banners.
        /(?:^|[.!?·:;\n]\s*|\breason:\s*)(?:[●✗✖⚠!]\s+)?(?:your\s+|the\s+)?(?:login|session|credential)s?\s+(?:has\s+|have\s+|is\s+|are\s+)?expired\b/,
        /(?:^|[.!?·:;\n]\s*)(?:[●✗✖⚠!]\s+)?(?:please\s+)?(?:run|use)\s+\/login\b/,
    ].some(pattern => pattern.test(linesText));
    if (auth) {
        return {
            errorReason: 'auth_failed',
            failureKind: 'auth',
            // Provider-neutral wording: the AUTH axis now serves every spec-backed
            // CLI (see observeProviderFailureOutput), so naming Kimi here would send
            // a claude-cli operator to re-login against the wrong tool. The billing
            // and quota messages above stay Kimi-specific because those axes remain
            // kimi-scoped.
            //
            // ★SELF-MATCH GUARD: this message MUST NOT itself classify as a failure
            // (assert: detectProviderFailure(message) === null). It travels
            // into mesh failure events that the daemon INJECTS into coordinator and
            // worker PTYs — the previous wording ("Provider authentication failed…")
            // matched the bare `authentication failed` rule above, so every delivery
            // of an auth-failure event poisoned the receiving session's own tail and
            // got IT flagged next (the 2026-09-21 coordinator kill loop). Keep the
            // wording out of every pattern in this file when editing it.
            message: AUTH_FAILURE_MESSAGE,
        };
    }
    return null;
}

/**
 * One auth-failure STATEMENT, matched against a whole sentence segment of a
 * normalized (lowercased, whitespace-collapsed) reply. Each alternative must
 * consume the entire segment — that is what separates the CLI's banner from a
 * reply that merely mentions it ("login expired banner now renders").
 */
const AUTH_ONLY_SEGMENT_RE = new RegExp('^(?:'
    + [
        // "Login expired", "OAuth token has expired", "Your session has expired"
        String.raw`(?:your\s+|the\s+)?(?:login|session|credentials?|(?:oauth\s+|access\s+|auth\s+|refresh\s+)?token)\s+(?:has\s+|have\s+|is\s+|are\s+)?expired`,
        // "Please run /login", "Run /login to re-authenticate"
        String.raw`(?:please\s+)?(?:run|use)\s+\/login(?:\s+to\s+[a-z\s-]{1,40})?`,
        // "Not logged in", "Invalid API key", "Invalid authentication credentials", "Authentication required"
        String.raw`not\s+(?:logged|signed)\s+in`,
        String.raw`(?:(?:api\s+error|http\s+error|error)\s*:\s*)?invalid\s+(?:api\s+key|authentication\s+credentials)`,
        String.raw`(?:authentication|login)\s+(?:required|failed)`,
        // "API Error: 401 {…authentication_error…}" or raw Anthropic authentication_error JSON.
        String.raw`api\s+error:\s*401\b.*`,
        String.raw`\{.*"type"\s*:\s*"authentication_error".*\}`,
    ].join('|')
    + ')$');
/** A banner is a line or two; anything longer is a real reply. */
const AUTH_ONLY_REPLY_MAX_CHARS = 600;

/**
 * Stricter sibling of `detectProviderFailure` for a TURN VERDICT: true only
 * when the turn's whole final reply is auth-failure wording, e.g. claude-cli's
 *   "Login expired · Please run /login"
 * (2026-10-06 preview incident: three workers answered a task with only this
 * line and the mesh committed one of them `task_completed`).
 *
 * `detectProviderFailure` is a live-tail suspicion classifier — it fires on a
 * statement anywhere in the text ("Done. Login expired banner now renders."
 * matches). That is fine for a suspicion re-checked on screen, but a turn
 * verdict fails a task outright, so here EVERY sentence segment of the reply
 * must itself be an auth statement. Auth axis only: billing/quota keep their
 * kimi-scoped admission (live-auth-advisory.ts).
 */
export function detectAuthFailureOnlyReply(reply: string): ProviderFailure | null {
    const text = stripAnsi(reply).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text || text.length > AUTH_ONLY_REPLY_MAX_CHARS) return null;
    // The raw 401 / JSON echo carries JSON (with its own punctuation) and may be followed
    // by "· Please run /login": split only on the CLI's `·` / newline joiners there.
    const isJsonOrRaw401 = /^(?:api\s+error:\s*401\b|\{.*"type"\s*:\s*"authentication_error")/.test(text);
    const segments = (isJsonOrRaw401 ? text.split(/\s*·\s*/) : text.split(/\s*[.!?·;\n]\s*/))
        .map((segment) => segment.replace(/^[\s:,-]+|[\s:,.!-]+$/g, ''))
        .filter(Boolean);
    if (segments.length === 0 || !segments.every((segment) => AUTH_ONLY_SEGMENT_RE.test(segment))) return null;
    const failure = detectProviderFailure(text);
    return failure?.failureKind === 'auth'
        ? failure
        : { errorReason: 'auth_failed', failureKind: 'auth', message: AUTH_FAILURE_MESSAGE };
}
