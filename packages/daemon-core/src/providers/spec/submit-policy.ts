/**
 * Submit policy — the pure (stateless) half of the spec driver's send/submit
 * machinery: size thresholds, delay resolution, win32 paste/newline encoding
 * choices, echo normalization, and the shutdown drain ceiling.
 *
 * Pure move out of fsm-driver.ts (file-size gate). fsm-driver re-exports every
 * public symbol here, so existing `from './fsm-driver.js'` imports are
 * unchanged (barrel-preserving decomposition precedent). The stateful timers
 * that CONSUME these policies (scheduleVerifiedSubmit, writeWin32Body,
 * hasInFlightSubmit/whenSubmitDrained) stay in FsmDriver.
 */
'use strict';

import { chunkPreservingSurrogates as chunkPreservingSurrogatesShared } from '../../cli-adapters/pty-write-chunking.js';

function countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
    return n;
}

const SUBMIT_DELAY_FLOOR_MS = 200;

/**
 * ENTER-LOSS layer ① — upper bound the daemon shutdown path waits for an
 * in-flight submit to finish before proceeding (2026-09-10 incident: a 10,937-char
 * completion notification was written to the coordinator PTY, the daemon began an
 * upgrade restart 1.4s later, and the CR — scheduled ≥1800ms out by
 * resolveSubmitDelayMs — never fired; the body sat in the composer for 1h42m and
 * was then merge-submitted with the owner's next input).
 *
 * Derivation (worst-case single submit, constants in fsm-driver.ts):
 *   initial delay   ≤ ~1,800ms  — resolveSubmitDelayMs: max(spec, manifest,
 *                                 200 floor + 800 lines-bonus cap + 800 length-bonus cap)
 *   echo-gate wait  ≤ 20,000ms  — WIN32_ECHO_MAX_WAIT_MS blind-fire backstop
 *   resend net      ≤  4,900ms  — WIN32_SUBMIT_MAX_RESENDS(14) × WIN32_SUBMIT_RESEND_GAP_MS(350)
 *   ─────────────────────────────
 *   total           ≤ ~26,700ms → 30,000ms with margin.
 *
 * This is a CEILING, not a wait: with nothing in flight the gate passes
 * immediately, and every phase above normally completes in well under a second
 * once the echo confirms. A manifest/spec could in principle declare a larger
 * delay_ms_before_submit than the 1,800ms modelled here; the gate then times out,
 * logs the unfinished submit count, and shutdown proceeds — bounded loss is
 * accepted over an unbounded shutdown hang.
 */
export const SUBMIT_DRAIN_SHUTDOWN_MAX_WAIT_MS = 30_000;

// ── POSIX-ENTER-DROP (2026-08-23, grok-cli/darwin) ───────────────────────────
//
// Live defect: a ~several-KB coordinator brief was injected into a grok-cli
// session and the submit CR never took — the body sat unsent in the composer
// until the owner pressed Enter by hand. Coordinator-side the session read
// `runtimeInputAck: true`, 1 user message, 0 assistant messages, status
// `generating` — i.e. a SILENT submit failure that looks like healthy work.
//
// Root cause: the verification machinery (echo-gate → resend-until-observed,
// fsm-driver.ts) was gated on `process.platform === 'win32'`. Every POSIX send
// took the blind branch in actuallySendMessage: write the whole body in ONE
// send_keys, then fire the CR from a bare setTimeout(beforeSubmit). That timer
// was NOT a function of body size — resolveSubmitDelayMs scaled on newline COUNT
// only — so a multi-KB single-paragraph body (few newlines) scored the 200ms
// floor. On a TUI that is still ingesting and re-rendering kilobytes of pasted
// text, a CR at 200ms is absorbed by the composer as part of the paste rather
// than acting as submit.
//
// Why grok and not claude/kimi on the same day: this is a race, not a per-provider
// bug. Its margin is (echo+render time) vs (a fixed 200ms). grok's manifest asks
// for 1200ms via `sendDelayMs`/`submitStrategy: wait_for_echo`, but BOTH fields were
// dead on the spec path — they were only read by cli-adapters/provider-cli-config.ts,
// which belonged to the legacy ProviderCliAdapter engine deleted in 48e5ed1a. kimi
// and opencode happen to carry delay_ms_before_submit: 1200 in their SPEC (the field
// that is still live), which is why they clear the same payload; grok/claude/codex/
// antigravity ship 200 and are all exposed. So the fix must be platform-general and
// provider-general, not a grok special case.
//
// UPDATE (MANIFEST-SEND-DELAY): `sendDelayMs` is no longer dead — route.ts now threads
// it in as SpecDriverOpts.manifestSendDelayMs and resolveSubmitDelayMs folds it into
// its max(), so grok's declared 1200 is finally the value it runs at. `submitStrategy`
// is deliberately still not consulted; see resolveEchoConfirmPolicy below for why
// wiring it would be either a no-op or a regression.
//
// Fix: the win32 gate is not win32-specific in nature — it verifies an EFFECT
// (body echoed, then agent left the composer) instead of guessing a duration. It is
// now shared by both platforms for bodies at or above VERIFIED_SUBMIT_MIN_CHARS.
// Below that threshold the legacy immediate path is kept verbatim so the overwhelming
// majority of sends ("y", "continue", a one-line question) are byte-for-byte
// unchanged and pay ZERO added latency — the over-correction guard the owner asked
// for. Above it we trade a few hundred ms for a confirmed submit, which is exactly
// the owner's stated preference: "입력이 늦는 것보단 확실하게 동작하는 게 더 중요함."
//
// The threshold is deliberately well below the observed failure size (thousands of
// chars) and well above an interactive one-liner. 512 chars is larger than any
// realistic hand-typed reply but far smaller than any pasted brief.
export const VERIFIED_SUBMIT_MIN_CHARS = 512;

/** True when `text` is large enough that the blind timed CR is unsafe and the
 *  echo-verified submit path should be used. Platform-independent: the win32
 *  path always verifies (its ConPTY failure modes are worse), POSIX verifies
 *  only from the threshold up. */
export function shouldUseVerifiedSubmit(text: string, platform: NodeJS.Platform = process.platform): boolean {
    if (platform === 'win32') return true;
    return text.length >= VERIFIED_SUBMIT_MIN_CHARS;
}

/**
 * MANIFEST-SUBMIT-STRATEGY — why the manifest's `submitStrategy` is NOT wired to
 * the echo-gate, decided deliberately rather than overlooked.
 *
 * `submitStrategy: 'wait_for_echo'` means "confirm the text echoed before pressing
 * Enter". That is precisely what scheduleVerifiedSubmit's echo-gate does, and since
 * d7332b84 it runs unconditionally for every body at/above VERIFIED_SUBMIT_MIN_CHARS
 * on BOTH platforms. So the two mechanisms are not complementary — they are the same
 * guarantee, one declared and one implemented. Wiring the declaration on top yields:
 *
 *  - 'wait_for_echo' → a NO-OP. All 8 shipped manifests declare exactly this, and the
 *    gate they are asking for is already running for them.
 *  - 'immediate'     → a REGRESSION. It would let a manifest switch OFF the echo
 *    verification that d7332b84 added to fix a silent submit failure — reintroducing
 *    that defect for any provider carrying the schema's default. Note the JSON Schema
 *    defaults this field to "immediate", so honouring it as an off-switch would break
 *    every out-of-tree provider that simply omits the field.
 *
 * The safety property is therefore: echo verification is decided by BODY SIZE and
 * PLATFORM (facts about the risk), never by provider self-declaration. This function
 * exists to make that contract explicit and testable — it maps any declared strategy
 * to whether verification may be skipped, and the answer is always "no".
 */
export function resolveEchoConfirmPolicy(
    _submitStrategy?: 'wait_for_echo' | 'immediate',
): { mayDisableEchoConfirm: false } {
    return { mayDisableEchoConfirm: false };
}

// FIX-B-v2 — how a newline-bearing win32 body's OWN embedded newlines are written
// (see concern (B) in fsm-driver.ts). 'paste' (default) wraps the body in a
// bracketed-paste so the Ink composer absorbs the whole thing as text;
// 'soft_newline' rewrites each embedded newline as a non-submitting Shift+Enter.
// Whether THIS ConPTY honors bracketed-paste can only be confirmed by the live
// deploy A/B (we cannot A/B it via delegation — win32 truncates any
// newline-bearing task), so both modes ship and the fallback is selectable at
// runtime via ADHDEV_WIN32_SUBMIT_MODE.
export type Win32SubmitMode = 'paste' | 'soft_newline';
export const WIN32_BRACKETED_PASTE_OPEN = '\x1b[200~';
export const WIN32_BRACKETED_PASTE_CLOSE = '\x1b[201~';
// Platform-agnostic aliases: the same bracketed-paste region is used on POSIX
// for image-bearing bodies (see actuallySendMessage's bracketedPaste branch).
export const BRACKETED_PASTE_OPEN = WIN32_BRACKETED_PASTE_OPEN;
export const BRACKETED_PASTE_CLOSE = WIN32_BRACKETED_PASTE_CLOSE;
// Non-submitting soft-newline for the claude-cli Ink composer. The spec
// (cli/claude-cli/specs/4.0.json) declares no soft-newline keycode, so we use the
// CSI-u encoding of Shift+Enter (modifyOtherKeys form: keycode 13 = Enter, modifier
// 2 = Shift). This inserts a literal newline into the composer WITHOUT submitting,
// unlike a bare CR (\r) which is reserved for the single real submit via (A).
export const WIN32_SOFT_NEWLINE = '\x1b[27;2;13~';

export function resolveWin32SubmitMode(env: NodeJS.ProcessEnv = process.env): Win32SubmitMode {
    return env.ADHDEV_WIN32_SUBMIT_MODE === 'soft_newline' ? 'soft_newline' : 'paste';
}

/** Collapse a string to its non-whitespace characters for echo comparison: the
 *  composer wraps, indents, and prefixes the body (with the `❯ ` prompt), so a raw
 *  substring test against the rendered screen fails. Stripping all whitespace makes
 *  "❯ hello world" reliably contain the probe "helloworld". */
export function normalizeForEcho(s: string): string {
    return s.replace(/\s+/g, '');
}

/**
 * The opening wait before the submit key, in ms.
 *
 * Three inputs, combined with max() so no source can shorten another:
 *  - `specBeforeSubmit` — the spec's `send_message.delay_ms_before_submit`.
 *  - `manifestSendDelayMs` — the provider manifest's `sendDelayMs` (MANIFEST-SEND-DELAY).
 *    Previously dead on this path; see SpecDriverOpts.manifestSendDelayMs.
 *  - the size-derived floor+bonus below.
 *
 * max() rather than precedence is deliberate: the size bonus exists because a
 * multi-KB body needs more time than any static declaration anticipated, so a
 * static manifest value must not be able to undercut it. Equally, a manifest that
 * asks for longer than the spec wins. Providers that declare nothing are byte-for-byte
 * unchanged, since an absent value contributes 0 to the max.
 */
export function resolveSubmitDelayMs(
    specBeforeSubmit: number | undefined,
    text: string,
    manifestSendDelayMs?: number,
): number {
    const lines = countNewlines(text);
    const linesBonus = Math.min(800, lines * 80);
    // LENGTH bonus (POSIX-ENTER-DROP). The line-count bonus alone misses the exact
    // shape that failed live: a MULTI-KILOBYTE body on FEW lines (a pasted task
    // brief is one long wrapped paragraph). Such a body scored only the 200ms floor
    // while taking far longer than that to stream through the PTY and echo into the
    // composer, so the CR fired mid-arrival. Length is the dimension that actually
    // predicts echo time, so it gets its own bonus — capped, because the echo-gate
    // (scheduleVerifiedSubmit) is what guarantees correctness; this only sets a
    // sane opening wait before the gate starts polling.
    const lengthBonus = Math.min(800, Math.floor(text.length / 1000) * 200);
    const spec = typeof specBeforeSubmit === 'number' && specBeforeSubmit > 0 ? specBeforeSubmit : 0;
    // Guard against a hostile/typo'd manifest: NaN and Infinity would poison the max
    // (NaN silently, Infinity by hanging the send), so only finite positives count.
    const manifest = typeof manifestSendDelayMs === 'number'
        && Number.isFinite(manifestSendDelayMs)
        && manifestSendDelayMs > 0
        ? manifestSendDelayMs
        : 0;
    return Math.max(spec, manifest, SUBMIT_DELAY_FLOOR_MS + linesBonus + lengthBonus);
}

/** Re-export of the shared surrogate-safe splitter so existing imports of
 *  `chunkPreservingSurrogates` from this module (and from fsm-driver's barrel)
 *  keep working. The implementation lives in ../../cli-adapters/pty-write-chunking
 *  (originally shared with the legacy adapter engine, deleted in 48e5ed1a). */
export const chunkPreservingSurrogates = chunkPreservingSurrogatesShared;

export function guessExt(mime: string): string {
    if (/png/i.test(mime)) return '.png';
    if (/jpe?g/i.test(mime)) return '.jpg';
    if (/gif/i.test(mime)) return '.gif';
    if (/webp/i.test(mime)) return '.webp';
    return '.bin';
}

// ── SEND-NOW-AGENT-QUEUE ─────────────────────────────────────────────────────
// Pure-moved here from fsm-driver.ts (file-size gate), same precedent as the
// submit-delay policy above. Re-exported from fsm-driver's barrel so existing
// imports keep working. The stateful consumer
// (FsmDriver.sendMessageDuringGeneration) stays in fsm-driver.ts.

/** Why a mid-generation split write was refused. Each one means NOTHING was
 *  written, so the caller can safely fall back to its previous behaviour. */
export type QueuedWriteRefusal =
    /** win32: the delayed lone CR is not recognised as a submit by ConPTY and
     *  the regression has not been re-measured. See sendMessageDuringGeneration. */
    | 'platform_unsupported'
    /** The machine has not reached a ready state even once — there is no composer
     *  to write into yet. */
    | 'not_ready'
    /** The session is not generating. The ordinary send path applies and is
     *  strictly better: it delivers as a real turn instead of an agent-queued one. */
    | 'not_generating'
    /** An earlier send is still mid-submit. Writing now would braid two bodies
     *  into one composer line — the SEND-OVERLAP defect. */
    | 'send_in_flight'
    /** The same body is already being delivered (pre-write duplicate gate). */
    | 'duplicate'
    /** The driver behind this adapter does not implement the split write (an
     *  out-of-tree ISpecDriver, or a test double). Reported rather than assumed
     *  successful, so the caller's fallback stays correct. */
    | 'not_supported';

/**
 * SEND-NOW-AGENT-QUEUE: write a body into a GENERATING composer so the CLI's
 * own input queue takes it, without interrupting the turn in flight.
 *
 * ── Why this is not the retired force-inject ──────────────────────────────
 * oss 6cca365b removed `forceSendMessage` after measuring that a body written
 * during generation was never consumed, while the caller was told it had been
 * sent. That measurement was real, but its conclusion generalised one write
 * SHAPE into a claim about all mid-generation writes. Re-measured live
 * (2026-09-12, claude-cli v2.1.220, node-pty direct):
 *
 *   ATOMIC  — one write of `text + '\r'`      → NOT consumed. The body sits
 *             in the composer; the CLI never queues it. This is exactly the
 *             shape forceSendMessage used, and exactly what 6cca365b measured.
 *   SPLIT   — write(text), gap, write('\r')   → CONSUMED. The TUI renders
 *             "Press up to edit queued messages" and the body is answered as
 *             the next turn when the current one ends.
 *
 * So the failing ingredient was the combined write, not the timing. This
 * method exists to express the SPLIT shape explicitly, and the atomic shape
 * remains forbidden — `actuallySendMessage` already writes the body and the
 * submit key as separate `send_keys` calls with a `delay_ms_before_submit`
 * gap between them, so the supported delivery is reused verbatim rather than
 * reimplemented here.
 *
 * ── POSIX ONLY, deliberately ──────────────────────────────────────────────
 * 6cca365b did not only delete a path; it also RETURNED win32 to the atomic
 * write because a delayed lone CR is not recognised as a submit by ConPTY
 * (the Ink composer absorbs it). That regression has not been re-measured —
 * no win32 machine was available for the 2026-09-12 session — so win32 is
 * refused here rather than being given an unverified new write path. Callers
 * get `{ accepted: false, reason: 'platform_unsupported' }` and fall back to
 * the behaviour they had before.
 *
 * ── Narrow by construction ────────────────────────────────────────────────
 * This is NOT a general send. It bypasses exactly one gate — `canSendNow()`'s
 * idle requirement — and keeps every other guard the ordinary path has
 * (duplicate suppression, the in-flight latch, ready-once). It is reached
 * only from the dashboard's explicit "Send now" press; nothing autonomous
 * (the FIFO drain, mesh dispatch, `send_chat` without `sendNow`) can enter
 * it. Optional so test doubles implementing ISpecDriver need not provide it.
 */

/**
 * SEND-NOW-AGENT-QUEUE: the outcome of a mid-generation split write.
 *
 * `accepted: true` means the body WAS written to the PTY as text + a separately
 * timed submit key, which the CLI's own input queue is expected to take. It is
 * deliberately not called `delivered`: the agent has not answered it yet, and
 * will not until the turn in flight ends. `accepted: false` always means no
 * bytes were written.
 */
export type QueuedWriteOutcome =
    | { accepted: true }
    | { accepted: false; reason: QueuedWriteRefusal };

/** SEND-NOW-AGENT-QUEUE: floor for the gap between the mid-generation body write
 *  and its submit key.
 *
 *  The separation is the whole mechanism — an atomic `text + '\r'` is not taken
 *  by the CLI's input queue, a split one is (see
 *  ISpecDriver.sendMessageDuringGeneration). The live A/B that established this
 *  used a ~400ms gap, so that is the floor rather than the ordinary
 *  SUBMIT_DELAY_FLOOR_MS of 200: this write lands while the composer is also
 *  being repainted by the turn in flight, which is strictly more contended than
 *  the settled prompt the 200ms floor was derived against, and the only evidence
 *  we have about what works here is at 400.
 *
 *  It is a FLOOR, not an override — resolveSubmitDelayMs' spec / manifest /
 *  size-derived value still wins when larger (cursor-cli and kimi declare 1200),
 *  so no provider's existing settling time is shortened by this path. */
export const MID_GENERATION_SUBMIT_MIN_GAP_MS = 400;
