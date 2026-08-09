/**
 * Completion stall-rescue & synthetic-emit paths (Phase 3 of the
 * completion-engine rewrite — verbatim move out of CliProviderInstance).
 *
 * Owns the three "the turn finished but the completion event never fired"
 * rescues: the stall-path transcript reconcile the mesh watchdog consults
 * before firing monitor:no_progress (TRANSCRIPT-COMPLETION-STALL-RESCUE), the
 * pre-cleanup completion flush for a PTY that exited before its emit window
 * closed (KIMI-MESH-COMPLETION-EMIT axis 2), and the startup-grace
 * fast-collapse synth for an unobservably-fast first turn
 * (GENERATING-BOUNDARY R4b/R4c). Turn/episode state stays ON THE HOST (the
 * provider instance) and the emit/evidence helpers dispatch back THROUGH the
 * host so instance-level overrides in the suites remain on the path.
 *
 * Provenance kept inline: TRANSCRIPT-COMPLETION-STALL-RESCUE (P2 of the
 * transcript-authority unification — historically KIMI-PURE-PTY-COMPLETION-
 * EMIT + KIMI-NATIVE-SOURCE-COMPLETION-EMIT), TX-FSM Stage 1 FIX 3 probe
 * delegation, COMPLETION-WEAK-REARM fix1, ANTIGRAVITY-PREMATURE-COMPLETION
 * turn-start gate, SPEC-DRIVEN completion timing (mission f2f6da1b /
 * AGY-BOOT-PHANTOM hold class), EARLYNOTIFY-GATEBYPASS (c) weak marking.
 */

import { LOG } from '../../logging/logger.js';
import { traceMeshEventStage } from '../../mesh/mesh-event-trace.js';
import { resolveTranscriptAuthorityProfile } from '../transcript-evidence.js';
import { extractFinalSummaryFromMessages, extractFinalSummaryFromMessagesAfter } from '../chat-message-normalization.js';
import type { ProviderModule } from '../contracts.js';
import type { CompletionFinalAssistantEvidence } from '../cli-provider-instance-types.js';
import type { SignalSnapshot } from '../spec/signal-envelope.js';

/**
 * The narrow surface of CliProviderInstance the rescue paths read/write.
 * Turn/episode state stays instance-owned; the shared emit/evidence/guard
 * helpers are dispatched through the host so suite-level stubs stay effective.
 */
export interface StallRescueHost {
    type: string;
    instanceId: string;
    provider: ProviderModule;
    adapter: {
        getScriptParsedStatus(): any;
    };
    settings: Record<string, any>;
    meshTaskInjectedAt: number;
    generatingStartedAt: number;
    generatingDebouncePending: { chatTitle: string; timestamp: number } | null;
    fastCollapseSynthesizedTaskId: string | null;
    isMeshWorkerSession(): boolean;
    hasAdapterPendingResponse(): boolean;
    completingTurnTaskId(): string | undefined;
    shouldSuppressCompletionReEmit(taskId: string | undefined): boolean;
    injectedTaskHasStartedGenerating(): boolean;
    completionFinalSummary(parsedMessages: unknown, turnStartedAt?: number): string | undefined;
    completionFinalAssistantEvidence(parsedMessages: unknown, turnStartedAt?: number): CompletionFinalAssistantEvidence;
    meshTraceCtx(event?: string): Record<string, unknown>;
    emitGeneratingCompleted(opts: {
        chatTitle: string;
        duration: number | undefined;
        timestamp: number;
        taskId?: string;
        finalSummary?: string;
        evidenceLevel?: string;
        completionDiagnostic?: Record<string, unknown>;
    }): void;
    completionTraceOn(): boolean;
    recordCompletionGateTrace(stage: string, payload: Record<string, unknown>): void;
    pushEvent(event: Record<string, unknown>): void;
}

/**
 * KIMI-MESH-COMPLETION-EMIT (axis 2). Last-chance completion emit for a mesh
 * DELEGATED worker whose PTY has already exited (e.g. killed by a false stall)
 * and is about to be auto-cleaned (cli-manager.startCliExitMonitor →
 * removeInstance closes the event-emit window forever). If the worker actually
 * FINISHED its assigned turn — its authoritative native transcript holds a final
 * assistant message for the injected task — but the completion event never fired
 * (the stall-kill happened before the FSM's idle transition), emit it now so the
 * coordinator learns the task completed instead of waiting ~180s for the reconcile
 * transcript-poll to reclaim it.
 *
 * Scope & guards (must all hold to emit):
 *   • mesh worker session only — a normal standalone session's ordinary exit is
 *     never synthesized (isMeshWorkerSession()).
 *   • DOUBLE-EMIT guard — refuse if this turn's completion already fired
 *     (lastEmittedCompletion matches the current taskId). A worker that completed
 *     cleanly and is merely being cleaned up never double-emits.
 *   • evidence gate — reuse the same final-assistant/turn-scoped summary machinery
 *     as the normal completion path (completionFinalSummary over the native
 *     transcript). No in-turn assistant summary ⇒ no proof of completion ⇒ leave
 *     the reclaim path to handle a genuinely-unfinished worker.
 *
 * Returns true when a synthetic completion was emitted, false otherwise. Safe to
 * call unconditionally from the cleanup path.
 */
export function flushMeshCompletionBeforeCleanup(host: StallRescueHost): boolean {
    if (!host.isMeshWorkerSession()) return false;
    const taskId = host.completingTurnTaskId();

    // DOUBLE-EMIT guard (COMPLETION-WEAK-REARM fix1): suppress a re-emit only when this
    // turn's completion already fired with GENUINE evidence. A prior WEAK emit is
    // re-armable once a real generating→idle transition intervened (one-shot).
    if (host.shouldSuppressCompletionReEmit(taskId)) {
        return false;
    }

    // Evidence gate: the injected task's own turn must have genuinely started
    // (guards against synthesizing a completion off a reused session's stale tail
    // before this task ran) and the native transcript must hold an in-turn final
    // assistant summary. turnStartedAt anchors the turn-scoped read.
    if (!host.injectedTaskHasStartedGenerating()) return false;
    const turnStartedAt = typeof (host.adapter as any)?.currentTurnStartedAt === 'number'
        ? (host.adapter as any).currentTurnStartedAt as number
        : host.meshTaskInjectedAt || undefined;
    let parsedMessages: unknown;
    try {
        parsedMessages = host.adapter?.getScriptParsedStatus?.()?.messages;
    } catch { parsedMessages = undefined; }
    let finalSummary: string | undefined;
    try {
        finalSummary = host.completionFinalSummary(parsedMessages, turnStartedAt);
    } catch { finalSummary = undefined; }
    // No in-turn final assistant evidence → not a proven turn-end. Defer to the
    // coordinator's reclaim/reconcile path rather than fabricate a completion.
    if (!finalSummary) return false;

    LOG.warn('CLI', `[${host.type}] emitting pre-cleanup mesh completion for session ${host.instanceId} `
        + `task=${taskId ?? '(none)'} — PTY exited before the completion event fired but the native transcript `
        + `shows a finished turn; synthesizing completion so the coordinator is not left waiting for reclaim.`);
    if (host.isMeshWorkerSession()) {
        traceMeshEventStage('fired', host.meshTraceCtx(), 'pre_cleanup_transcript_completion');
    }
    host.emitGeneratingCompleted({
        chatTitle: '',
        duration: undefined,
        timestamp: Date.now(),
        taskId,
        finalSummary,
        evidenceLevel: 'transcript',
        completionDiagnostic: { source: 'pre_cleanup_transcript_completion' },
    });
    return true;
}

/**
 * TRANSCRIPT-COMPLETION-STALL-RESCUE (P2 of the transcript-authority
 * unification — root repo docs/design/2026-07-25-transcript-authority-
 * unification.md): stall-path completion reconcile for every class whose
 * turns can finish without a generating_completed emit (idle→idle collapse)
 * and then sit PTY-quiet at a static idle prompt.
 *
 * Historically this was TWO class-enumerated copies — KIMI-PURE-PTY-
 * COMPLETION-EMIT (Fix 3) gated on isPurePtyTranscriptProvider, and
 * KIMI-NATIVE-SOURCE-COMPLETION-EMIT gated on isNativeSourceCanonicalHistory
 * — whose bodies were identical because completionFinalSummary already picks
 * the class-appropriate evidence source (authoritative native transcript for
 * a native-source provider, the PTY parse otherwise). The enumeration itself
 * was the recurring defect: each new class had to be remembered at this site.
 * The profile collapses it: any class except daemon-owned is eligible, and
 * the evidence bar — not the class — decides.
 *
 * Called from checkMeshWorkerStall just before the fire. Returns true when
 * the session is a finished turn — idle, nothing pending, the injected
 * task's turn genuinely started, and an in-turn final assistant summary —
 * in which case it emits the missing generating_completed (idempotent: a
 * real/late emit writes the terminal ledger and the coordinator's reconcile
 * makes any duplicate a no-op) and the caller SUPPRESSES the stall. Returns
 * false for a daemon-owned provider and for a genuinely mid-turn / wedged
 * worker with no in-turn final assistant, so a real stall still fires
 * unchanged. Evidence bar is identical to flushMeshCompletionBeforeCleanup.
 *
 * TX-FSM Stage 1 (FIX 3 probe delegation): for a native-source class the
 * completion VERDICT is the shared TranscriptSignalSource's
 * final_assistant_present signal, normalized from the ONE transcript read
 * the stall watchdog already performed this tick (passed in as
 * `transcriptSignals`) — not a second private read + scan. The emit
 * payload (finalSummary) is extracted from the SAME messages the signal
 * was normalized from, with the SAME turn boundary the legacy path used,
 * so the extraction re-proves the turn scope the signal checked. Fail-open
 * both ways: no usable snapshot (read failed / unresolved / a pure-PTY
 * class, which has no native signal by construction) → the legacy
 * class-appropriate evidence path (completionFinalSummary), unchanged; and
 * a present-but-unextractable signal yields false rather than a
 * payload-less emit.
 */
export function tryReconcileTranscriptCompletionForStall(
    host: StallRescueHost,
    observedStatus: string,
    transcriptSignals?: { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null,
): boolean {
    // daemon-owned transcripts get real PTY turn events — an idle-quiet
    // daemon-owned worker with no completion emit is a genuine anomaly the
    // stall should surface, exactly as before this unification.
    const profile = resolveTranscriptAuthorityProfile(host.provider);
    if (profile.class === 'daemon-owned') return false;
    // A finished turn is idle with nothing pending. A generating/waiting session is
    // mid-turn (the real stall path should evaluate it), so never complete it here.
    if (observedStatus !== 'idle') return false;
    if (host.hasAdapterPendingResponse()) return false;

    const taskId = host.completingTurnTaskId();
    // DOUBLE-EMIT guard (COMPLETION-WEAK-REARM fix1): suppress a re-emit only when this
    // turn's completion already fired with GENUINE evidence. A prior WEAK emit is
    // re-armable once a real generating→idle transition intervened (one-shot).
    if (host.shouldSuppressCompletionReEmit(taskId)) {
        return false;
    }
    // The injected task's own turn must have genuinely started (guards against a
    // reused session's stale tail before this task ran).
    if (!host.injectedTaskHasStartedGenerating()) return false;

    const turnStartedAt = typeof (host.adapter as any)?.currentTurnStartedAt === 'number'
        ? (host.adapter as any).currentTurnStartedAt as number
        : host.meshTaskInjectedAt || undefined;
    let parsedMessages: unknown;
    try {
        parsedMessages = host.adapter?.getScriptParsedStatus?.()?.messages;
    } catch { parsedMessages = undefined; }
    // TX-FSM Stage 1: a native-source class with a usable signal snapshot
    // takes its verdict from the SHARED signal source (final_assistant_present),
    // and the payload from the SAME messages — zero added I/O. Every other
    // case falls back to completionFinalSummary, which turn-scopes the
    // class-appropriate transcript (native history for a native-source
    // provider, the PTY parse otherwise) — a stale prior-turn tail or a
    // mid-turn worker with no in-turn final assistant yields '' → return
    // false below.
    let finalSummary: string | undefined;
    const signalSnapshot = transcriptSignals?.snapshot;
    if (profile.class === 'native-source' && signalSnapshot?.available === true) {
        // The signal is the verdict; the turn-scoped extraction re-proves
        // the scope and supplies the emit payload from the same read.
        if (signalSnapshot.signals.final_assistant_present !== true) return false;
        finalSummary = extractFinalSummaryFromMessagesAfter(
            (Array.isArray(transcriptSignals?.messages) ? transcriptSignals.messages : []) as any,
            turnStartedAt,
        ) || undefined;
    } else {
        try {
            finalSummary = host.completionFinalSummary(parsedMessages, turnStartedAt);
        } catch { finalSummary = undefined; }
    }
    // No in-turn final assistant evidence → not a proven turn-end. Let the real
    // stall fire so a genuinely-wedged worker is still surfaced.
    if (!finalSummary) return false;

    // Telemetry keeps the historical per-class source strings so traces and
    // dashboards stay comparable across the unification.
    const diagnosticSource = profile.class === 'pure-pty'
        ? 'stall_pure_pty_transcript_completion'
        : 'stall_native_source_transcript_completion';
    LOG.warn('CLI', `[${host.type}] reconciling ${profile.class} mesh completion from the stall path for session ${host.instanceId} `
        + `task=${taskId ?? '(none)'} — PTY is idle-quiet with an in-turn final assistant message but the completion `
        + `event never fired; emitting it instead of a false monitor:no_progress.`);
    if (host.isMeshWorkerSession()) {
        traceMeshEventStage('fired', host.meshTraceCtx(), diagnosticSource);
    }
    host.emitGeneratingCompleted({
        chatTitle: '',
        duration: undefined,
        timestamp: Date.now(),
        taskId,
        finalSummary,
        evidenceLevel: 'transcript',
        completionDiagnostic: { source: diagnosticSource },
    });
    return true;
}

/**
 * GENERATING-BOUNDARY synthetic emit for a first turn that started AND finished
 * inside the startup-grace window without the FSM ever observing a 'generating'
 * frame (an unobservably-fast turn). Synthesizes the agent:generating_started +
 * agent:generating_completed pair so the mesh coordinator learns the worker went
 * idle. Returns true iff it synthesized.
 *
 * Two callers share this defense line:
 *  - 'startup_grace_fast_collapse' — the starting→idle transition (the FSM whose
 *    spec lacks/hadn't-synced the starting→busy edge collapses starting→idle
 *    directly, with no intervening 'generating' frame).
 *  - 'startup_grace_idle_turn_collapse' — the idle→idle no-status-change poll
 *    (the launch settle already drained starting→idle BEFORE the first turn, so
 *    the turn runs+completes while status stays 'idle' the whole time and
 *    detectStatusTransition never re-enters its change block — the live rc.403
 *    Probe1 miss).
 *
 * False-positive safety (must NOT fire on a benign boot): currentTurnTaskId is
 * set ONLY by onTurnStarted (a real turn STARTED this boot) and persists past
 * completion, so it excludes a true idle boot (null) and a queued-pending first
 * turn that only runs after grace (onTurnStarted not yet called → null).
 * !hasAdapterPendingResponse() excludes a turn still mid-flight. generating
 * never armed (generatingStartedAt===0 && !generatingDebouncePending) means the
 * whole idle→busy→idle never happened for this turn. The once-per-turn guard
 * (fastCollapseSynthesizedTaskId) keeps the re-polled idle-stayed caller from
 * re-emitting every poll — and is ALSO stamped by the genuine completion flush
 * (markCurrentTurnStartupGraceCollapseSatisfied), so a turn that completed
 * NORMALLY inside the grace window (generating armed, then consumed by the
 * flush's generatingStartedAt=0 reset) is never misclassified as a
 * never-armed collapse on the next idle-stayed poll.
 */
export function maybeSynthesizeStartupGraceCollapse(
    host: StallRescueHost,
    chatTitle: string,
    now: number,
    reason: 'startup_grace_fast_collapse' | 'startup_grace_idle_turn_collapse',
): boolean {
    const startedTurnTaskId = typeof (host.adapter as any)?.currentTurnTaskId === 'string'
        && (host.adapter as any).currentTurnTaskId.trim()
        ? (host.adapter as any).currentTurnTaskId as string
        : undefined;
    const fastCollapsed = !!startedTurnTaskId
        && !host.hasAdapterPendingResponse()
        && !host.generatingStartedAt
        && !host.generatingDebouncePending;
    if (!fastCollapsed) return false;
    // Once-per-turn: the idle-stayed caller re-polls steadily while the session
    // sits idle; without this guard it would re-emit the pair every poll.
    if (host.fastCollapseSynthesizedTaskId === startedTurnTaskId) return false;

    let fcFinalSummary: string | undefined;
    let fcEvidenceSource: CompletionFinalAssistantEvidence['source'] = 'unavailable';
    try {
        const parsedMessages = host.adapter?.getScriptParsedStatus()?.messages;
        const evidence = host.completionFinalAssistantEvidence(parsedMessages);
        fcEvidenceSource = evidence.source;
        fcFinalSummary = extractFinalSummaryFromMessages(evidence.messages as any);
    } catch { /* best-effort */ }
    // SPEC-DRIVEN completion timing (mission f2f6da1b / AGY-BOOT-PHANTOM): the
    // startup-grace synth must enumerate the SAME transcript-authority timing
    // classes the genuine finalization gate does (getCompletedFinalizationBlock,
    // the external-native branch ~line 2120), not just 'floor' + external-native.
    // The 'hold' class (antigravity — holdCompletionForTranscript) was missing:
    // at boot its native history is often not yet written, so fcEvidenceSource is
    // 'unavailable' (neither 'floor' nor 'external-native'), which left
    // missingEvidence=false and fired a WEAK phantom completion the moment the FSM
    // collapsed to idle — a completion for a turn whose authoritative transcript
    // had not landed.
    const synthTiming = resolveTranscriptAuthorityProfile(host.provider).timing;
    const missingEvidence = (synthTiming === 'floor' || synthTiming === 'hold' || fcEvidenceSource === 'external-native') && !fcFinalSummary;
    // HOLD class (antigravity): idle holds for the native transcript to land. The
    // finalization gate never emits a completion for a hold provider without the
    // transcript (it returns holdForTranscript / null at ~line 2120), so the synth
    // must not either — even WITH mesh context. Suppress the synth and leave the
    // task UNMARKED so a later idle poll re-runs this path once the transcript's
    // final assistant lands (then fcFinalSummary is present → missingEvidence=false
    // → a genuine, summary-bearing emit). This is the HOLD-and-retry equivalent of
    // the finalization gate's non-terminal missing_final_assistant hold; it is what
    // stops the boot-time phantom weak completion for a mesh worker.
    if (missingEvidence && synthTiming === 'hold') {
        LOG.info('CLI', `[${host.type}] ${reason} held: hold-class transcript not yet landed (source=${fcEvidenceSource})`);
        return false;
    }
    // Mirror the short-generating idle path's suppression: a provider that
    // requires a final assistant (or external-native history) with NO confirmed
    // summary and NO mesh context emits nothing — the session is idle with no
    // confirmed turn, matching startup-blip semantics. With mesh context we still
    // emit so the coordinator can apply its own timeout/retry logic. Left UNMARKED
    // so a later poll can retry once the transcript's final assistant lands.
    const hasMeshContext = !!(host.settings.meshNodeFor || host.settings.meshActiveTaskId || host.settings.launchedByCoordinator);
    if (missingEvidence && !hasMeshContext) {
        LOG.info('CLI', `[${host.type}] ${reason} suppressed: missing final assistant evidence, no mesh context (source=${fcEvidenceSource})`);
        return false;
    }
    // Mark BEFORE emitting so a re-entrant poll cannot double-fire.
    host.fastCollapseSynthesizedTaskId = startedTurnTaskId;
    LOG.info('CLI', `[${host.type}] ${reason}: synthesizing started+completed (taskId=${startedTurnTaskId} source=${fcEvidenceSource} hadFinalSummary=${!!fcFinalSummary})`);
    // Retroactive started so the started→completed pair (and the chat bubble) is
    // well-formed; pushEvent stamps the per-turn taskId for CANON-B ack.
    host.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now });
    if (host.isMeshWorkerSession()) {
        traceMeshEventStage('fired', host.meshTraceCtx(), `${reason} (source=${fcEvidenceSource})`);
    }
    // EARLYNOTIFY-GATEBYPASS (c): a startup-grace fast-collapse never OBSERVED the turn's
    // generating phase — its evidence is a plain transcript tail, never a self-attributing
    // final_summary_json — so this synth is TENTATIVE by default. Mark it WEAK
    // (evidenceLevel:'weak') so buildPendingEventFingerprint keys it `…::weak` and any later
    // genuine agent:generating_completed for the same task can still surface (CANON-B). The
    // stronger missing_final_assistant marker is preserved when there is also no summary.
    if (host.completionTraceOn()) host.recordCompletionGateTrace('synth-fire', {
        path: 'startup_grace_fast_collapse',
        reason,
        evidenceSource: fcEvidenceSource,
        hadFinalSummary: !!fcFinalSummary,
        missingEvidence,
        evidenceLevel: 'weak',
    });
    host.emitGeneratingCompleted({
        chatTitle,
        duration: 0,
        timestamp: now,
        finalSummary: fcFinalSummary,
        evidenceLevel: 'weak',
        completionDiagnostic: {
            reason,
            finalAssistantEvidenceSource: fcEvidenceSource,
            ...(missingEvidence ? { blockReason: 'missing_final_assistant' } : {}),
        },
    });
    return true;
}
