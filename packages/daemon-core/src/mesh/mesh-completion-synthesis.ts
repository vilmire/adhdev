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
import { traceMeshEventDrop } from './mesh-event-trace.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { daemonIdListIncludes } from './mesh-reconcile-identity.js';
import { getActiveDirectDispatches, getQueue } from './mesh-work-queue.js';
import { readLedgerEntries } from './mesh-ledger.js';
import { pruneStaleDirectDispatches } from './mesh-active-work.js';
import { reconcileDirectDispatchCompletionFromTranscript } from './mesh-events-stale.js';
import { extractFinalAssistantSummaryEvidence, hasTrailingToolActivityAfterFinalAssistant, readChatMessageTimestampMs } from '../providers/chat-message-normalization.js';
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
    reprobeWorkerStatus,
    realTerminalEmitPendingForTask,
    collectLiveNodesWithSessions,
} from './mesh-remote-event-pull.js';

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
        const nowMs = Date.now();
        if (readChatPayloadStatus(payload) !== 'idle') {
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
        const evidence = extractFinalAssistantSummaryEvidence(messages);

        if (isAcked) {
            const ackedAtMs = Date.parse(readNonEmptyString(dispatch.updatedAt));
            const sinceAckMs = Number.isFinite(ackedAtMs) ? nowMs - ackedAtMs : Number.POSITIVE_INFINITY;
            const deathDeadlineMs = resolveAckedDeathDeadlineMs();

            // ACKED-HOLD-IDLE-OVERTRUST fast-track. Maintain the continuous idle-with-final-assistant
            // streak. The streak starts (or continues) only while a final visible assistant message is
            // present; a tick with idle-but-no-assistant breaks it (the answer is not yet rendered).
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
        const dispatchedAtMs = Date.parse(readNonEmptyString(dispatch.dispatchedAt));
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
        // turn); it stays as a final live-state guard at synth-commit time.
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
        ledgerEntries: readLedgerEntries(mesh.id, { tail: 500 }),
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
export async function pollAssignedTaskInTurnProgress(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    row: { id: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string; dispatchTimestamp?: string },
): Promise<boolean> {
    const sessionId = readNonEmptyString(row.assignedSessionId);
    const nodeId = readNonEmptyString(row.assignedNodeId);
    if (!sessionId || !nodeId) return false; // no worker to read

    // A dispatch boundary is REQUIRED: without it a reused session's prior-task tail would read as
    // progress on THIS task and suppress the re-drive forever.
    const dispatchedAtMs = Date.parse(readNonEmptyString(row.dispatchTimestamp));
    if (!Number.isFinite(dispatchedAtMs)) return false;

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
        tailLimit: 10,
        ...(node?.workspace ? { workspace: node.workspace } : {}),
        ...(providerType ? { agentType: providerType, providerType } : {}),
    };

    let payload: Record<string, unknown> | null = null;
    try {
        if (isLocalNode) {
            const result = await components.commandHandler?.handle('read_chat', readArgs);
            if (result && (result as { success?: boolean }).success === false) return false;
            payload = unwrapReadChatPayload(result);
        } else if (components.dispatchMeshCommand) {
            const result = await components.dispatchMeshCommand(nodeDaemonId, 'read_chat', readArgs);
            payload = unwrapReadChatPayload(result);
            if (payload && (payload as { success?: boolean }).success === false) return false;
        } else {
            return false; // remote node, no P2P transport — can't read this tick
        }
    } catch {
        return false; // transport error / session gone → inconclusive, let the caller decide
    }
    if (!payload) return false;

    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    // Any AGENT-side bubble dated at/after dispatch proves the prompt landed and the turn is under
    // way. User bubbles are excluded: the injected task prompt itself is a post-dispatch user
    // message, and counting it would suppress the re-drive for the very row this watchdog exists
    // to rescue (delivered, echoed into the transcript, but never actually worked).
    return messages.some(msg => {
        if (!msg) return false;
        if (msg.role === 'user' || msg.role === 'system') return false;
        const ts = readChatMessageTimestampMs(msg);
        if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
        return ts >= dispatchedAtMs;
    });
}

export async function pollAssignedTaskTerminalEvidence(
    components: DaemonComponents,
    mesh: { id: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> },
    row: { id: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string; dispatchTimestamp?: string },
): Promise<AssignedTaskTerminalEvidence | null> {
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
        tailLimit: 10,
        ...(node?.workspace ? { workspace: node.workspace } : {}),
        ...(providerType ? { agentType: providerType, providerType } : {}),
    };

    let payload: Record<string, unknown> | null = null;
    try {
        if (isLocalNode) {
            const result = await components.commandHandler?.handle('read_chat', readArgs);
            if (result && (result as { success?: boolean }).success === false) return null;
            payload = unwrapReadChatPayload(result);
        } else if (components.dispatchMeshCommand) {
            const result = await components.dispatchMeshCommand(nodeDaemonId, 'read_chat', readArgs);
            payload = unwrapReadChatPayload(result);
            if (payload && (payload as { success?: boolean }).success === false) return null;
        } else {
            return null; // remote node, no P2P transport — can't read this tick
        }
    } catch {
        return null; // transport error / session gone → inconclusive, let the caller decide
    }
    if (!payload) return null;

    // Only a settled-idle session is a turn-end; a generating/waiting session is mid-turn and
    // must NEVER be short-circuited to completed.
    if (readChatPayloadStatus(payload) !== 'idle') return null;

    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    const evidence = extractFinalAssistantSummaryEvidence(messages);
    if (!evidence.finalSummary) return null; // idle but no assistant result yet → not a turn-end

    // EARLY-IDLE-COMPLETION-FALSE-POSITIVE (poll defense-in-depth): a momentary idle read
    // (startup-grace, or the sliver between an assistant preamble and the tool it fires) can
    // show an assistant "Let me explore…" bubble FOLLOWED by trailing Read/Grep tool_use — a
    // turn that is still executing, not a turn-end. selectFinalAssistantTurnEndMessage skips
    // those trailing tool bubbles and would promote the preamble, so guard here: if a
    // tool/terminal activity bubble trails the final assistant message, the worker is mid-turn
    // — refuse the completion (fall through to the caller's reclaim/grace path). A genuinely
    // finished pure-PTY worker ends on its final assistant with no trailing tool activity, so
    // the kimi rescue is preserved.
    if (hasTrailingToolActivityAfterFinalAssistant(messages)) return null;

    // Stale-summary guard (same bar as PHASE 4): a reused session's transcript tail may hold a
    // PRIOR task's summary. Require the final assistant message to be dated at/after THIS task's
    // dispatch. When either timestamp is unusable, do NOT short-circuit — fall through so we never
    // synthesize a completion off a possibly-stale tail (the reclaim path is the safe default).
    const dispatchedAtMs = Date.parse(readNonEmptyString(row.dispatchTimestamp));
    const transcriptAtMs = Date.parse(evidence.transcriptMessageAt ?? '');
    if (!(Number.isFinite(dispatchedAtMs) && Number.isFinite(transcriptAtMs) && transcriptAtMs >= dispatchedAtMs)) {
        return null;
    }

    // Idle + a final assistant message dated after dispatch = the worker finished this turn. We
    // cannot distinguish a self-reported failure from the plain transcript tail here (that lives
    // in buildTaskCompletionEvidence's structured-result path), and the alternative — re-driving a
    // finished worker — is strictly worse, so a proven turn-end short-circuits to 'completed'.
    //
    // WATCHDOG-FINALSUMMARY-LOST: carry the read evidence back to the caller so it can propagate a
    // finalSummary-bearing completion (not just flip the row). providerSessionId is best-effort from
    // the read payload — absent → daemon-level routing (unchanged from the reconcile paths).
    return {
        outcome: 'completed',
        finalSummary: evidence.finalSummary,
        ...(evidence.transcriptMessageAt ? { transcriptMessageAt: evidence.transcriptMessageAt } : {}),
        ...(readNonEmptyString(payload.providerSessionId) ? { providerSessionId: readNonEmptyString(payload.providerSessionId) } : {}),
        ...(providerType ? { providerType } : {}),
        ...(nodeId ? { nodeId } : {}),
        sessionId,
    };
}
