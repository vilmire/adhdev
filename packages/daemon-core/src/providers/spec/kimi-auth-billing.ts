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

export interface KimiAuthBillingFailure {
    errorReason: 'auth_failed' | 'billing_failed' | 'quota_exceeded';
    failureKind: 'auth' | 'billing' | 'quota';
    message: string;
}

/**
 * KIMI-AUTH-BILLING-LIVE: classify only strong Kimi CLI failure markers.
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

export function detectKimiAuthBillingFailure(output: string, _exitCode?: number): KimiAuthBillingFailure | null {
    const text = stripAnsi(output).replace(/\s+/g, ' ').trim().toLowerCase();
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
        /\b(?:authentication|authorization|login)\s*(?:error|failed|required)\b/,
        /\b(?:access|refresh|auth(?:entication)?)\s+token\s+(?:has\s+|is\s+)?(?:expired|invalid|rejected|revoked)\b/,
        /\b(?:token_expired|invalid_token)\b/,
        /\b(?:unauthorized|http\s*401|status(?:\s+code)?\s*[:=]?\s*401)\b/,
        /\b(?:not\s+(?:logged|signed)\s+in)\b/,
        /\bplease\s+(?:run\s+)?(?:`?kimi`?\s+)?login\b/,
    ].some(pattern => pattern.test(text));
    if (auth) {
        return {
            errorReason: 'auth_failed',
            failureKind: 'auth',
            message: 'Kimi authentication failed (the access token is expired or rejected). Run "kimi login" in this environment before retrying.',
        };
    }
    return null;
}
