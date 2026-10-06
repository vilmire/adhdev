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

// ── Origin gating (§4.10.2 check 5) ─────────────────────────────────────────

/**
 * Where a store write comes from, as recorded in the journal.
 *  - `human`  — no non-human input was delivered after the last human input.
 *  - `relay`  — a non-human input (relay, progress/stall signal, restart note,
 *               first-run input) was delivered after the last human input, or
 *               no human input was seen at all. Writes are STAGED.
 *  - `review` — the idle review turn (§4.10.7). Applied, journaled as review.
 *  - `owner`  — a direct owner action (dashboard, import, staged resolve).
 *               Applied without staging; format/budget/secret checks still run.
 */
export type StoreWriteOrigin = 'human' | 'relay' | 'review' | 'owner';

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
 */
export function classifyWriteOrigin(delivered: readonly AssistantInputSource[]): StoreWriteOrigin {
    const last = delivered[delivered.length - 1];
    if (last === 'review') return 'review';
    const lastHuman = delivered.lastIndexOf('human');
    if (lastHuman < 0) return 'relay'; // no human authority at all → stage
    return lastHuman === delivered.length - 1 ? 'human' : 'relay';
}

/** True when a write with this origin must be staged instead of applied. */
export function mustStage(origin: StoreWriteOrigin): boolean {
    return origin === 'relay';
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
