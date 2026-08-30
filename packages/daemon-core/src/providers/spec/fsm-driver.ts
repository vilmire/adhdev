/**
 * FsmDriver — runs an adhdev:cli/spec@4 finite state machine against a PTY.
 *
 * Drop-in compatible with SpecDriver's public surface (subscribe / dispatch /
 * start / snapshot / getStateHistory / getDebugState / …) so the cli-adapter
 * can use either driver behind one interface. The difference is entirely
 * internal: instead of a stack of hard-coded debounce layers, this driver
 * holds ONE piece of state — the current FSM node — and on every screen change
 * asks the FSM evaluator "which outgoing transition fires?". All timing
 * (startup grace, busy hold, completion stability) is expressed in the spec as
 * transition guards (min_hold_ms) and time conditions (elapsed_ms / stable_ms).
 *
 * Because the engine carries no CLI knowledge, the only way it can be "wrong"
 * is if a spec's transitions are wrong — and that is fully inspectable via
 * getFsmDebug(), which reports every outgoing transition with its per-condition
 * match result and countdown. That is the contract: debug the spec, not the
 * engine.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalAdapter, type TerminalAdapterOpts, type SpecPtyEvent } from './adapter.js';
import { resolveCliSpawnPlanFromParts, stripRemovedSpawnArgs } from '../../cli-adapters/provider-cli-runtime.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import {
    resolveSections, sectionText, extractTitle, extractButtonsFromRule,
    type ResolvedSection, type TraceEntry,
} from './evaluator.js';
import { evaluateFsm, stableRegionKey, type FsmClock, type TransitionEval, type FsmEvaluation } from './fsm-evaluator.js';
import type { SignalSnapshot } from './signal-envelope.js';
import {
    type CliSpecV4, type FsmState, type FsmTransition,
    initialState, stateById, statusForState, modalKindForState, outgoingTransitions,
} from './fsm-types.js';
import { loadFsmSpec } from './fsm-loader.js';
import { applyPreLaunchTrust } from './pre-launch-trust.js';
import {
    createStartupDismissState, decideStartupDismiss, normalizeStartupDismissConfig, recordStartupDismiss,
    type StartupDismissConfig, type StartupDismissState,
} from '../../cli-adapters/startup-dismiss.js';
import type { Control, DelegateTrigger } from './types.js';
import { LOG } from '../../logging/logger.js';
import { recordDebugTrace } from '../../logging/debug-trace.js';
import { shouldCollectTraceCategory } from '../../logging/debug-config.js';
import {
    WIN32_PTY_WRITE_CHUNK_CHARS,
    WIN32_PTY_WRITE_CHUNK_GAP_MS,
    chunkPreservingSurrogates as chunkPreservingSurrogatesShared,
} from '../../cli-adapters/pty-write-chunking.js';

// ── Shared driver types (formerly in driver.ts) ───────────────────────────

export type DashboardEvent =
    | { kind: 'pty_data'; chunk: string }
    | { kind: 'state_changed'; state: { id: string; label: string; title: string | null; status: 'idle' | 'generating' | 'approval' };
        modal: { title: string | null; buttons: { index: number; label: string }[]; kind: 'approval' | 'picker' | 'confirm' | null } | null;
        controls: { id: string; label: string; action_type: string }[] }
    | { kind: 'notification'; id: string; title: string; body: string }
    | { kind: 'delegate'; id: string; task: string }
    | { kind: 'spec_trace'; entries: TraceEntry[] }
    | { kind: 'exit'; exit_code: number }
    | { kind: 'spec_error'; errors: string[] };

export type DashboardCommand =
    | { kind: 'send_message'; text: string; bracketedPaste?: boolean }
    | { kind: 'pty_write'; data: string }
    | { kind: 'click_control'; control_id: string; payload?: unknown }
    | { kind: 'click_modal_button'; index: number }
    | { kind: 'attach_image'; blob: string; mime: string }
    | { kind: 'resize'; cols: number; rows: number }
    | { kind: 'cancel' }
    | { kind: 'shutdown' };

export interface DriverHistoryEntry {
    stateId: string;
    label: string;
    at: number;
    durationMs: number;
    reason: string;
    matchedStateId?: string;
    matchedRules?: string[];
    debounceKind?: string;
    idleHoldMs?: number;
    busyHoldMs?: number;
    via?: string;
}

/**
 * A frozen snapshot of the FULL FSM evaluation captured at the instant a
 * transition fired — the rich `transitions[]` table (per-transition eligible /
 * hold countdown / per-condition CondResult + remainingMs) that `getFsmDebug()`
 * otherwise only computes live for the current instant. Kept in a separate ring
 * buffer from `stateHistory` (which stays intentionally lightweight) so the
 * "why did this rule fire just before the transition" question is answerable
 * after the fact. before-only: this is the evaluation that PRODUCED the
 * transition, not the post-transition state.
 */
export interface FsmSnapshotEntry {
    /** State we transitioned out of. */
    stateFrom: string;
    /** State we transitioned into (the fired transition's destination). */
    stateTo: string;
    /** Wall-clock time the transition committed (ms). */
    at: number;
    /** The fired transition's destination state id (== stateTo; kept explicit
     *  to mirror the rule that fired). */
    firedTo: string;
    /** Human label of the fired transition (e.g. "approval→busy"). */
    firedLabel: string;
    /** Why-it-fired summary, same shape produced for stateHistory.matchedRules. */
    reason: string[];
    /** Every outgoing transition from `stateFrom` as evaluated at `at`, each
     *  with its eligible / hold / per-condition CondResult + remainingMs. This
     *  is the full pre-transition evaluation table — the whole point of the
     *  snapshot. */
    transitions: TransitionEval[];
}

export interface ISpecDriver {
    subscribe(listener: (ev: DashboardEvent) => void): () => void;
    start(): void;
    dispatch(cmd: DashboardCommand): void;
    /**
     * BUTTON-INDEX-MISMAP (Fix C.3): click a modal button by its FSM display index and report
     * whether a button was actually matched and its confirm keys dispatched. Unlike the
     * fire-and-forget `dispatch('click_modal_button')`, callers that need to know the click
     * landed (mesh_approve → SpecCliAdapter.resolveModalMatched) can observe a miss.
     */
    clickModalButton(index: number): boolean;
    updateMeta(meta: Record<string, unknown>, replace?: boolean): void;
    snapshot(): string;
    getCursorPosition(): { row: number; col: number };
    getScreen(): string;
    /** Current terminal geometry (columns × rows). Optional so a non-Fsm
     *  ISpecDriver implementation (test doubles) need not provide it; the
     *  mesh_read_terminal path falls back to a 0×0 geometry when absent. */
    getScreenSize?(): { cols: number; rows: number };
    getSpecPath(): string;
    shutdown(): void;
    getStateHistory(): ReadonlyArray<DriverHistoryEntry>;
    getSections(): Array<{ id: string; text: string }> | null;
    getLastBusyAt(): number;
    hasIdleHoldPending(): boolean;
    hasSeenReady(): boolean;
    getCompletionIdleDebounceState(): { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null;
    getFsmDebug?(): unknown;
    getFsmSnapshotHistory?(): ReadonlyArray<FsmSnapshotEntry>;
    getEventTimeline?(limit?: number): ReadonlyArray<SpecPtyEvent>;
    /**
     * TX-FSM Stage 0 (shadow): inject the daemon-normalized signal observation.
     * Observation ONLY — the driver receives the envelope, never a reader; all
     * file discovery / session pinning / parsing stays daemon-side so the FSM
     * engine remains a generic PTY engine. The snapshot feeds the shadow
     * verdict of `signal` conditions exclusively; it cannot gate a transition.
     */
    setSignalObservation?(snapshot: SignalSnapshot | null): void;
}

export interface SpecDriverOpts {
    specPath: string;
    workingDir: string;
    extraEnv?: Record<string, string>;
    cols?: number;
    rows?: number;
    hotReload?: boolean;
    emitTrace?: boolean;
    transportFactory?: PtyTransportFactory;
    extraCliArgs?: string[];
    /**
     * FSMLOG-SESSION-ATTRIBUTION (D3): the owning provider instance's session id, used only to
     * prefix this driver's log lines. Without it every concurrent session logs under the same
     * `[cli/claude-code/4.0.json]` tag, so multi-session logs cannot be attributed to a session
     * — the direct cause of a misdiagnosis where one session's FSM transitions were read as
     * another's. Optional: callers that have no session id (tests, out-of-tree embedders) fall
     * back to a per-instance short uid, which still groups one driver's lines together.
     */
    sessionId?: string;
    /**
     * MANIFEST-SEND-DELAY: the provider manifest's `sendDelayMs`, threaded in from
     * route.ts so the spec path actually honours it. Before this it was DEAD on the
     * spec path — its only reader belonged to the ProviderCliAdapter engine deleted
     * in 48e5ed1a — which made manifests actively misleading: grok-cli declares
     * `sendDelayMs: 1200` while its spec says 200, so it ran at 200 and an
     * investigation into a grok submit failure was nearly waved off on the strength
     * of the declared-but-unused 1200.
     *
     * It is a FLOOR, not an override: resolveSubmitDelayMs takes the max of this,
     * the spec's `delay_ms_before_submit`, and the size-derived bonus. A manifest
     * therefore can only ask for MORE settling time than the spec/heuristic already
     * computed, never less — so wiring it cannot shorten any existing wait and
     * cannot weaken the echo-gate that d7332b84 put in front of the submit key.
     */
    manifestSendDelayMs?: number;
    /**
     * PERMISSION-MODE-DUPLICATE: the selected auto-approve mode's `removeArgs` — base-arg
     * flags that this launch's `extraCliArgs` replace. `applyAutoApproveModeLaunchArgs`
     * filters them out of the provider MANIFEST's `spawn.args`, but this path spawns from
     * the SPEC's `spawn_args`, so without threading the list here the two collide: grok-cli
     * in `auto` mode spawned `--permission-mode acceptEdits --permission-mode auto`, which
     * its clap-based CLI rejects.
     *
     * The LIST is threaded rather than a pre-filtered array because the manifest and the
     * spec legitimately declare different values for the same flag (claude-cli: manifest
     * `acceptEdits`, specs/4.0.json `default`).
     */
    removeSpawnArgs?: string[];
}

function countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
    return n;
}

const SUBMIT_DELAY_FLOOR_MS = 200;

// ── send_message serialization (SEND-OVERLAP) ────────────────────────────────
//
// Live defect (2026-08-10, antigravity/darwin): one coordinator-side enqueue of a
// ~1.5KB task arrived in the worker transcript as TWO user bubbles 8.5s apart —
// the second one CORRUPTED, missing ~90 chars out of its MIDDLE while head and
// tail survived. That signature is an interleave, not an overflow: a second body
// was written into the composer while the first turn was still being consumed, so
// the two writes braided.
//
// Root cause: handleSendMessage gated only on `readySeenOnce`, a ONE-SHOT latch.
// Once the machine had ever been ready, EVERY later send went straight to the PTY
// without consulting the current FSM state — so a resend landing mid-turn was
// written on top of a `generating` turn. The pre-write duplicate gate that should
// have absorbed the resend (isRecentDuplicateSend in chat-commands-write.ts) has a
// 1.2s window, and the only 60s-window dedup (recordAcknowledgedUserInput) runs
// AFTER the PTY write and merely collapses the display bubble. The observed 8.5s
// gap falls in the hole between the two.
//
// The fix is state-gated serialization, mirroring what the legacy
// provider-cli-adapter already does with pendingOutboundQueue + ptyWriteChain:
// a send that arrives while the machine is busy/approval, or while a previous
// send is still in flight, is QUEUED (never written concurrently) and drained
// when the machine returns to idle.

/** Upper bound on how long a written-but-unobserved send holds the in-flight
 *  latch. The latch normally clears the moment the FSM leaves idle (the CLI
 *  visibly consumed the submit). A CLI that submits without any observable state
 *  change would otherwise wedge the queue forever, so the latch self-expires.
 *  Generous: it must outlast the win32 echo-gate + resend budget (~20s) so a slow
 *  but legitimate submit is never treated as abandoned. */
const SEND_IN_FLIGHT_MAX_MS = 30_000;

/** Duplicate-resend suppression window for the PRE-WRITE gate. Sized to match
 *  USER_INPUT_ACK_DEDUP_WINDOW_MS (60s), the post-write bubble-collapse window in
 *  cli-provider-instance — the two now cover the same span, closing the
 *  1.2s..60s hole where a redelivery was collapsed in the UI but had already been
 *  written to the PTY twice.
 *
 *  This is deliberately NOT applied to sends that go out while the machine is
 *  idle and nothing is in flight — see isDuplicateResend. A user legitimately
 *  typing the same text twice ("continue", "y", "run it again") is a normal turn
 *  and must still reach the CLI; only a resend that collides with the SAME text
 *  still being processed is dropped. */
const DUPLICATE_RESEND_WINDOW_MS = 60_000;

/** djb2 — a short, stable content hash for the duplicate gate. Not security
 *  relevant; only needs to make accidental collisions vanishingly unlikely
 *  while keeping the map keys small. */
function hashSendText(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = (((h << 5) + h) ^ text.charCodeAt(i)) >>> 0;
    return `${h.toString(36)}:${text.length}`;
}

/** FSMLOG-SESSION-ATTRIBUTION (D3): fallback log-tag sequence for drivers constructed without a
 *  session id. Process-local and monotonic — enough to group one driver's lines together. */
let fsmDriverSeq = 0;

// win32 ConPTY submit reliability — TWO independent concerns, do not conflate:
//
//   (A) WHEN the single real submit CR fires. The first CR must not fire until
//       the WHOLE body has echoed into the composer; a MULTILINE body also opens
//       an Ink paste/newline-accumulation window during which a lone CR can be
//       absorbed as a literal newline rather than submitting, with a
//       nondeterministic length (observed 0–~2s, driven by ConPTY byte timing).
//       So we VERIFY instead of guessing: hold the CR behind the head+tail
//       echo-gate (scheduleVerifiedSubmit phase 1), then resend the submit key on a
//       fixed cadence until the FSM observes the agent has actually left the idle
//       composer (status flips away from 'idle' — submitted / generating / modal),
//       bounded by a retry budget (phase 2). Once submission is observed we stop
//       so we don't spam Enter into the next turn. Single-line messages satisfy
//       the check after the first CR, so their behaviour is unchanged.
//
//   (B) HOW the body's OWN embedded newlines are written (FIX-B-v2). On the real
//       win32 Ink/ConPTY composer each embedded '\n' in the body SUBMITS the
//       preceding line as a separate composer entry, so writing the raw body
//       (writeWin32Body) submitted every line but the last BEFORE the trailing
//       echo-gated CR (A) ever ran — the prompt was truncated to only the tail
//       fragment after the last '\n' (failure_category=per_newline_submit). The
//       body must therefore land atomically as composer TEXT with ZERO per-line
//       submits. writeWin32Body now does that: it wraps a newline-bearing body in
//       a bracketed-paste (ESC[200~ … ESC[201~) so the composer takes the whole
//       thing — embedded newlines and all — as pasted text (PRIMARY mode), or in
//       the soft_newline fallback rewrites each embedded newline as a
//       non-submitting Shift+Enter sequence. EITHER way the trailing submit CR is
//       NOT part of this write — it stays separate and is fired later by (A).
//
// NOTE on the old "bracketed-paste wrapping does NOT help" claim that used to live
// here: that A/B fused the submit CR *inside* the paste (…body\r…201~), so the
// paste-closing still carried a submit and was never a clean text-only paste. The
// correct shape — paste wraps ONLY the body, CR stays separate — is what FIX-B-v2
// implements; it was never actually tested by that earlier A/B.
const WIN32_SUBMIT_RESEND_GAP_MS = 350;
const WIN32_SUBMIT_MAX_RESENDS = 14;
// Quiet window the win32 echo-gate (below) requires AFTER the body is seen in the
// composer, so a CR fires only once the FULL (possibly multi-KB / multiline) body has
// finished arriving and echoing — not mid-arrival. POLL_MS is the gate's recheck
// cadence while it waits for the body to echo.
const WIN32_SUBMIT_SETTLE_MS = 500;
const WIN32_SUBMIT_SETTLE_POLL_MS = 120;
// Defensive paced PTY write tuning (WIN32_PTY_WRITE_CHUNK_CHARS / _GAP_MS) and the
// surrogate-safe splitter live in the shared cli-adapters/pty-write-chunking module —
// see the import above. (It was originally shared with the legacy ProviderCliAdapter
// engine, deleted in 48e5ed1a; this driver is now its only runtime consumer.)
// Echo-gate for the win32 FIRST submit CR (supersedes the bare output-quiet settle).
// The body write can race claude-cli's boot — its stdin reader is not wired until the
// composer renders (~5–7s in, later under load), so a too-early write is buffered and
// the output goes quiet with a still-EMPTY composer; a quiet-only gate then fires a CR
// into nothing. Instead, hold the CR until the body text has actually ECHOED into the
// composer (effect-confirmed, not readiness-signal-guessed) — the buffered write lands
// once claude wires up, just late. WIN32_ECHO_MAX_WAIT_MS bounds the wait so a body
// that truly never confirms still fires a blind CR (resend net) rather than hanging; it
// is set generously so even a slow/contended boot lands its body before the blind fire.
const WIN32_ECHO_PROBE_CHARS = 16;
const WIN32_ECHO_MAX_WAIT_MS = 20_000;

// ── POSIX-ENTER-DROP (2026-08-23, grok-cli/darwin) ───────────────────────────
//
// Live defect: a ~several-KB coordinator brief was injected into a grok-cli
// session and the submit CR never took — the body sat unsent in the composer
// until the owner pressed Enter by hand. Coordinator-side the session read
// `runtimeInputAck: true`, 1 user message, 0 assistant messages, status
// `generating` — i.e. a SILENT submit failure that looks like healthy work.
//
// Root cause: the verification machinery above (echo-gate → resend-until-observed)
// was gated on `process.platform === 'win32'`. Every POSIX send took the blind
// branch in actuallySendMessage: write the whole body in ONE send_keys, then fire
// the CR from a bare setTimeout(beforeSubmit). That timer was NOT a function of
// body size — resolveSubmitDelayMs scaled on newline COUNT only — so a multi-KB
// single-paragraph body (few newlines) scored the 200ms floor. On a TUI that is
// still ingesting and re-rendering kilobytes of pasted text, a CR at 200ms is
// absorbed by the composer as part of the paste rather than acting as submit.
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
// (see concern (B) above). 'paste' (default) wraps the body in a bracketed-paste so
// the Ink composer absorbs the whole thing as text; 'soft_newline' rewrites each
// embedded newline as a non-submitting Shift+Enter. Whether THIS ConPTY honors
// bracketed-paste can only be confirmed by the live deploy A/B (we cannot A/B it via
// delegation — win32 truncates any newline-bearing task), so both modes ship and the
// fallback is selectable at runtime via ADHDEV_WIN32_SUBMIT_MODE.
export type Win32SubmitMode = 'paste' | 'soft_newline';
const WIN32_BRACKETED_PASTE_OPEN = '\x1b[200~';
const WIN32_BRACKETED_PASTE_CLOSE = '\x1b[201~';
// Platform-agnostic aliases: the same bracketed-paste region is used on POSIX
// for image-bearing bodies (see actuallySendMessage's bracketedPaste branch).
const BRACKETED_PASTE_OPEN = WIN32_BRACKETED_PASTE_OPEN;
const BRACKETED_PASTE_CLOSE = WIN32_BRACKETED_PASTE_CLOSE;
// Non-submitting soft-newline for the claude-cli Ink composer. The spec
// (cli/claude-cli/specs/4.0.json) declares no soft-newline keycode, so we use the
// CSI-u encoding of Shift+Enter (modifyOtherKeys form: keycode 13 = Enter, modifier
// 2 = Shift). This inserts a literal newline into the composer WITHOUT submitting,
// unlike a bare CR (\r) which is reserved for the single real submit via (A).
const WIN32_SOFT_NEWLINE = '\x1b[27;2;13~';

export function resolveWin32SubmitMode(env: NodeJS.ProcessEnv = process.env): Win32SubmitMode {
    return env.ADHDEV_WIN32_SUBMIT_MODE === 'soft_newline' ? 'soft_newline' : 'paste';
}

/** Collapse a string to its non-whitespace characters for echo comparison: the
 *  composer wraps, indents, and prefixes the body (with the `❯ ` prompt), so a raw
 *  substring test against the rendered screen fails. Stripping all whitespace makes
 *  "❯ hello world" reliably contain the probe "helloworld". */
function normalizeForEcho(s: string): string {
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
 *  `chunkPreservingSurrogates` from this module keep working. The implementation
 *  lives in ../../cli-adapters/pty-write-chunking (originally shared with the
 *  legacy adapter engine, deleted in 48e5ed1a). */
export const chunkPreservingSurrogates = chunkPreservingSurrogatesShared;

export function guessExt(mime: string): string {
    if (/png/i.test(mime)) return '.png';
    if (/jpe?g/i.test(mime)) return '.jpg';
    if (/gif/i.test(mime)) return '.gif';
    if (/webp/i.test(mime)) return '.webp';
    return '.bin';
}

// ─────────────────────────────────────────────────────────────────────────────

interface ModalSnapshot {
    title: string | null;
    buttons: { index: number; label: string; key: string; current: boolean }[];
}

interface VisibleControl {
    id: string;
    label: string;
    actionType: 'send_keys' | 'open_picker' | 'attach_image';
}

type HistoryEntry = DriverHistoryEntry;

/** Per-state evaluation snapshot (mirrors v3 SpecEvaluation shape for the
 *  parts the cli-adapter / panel consume). */
interface CurrentEval {
    state: { id: string; label: string; title: string | null; status: 'idle' | 'generating' | 'approval' };
    modal: ModalSnapshot | null;
    controls: VisibleControl[];
}

export class FsmDriver implements ISpecDriver {
    private spec!: CliSpecV4;
    private adapter: TerminalAdapter;
    private listeners = new Set<(ev: DashboardEvent) => void>();

    // ── The entire FSM state: which node we're in, and when we entered it.
    private currentStateId = '';
    private stateEnteredAt = 0;

    // ── Clock bookkeeping for time conditions.
    private startedAtMs = 0;
    private prevScreenLines: string[] = [];
    /** Per stable region → last time that region's content changed. Drives
     *  stable_ms conditions. Key = stableRegionKey(cond): numeric cursor_above
     *  (−1 = whole screen), or a `section:<id>` / `<region>#ignore:<pat>` string
     *  when the clause scopes to a section or declares an ignore_lines filter. */
    private regionLastChangedAt = new Map<number | string, number>();
    /** COMPLETION-EARLYNOTIFY stable-eval trace: last stable/not-stable verdict
     *  recorded per stable region, so the trace fires only when the verdict FLIPS
     *  (not every quiet frame). Cleared on every transition alongside
     *  regionLastChangedAt. Diagnostic-only — never consulted by the FSM. */
    private stableVerdictCache = new Map<number | string, boolean>();
    /** Timer that re-runs evaluate() when a time-condition would flip true
     *  with no PTY frame to trigger it. */
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Boot-prompt dismissal (CliSpecV4.startup_dismiss — OPENCODE-UPDATE-MODAL
     *  class). Config normalized once at start(); the shared decision engine
     *  bounds writes by spawn window + attempt cap + per-snapshot dedupe. */
    private startupDismissConfig: StartupDismissConfig | null = null;
    private startupDismissState: StartupDismissState = createStartupDismissState();
    /** Wall clock at start() — the spawn anchor for the dismiss window. */
    private startupDismissSpawnAt = 0;
    /** Timer driving the focus-gated stall watchdog (refocus_when_stalled_ms).
     *  Re-arms itself while the machine is generating so a re-prime can fire
     *  even when the PTY has gone completely quiet. */
    private stallTimer: ReturnType<typeof setTimeout> | null = null;
    /** Wall-clock time the last stall re-prime was injected. The cooldown gate:
     *  after a re-prime we don't re-inject until the screen changes (which
     *  resets the stall reference) or another full stall window lapses. */
    private lastRefocusAt = 0;
    /** Timer driving the win32 verification-based submit resend loop (see
     *  WIN32_SUBMIT_* and scheduleVerifiedSubmit). Re-arms itself until the FSM
     *  leaves idle (submitted) or the resend budget is spent. */
    private win32SubmitTimer: ReturnType<typeof setTimeout> | null = null;
    /** Wall-clock (ms) of the most recent raw PTY output chunk. Advances on every
     *  on_pty_data — including the echo of text written into the composer — so the
     *  win32 submit settle-gate can tell when input has finished landing. */
    private lastPtyDataAt = 0;
    /** Wall-clock (ms) of the most recent win32 message-body input write. Bridges
     *  the gap between writing a chunk and its echo so the settle-gate does not
     *  declare "quiet" mid-write. */
    private lastWin32WriteAt = 0;
    /** Pending paced chunk-write timer for a large win32 body (see writeWin32Body). */
    private win32WriteTimer: ReturnType<typeof setTimeout> | null = null;
    /** Timer driving the win32 verification-based modal-confirm CR resend loop (see
     *  scheduleWin32ModalConfirm). A lone CR that confirms an approval/picker choice
     *  is absorbed by ConPTY the same way a send_message submit CR is, so the confirm
     *  must be resent until the modal actually resolves (status leaves 'approval'). */
    private win32ModalConfirmTimer: ReturnType<typeof setTimeout> | null = null;
    /** SUBMIT-SILENT-FAILURE: set when scheduleVerifiedSubmit spent its whole resend
     *  budget without the FSM ever leaving 'idle' — i.e. the body is still sitting
     *  unsent in the composer. Cleared on the next send. Exposed via
     *  lastSubmitUnconfirmed() so a supervisor can distinguish "agent is thinking"
     *  from "the prompt was never actually submitted". */
    private submitUnconfirmed = false;

    private currentEval: CurrentEval | null = null;
    private stateHistory: HistoryEntry[] = [];
    private prevStateAt = 0;

    // ── send_message queueing until the machine first reaches a non-initial,
    //    non-busy ("ready") state — same contract as v3's idleSeenOnce.
    private readySeenOnce = false;
    /** Queued send bodies. `bracketedPaste` rides along so a queued image
     *  prompt keeps its paste-wrapped delivery when drained later. */
    private pendingSends: { text: string; bracketedPaste?: boolean }[] = [];
    /** True while a send is written but the FSM has not yet left idle, i.e. the
     *  composer is mid-submit. Blocks a second send from overwriting the first
     *  before the CLI has consumed it (see handleSendMessage). */
    private sendInFlight = false;
    /** Wall-clock (ms) the in-flight send was written. Bounds sendInFlight so a
     *  send the CLI never visibly consumed cannot wedge the queue forever. */
    private sendInFlightAt = 0;
    /** Content hash → wall-clock of the last PTY write, for the pre-write
     *  duplicate gate (see isDuplicateResend). */
    private recentSendHashes = new Map<string, number>();
    /** Pending queued-send drain timer, tracked so shutdown() can cancel it and
     *  a torn-down driver never writes a queued body into a dead PTY. */
    private pendingSendDrainTimer: ReturnType<typeof setTimeout> | null = null;

    private pickerInProgress: { control_id: string; spec: Control } | null = null;
    private delegateTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private specWatcher: fs.FSWatcher | null = null;
    /** Last full FSM evaluation, kept for the debugger. */
    private lastFsmEval: ReturnType<typeof evaluateFsm> | null = null;
    /** Ring buffer (max 20) of the full FSM evaluation captured at each
     *  transition — the rich pre-transition table that lastFsmEval only keeps
     *  for the single most recent evaluation. Separate from stateHistory. */
    private fsmSnapshotHistory: FsmSnapshotEntry[] = [];
    /** TX-FSM Stage 0 (shadow): the latest daemon-injected signal observation.
     *  Read by evalFsmNow for the shadow verdict of `signal` conditions ONLY —
     *  the Stage-0 pass-through in the evaluator means it can never alter
     *  which transition fires. */
    private signalObservation: SignalSnapshot | null = null;
    /** Per-transition last-logged shadow divergence (`${from}→${to}` → whether
     *  the shadow verdict currently disagrees with the real one), so the
     *  shadow log emits on FLIP only, not every frame. */
    private shadowDivergenceLast = new Map<string, boolean>();
    /** FSMLOG-SESSION-ATTRIBUTION (D3): session segment of every log line's prefix. */
    private readonly sessionTag: string;

    constructor(private readonly opts: SpecDriverOpts) {
        const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
        this.sessionTag = sessionId ? sessionId.slice(0, 8) : `d${++fsmDriverSeq}`;
        this.loadSpecOrThrow();
        this.adapter = new TerminalAdapter(
            this.buildAdapterOpts(),
            {
                init: () => this.emitInitialState(),
                on_pty_data: (chunk) => { this.lastPtyDataAt = Date.now(); this.emit({ kind: 'pty_data', chunk }); },
                on_screen_changed: () => this.reevaluate(),
                on_exit: ({ exitCode }) => this.handleExit(exitCode),
            },
        );
        if (this.opts.hotReload !== false) this.armSpecWatcher();
    }

    subscribe(listener: (ev: DashboardEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    start(): void {
        const now = Date.now();
        this.startedAtMs = now;
        const init = initialState(this.spec);
        this.currentStateId = init.id;
        this.stateEnteredAt = now;
        this.prevStateAt = now;
        // Pre-trust the workspace before spawning so a first-run folder-trust
        // prompt never appears (best-effort; failures fall back to the FSM's
        // trust-modal detection). Only runs for specs that declare it.
        if (this.spec.pre_launch_trust) {
            applyPreLaunchTrust(this.spec.pre_launch_trust, this.opts.workingDir);
        }
        this.startupDismissConfig = normalizeStartupDismissConfig(this.spec.startup_dismiss);
        this.startupDismissState = createStartupDismissState();
        this.startupDismissSpawnAt = now;
        this.adapter.start();
        // Prime focus-gated TUIs (see CliSpecV4.send_on_spawn). Written once,
        // shortly after spawn, so the input stream is awake before the first
        // delegated message — without this, a focus-event CLI like antigravity
        // drops the first programmatic write until a manual keystroke.
        this.scheduleSpawnPrime();
        // The initial state may have a purely time-based exit (elapsed_ms);
        // schedule a wake so we leave it even if the PTY goes quiet.
        this.scheduleWakeForState();
    }

    private scheduleSpawnPrime(): void {
        const seqs = this.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        const delay = Math.max(0, this.spec.send_on_spawn_delay_ms ?? 250);
        setTimeout(() => this.sendSpawnPrime(), delay);
    }

    /** Write the declared `send_on_spawn` sequences to the PTY once. Used both
     *  at spawn (scheduleSpawnPrime) and, for focus-gated TUIs, by the stall
     *  watchdog to re-inject the focus-in wake mid-turn. No-op when the spec
     *  declares no prime, so non-focus-gated CLIs are never poked. */
    private sendSpawnPrime(): void {
        const seqs = this.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        for (const seq of seqs) {
            if (typeof seq === 'string' && seq.length > 0) this.adapter.send_keys(seq);
        }
    }

    /** Boot-prompt dismissal (CliSpecV4.startup_dismiss). Runs on every
     *  reevaluation; the shared decision engine makes it a cheap no-op outside
     *  the spawn window and bounds writes (attempt cap + per-snapshot dedupe),
     *  so a prompt that survives the key can never become a key-spam loop. */
    private maybeDismissStartupPrompt(screen: string, now: number): void {
        if (!this.startupDismissConfig) return;
        const verdict = decideStartupDismiss(
            this.startupDismissConfig, this.startupDismissState, screen, this.startupDismissSpawnAt, now,
        );
        if (!verdict.dismiss) return;
        recordStartupDismiss(this.startupDismissState, screen);
        LOG.info('FsmDriver', `[${this.specTag()}] startup prompt matched /${verdict.matchedPattern}/ — sending dismiss key (attempt ${this.startupDismissState.attempts})`);
        try { this.adapter.send_keys(this.startupDismissConfig.key); } catch { /* pty gone — nothing to dismiss */ }
    }

    dispatch(cmd: DashboardCommand): void {
        switch (cmd.kind) {
            case 'send_message': this.handleSendMessage(cmd.text, cmd.bracketedPaste); return;
            case 'pty_write': this.adapter.send_keys(cmd.data); return;
            case 'click_control': this.handleClickControl(cmd.control_id, cmd.payload); return;
            case 'click_modal_button': this.clickModalButton(cmd.index); return;
            case 'attach_image': this.handleAttachImage(cmd.blob, cmd.mime); return;
            case 'resize': this.adapter.resize(cmd.cols, cmd.rows); return;
            case 'cancel': this.adapter.send_keys('\x03'); return;
            case 'shutdown': this.shutdown(); return;
        }
    }

    /** Forward runtime metadata to the terminal transport so mesh binding
     *  fields (meshNodeId / meshNodeFor / workspaceLabel / lifecycle) reach
     *  the session registry. Not a DashboardCommand — this is a control-plane
     *  update, not user input. */
    updateMeta(meta: Record<string, unknown>, replace = false): void {
        this.adapter.updateMeta(meta, replace);
    }

    /**
     * TX-FSM Stage 0 (shadow): receive the daemon-normalized signal
     * observation. The driver stores it verbatim — it does NOT poll, parse,
     * or read anything itself (generic-PTY-engine boundary). The observation
     * only feeds the shadow verdict of `signal` conditions; the evaluator's
     * Stage-0 pass-through guarantees it cannot change a transition.
     */
    setSignalObservation(snapshot: SignalSnapshot | null): void {
        this.signalObservation = snapshot ?? null;
    }

    snapshot(): string { return this.adapter.snapshot(); }
    getCursorPosition(): { row: number; col: number } { return this.adapter.getCursorPosition(); }
    getScreen(): string { return this.adapter.snapshot(); }
    getScreenSize(): { cols: number; rows: number } { return this.adapter.getScreenSize(); }

    /** Scrollback-inclusive screen as line array — used only for modal/button
     *  content extraction so a tall prompt's off-screen anchors stay matchable.
     *  Falls back to the viewport snapshot if scrollback read is unavailable. */
    private scrollbackLines(): string[] {
        let screen = '';
        try {
            screen = this.adapter.snapshotWithScrollback();
        } catch { /* fall through to viewport */ }
        if (!screen) screen = this.adapter.snapshot();
        return screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    }
    getSpecPath(): string { return this.opts.specPath; }

    shutdown(): void {
        for (const t of this.delegateTimers.values()) clearTimeout(t);
        this.delegateTimers.clear();
        if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
        if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
        if (this.win32SubmitTimer) { clearTimeout(this.win32SubmitTimer); this.win32SubmitTimer = null; }
        if (this.win32WriteTimer) { clearTimeout(this.win32WriteTimer); this.win32WriteTimer = null; }
        if (this.win32ModalConfirmTimer) { clearTimeout(this.win32ModalConfirmTimer); this.win32ModalConfirmTimer = null; }
        // SEND-OVERLAP: drop the queued-send drain and its backlog — a torn-down
        // driver must never write a queued body into a dead PTY.
        if (this.pendingSendDrainTimer) { clearTimeout(this.pendingSendDrainTimer); this.pendingSendDrainTimer = null; }
        this.pendingSends.length = 0;
        this.specWatcher?.close();
        this.adapter.kill();
    }

    // ── Debug surface (the whole reason for the rewrite) ──────────────────
    //
    // getFsmDebug() answers, for the CURRENT instant: which state am I in,
    // how long have I been here, and for every outgoing transition — does its
    // guard pass right now, and if not, which sub-condition is blocking and
    // how many ms until it would flip. No screenshots required.

    getFsmDebug(): {
        currentState: string;
        label: string;
        stateAgeMs: number;
        status: string;
        cursor: { row: number; col: number };
        transitions: TransitionEval[];
    } {
        const now = Date.now();
        const cursor = this.adapter.getCursorPosition();
        const screen = this.adapter.snapshot();
        const ev = this.evalFsmNow(screen, cursor, now);
        const state = stateById(this.spec, this.currentStateId);
        return {
            currentState: this.currentStateId,
            label: state?.label ?? this.currentStateId,
            stateAgeMs: now - this.stateEnteredAt,
            status: state ? statusForState(state) : 'idle',
            cursor,
            transitions: ev.transitions,
        };
    }

    getStateHistory(): ReadonlyArray<HistoryEntry> { return this.stateHistory; }
    getFsmSnapshotHistory(): ReadonlyArray<FsmSnapshotEntry> { return this.fsmSnapshotHistory; }
    /** Debug-only PTY input/output/resize/cursor timeline from the adapter. */
    getEventTimeline(limit?: number): ReadonlyArray<SpecPtyEvent> {
        return this.adapter.getEventTimeline(limit);
    }
    getSections(): Array<{ id: string; text: string }> | null {
        try {
            const screen = this.adapter.snapshot();
            const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
            return resolveSections(this.spec.sections ?? {}, lines).map(s => ({ id: s.id, text: s.text }));
        } catch { return null; }
    }

    /** v3-compat shims so the cli-adapter's existing debug snapshot keeps
     *  working without branching on driver type. */
    getLastBusyAt(): number {
        // Approximate: time we entered a generating-status state.
        const st = stateById(this.spec, this.currentStateId);
        return st && statusForState(st) === 'generating' ? this.stateEnteredAt : 0;
    }
    hasIdleHoldPending(): boolean {
        // FSM has no separate idle-hold timer; min_hold_ms is the analog.
        // Report true while any outgoing transition is hold-blocked.
        return (this.lastFsmEval?.transitions ?? []).some(t => !t.holdSatisfied && t.condResult);
    }
    /**
     * True once the machine has reached its first non-initial idle state (the
     * prompt is genuinely drawn — see maybeMarkReady). The cli-adapter surfaces
     * this on its idle status so CliProviderInstance can re-arm the queue-claim
     * agent:ready on the first genuine ready, independent of the boot-time
     * starting→idle one-shot (which is consumed too early for specs whose
     * initial state already reports idle).
     */
    hasSeenReady(): boolean {
        return this.readySeenOnce;
    }
    getCompletionIdleDebounceState(): { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null {
        // Surface the busy→ready transition's stable countdown, if any, so the
        // existing panel field stays meaningful.
        const out = outgoingTransitions(this.spec, this.currentStateId);
        const toReady = this.lastFsmEval?.transitions.find((t, i) => {
            const st = stateById(this.spec, out[i]?.to ?? '');
            return st && statusForState(st) === 'idle';
        });
        if (!toReady || !toReady.cond) return null;
        const stable = findStable(toReady.cond);
        if (!stable) return null;
        return { active: true, ageMs: 0, holdMs: stable.totalMs, forceAfterMs: 0 };
    }

    // ────────────────────────────────────────────────────────────────────
    // Loading & adapter wiring
    // ────────────────────────────────────────────────────────────────────

    private loadSpecOrThrow(): void {
        const res = loadFsmSpec(this.opts.specPath);
        if (!res.ok) throw new Error(`fsm spec invalid: ${res.errors.join('; ')}`);
        this.spec = res.spec;
    }

    private buildAdapterOpts(): TerminalAdapterOpts {
        // Single-source spawn resolution: route the spec's binary/args/env
        // through the shared spawn planner (resolveCliSpawnPlanFromParts,
        // inherited from the legacy ProviderCliAdapter engine deleted in
        // 48e5ed1a). This gives the spec/FSM path
        // findBinary (PATH + npm-global / Node-dir fallback so an off-PATH
        // `codex`/`claude` resolves), `{{workingDir}}` token substitution, shell
        // wrapping for script-shims / non-absolute / non-native binaries, and a
        // sanitized env with TERMINAL_CWD — none of which it had when it passed
        // `this.spec.binary` straight to the PTY.
        const cols = this.opts.cols ?? DEFAULT_SESSION_HOST_COLS;
        const rows = this.opts.rows ?? DEFAULT_SESSION_HOST_ROWS;
        // PERMISSION-MODE-DUPLICATE: the spec's own base args are subject to the
        // selected auto-approve mode's removeArgs, exactly as the manifest's
        // spawn.args are in applyAutoApproveModeLaunchArgs. Without this the two
        // sources both contribute a `--permission-mode`.
        const specSpawnArgs = stripRemovedSpawnArgs(
            this.spec.spawn_args ?? [],
            this.opts.removeSpawnArgs ?? [],
        );
        const plan = resolveCliSpawnPlanFromParts({
            command: this.spec.binary,
            baseArgs: specSpawnArgs,
            baseEnv: this.spec.env ?? {},
            workingDir: this.opts.workingDir,
            extraArgs: this.opts.extraCliArgs ?? [],
            extraEnv: this.opts.extraEnv ?? {},
            geometry: { cols, rows },
            // CliSpecV4 is the FSM runtime spec (specs/4.0.json), not the
            // provider manifest, so it carries no `type`/`providerVersion`.
            // `id`/`name` is the identity this path actually has; the manifest
            // version is genuinely unavailable here rather than omitted.
            diagnosticCliType: this.spec.id || this.spec.name,
        });
        return {
            binary: plan.shellCmd,
            args: plan.shellArgs,
            cwd: plan.ptyOptions.cwd,
            // plan.ptyOptions.env is already a complete, sanitized environment —
            // pass it verbatim, do not overlay process.env (see envIsComplete).
            env: plan.ptyOptions.env,
            envIsComplete: true,
            cols,
            rows,
            transportFactory: this.opts.transportFactory,
        };
    }

    private armSpecWatcher(): void {
        try {
            const dir = path.dirname(this.opts.specPath);
            const base = path.basename(this.opts.specPath);
            this.specWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
                if (filename && filename !== base) return;
                const res = loadFsmSpec(this.opts.specPath);
                if (!res.ok) {
                    this.emit({ kind: 'spec_error', errors: res.errors });
                    return;
                }
                this.spec = res.spec;
                LOG.info('FsmDriver', `[${this.specTag()}] spec hot-reloaded`);
                // Re-evaluate immediately with the new transitions.
                this.reevaluate(true);
            });
        } catch { /* best-effort */ }
    }

    private emitInitialState(): void {
        this.reevaluate(true);
    }

    // ────────────────────────────────────────────────────────────────────
    // Core: evaluate the FSM and commit transitions
    // ────────────────────────────────────────────────────────────────────

    private buildClock(now: number): FsmClock {
        return {
            now,
            stateEnteredAt: this.stateEnteredAt,
            regionLastChangedAt: this.regionLastChangedAt,
        };
    }

    private evalFsmNow(screen: string, cursor: { row: number; col: number }, now: number) {
        const prev = this.prevScreenLines.length > 0 ? this.prevScreenLines : undefined;
        return evaluateFsm(this.spec, this.currentStateId, screen, cursor, prev, this.buildClock(now), this.signalObservation);
    }

    /**
     * TX-FSM Stage 0 (shadow): compare each signal-guarded transition's
     * counterfactual verdict against the real (PTY-only) one and log on FLIP.
     * This is the "만약 적용했다면" half of the shadow log — the Stage 1-3
     * evidence for whether signal gating would have changed any verdict, and
     * in which direction. Read-only: runs after the evaluation is complete
     * and never feeds back into it.
     */
    private logShadowDivergence(ev: FsmEvaluation): void {
        for (const t of ev.transitions) {
            if (!t.shadow) continue;
            const key = `${this.currentStateId}→${t.to}`;
            const diverges = t.shadow.fires !== t.fires;
            if ((this.shadowDivergenceLast.get(key) ?? false) === diverges) continue;
            this.shadowDivergenceLast.set(key, diverges);
            if (diverges) {
                LOG.info(
                    'FsmDriver',
                    `[${this.specTag()}] [shadow] ${key} (${t.label}): real fires=${t.fires}`
                    + ` but signal-gated verdict would be fires=${t.shadow.fires}`
                    + ` (shadowCond=${t.shadow.condResult}${t.shadow.unknown ? ', signal unknown/fail-open' : ''})`,
                );
            } else {
                LOG.info(
                    'FsmDriver',
                    `[${this.specTag()}] [shadow] ${key} (${t.label}): shadow verdict realigned with real fires=${t.fires}`,
                );
            }
        }
    }

    private reevaluate(forceEmit = false): void {
        const now = Date.now();
        const screen = this.adapter.snapshot();
        this.maybeDismissStartupPrompt(screen, now);
        const cursor = this.adapter.getCursorPosition();
        const currentLines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);

        // Track per-region change timestamps for stable_ms conditions BEFORE
        // we overwrite prevScreenLines.
        this.trackRegionChanges(currentLines, cursor, now);

        const ev = this.evalFsmNow(screen, cursor, now);
        this.lastFsmEval = ev;
        this.prevScreenLines = currentLines;
        this.logShadowDivergence(ev);

        if (ev.fired) {
            this.commitTransition(ev.fired, now, ev);
            // Mark ready BEFORE emitStateChanged so SpecCliAdapter.getStatus()
            // on the idle-entry frame already has fsmReadySeen=true. The
            // adapter's statusCallback → detectStatusTransition runs inside
            // emit; if maybeMarkReady ran after, a quiet CLI (no further PTY
            // frames at the prompt) would never re-poll and agent:ready would
            // never fire — antigravity signing_in→idle, live M-MESH-INFRA-0829.
            this.maybeMarkReady();
            // After a transition, immediately re-derive controls/modal for the
            // new state and emit. Re-run once so a chain like approval→busy
            // that's already satisfied doesn't wait for the next PTY frame.
            this.emitStateChanged(forceEmit);
            this.scheduleWakeForState();
            this.scheduleStallWatchdog();
            // Drain queued sends on the SAME frame the machine reaches "ready".
            // The first delegated message is queued in pendingSends until the
            // FSM first enters a non-initial idle state (the prompt is drawn).
            // That readiness is normally reached BY a transition (e.g.
            // signing_in→idle / starting→idle) — and an idle state has no
            // pending time-condition, so scheduleWakeForState() arms no timer
            // and, agy being quiet at the prompt, no further PTY frame arrives.
            // Without this call the queued first message would strand here
            // forever (the "first input never processed" bug). maybeMarkReady is
            // idempotent (guarded by readySeenOnce) so calling it on both
            // branches is safe. Drain stays after emit so detectStatusTransition
            // observes idle+fsmReadySeen before the first queued body is written.
            this.drainPendingSends();
            return;
        }

        // No transition — refresh modal/controls (content inside the same
        // state can still change, e.g. modal title/buttons) and emit if changed.
        this.maybeMarkReady();
        this.emitStateChanged(forceEmit);
        // Schedule a wake for the soonest pending time-condition.
        this.scheduleWakeForState();
        this.scheduleStallWatchdog();
        // Drain queued sends once we first reach a "ready" state.
        this.drainPendingSends();
    }

    private commitTransition(fired: TransitionEval, now: number, ev: FsmEvaluation): void {
        const from = this.currentStateId;
        // Capture the full pre-transition evaluation BEFORE we mutate state, so
        // the snapshot records why this transition fired from `from`.
        this.pushFsmSnapshot(from, fired, now, ev);
        this.currentStateId = fired.to;
        this.stateEnteredAt = now;
        // Region change timestamps are relative to the previous state's
        // activity; reset so stable_ms in the new state measures from entry.
        this.regionLastChangedAt.clear();
        this.stableVerdictCache.clear();
        this.pushHistory(fired.to, stateById(this.spec, fired.to)?.label ?? fired.to, {
            reason: 'transition',
            via: `${from}→${fired.to}`,
            matchedRules: summarizeTransition(fired),
        });
        LOG.info('FsmDriver', `[${this.specTag()}] ${from} → ${fired.to} (${fired.label})`);
    }

    /** Snapshot the full FSM evaluation that produced a transition into the
     *  separate fsmSnapshotHistory ring buffer (max 20). The transitions[]
     *  table is captured by reference — it is freshly built per evaluation in
     *  evaluateFsm and never mutated after, so no clone is needed. */
    private pushFsmSnapshot(from: string, fired: TransitionEval, now: number, ev: FsmEvaluation): void {
        this.fsmSnapshotHistory.push({
            stateFrom: from,
            stateTo: fired.to,
            at: now,
            firedTo: fired.to,
            firedLabel: fired.label,
            reason: summarizeTransition(fired),
            transitions: ev.transitions,
        });
        if (this.fsmSnapshotHistory.length > 20) this.fsmSnapshotHistory.shift();
    }

    /** Re-derive the visible modal + controls for the current state and emit a
     *  state_changed if anything differs from the last emit. */
    private emitStateChanged(forceEmit: boolean): void {
        const state = stateById(this.spec, this.currentStateId);
        if (!state) return;
        const screen = this.adapter.snapshot();
        const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(this.spec.sections ?? {}, lines);

        // Modal states (approval / picker) extract their buttons + title from a
        // SCROLLBACK-INCLUSIVE buffer: claude-cli renders an approval as a box,
        // and when the prompt body (a big diff / long explanation) is tall the
        // top of the box — including the `─────` separator that anchors the
        // `modal` section — scrolls above the viewport. Matching only the
        // viewport then yields < min_count buttons, deriveModal returns null,
        // and auto-approve never fires (the "long prompts never auto-approve"
        // bug). The viewport stays authoritative for transitions / cursor
        // conditions; only this content-pattern extraction reads scrollback.
        const modalLines = state.modal
            ? this.scrollbackLines()
            : lines;
        const modalSections = state.modal
            ? resolveSections(this.spec.sections ?? {}, modalLines)
            : sections;
        const modalFullScreen = modalLines.join('\n');

        const modal = this.deriveModal(state, modalSections, modalFullScreen);
        const controls = this.deriveControls(state.id);
        const title = modal?.title ?? this.deriveTitle(state, modalSections, modalFullScreen);

        const next: CurrentEval = {
            // status is derived from the FSM state itself (statusForState), NOT from
            // whether a modal was parsed this frame. A modal state whose buttons briefly
            // fail to parse (PTY repaint → deriveModal returns null) must still report
            // its authoritative status (e.g. 'approval'), so the adapter never collapses
            // an approval/busy state to idle on a transient modal-parse miss.
            state: { id: state.id, label: state.label, title, status: statusForState(state) },
            modal,
            controls,
        };

        const changed = forceEmit
            || !this.currentEval
            || this.currentEval.state.id !== next.state.id
            || this.currentEval.state.title !== next.state.title
            || !sameModal(this.currentEval.modal, next.modal)
            || !sameControls(this.currentEval.controls, next.controls);

        this.currentEval = next;
        if (this.pickerInProgress) this.tryAdvancePicker(screen);

        if (changed) {
            this.emit({
                kind: 'state_changed',
                state: next.state,
                // kind is the SEMANTIC modal class (approval vs picker/confirm)
                // derived from the FSM state, NOT from the parsed buttons — the
                // status field already collapsed it to 'approval' so the modal is
                // surfaced. The auto-approve worker needs the distinction back to
                // avoid answering a /model picker on the user's behalf.
                modal: next.modal ? { title: next.modal.title, buttons: next.modal.buttons.map(b => ({ index: b.index, label: b.label })), kind: modalKindForState(state) } : null,
                controls: next.controls.map(c => ({ id: c.id, label: c.label, action_type: c.actionType })),
            });
            this.fireNotifications(state.id, title);
            this.armOrCancelDelegateTimers(state.id);
        }
    }

    private deriveModal(state: FsmState, sections: ResolvedSection[], fullScreen: string): ModalSnapshot | null {
        const rule = state.extract?.buttons;
        if (!rule) return null;
        const hay = sectionText(sections, rule.section, fullScreen);
        const minCount = rule.min_count ?? 2;
        let buttons = extractButtonsFromRule(rule, hay);
        if (buttons.length < minCount && rule.section) {
            // Whole-screen fallback: the modal `section` can resolve too short
            // when a spec's `until` anchor clips the section BEFORE the choices
            // (e.g. a claude-cli approval whose command preview carries a leading
            // shell-redirect line — `>/dev/null 2>&1` — that an over-broad
            // `[…>…]` modal-terminator anchor mistakes for the input prompt,
            // stranding the `❯ 1. Yes / 2. No` buttons below the cut and wedging
            // auto-approve forever). The buttons are still present in the full
            // buffer, so re-extract from it. `lastContiguousNumberedBlock`
            // (inside extractButtonsFromRule) already isolates the real
            // bottom-most choice block from any stray body-numbered lines the
            // wider scope pulls in, so this cannot bind the wrong rows. Guards
            // it to the buttons-under-count case only, so a correctly-scoped
            // spec pays nothing.
            const whole = extractButtonsFromRule(rule, fullScreen);
            if (whole.length >= minCount) buttons = whole;
        }
        if (buttons.length < minCount) return null;
        const title = this.deriveTitle(state, sections, fullScreen);
        return { title, buttons };
    }

    private deriveTitle(state: FsmState, sections: ResolvedSection[], fullScreen: string): string | null {
        const rule = state.extract?.title;
        if (!rule) return null;
        return extractTitle(rule, sections, fullScreen);
    }

    private deriveControls(stateId: string): VisibleControl[] {
        const out: VisibleControl[] = [];
        for (const c of this.spec.control_bar ?? []) {
            if (c.visible_when_state && !c.visible_when_state.includes(stateId)) continue;
            out.push({ id: c.id, label: c.label, actionType: c.action.type });
        }
        return out;
    }

    /** Track which stable regions changed since the previous frame so
     *  stable_ms conditions can measure quiet time. We record every distinct
     *  stable region referenced in the current state (numeric cursor_above /
     *  whole-screen -1, and named `section:<id>` regions) plus, for each, the
     *  optional `ignore_lines` filter that folds into its key.
     *
     *  `ignore_lines` is the content-aware fix for the busy→idle wedge: lines
     *  matching it are stripped from BOTH frames before the comparison, so a
     *  benign residual ticker (bare token counter / elapsed timer that repaints
     *  every frame post-generation) no longer resets the clock — while an active
     *  spinner line, which does NOT match the benign pattern, still does (the
     *  FALSEIDLE2 / FALSEBUSY-B whole-screen invariant is preserved). */
    private trackRegionChanges(currentLines: string[], cursor: { row: number; col: number }, now: number): void {
        if (this.prevScreenLines.length === 0) return;
        const descs = this.stableRegionDescriptors();
        // COMPLETION-EARLYNOTIFY hook 4: record the stable/not-stable verdict for each
        // tracked region, but ONLY when the verdict flips (see stableVerdictCache) so a
        // quiet screen does not spam the ring buffer. This is the case-b diagnostic — an
        // ignore_lines-scoped stable clause declaring a tool-execution screen "stable-idle"
        // shows up here as verdict:true with a short fingerprint. Payload carries lengths
        // and the pattern SOURCE only — never screen text.
        const stableTraceOn = shouldCollectTraceCategory('fsm-transition');
        // Section ranges depend on screen content, so resolve per-frame for both
        // frames — but only when some tracked region is actually section-scoped.
        const needsSections = descs.some(d => !!d.section);
        const curSections = needsSections ? resolveSections(this.spec.sections ?? {}, currentLines) : [];
        const prevSections = needsSections ? resolveSections(this.spec.sections ?? {}, this.prevScreenLines) : [];
        for (const d of descs) {
            let curLines: string[]; let prevLines: string[];
            if (d.section) {
                curLines = sliceSectionLines(currentLines, curSections, d.section);
                prevLines = sliceSectionLines(this.prevScreenLines, prevSections, d.section);
            } else if (!d.cursor_above || d.cursor_above <= 0) {
                curLines = currentLines;
                prevLines = this.prevScreenLines;
            } else {
                // CODEX-FSM-DEGENERATE-STABLE fix: cursor.row is the backend's RAW
                // row coordinate (ghostty getCursorPosition(), un-normalized), while
                // currentLines is the VIEWPORT snapshot with blank ends trimmed
                // (ghostty-vt-backend getText → trimBlankEnds). The two coordinate
                // spaces diverge whenever trailing blank rows are trimmed away (or
                // the backend counts scrollback rows): cursor.row then overshoots
                // the array and slice(start, cursor.row) returns an EMPTY window.
                // Two empty windows compare equal on every frame, so
                // regionLastChangedAt never advances and stable_ms accumulates
                // forever — the FSM read a generating screen as
                // "stable cursor_above=4 353833ms / 1500ms" and committed a false
                // busy→idle (live RCA: generating_completed at duration=402s while
                // the native transcript kept growing).
                //
                // Invariant: an unmeasurable window must NEVER read as "stable".
                // Clamp the window end to the content length (when the cursor sits
                // in the trimmed blank region, the lines directly above it in
                // content terms are the content tail), and when the window is still
                // empty (no measurable content at all) mark the region CHANGED so
                // the stable clock restarts instead of accumulating.
                const window = stableCursorWindow(currentLines.length, cursor.row, d.cursor_above);
                if (!window) {
                    this.regionLastChangedAt.set(d.key, now);
                    continue;
                }
                curLines = currentLines.slice(window.start, window.end);
                prevLines = this.prevScreenLines.slice(window.start, window.end);
            }
            const cur = filterIgnoredLines(curLines, d.ignoreRe).join('\n');
            const prev = filterIgnoredLines(prevLines, d.ignoreRe).join('\n');
            if (cur !== prev) this.regionLastChangedAt.set(d.key, now);
            if (stableTraceOn && typeof d.holdMs === 'number') {
                const lastChanged = this.regionLastChangedAt.get(d.key) ?? this.stateEnteredAt;
                const ageMs = now - lastChanged;
                const verdict = ageMs >= d.holdMs;
                if (this.stableVerdictCache.get(d.key) !== verdict) {
                    this.stableVerdictCache.set(d.key, verdict);
                    recordDebugTrace({
                        category: 'fsm-transition',
                        stage: 'stable-eval',
                        level: 'debug',
                        payload: {
                            state: this.currentStateId,
                            regionKey: String(d.key),
                            ignorePattern: d.ignoreRe?.source ?? null,
                            fingerprintLen: cur.length,
                            ageMs,
                            holdMs: d.holdMs,
                            verdict,
                        },
                    });
                }
            }
        }
    }

    /** Every distinct stable-region descriptor referenced by stable_ms
     *  conditions in the current state's outgoing transitions, plus the plain
     *  whole-screen key (-1) that other machinery (stall watchdog) reads.
     *  De-duplicated by key. Cached lazily per spec load would be nicer but the
     *  set is tiny. */
    private stableRegionDescriptors(): StableRegionDescriptor[] {
        const byKey = new Map<number | string, StableRegionDescriptor>();
        byKey.set(-1, { key: -1 });
        for (const t of outgoingTransitions(this.spec, this.currentStateId)) {
            collectStableDescriptors(t.when, byKey);
        }
        return [...byKey.values()];
    }

    /** Schedule a re-evaluation for the soonest pending time-condition on any
     *  outgoing transition (elapsed_ms / stable_ms / min_hold_ms). Without
     *  this, a state whose only exit is time-based would never leave once the
     *  PTY goes quiet. */
    private scheduleWakeForState(): void {
        if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
        const ev = this.lastFsmEval;
        if (!ev) return;
        let soonest = Infinity;
        for (const t of ev.transitions) {
            if (t.fires) continue;
            if (!t.holdSatisfied) soonest = Math.min(soonest, t.holdRemainingMs);
            const condRemain = t.cond ? t.cond.remainingMs ?? Infinity : Infinity;
            // Only treat the cond countdown as a wake source when the rest of
            // the guard (hold) is already or will be satisfied.
            if (Number.isFinite(condRemain) && condRemain > 0) soonest = Math.min(soonest, condRemain);
        }
        if (!Number.isFinite(soonest)) return;
        this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.reevaluate(); }, Math.max(soonest + 30, 50));
    }

    // ── Focus-gated stall watchdog (refocus_when_stalled_ms) ──────────────────
    //
    // A focus-event TUI (antigravity's `agy`) freezes its render loop the moment
    // it thinks it has lost focus mid-turn: the screen stops updating and only
    // repaints on the next keypress, which the daemon never sends. The output
    // pump is wired entirely to PTY onData (no PTY data → no reevaluate, no
    // on_screen_changed), so a normal time-wake that only re-reads the screen
    // can't help — there is nothing new to read. The fix is to re-inject the
    // focus-in wake (`send_on_spawn`) so the CLI flushes the held output itself.

    /** True when this spec opts into stall recovery (declares a positive
     *  refocus window AND a wake sequence to re-inject). */
    private stallRecoveryEnabled(): boolean {
        const ms = this.spec.refocus_when_stalled_ms;
        return typeof ms === 'number' && ms > 0
            && Array.isArray(this.spec.send_on_spawn) && this.spec.send_on_spawn.length > 0;
    }

    /** Wall-clock time the screen last changed in the current state, falling
     *  back to state entry when it has not changed since (i.e. fully stalled
     *  from the start of the state). */
    private lastScreenChangeAt(): number {
        return this.regionLastChangedAt.get(-1) ?? this.stateEnteredAt;
    }

    /** Arm a timer to re-inject the focus-in prime if the screen stays frozen
     *  through a `generating` state. Only active for opted-in focus-gated specs;
     *  a no-op (and cleared) for every other CLI and every non-generating state.
     *  Re-arms itself so it keeps watching while the PTY is quiet. */
    private scheduleStallWatchdog(): void {
        if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
        if (!this.stallRecoveryEnabled()) return;
        const st = stateById(this.spec, this.currentStateId);
        if (!st || statusForState(st) !== 'generating') return;
        const windowMs = this.spec.refocus_when_stalled_ms as number;
        // Cooldown reference: a re-prime defers the next one by a full window,
        // even if the screen has not yet repainted, so we don't tight-loop.
        const since = Math.max(this.lastScreenChangeAt(), this.lastRefocusAt);
        const remaining = windowMs - (Date.now() - since);
        this.stallTimer = setTimeout(
            () => { this.stallTimer = null; this.onStallTick(); },
            Math.max(remaining + 30, 50),
        );
    }

    /** Fire when the stall window elapses: if the screen is still frozen and we
     *  are still generating, re-inject the focus-in wake once, then re-arm. */
    private onStallTick(): void {
        if (!this.stallRecoveryEnabled()) return;
        const st = stateById(this.spec, this.currentStateId);
        if (!st || statusForState(st) !== 'generating') return;
        const windowMs = this.spec.refocus_when_stalled_ms as number;
        const now = Date.now();
        const stalledFor = now - this.lastScreenChangeAt();
        const sinceLastRefocus = now - this.lastRefocusAt;
        if (stalledFor >= windowMs && sinceLastRefocus >= windowMs) {
            LOG.info('FsmDriver', `[${this.specTag()}] stall detected (${stalledFor}ms quiet, generating) — re-injecting focus-in`);
            this.sendSpawnPrime();
            this.lastRefocusAt = now;
        }
        // Keep watching: the re-prime may not flush instantly, and a still-quiet
        // screen needs the next window to come around.
        this.scheduleStallWatchdog();
    }

    private maybeMarkReady(): void {
        if (this.readySeenOnce) return;
        const st = stateById(this.spec, this.currentStateId);
        if (!st) return;
        // "Ready" = a non-initial state whose status is idle (the prompt is up).
        // Latch only — the queued first send is drained AFTER emitStateChanged
        // so detectStatusTransition observes idle+fsmReadySeen (and fires
        // agent:ready) before the body is written. drainPendingSends still
        // serializes one message at a time (SEND-OVERLAP).
        if (!st.initial && statusForState(st) === 'idle') {
            this.readySeenOnce = true;
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Notifications & delegates
    // ────────────────────────────────────────────────────────────────────

    private fireNotifications(stateId: string, title: string | null): void {
        for (const n of this.spec.notifications ?? []) {
            if (n.when_state !== stateId) continue;
            const body = (n.body ?? '').replace(/\{state\.title\}/g, title ?? '');
            this.emit({ kind: 'notification', id: n.id, title: n.title, body });
        }
    }

    private armOrCancelDelegateTimers(currentStateId: string): void {
        for (const d of this.spec.delegate ?? []) {
            const armed = this.delegateTimers.has(d.id);
            const shouldFire = d.when_state === currentStateId;
            if (shouldFire && !armed) {
                const delay = d.after_duration_ms ?? 0;
                const t = setTimeout(() => { this.fireDelegate(d); this.delegateTimers.delete(d.id); }, delay);
                this.delegateTimers.set(d.id, t);
            } else if (!shouldFire && armed) {
                clearTimeout(this.delegateTimers.get(d.id)!);
                this.delegateTimers.delete(d.id);
            }
        }
    }

    private fireDelegate(d: DelegateTrigger): void {
        const ev = this.currentEval;
        const task = d.task_template
            .replace(/\{node\}/g, os.hostname())
            .replace(/\{state\.label\}/g, ev?.state.label ?? '')
            .replace(/\{state\.title\}/g, ev?.state.title ?? '')
            .replace(/\{duration_ms\}/g, String(d.after_duration_ms ?? 0));
        this.emit({ kind: 'delegate', id: d.id, task });
    }

    // ────────────────────────────────────────────────────────────────────
    // Dashboard commands (identical semantics to v3)
    // ────────────────────────────────────────────────────────────────────

    /**
     * SEND-OVERLAP gate. A send may only go straight to the PTY when the machine
     * is genuinely able to accept one: it has been ready at least once, it is
     * sitting at an idle prompt right now, and no earlier send is still in flight.
     * Anything else is queued and drained by drainPendingSends() when the machine
     * next returns to idle.
     *
     * Before the fix this consulted ONLY `readySeenOnce` — a one-shot latch — so
     * every send after the first ignored the live FSM state and could be written
     * on top of a still-generating turn, braiding the two bodies in the composer
     * (see the SEND-OVERLAP note above the constants).
     */
    private handleSendMessage(text: string, bracketedPaste?: boolean): void {
        // A resend of text we are already in the middle of delivering is dropped
        // outright rather than queued: queueing it would just submit the same
        // prompt a second time once the turn ends, which is the duplicate-bubble
        // symptom in a slower disguise.
        if (this.isDuplicateResend(text)) {
            LOG.info('FsmDriver', `[${this.specTag()}] send suppressed — duplicate resend within ${DUPLICATE_RESEND_WINDOW_MS}ms (len=${text.length})`);
            return;
        }
        if (!this.canSendNow()) {
            this.pendingSends.push({ text, bracketedPaste });
            LOG.info(
                'FsmDriver',
                `[${this.specTag()}] send queued — ${this.sendBlockedReason()} (len=${text.length}, queued=${this.pendingSends.length})`,
            );
            return;
        }
        this.beginSend(text, bracketedPaste);
    }

    /** True when a send can be written to the PTY right now. */
    private canSendNow(): boolean {
        if (!this.readySeenOnce) return false;
        if (this.isSendInFlight()) return false;
        return this.currentStatus() === 'idle';
    }

    /** Human-readable reason a send was queued — logged, never used for control flow. */
    private sendBlockedReason(): string {
        if (!this.readySeenOnce) return 'machine not ready yet';
        if (this.isSendInFlight()) return `previous send still in flight (${Date.now() - this.sendInFlightAt}ms)`;
        return `machine is ${this.currentStatus()}`;
    }

    /** In-flight latch with its self-expiry applied, so a send the CLI never
     *  visibly consumed cannot wedge the queue permanently. */
    private isSendInFlight(): boolean {
        if (!this.sendInFlight) return false;
        if (Date.now() - this.sendInFlightAt > SEND_IN_FLIGHT_MAX_MS) {
            LOG.warn('FsmDriver', `[${this.specTag()}] in-flight send latch expired after ${SEND_IN_FLIGHT_MAX_MS}ms — releasing`);
            this.sendInFlight = false;
            return false;
        }
        return true;
    }

    /**
     * Pre-write duplicate gate. Suppresses a repeat of text that was written to
     * the PTY within DUPLICATE_RESEND_WINDOW_MS *while that text is still being
     * processed* — i.e. a send is in flight or the machine has not returned to
     * idle. A genuine repeat typed at an idle prompt is NOT suppressed: sending
     * "continue" twice in a row is ordinary use, and silently swallowing the
     * second one would be a worse defect than the one being fixed.
     */
    private isDuplicateResend(text: string): boolean {
        const now = Date.now();
        const key = hashSendText(text);
        for (const [candidate, at] of this.recentSendHashes) {
            if (now - at > DUPLICATE_RESEND_WINDOW_MS) this.recentSendHashes.delete(candidate);
        }
        const previous = this.recentSendHashes.get(key);
        if (previous === undefined) return false;
        if (now - previous > DUPLICATE_RESEND_WINDOW_MS) return false;
        // Same text, inside the window. Only a collision with work still in
        // progress is a redelivery; at a settled idle prompt it is a new turn.
        const stillProcessing = this.isSendInFlight()
            || this.currentStatus() !== 'idle'
            || this.pendingSends.length > 0;
        return stillProcessing;
    }

    /** Mark a send as in flight, record it for the duplicate gate, and write it. */
    private beginSend(text: string, bracketedPaste?: boolean): void {
        this.sendInFlight = true;
        this.sendInFlightAt = Date.now();
        this.recentSendHashes.set(hashSendText(text), this.sendInFlightAt);
        this.actuallySendMessage(text, bracketedPaste);
    }

    /**
     * Release the in-flight latch and write the next queued send, if the machine
     * can take one. Called from the FSM evaluation loop, so it runs on the same
     * frame the machine reaches idle — the queue never waits for an extra PTY
     * frame that a quiet CLI would never produce (the same hazard maybeMarkReady
     * documents for the very first message).
     */
    private drainPendingSends(): void {
        if (!this.readySeenOnce) return;
        const status = this.currentStatus();
        // Leaving idle is the observable proof the CLI consumed the submit.
        if (this.sendInFlight && status !== 'idle') {
            this.sendInFlight = false;
        }
        if (status !== 'idle') return;
        if (this.isSendInFlight()) return;
        if (this.pendingSends.length === 0) return;
        const next = this.pendingSends.shift()!;
        LOG.info('FsmDriver', `[${this.specTag()}] draining queued send (len=${next.text.length}, remaining=${this.pendingSends.length})`);
        // Small delay for parity with the ready-gate drain: it lets the prompt
        // frame settle before the body lands.
        if (this.pendingSendDrainTimer) clearTimeout(this.pendingSendDrainTimer);
        this.pendingSendDrainTimer = setTimeout(() => {
            this.pendingSendDrainTimer = null;
            this.beginSend(next.text, next.bracketedPaste);
        }, 50);
        // Hold the latch immediately so a second drain on the very next frame
        // cannot write a second body into the same composer line.
        this.sendInFlight = true;
        this.sendInFlightAt = Date.now();
    }

    /** SUBMIT-SILENT-FAILURE: true when the most recent send exhausted its submit
     *  resend budget without the agent ever leaving the composer. A caller seeing
     *  this should treat an apparent 'generating' status as untrustworthy. */
    lastSubmitUnconfirmed(): boolean {
        return this.submitUnconfirmed;
    }

    private actuallySendMessage(text: string, bracketedPaste?: boolean): void {
        const sm = this.spec.send_message;
        this.submitUnconfirmed = false;
        const perChar = sm.delay_ms_per_char ?? 0;
        const beforeSubmit = resolveSubmitDelayMs(sm.delay_ms_before_submit, text, this.opts.manifestSendDelayMs);

        // POSIX-IMAGE-PASTE (multi-image attachment loss): a body carrying
        // materialized image paths is wrapped in a bracketed-paste region when the
        // spec opts in (send_message.posix_bracketed_paste_for_images). Live A/B
        // against claude-cli v2.1.220 (2026-08-26) showed the raw-write path loses
        // every image but the last: the CLI only converts image paths to real
        // attachments when a single input burst clears its ~800-char
        // heuristic-paste threshold, so a short body attaches NONE and a body split
        // across pipe chunks attaches only the burst's tail. The bracketed-paste
        // region routes the whole body through the CLI's real paste handler, which
        // attaches EVERY image path in it (verified: imagePasteIds [1, 2] on the
        // recorded user turn). The echo-gate is skipped for the wrapped body: the
        // composer renders paste chips ([Image #N]) instead of the literal text, so
        // the raw body can never echo and the gate would stall to its blind-fire
        // backstop. The verified-resend net still runs, covering a CR that lands
        // while the CLI's async image ingestion is still in flight.
        const wrapInPaste = process.platform !== 'win32'
            && bracketedPaste === true
            && sm.posix_bracketed_paste_for_images === true;
        if (wrapInPaste) {
            this.adapter.send_keys(`${BRACKETED_PASTE_OPEN}${text}${BRACKETED_PASTE_CLOSE}`);
            this.markBodyWrite();
            this.scheduleVerifiedSubmit(sm.submit_key, beforeSubmit, text, { skipEchoGate: true });
            return;
        }

        // win32 ConPTY submit: the text and the submit key (CR) must NOT be
        // combined into one PTY write — Ink-based TUIs (claude-cli) treat a
        // single write that carries text + a trailing CR as a bracketed/multi-line
        // paste and absorb the CR as a literal newline. So we write the text on
        // its own, then resend the submit key on a fixed cadence, VERIFYING after
        // each that the agent actually left the idle composer (status flipped away
        // from 'idle'). This handles the nondeterministic multiline
        // paste-accumulation window where a variable number of CRs is needed; a
        // fixed double-CR fails for multiline (see WIN32_SUBMIT_* above). perChar
        // typing simulation is skipped on win32; correctness of submission wins
        // over the typing visual there.
        if (process.platform === 'win32') {
            this.writeWin32Body(text);
            this.scheduleVerifiedSubmit(sm.submit_key, beforeSubmit, text);
            return;
        }

        // POSIX-ENTER-DROP: a large body takes the same echo-verified submit the
        // win32 path uses. The body itself is written exactly as before (one write,
        // no bracketed paste — POSIX composers do not need it and wrapping would be
        // an unvalidated behaviour change); only the CR is now effect-verified
        // instead of blind-timed. Short bodies keep the original immediate path.
        if (perChar === 0 && shouldUseVerifiedSubmit(text)) {
            this.adapter.send_keys(text);
            this.markBodyWrite();
            this.scheduleVerifiedSubmit(sm.submit_key, beforeSubmit, text);
            return;
        }

        if (perChar === 0) {
            this.adapter.send_keys(text);
            if (beforeSubmit > 0) setTimeout(() => this.adapter.send_keys(sm.submit_key), beforeSubmit);
            else this.adapter.send_keys(sm.submit_key);
            return;
        }
        let i = 0;
        const iv = setInterval(() => {
            if (i >= text.length) {
                clearInterval(iv);
                setTimeout(() => this.adapter.send_keys(sm.submit_key), beforeSubmit);
                return;
            }
            this.adapter.send_keys(text[i]);
            i += 1;
        }, perChar);
    }

    /** The agent's current coarse status, derived from the FSM node we're in. */
    private currentStatus(): 'idle' | 'generating' | 'approval' {
        const st = stateById(this.spec, this.currentStateId);
        return st ? statusForState(st) : 'idle';
    }

    /** Record a win32 body write so the settle-gate counts it as input activity
     *  even before the echo arrives. */
    private markBodyWrite(): void {
        this.lastWin32WriteAt = Date.now();
    }

    /** Most recent win32 input activity — a write we issued OR a PTY output chunk
     *  (echo). The submit settle-gate waits for this to go quiet. */
    private lastWin32InputActivityAt(): number {
        return Math.max(this.lastPtyDataAt, this.lastWin32WriteAt);
    }

    /**
     * Write the message body to the PTY for win32, paced into bounded chunks. A
     * single unbounded ConPTY write can overflow the input pipe and drop leading
     * bytes; splitting it with a short inter-chunk gap keeps the console input
     * buffer from overflowing. Small bodies still go out in a single write. Each
     * write advances lastWin32WriteAt so the submit settle-gate keeps waiting until
     * the final segment is out and echoed.
     *
     * FIX-B-v2: a body that contains an embedded newline cannot be written raw —
     * on the real win32 Ink/ConPTY composer each '\n' SUBMITS the preceding line as
     * its own entry, truncating the prompt to only the tail fragment. So a
     * newline-bearing body is rewritten so its embedded newlines never submit:
     *   - 'paste' (default): wrap the body in a bracketed-paste (ESC[200~ … ESC[201~)
     *     — the composer takes the whole thing, newlines and all, as pasted text.
     *   - 'soft_newline': replace each embedded newline with a non-submitting
     *     Shift+Enter (CSI-u) so the body is typed as one multi-line entry.
     * The trailing submit CR is NOT written here — it stays separate and is fired
     * later by scheduleVerifiedSubmit (concern (A)). The bracketed-paste markers are
     * written as their own atomic segments (never chunked), so chunking can never
     * split ESC[200~ / ESC[201~ mid-sequence regardless of body length.
     */
    private writeWin32Body(text: string): void {
        if (this.win32WriteTimer) { clearTimeout(this.win32WriteTimer); this.win32WriteTimer = null; }

        const hasNewline = /\r?\n/.test(text);
        const mode = resolveWin32SubmitMode();

        // Build the ordered list of segments to write. Bracketed-paste markers are
        // their OWN segments so chunking only ever splits the body, never a marker.
        let segments: string[];
        if (!hasNewline) {
            // Single-line: unchanged behaviour — just (chunk and) write the body.
            segments = chunkPreservingSurrogates(text, WIN32_PTY_WRITE_CHUNK_CHARS);
        } else if (mode === 'soft_newline') {
            // Rewrite embedded newlines as non-submitting soft-newlines, THEN chunk.
            // The soft-newline sequence (ESC[27;2;13~) contains no '\n', so it is
            // never re-interpreted as a submit, and chunking it like ordinary text is
            // safe (a split mid-sequence is avoided below by chunking the whole
            // rewritten string — see the marker-safety note for paste; for soft_newline
            // the only ESC seq is short and self-contained, so we keep it simple and
            // chunk the rewritten body, accepting that the 1024-char chunk boundary is
            // astronomically unlikely to land inside a 9-byte CSI-u seq — and even if
            // it did, ConPTY reassembles the byte stream, the composer parses the full
            // sequence across the boundary).
            const rewritten = text.split(/\r?\n/).join(WIN32_SOFT_NEWLINE);
            segments = chunkPreservingSurrogates(rewritten, WIN32_PTY_WRITE_CHUNK_CHARS);
        } else {
            // paste: [OPEN marker] [body chunks…] [CLOSE marker]. Markers are atomic
            // segments — never merged with body bytes — so they cannot be split.
            segments = [
                WIN32_BRACKETED_PASTE_OPEN,
                ...chunkPreservingSurrogates(text, WIN32_PTY_WRITE_CHUNK_CHARS),
                WIN32_BRACKETED_PASTE_CLOSE,
            ];
        }

        if (segments.length <= 1) {
            this.markBodyWrite();
            this.adapter.send_keys(segments[0] ?? text);
            return;
        }
        let idx = 0;
        const writeNext = (): void => {
            this.win32WriteTimer = null;
            if (idx >= segments.length) return;
            this.markBodyWrite();
            this.adapter.send_keys(segments[idx]);
            idx += 1;
            if (idx < segments.length) {
                this.win32WriteTimer = setTimeout(writeNext, WIN32_PTY_WRITE_CHUNK_GAP_MS);
            }
        };
        writeNext();
    }

    /**
     * win32 submit. Two phases:
     *
     *  Phase 1 (echo-gate): hold the first CR until the body text is CONFIRMED in the
     *  composer (its whitespace-collapsed tail appears in the rendered screen) AND the
     *  PTY output is then quiet for WIN32_SUBMIT_SETTLE_MS (the full, possibly multi-KB
     *  / multiline body has finished arriving). This replaces a bare output-quiet
     *  settle: an early write that races claude's boot is buffered, not dropped, so the
     *  screen can go quiet with the body NOT YET in the composer — a quiet-only gate
     *  would then fire a CR into an empty composer (no submit). Waiting on the echo
     *  closes that. Honors an initial minimum delay and a generous WIN32_ECHO_MAX_WAIT_MS
     *  last-resort blind fire so a body that truly never confirms still submits (carried
     *  by phase 2) rather than hanging. A settled session echoes immediately → no delay.
     *
     *  Phase 2 (verified resend — unchanged): send the submit key, wait a gap, and
     *  if the FSM is still 'idle' (the CR was absorbed as a multiline-paste
     *  newline) resend, up to WIN32_SUBMIT_MAX_RESENDS. The first CR always fires
     *  (a stale/edge status never suppresses it); resends are gated on still being
     *  idle and stop the instant the agent leaves idle (submitted → generating /
     *  approval). This preserves the win32 lone-CR-swallow handling.
     */
    private scheduleVerifiedSubmit(submitKey: string, initialDelayMs: number, body: string, opts?: { skipEchoGate?: boolean }): void {
        if (this.win32SubmitTimer) { clearTimeout(this.win32SubmitTimer); this.win32SubmitTimer = null; }
        const startedAt = Date.now();

        // FULL-BODY echo confirmation. A tail-only probe (slice(-N)) was insufficient
        // for multi-line prompts: a multiline body echoes line-by-line, so its TAIL can
        // appear in the composer (and the screen settle) while the HEAD / middle is still
        // arriving. Releasing the first CR on the tail alone then submits a PARTIAL body:
        // the early CR commits whatever has accumulated and the remainder is lost, so only
        // the trailing segment survives (the cross-machine MAGI replica receiving only the
        // prompt's boilerplate suffix). We now require BOTH the head probe AND the tail
        // probe to be present in the echo before releasing the CR.
        //
        // Crucially, the head check runs against snapshotWithScrollback(), NOT the visible
        // viewport: a tall body scrolls its leading lines off-screen (the very reason the
        // original gate used the tail), so the head is only ever observable in the
        // scrollback-inclusive buffer. The tail check stays on the visible snapshot (the
        // cursor / body end is always on screen). Both present ⇒ the whole body, head
        // through tail, has echoed — not just its end with a still-streaming middle.
        // Single-line / short bodies have overlapping head and tail probes and the
        // scrollback buffer is a superset of the viewport, so behaviour is unchanged. The
        // WIN32_ECHO_MAX_WAIT_MS blind-fire backstop below still bounds the wait so a body
        // that never fully confirms cannot hang.
        const normBody = normalizeForEcho(body);
        const headProbe = normBody.slice(0, WIN32_ECHO_PROBE_CHARS);
        const tailProbe = normBody.slice(-WIN32_ECHO_PROBE_CHARS);
        const bodyEchoed = (): boolean => {
            if (!normBody) return true;
            // Tail on the visible viewport (cursor end is always on screen); head on the
            // scrollback-inclusive buffer (leading lines of a tall body scroll off-screen).
            const visible = normalizeForEcho(this.adapter.snapshot());
            if (!visible.includes(tailProbe)) return false;
            const full = normalizeForEcho(this.adapter.snapshotWithScrollback());
            return full.includes(headProbe);
        };

        const fire = (attempt: number): void => {
            this.win32SubmitTimer = null;
            this.adapter.send_keys(submitKey);
            if (attempt + 1 >= WIN32_SUBMIT_MAX_RESENDS) {
                // SUBMIT-SILENT-FAILURE detection. We have spent the entire resend
                // budget and the FSM never left 'idle' — the body is sitting unsent in
                // the composer. This is precisely the state that previously presented
                // to the coordinator as runtimeInputAck:true + status generating + zero
                // assistant output: work that looks in-flight but will never progress.
                // Say so loudly; a silent give-up is what made the live defect cost an
                // owner-side manual Enter to notice.
                if (this.currentStatus() === 'idle') {
                    this.submitUnconfirmed = true;
                    LOG.error(
                        'FsmDriver',
                        `[${this.specTag()}] SUBMIT NOT CONFIRMED after ${WIN32_SUBMIT_MAX_RESENDS} submit-key attempts ` +
                        `(len=${body.length}, echoed=${bodyEchoed()}, waited=${Date.now() - startedAt}ms). ` +
                        'The message is likely still sitting unsent in the composer — the agent is NOT working on it.',
                    );
                }
                return;
            }
            this.win32SubmitTimer = setTimeout(() => {
                // Left the idle composer → it submitted; stop resending.
                if (this.currentStatus() !== 'idle') {
                    this.win32SubmitTimer = null;
                    if (attempt > 0) {
                        LOG.warn('FsmDriver', `[${this.specTag()}] submit confirmed only after ${attempt + 1} attempts (len=${body.length})`);
                    }
                    return;
                }
                fire(attempt + 1);
            }, WIN32_SUBMIT_RESEND_GAP_MS);
        };

        // Echo-gate: hold the first CR until the body is CONFIRMED in the composer, not
        // merely until output goes quiet — a quiet screen with a not-yet-arrived body is
        // the exact empty-submit failure this replaces. The body is NOT re-written: on
        // the session-host IPC transport an early write is buffered, not dropped, so it
        // lands once claude's stdin reader wires up (just late on a slow/contended boot);
        // re-writing would risk a duplicated body when several buffered writes drain
        // together. So we simply WAIT for the echo. The hard upper bound only fires a
        // blind CR if the body never confirms at all (resend net carries it), set
        // generously so a slow boot still lands its body first.
        const waitForEcho = (): void => {
            this.win32SubmitTimer = null;
            const now = Date.now();
            const quietFor = now - this.lastWin32InputActivityAt();
            const waited = now - startedAt;
            const settled = quietFor >= WIN32_SUBMIT_SETTLE_MS;
            // skipEchoGate (POSIX bracketed-paste image bodies): the composer renders
            // paste chips instead of the literal body, so the body can never echo —
            // waiting on it would stall to the blind-fire backstop for no gain. The
            // initial delay still applies (first tick fires after initialDelayMs), and
            // the verified-resend net below carries a CR eaten mid-paste.
            // Default: body present in the composer AND output quiet (full body
            // arrived) → submit.
            if (opts?.skipEchoGate ? true : (bodyEchoed() && settled)) { fire(0); return; }
            // Last-resort blind fire so a body that truly never confirms cannot hang.
            if (waited >= WIN32_ECHO_MAX_WAIT_MS) {
                LOG.warn(
                    'FsmDriver',
                    `[${this.specTag()}] body never confirmed in composer after ${waited}ms (len=${body.length}) — ` +
                    'firing submit key blind; resend net will verify.',
                );
                fire(0);
                return;
            }
            this.win32SubmitTimer = setTimeout(waitForEcho, WIN32_SUBMIT_SETTLE_POLL_MS);
        };

        if (initialDelayMs > 0) this.win32SubmitTimer = setTimeout(waitForEcho, initialDelayMs);
        else waitForEcho();
    }

    private handleClickControl(controlId: string, payload?: unknown): void {
        const ctl = (this.spec.control_bar ?? []).find(c => c.id === controlId);
        if (!ctl) return;
        if (ctl.visible_when_state && !ctl.visible_when_state.includes(this.currentStateId)) return;
        const a = ctl.action;
        switch (a.type) {
            case 'send_keys': this.adapter.send_keys(a.keys); return;
            case 'open_picker':
                // Some TUIs (e.g. codex) don't register a slash command if its
                // text and the submitting Enter arrive in the same write — the
                // composer needs a beat to recognise the command before the CR.
                // Split a trailing CR/LF off the trigger and send it after a
                // short delay, mirroring send_message's delay_ms_before_submit.
                {
                    const m = /^([\s\S]*?)([\r\n]+)$/.exec(a.trigger_keys);
                    if (m && m[1]) {
                        this.adapter.send_keys(m[1]);
                        setTimeout(() => this.adapter.send_keys(m[2]), 200);
                    } else {
                        this.adapter.send_keys(a.trigger_keys);
                    }
                }
                this.pickerInProgress = { control_id: ctl.id, spec: ctl };
                return;
            case 'attach_image': {
                const p = typeof payload === 'object' && payload && (payload as any).path;
                if (typeof p === 'string') this.adapter.send_keys(a.keys_template.replace(/\{path\}/g, p));
                return;
            }
        }
    }

    /**
     * BUTTON-INDEX-MISMAP (Fix C.3): public modal-click entry that returns whether a button
     * matching the requested FSM display index was actually found and its confirm keys were
     * dispatched. The old private handleClickModalButton silently `return`ed on a miss (no
     * modal captured, or no button whose `.index` equals the requested display index), so a
     * mis-mapped index looked identical to a successful press. Callers that need to know
     * whether the click landed (mesh_approve → resolveModal) can now observe the miss instead
     * of reporting success into the void. The generic `dispatch('click_modal_button')` path
     * keeps ignoring the return (fire-and-forget UI clicks).
     */
    clickModalButton(index: number): boolean {
        return this.handleClickModalButton(index);
    }

    private handleClickModalButton(index: number): boolean {
        const m = this.currentEval?.modal;
        if (!m) return false;
        const btn = m.buttons.find(b => b.index === index);
        if (!btn) return false;

        const rule = stateById(this.spec, this.currentStateId)?.extract?.buttons;
        if (rule?.select_mode === 'arrow_keys') {
            // Cursor-list approval modal (claude-cli new TUI): number keys are
            // IGNORED — sending `btn.key` ("1\r") types a literal "1" into the
            // composer and the trailing CR submits it as a chat message. Drive
            // the cursor from its current row to the target row with arrows,
            // then confirm. The cursor opens on the first option, so when the
            // marker isn't detected we step down from row 1 (index - 1).
            const from = m.buttons.find(b => b.current)?.index ?? 1;
            const up = rule.cursor_keys?.up ?? '\x1b[A';
            const down = rule.cursor_keys?.down ?? '\x1b[B';
            const delta = btn.index - from;
            const step = delta >= 0 ? down : up;
            const nav = step.repeat(Math.abs(delta));
            // Confirm = key_for_index with the (now unused) {index} stripped:
            // `{index}\r` → `\r`.
            const confirm = (rule.key_for_index || '\r').replace(/\{index\}/g, '') || '\r';
            if (nav) this.adapter.send_keys(nav);
            this.submitModalConfirm(confirm);
            return true;
        }
        this.submitModalConfirm(btn.key);
        return true;
    }

    /**
     * Submit a modal-confirm key sequence (the choice key + its trailing CR).
     *
     * On win32 the trailing CR is the SAME lone-CR-swallow case as a send_message
     * submit: ConPTY can absorb a single CR as a literal newline instead of a
     * confirm, so the approval/picker modal never resolves and the FSM flaps
     * approval↔busy while auto-approve keeps firing into the void (APPROVESTUCK).
     * So we split any non-CR prefix (e.g. the "1" of "1\r") off, write it once, and
     * resend the CR on a fixed cadence until the modal actually resolves (status
     * leaves 'approval'). Non-win32 keeps the single direct write — its CR submits
     * on the first try.
     */
    private submitModalConfirm(keys: string): void {
        if (process.platform !== 'win32') {
            this.adapter.send_keys(keys);
            return;
        }
        const m = /^([\s\S]*?)([\r\n]+)$/.exec(keys);
        const prefix = m ? m[1] : keys;
        const cr = m ? m[2] : '';
        if (prefix) this.adapter.send_keys(prefix);
        if (!cr) return;
        this.scheduleWin32ModalConfirm(cr);
    }

    /**
     * win32 modal-confirm CR resend loop. Mirrors scheduleVerifiedSubmit's phase-2
     * verified resend, but gated on still being IN a modal (status 'approval')
     * rather than still idle: the first CR fires immediately, then resends every
     * WIN32_SUBMIT_RESEND_GAP_MS while the FSM is still showing the modal, up to
     * WIN32_SUBMIT_MAX_RESENDS. The instant the modal resolves (status flips to
     * generating/idle) we stop, so no stray CR leaks into the next turn's composer.
     */
    private scheduleWin32ModalConfirm(submitKey: string): void {
        if (this.win32ModalConfirmTimer) { clearTimeout(this.win32ModalConfirmTimer); this.win32ModalConfirmTimer = null; }
        const fire = (attempt: number): void => {
            this.win32ModalConfirmTimer = null;
            this.adapter.send_keys(submitKey);
            if (attempt + 1 >= WIN32_SUBMIT_MAX_RESENDS) return;
            this.win32ModalConfirmTimer = setTimeout(() => {
                // Left the modal → it resolved; stop resending.
                if (this.currentStatus() !== 'approval') { this.win32ModalConfirmTimer = null; return; }
                fire(attempt + 1);
            }, WIN32_SUBMIT_RESEND_GAP_MS);
        };
        fire(0);
    }

    private handleAttachImage(blob: string, mime: string): void {
        const ctl = (this.spec.control_bar ?? []).find(c => c.action.type === 'attach_image');
        if (!ctl || ctl.action.type !== 'attach_image') return;
        const ext = guessExt(mime);
        const tmp = path.join(os.tmpdir(), `adhdev-attach-${Date.now()}${ext}`);
        try { fs.writeFileSync(tmp, Buffer.from(blob, 'base64')); } catch { return; }
        this.adapter.send_keys(ctl.action.keys_template.replace(/\{path\}/g, tmp));
    }

    private tryAdvancePicker(screen: string): void {
        const picker = this.pickerInProgress;
        if (!picker) return;
        const action = picker.spec.action;
        if (action.type !== 'open_picker' || !action.wait_for.regex) return;
        const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(this.spec.sections ?? {}, lines);
        const hay = sectionText(sections, action.wait_for.section, lines.join('\n'));
        const re = new RegExp(action.wait_for.regex, action.wait_for.flags ?? 'i');
        if (!re.test(hay)) return;
        this.pickerInProgress = null;
    }

    private handleExit(exitCode: number): void {
        this.emit({ kind: 'exit', exit_code: exitCode });
        this.shutdown();
    }

    private pushHistory(stateId: string, label: string, meta: { reason: string; via?: string; matchedRules?: string[] }): void {
        const now = Date.now();
        const durationMs = this.prevStateAt > 0 ? now - this.prevStateAt : 0;
        this.prevStateAt = now;
        this.stateHistory.push({
            stateId, label, at: now, durationMs,
            reason: meta.reason,
            ...(meta.via ? { via: meta.via } : {}),
            ...(meta.matchedRules ? { matchedRules: meta.matchedRules } : {}),
        });
        if (this.stateHistory.length > 50) this.stateHistory.shift();
    }

    /**
     * FSMLOG-SESSION-ATTRIBUTION (D3): log prefix identifying BOTH the spec being driven and the
     * session driving it. Previously spec-only, which made every concurrent session of the same
     * provider log under an identical tag. The session segment is the owning instance's session id
     * (short form — the leading 8 chars are what mesh ledger/trace lines carry, so logs grep-join
     * against them), or a per-driver `d<n>` fallback when no session id was supplied.
     */
    private specTag(): string {
        const spec = this.opts.specPath.split(/[/\\]/).slice(-3).join('/');
        return `${spec}|${this.sessionTag}`;
    }

    private emit(ev: DashboardEvent): void {
        for (const l of this.listeners) {
            try { l(ev); } catch { /* listener side */ }
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

function sameModal(a: ModalSnapshot | null, b: ModalSnapshot | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.title !== b.title) return false;
    if (a.buttons.length !== b.buttons.length) return false;
    for (let i = 0; i < a.buttons.length; i += 1) {
        if (a.buttons[i].label !== b.buttons[i].label) return false;
    }
    return true;
}

function sameControls(a: VisibleControl[], b: VisibleControl[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i].id !== b[i].id) return false;
    return true;
}

/** A compact one-line-per-condition summary of why a transition fired. */
function summarizeTransition(t: TransitionEval): string[] {
    const out: string[] = [`${t.label} fired`];
    if (t.cond) flattenCond(t.cond, out, 1);
    return out;
}

function flattenCond(c: import('./fsm-evaluator.js').CondResult, out: string[], depth: number): void {
    const matched = c.matchedText ? ` matched=${JSON.stringify(c.matchedText)}` : '';
    out.push(`${'  '.repeat(depth)}${c.kind} ${c.detail} = ${c.result}${c.remainingMs ? ` (${c.remainingMs}ms left)` : ''}${matched}`);
    for (const child of c.children ?? []) flattenCond(child, out, depth + 1);
}

function findStable(c: import('./fsm-evaluator.js').CondResult): { totalMs: number } | null {
    if (c.kind === 'stable') {
        const m = /\/ (\d+)ms/.exec(c.detail);
        return { totalMs: m ? Number(m[1]) : 0 };
    }
    for (const child of c.children ?? []) {
        const r = findStable(child);
        if (r) return r;
    }
    return null;
}

/** Resolved description of one stable region the driver must track: its map
 *  key, the geometry (section / cursor_above / whole-screen), and a compiled
 *  `ignore_lines` matcher. */
interface StableRegionDescriptor {
    key: number | string;
    section?: string;
    cursor_above?: number;
    ignoreRe?: RegExp;
    /** The stable_ms threshold the FIRST clause on this region declares. Used
     *  only by the COMPLETION-EARLYNOTIFY stable-eval trace to report the
     *  stable/not-stable verdict; the FSM decision itself is owned by the
     *  evaluator against the live clause. */
    holdMs?: number;
}

function collectStableDescriptors(when: FsmTransition['when'], byKey: Map<number | string, StableRegionDescriptor>): void {
    if (!when) return;
    const w = when as any;
    if ('stable_ms' in w) {
        const key = stableRegionKey(w);
        const existing = byKey.get(key);
        if (!existing) {
            let ignoreRe: RegExp | undefined;
            if (w.ignore_lines) {
                // Compile once here; a bad pattern is validated at load time, so
                // this is best-effort and simply skips the filter if it throws.
                try { ignoreRe = new RegExp(w.ignore_lines, 'm'); } catch { /* validated at load */ }
            }
            byKey.set(key, { key, section: w.section, cursor_above: w.cursor_above, ignoreRe, holdMs: typeof w.stable_ms === 'number' ? w.stable_ms : undefined });
        } else if (existing.holdMs === undefined && typeof w.stable_ms === 'number') {
            // Enrich the -1 whole-screen seed (or an earlier clause) with a threshold
            // so its verdict can be traced. Geometry/ignoreRe from the first set win.
            existing.holdMs = w.stable_ms;
        }
        return;
    }
    if ('all' in w) { for (const c of w.all) collectStableDescriptors(c, byKey); return; }
    if ('any' in w) { for (const c of w.any) collectStableDescriptors(c, byKey); return; }
    if ('not' in w) { collectStableDescriptors(w.not, byKey); return; }
}

/** Lines of section `id` on the given frame, or [] if that section is absent
 *  this frame. Used to compute per-frame change of a section-scoped stable
 *  region. */
function sliceSectionLines(lines: string[], sections: ResolvedSection[], id: string): string[] {
    const sec = sections.find(s => s.id === id);
    if (!sec) return [];
    return lines.slice(sec.fromLine, sec.toLine);
}

/** Drop lines matching `ignoreRe` so a per-frame repaint confined to them does
 *  not register as a region change. No filter → lines returned unchanged.
 *  Exported for unit tests of the stable_ms `ignore_lines` change-detection. */
export function filterIgnoredLines(lines: string[], ignoreRe: RegExp | undefined): string[] {
    if (!ignoreRe) return lines;
    return lines.filter(l => !ignoreRe.test(l));
}

/** Compute the [start, end) line window a cursor_above stable region measures,
 *  reconciling the backend's raw cursor row with the blank-trimmed viewport
 *  line array (see the CODEX-FSM-DEGENERATE-STABLE note in trackRegionChanges).
 *  The window end is clamped to the content length so an overshooting cursor
 *  row measures the content tail instead of slicing past the array into a
 *  permanently-empty — and therefore permanently "unchanged" — window.
 *  Returns null when no measurable window exists (cursor at/above row 0, or no
 *  content): the caller must treat the region as CHANGED, never stable.
 *  Exported for unit tests. */
export function stableCursorWindow(lineCount: number, cursorRow: number, cursorAbove: number): { start: number; end: number } | null {
    const end = Math.min(Math.max(0, cursorRow), Math.max(0, lineCount));
    const start = Math.max(0, end - cursorAbove);
    if (end <= start) return null;
    return { start, end };
}
