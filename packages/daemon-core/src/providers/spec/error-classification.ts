/**
 * ERROR-NOT-COMPLETION: live-PTY provider failure classification.
 *
 * A PTY CLI can print a transport/auth/billing/quota failure mid-turn without
 * exiting and without the FSM ever reaching a distinct 'error' state — left
 * alone, that text sits on screen exactly like real assistant output and the
 * ordinary idle-settle path folds it into finalSummary as a "possible
 * completion (weak evidence)", indistinguishable from a genuine answer.
 * classifyDeclaredError recognizes a spec's own declared failure wording
 * (fsm-types.ts ErrorClassification) and returns a typed ProviderErrorReason
 * so cli-adapter.ts's SpecCliAdapter can surface adapter status 'error'
 * instead — the ordinary agent:stopped path (status-transition.ts), which
 * bypasses completion/finalSummary entirely.
 *
 * Split out of cli-adapter.ts (2026-09, file-size gate) as a self-contained,
 * pure classification unit — no FSM/driver/PTY-transport dependencies.
 */
'use strict';

import type { ErrorClassification, ErrorClassBucket } from './fsm-types.js';

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
 * True when the tail carries a machine-emitted provider failure envelope, as
 * opposed to prose that merely mentions limits. This is the live-PTY stand-in
 * for the quota fetcher's "we already know this is a 403" precondition: it is
 * what separates the incident line "[provider.auth_error] 403 You've reached
 * your 5-hour usage limit" from an agent narrating the quota source file.
 * Kept as the built-in structural guard for auth/billing/quota classes: a
 * spec-declared pattern for these classes still must arrive inside one of
 * these envelopes, so a provider's own manifest cannot accidentally turn "the
 * agent quoting an error code in prose" into a false stop.
 */
function hasProviderFailureEnvelope(text: string): boolean {
    return /\bprovider\.[a-z_]*error\b/.test(text)
        || /\b(?:http\s*)?(?:40[23])\b\s*(?:[-:—]|\bforbidden\b|\bpayment\b|you\b|your\b)/.test(text)
        || /\bstatus(?:\s+code)?\s*[:=]?\s*40[23]\b/.test(text);
}

export interface ClassifiedFailure {
    errorReason: 'auth_failed' | 'billing_failed' | 'quota_exceeded' | 'spawn_error';
    failureKind: 'auth' | 'billing' | 'quota' | 'transport';
    message: string;
}

const ERROR_CLASS_TO_REASON: Record<keyof ErrorClassification, ClassifiedFailure['errorReason']> = {
    transport: 'spawn_error',
    auth: 'auth_failed',
    billing: 'billing_failed',
    quota: 'quota_exceeded',
};

const ERROR_CLASS_MESSAGE: Record<keyof ErrorClassification, string> = {
    transport: 'The provider connection was interrupted mid-response. This is usually transient — the mesh may retry.',
    auth: 'Provider authentication failed (the access token is expired or rejected). Re-authenticate this environment before retrying.',
    billing: 'Provider billing/subscription failed. Renew the subscription or payment entitlement before retrying.',
    quota: 'Provider usage quota reached — the current window is exhausted but the account itself is fine. It will resume automatically once the quota resets.',
};

/**
 * Trailing slop (chars) allowed after a `no_further_generation` match before
 * it is treated as "something else was said afterward". Small enough to
 * absorb a trailing prompt redraw / whitespace / cursor artifact, far too
 * small to absorb a sentence of narration.
 */
const NO_FURTHER_GENERATION_TRAILING_SLOP = 24;

/**
 * ERROR-NOT-COMPLETION generic classifier: given a spec's declared
 * `error_classification` (fsm-types.ts), test merged PTY output against each
 * declared class in a fixed, deliberate priority (quota before billing before
 * auth before transport — the same "specific entitlement verdict outranks a
 * generic one" ordering the Kimi classifier established) and return the first
 * match.
 *
 * `generating` reports whether the FSM's live status is still 'generating' at
 * the moment of the check. It gates `requires: 'no_further_generation'`
 * buckets ALONGSIDE a second, stronger check: the match must land at (or
 * within NO_FURTHER_GENERATION_TRAILING_SLOP of) the end of the trimmed tail.
 * A genuine mid-response transport drop leaves the error string as the LAST
 * thing the PTY printed; a worker that quotes the same wording while
 * reporting completed work ("fixed the retry handler so a 'Connection closed
 * mid-response' error no longer crashes the client") keeps talking after it —
 * failing the trailing-position check even though the FSM has equally
 * settled to idle by the time either report is read. Both conditions must
 * hold; `generating` alone is insufficient (a settled report is exactly as
 * "not generating" as a genuine drop), and the trailing-position check alone
 * would misfire on a live failure whose tail still carries a few bytes of
 * prompt redraw — hence the small slop rather than requiring an exact string
 * end. Each bucket's `requires` (see ErrorClassBucket) is opt-in per class,
 * not implied by omission: a spec author gets pattern authorship, never
 * guard authorship — the guard names (and whether one applies at all) are
 * the engine's own safety rail, exactly like startup_dismiss/pre_launch_trust
 * give schemes/patterns but never let a manifest disable the engine's own
 * bounding logic.
 */
export function classifyDeclaredError(
    output: string,
    declared: ErrorClassification | undefined,
    context: { generating: boolean; messages?: Partial<Record<keyof ErrorClassification, string>> },
): ClassifiedFailure | null {
    if (!declared) return null;
    const text = stripAnsi(output).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return null;

    const order: Array<keyof ErrorClassification> = ['quota', 'billing', 'auth', 'transport'];
    for (const cls of order) {
        const bucket: ErrorClassBucket | undefined = declared[cls];
        if (!bucket) continue;
        const match = bucket.patterns.reduce<RegExpMatchArray | null>((found, { regex, flags }) => {
            if (found) return found;
            try {
                return text.match(new RegExp(regex, flags));
            } catch {
                return null;
            }
        }, null);
        if (!match) continue;
        if (bucket.requires === 'no_further_generation') {
            if (context.generating) continue;
            const matchEnd = (match.index ?? 0) + match[0].length;
            if (text.length - matchEnd > NO_FURTHER_GENERATION_TRAILING_SLOP) continue;
        }
        if (bucket.requires === 'provider_failure_envelope' && !hasProviderFailureEnvelope(text)) continue;
        return {
            errorReason: ERROR_CLASS_TO_REASON[cls],
            failureKind: cls,
            message: context.messages?.[cls] || ERROR_CLASS_MESSAGE[cls],
        };
    }
    return null;
}

/**
 * Kimi's own error_classification, expressed as the same declarative shape
 * every other spec would use. This is the DEFAULT applied when a 'kimi'
 * adapter's spec has not yet migrated its wording into specs/*.json
 * (KIMI-AUTH-BILLING-LIVE, live since 2026-08). Once a published kimi spec
 * declares its own error_classification this default is never consulted
 * (declaredErrorClassification in cli-adapter.ts prefers the spec's
 * declaration), so retiring this constant is a manifest change, not a code
 * change.
 *
 * Verdict ordering and wording match the original hand-written classifier
 * byte-for-byte: quota is checked before billing so a usage-limit envelope
 * never falls through into the non-retryable bucket (the incident this file
 * exists to prevent — fixed 2026-08-29, see the quota/billing test coverage).
 */
export const KIMI_DEFAULT_ERROR_CLASSIFICATION: ErrorClassification = {
    quota: {
        patterns: [
            { regex: '\\b(?:usage|quota|credit)\\s+limit\\b' },
            { regex: '\\bquota\\s*(?:exhausted|refresh)' },
            { regex: '\\bbilling\\s+cycle\\b' },
        ],
        // The only bucket the original hand-written classifier gated: bare
        // limit wording is what a coding agent produces while discussing
        // quota code, so it is trusted only alongside a machine-emitted
        // failure envelope (a provider.*_error tag or 401/402/403 marker).
        requires: 'provider_failure_envelope',
    },
    billing: {
        patterns: [
            { regex: '\\b(?:kimi code\\s+)?(?:subscription|membership|plan)\\s+(?:has\\s+|is\\s+)?(?:expired|inactive|suspended|cancelled|canceled)\\b' },
            { regex: '\\b(?:payment|billing)\\s+(?:is\\s+)?(?:required|failed|overdue)\\b' },
            { regex: '\\bpayment_required\\b' },
            { regex: '\\binsufficient\\s+(?:balance|credits?)\\b' },
        ],
    },
    auth: {
        patterns: [
            { regex: '\\b(?:authentication|authorization|login)\\s*(?:error|failed|required)\\b' },
            { regex: '\\b(?:access|refresh|auth(?:entication)?)\\s+token\\s+(?:has\\s+|is\\s+)?(?:expired|invalid|rejected|revoked)\\b' },
            { regex: '\\b(?:token_expired|invalid_token)\\b' },
            { regex: '\\b(?:unauthorized|http\\s*401|status(?:\\s+code)?\\s*[:=]?\\s*401)\\b' },
            { regex: '\\b(?:not\\s+(?:logged|signed)\\s+in)\\b' },
            { regex: '\\bplease\\s+(?:run\\s+)?(?:`?kimi`?\\s+)?login\\b' },
        ],
    },
};

/** Kimi's operator-facing messages — kept out of the manifest (message
 *  wording is engine-owned; see classifyDeclaredError's `messages` override)
 *  so a debug-panel-edited spec can never rewrite what an operator is told to
 *  do. Byte-for-byte the original hand-written classifier's wording. */
export const KIMI_ERROR_MESSAGES: Partial<Record<keyof ErrorClassification, string>> = {
    quota: 'Kimi usage quota reached — the current window is exhausted but the account itself is fine. It will resume automatically once the quota resets.',
    billing: 'Kimi billing/subscription failed. Renew the subscription or payment entitlement before retrying.',
    auth: 'Kimi authentication failed (the access token is expired or rejected). Run "kimi login" in this environment before retrying.',
};

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
 *
 * Now a thin wrapper over classifyDeclaredError + KIMI_DEFAULT_ERROR_CLASSIFICATION
 * (ERROR-NOT-COMPLETION, 2026-09) so Kimi's wording lives in the same
 * declarative shape every other provider's manifest uses; behavior and every
 * assertion in cli-adapter-kimi-auth-billing-exit.test.ts are unchanged.
 */
export function detectKimiAuthBillingFailure(output: string, _exitCode?: number): KimiAuthBillingFailure | null {
    const verdict = classifyDeclaredError(output, KIMI_DEFAULT_ERROR_CLASSIFICATION, { generating: false, messages: KIMI_ERROR_MESSAGES });
    if (!verdict || verdict.failureKind === 'transport') return null;
    return { errorReason: verdict.errorReason as KimiAuthBillingFailure['errorReason'], failureKind: verdict.failureKind, message: verdict.message };
}
