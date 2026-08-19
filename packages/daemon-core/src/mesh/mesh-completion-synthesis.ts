// ---------------------------------------------------------------------------
// mesh-completion-synthesis — PHASE-4 transcript completion synth + PHASE-5 auto-prune
// ---------------------------------------------------------------------------
// Extracted from mesh-reconcile-loop.ts (A-3 god-module decomposition, pure move,
// no behavior change). This is the reconcile loop's completion-synthesis core:
// for every active (non-terminal) direct dispatch this daemon hosts, confirm the
// worker session is idle and — when a final assistant summary exists but no
// terminal ledger does — synthesize the missing completion (the acked-hold /
// death-backstop / fast-track machinery lives here). PHASE-5 auto-prune of orphaned
// dispatch records rides along, sharing the same live-session probe transports.
//
// Depends on mesh-remote-event-pull.ts for the P2P read/probe helpers
// (unwrapReadChatPayload, readChatPayloadStatus, reprobeWorkerStatus,
// realTerminalEmitPendingForTask, collectLiveNodesWithSessions). The reconcile
// loop imports reconcileUnterminatedDirectDispatches + autoPruneStaleDirectDispatches.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { LOG } from '../logging/logger.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { traceMeshEventDrop, traceMeshEventStage } from './mesh-event-trace.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { daemonIdListIncludes } from './mesh-reconcile-identity.js';
import { getActiveDirectDispatches, getQueue } from './mesh-work-queue.js';
import { readLedgerEntriesByKind } from './mesh-ledger.js';
import { pruneStaleDirectDispatches } from './mesh-active-work.js';
import { reconcileDirectDispatchCompletionFromTranscript, resolveLiveTurnPendingEvidence } from './mesh-events-stale.js';
import { extractFinalAssistantSummaryEvidence, hasTrailingToolActivityAfterFinalAssistant, countTrailingToolActivityAfterFinalAssistant, selectFinalAssistantTurnEndMessage, readChatMessageTimestampMs } from '../providers/chat-message-normalization.js';
import { hasNonEmptyModalButtons } from '../commands/read-chat-presentation.js';
import { providerHasNativeTurnSignal } from '../chat/native-turn-signal.js';
import type { NativeTurnTerminalMarker } from '../chat/native-turn-signal.js';
import { evaluateTerminalAdmission, TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS } from './mesh-terminal-admission.js';
import { runSessionEvidenceCollection, resolveTaskEvidenceSessionId } from './mesh-turn-ledger.js';
import type { ChatMessage } from '../types.js';
import {
    getMeshV2BackstopCounters,
    recordBackstopFire,
} from './mesh-reconcile-v2-backstop.js';
import {
    ACKED_DEATH_CONSECUTIVE_READ_FAILURES,
    resolveAckedDeathDeadlineMs,
    resolveAckedTranscriptFastTrackGraceMs,
    inFlightSynthKey,
    getHoldState,
    setHoldState,
    deleteHoldState,
    rehydrateAckedHoldsForMesh,
    collectHeldSynthKeysForMesh,
} from './mesh-reconcile-acked-hold.js';
import {
    unwrapReadChatPayload,
    readChatPayloadStatus,
    readChatPayloadProviderObservedStatus,
    reprobeWorkerStatus,
    realTerminalEmitPendingForTask,
    collectLiveNodesWithSessions,
} from './mesh-remote-event-pull.js';

/**
 * Newest transcript bubble of ANY kind (epoch ms), or undefined when nothing in the
 * tail carries a usable timestamp.
 *
 * This is the freshness probe behind admission rule 6 (transcript_growing). Shared by
 * BOTH producers in this file — the acked-hold/death-deadline synth and the terminal
 * poll — because the whole point of item 3 is that the two must answer the "is the tail
 * still moving?" question the same way. Undefined means "could not observe", which by
 * construction never manufactures a veto at either call site.
 */
function readNewestChatActivityAtMs(messages: ChatMessage[]): number | undefined {
    let newest: number | undefined;
    for (const msg of messages) {
        const ts = readChatMessageTimestampMs(msg);
        if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
        if (newest === undefined || ts > newest) newest = ts;
    }
    return newest;
}

// ---------------------------------------------------------------------------
// NON-IDLE-ESCAPE-AS-WEAK-CANDIDATE (2026-08-18 false-completion fix)
// ---------------------------------------------------------------------------
// Verified incidents (kimi a3dc0a3e, grok b01e5a01): the old PHASE-4 non-idle
// escape synthesized a COMPLETED terminal off a `generating` live probe the
// moment the acked death deadline expired — 13s after dispatch the worker had
// only emitted its "on it" preamble, and it then kept working for another 39
// minutes under a false completion. A TIMEOUT IS NEVER COMPLETION EVIDENCE
// (mesh-terminal-admission.ts header): the only honest outcomes for a worker
// whose live probe still reads `generating` are hold / reclaim / fail.
//
// The escape therefore no longer synthesizes anything. While the read says
// `generating` it tracks whether the transcript tail is STILL MOVING — the
// same "PTY quiet but transcript advancing" axis the stall watchdog already
// observes (mesh-stall-watchdog TX-FSM Stage 1, msgCount growth), mirrored
// here through the reconcile loop's OWN read_chat tail so pure-PTY providers
// (kimi — the incident provider, which has no native-source signal at all)
// are covered identically:
//   - tail fingerprint CHANGED since the last tick → the worker is alive and
//     mid-turn: the escape anchor RE-ARMS (death-deadline reset), so a slow
//     worker can never age into the deadline while it is producing.
//   - tail fingerprint STATIC for a full death-deadline window → the
//     floor-class wedge the escape was built for: record a WEAK CANDIDATE
//     (WARN + trace, observable in the ledger trace stream) and KEEP HOLDING.
//     No terminal ledger, no queue/dispatch flip, no coordinator completion.
//     Recovery stays with the nets that own a wedged row: the session-death
//     read-failure backstop, the stranded-dispatch reclaim, the orphan prune.
// Process-local by design: a restart simply re-anchors (one more deadline
// window of observed stillness before the candidate is re-recorded) — losing
// the track can only DELAY a candidate record, never fabricate one.
interface NonIdleEscapeTrack {
    /** Wall-clock when the current continuous static-tail run began. */
    anchorMs: number;
    /** Fingerprint of the tail seen at anchor time (movement detector). */
    tailFingerprint: string;
    /** Candidate already recorded for this anchor (log/trace once, not per tick). */
    candidateRecorded: boolean;
}
const nonIdleEscapeTracks = new Map<string, NonIdleEscapeTrack>();

/**
 * Change detector over the (tail-limited) read_chat messages. With tailLimit
 * the COUNT is pinned, so movement is detected from per-bubble
 * role/timestamp/content-length — any slide of the window, new bubble, or
 * streaming growth flips the fingerprint. Cheap: the tail is ~10 bubbles.
 */
function escapeTailFingerprint(messages: ChatMessage[]): string {
    let fp = '';
    for (const msg of messages) {
        if (!msg) continue;
        const ts = readChatMessageTimestampMs(msg) ?? 0;
        let len = -1;
        try { len = JSON.stringify(msg.content)?.length ?? -1; } catch { /* keep -1 */ }
        fp += `${msg.role}:${ts}:${len};`;
    }
    return fp;
}

/** Test hook: clear the non-idle escape tracks between cases. */
export function __resetNonIdleEscapeTracksForTests(): void {
    nonIdleEscapeTracks.clear();
}

/** Test hook: inspect a task's non-idle escape track (weak-candidate observability). */
export function __peekNonIdleEscapeTrackForTests(meshId: string, taskId: string): NonIdleEscapeTrack | undefined {
    return nonIdleEscapeTracks.get(inFlightSynthKey(meshId, taskId));
}

// PHASE 4 helper. For every active (non-terminal) direct dispatch this daemon
// hosts, confirm the worker session is idle via a read_chat and — if a final
// assistant summary is present but no terminal ledger exists for that dispatch —
// synthesize the missing completion through reconcileDirectDispatchCompletionFromTranscript.
//
// read_chat is resolved against the target node: a node on THIS daemon is read
// through the local commandHandler; a remote node is read over P2P via
// dispatchMeshCommand. Both yield the same { messages, status, providerSessionId }
// shape. We only synthesize when the session reports idle AND a final assistant
// message exists — the same evidence bar the MCP poll path uses — so an actively
// generating worker is never falsely completed. The reconcile itself is idempotent.
export async function reconcileUnterminatedDirectDispatches(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
): Promise<void> {
    const dispatches = getActiveDirectDispatches(mesh.id);

    // T2 (B2b): restart rehydration. Reload this mesh's persisted acked-hold rows into
    // the Map cache the first time this process touches the mesh — a hold established
    // before a daemon restart is honored again. Must run BEFORE the prune below so a
    // rehydrated hold for a still-active task is not seen as absent-from-cache and lost.
    rehydrateAckedHoldsForMesh(mesh.id);

    // Prune the in-flight acked-hold state to the tasks still active in THIS mesh, so a
    // completed/pruned task's state is dropped (both the Map cache AND the store row —
    // the persisted table never grows without bound). Runs even when there are zero
    // active dispatches so a restart that landed after every task terminated still
    // reaps orphaned store rows. Iterate the union of Map keys and store rows so a row
    // that exists ONLY on disk (not yet cached) is pruned too.
    const activeTaskKeys = new Set(
        dispatches
            .map(d => readNonEmptyString(d.taskId))
            .filter(Boolean)
            .map(taskId => inFlightSynthKey(mesh.id, taskId)),
    );
    const heldKeys = collectHeldSynthKeysForMesh(mesh.id);
    for (const key of heldKeys) {
        if (!activeTaskKeys.has(key)) deleteHoldState(key, mesh.id);
    }
    // Same prune for the process-local non-idle escape tracks: a task that left
    // the active set never re-fires its candidate record.
    for (const key of [...nonIdleEscapeTracks.keys()]) {
        if (key.startsWith(`${mesh.id}::`) && !activeTaskKeys.has(key)) nonIdleEscapeTracks.delete(key);
    }

    if (dispatches.length === 0) return; // nothing left to reconcile after the prune

    const dispatchMeshCommand = components.dispatchMeshCommand;
    const nodeById = new Map(mesh.nodes.map(n => [n.id, n] as const));

    for (const dispatch of dispatches) {
        const sessionId = readNonEmptyString(dispatch.sessionId);
        const nodeId = readNonEmptyString(dispatch.nodeId);
        const taskId = readNonEmptyString(dispatch.taskId);
        if (!sessionId || !nodeId || !taskId) continue;

        const node = nodeById.get(nodeId);
        const nodeDaemonId = readNonEmptyString(node?.daemonId);
        // A node is local when it has no daemonId, names this daemon, or actually
        // has a live instance here. Anything else is reached over P2P.
        const isLocalNode = !nodeDaemonId
            || daemonIdListIncludes(selfIds, nodeDaemonId)
            || daemonIdsEquivalent(nodeDaemonId, localDaemonId)
            || !!components.instanceManager.getInstance(sessionId);

        const providerType = readNonEmptyString(dispatch.providerType);
        const readArgs: Record<string, unknown> = {
            sessionId,
            targetSessionId: sessionId,
            tailLimit: 10,
            ...(node?.workspace ? { workspace: node.workspace } : {}),
            ...(providerType ? { agentType: providerType, providerType } : {}),
        };

        const synthKey = inFlightSynthKey(mesh.id, taskId);
        const isAcked = dispatch.status === 'acked';
        // T6: which last-resort backstop (if any) drove this synth. Set when the
        // acked-hold fast-track / death-deadline promotes the synth; the counter is
        // bumped only if the synth actually COMMITS (result.reconciled), so a
        // deferred/re-probed-away synth is not miscounted. A never-acked dispatch
        // that reaches the commit is a plain PHASE-4 transcript synthesis.
        let backstopKind: keyof ReturnType<typeof getMeshV2BackstopCounters> | undefined;

        // R4f: read the worker session. A FAILED read (transport error / success:false / no payload)
        // is no longer silently swallowed for an acked task — it is the liveness side of the
        // death backstop (a). We classify the read result and route an acked failure into the
        // failure counter; a never-acked (or non-acked) failure keeps the old best-effort `continue`.
        let payload: Record<string, unknown> | null = null;
        let readFailed = false;
        try {
            if (isLocalNode) {
                const result = await components.commandHandler.handle('read_chat', readArgs);
                if (result && (result as { success?: boolean }).success === false) {
                    readFailed = true;
                } else {
                    payload = unwrapReadChatPayload(result);
                }
            } else if (dispatchMeshCommand) {
                const result = await dispatchMeshCommand(nodeDaemonId, 'read_chat', readArgs);
                payload = unwrapReadChatPayload(result);
                if (payload && (payload as { success?: boolean }).success === false) { payload = null; readFailed = true; }
            } else {
                continue; // remote node but no P2P transport — can't read; retry next tick (not a death signal)
            }
        } catch {
            readFailed = true; // session may be gone or node offline
        }
        if (!payload && !readFailed) continue; // null payload that wasn't a hard failure — retry next tick

        if (readFailed || !payload) {
            // R4f backstop (a) — liveness failure. For a never-acked dispatch there is no in-flight
            // turn to protect, so a read failure is a transient probe blip → retry next tick (old
            // behavior). For an ACKED dispatch that we had previously confirmed live, a streak of
            // consecutive read failures means the worker session genuinely went away mid-turn and
            // will never emit its real completion — count it. The actual terminal cleanup of a
            // gone session is owned by PHASE 2.5 (stranded reclaim) / PHASE 5 (orphan prune); here
            // we only record the death observation and STOP holding so those nets can take over,
            // rather than pinning the row on an indefinite hold for a session that is already gone.
            if (isAcked) {
                const prior = getHoldState(synthKey, mesh.id);
                const failures = (prior?.consecutiveReadFailures ?? 0) + 1;
                const liveConfirmedSinceAck = prior?.liveConfirmedSinceAck ?? false;
                // A read failure breaks the idle-with-final-assistant run → reset the fast-track streak
                // (transcriptIdleSinceMs cleared by omission) so it must re-accumulate from scratch.
                setHoldState(synthKey, mesh.id, { liveConfirmedSinceAck, consecutiveReadFailures: failures });
                if (liveConfirmedSinceAck && failures >= ACKED_DEATH_CONSECUTIVE_READ_FAILURES) {
                    LOG.warn('MeshReconcile', `Acked-hold death signal: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read_chat failed ${failures}x consecutively after a live-confirmed ack — worker session presumed gone mid-turn; releasing the indefinite synth hold to the stranded-reclaim / orphan-prune nets`);
                }
            }
            continue; // no readable transcript this tick → cannot synth here; retry / let backstops act
        }

        // Read succeeded (a conclusive idle/generating status) → the session is reachable: reset the
        // failure streak and mark it live-confirmed-since-ack, so a LATER read failure is recognized
        // as a genuine liveness loss (backstop a) rather than a node that was never reachable. The
        // fast-track idle streak (transcriptIdleSinceMs) is PRESERVED across this reset — it is
        // managed below where the idle + final-assistant signal is actually evaluated.
        const priorHoldState = getHoldState(synthKey, mesh.id);
        setHoldState(synthKey, mesh.id, {
            liveConfirmedSinceAck: true,
            consecutiveReadFailures: 0,
            ...(priorHoldState?.transcriptIdleSinceMs !== undefined ? { transcriptIdleSinceMs: priorHoldState.transcriptIdleSinceMs } : {}),
        });

        // Only act on a session that has actually settled to idle. A generating /
        // waiting_approval session is mid-turn — synthesizing a completion now would
        // be wrong. (idle is the only status the MCP poll path reconciles too.)
        //
        // FLOOR-COMPLETION-NON-IDLE-ESCAPE → WEAK CANDIDATE ONLY (2026-08-18 fix).
        // The pre-fix escape SYNTHESIZED a completion past the death deadline off a
        // `generating` read (boundedBackstop overrode the live-pending veto) — the
        // direct cause of two same-day false completions (a3dc0a3e/b01e5a01), where
        // the 480s deadline fired on a worker that then kept working for 39 minutes.
        // A timeout is never completion evidence: while the live probe reads
        // `generating` the escape can only record a WEAK CANDIDATE and HOLD — the
        // transcript-advancing axis (tail fingerprint movement, the same signal the
        // stall watchdog's TX-FSM Stage 1 observes) RE-ARMS the deadline anchor on
        // every movement, so a slow-but-alive worker never ages into the deadline,
        // and a genuinely wedged floor-class session (static tail for a full
        // deadline window) is surfaced as a candidate for the hold/reclaim nets
        // instead of being stamped `completed`.
        const nowMs = Date.now();
        if (readChatPayloadStatus(payload) !== 'idle') {
            if (isAcked && readChatPayloadStatus(payload) === 'generating') {
                // Only an ACKed (consumed) attempt qualifies — a never-acked
                // dispatch has no in-flight turn to track. Only `generating`
                // qualifies — waiting_approval / waiting_choice / anything else
                // is a genuinely BLOCKED worker (no candidacy to record).
                const escapeMessages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
                const fingerprint = escapeTailFingerprint(escapeMessages);
                const prior = nonIdleEscapeTracks.get(synthKey);
                if (!prior || prior.tailFingerprint !== fingerprint) {
                    // Transcript advancing (or first observation): the worker is
                    // alive — RE-ARM the escape anchor. This is the death-deadline
                    // reset wired to the transcript-advancing signal.
                    nonIdleEscapeTracks.set(synthKey, { anchorMs: nowMs, tailFingerprint: fingerprint, candidateRecorded: false });
                    if (prior) {
                        LOG.info('MeshReconcile', `Non-idle escape re-armed: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) reads 'generating' and its transcript tail moved — worker is alive mid-turn; the escape deadline restarts from now`);
                    }
                } else {
                    const staticMs = nowMs - prior.anchorMs;
                    if (staticMs >= resolveAckedDeathDeadlineMs() && !prior.candidateRecorded) {
                        // Genuinely wedged (static tail for a full deadline window
                        // while reading `generating`): record the WEAK CANDIDATE —
                        // observable, never terminal. The row stays held for the
                        // session-death / stranded-reclaim / orphan-prune nets.
                        prior.candidateRecorded = true;
                        const candidateEvidence = extractFinalAssistantSummaryEvidence(escapeMessages);
                        LOG.warn('MeshReconcile', `Non-idle escape WEAK CANDIDATE (no completion): task ${taskId} on node ${nodeId} (mesh ${mesh.id}) has read 'generating' with a static transcript tail for ${Math.round(staticMs / 1000)}s (deadline ${Math.round(resolveAckedDeathDeadlineMs() / 1000)}s)${candidateEvidence.finalSummary ? ' and a final-looking assistant bubble' : ''} — recorded as a weak candidate only; NOT completed (a timeout is never completion evidence); the hold/reclaim nets own the terminal`);
                        traceMeshEventDrop('non_idle_escape_weak_candidate_held', {
                            taskId, sessionId, nodeId, meshId: mesh.id, event: 'agent:generating_completed',
                        }, `staticTailMs=${staticMs} finalAssistant=${candidateEvidence.finalSummary ? 'present' : 'absent'} transcriptAt=${candidateEvidence.transcriptMessageAt ?? 'n/a'}`);
                    }
                }
            }
            // Not idle → the worker is genuinely mid-turn (a clear live signal). Keep the
            // live-confirmed flag set (above) but RESET the fast-track idle streak: a turn that
            // resumed generating proves the prior idle was a mid-turn blip, not a settled turn-end.
            setHoldState(synthKey, mesh.id, { liveConfirmedSinceAck: true, consecutiveReadFailures: 0 });
            continue;
        }

        // R4f GENERATING-BOUNDARY (acked-hold): a dispatch whose worker was OBSERVED to start
        // generating (the agent:generating_started ack flipped the row to 'acked') is ALIVE and
        // mid-turn — it WILL eventually emit a real terminal. An `idle` read here is therefore
        // presumed a TRANSIENT mid-turn window (a PTY inter-tool-call settle, or final text already
        // rendered while the lifecycle close lags), NOT a settled completion. We HOLD the synth
        // INDEFINITELY rather than racing the worker's (variable, unbounded) emit latency with a
        // finite timer — the failure mode of R4..R4e. This is safe: when the worker's real emit
        // lands it writes a terminal ledger, and reconcileDirectDispatchCompletionFromTranscript's
        // hasTerminalLedgerAfterDispatch makes any later synth an idempotent no-op, so the real emit
        // always wins no matter how late. The hold is released ONLY by the death backstops:
        //   (a) consecutive read failures after a live-confirmed ack (handled above), or
        //   (b) the absolute ACKED_DEATH_DEADLINE_MS since the ack — a notification-loss net set FAR
        //       above any observed emit latency, so it catches a genuinely-wedged worker / lost emit
        //       without racing a normal slow turn.
        // A never-acked dispatch (worker never started) is exempt — no in-flight generation to
        // pre-empt; it keeps the first-idle-tick synth, with the downstream grace + stale-summary
        // guards as its backstops.
        //
        // ACKED-HOLD-IDLE-OVERTRUST: the read is idle. Extract the final-assistant evidence NOW (the
        // same signal the synth below requires) so the fast-track can gate on idle-WITH-final-assistant
        // rather than bare idle. Only when a final visible assistant message is present do we treat
        // this tick as a candidate turn-end and accumulate the fast-track grace streak; a bare idle
        // with no assistant result is the worker still warming up and resets the streak.
        const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
        // INSTANT-ACK guard (P3): hand the selector this task's dispatch boundary so a
        // seconds-fresh acknowledgment bubble ("on it…", the a3dc0a3e shape) is not a
        // turn-end candidate. The parse is duplicated at the stale-summary guard below —
        // a NaN boundary simply disables the guard (undated dispatch row).
        const dispatchedAtMs = Date.parse(readNonEmptyString(dispatch.dispatchedAt));
        const evidence = extractFinalAssistantSummaryEvidence(messages, undefined,
            Number.isFinite(dispatchedAtMs) ? { turnStartedAtMs: dispatchedAtMs } : undefined);

        // MID-TURN-CAUSAL-ADMISSION (rc.16, trailing-tool veto): the latest final-LOOKING
        // assistant bubble is followed by tool/terminal activity — the worker emitted interim
        // narration ("Let me find…") and is still running tools; the bubble is a preamble,
        // not a turn end. This is the exact false-completion shape of the verified incidents
        // (weak synth after an interim progress sentence while tools continued), and PHASE 4
        // previously never ran the veto pollAssignedTaskTerminalEvidence has. The veto applies
        // to EVERY synth path below — never-acked first-idle, acked fast-track, AND the death
        // deadline: a stale weak interim summary must not become final merely because a
        // timeout fired while newer transcript/tool activity exists. The fast-track streak is
        // reset so the continuous idle-with-final-assistant run must restart from the genuine
        // final bubble. This cannot wedge: the next tick re-reads and re-evaluates (a genuine
        // final assistant lands AFTER the last tool call, completing one tick later), and the
        // hold is still released by the session-death read-failure backstop / stranded-reclaim
        // / orphan-prune nets if the worker truly goes away.
        if (hasTrailingToolActivityAfterFinalAssistant(messages)) {
            setHoldState(synthKey, mesh.id, { liveConfirmedSinceAck: true, consecutiveReadFailures: 0 });
            LOG.info('MeshReconcile', `Mid-turn causal admission: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) — the latest final-looking assistant bubble is followed by trailing tool/terminal activity (interim narration; the turn is still executing); holding the transcript synth`);
            traceMeshEventDrop('reconcile_synth_veto_trailing_tool_activity', {
                taskId, sessionId, nodeId, meshId: mesh.id, event: 'agent:generating_completed',
            });
            continue;
        }

        // TERMINAL-ADMISSION-ALL-PATHS (item 3): FAIL-OPEN/FAIL-CLOSED SYMMETRY.
        //
        // The asymmetry this fixes lived inside this one file. The transcript POLL
        // (pollAssignedTaskTerminalEvidence, below) refuses to complete a tail that is
        // still MOVING — admission rule 6, the transcript_growing veto. This synth path
        // had no equivalent: it vetoed trailing TOOL bubbles (just above) but was blind
        // to a transcript that is simply still growing, so the same evidence that is
        // fail-CLOSED for the poll was fail-OPEN for the synth. That gap matters most at
        // the death deadline, which is exactly where a synth is most likely to fire on a
        // worker that is slow rather than dead.
        //
        // Aligned here, on the SAME constant and the SAME freshness question, and placed
        // beside the trailing-tool veto so it likewise covers EVERY synth path —
        // never-acked first-idle, acked fast-track, and the death deadline.
        //
        // ★ WHAT THIS DELIBERATELY DOES NOT DO — the reclaim path stays alive.
        // This veto refuses to manufacture a COMPLETION off a moving tail. It does not,
        // and must not, disable RECOVERY of a genuinely dead session. The distinction the
        // admission module draws (a timeout is never completion evidence, but recovery is
        // still owed) is preserved exactly:
        //   - a DEAD worker's transcript does not grow, so this veto never engages for it
        //     and the death-deadline synth fires as before;
        //   - the session-death read-failure backstop, the stranded-dispatch reclaim, and
        //     the orphan prune are untouched — they are the paths that recover a wedged
        //     row, and none of them route through here.
        // So a task like the long-idle a09144fa case is still reclaimed; what can no
        // longer happen is a moving transcript being stamped `completed` because a
        // deadline expired.
        const synthNewestActivityAtMs = readNewestChatActivityAtMs(messages);
        if (synthNewestActivityAtMs !== undefined
            && nowMs - synthNewestActivityAtMs < TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS) {
            setHoldState(synthKey, mesh.id, { liveConfirmedSinceAck: true, consecutiveReadFailures: 0 });
            LOG.info('MeshReconcile', `Mid-turn causal admission: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) — newest transcript bubble is ${nowMs - synthNewestActivityAtMs}ms old (< ${TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS}ms quiet window); the tail is still moving, holding the transcript synth`);
            traceMeshEventDrop('reconcile_synth_veto_transcript_growing', {
                taskId, sessionId, nodeId, meshId: mesh.id, event: 'agent:generating_completed',
            }, `newestActivityAgeMs=${nowMs - synthNewestActivityAtMs}`);
            continue;
        }

        if (isAcked) {
            const ackedAtMs = Date.parse(readNonEmptyString(dispatch.updatedAt));
            const sinceAckMs = Number.isFinite(ackedAtMs) ? nowMs - ackedAtMs : Number.POSITIVE_INFINITY;
            const deathDeadlineMs = resolveAckedDeathDeadlineMs();

            // ACKED-HOLD-IDLE-OVERTRUST fast-track. Maintain the continuous idle-with-final-assistant
            // streak. The streak starts (or continues) only while a final visible assistant message is
            // present; a tick with idle-but-no-assistant breaks it (the answer is not yet rendered).
            // This path only ever runs for an IDLE read — a `generating` read is held above
            // (non-idle escape, weak-candidate only) and never reaches the streak machinery.
            const holdState = getHoldState(synthKey, mesh.id);
            let fastTrackReady = false;
            if (evidence.finalSummary) {
                const idleSinceMs = holdState?.transcriptIdleSinceMs ?? nowMs;
                if (holdState && holdState.transcriptIdleSinceMs === undefined) {
                    setHoldState(synthKey, mesh.id, { ...holdState, transcriptIdleSinceMs: idleSinceMs });
                }
                const fastTrackGraceMs = resolveAckedTranscriptFastTrackGraceMs();
                const idleHeldMs = nowMs - idleSinceMs;
                if (idleHeldMs >= fastTrackGraceMs) {
                    fastTrackReady = true;
                    backstopKind = 'ackedHoldFastTrackFired';
                    LOG.info('MeshReconcile', `Acked-hold transcript fast-track: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read idle WITH a final assistant message for ${Math.round(idleHeldMs / 1000)}s continuous (grace ${Math.round(fastTrackGraceMs / 1000)}s) — promoting the synth ahead of the ${Math.round(deathDeadlineMs / 1000)}s death backstop; the worker's real emit was lost/late and a later one no-ops idempotently.`);
                }
            } else if (holdState?.transcriptIdleSinceMs !== undefined) {
                // Idle but no final assistant yet → not a turn-end; reset the streak.
                setHoldState(synthKey, mesh.id, { ...holdState, transcriptIdleSinceMs: undefined });
            }

            // Hold indefinitely UNLESS the fast-track grace was met OR the absolute death deadline is
            // reached. The fast-track is the new fast path in front of the (preserved) 8-min backstop.
            if (!fastTrackReady && sinceAckMs < deathDeadlineMs) {
                LOG.info('MeshReconcile', `Acked-hold: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read idle ${Number.isFinite(sinceAckMs) ? Math.round(sinceAckMs / 1000) + 's' : '∞'} since the generating_started ack — HOLDING synth (worker presumed alive; a later real emit is idempotent). Transcript fast-track promotes at ${Math.round(resolveAckedTranscriptFastTrackGraceMs() / 1000)}s continuous idle-with-final-assistant; death backstop at ${Math.round(deathDeadlineMs / 1000)}s or on consecutive read failures.`);
                continue;
            }
            if (!fastTrackReady) {
                backstopKind = 'ackedHoldDeathDeadlineFired';
                LOG.warn('MeshReconcile', `Acked-hold death deadline reached: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) still idle ${Math.round(sinceAckMs / 1000)}s after the ack (deadline ${Math.round(deathDeadlineMs / 1000)}s) — synthesizing the missing completion as a notification-loss net (a real emit, if it ever lands, no-ops idempotently).`);
            }
        }

        // R4f (auxiliary, was R4e fix 3) — worker-emit priority. Secondary check: if the worker's
        // REAL terminal emit for this task has already arrived in the pending-events queue (queued
        // for delivery to the coordinator) but not yet written a terminal ledger, YIELD — let the
        // genuine emit surface rather than racing it with a synth that would win the taskId-anchored
        // fingerprint dedup and mask it. Under the R4f acked-hold this is now an auxiliary belt-and-
        // suspenders check (the indefinite hold already defers an acked synth); it still guards the
        // never-acked path and the post-death-deadline acked synth from racing an emit caught in
        // flight at synth-commit time.
        if (realTerminalEmitPendingForTask(mesh.id, taskId)) {
            deleteHoldState(synthKey, mesh.id);
            LOG.info('MeshReconcile', `Worker-emit priority: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) has a real terminal completion already queued — yielding synth to the worker's own emit`);
            continue;
        }

        if (!evidence.finalSummary) continue; // no assistant result yet — nothing to attribute

        // STALE-SUMMARY guard (modal-parked / reused-session misattribution): a direct
        // dispatch frequently reuses a session that already ran a PRIOR task. read_chat
        // returns the tail of the WHOLE session, so extractFinalAssistantSummaryEvidence
        // picks the latest user-facing assistant message — which, for a task that has
        // barely started (the session momentarily reads idle between turns), is the prior
        // task's final summary. The downstream reconcile proves the summary is after the
        // LEDGER task_dispatched entry; here we additionally have the AUTHORITATIVE per-task
        // dispatchedAt (the dispatch-store row, immune to ledger-ordering quirks), so when
        // the selected transcript message is provably BEFORE this task's own dispatch we
        // refuse it outright — it is a prior task's summary, not this task's output (the
        // 2843ms-duration stale-summary bug where task 2e3f501e copy-pasted 4eca2d9d's
        // summary). When the message carries no usable timestamp we do NOT block here: the
        // downstream reconcile already rejects a non-JSON summary it cannot prove is
        // post-dispatch (transcript_not_proven_after_dispatch), and a structured
        // final_summary_json is self-attributing — so a timeless provider is not
        // over-blocked while the provable-stale case is still caught.
        // (dispatchedAtMs was already parsed above for the INSTANT-ACK evidence guard.)
        const transcriptAtMs = Date.parse(evidence.transcriptMessageAt ?? '');
        if (Number.isFinite(dispatchedAtMs) && Number.isFinite(transcriptAtMs) && transcriptAtMs < dispatchedAtMs) {
            LOG.info('MeshReconcile', `Stale-summary guard: skipping transcript reconcile for task ${taskId} on node ${nodeId} (mesh ${mesh.id}) — final assistant message (${evidence.transcriptMessageAt}) predates this task's dispatch (${dispatch.dispatchedAt}); it is a prior task's summary`);
            traceMeshEventDrop('reconcile_stale_summary_before_dispatch', {
                taskId, sessionId, nodeId, meshId: mesh.id, event: 'agent:generating_completed',
            }, `transcriptAt=${evidence.transcriptMessageAt} < dispatchedAt=${dispatch.dispatchedAt}`);
            continue;
        }

        // R4f (auxiliary, was R4e fix 2) — live re-probe immediately before committing the synth. A
        // fresh read right now catches a worker that resumed generating since this tick's first read
        // so it is never falsely completed off a stale snapshot. Best-effort: an inconclusive
        // re-probe (transport error/null) falls through to the synth — we already hold a valid idle
        // read from the top of THIS tick, so a re-probe failure must not re-introduce a
        // notification-miss. Under the R4f acked-hold this matters mainly for the never-acked path
        // and the post-death-deadline acked synth (the indefinite hold already deferred a live acked
        // turn); it stays as a final live-state guard at synth-commit time. (The old non-idle
        // escape skipped this re-probe; that escape no longer synthesizes at all — see the
        // weak-candidate block above — so every synth that reaches here came from an idle read.)
        const reprobeStatus = await reprobeWorkerStatus(components, { isLocalNode, nodeDaemonId, readArgs });
        if (reprobeStatus && reprobeStatus !== 'idle') {
            deleteHoldState(synthKey, mesh.id);
            LOG.info('MeshReconcile', `Live re-probe defer: task ${taskId} on node ${nodeId} (mesh ${mesh.id}) read '${reprobeStatus}' at synth-commit time — worker resumed generating; deferring synth to a later tick`);
            continue;
        }

        const providerSessionId = readNonEmptyString(payload.providerSessionId);
        // COORD-EVENT-MISROUTE (anchor preservation): the coordinator DAEMON anchor for the
        // synthesized completion is the daemon that DISPATCHED the task, NOT this reconcile
        // runner's own daemon. On a REMOTE worker the reconcile loop runs on the WORKER's daemon,
        // so `selfIds` is the worker daemon — stamping it as targetCoordinatorDaemonId corrupts the
        // anchor and (when the real coordinator is on another machine) downgrades the completion to
        // a cross-machine broadcast deliverable to any coordinator. Recover the true anchor:
        //   1. the live worker session's meshCoordinatorDaemonId relay stamp (set at dispatch,
        //      the same anchor the worker's own real-emit path reads in mesh-event-forwarding); then
        //   2. leave it to reconcileDirectDispatchCompletionFromTranscript, which recovers the
        //      DISPATCHING coordinator daemon from the task_dispatched ledger (authoritative).
        // Only when NEITHER is available do we fall back to selfIds — a genuinely local,
        // single-daemon dispatch where self IS the coordinator daemon (unchanged behaviour).
        const workerSession = components.instanceManager.getInstance(sessionId);
        const workerCoordinatorDaemonId = readNonEmptyString(
            (workerSession?.getState()?.settings as Record<string, unknown> | undefined)?.meshCoordinatorDaemonId,
        );
        const coordinatorDaemonId = workerCoordinatorDaemonId || selfIds.find(id => !!id);
        try {
            const result = reconcileDirectDispatchCompletionFromTranscript({
                meshId: mesh.id,
                nodeId,
                sessionId,
                providerType: providerType || undefined,
                providerSessionId: providerSessionId || undefined,
                taskId,
                finalSummary: evidence.finalSummary,
                ...(evidence.transcriptMessageAt ? { transcriptMessageAt: evidence.transcriptMessageAt } : {}),
                // The ledger-recovered dispatching-coordinator daemon (inside the reconcile fn)
                // takes PRIORITY over this arg; this remains the best-available fallback.
                ...(coordinatorDaemonId ? { targetCoordinatorDaemonId: coordinatorDaemonId } : {}),
                // MID-TURN-CAUSAL-ADMISSION (rc.16): pass the LOCAL live adapter's synchronous
                // turn-state probe into the unified choke point — a pending verdict vetoes this
                // eager synth (never-acked first-idle / acked fast-track). The death-deadline
                // backstop is the bounded max-wait net and overrides the veto (genuine-final
                // fail-open preserved); a remote/missing live source resolves to undefined and
                // fails open onto the bounded transcript evidence above. The trailing-tool veto
                // already ran at the top of this tick.
                causalAdmission: {
                    liveTurnPendingEvidence: resolveLiveTurnPendingEvidence(components, sessionId),
                    boundedBackstop: backstopKind === 'ackedHoldDeathDeadlineFired',
                },
                source: 'daemon_reconcile_transcript_completion',
            });
            if (result.reconciled) {
                // T6: this synth actually committed → count the last-resort backstop fire.
                // An acked hold routes to the fast-track / death-deadline kind captured
                // above; a never-acked dispatch is a plain PHASE-4 transcript synthesis.
                // Under enforce, recordBackstopFire additionally WARNs (target = 0 fires).
                recordBackstopFire(backstopKind ?? 'phase4SynthesisFired', `task ${taskId} on node ${nodeId} (mesh ${mesh.id}), kind=${result.kind}`);
                LOG.info('MeshReconcile', `Synthesized missing completion (${result.kind}) for task ${taskId} on node ${nodeId} (mesh ${mesh.id})`);
            }
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Transcript completion reconcile threw for task ${taskId}: ${e?.message || e}`);
        }
    }
}

// PHASE 5 helper. Build the live-node view (mesh.nodes decorated with each node's live
// session list) and run the shared prune core in execute mode with the conservative age gate.
//
// Orphan detection needs the SAME live-session evidence the manual MCP prune uses: a node still
// in mesh.nodes whose session list no longer contains the dispatched sessionId is "session not
// present" (prunable); a node missing from mesh.nodes entirely is "node no longer in live mesh"
// (prunable). We obtain live sessions per node via get_status_metadata — local nodes through the
// local commandHandler, remote nodes over P2P (dispatchMeshCommand) — exactly the transports
// PHASE 4 already uses. A node we cannot probe (offline) keeps an empty session list; combined
// with the age gate that only matters once the orphan is genuinely old.
//
// O(1) fast exit: when there are no active direct dispatches at all there is nothing to prune,
// so we skip the (per-node) status probes entirely — an idle mesh costs one indexed query.
export async function autoPruneStaleDirectDispatches(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
    minAgeMs: number,
): Promise<void> {
    const directDispatches = getActiveDirectDispatches(mesh.id);
    if (directDispatches.length === 0) return; // nothing dispatched → nothing to prune

    const liveNodes = await collectLiveNodesWithSessions(components, mesh, selfIds, localDaemonId);

    const result = pruneStaleDirectDispatches({
        meshId: mesh.id,
        queue: getQueue(mesh.id),
        // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered to exactly the kinds buildMeshActiveWork
        // (invoked internally by pruneStaleDirectDispatches) reads, no bare tail — a bare
        // tail:500 window can be crowded out by unrelated mesh traffic while a still-active
        // dispatch's ledger evidence falls out of the window, risking a live dispatch being
        // misclassified as an orphan and pruned.
        ledgerEntries: readLedgerEntriesByKind(mesh.id, [
            'task_dispatched',
            'task_completed',
            'task_failed',
            'task_stalled',
            'task_approval_needed',
            'task_question_pending',
        ]),
        directDispatches,
        nodes: liveNodes,
        execute: true,
        minAgeMs,
        source: 'daemon_reconcile_auto_prune',
    });

    // Log only when something was actually pruned — silence on the common no-op tick.
    if (result.prunedCount > 0) {
        LOG.info('MeshReconcile', `Auto-pruned ${result.prunedCount} orphaned direct dispatch record(s) for mesh ${mesh.id}`);
    }
}

// TASK-PROMPT-REDRIVE-AFTER-COMPLETE (Fix A-i). Single-shot transcript poll for a CLAIM-PATH
// (queue-assigned) row that PHASE 2.5's long delivered-no-turn deadline is about to RE-DRIVE.
//
// PHASE 4 (reconcileUnterminatedDirectDispatches) recovers a lost completion by re-reading the
// worker transcript, but it is bound to DIRECT-dispatch ledger rows — it never touches a
// claim-path queue row. So the F3 long-deadline reclaim reaches its 15-min deadline with an empty
// ledger for an autoLaunch/worktree worker whose generating_started/completed events never
// propagated, and re-drives a task the worker actually FINISHED (the owner's symptom). This poll
// gives that reclaim the SAME transcript evidence PHASE 4 uses, for the queue row: if the worker
// session is idle with a final assistant summary dated at/after this task's dispatch, the task is
// done — return its terminal outcome so the caller short-circuits to that status instead of
// reclaiming. Unlike PHASE 4 there is no acked-hold/grace machinery: the caller only invokes this
// AFTER the full 15-min deadline, so a single idle-with-final-assistant read is decisive.
//
// Conservative: a non-idle read, a read failure, no final summary, or a summary provably BEFORE
// dispatch all yield null (fall through to the caller's normal reclaim decision) — the poll can
// only PREVENT a wrong re-drive, never invent a completion.
//
// WATCHDOG-FINALSUMMARY-LOST: the poll now returns the FINAL ASSISTANT SUMMARY it read (not just
// the 'completed' verdict) so the watchdog caller can propagate a finalSummary-bearing completion
// to the coordinator (the SAME [System] notification a native generating_completed produces),
// instead of dropping the summary and only flipping the row + tracing a structural DROP. The
// evidence carried here is exactly what reconcileDirectDispatchCompletionFromTranscript needs to
// build and queue that completion.
export interface AssignedTaskTerminalEvidence {
    outcome: 'completed';
    finalSummary: string;
    transcriptMessageAt?: string;
    providerSessionId?: string;
    providerType?: string;
    nodeId?: string;
    sessionId: string;
    /**
     * P0-1 (terminal-admission choke point): how the turn end was proven.
     * 'strong' = a provider-native turn-terminal marker scoped to this turn
     * (immediate terminal flow is justified); 'weak' = message-shape fallback
     * only (idle + post-dispatch final assistant + quiet tail) — the caller
     * must re-confirm before releasing queue/dependency state (P1-4).
     * Absent on evidence produced before the admission choke point existed.
     */
    evidenceLevel?: 'strong' | 'weak';
    /** The native marker that proved the turn end, when evidenceLevel is 'strong'. */
    nativeMarker?: NativeTurnTerminalMarker;
    /**
     * P1-5: the full observation set the admission verdict was judged on
     * (producer / providerObservedStatus / trailingActivityCount /
     * nativeMarkerPresent / newestActivityAtMs / …). Threaded verbatim into
     * the terminal ledger's completionDiagnostic.terminalAdmission so the
     * ledger records the admission evidence the synth was judged on.
     */
    admissionSnapshot?: Record<string, unknown>;
}

// STARTED-REDRIVE-NATIVE-SOURCE-BLINDSPOT. Single-shot transcript poll that asks the NARROWER
// question the delivered-not-consumed short re-drive needs: did the worker START this turn
// (in-turn progress), regardless of whether it ever FINISHED it?
//
// The short re-drive treats "no agent:generating_started arrived" as positive evidence the worker
// never consumed the task. That inference holds for a PTY-event provider, whose turn start IS an
// emitted event. It is FALSE for a NATIVE-SOURCE provider (transcriptAuthority=provider +
// on-disk nativeHistory — kimi and kin): its start/finish signals live in the native transcript,
// not in the PTY event stream, so a worker that is demonstrably mid-task still reads
// delivered-but-never-acked. The observed symptom (2026-07-25): a kimi worker answering the same
// question four times as the watchdog re-injected the prompt at 35s/28s/27s/43s, then marked the
// task failed — verdict IDLE_CONFIRMED, because between tool calls the session reads idle.
//
// pollAssignedTaskTerminalEvidence answers "did it FINISH" (idle + final-assistant + no trailing
// tool activity). That is the wrong bar here: a worker mid-task has NOT finished, yet must not be
// re-driven. This poll therefore accepts ANY post-dispatch transcript bubble — assistant text,
// thought, or tool/terminal activity — as proof the prompt was consumed and work is under way.
//
// Conservative in the same direction as its sibling: an unreadable transcript, a missing/unusable
// dispatch timestamp, or a tail containing nothing dated at/after dispatch all yield false, so the
// caller falls through to its normal re-drive decision. The poll can only PREVENT a re-drive of a
// working session, never create or suppress a completion.
// ---------------------------------------------------------------------------
// Shared assigned-task read_chat skeleton (P1 of the transcript-authority
// unification — root repo docs/design/2026-07-25-transcript-authority-unification.md).
// pollAssignedTaskInTurnProgress ('turn-progress') and
// pollAssignedTaskTerminalEvidence ('terminal-evidence') previously duplicated
// this fetch verbatim; both are delegation shells over this one skeleton so a
// future purpose (or the reconcile-loop consumers in P3) cannot fork the
// transport semantics again. Inconclusive — no worker, no transport, transport
// error, or an explicit success:false — is null; callers keep their
// conservative fallbacks ("couldn't tell ≠ idle").
// ---------------------------------------------------------------------------
async function fetchAssignedTaskChatTail(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    row: { assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string },
    tailLimit = 10,
): Promise<Record<string, unknown> | null> {
    const sessionId = readNonEmptyString(row.assignedSessionId);
    const nodeId = readNonEmptyString(row.assignedNodeId);
    if (!sessionId || !nodeId) return null; // no worker to read

    const node = (mesh.nodes ?? []).find(n => n.id === nodeId);
    const nodeDaemonId = readNonEmptyString(node?.daemonId);
    const localDaemonId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const isLocalNode = !nodeDaemonId
        || daemonIdsEquivalent(nodeDaemonId, localDaemonId)
        || !!components.instanceManager.getInstance(sessionId);

    const providerType = readNonEmptyString(row.assignedProviderType);
    const readArgs: Record<string, unknown> = {
        sessionId,
        targetSessionId: sessionId,
        tailLimit,
        // P0-2 (terminal-admission incident): include the ACTIVITY surface. Without
        // it the worker-side read strips tool/terminal bubbles from the tail, so the
        // trailing-tool guard was BLIND — the 15-min redrive poll read a mid-turn
        // kimi worker as "idle + final assistant preamble" because the trailing Edit
        // tool call had been filtered out, and flipped the row completed 6s before
        // the worker went busy again. This also makes pollAssignedTaskActivity see
        // tool bubbles — strictly more accurate consumption evidence.
        includeActivity: true,
        ...(node?.workspace ? { workspace: node.workspace } : {}),
        ...(providerType ? { agentType: providerType, providerType } : {}),
    };

    try {
        if (isLocalNode) {
            const result = await components.commandHandler?.handle('read_chat', readArgs);
            if (result && (result as { success?: boolean }).success === false) return null;
            return unwrapReadChatPayload(result);
        }
        if (components.dispatchMeshCommand) {
            const result = await components.dispatchMeshCommand(nodeDaemonId, 'read_chat', readArgs);
            const payload = unwrapReadChatPayload(result);
            if (payload && (payload as { success?: boolean }).success === false) return null;
            return payload;
        }
        return null; // remote node, no P2P transport — can't read this tick
    } catch {
        return null; // transport error / session gone → inconclusive, let the caller decide
    }
}

/**
 * Purpose-tagged coordinator-side evidence query — the remote half of the
 * transcript-authority choke point (P1). Existing callers keep the original
 * poll* shells below; new consumers (the reconcile loop's early-arm / redrive
 * sites in P3) should enter here so the purpose vocabulary — not another
 * ad-hoc gate — expresses what is being asked of the worker transcript.
 */
export type AssignedTaskEvidencePurpose = 'turn-progress' | 'terminal-evidence';

export interface AssignedTaskCompletionEvidence {
    purpose: AssignedTaskEvidencePurpose;
    /** "Did the worker START this task's turn" — post-dispatch agent bubble. */
    inTurnProgress: boolean;
    /** "Did the worker FINISH this task's turn" — populated for 'terminal-evidence'. */
    terminal: AssignedTaskTerminalEvidence | null;
}

export async function resolveAssignedTaskCompletionEvidence(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    row: { id: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string; dispatchTimestamp?: string },
    purpose: AssignedTaskEvidencePurpose,
): Promise<AssignedTaskCompletionEvidence> {
    if (purpose === 'turn-progress') {
        const inTurnProgress = await pollAssignedTaskInTurnProgress(components, mesh, row);
        return { purpose, inTurnProgress, terminal: null };
    }
    const terminal = await pollAssignedTaskTerminalEvidence(components, mesh, row);
    // A proven turn-end implies the turn also started.
    return { purpose, inTurnProgress: terminal != null, terminal };
}

export async function pollAssignedTaskInTurnProgress(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    row: { id: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string; dispatchTimestamp?: string },
): Promise<boolean> {
    return (await pollAssignedTaskActivity(components, mesh, row)).inTurnProgress;
}

export interface AssignedTaskActivity {
    /** "Did the worker START this task's turn" — any post-dispatch agent bubble. */
    inTurnProgress: boolean;
    /**
     * Timestamp (ms) of the NEWEST post-dispatch agent bubble, when one exists.
     * Callers use this to distinguish a worker whose transcript is still GROWING
     * (fresh activity → hold a redrive/reclaim) from one that went quiet mid-turn
     * (stale activity → bounded recovery may proceed). Existence alone is not
     * enough: a post-dispatch bubble remains visible forever after the worker dies,
     * so a boolean-only check would suppress the reclaim indefinitely.
     */
    lastAgentActivityMs: number | null;
}

/**
 * RC.20 (queue/redrive): activity-timestamped sibling of
 * pollAssignedTaskInTurnProgress. Same evidence bar (any post-dispatch AGENT-side
 * bubble proves the prompt was consumed — this covers a native-source worker's own
 * narration/tool bubbles, including the tool activity an orchestrator emits while
 * spawning its child probes), but also reports the newest bubble's timestamp so the
 * reconcile loop can apply a bounded freshness rule instead of holding forever.
 *
 * Conservative in the same direction: an unreadable transcript, a missing dispatch
 * boundary, or a tail with nothing post-dispatch yields inTurnProgress=false /
 * lastAgentActivityMs=null, so the caller falls through to its normal decision.
 */
export async function pollAssignedTaskActivity(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    row: { id: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string; dispatchTimestamp?: string },
): Promise<AssignedTaskActivity> {
    const NONE: AssignedTaskActivity = { inTurnProgress: false, lastAgentActivityMs: null };
    // DUP-CLAIM-REBIND (rc.35): attempt-first, row-fallback — same reasoning as
    // pollAssignedTaskTerminalEvidence. This poll is the redrive's in-turn-progress
    // gate, so reading the refused (idle) session instead of the rebound holder is
    // precisely what let the redrive arm against a worker that was still generating.
    const sessionId = resolveTaskEvidenceSessionId(mesh.id, row.id, row.assignedSessionId);
    const nodeId = readNonEmptyString(row.assignedNodeId);
    if (!sessionId || !nodeId) return NONE; // no worker to read
    const evidenceRow = sessionId !== row.assignedSessionId
        ? { ...row, assignedSessionId: sessionId }
        : row;

    // A dispatch boundary is REQUIRED: without it a reused session's prior-task tail would read as
    // progress on THIS task and suppress the re-drive forever.
    const dispatchedAtMs = Date.parse(readNonEmptyString(row.dispatchTimestamp));
    if (!Number.isFinite(dispatchedAtMs)) return NONE;

    // TURN-LEDGER (Stage 5): the transcript read is evidence collection — strictly
    // ordered against any destructive stop/teardown queued for the same session, so
    // teardown can never destroy the evidence source mid-read (the 6ms race).
    const payload = await runSessionEvidenceCollection(sessionId, () => fetchAssignedTaskChatTail(components, mesh, evidenceRow));
    if (!payload) return NONE;

    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    // Any AGENT-side bubble dated at/after dispatch proves the prompt landed and the turn is under
    // way. User bubbles are excluded: the injected task prompt itself is a post-dispatch user
    // message, and counting it would suppress the re-drive for the very row this watchdog exists
    // to rescue (delivered, echoed into the transcript, but never actually worked).
    let lastAgentActivityMs: number | null = null;
    for (const msg of messages) {
        if (!msg) continue;
        if (msg.role === 'user' || msg.role === 'system') continue;
        const ts = readChatMessageTimestampMs(msg);
        if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
        if (ts < dispatchedAtMs) continue;
        if (lastAgentActivityMs === null || ts > lastAgentActivityMs) lastAgentActivityMs = ts;
    }
    return { inTurnProgress: lastAgentActivityMs !== null, lastAgentActivityMs };
}

export async function pollAssignedTaskTerminalEvidence(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    row: { id: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string; dispatchTimestamp?: string },
    opts?: {
        /**
         * TX-FSM Stage 2 (EARLY-IDLE preamble guard): when set, the selected
         * final assistant bubble must ALSO be at least this old at poll time.
         *
         * Why: the early-idle caller's continuous-idle streak proves the
         * worker's status VERDICT stayed idle — not that the transcript did.
         * A floor-class worker reads idle in the sliver BETWEEN an assistant
         * preamble ("코드와 로그를 병행으로 확인하겠습니다.") and the tool call
         * it is about to fire; at that instant the preamble IS the latest
         * user-facing assistant bubble, is dated after dispatch, and has no
         * trailing tool activity yet, so every structural guard above passes
         * and a turn still in flight gets promoted to a completion (ledger
         * 84594b15, 2026-07-26: task_completed with
         * transcriptFinalAssistantPresent:false while the worker went on to an
         * approval modal and did the real work minutes later). No single-read
         * structural test can separate that preamble from a genuine final
         * answer — only TIME can: a bubble younger than the settle window is
         * narration, not a turn end. A genuinely finished worker's bubble
         * simply completes one streak later (the caller resets and re-arms),
         * so this guard DELAYS the early path by at most one window, never
         * loses it. Fail-safe direction: veto → the caller falls through to
         * the reclaim/grace paths.
         */
        minFinalAssistantAgeMs?: number;
        /**
         * P0-1 (terminal-admission choke point): who is asking, recorded in the
         * admission snapshot + decline traces so a ledger completion can be
         * paired with the producer that judged it
         * ('redrive_deadline_transcript_evidence' | 'early_idle_transcript_evidence' | …).
         * Defaults to 'transcript_poll' for legacy callers.
         */
        producer?: string;
    },
): Promise<AssignedTaskTerminalEvidence | null> {
    // DUP-CLAIM-REBIND (rc.35): read the session the ATTEMPT names, not the claim-time
    // row stamp. After a duplicate-dispatch refusal rebinds the attempt to the real
    // holder, the row still names the refused session — polling THAT session reads
    // "idle with 0 messages" and the caller re-drives a task the holder is still
    // working. resolveTaskEvidenceSessionId falls back to the row whenever the attempt
    // cannot speak for the binding, so the never-rebound path is unchanged.
    const sessionId = resolveTaskEvidenceSessionId(mesh.id, row.id, row.assignedSessionId);
    const nodeId = readNonEmptyString(row.assignedNodeId);
    // The tail fetch re-derives the session from the row it is handed, so hand it the
    // effective (attempt-first) binding rather than the raw row.
    const evidenceRow = sessionId && sessionId !== row.assignedSessionId
        ? { ...row, assignedSessionId: sessionId }
        : row;

    // POLL-TRACE (observability, not a behaviour change): this poll is the last net before a
    // 15-min delivered-no-turn reclaim re-injects a prompt into a possibly-finished worker, and
    // every one of its guards used to `return null` SILENTLY. When it declined, the deadline
    // reclaim showed no reason at all, which is precisely what blocked diagnosis of the rc.33
    // strict-route loss. Each exit now names itself. Verdicts are traced at drop level (the
    // poll declined) and the accept is traced at stage level, so a reclaim can always be paired
    // with the reason the transcript net did not catch it first.
    const traceCtx = {
        taskId: row.id,
        ...(sessionId ? { sessionId } : {}),
        ...(nodeId ? { nodeId } : {}),
        meshId: mesh.id,
        event: 'agent:generating_completed',
    };
    const declined = (reason: string, detail?: string): null => {
        traceMeshEventDrop(`poll_terminal_evidence_${reason}`, traceCtx, detail);
        return null;
    };

    if (!sessionId || !nodeId) {
        // No worker to read — trace without session/node (they are the missing part).
        return declined('no_assigned_worker', `sessionId=${sessionId ?? 'none'} nodeId=${nodeId ?? 'none'}`);
    }

    const providerType = readNonEmptyString(row.assignedProviderType);
    // TURN-LEDGER (Stage 5): strictly ordered evidence collection (see above).
    const payload = await runSessionEvidenceCollection(sessionId, () => fetchAssignedTaskChatTail(components, mesh, evidenceRow));
    if (!payload) return declined('chat_tail_unreadable', 'worker transcript read returned no payload (offline/unreachable?)');

    // Only a settled-idle session is a turn-end; a generating/waiting session is mid-turn and
    // must NEVER be short-circuited to completed.
    //
    // PROJECTION-SELF-REFERENCE: read the PROVIDER's own verdict, not the projected
    // `status`. For a mesh-owned session Stage 6 replaces `status` with the turn-ledger
    // stage — and this poll is the writer that advances that stage. Gating on it made the
    // condition self-referential: the ledger stayed `generating` because the poll declined,
    // and the poll declined because the ledger said `generating`. Observed live for 1h+ on
    // both codex-cli and claude-cli (328 `session_not_idle` drops on a session whose turn had
    // visibly ended), and it is the reason finished tasks never released their queue slot.
    //
    // This does NOT loosen completion detection. The `!== 'idle'` test never protected against
    // a false completion — a genuinely generating provider reports `generating` here too, so a
    // mid-turn worker is still refused. When the field is absent (older remote daemon) the
    // reader falls back to the projected status — i.e. the pre-fix behaviour, never a
    // fabricated idle. The verdict itself is now applied inside the terminal-admission
    // choke point below (rule 2), with ITS result passed verbatim so the fallback
    // semantics are preserved exactly.
    const payloadStatus = readChatPayloadProviderObservedStatus(payload);

    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    // Parsed BEFORE the evidence extraction so the INSTANT-ACK structural guard (P3)
    // gets the dispatch boundary: a seconds-fresh acknowledgment bubble is not a
    // turn-end candidate. (The stale-summary guard below reuses this same parse.)
    const dispatchedAtMs = Date.parse(readNonEmptyString(row.dispatchTimestamp));
    const evidence = extractFinalAssistantSummaryEvidence(messages, undefined,
        Number.isFinite(dispatchedAtMs) ? { turnStartedAtMs: dispatchedAtMs } : undefined);

    // Stale-summary guard (same bar as PHASE 4): a reused session's transcript tail may hold a
    // PRIOR task's summary. Require the final assistant message to be dated at/after THIS task's
    // dispatch. When either timestamp is unusable, do NOT short-circuit — fall through so we never
    // synthesize a completion off a possibly-stale tail (the reclaim path is the safe default).
    // Runs BEFORE the admission predicate: the admission snapshot needs the dispatch boundary
    // anyway, and a provably-stale tail is declined here regardless of any other signal.
    const transcriptAtMs = Date.parse(evidence.transcriptMessageAt ?? '');
    // A summary PROVABLY older than this task's dispatch is a prior task's tail — the
    // original stale-tail veto, unchanged and still fail-closed.
    if (Number.isFinite(dispatchedAtMs) && Number.isFinite(transcriptAtMs) && transcriptAtMs < dispatchedAtMs) {
        return declined(
            'summary_predates_dispatch',
            `dispatchTimestamp=${row.dispatchTimestamp ?? 'none'} transcriptMessageAt=${evidence.transcriptMessageAt ?? 'none'}`,
        );
    }
    // TIMESTAMP-UNUSABLE DEMOTION (terminal-admission-all-paths, item 1).
    //
    // What this guard used to do: hard-return `timestamp_unusable` whenever EITHER
    // timestamp failed to parse. Live measurement showed that pre-return firing 49/49
    // times on this path — it declined every poll, which is why the admission gate below
    // had never once run in production.
    //
    // Why it fired so often — the measured cause, not the assumed one. `transcriptMessageAt`
    // is not "a field that happened to be empty". extractFinalAssistantSummaryEvidence
    // returns `{ finalSummary: '' }` with NO transcriptMessageAt at all whenever
    // selectFinalAssistantTurnEndMessage returns null. So `transcriptMessageAt=none`
    // does not mean "undated bubble" — it overwhelmingly means "no final assistant bubble
    // was selected in the tail", which on a tool-heavy coordinator session with
    // tailLimit=10 is the normal reading. The guard was answering a SHAPE question with a
    // TIMESTAMP verdict.
    //
    // What changes: an unusable/absent timestamp is no longer a hard pre-return. It is
    // demoted to what it actually is — an ABSENCE of shape evidence — and handed to the
    // admission choke point, which already answers it correctly and more precisely:
    //   - rule 5 declines `no_final_assistant_summary` when no final assistant exists
    //     (the real 43/49 case) — same refusal, honest reason;
    //   - rule 3 can admit a provider-NATIVE turn-terminal marker first, which is the
    //     case the old guard wrongly buried: a marker proves THIS turn ended even when
    //     the tail carries no dated assistant bubble at all (codex's 19.5% empty-reply
    //     turns), and it is scoped to the dispatch boundary so it cannot match a prior
    //     turn's marker.
    //
    // ★ What is preserved: "no timestamp" still NEVER promotes to completed on shape
    // evidence. The message-shape fallback (rule 8) is reachable only through rule 5,
    // which requires a final assistant to have been selected — and selection is exactly
    // what produces the timestamp. So a dated-tail-less transcript can only be admitted
    // by a native marker, never by shape. The guard's original intent — do not manufacture
    // a completion from an undated/pre-dispatch tail, let reclaim handle it — holds.
    const dispatchBoundaryUnusable = !Number.isFinite(dispatchedAtMs) || !Number.isFinite(transcriptAtMs);

    // TX-FSM Stage 2 (EARLY-IDLE preamble guard): the final assistant bubble
    // must have SETTLED — see the opts doc above. A bubble younger than the
    // caller's settle window is treated as in-flight narration: veto (null),
    // exactly like the trailing-tool guard, so the streak re-accumulates and a
    // genuine turn end completes one window later. Kept CALLER-SIDE (admission
    // rule 7): the early-idle caller owns this window, the predicate does not
    // duplicate it.
    if (typeof opts?.minFinalAssistantAgeMs === 'number' && opts.minFinalAssistantAgeMs > 0
        && Date.now() - transcriptAtMs < opts.minFinalAssistantAgeMs) {
        return declined(
            'final_assistant_not_settled',
            `age=${Date.now() - transcriptAtMs}ms < minFinalAssistantAgeMs=${opts.minFinalAssistantAgeMs} — treated as in-flight narration`,
        );
    }

    // P0-1 (terminal-admission choke point): the finality decision is made ONE way,
    // in evaluateTerminalAdmission — see mesh-terminal-admission.ts for the ordered
    // rules and the incident they fix. This poll now gathers the observations only:
    //
    //   - activeModalPresent: a parked approval/question modal blocks the turn.
    //   - nativeMarkers* (P0-2): when the provider has a native turn-terminal signal
    //     AND the payload carried turnTerminalMarkers (a native read genuinely
    //     happened — absent on old daemons / PTY fallbacks), the marker list is
    //     authoritative: a scoped marker admits STRONG, its absence vetoes even a
    //     perfect message shape (the incident veto).
    //   - trailingActivityCount: tool/terminal bubbles after the final assistant
    //     (EARLY-IDLE-COMPLETION-FALSE-POSITIVE — the preamble veto; now visible
    //     because the tail fetch passes includeActivity).
    //   - newestActivityAtMs: newest bubble of ANY kind — the transcript-growing
    //     freshness veto, never bypassable by any deadline/backstop.
    const nowMs = Date.now();
    const trailingActivityCount = countTrailingToolActivityAfterFinalAssistant(messages);
    const newestActivityAtMs = readNewestChatActivityAtMs(messages);
    const transcriptGrowing = newestActivityAtMs !== undefined
        && nowMs - newestActivityAtMs < TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS;
    const activeModalPresent = hasNonEmptyModalButtons(payload.activeModal);
    const nativeMarkersFieldPresent = 'turnTerminalMarkers' in payload;
    const nativeMarkers = nativeMarkersFieldPresent && Array.isArray(payload.turnTerminalMarkers)
        ? payload.turnTerminalMarkers as readonly NativeTurnTerminalMarker[]
        : undefined;
    const finalAssistantPresent = !!evidence.finalSummary;
    const producer = readNonEmptyString(opts?.producer) || 'transcript_poll';
    const verdict = evaluateTerminalAdmission({
        producer,
        providerType: providerType || undefined,
        providerHasNativeMarker: providerHasNativeTurnSignal({ type: providerType }),
        nativeMarkersFieldPresent,
        nativeMarkers,
        turnStartedAtMs: Number.isFinite(dispatchedAtMs) ? dispatchedAtMs : undefined,
        providerObservedStatus: payloadStatus,
        activeModalPresent,
        finalAssistantPresent,
        trailingActivityCount,
        newestActivityAtMs,
        nowMs,
        minFinalAssistantAgeMs: opts?.minFinalAssistantAgeMs,
    });
    if (!verdict.admit) return declined(verdict.reason, verdict.detail);

    // ★ TIMESTAMP-UNUSABLE DEMOTION — the invariant the old hard pre-return used to
    // guarantee structurally, re-asserted explicitly now that the demotion lets these
    // cases reach the predicate at all.
    //
    // "No usable timestamp" must NEVER promote to completed on message-SHAPE evidence.
    // Rules 5→8 already make that true by construction (`finalAssistantPresent` is
    // `!!evidence.finalSummary`, produced by the SAME selectFinalAssistantTurnEndMessage
    // call that produces transcriptMessageAt — so no final assistant ⇒ no timestamp ⇒
    // rule 5 declines). That coupling is not obvious from either call site and a future
    // change to either extractor could silently break it, turning "undated tail" back
    // into "completed" — the exact failure the original guard existed to prevent. Pin it
    // here: with an unusable dispatch/transcript boundary, ONLY a strong native marker
    // (rule 3, itself dispatch-scoped) may admit. Anything else falls back to the
    // reclaim path, as before.
    if (dispatchBoundaryUnusable && verdict.evidenceLevel !== 'strong') {
        return declined(
            'timestamp_unusable',
            `dispatchTimestamp=${row.dispatchTimestamp ?? 'none'} transcriptMessageAt=${evidence.transcriptMessageAt ?? 'none'}`
            + ` — shape-only evidence (${verdict.reason}) cannot complete an undated tail; reclaim owns it`,
        );
    }

    // Admitted. Idle + a final assistant message dated after dispatch (weak), or a
    // native turn-terminal marker scoped to this turn (strong) = the worker finished
    // this turn. We cannot distinguish a self-reported failure from the plain
    // transcript tail here (that lives in buildTaskCompletionEvidence's
    // structured-result path), and the alternative — re-driving a finished worker —
    // is strictly worse, so a proven turn-end short-circuits to 'completed'.
    //
    // WATCHDOG-FINALSUMMARY-LOST: carry the read evidence back to the caller so it can propagate a
    // finalSummary-bearing completion (not just flip the row). providerSessionId is best-effort from
    // the read payload — absent → daemon-level routing (unchanged from the reconcile paths).
    // P1-5: the admission snapshot rides along so the caller can stamp it into the
    // terminal ledger's completionDiagnostic.terminalAdmission.
    // POLL-TRACE: the accept side, so a poll that PREVENTED a wrong re-drive is as visible as one
    // that declined (the whole point is being able to tell those two apart after the fact).
    const selectedFinalAssistant = finalAssistantPresent
        ? selectFinalAssistantTurnEndMessage(messages,
            Number.isFinite(dispatchedAtMs) ? { turnStartedAtMs: dispatchedAtMs } : undefined)
        : null;
    const selectedFinalAssistantIndex = selectedFinalAssistant ? messages.lastIndexOf(selectedFinalAssistant) : -1;
    const admissionSnapshot: Record<string, unknown> = {
        producer,
        providerType: providerType || undefined,
        providerObservedStatus: payloadStatus,
        activeModalPresent,
        inTurnProgress: trailingActivityCount > 0 || transcriptGrowing,
        transcriptGrowing,
        trailingActivityCount,
        nativeMarkerPresent: !!verdict.nativeMarker,
        nativeMarkersFieldPresent,
        finalAssistantPresent,
        ...(selectedFinalAssistantIndex >= 0 ? { selectedFinalAssistantIndex } : {}),
        ...(newestActivityAtMs !== undefined ? { newestActivityAtMs } : {}),
        ...(Number.isFinite(dispatchedAtMs) ? { turnStartedAtMs: dispatchedAtMs } : {}),
        polledAtMs: nowMs,
    };
    traceMeshEventStage('poll_terminal_evidence_completed', traceCtx,
        `${verdict.reason} (${verdict.evidenceLevel}) — task is completed, re-drive prevented`);
    return {
        outcome: 'completed',
        finalSummary: evidence.finalSummary,
        ...(evidence.transcriptMessageAt ? { transcriptMessageAt: evidence.transcriptMessageAt } : {}),
        ...(readNonEmptyString(payload.providerSessionId) ? { providerSessionId: readNonEmptyString(payload.providerSessionId) } : {}),
        ...(providerType ? { providerType } : {}),
        ...(nodeId ? { nodeId } : {}),
        sessionId,
        evidenceLevel: verdict.evidenceLevel,
        ...(verdict.nativeMarker ? { nativeMarker: verdict.nativeMarker } : {}),
        admissionSnapshot,
    };
}
