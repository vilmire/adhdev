// Queue dispatch delivery: hand a claimed task to its session's transport (local
// router or remote mesh command) with the confirm deadline, report every transport
// outcome to the turn ledger as evidence, and requeue / fail on a dispatch
// failure. Split out of mesh-queue-assignment.ts (re-exported there).

import { MESH_CONNECT_TIMEOUT_MS } from '../runtime-defaults.js';
import { LOG } from '../logging/logger.js';
import { type MeshWorkQueueEntry, applyDispatchFailureBackoff, requeueTask } from './mesh-work-queue.js';
import type { MeshTaskRoutingDecision } from './mesh-routing-decision.js';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { type TurnAttemptRef, type TurnEvidence, sessionIdsEquivalent, meshNodeIdMatches, sanitizeRefusalCode, readText } from '@adhdev/mesh-shared';
import type { TurnLedger } from './turn-ledger/ledger.js';
import { localCoordinatorDaemonId } from './mesh-queue-mesh-view.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { buildRedriveProvenance, describeRedriveProviderFlip } from './mesh-redrive-provenance.js';
import { meshRecord } from './mesh-record.js';
import { traceMeshEventStage } from '../shared/mesh-event-trace.js';
import { randomUUID } from 'crypto';
import { awaitWithWarmupDeadline, resolveWarmupDeadlineOpts } from './mesh-warmup-deadline.js';
import { unwrapMeshRelayResult } from '../commands/mesh-relay-result.js';
import { dispatchMessageId } from './mesh-queue-dispatch-evidence.js';
import { classifyDuplicateMeshDispatch } from './mesh-duplicate-dispatch.js';
import { endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { notifyCoordinatorOfPinnedDispatchFailure } from './mesh-dispatch-failed-notify.js';

// ---------------------------------------------------------------------------
// Queue assignment
// ---------------------------------------------------------------------------

// Per-dispatch confirmation timeout (Bug B). A dispatch promise that never settles —
// a saturated remote P2P relay that hangs, or a transport that resolves only after
// the worker acks — would otherwise leave the just-claimed queue row 'assigned' with
// its delivery stuck 'delivering' forever: the .catch that requeues never fires, and
// PHASE 3 reconcile skips the row (it counts 0 pending). Racing the dispatch against
// this timeout guarantees a hung dispatch deterministically returns the task to
// 'pending' for re-dispatch. Generous so a merely-slow-but-live dispatch (a cold
// remote relay) is never reclaimed early; the reconcile assigned-stranded watchdog is
// the durable cross-restart backstop for a timer lost to a daemon restart.
const DISPATCH_CONFIRM_TIMEOUT_MS = 120_000;

// Cold-open connect budget for the warmup-aware REMOTE task dispatch deadline. A
// remote `agent_command` to a peer whose mesh DataChannel is not open yet first has
// to drive the cross-machine (often TURN-relayed) handshake; charging that warmup
// against the response budget is the same cold-open false-timeout the git_status
// probe path already guards against. This budget bounds ONLY the "channel not open
// yet" phase; once the channel is warm the DISPATCH_CONFIRM_TIMEOUT_MS response
// budget governs (identical to the legacy flat guard for an already-open peer, so
// no latency is added to a normal dispatch). Matches the daemon-cloud
// DaemonMeshManager CONNECT_TIMEOUT_MS (45s) so the caller-side deadline tracks the
// transport's own cold-open window rather than guessing.
//
// Sourced from the unified, env-overridable MESH_CONNECT_TIMEOUT_MS (runtime-defaults)
// — the SAME budget the router's direct-peer git_status probe uses. Previously this
// was a hard-coded 45_000 while the probe path was env-overridable, so setting the
// env tuned the probe but silently left this dispatch path at 45s (a silent
// asymmetry). They now move together.
const DISPATCH_CONNECT_TIMEOUT_MS = MESH_CONNECT_TIMEOUT_MS;

// Fail-loud (throttled) trace for a remote dispatch that ran with NO live mesh
// connection getter wired — the same degraded-warmup misconfiguration the git probe
// path warns about. Warn once per peer; resolveWarmupDeadlineOpts then falls back to
// the conservative combined budget instead of silently assuming "always warm".
const dispatchWarmupGetterMissingWarned = new Set<string>();
function warnDispatchWarmupGetterMissingOnce(daemonId: string): void {
    if (dispatchWarmupGetterMissingWarned.has(daemonId)) return;
    dispatchWarmupGetterMissingWarned.add(daemonId);
    LOG.warn('MeshQueue', `Mesh peer connection getter unavailable for ${String(daemonId).slice(0, 12)}; remote task-dispatch warmup deadline degraded to the combined connect+response window. Avoids a cold-open false-timeout but loses warm/cold precision — wire getMeshPeerConnectionStatus on this daemon.`);
}

interface DeliverTaskContext {
    meshId: string;
    nodeId: string;
    sessionId: string;
    providerType: string;
    task: MeshWorkQueueEntry;
    transport: 'remote' | 'local';
    sourceCoordinatorSessionId?: string;
    sourceCoordinatorDaemonId?: string;
    // LEDGER-TASK-TRACEABILITY (A): routing rationale to record on task_dispatched.
    routingDecision?: MeshTaskRoutingDecision;
    // COORD-NOTIFY-STUCK: carried so a dispatch failure in the catch below can look up
    // the target node's other live sessions for the coordinator notification without
    // threading a second parameter through deliverTaskToSession.
    components: DaemonComponents;
    /** TURN-LEDGER (C2): the attempt this dispatch delivers (absent without a wired ledger). */
    attemptRef?: TurnAttemptRef;
}

// ── TURN-LEDGER evidence (wiring-unification C2/C4, C-W4) ─────────────────────
// The claim/dispatch path no longer writes attempt rows itself (the legacy
// openTurnAttempt / recordTurnAck / closeAttemptForReassignment /
// rebindAttemptToLiveHolder calls are retired). It reports what it observed —
// dispatch_accepted, delivered, dispatch_failed, duplicate_dispatch_refusal —
// and the ledger's reducer decides: R1 opens the attempt with its
// await_delivery + hard_ceiling holds, R2 binds the delivering session, R24
// reclaims (queue row → pending is a commit effect), R25 rebinds to the live
// holder. Without a wired ledger the post-dispatch evidence helpers below are
// no-ops, but `tryAssignQueueTask` itself REFUSES the claim (fail closed, WARN)
// — a queue dispatch with no attempt can never be closed (rc.39).

/** The daemon's turn ledger, as the boot stage puts it on `components` (C-W3). */
export function turnLedgerOf(components: DaemonComponents | undefined): TurnLedger | null {
    return components?.turnLedger ?? null;
}

function observeDispatchEvidence(components: DaemonComponents, evidence: TurnEvidence): void {
    const ledger = turnLedgerOf(components);
    if (!ledger) {
        // Unreachable through a claim (tryAssignQueueTask refuses without a ledger),
        // so this is a caller handing a components look-alike — say so, loudly.
        LOG.warn('TurnLedger', `dropping dispatch evidence ${evidence.kind} ${evidence.eventId}: no turn ledger on the components passed in (look-alike components?)`);
        return;
    }
    try {
        const result = ledger.observe(evidence);
        if (result.verdict === 'rejected') {
            LOG.warn('TurnLedger', `dispatch evidence ${evidence.kind} ${evidence.eventId} rejected (${result.rejection ?? 'unknown'})`);
        }
    } catch (e: any) {
        LOG.error('TurnLedger', `dispatch evidence ${evidence.kind} ${evidence.eventId} failed: ${e?.message || e}`);
    }
}

function dispatchEvidenceBase(ctx: Pick<DeliverTaskContext, 'sessionId' | 'task' | 'attemptRef'>, source: 'dispatch' | 'input_service'): Omit<TurnEvidence, 'kind' | 'eventId'> {
    return {
        at: Date.now(),
        source,
        sessionId: ctx.sessionId,
        ...(ctx.attemptRef ? { attemptRef: ctx.attemptRef } : { taskId: ctx.task.id }),
        observedBy: localCoordinatorDaemonId() || 'local',
    } as Omit<TurnEvidence, 'kind' | 'eventId'>;
}

// Readiness barrier for the LOCAL auto-launch path. A just-spawned CLI session is
// not interactive until its PTY prints the input prompt (the adapter flips
// isReady() / settles to idle ~2-6s later). Poll the local adapter until it reports
// ready (or idle), bounded by a generous timeout so a slow/contended boot still
// lands, and a hard cap so a session that never becomes interactive doesn't block the
// reconcile loop forever (the adapter's queue-until-ready path is the backstop then).
const LOCAL_LAUNCH_READY_TIMEOUT_MS = 15_000;
const LOCAL_LAUNCH_READY_POLL_MS = 100;

export async function waitForLocalSessionReady(components: DaemonComponents, sessionId: string): Promise<void> {
    const adapter = components.cliManager?.adapters?.get(sessionId) as
        | { isReady?: () => boolean; currentStatus?: string }
        | undefined;
    // No locally-resolvable adapter (e.g. a remote/forwarded session that somehow
    // reached this branch) → nothing to wait on; let dispatch proceed.
    if (!adapter || typeof adapter.isReady !== 'function') return;
    const deadline = Date.now() + LOCAL_LAUNCH_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (adapter.isReady() || adapter.currentStatus === 'idle') return;
        await new Promise<void>(resolve => setTimeout(resolve, LOCAL_LAUNCH_READY_POLL_MS));
    }
    LOG.warn('MeshQueue', `Auto-launched session ${sessionId} not interactive after ${LOCAL_LAUNCH_READY_TIMEOUT_MS}ms; dispatching anyway (adapter queue-until-ready will buffer)`);
}

/**
 * REMOTE-READY-WAIT: bind the remote readiness barrier (mesh-remote-ready-wait.ts) to this
 * daemon's remote-idle registry — the place a forwarded `agent:ready` actually lands.
 * The budget and the timeout semantics live in that module; this only supplies the probe.
 */
export function remoteSessionReadyProbe(meshId: string, nodeId: string, sessionId: string): () => boolean {
    return () => MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
        // sessionIdsEquivalent / meshNodeIdMatches rather than raw ===: both ids reach this
        // store through several serialization forms, and a raw comparison here is exactly the
        // canon-identity defect class that check:canon-identity exists to catch.
        .some(s => sessionIdsEquivalent(s.sessionId, sessionId) && meshNodeIdMatches({ nodeId: s.nodeId }, nodeId));
}

// CONS scope 3: the SINGLE source of truth for dispatching a claimed task to its
// session. The remote (P2P dispatchMeshCommand) and local (router.execute, src:mesh)
// branches differ ONLY in the transport call — the delivery record, the delivered/failed
// transitions, the pending-requeue-on-failure, the dispatch_failed ledger entry, AND the
// Bug B hang timeout are identical and live here once so a future change to the dispatch
// lifecycle cannot drift between the two paths. The caller passes a `dispatchThunk` that
// performs only the transport-specific send and returns its promise.
//
// Cold-open warmup (remote only): the REMOTE transport speaks over a P2P
// DataChannel that may still be opening when the first task is dispatched to a peer.
// When `warmup` is supplied the dispatch is awaited under the warmup-aware deadline
// (mesh-warmup-deadline) — the cold-open handshake is charged to the connect budget
// and only the warm round trip to the DISPATCH_CONFIRM_TIMEOUT_MS response budget —
// so the very first dispatch to a not-yet-open peer is no longer false-timed at the
// combined window. An already-open peer behaves identically to the legacy flat guard
// (response budget governs from t0), so a normal dispatch sees no added latency. The
// LOCAL transport (in-process cliManager) has no channel to warm up and keeps the
// flat Bug B hang guard.
/**
 * LEDGER-TASK-TRACEABILITY (A/D): append a task_dispatched entry from an already-built
 * dispatch context. Reads the execution profile off the claimed task (model/thinking/
 * difficulty/coordinator session were stamped at enqueue/claim) and folds in the caller's
 * routing rationale. Hot-path-safe: no detection, no scoring — everything is precomputed.
 * taskId is promoted to the base field (B) so the row joins the lifecycle by kind+taskId.
 */
function recordTaskDispatchedLedger(ctx: DeliverTaskContext, deliveryId: string): void {
    const task = ctx.task;
    const routing = ctx.routingDecision;
    const routingDecision: Record<string, unknown> = {
        source: routing?.source ?? 'queue',
        selectedNodeId: ctx.nodeId,
        ...(localCoordinatorDaemonId() ? { daemonId: localCoordinatorDaemonId() } : {}),
        transport: ctx.transport,
        // D: resolved execution profile — prefer the caller's resolved values, fall back
        // to what the claimed task row carries (queue/idle drains carry it on the task).
        resolvedProviderType: routing?.resolvedProviderType ?? ctx.providerType,
        ...(routing?.resolvedModel ?? task.model ? { resolvedModel: routing?.resolvedModel ?? task.model } : {}),
        ...(routing?.resolvedThinkingLevel ?? task.thinkingLevel ? { resolvedThinkingLevel: routing?.resolvedThinkingLevel ?? task.thinkingLevel } : {}),
        ...(routing?.resolvedDifficulty ?? task.difficulty ? { resolvedDifficulty: routing?.resolvedDifficulty ?? task.difficulty } : {}),
        ...(typeof routing?.fitnessScore === 'number' ? { fitnessScore: routing.fitnessScore } : {}),
        ...(routing?.selectedSlot ? { selectedSlot: routing.selectedSlot } : {}),
        ...(routing?.skippedCandidates?.length ? { skippedCandidates: routing.skippedCandidates } : {}),
        ...(routing?.skippedCandidatesOmitted ? { skippedCandidatesOmitted: routing.skippedCandidatesOmitted } : {}),
        ...(routing?.requiredTagsResult ? { requiredTagsResult: routing.requiredTagsResult } : {}),
        ...(routing?.quotaRiskSnapshot?.length ? { quotaRiskSnapshot: routing.quotaRiskSnapshot } : {}),
        ...(routing?.quotaRisksOmitted ? { quotaRisksOmitted: routing.quotaRisksOmitted } : {}),
        ...(routing?.intraNodeLosers?.length ? { intraNodeLosers: routing.intraNodeLosers } : {}),
        ...(routing?.intraNodeLosersOmitted ? { intraNodeLosersOmitted: routing.intraNodeLosersOmitted } : {}),
        ...(routing?.selectionTrajectory ? { selectionTrajectory: routing.selectionTrajectory } : {}),
        ...(routing?.reason ? { reason: routing.reason } : {}),
    };
    // REDRIVE-PROVIDER-FLIP (a): if a stranded-reclaim tore an assignment down before this
    // dispatch, fold what it tore down into THIS entry. A redrive re-claims an idle session
    // without recomputing routing, so the provider can change silently; previously the only
    // way to see that was to hand-join two task_dispatched entries and diff providerType.
    // null for an ordinary first dispatch → payload shape unchanged for the common case.
    const redriveProvenance = buildRedriveProvenance(task.lastReclaim, ctx.providerType);
    meshRecord(ctx.meshId, 'task_dispatched', {
        nodeId: ctx.nodeId,
        sessionId: ctx.sessionId,
        providerType: ctx.providerType,
        taskId: task.id,
        payload: {
            taskId: task.id,
            ...(task.missionId ? { missionId: task.missionId } : {}),
            deliveryId,
            transport: ctx.transport,
            ...(ctx.sourceCoordinatorSessionId ? { coordinatorSessionId: ctx.sourceCoordinatorSessionId } : {}),
            ...(ctx.sourceCoordinatorDaemonId ? { coordinatorDaemonId: ctx.sourceCoordinatorDaemonId } : {}),
            ...(Array.isArray(task.requiredTags) && task.requiredTags.length ? { requiredTags: task.requiredTags } : {}),
            routingDecision,
            ...(redriveProvenance ? { redriveProvenance } : {}),
        },
    }, { local: true });
    // A provider-CHANGING redrive additionally gets its own top-level marker, so the flip is
    // greppable and queryable without inspecting every task_dispatched payload. A redrive that
    // kept its provider (the benign majority) writes no extra entry — this must stay a signal,
    // not background noise.
    if (redriveProvenance?.providerChanged) {
        LOG.warn('MeshQueue', describeRedriveProviderFlip(redriveProvenance, task.id, ctx.meshId));
        // A stage, not a drop: nothing was rejected or held — the dispatch DID advance,
        // just onto a provider the original routing did not choose.
        traceMeshEventStage('redrive_provider_changed', {
            taskId: task.id,
            sessionId: ctx.sessionId,
            nodeId: ctx.nodeId,
            meshId: ctx.meshId,
        }, `${redriveProvenance.previousProviderType} → ${redriveProvenance.providerType} (${redriveProvenance.reason}, reclaim #${redriveProvenance.reclaimCount})`);
        try {
            meshRecord(ctx.meshId, 'redrive_provider_changed', {
                nodeId: ctx.nodeId,
                sessionId: ctx.sessionId,
                providerType: ctx.providerType,
                taskId: task.id,
                payload: { taskId: task.id, deliveryId, transport: ctx.transport, ...redriveProvenance },
            }, { local: true });
        } catch { /* best-effort: never fail a dispatch on a diagnostic write */ }
    }
}

export const __recordTaskDispatchedLedgerForTests = recordTaskDispatchedLedger;

export function deliverTaskToSession(
    dispatchThunk: () => Promise<unknown>,
    ctx: DeliverTaskContext,
    warmup?: { daemonId: string; getConnection?: (daemonId: string) => Record<string, unknown> | null },
): void {
    // C-W8: the delivery lifecycle lives on the turn ledger attempt (`delivered`
    // / `duplicate_dispatch_refusal` / `dispatch_failed` evidence below); the
    // legacy session-delivery table row is retired. The id survives only as
    // this dispatch's correlation key (evidence event ids, ledger payloads).
    const delivery = { id: `dlv-${randomUUID()}` };

    // LEDGER-TASK-TRACEABILITY (A): record the dispatch — the single funnel every
    // queue-claim dispatch (local + remote) flows through — so mesh_task_history and the
    // dashboard can show "which device/daemon/provider/model, via what path, and why".
    // All routing values are ALREADY computed by the caller (no re-serialization on the
    // hot path); the delivery id links this to the delivered/failed transitions below.
    try {
        recordTaskDispatchedLedger(ctx, delivery.id);
    } catch { /* ledger write is best-effort — dispatch proceeds regardless */ }

    // Invoke the transport synchronously (preserves the prior fire-and-forget timing,
    // and lets a synchronous throw fall into the same failure path as a rejection).
    let dispatchPromise: Promise<unknown>;
    try {
        dispatchPromise = Promise.resolve(dispatchThunk());
    } catch (e) {
        dispatchPromise = Promise.reject(e);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let guarded: Promise<unknown>;
    if (warmup) {
        // Remote P2P: cold-open-aware deadline. awaitWithWarmupDeadline owns its own
        // timers (so `timer` stays undefined and the clearTimeout below is a no-op),
        // and rejects with Error('timeout') when either budget lapses — the same
        // retryable failure shape the catch below already handles (requeue + ledger).
        guarded = awaitWithWarmupDeadline(dispatchPromise, resolveWarmupDeadlineOpts({
            getConnection: warmup.getConnection,
            daemonId: warmup.daemonId,
            connectTimeoutMs: DISPATCH_CONNECT_TIMEOUT_MS,
            responseTimeoutMs: DISPATCH_CONFIRM_TIMEOUT_MS,
            onMissingGetter: warnDispatchWarmupGetterMissingOnce,
        }));
    } else {
        guarded = Promise.race([
            dispatchPromise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`dispatch_confirm_timeout after ${DISPATCH_CONFIRM_TIMEOUT_MS}ms`)),
                    DISPATCH_CONFIRM_TIMEOUT_MS,
                );
                // Never keep the process alive solely for this confirm-timeout timer.
                if (typeof (timer as { unref?: () => void })?.unref === 'function') (timer as { unref: () => void }).unref();
            }),
        ]);
    }

    guarded.then((res: any) => {
        if (timer) clearTimeout(timer);
        // REFUSAL-BOOKED-AS-DELIVERED: a non-throwing answer is not automatically a
        // successful delivery. Some `agent_command` refusals RESOLVE with
        // `{ success: false, code, … }` instead of throwing — e.g. mesh_node_bootstrap_pending
        // (commands/med-family/cli-agent.ts) and the mesh-sender gate's whole
        // mesh_sender_not_session_coordinator family (commands/mesh-sender.ts
        // meshSenderRefusalResult — DaemonCommandRouter.execute returns this as a normal
        // result, never a throw, so it crosses the P2P RPC envelope as a genuine response).
        // Unwrap through the shared boundary reader (handles that envelope / IPC wrapping
        // too) and treat an explicit `success === false` (or an object answer that fails to
        // carry a boolean `success` at all — relay_result_malformed) as a dispatch FAILURE,
        // exactly like a thrown rejection: it goes through the same handleDispatchFailure
        // path (duplicate-refusal rebind, retry/requeue, ledger) — so a refusal that throws
        // on one transport and resolves on another (or changes tomorrow) is booked
        // identically either way. A non-object / undefined answer (legacy transports) keeps
        // the prior behavior — that is not an application-level answer to unwrap, just an ack.
        if (res && typeof res === 'object' && !Array.isArray(res)) {
            const unwrapped = unwrapMeshRelayResult(res, { command: 'agent_command', peerDaemonId: ctx.transport === 'remote' ? ctx.nodeId : undefined });
            if (unwrapped.success === false) {
                handleDispatchFailure(unwrapped, ctx, delivery);
                return;
            }
        }
        const isQueued = res && typeof res === 'object' && res.status === 'queued';
        // TURN-LEDGER (C2): the transport confirm IS the delivered evidence (R2
        // binds the attempt to this session and arms await_consume / await_turn).
        // A QUEUED result is a positive receipt too — the adapter buffered the
        // prompt for this session — and carries `outcome:'queued'` so the two
        // stay distinguishable in the evidence row.
        if (ctx.attemptRef) {
            observeDispatchEvidence(ctx.components, {
                ...dispatchEvidenceBase(ctx, 'dispatch'),
                eventId: `dispatch-ack:${ctx.attemptRef.attemptId}:g${ctx.attemptRef.generation}:${delivery.id}`,
                kind: 'delivered',
                messageId: dispatchMessageId(ctx.task),
                outcome: isQueued ? 'queued' : 'delivered',
                via: ctx.transport === 'remote' ? 'p2p' : 'local',
            } as TurnEvidence);
        }
    }).catch((e: any) => {
        if (timer) clearTimeout(timer);
        handleDispatchFailure(e, ctx, delivery);
    });
}

/**
 * Shared dispatch-failure handling for `deliverTaskToSession` — reached from both the
 * `.catch()` (a thrown/rejected send) and the `.then()` (a resolved `{success:false}`
 * refusal answer, see REFUSAL-BOOKED-AS-DELIVERED above) so the two arms cannot drift:
 * a refusal is booked exactly like a throw, never as `delivered`.
 */
function handleDispatchFailure(rawFailure: any, ctx: DeliverTaskContext, delivery: { id: string }): void {
    // REFUSAL-BOOKED-AS-DELIVERED: a resolved `{success:false, code, error/reason}`
    // answer (no `.message`, unlike a thrown Error) reaches this function too — see the
    // `.then()` unwrap above. Normalize it to the `{message}` shape every branch below
    // already reads, without touching what a genuine thrown Error carries (`e` stays
    // that same object so `.code`/`.retryRecommended`/`.recoverable` reads below are
    // unaffected either way).
    const isApplicationRefusal = !!rawFailure && typeof rawFailure === 'object' && rawFailure.success === false;
    const e: any = isApplicationRefusal && typeof rawFailure.message !== 'string'
        ? {
            ...rawFailure,
            message: rawFailure.error || rawFailure.reason || rawFailure.code
                ? `${rawFailure.code ? `${rawFailure.code}: ` : ''}${rawFailure.error || rawFailure.reason || 'agent_command refused the dispatch'}`
                : 'agent_command refused the dispatch',
        }
        : rawFailure;
    {
        // DUP-CLAIM-REBIND: not every rejection is a dispatch FAILURE. When the node
        // refuses because it is ALREADY working this exact task on another live session,
        // that is an application-level answer — the work is running, it is simply running
        // somewhere other than the session this attempt was opened against. (The race: an
        // auto fast-forward defers a claim, and the re-fired claim pulls a task the original
        // session has meanwhile started.) The old code treated this identically to a
        // transport failure: it cancelled the attempt, which left the ledger bound to a
        // session doing nothing, so the real holder's completion was later rejected as
        // session_mismatch and a FINISHED task was recorded as lost.
        //
        // Correct the binding instead. Keep the task assigned (it is genuinely in flight),
        // leave the attempt open, and re-point it at the live holder the worker named — the
        // holder's completion then satisfies the session_mismatch check on the merits. The
        // duplicate-dispatch guard itself is untouched: refusing the second injection is
        // exactly right, and this changes only how the coordinator books that refusal.
        //
        // Strictly gated: `classifyDuplicateMeshDispatch` matches only the typed error /
        // structured wire code (never the message text), and the rebind is skipped unless a
        // holder session was actually named. Anything else falls through to the failure path
        // below unchanged — a blanket rebind on arbitrary errors would let a STALE session's
        // completion be accepted, which is precisely what session_mismatch must keep out.
        const duplicate = classifyDuplicateMeshDispatch(e);
        if (duplicate?.holderSessionId) {
            // DUP-CLAIM-REBIND / DUP-REFUSAL-IS-CONSUMPTION: the node refused because a
            // live session is ALREADY working this exact task — the prompt was taken
            // up. Not a dispatch failure: the task stays assigned.
            LOG.info('MeshQueue', `Duplicate dispatch of task ${ctx.task.id} refused by node ${ctx.nodeId}: it is already being worked by live session ${duplicate.holderSessionId}. Task stays assigned${ctx.attemptRef ? `; attempt ${ctx.attemptRef.attemptId} rebinds to that session` : ''}.`);
            // DUP-REFUSAL-IS-CONSUMPTION (attempt half, C2): duplicate_dispatch_refusal
            // naming THIS attempt as the holder → R25 rebinds the attempt to the
            // holder session AND marks it consumed in one reducer step (the old
            // rebind-then-promote ordering is now a single transition).
            if (ctx.attemptRef) {
                observeDispatchEvidence(ctx.components, {
                    ...dispatchEvidenceBase(ctx, 'dispatch'),
                    eventId: `dispatch-dup:${ctx.attemptRef.attemptId}:g${ctx.attemptRef.generation}:${delivery.id}`,
                    kind: 'duplicate_dispatch_refusal',
                    holderSessionId: duplicate.holderSessionId,
                    holderAttemptId: ctx.attemptRef.attemptId,
                } as TurnEvidence);
            }
            try {
                meshRecord(ctx.meshId, 'dispatch_duplicate_rebound', {
                    nodeId: ctx.nodeId,
                    sessionId: duplicate.holderSessionId,
                    payload: {
                        taskId: ctx.task.id,
                        deliveryId: delivery.id,
                        transport: ctx.transport,
                        attemptedSessionId: ctx.sessionId,
                        holderSessionId: duplicate.holderSessionId,
                        ...(ctx.attemptRef ? { attemptId: ctx.attemptRef.attemptId } : {}),
                        rebound: true,
                    },
                }, { local: true });
            } catch { /* ledger write is best-effort */ }
            return;
        }
        // A dispatch failure (transport reject OR hang timeout) is most often transient —
        // a busy/refusing adapter, or a relay that never acked — not a permanent task
        // failure. Marking the task terminal here would permanently kill tasks a later
        // tick delivers fine. Return it to 'pending' and record a retryable dispatch_failed
        // ledger entry so the reconcile loop re-dispatches it. Identical for both transports.
        // Live-gap fix (2026-09-25): name the worker's own refusal code + detail, not just
        // "refused" — this is the one WARN line an operator/coordinator actually sees for
        // WHY (session_busy_with_task, mesh_sender_not_on_roster, mesh_node_bootstrap_pending,
        // provider_quota_exhausted, …), matching the equivalent line the direct-dispatch path
        // (mesh-tools-session.ts observeDirectDispatchOutcome) now emits.
        const applicationRefusalCode = isApplicationRefusal ? sanitizeRefusalCode(rawFailure?.code) : undefined;
        if (isApplicationRefusal) {
            LOG.warn('MeshQueue', `dispatch to ${ctx.nodeId} refused by worker: ${applicationRefusalCode ?? rawFailure?.code ?? 'unknown'}`
                + (typeof rawFailure?.error === 'string' && rawFailure.error ? ` — ${rawFailure.error.slice(0, 200)}` : ''));
        }
        LOG.error('MeshQueue', `Failed to dispatch task via ${ctx.transport} to node ${ctx.nodeId}: ${e?.message}`);
        // The dispatch failed — the task is no longer in-flight (it returns to pending
        // for a clean re-dispatch). Clear the single-flight mark so a legitimate
        // requeue/re-claim is not blocked as if a worker were still generating.
        endTaskDispatchInFlight(ctx.meshId, ctx.task.id);
        const retryable = isRetryableDispatchFailure(e);
        if (ctx.attemptRef) {
            // TURN-LEDGER (C2): the dispatch never reached the worker. The reducer
            // owns what happens to the attempt AND the queue row:
            //   retryable     → dispatch_failed → R24 reclaim (generation + 1, the
            //                   row back to `pending` as a commit effect; the reclaim
            //                   budget bounds the loop — DEAD-DISPATCH-BOUND);
            //   unrecoverable → session_error{spawn_failed} → R21 commit failed
            //                   (a self-dial re-runs an identical decision — retrying
            //                   is provably pointless).
            // The DISPATCH-BOOT-RACE backoff is kept as queue metadata only
            // (notBefore on the now-pending row); it never makes a terminal decision.
            const gen = `${ctx.attemptRef.attemptId}:g${ctx.attemptRef.generation}:${delivery.id}`;
            observeDispatchEvidence(ctx.components, {
                ...dispatchEvidenceBase(ctx, 'dispatch'),
                eventId: `dispatch-failed:${gen}`,
                kind: 'dispatch_failed',
                // REFUSAL-BOOKED-AS-DELIVERED: an application-level `{success:false}` answer
                // is the worker actively refusing the dispatch, not a transport failure — the
                // worker unambiguously WAS reached, so it is never `workerAbsent`, and the
                // typed reason is `rejected_by_worker` (never the message-text sniff below,
                // which only classifies genuine thrown transport/timeout errors).
                workerAbsent: isApplicationRefusal ? false : /timeout|not.?found|no adapter|unreachable|offline/i.test(String(e?.message ?? '')),
                reason: isApplicationRefusal ? 'rejected_by_worker' : (/timeout/i.test(String(e?.message ?? '')) ? 'timeout' : 'transport_error'),
                // Live-gap fix (2026-09-25): the worker's own refusal code, sanitized to the
                // closed id-like shape the content-free evidence contract requires (see
                // turn-evidence.ts `dispatch_failed.refusalCode` doc comment) — never the free-text
                // `error`/`reason` message, which stays local to the WARN line above only.
                ...(applicationRefusalCode ? { refusalCode: applicationRefusalCode } : {}),
            } as TurnEvidence);
            if (!retryable) {
                LOG.error('MeshQueue', `Task ${ctx.task.id} (mesh ${ctx.meshId}) is undeliverable to node ${ctx.nodeId} (session ${ctx.sessionId ?? '?'}) and will NOT be retried: dispatch_unrecoverable: ${e?.message || 'transport reported the failure as non-recoverable'}`);
                const failRef = turnLedgerOf(ctx.components)?.getAttempt(ctx.attemptRef.attemptId);
                observeDispatchEvidence(ctx.components, {
                    ...dispatchEvidenceBase({ ...ctx, attemptRef: failRef ? { attemptId: failRef.attemptId, generation: failRef.generation } : ctx.attemptRef }, 'dispatch'),
                    eventId: `dispatch-unrecoverable:${gen}`,
                    kind: 'session_error',
                    reason: 'spawn_failed',
                } as TurnEvidence);
            } else {
                try { applyDispatchFailureBackoff(ctx.meshId, ctx.task.id); } catch { /* backoff is advisory */ }
                const requeued = MeshRuntimeStore.getInstance().findQueueEntryById(ctx.meshId, ctx.task.id);
                if (requeued?.status === 'pending' && readText(requeued.targetSessionId)) {
                    notifyCoordinatorOfPinnedDispatchFailure(ctx.components, {
                        meshId: ctx.meshId,
                        taskId: ctx.task.id,
                        targetSessionId: requeued.targetSessionId!,
                        nodeId: ctx.nodeId,
                        error: e?.message,
                        sourceCoordinatorSessionId: ctx.sourceCoordinatorSessionId,
                        sourceCoordinatorDaemonId: ctx.sourceCoordinatorDaemonId,
                    });
                }
            }
        } else if (!retryable) {
            // No ledger wired (unit fixtures): queue bookkeeping only.
            failTaskAsUndeliverable(ctx, `dispatch_unrecoverable: ${e?.message || 'transport reported the failure as non-recoverable'}`);
        } else {
            // DISPATCH-BOOT-RACE: the dispatch-failure axis, never requeueCount — the
            // worker never started this task. Carries the escalating notBefore backoff.
            const requeued = requeueTask(ctx.meshId, ctx.task.id, {
                reason: 'dispatch_failed',
                clearTargetSession: false,
                dispatchFailure: true,
            });
            if (requeued?.status === 'failed') {
                LOG.error('MeshQueue', `Task ${ctx.task.id} (mesh ${ctx.meshId}) failed after repeated dispatch failures to node ${ctx.nodeId} — the worker never started it: ${requeued.cancelReason || 'dispatch_never_started'}. Dependents were unblocked.`);
            } else if (requeued?.status === 'pending' && readText(requeued.targetSessionId)) {
                // COORD-NOTIFY-STUCK: the row is back to 'pending' STILL PINNED — page the
                // coordinator now rather than let it re-target the same dead session.
                notifyCoordinatorOfPinnedDispatchFailure(ctx.components, {
                    meshId: ctx.meshId,
                    taskId: ctx.task.id,
                    targetSessionId: requeued.targetSessionId!,
                    nodeId: ctx.nodeId,
                    error: e?.message,
                    sourceCoordinatorSessionId: ctx.sourceCoordinatorSessionId,
                    sourceCoordinatorDaemonId: ctx.sourceCoordinatorDaemonId,
                });
            }
        }
        try {
            // 'dispatch_failed' is a real MeshLedgerKind in the task-lifecycle set, so
            // meshRecord derives the top-level taskId from payload.taskId below. It spent
            // its whole life as `as any` — off the union, hence off the lifecycle set,
            // hence written with a NULL task_id and unreachable by the kind+taskId join
            // every reader uses. Do not reintroduce the cast.
            meshRecord(ctx.meshId, 'dispatch_failed', {
                nodeId: ctx.nodeId,
                sessionId: ctx.sessionId,
                payload: { taskId: ctx.task.id, deliveryId: delivery.id, error: e?.message, retryable, transport: ctx.transport },
            }, { local: true });
        } catch { /* ledger write is best-effort */ }
    }
}

/**
 * DEAD-DISPATCH-BOUND: terminate a task whose dispatch can never succeed.
 *
 * Used for the two provably-unrecoverable cases: a transport that classified its own
 * failure as non-recoverable (self-dial), and a pre-dispatch target that is absent from
 * the live mesh. Both would otherwise re-claim and re-fail on every drain forever.
 *
 * Fails the row directly rather than through requeueTask's budget because there is no
 * point spending retries on a destination that cannot answer; cascading to dependents
 * matches what the retry-cap path does, so a blocked chain unblocks either way.
 */
function failTaskAsUndeliverable(ctx: Pick<DeliverTaskContext, 'meshId' | 'nodeId' | 'sessionId' | 'task'>, reason: string): void {
    // maxRetries:0 makes requeueTask's own cap trip immediately, so the row lands terminal
    // ('failed' + max_retries_exceeded) and cascades to dependents through exactly the same
    // code path as an exhausted retry budget — no second terminal-transition mechanism to
    // keep in sync, and the reason string below records WHY it skipped the budget.
    try {
        const failed = requeueTask(ctx.meshId, ctx.task.id, { maxRetries: 0, reason, clearTargetSession: false });
        if (!failed) return; // row already gone/terminal — nothing to fail
    } catch (err: any) {
        LOG.warn('MeshQueue', `Failed to mark undeliverable task ${ctx.task.id} (mesh ${ctx.meshId}) terminal: ${err?.message || err}`);
        return;
    }
    LOG.error('MeshQueue', `Task ${ctx.task.id} (mesh ${ctx.meshId}) is undeliverable to node ${ctx.nodeId} (session ${ctx.sessionId ?? '?'}) and will NOT be retried: ${reason}`);
    try {
        meshRecord(ctx.meshId, 'task_failed', {
            nodeId: ctx.nodeId,
            sessionId: ctx.sessionId,
            payload: { taskId: ctx.task.id, reason, undeliverable: true },
        }, { local: true });
    } catch { /* ledger write is best-effort */ }
}

/**
 * Is a dispatch failure worth re-dispatching?
 *
 * Most transport failures ARE transient (a busy adapter, a relay that never acked), so
 * the default stays `true` — the reconcile loop re-dispatches and the task lands on a
 * later tick. But a structured relay failure can say otherwise: the transport layer
 * classifies a self-dial (routing decided "remote" for THIS daemon) as definitively
 * non-recoverable, because a retry re-runs the identical decision on identical inputs
 * and fails identically. Booking that as retryable is what let dispatchNonce climb
 * without ever converging.
 *
 * Reads the flags defensively: an older daemon-cloud (or a plain Error) carries neither
 * field, and `undefined` must keep the permissive legacy behavior rather than silently
 * marking real transients terminal.
 */
function isRetryableDispatchFailure(e: any): boolean {
    if (e && typeof e === 'object') {
        if (e.retryRecommended === false) return false;
        if (e.recoverable === false) return false;
    }
    return true;
}
