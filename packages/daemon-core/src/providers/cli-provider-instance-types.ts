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
