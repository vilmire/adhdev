// Module-level types and constants extracted from cli-provider-instance.ts.
// Pure move — no behavior change. These were module-private in the original
// file; they are re-imported by cli-provider-instance.ts and used identically.

// Status snapshots only ever surface the newest messages: the cloud 'live'
// profile drops chat messages entirely (loaded lazily via read_chat on
// subscribe) and the 'full' profile caps activeChat.messages to the last 60
// (see status/normalize.ts). Unread/completion markers walk only the tail.
// So getState()'s saved-history hydration — which runs once per resume/manual
// CLI session on every status report — must read only a bounded tail, not the
// entire transcript. A full MAX_SAFE_INTEGER read here makes the initial
// status report O(transcript) × N(sessions), which is the real cold first-
// connection bottleneck on chat-heavy machines. The window comfortably exceeds
// the 60-message snapshot cap so dedup/collapse at the boundary stays stable.
export const STATUS_HYDRATION_TAIL_LIMIT = 200;

export type CompletedDebouncePending = {
    chatTitle: string;
    duration: number;
    timestamp: number;
    firstObservedAt: number;
    previousStatus: string;
    loggedBlockReason?: string;
    loggedTranscriptProbe?: boolean;
    transcriptProbeHistory?: ExternalTranscriptProbe[];
    // ARCH-REFACTOR R1: the taskId of the turn that produced this (debounced) completion,
    // captured SYNCHRONOUSLY at the generating→idle transition. The actual completion
    // event is emitted later by the debounce flush, by which point a follow-up task may
    // already have started its own turn and overwritten engine.currentTurnTaskId — so the
    // id must be snapshotted here, not re-read at flush time.
    taskId?: string;
    // NOTIF Defect-B: the wall-clock start of the turn that produced this (debounced)
    // completion, snapshotted SYNCHRONOUSLY at the generating→idle transition (same
    // reason as taskId — a follow-up turn moves engine.currentTurnStartedAt). The
    // completion's finalSummary is turn-scoped to bubbles at/after this instant so a
    // debounce that flushes before the producing turn's final assistant bubble lands
    // in the native transcript never echoes the PRIOR task's last bubble.
    turnStartedAt?: number;
    // FALSE-IDLE continuity: the busyEpoch value at the instant this pending was armed.
    // The flush guard requires this.busyEpoch to still equal this — proving no busy
    // phase (generating/waiting_approval) opened since arming. A momentary busy→idle
    // blip in an inter-approval valley bumps busyEpoch, so a completion armed before
    // the blip is cancelled at flush instead of emitting a stale mid-turn summary.
    busyEpochAtArm?: number;
    // FALSE-IDLE continuity: the adapter's raw PTY lastOutputAt at arm time. New PTY
    // output after arming means the session was not continuously idle through the
    // settle window (the agent kept printing), so the completion is cancelled.
    lastOutputAtArm?: number;
    // (FALSE-IDLE-BACKGROUND-CMD) Wall clock of the FIRST flush attempt that observed
    // backgroundTaskActive=true and held. Used to bound the hold: once the hold has
    // lasted BACKGROUND_TASK_HOLD_MAX_MS the flush stops deferring on this signal alone,
    // so a never-completing / killed background job can't pin the session in generating
    // forever. Cleared implicitly when the pending is reset on cancel/emit.
    backgroundTaskHoldSince?: number;
    // EMPTY-FINAL-CONTENT (kimi native-source TOCTOU): the exact message array that
    // completionFinalAssistantEvidence proved `present:true` from on the CLEAN
    // finalization path (getCompletedFinalizationBlock returning null). The clean-path
    // emit used to re-derive finalSummary via a SECOND, independent read
    // (adapter.getScriptParsedStatus() + a fresh readExternalCompletionMessages() inside
    // completionFinalSummary) taken moments later — for a native-source provider whose
    // transcript/PTY buffer can legitimately shift between the two reads (file rewrite,
    // terminal repaint scrolling the matched bubble out), the second read could yield an
    // EMPTY or different result than the evidence that just proved the turn was done,
    // producing a genuine agent:generating_completed with an empty assistant bubble.
    // Caching the PROVING read here lets the emit extract its summary from the SAME
    // snapshot that justified the completion, closing the gap. Undefined when the clean
    // path resolved evidence from the PTY-parsed branch (no separate transcript to race).
    resolvedFinalMessages?: unknown[];
    /** Authority source and observation clock for the exact snapshot above. */
    resolvedFinalEvidenceSource?: 'parsed' | 'external-native';
    resolvedFinalEvidenceObservedAt?: number;
};

export type CompletedFinalizationBlock = {
    reason: string;
    terminal?: boolean;
    allowTimeout?: boolean;
    // (SETTLE-VALLEY) When set, suppress the CANON-C decoupled-immediate emit for this
    // missing_final_assistant block and HOLD (retry up to COMPLETED_FINALIZATION_MAX_WAIT_MS)
    // until the native transcript's final assistant turn arrives (block clears → genuine emit)
    // or the worker resumes (resume guard cancels). Set only for the inter-approval idle valley
    // of a native-history mesh worker, where an immediate weak emit would freeze a truncated
    // preamble summary (evidenceLevel=insufficient) into the append-only ledger before the
    // worker's next approval turn resumes. Independent of valley length.
    holdForTranscript?: boolean;
    // (CANON-C EARLY-EMIT FLOOR) Set on a missing_final_assistant block whose provider has NO
    // external transcript source to trail — a PTY-parsed provider (codex-cli) or one that merely
    // requires a final assistant before idle. For those the CANON-C decoupled-immediate emit is a
    // pure timing guess (no separate transcript will land to upgrade it), so it must observe the
    // CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS floor rather than fire at the ~13s first-poll
    // waitedMs. A native-source block (claude-cli external-native, where the transcript legitimately
    // trails the idle transition by a write) deliberately does NOT set this — its immediate emit is
    // correct and is upgraded by the transcript reconcile.
    noExternalTranscriptSource?: boolean;
};

export type CompletionFinalAssistantEvidence = {
    present: boolean;
    messages: unknown[];
    source: 'parsed' | 'external-native' | 'unavailable';
};

export type ExternalTranscriptProbe = {
    readAt: number;
    msgCount: number;
    lastRole: string | null;
    lastKind: string | null;
    contentLen: number;
    sourcePath: string | null;
    sourceMtimeMs: number | null;
    mtimeAgeMs: number | null;
};

export const COMPLETED_FINALIZATION_RETRY_MS = 1000;
export const COMPLETED_FINALIZATION_MAX_WAIT_MS = 30_000;
// (CANON-C EARLY-EMIT FLOOR) Minimum elapsed time before the CANON-C transcript-evidence
// gate (allowTimeout blocks) may fire its decoupled-immediate completion for a block that
// has NO final-assistant evidence (missing_final_assistant, finalAssistantPresent=false).
//
// CANON-C deliberately decouples the idle NOTIFICATION from the transcript's final-assistant
// turn: for a native-source worker whose transcript write merely trails the idle transition,
// emitting immediately (weak, later upgraded) is correct. But the SAME allowTimeout path also
// carries codex/antigravity PLAIN terminal blocks whose on-screen "final" assistant never
// landed — there the immediate emit fires at whatever tiny waitedMs the first completion-gate
// poll observed (~13s live), stamping evidenceLevel=insufficient and racing the transcript
// before it can catch up or the 180s mesh-worker stall watchdog can arm. Requiring a minimum
// dwell gives the transcript a window to land (clearing the block for a GENUINE emit) and lets
// the stall watchdog own long turns, while still emitting a weak completion promptly once the
// floor is met so a genuinely-answerless turn is never wedged. A block WITH final-assistant
// evidence present is unaffected (it takes the normal emit path, not this floor). Scoped (at
// the call site) to the missing_final_assistant transcript-evidence gate on mesh workers.
// Sized so a short transcript-write lag resolves under it while staying well below the 30s
// COMPLETED_FINALIZATION_MAX_WAIT_MS cap that force-releases the weak completion regardless.
export const CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS = 20_000;
// (TRANSCRIPT-GROWTH-HOLD — CODEX-FSM-DEGENERATE-STABLE RCA, upper safety net)
// Minimum QUIET time required on the provider's native transcript file before a
// missing_final_assistant + noExternalTranscriptSource completion (the FLOOR
// class: codex-cli / kimi / cursor-cli / opencode) may release its weak emit.
// While the transcript file has been appended within this window, the turn is
// demonstrably alive regardless of what the screen parser says — the FSM's
// busy→idle that armed the completion was a lie (spinner escaped the status
// window / degenerate stable region), so the flush HOLDS instead of firing.
//
// Conservative by construction: the hold engages ONLY on positive growth
// evidence (a fresh source mtime). A provider with no native source, an
// unresolvable transcript, or a transcript that has gone quiet for this window
// falls through to the unchanged floor/cap logic — missing information never
// blocks an idle verdict (no false-busy wedge), and each hold cycle is
// re-verified against a FRESH sample, so the hold releases at most this long
// after the transcript's last append.
//
// Sized from the live RCA: during the defect the rollout transcript advanced
// ~once per 45s (msgCount 82→87 over ~4min) while the PTY was quiet for 365s,
// so the window must exceed that append cadence or the hold leaks between
// appends; 60s covers it with margin while staying well under the 180s
// mesh-worker stall watchdog threshold, which keeps ownership of genuine long
// stalls. It only ever delays the already-degraded missing_final_assistant
// path — completions WITH an in-turn final assistant never see this hold.
export const MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS = 60_000;
// (FALSEIDLE-BGCHILD-a) Minimum generating→idle settle window for native-history mesh worker
// sessions. Native-history providers (e.g. claude-cli) normally flush the completion with
// flushDelay=0 — the transcript is authoritative, so there is no reason to wait. But a worker
// turn that spawns a BACKGROUND child (e.g. `npm test &`, a backgrounded Bash tool) can paint
// a burst of child output, fall quiet, and have the screen parser read a PRIOR/intermediate
// standard assistant as if the turn were done — firing a false idle while the agent is in fact
// still generating (e.g. mid-commit). With flushDelay=0 there is no window for the resume guard
// in flushCompletedDebounceIfFinalized (latestVisibleStatus !== 'idle' → cancel) to observe the
// agent picking the turn back up. A short non-zero settle window restores that resume guard for
// mesh workers without delaying genuinely-finished turns beyond this bound. Scoped to mesh
// worker sessions so interactive native-history sessions keep the immediate flush.
// 4000ms (was 1500): live measurement showed the completion event can fire 1.6–3s
// BEFORE the worker's final-assistant turn lands in the transcript on a natural
// generating→idle completion (no approval modal), freezing a prior intermediate
// bubble as finalSummary (evidenceLevel=insufficient). The 68a3c324 waiting_approval
// hold only covers the approval-resolved valley; widening this settle window to 4000ms
// covers that race AND the ~3s waiting_approval valley within the settle bound.
export const NATIVE_HISTORY_MESH_IDLE_SETTLE_MS = 4000;
// (FALSE-IDLE-MIDTURN codex/PTY) Minimum quiet dwell required after the LAST raw PTY
// output before a PTY-PARSED (non-native-history) provider's on-screen "final" assistant
// bubble may be trusted as a turn-complete reply. codex parses its assistant text from the
// terminal screen, so a completion-gate poll that lands MID-STREAM — while the screen still
// shows a partial sentence fragment ("...하겠습니다") and the FSM momentarily reads idle —
// satisfies completionHasFinalAssistantMessage (present=true) and would clean-emit an early
// completion. The busyEpoch/lastOutputAt continuity guard in the flush only CANCELS when new
// output ARRIVES during the settle; it cannot catch a turn that fell quiet just before the
// arm and is still mid-turn. Require instead that the screen has been QUIET for at least this
// long since the last output: a genuinely finished turn's tail is stable well past this bound,
// while a mid-stream fragment is by definition still receiving output (or just did). Bounded,
// non-terminal HOLD — a real completion re-passes the gate one retry later once the dwell is
// met. Scoped (at the call site) to autonomous mesh sessions, so interactive sessions are
// untouched.
export const PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS = 1200;
// (ANTIGRAVITY-30S-CAP-PREMATURE) Minimum PTY quiet dwell required before the
// COMPLETED_FINALIZATION_MAX_WAIT_MS (30s) cap may RELEASE an antigravity `holdForTranscript`
// block into the forced weak completion. Antigravity is a native-source provider: its
// idle/generating verdict is PTY-screen-derived, but its assistant answer lands in
// native-history and can legitimately lag past 30s on a long turn (tool phase + slow reply).
// The 30s cap releases on ELAPSED TIME, not proof-of-idle — so on a long turn it fired a
// premature completed/idle to the coordinator while the PTY was still generating (live-repro:
// a routed RCA task emitted "completed" in 10s with no result). Require instead that the PTY
// has been quiet (no raw output) for at least this long AND the adapter reports no pending
// response before the cap may force-emit. A genuinely quiescent tool-only turn (no assistant
// bubble) has a stable screen well past this bound and still finalizes; a turn whose PTY is
// still producing output keeps holding past 30s (up to ANTIGRAVITY_HOLD_HARD_CAP_MS). Scoped
// (at the call site) to antigravity-cli holdForTranscript blocks, so claude-cli/codex-cli
// completion timing is untouched.
export const ANTIGRAVITY_HOLD_QUIET_DWELL_MS = 3000;
// (ANTIGRAVITY-30S-CAP-PREMATURE) Absolute upper bound on how long an antigravity
// `holdForTranscript` block may be held once the 30s cap is reached but the PTY is still
// active. The quiet-dwell gate above keeps holding while the PTY keeps emitting output, so a
// truly runaway turn (PTY never falls quiet) must still eventually release rather than wedge
// the session in generating forever — strictly worse than the original premature-emit bug.
// Once a pending completion has been held this long we force-emit regardless of PTY activity.
// Sized generously (5 min) so realistic long antigravity turns (multi-tool + slow reply)
// finish and let the transcript land / the PTY fall quiet naturally, while still guaranteeing
// eventual release. Mirrors BACKGROUND_TASK_HOLD_MAX_MS's escape-hatch rationale.
export const ANTIGRAVITY_HOLD_HARD_CAP_MS = 5 * 60_000;
// (FALSE-IDLE-BACKGROUND-CMD) Hard cap on how long a pending completion may be HELD
// solely because the claude-cli transcript still shows an unresolved run_in_background
// bash job (backgroundTaskActive). The hold is the correct behaviour while the job is
// genuinely running — the parent turn is idle but the session is not done. But the
// signal derives from a MISSING tool_result in an append-only transcript: if a
// background job is killed, crashes, or its completion is never written, the flag would
// never clear and the session would be pinned in generating forever — strictly worse
// than the original false-idle bug. This cap is the escape hatch: once a pending
// completion has been held this long on the background-task signal alone, we stop
// holding and let the normal finalization proceed (emit). Sized generously (5 min) so
// realistic background jobs (tests, builds, long greps) complete and clear the flag
// naturally, while still guaranteeing eventual release.
export const BACKGROUND_TASK_HOLD_MAX_MS = 5 * 60_000;
// TASKBUBBLE-DUP: window during which an identical user-input ack (same trimmed
// content on the same instance) is treated as a redelivery of one dispatch and
// suppressed from the chat transcript. Matches the coordinator-side
// DUPLICATE_DISPATCH_WINDOW_MS (mesh-tools) so the daemon's bubble-level guard
// covers the same retry horizon as the MCP-level dispatch dedup.
export const USER_INPUT_ACK_DEDUP_WINDOW_MS = 60_000;
// GENERATING-BOUNDARY (R4c): window — measured from the startup-grace COLLAPSE moment
// (startupGraceCollapseAt), not boot — inside which a "first turn that ran+completed
// without the FSM ever observing a 'generating' frame" is attributed to the startup-grace
// collapse and synthesized (reason 'startup_grace_idle_turn_collapse').
// The spec's startup-grace exit is elapsed_ms=8000, so the FSM spends ~8s in 'starting'
// before collapsing to idle; a turn can be dispatched a few seconds AFTER that collapse
// (the live R4b miss: collapse at boot+8s, dispatch at boot+12.4s — already past a 12s
// boot-anchored window before the turn even started). Anchoring on the collapse moment
// covers dispatch-delay; R4d additionally anchors on the turn-START moment
// (engine.currentTurnStartedAt) so a non-trivial turn-DURATION cannot push the completion
// past a now-anchored window (the live rc.405 Probe2 miss). The strong discriminator is
// generatingStartedAt===0 (generating was never observed) AND a started-but-finished turn
// — the window only keeps the synthesized reason honest and scopes the synthesis to the
// boot collapse, so a much-later unobservably-fast turn is not mislabelled a startup collapse.
export const STARTUP_GRACE_IDLE_COLLAPSE_WINDOW_MS = 12_000;

/** Events that signal a dispatched mesh task has reached a terminal state.
 *  Detach the mesh assignment after emitting one of these so the worker's
 *  next unrelated turn doesn't impersonate another completion. */
export const TERMINAL_MESH_EVENTS = new Set([
    'agent:generating_completed',
    'agent:stopped',
    'agent:ready',
]);
