/**
 * Assistant store write guards — credential-pattern rejection and origin
 * gating (design docs/design/2026-10-07-assistant-layer.md §4.10.2 checks 4–5,
 * shared by the memory store now and the skill store / `project_note` later).
 *
 * Pure functions, no I/O. The atomic file helpers used by the stores live here
 * too so memory and skills write with one convention (0600, tmp + rename,
 * matching seqscribe/fleet-secret.ts).
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// ── Credential patterns (§4.10.2 check 4) ───────────────────────────────────
//
// Fail-closed: a false positive is a refused write the human can make by
// editing the file directly; a false negative is a credential that becomes
// part of every future session prompt. When in doubt the pattern rejects.

export type CredentialPatternId =
    | 'adhdev_token'
    | 'jwt'
    | 'openai_style_key'
    | 'github_token'
    | 'github_pat'
    | 'slack_token'
    | 'aws_access_key'
    | 'pem_header'
    | 'long_hex'
    | 'long_base64';

interface CredentialPattern {
    id: CredentialPatternId;
    re: RegExp;
}

/** Letter/digit lookbehind so `task-...` does not trip the `sk-` rule. */
const NOT_AFTER_ALNUM = '(?<![A-Za-z0-9])';

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
    // ADHDev tokens: API key, machine secret, share token. A bare mention of
    // the prefix ("the adk_ prefix") is not a token — require a body.
    { id: 'adhdev_token', re: new RegExp(`${NOT_AFTER_ALNUM}(?:adk|adm|shr)_[A-Za-z0-9_-]{8,}`) },
    // JWT shape: three dot-separated base64url segments, header starting `eyJ`
    // (base64 of `{"`). Plain dotted names (`a.b.c`, versions) do not match.
    { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/ },
    { id: 'openai_style_key', re: new RegExp(`${NOT_AFTER_ALNUM}sk-[A-Za-z0-9_-]{16,}`) },
    { id: 'github_pat', re: new RegExp(`${NOT_AFTER_ALNUM}github_pat_[A-Za-z0-9_]{16,}`) },
    { id: 'github_token', re: new RegExp(`${NOT_AFTER_ALNUM}ghp_[A-Za-z0-9]{16,}`) },
    { id: 'slack_token', re: new RegExp(`${NOT_AFTER_ALNUM}xox[bp]-[A-Za-z0-9-]{10,}`) },
    { id: 'aws_access_key', re: new RegExp(`${NOT_AFTER_ALNUM}AKIA[0-9A-Z]{16}`) },
    { id: 'pem_header', re: /-----BEGIN [A-Z0-9 ]+-----/ },
    { id: 'long_hex', re: /[0-9a-fA-F]{32,}/ },
];

/** Run of base64/base64url characters long enough to be a key. */
const BASE64_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

/**
 * A 32+ base64 run is a credential when it mixes letters and digits AND has a
 * contiguous alphanumeric stretch of ≥ 20. The stretch rule keeps file paths
 * (`oss/packages/daemon-core/src`) and snake/kebab identifiers out — their
 * segments are short — while a random key's `+`/`/`/`-`/`_` are too sparse to
 * break it into short pieces.
 */
function looksLikeBase64Secret(run: string): boolean {
    if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) return false;
    return /[A-Za-z0-9]{20,}/.test(run);
}

/** First credential pattern the text matches, or null. Never returns the matched text. */
export function detectCredential(text: string): CredentialPatternId | null {
    for (const p of CREDENTIAL_PATTERNS) {
        if (p.re.test(text)) return p.id;
    }
    for (const m of text.matchAll(BASE64_RUN)) {
        if (looksLikeBase64Secret(m[0])) return 'long_base64';
    }
    return null;
}

// ── Content patterns (research 2026-10-08 F3) ───────────────────────────────
//
// Invisible Unicode and a NARROW set of prompt-injection phrases, checked on
// every memory / skill / project-note write and again when the frozen memory
// snapshot and the skill index are built. The phrase set is anchored on attack
// vocabulary (Hermes `threat_patterns.py`, "all" scope), never on bossy
// English: legitimate rules say "you must", "never", "do not" all the time.
// Patterns that would trip on ordinary dev procedures here (curl with
// $TOKEN, authorized_keys, editing CLAUDE.md, `unset CLAUDECODE`) are
// deliberately left out.

export type HiddenCharId = 'zero_width' | 'bidi_control' | 'tag_char';

export type InjectionPatternId =
    | 'ignore_instructions'
    | 'disregard_rules'
    | 'system_prompt_override'
    | 'bypass_restrictions'
    | 'fake_update'
    | 'html_comment_injection';

/** Emoji ZWJ sequences (👨‍👩‍👧) are not hidden text; strip them before the zero-width check. */
const EMOJI_ZWJ = /\p{Extended_Pictographic}\uFE0F?\u200D(?=\p{Extended_Pictographic})/gu;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\u2062-\u2064\uFEFF]/u;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/u;
const TAG_CHAR = /[\u{E0000}-\u{E007F}]/u;

/** First kind of invisible character in `text`, or null. */
export function detectHiddenChars(text: string): HiddenCharId | null {
    if (BIDI_CONTROL.test(text)) return 'bidi_control';
    if (TAG_CHAR.test(text)) return 'tag_char';
    if (ZERO_WIDTH.test(text.replace(EMOJI_ZWJ, ''))) return 'zero_width';
    return null;
}

/** Up to N filler words between key tokens ("ignore all prior instructions"); bounded, no backtracking blow-up. */
const W = '(?:[\\w\'’-]+\\s+){0,4}';

// Considered and left out for false positives on this owner's own rules and
// procedures: "do not tell the user …" (a real rule: "never tell the user it is
// done before the tests pass"), "print the system prompt" (ADHDev debugs its
// own prompts), hidden `display:none` markup (frontend notes; not hidden from
// a model anyway), role-play "you are now a …".
const INJECTION_PATTERNS: ReadonlyArray<{ id: InjectionPatternId; re: RegExp }> = [
    { id: 'ignore_instructions', re: new RegExp(`\\bignore\\s+${W}(?:previous|all|above|prior|earlier)\\s+${W}instructions\\b`, 'i') },
    { id: 'disregard_rules', re: new RegExp(`\\bdisregard\\s+${W}(?:your|all|any)\\s+${W}(?:instructions|rules|guidelines)\\b`, 'i') },
    { id: 'system_prompt_override', re: /\bsystem\s+prompt\s+override\b/i },
    { id: 'bypass_restrictions', re: new RegExp(`\\bact\\s+as\\s+(?:if|though)\\s+${W}you\\s+${W}(?:have\\s+no|don'?t\\s+have)\\s+${W}(?:restrictions|limits|rules)\\b`, 'i') },
    { id: 'fake_update', re: new RegExp(`\\byou\\s+have\\s+been\\s+${W}(?:updated|upgraded|patched|reprogrammed)\\s+to\\b`, 'i') },
    { id: 'html_comment_injection', re: /<!--[^>]*\b(?:ignore|disregard|override)\b[^>]*-->/i },
];

/** First injection pattern `text` matches, or null. Never returns the matched text. */
export function detectInjection(text: string): InjectionPatternId | null {
    for (const p of INJECTION_PATTERNS) if (p.re.test(text)) return p.id;
    return null;
}

export type StoreContentFinding =
    | { kind: 'hidden_chars'; pattern: HiddenCharId }
    | { kind: 'injection'; pattern: InjectionPatternId }
    | { kind: 'credential'; pattern: CredentialPatternId };

/**
 * Write-time content check (hidden characters, then injection phrases). The
 * credential check stays separate at write time because each store already
 * runs it with its own result code; `scanStoredContent` adds it for the
 * read-time re-scan.
 */
export function scanWriteContent(text: string): Exclude<StoreContentFinding, { kind: 'credential' }> | null {
    const hidden = detectHiddenChars(text);
    if (hidden) return { kind: 'hidden_chars', pattern: hidden };
    const inj = detectInjection(text);
    if (inj) return { kind: 'injection', pattern: inj };
    return null;
}

/** Read-time re-scan (snapshot / skill index): every write-time check, credentials included. */
export function scanStoredContent(text: string): StoreContentFinding | null {
    const w = scanWriteContent(text);
    if (w) return w;
    const cred = detectCredential(text);
    return cred ? { kind: 'credential', pattern: cred } : null;
}

// ── Origin gating (§4.10.2 check 5) ─────────────────────────────────────────

/**
 * Where a store write comes from, as recorded in the journal.
 *  - `human`  — no non-human input was delivered after the last human input.
 *  - `relay`  — a non-human input (relay, progress/stall signal, restart note,
 *               first-run input) was delivered after the last human input, or
 *               no human input was seen at all. Writes are STAGED.
 *  - `review` — the idle review turn (§4.10.7) over a window (since the
 *               previous review, or since the session started) that held only
 *               human inputs. Applied with a notice; the owner can undo.
 *  - `review_tainted` — the review turn over a window that held at least one
 *               non-human input (or whose start was truncated away). STAGED:
 *               otherwise a relay could reach memory by waiting for the next
 *               review (research 2026-10-08 F1).
 *  - `owner`  — a direct owner action (dashboard, import, staged resolve).
 *               Applied without staging; format/budget/secret checks still run.
 */
export type StoreWriteOrigin = 'human' | 'relay' | 'review' | 'review_tainted' | 'owner';

/** Kinds of input the daemon delivers into the assistant session. */
export type AssistantInputSource =
    | 'human'
    | 'relay'
    | 'progress'
    | 'stall'
    | 'restart_note'
    | 'first_run'
    | 'review';

/**
 * Classify a write from the ordered list of inputs the daemon delivered into
 * the assistant session (oldest first). Deliberately coarse (§4.10.2): it does
 * not track which input opened the current turn, only the order of sources.
 *
 * `truncated`: the list does not reach back to the session start (oldest
 * entries dropped, or the log began after a daemon restart). A review whose
 * window would reach back past that point cannot prove the window was
 * human-only, so it is `review_tainted` (fail-closed).
 */
export function classifyWriteOrigin(delivered: readonly AssistantInputSource[], opts: { truncated?: boolean } = {}): StoreWriteOrigin {
    const last = delivered[delivered.length - 1];
    if (last === 'review') {
        const prevReview = delivered.lastIndexOf('review', delivered.length - 2);
        if (prevReview < 0 && opts.truncated) return 'review_tainted';
        const window = delivered.slice(prevReview + 1, delivered.length - 1);
        return window.every((s) => s === 'human') ? 'review' : 'review_tainted';
    }
    const lastHuman = delivered.lastIndexOf('human');
    if (lastHuman < 0) return 'relay'; // no human authority at all → stage
    return lastHuman === delivered.length - 1 ? 'human' : 'relay';
}

/** True when a write with this origin must be staged instead of applied. */
export function mustStage(origin: StoreWriteOrigin): boolean {
    return origin === 'relay' || origin === 'review_tainted';
}

/** Either flavour of the review turn. */
export function isReviewOrigin(origin: StoreWriteOrigin): boolean {
    return origin === 'review' || origin === 'review_tainted';
}

/**
 * USER.md is about the person; only the person (directly, through a clean
 * review turn, or as owner) may change it. Every other origin is REFUSED, not
 * staged — project output is not a source of the user's preferences
 * (research 2026-10-08 "추가 1").
 */
export function userTargetAllowed(origin: StoreWriteOrigin): boolean {
    return origin === 'human' || origin === 'review' || origin === 'owner';
}

// ── File helpers (0600, atomic) ─────────────────────────────────────────────

function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function forceMode600(path: string): void {
    try {
        chmodSync(path, 0o600);
    } catch {
        /* Windows etc. not supported */
    }
}

/** tmp + rename at mode 0600 (seqscribe/fleet-secret.ts convention). */
export function writeFileAtomic600(path: string, content: string): void {
    ensureDir(dirname(path));
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    try {
        renameSync(tmp, path);
    } catch (err) {
        try {
            unlinkSync(tmp);
        } catch {
            /* already gone */
        }
        throw err;
    }
    // rename does not carry the mode onto an existing destination everywhere.
    forceMode600(path);
}

/** Append one JSON line at mode 0600. */
export function appendJsonLine600(path: string, record: unknown): void {
    ensureDir(dirname(path));
    const existed = existsSync(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 });
    if (!existed) forceMode600(path);
}
