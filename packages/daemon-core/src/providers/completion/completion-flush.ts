/**
 * The completed-debounce flush interpreter (verbatim move out of
 * CliProviderInstance — M-FILE-SIZE-DEBT decomposition).
 *
 * A-3/Phase-1 (completion-engine rewrite): this is an INTERPRETER, not a judge.
 * decideCompletionPreflight / decideCompletionVerdict (completion-engine.ts) own
 * the WHETHER/WHEN judgment — cancels, every hold class and its bound, the
 * weak/genuine emit split — as one pure, ordered rule pipeline. This function
 * only translates the returned decision into effects: logging/tracing, the
 * pending-record patch, retry scheduling, and the single emit call.
 *
 * Rule semantics and their provenance (FALSE-IDLE / CANON-C / SETTLE-VALLEY /
 * TX-FSM / …) are documented on the engine; do not re-inline judgment here.
 *
 * State lives ON THE HOST (the provider instance) exactly as before, so the
 * per-incident regression suites that drive the flush directly are unchanged.
 */

import { LOG } from '../../logging/logger.js';
import type { CompletedDebouncePending, CompletedFinalizationBlock } from '../cli-provider-instance-types.js';
import type { CompletionArmPatch, CompletionFlushDecision, CompletionPolicy, CompletionSignalReader } from './completion-engine.js';
import { decideCompletionPreflight, decideCompletionVerdict } from './completion-engine.js';
import type { CancelledCompletionReason } from './cancel-recheck.js';
import { traceMeshEventStage } from '../../shared/mesh-event-trace.js';
import { extractJsonObjectFromSummary } from '../../shared/worker-result-parse.js';
import { resolveTranscriptAuthorityProfile } from '../transcript-evidence.js';
import { isWeakCompletionEvidence } from '../../mesh/mesh-events-utils.js';
import type { ProviderModule } from '../contracts.js';
import { COMPLETED_FINALIZATION_RETRY_MS } from '../cli-provider-instance-types.js';
import { emitTurnEnd, type TurnEvidencePort } from '../turn-evidence-port.js';
import type { TurnAttemptRef, TurnEndBlockReason, NativeTurnOutcome } from '@adhdev/mesh-shared';

/**
 * `opts.completionDiagnostic.blockReason` (set on the weak/emit-weak path,
 * see below) is already one of the closed `TurnEndBlockReason` members in
 * every current producer — `getCompletedFinalizationBlock` /
 * `decideCompletionVerdict` (completion-engine.ts) only ever set it to
 * `missing_final_assistant | finalization_timeout | terminal_block_hard_cap |
 * decoupled_completion`. This guard narrows the type without inventing a
 * mapping table for values that cannot occur.
 */
const TURN_END_BLOCK_REASON_SET: ReadonlySet<string> = new Set([
    'missing_final_assistant', 'finalization_timeout', 'terminal_block_hard_cap', 'decoupled_completion',
]);
function asTurnEndBlockReason(value: unknown): TurnEndBlockReason | undefined {
    return typeof value === 'string' && TURN_END_BLOCK_REASON_SET.has(value) ? (value as TurnEndBlockReason) : undefined;
}

const NATIVE_TURN_OUTCOME_SET: ReadonlySet<string> = new Set(['completed', 'aborted']);
function asNativeTurnOutcome(value: unknown): NativeTurnOutcome | undefined {
    return typeof value === 'string' && NATIVE_TURN_OUTCOME_SET.has(value) ? (value as NativeTurnOutcome) : undefined;
}

/** The narrow surface of CliProviderInstance the flush interpreter reads/writes. */
export interface CompletionFlushHost {
    type: string;
    instanceId: string;
    provider: ProviderModule;
    settings: Record<string, any>;
    adapter: Record<string, any>;
    busyEpoch: number;
    generatingStartedAt: number;
    lastApprovalEventFingerprint: string;
    completedDebouncePending: CompletedDebouncePending | null;
    completedDebounceTimer: NodeJS.Timeout | null;
    completionEnginePolicy(): CompletionPolicy;
    buildCompletionSignalReader(pending: CompletedDebouncePending, visibleStatusOverride?: string): CompletionSignalReader;
    applyCompletionArmPatch(pending: CompletedDebouncePending, patch: CompletionArmPatch): void;
    getCompletedFinalizationBlock(latestVisibleStatus: string, pending: CompletedDebouncePending): CompletedFinalizationBlock | null;
    buildCompletedFinalizationDiagnostic(args: {
        blockReason: string;
        latestStatus?: any;
        latestVisibleStatus: string;
        waitedMs: number;
        pending: CompletedDebouncePending;
        emittedAfterFinalizationTimeout: boolean;
    }): Record<string, unknown>;
    logCompletionHold(decision: Extract<CompletionFlushDecision, { kind: 'hold' }>): void;
    scheduleCompletedDebounceFlush(delayMs: number): void;
    armCancelledCompletionRecheck(pending: CompletedDebouncePending, reason: CancelledCompletionReason, delayMs?: number): void;
    clearCancelledCompletionRecheck(): void;
    emitGeneratingCompleted(opts: any): void;
    markCurrentTurnStartupGraceCollapseSatisfied(): void;
    cleanCompletionFinalSummary(pending: CompletedDebouncePending): string | undefined;
    completionFinalSummary(parsedMessages: unknown, turnStartedAt?: number): string | undefined;
    cachedInTurnCompletionSummaryContent(turnStartedAt?: number): string;
    nativeTurnTerminalSummary(turnStartedAt?: number): string | undefined;
    snapshotExternalNativeCompletionSummary(pending: CompletedDebouncePending): string | undefined;
    finalSummaryProvenanceDiagnostic(emittedSummary: string | undefined): Record<string, unknown>;
    recordCompletionGateTrace(stage: string, payload: Record<string, unknown>): void;
    completionTraceOn(): boolean;
    isMeshWorkerSession(): boolean;
    meshTraceCtx(event?: string): Record<string, unknown>;
}

export function flushCompletedDebounceIfFinalized(host: CompletionFlushHost): void {
    const pending = host.completedDebouncePending;
    if (!pending) {
        host.completedDebounceTimer = null;
        return;
    }

    const reader = host.buildCompletionSignalReader(pending);
    const policy = host.completionEnginePolicy();
    const latestVisibleStatus = reader.visibleStatus();
    const pre = decideCompletionPreflight(pending, reader, policy);
    let decision: CompletionFlushDecision;
    if (pre.kind !== 'proceed') {
        decision = pre;
    } else {
        host.applyCompletionArmPatch(pending, pre.armPatch);
        // Historical seam: the finalization block is obtained through the instance
        // method (not the engine directly) so the per-incident regression suites can
        // pin it. The delegate also applies the evidence-stash patch to `pending`.
        const block = host.getCompletedFinalizationBlock(latestVisibleStatus, pending);
        decision = decideCompletionVerdict(pending, reader, policy, block);
    }
    LOG.debug('CLI', `[${host.type}] flush attempt: latestVisible=${latestVisibleStatus} decision=${decision.kind} generatingStartedAt=${host.generatingStartedAt}`);

    if (decision.kind === 'cancel') {
        const label = decision.reason === 'resumed_status'
            ? `resumed ${latestVisibleStatus}`
            : decision.reason === 'busy_reentry'
                ? `busy re-entry during settle: epoch ${pending.busyEpochAtArm}→${host.busyEpoch}`
                : `new PTY output during settle: ${pending.lastOutputAtArm}→${(decision.trace as any).lastOutputAt}`;
        LOG.info('CLI', `[${host.type}] cancelled pending completed (${label})`);
        if (host.completionTraceOn()) host.recordCompletionGateTrace('cancel', { blockReason: decision.reason, ...decision.trace });
        host.completedDebouncePending = null;
        host.completedDebounceTimer = null;
        // (CANCEL-BLIP-ORPHAN) The cancel above is CORRECT and stays — a resumed turn
        // must never emit the completion armed before it. But dropping the arm here was
        // the whole story, and that is the defect: the ONLY path that re-arms a
        // completion is a fresh idle→generating FSM edge, so a sub-second PTY blip
        // right after a genuine turn end (live codex incident: busy→idle→busy in 81ms,
        // then idle again with no further edge) deleted the arm and no completion ever
        // fired — the worker finished ~10min later while the coordinator's queue row
        // sat 'generating' until a 15/90-min hard deadline reclaimed it.
        //
        // Instead of guessing blip-vs-real-resume at cancel time (unknowable from a
        // point sample — that is exactly what made the original inline judgment
        // unreliable), hand the deleted arm to a bounded RE-VERIFICATION watch and
        // decide later, when the session's state is actually observable. A real resume
        // simply re-cancels on each recheck and the watch expires; a blip settles back
        // to idle and the re-armed pending flushes through the unchanged gate. Every
        // rule (continuity, finalization block, evidence) is re-applied on the retry —
        // the watch grants no exemption, it only restores the chance to be judged.
        host.armCancelledCompletionRecheck(pending, decision.reason);
        return;
    }

    host.applyCompletionArmPatch(pending, decision.armPatch);

    if (decision.kind === 'hold') {
        host.logCompletionHold(decision);
        if (host.completionTraceOn()) host.recordCompletionGateTrace('hold', {
            blockReason: (decision.trace as any).blockReason ?? decision.reason,
            ...decision.trace,
        });
        host.scheduleCompletedDebounceFlush(decision.retryInMs);
        return;
    }

    if (decision.kind === 'emit-weak') {
        const blockReason = decision.block.reason;
        const waitedMs = decision.waitedMs;
        const emittedAfterFinalizationTimeout = decision.emittedAfterFinalizationTimeout;
        const latestStatus = host.adapter.getStatus({ allowParse: false });
        const completionDiagnostic = host.buildCompletedFinalizationDiagnostic({
            blockReason,
            latestStatus,
            latestVisibleStatus,
            waitedMs,
            pending,
            emittedAfterFinalizationTimeout,
        });
        // Surface the CANON-C immediate-emit path distinctly so a delegated worker's idle
        // notification (transcript still pending) is not mistaken for a 30s-timeout fallback.
        (completionDiagnostic as Record<string, unknown>).decoupledImmediateEmit = decision.decoupledImmediateEmit;
        // (INFINITE-GENERATING) A hard-cap release means the terminal block's reason never
        // cleared — the session would previously have wedged in generating forever. Log it
        // distinctly from the ordinary timeout so the stuck provider stays diagnosable.
        (completionDiagnostic as Record<string, unknown>).releasedByTerminalBlockHardCap = decision.releasedByTerminalBlockHardCap;
        const emitCause = decision.releasedByTerminalBlockHardCap
            ? `terminal block never cleared, released at ${waitedMs}ms hard cap`
            : decision.decoupledImmediateEmit ? 'CANON-C decoupled-immediate, transcript pending' : `after ${waitedMs}ms`;
        LOG.warn('CLI', `[${host.type}] emitting completed event (${emitCause}) without finalized assistant turn (${blockReason})`);
        if (host.isMeshWorkerSession()) {
            traceMeshEventStage('fired', host.meshTraceCtx(), `forced after ${waitedMs}ms (${blockReason})`);
        }
        if (host.completionTraceOn()) host.recordCompletionGateTrace('fire', {
            path: decision.releasedByTerminalBlockHardCap
                ? 'terminal_block_hard_cap'
                : decision.decoupledImmediateEmit ? 'canon_c_decoupled' : 'forced_timeout',
            blockReason,
            latestVisibleStatus,
            approvalResolvedIdle: pending.previousStatus === 'waiting_approval',
            finalAssistantPresent: (completionDiagnostic as any).finalAssistantPresent === true,
            evidenceSource: (completionDiagnostic as any).finalAssistantEvidenceSource ?? null,
            lastVisibleRole: (completionDiagnostic as any).lastVisibleRole ?? null,
            lastVisibleContentLen: (completionDiagnostic as any).lastVisibleContentLength ?? null,
            emittedAfterFinalizationTimeout,
            waitedMs,
            busyEpoch: host.busyEpoch,
        });
        // finalSummary provenance chain unchanged (see snapshotExternalNativeCompletionSummary /
        // completionFinalSummary / cachedInTurnCompletionSummaryContent docs above).
        // (SUMMARY-SCRAPE-FALLBACK, part B) Resolved into a local FIRST so the provenance
        // completionFinalSummary just recorded can be stamped onto the diagnostic below —
        // reading it before the chain runs would stamp the previous turn's source.
        const weakFinalSummary = (host.nativeTurnTerminalSummary(pending.turnStartedAt)
            || host.snapshotExternalNativeCompletionSummary(pending)
            || host.completionFinalSummary(host.adapter?.getScriptParsedStatus()?.messages, pending.turnStartedAt)
            || host.cachedInTurnCompletionSummaryContent(pending.turnStartedAt)
            || (blockReason.startsWith('parsed_status:') ? '' : undefined));
        Object.assign(
            completionDiagnostic as Record<string, unknown>,
            host.finalSummaryProvenanceDiagnostic(weakFinalSummary),
        );
        host.emitGeneratingCompleted({
            chatTitle: pending.chatTitle,
            duration: pending.duration,
            timestamp: pending.timestamp,
            taskId: pending.taskId,
            finalSummary: weakFinalSummary,
            completionDiagnostic,
        });
        host.completedDebouncePending = null;
        host.completedDebounceTimer = null;
        // (CANCEL-BLIP-ORPHAN) This turn's completion is out; any watch owed for it is
        // settled. Leaving it armed would let a stale recheck re-arm a duplicate.
        host.clearCancelledCompletionRecheck();
        host.generatingStartedAt = 0;
        host.lastApprovalEventFingerprint = '';
        host.markCurrentTurnStartupGraceCollapseSatisfied();
        return;
    }

    // emit-genuine: the clean path — transcript finalized, evidence stashed on pending.
    LOG.info('CLI', `[${host.type}] completed in ${pending.duration}s`);
    if (host.isMeshWorkerSession()) {
        traceMeshEventStage('fired', host.meshTraceCtx(), `duration=${pending.duration}s`);
    }
    if (host.completionTraceOn()) host.recordCompletionGateTrace('fire', {
        path: 'clean',
        latestVisibleStatus,
        approvalResolvedIdle: pending.previousStatus === 'waiting_approval',
        finalAssistantPresent: true,
        duration: pending.duration,
        busyEpoch: host.busyEpoch,
    });
    const finalSummary = host.cleanCompletionFinalSummary(pending);
    const transcriptProfile = resolveTranscriptAuthorityProfile(host.provider);
    const finalContentLength = typeof finalSummary === 'string' ? finalSummary.trim().length : 0;
    host.emitGeneratingCompleted({
        chatTitle: pending.chatTitle,
        duration: pending.duration,
        timestamp: pending.timestamp,
        taskId: pending.taskId,
        finalSummary,
        evidenceLevel: 'reported',
        completionDiagnostic: {
            source: 'clean_final_assistant',
            cleanPath: true,
            evidenceWeak: false,
            finalAssistantPresent: true,
            finalAssistantEvidenceSource: pending.resolvedFinalEvidenceSource ?? 'parsed',
            finalAssistantContentLength: finalContentLength,
            ...host.finalSummaryProvenanceDiagnostic(finalSummary),
            transcriptEvidence: {
                version: 1,
                kind: 'final_assistant',
                cleanPath: true,
                weak: false,
                authorityClass: transcriptProfile.class,
                timing: transcriptProfile.timing,
                providerOwnsTranscript: transcriptProfile.providerOwnsTranscript,
                observedAt: pending.resolvedFinalEvidenceObservedAt ?? Date.now(),
                turnStartedAt: pending.turnStartedAt ?? null,
                finalContentLength,
                taskId: pending.taskId ?? null,
                attemptId: typeof host.settings.meshActiveAttemptId === 'string'
                    ? host.settings.meshActiveAttemptId : null,
                dispatchNonce: typeof host.settings.meshActiveDispatchNonce === 'number'
                    ? host.settings.meshActiveDispatchNonce : null,
                sessionId: host.instanceId,
            },
        },
    });
    host.completedDebouncePending = null;
    host.completedDebounceTimer = null;
    // (CANCEL-BLIP-ORPHAN) Completion delivered — settle any outstanding watch.
    host.clearCancelledCompletionRecheck();
    host.generatingStartedAt = 0;
    host.lastApprovalEventFingerprint = '';
    host.markCurrentTurnStartupGraceCollapseSatisfied();
}

/** The narrow surface of CliProviderInstance the completion emit reads/writes. */
export interface CompletionEmitHost {
    instanceId: string;
    settings: Record<string, any>;
    busyEpoch: number;
    lastCompletionSummary: { content: string; receivedAt: number; sourceTimestampMs?: number } | null;
    lastEmittedCompletion: { taskId: string; at: number; evidenceLevel?: string; weak: boolean; emittedAtEpoch: number } | null;
    pushEvent(event: any): void;
    updateSettings(newSettings: Record<string, any>): void;
    /** Turn-evidence port (wiring-unification C5/C-W5). Null until boot wires it. */
    turnEvidencePort?: TurnEvidencePort | null;
    /** Live attempt ref for this session, if the mesh assignment attached one. */
    currentAttemptRef?(): TurnAttemptRef | null;
}

export function emitGeneratingCompleted(host: CompletionEmitHost, opts: {
    chatTitle: string;
    duration: number | undefined;
    timestamp: number;
    taskId?: string;
    finalSummary?: string;
    evidenceLevel?: string;
    completionDiagnostic?: Record<string, unknown>;
}): void {
    // Cache the final assistant summary so the dashboard snapshot can surface it
    // for native-source providers whose assistant answer is absent from the PTY
    // parse (antigravity). completionFinalSummary already read native-history to
    // produce this, so nothing extra is read here.
    const summary = typeof opts.finalSummary === 'string' ? opts.finalSummary.trim() : '';
    if (summary) {
        host.lastCompletionSummary = { content: summary, receivedAt: opts.timestamp };
    }
    // Classification input only (NOT pushed to the wire — C-W5c deleted the
    // legacy `agent:generating_completed` construction; `isWeakCompletionEvidence`
    // just needs the same shape it always read).
    const completionEvidenceInput = {
        chatTitle: opts.chatTitle,
        duration: opts.duration,
        timestamp: opts.timestamp,
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        finalSummary: opts.finalSummary,
        ...(opts.evidenceLevel !== undefined ? { evidenceLevel: opts.evidenceLevel } : {}),
        ...(opts.completionDiagnostic !== undefined ? { completionDiagnostic: opts.completionDiagnostic } : {}),
    };
    // KIMI-MESH-COMPLETION-EMIT (axis 2, double-emit guard): record that THIS turn's
    // completion has now been emitted, keyed by its taskId, so the pre-cleanup
    // completion flush never fires a duplicate for the same turn.
    //
    // COMPLETION-WEAK-REARM (fix1): stamp the emit's evidence STRENGTH so the three
    // transcript re-emit guards can distinguish a weak first emit (which must be
    // re-armable once a genuine idle lands) from a genuine one (single-shot). The
    // weakness is read from the exact event being pushed — evidenceLevel plus the
    // completionDiagnostic (missing_final_assistant blockReason) — via the same
    // isWeakCompletionEvidence() the coordinator/ledger paths share, so the worker's
    // notion of "weak" cannot drift from theirs. emittedAtEpoch snapshots busyEpoch so
    // a re-arm requires a real generating→idle transition after this emit.
    const weak = isWeakCompletionEvidence(completionEvidenceInput as Record<string, unknown>);
    host.lastEmittedCompletion = {
        taskId: typeof opts.taskId === 'string' ? opts.taskId : '',
        at: Date.now(),
        evidenceLevel: opts.evidenceLevel,
        weak,
        emittedAtEpoch: host.busyEpoch,
    };
    // Turn-evidence (C5/C-W5/C-W5c): the SOLE chokepoint (wiring-unification
    // §5 C5). EVERY provider verdict site in status-transition.ts /
    // completion-flush.ts / stall-rescue.ts that used to decide "genuine ⇒
    // done" locally now only calls this function with the fields it
    // observed — `strength` stays on the evidence, but the reducer in
    // mesh/turn-ledger/ (R9) is what turns "genuine" into a commit. This
    // function itself computes NO verdict: it reuses the SAME
    // `isWeakCompletionEvidence` classification already computed above for
    // `lastEmittedCompletion.weak`, so the evidence's `strength` can never
    // disagree with the dropped wire event's own weakness.
    //
    // `envelope` carries the local render context (final summary, node/
    // provider identity, review flag, completion metadata) that used to ride
    // ONLY the deleted `agent:generating_completed` wire event — the port
    // (`turn-evidence-port.ts`) either stores it locally (this daemon owns
    // the attempt — the common case) or publishes it to `mesh.<id>.handoff`
    // and swaps in the returned `SummaryRef` (a remote-owned worker), so
    // `renderNotice` (turn-ledger/deliver.ts) reproduces the exact same
    // coordinator text that used to come from `buildProviderEvidence`.
    if (host.turnEvidencePort) {
        emitTurnEnd(host.turnEvidencePort, {
            sessionId: host.instanceId,
            observedBy: 'cli_completion_flush',
            source: weak ? 'completion_flush_weak' : 'completion_flush_genuine',
            attemptRef: host.currentAttemptRef?.() ?? undefined,
            taskId: opts.taskId,
            at: opts.timestamp,
            strength: weak ? 'weak' : 'genuine',
            blockReason: asTurnEndBlockReason(opts.completionDiagnostic?.blockReason),
            releasedByHardCap: opts.completionDiagnostic?.releasedByTerminalBlockHardCap === true ? true : undefined,
            afterFinalizationTimeout: opts.completionDiagnostic?.emittedAfterFinalizationTimeout === true ? true : undefined,
            // A provider's own turn-terminal record (stall-rescue's wedge/idle
            // native-marker reconcile) — `turn_end`'s closed `nativeOutcome`
            // enum, never a free-text passthrough.
            nativeOutcome: asNativeTurnOutcome(opts.completionDiagnostic?.nativeTurnOutcome),
            // `nodeLabel` is intentionally omitted — `turn-ledger/deliver.ts`'s
            // `nodeLabelFor` already falls back to the attempt's own
            // `nodeId`/`providerType` (dispatch-time facts the ledger has),
            // which is the same information this host has access to, so
            // there is nothing this call site can add.
            //
            // `workerResult`: the graph output envelope's structured pointer
            // target (`envelope.worker_result`, `mesh-graph-transition-runner.ts`
            // `applyTaskTerminalInTxn`, fed by `runtime-ledger.ts`'s
            // `graphAdvance` from `ctx.envelope`). Parsed with the SAME
            // trailing-JSON-in-the-final-summary rule the ledger evidence
            // record has always used (`shared/worker-result-parse.ts`, moved
            // out of `mesh/mesh-ledger.ts` in C-W5c so this producers-side
            // call site can use it without a `providers -> mesh` boundary
            // violation) — without it `envelope.worker_result` is empty for
            // every locally-completed task and documented pointers like
            // `/worker_result/validationResults` resolve to nothing.
            envelope: {
                ...(opts.finalSummary ? { finalSummary: opts.finalSummary } : {}),
                ...(() => {
                    const workerResult = opts.finalSummary ? extractJsonObjectFromSummary(opts.finalSummary) : undefined;
                    return workerResult ? { workerResult } : {};
                })(),
                ...((typeof opts.completionDiagnostic?.reason === 'string'
                    || typeof opts.completionDiagnostic?.blockReason === 'string'
                    || typeof opts.completionDiagnostic?.finalAssistantPresent === 'boolean'
                    || opts.evidenceLevel
                    || typeof opts.completionDiagnostic?.source === 'string'
                    || typeof opts.completionDiagnostic?.wedgedObservedStatus === 'string'
                    || typeof opts.completionDiagnostic?.nativeTurnId === 'string') ? {
                    notice: {
                        completionMetadata: {
                            ...(typeof opts.completionDiagnostic?.reason === 'string' ? { diagnosticReason: opts.completionDiagnostic.reason } : {}),
                            // `blockReason` here is the FULL diagnostic vocabulary
                            // (e.g. 'parsed_final_assistant_quiet_dwell') — much
                            // wider than `asTurnEndBlockReason`'s closed 4-value
                            // evidence enum above, so it rides local text too
                            // (never silently dropped just because it didn't
                            // narrow into the typed field).
                            ...(typeof opts.completionDiagnostic?.blockReason === 'string' && !asTurnEndBlockReason(opts.completionDiagnostic.blockReason)
                                ? { diagnosticReason: opts.completionDiagnostic.blockReason } : {}),
                            ...(typeof opts.completionDiagnostic?.finalAssistantPresent === 'boolean'
                                ? { finalAssistantPresent: opts.completionDiagnostic.finalAssistantPresent } : {}),
                            ...(opts.evidenceLevel ? { evidenceLevel: opts.evidenceLevel } : {}),
                            // Diagnostic-only strings (which producer path fired,
                            // the wedge's observed status, the provider's own
                            // native turn id) — local render context, same
                            // treatment the deleted wire literal gave them.
                            ...(typeof opts.completionDiagnostic?.source === 'string' ? { source: opts.completionDiagnostic.source } : {}),
                            ...(typeof opts.completionDiagnostic?.wedgedObservedStatus === 'string' ? { wedgedObservedStatus: opts.completionDiagnostic.wedgedObservedStatus } : {}),
                            ...(typeof opts.completionDiagnostic?.nativeTurnId === 'string' ? { nativeTurnId: opts.completionDiagnostic.nativeTurnId } : {}),
                        },
                    },
                } : {}),
            },
        });
    }
    // COORDINATOR-SILENT-IDLE one-shot consume: this completion's snapshot rides the
    // armed mute (resolveMuted honors settings.silentNextIdlePush for the idle status
    // above), so the routine idle push is suppressed for THIS completion only. Clear
    // the arm now — AFTER the completion event was pushed — so the NEXT turn notifies
    // normally. Redundant with the TTL leak-guard, but the deterministic clear is the
    // primary one-shot mechanism; the TTL only covers a worker that never completes.
    if (host.settings?.silentNextIdlePush === true) {
        host.updateSettings({ silentNextIdlePush: undefined, silentNextIdlePushArmedAt: undefined });
    }
}
