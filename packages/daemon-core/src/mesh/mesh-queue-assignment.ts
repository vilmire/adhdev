import { existsSync } from 'fs';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { MESH_CONNECT_TIMEOUT_MS } from '../runtime-defaults.js';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { detectCLI } from '../detection/cli-detector.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, claimNextTask, updateTaskStatus, getQueue, recordTaskAutoLaunch, getActiveDirectDispatches } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { fastForwardMeshNode } from './mesh-fast-forward.js';
import { createSessionDelivery, updateSessionDeliveryStatus } from './mesh-delivery-policy.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { traceMeshEventDrop } from './mesh-event-trace.js';
import { awaitWithWarmupDeadline, resolveWarmupDeadlineOpts } from './mesh-warmup-deadline.js';
import { resolveDelegatedWorkerAutoApprove, resolveProviderMaxParallel, resolveNodeSchedulingPriority, normalizeMeshSchedulingStrategy, resolveMaxParallelTasks, resolveMaxReadonlyParallelTasks, distributionToStrategy } from '../repo-mesh-types.js';
import type { RepoMeshSchedulingStrategy } from '../repo-mesh-types.js';
import { loadMeshJsonConfig, type MeshJsonSchedulingConfig } from '../config/mesh-json-config.js';
import { normalizeMeshNodeId, meshNodeIdMatches, daemonIdsEquivalent, normalizeMeshWorkspaceForCompare, meshWorkspacesEquivalent, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import { findTerminalLedgerEvidenceForTask, hasUnterminalDirectDispatchLedgerEntry } from './mesh-events-stale.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { isWorktreeBootstrapStaleRunning } from './worktree-bootstrap-config.js';

// ---------------------------------------------------------------------------
// Idle auto fast-forward throttle state
// ---------------------------------------------------------------------------
const IDLE_AUTO_FAST_FORWARD_THROTTLE_MS = 30 * 60 * 1000;
const idleAutoFastForwardLastAttempt = new Map<string, number>();

export function __resetIdleAutoFastForwardForTests(): void {
    idleAutoFastForwardLastAttempt.clear();
}

export function getMeshWithCache(components: DaemonComponents, meshId: string): any | undefined {
    const localMesh = getMesh(meshId);
    const cachedMesh = components.router?.getCachedInlineMesh(meshId);
    if (!localMesh) return cachedMesh;
    if (!cachedMesh) return localMesh;
    return mergeInlineCacheOnlyNodes(localMesh, cachedMesh);
}

/**
 * Claim-time membership view unification (CLAIMSTALL fix).
 *
 * The coordinator's claim path — triggerMeshQueue → autoLaunch candidate filter
 * and the local/remote idle-session drain — reads mesh membership through
 * getMeshWithCache, which historically returned the local-config mesh verbatim
 * whenever one existed. A freshly cloned worktree node is registered ONLY into the
 * router's inline mesh cache: clone_mesh_node's `meshRecord.inline` branch calls
 * updateInlineMeshNode, NOT addNode, so the worktree node never reaches local
 * config (meshes.json). The config-first view therefore omits the worktree node,
 * while send_task — which resolves membership through getMeshForCommand(preferInline)
 * over the same inline cache — sees it. That view asymmetry is the stall: a queue
 * task pinned to the worktree node reports `target_node_id_unmatched` (autoLaunch
 * candidate filter / targetPinUnmatched check) and the node's idle session is
 * dropped from the drain pool (mesh.nodes.find miss), so claim never fires and the
 * task is stranded pending — even though nodeId matching itself is correct.
 *
 * Fix: union the local-config nodes with any inline-cache-ONLY nodes, so the claim
 * view matches the command (send_task) view. Base (non-worktree) nodes present in
 * local config stay config-authoritative — their entry is taken verbatim from
 * localMesh, so base node claim/matching is byte-for-byte unchanged. Only nodes
 * that exist solely in the inline cache (the cloned worktree nodes) are appended.
 * Identity comparison uses the shared 3-form normalizer (id / nodeId / node_id),
 * identical to every other claim-path consumer — the matching logic is untouched,
 * only which nodes are visible.
 */
function mergeInlineCacheOnlyNodes(localMesh: any, cachedMesh: any): any {
    const localNodes = Array.isArray(localMesh?.nodes) ? localMesh.nodes : [];
    const cachedNodes = Array.isArray(cachedMesh?.nodes) ? cachedMesh.nodes : [];
    if (!cachedNodes.length) return localMesh;
    const cacheOnly = cachedNodes.filter((cachedNode: any) => {
        const cachedId = readMeshNodeId(cachedNode);
        // Unidentifiable cache entries can never be a claim/route target — skip them
        // rather than appending junk that no consumer can address.
        if (!cachedId) return false;
        return !localNodes.some((localNode: any) => meshNodeIdMatches(localNode, cachedId));
    });
    if (!cacheOnly.length) return localMesh;
    return { ...localMesh, nodes: [...localNodes, ...cacheOnly] };
}

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
}

// Readiness barrier for the LOCAL auto-launch path. A just-spawned CLI session is
// not interactive until its PTY prints the input prompt (the adapter flips
// isReady() / settles to idle ~2-6s later). Poll the local adapter until it reports
// ready (or idle), bounded by a generous timeout so a slow/contended boot still
// lands, and a hard cap so a session that never becomes interactive doesn't block the
// reconcile loop forever (the adapter's queue-until-ready path is the backstop then).
const LOCAL_LAUNCH_READY_TIMEOUT_MS = 15_000;
const LOCAL_LAUNCH_READY_POLL_MS = 100;

async function waitForLocalSessionReady(components: DaemonComponents, sessionId: string): Promise<void> {
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

// CONS scope 3: the SINGLE source of truth for dispatching a claimed task to its
// session. The remote (P2P dispatchMeshCommand) and local (cliManager.handleCliCommand)
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
function deliverTaskToSession(
    dispatchThunk: () => Promise<unknown>,
    ctx: DeliverTaskContext,
    warmup?: { daemonId: string; getConnection?: (daemonId: string) => Record<string, unknown> | null },
): void {
    const delivery = createSessionDelivery({
        meshId: ctx.meshId,
        nodeId: ctx.nodeId,
        sessionId: ctx.sessionId,
        providerType: ctx.providerType,
        taskId: ctx.task.id,
        kind: 'task',
        message: ctx.task.message,
        status: 'delivering',
        ...(ctx.sourceCoordinatorSessionId ? { sourceCoordinatorSessionId: ctx.sourceCoordinatorSessionId } : {}),
        ...(ctx.sourceCoordinatorDaemonId ? { sourceCoordinatorDaemonId: ctx.sourceCoordinatorDaemonId } : {}),
    });

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

    guarded.then(() => {
        if (timer) clearTimeout(timer);
        updateSessionDeliveryStatus(delivery.id, 'delivered');
    }).catch((e: any) => {
        if (timer) clearTimeout(timer);
        // A dispatch failure (transport reject OR hang timeout) is most often transient —
        // a busy/refusing adapter, or a relay that never acked — not a permanent task
        // failure. Marking the task terminal here would permanently kill tasks a later
        // tick delivers fine. Return it to 'pending' and record a retryable dispatch_failed
        // ledger entry so the reconcile loop re-dispatches it. Identical for both transports.
        LOG.error('MeshQueue', `Failed to dispatch task via ${ctx.transport} to node ${ctx.nodeId}: ${e?.message}`);
        updateSessionDeliveryStatus(delivery.id, 'failed', { lastError: e?.message, incrementAttempt: true });
        updateTaskStatus(ctx.meshId, ctx.task.id, 'pending');
        try {
            appendLedgerEntry(ctx.meshId, {
                kind: 'dispatch_failed' as any,
                nodeId: ctx.nodeId,
                sessionId: ctx.sessionId,
                payload: { taskId: ctx.task.id, deliveryId: delivery.id, error: e?.message, retryable: true, transport: ctx.transport },
            });
        } catch { /* ledger write is best-effort */ }
    });
}

// WTCLAIM: workspace normalization for base-vs-worktree comparison now lives in
// @adhdev/mesh-shared (normalizeMeshWorkspaceForCompare) so the enqueue→claim path,
// the mesh_status per-node session filter, and the read_chat node scope guard all
// share one comparison rule instead of drifting module-private copies.

export function tryAssignQueueTask(
    components: DaemonComponents,
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string
): boolean {
    const mesh = getMeshWithCache(components, meshId);
    // Match with the shared 3-form normalizer (id / nodeId / node_id), not raw
    // `n.id` — a stamp-form nodeId vs the mesh node's config-form id must still
    // resolve, mirroring the remote idle-session path below (:1341).
    const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, nodeId));

    // WORKTREE-CLAIM-GATE-BYPASS: the SINGLE claim-time gate for the worktree-bootstrap defer.
    // tryAssignQueueTask is the one funnel every claim path flows through — the event-driven
    // agent:ready drain, the triggerMeshQueue idle-session drain (local + remote), the
    // auto-launch claim, and the PHASE 3 reconcile re-drain all call it. The agent:ready handler
    // (mesh-event-forwarding) deferred its OWN claim while a worktree node's bootstrap was still
    // 'running', but it ALSO called setRemoteIdleSession first — registering the session as a
    // claim candidate. A concurrent triggerMeshQueue drain then pulled that candidate and claimed
    // through tryAssignQueueTask within ~0.16s, BYPASSING the event-handler-local defer: the task
    // dispatched into a half-built worktree (native addons not yet installed → child daemon dies
    // → empty session, totalMessages=0). The transport ack returns ok:true, so neither the
    // assigned-stranded watchdog nor the pending-only PHASE 3 reconcile ever re-fires it → the
    // session is stranded empty forever.
    //
    // Lowering the gate HERE makes the defer a property of the claim itself, not of one caller:
    // a worktree node whose bootstrap is still 'running' can never be claimed from any path. The
    // task stays pending (we return false WITHOUT touching its status — no fail/cancel), so the
    // bootstrap_complete refire (triggerMeshQueue re-fired on worktree_bootstrap_complete) re-runs
    // this claim and passes once status is no longer 'running'. The registered remote-idle session
    // persists for REMOTE_IDLE_SESSION_TTL_MS (5min > observed ~2m8s bootstrap), so the refire
    // still finds a live candidate to re-claim. Identity uses meshNodeIdMatches (the same shared
    // 3-form normalizer the defer guard uses), never a raw === — canon-identity regression guard.
    // Conservative: any non-'running' status (idle/complete/failed/absent/unknown) does NOT gate,
    // so a base node and a fully-bootstrapped worktree keep prior behavior exactly.
    if ((node as { worktreeBootstrap?: { status?: string } } | undefined)?.worktreeBootstrap?.status === 'running') {
        // Fix (3) safety net: a 'running' bootstrap that is far older than any real bootstrap AND
        // whose worktree is git-clean is almost certainly one whose terminal-state stamp never
        // reached this daemon — downgrade it so a dispatch is allowed instead of stranded forever.
        // The conservative threshold + git-clean co-requirement prevents downgrading a genuinely
        // in-progress bootstrap (which would re-introduce the half-built-worktree dispatch).
        if (isWorktreeBootstrapStaleRunning(node)) {
            LOG.warn('MeshQueue', `Worktree node ${nodeId} (${sessionId}) bootstrap stuck 'running' beyond the stale backstop and its worktree is git-clean — treating bootstrap as silently complete and allowing the claim (the terminal-state stamp likely never reached this daemon's mesh view)`);
        } else {
            LOG.info('MeshQueue', `Gating queue claim for worktree node ${nodeId} (${sessionId}): worktree bootstrap still running — task left pending; claim re-fires once bootstrap reaches a terminal state (guards against dispatching into a half-built worktree → empty session)`);
            return false;
        }
    }

    // WTCLAIM (fix-B extended to the enqueue→claim path): a base-targeted task must never be
    // claimed by — and dispatched into — a co-located worktree-clone session, nor vice versa.
    // The drain candidate's nodeId is derived from settings.meshNodeId || settings.nodeId
    // (triggerMeshQueue), so a worktree session whose meshNodeId is empty/stale falls back to
    // settings.nodeId = the BASE node id and impersonates the base node here. fix-B's worker-side
    // workspace scope only ran for sessionless dispatch (meshScopeNodeId && !targetSessionId); the
    // claim path ALWAYS carries a targetSessionId, so it never engaged. Apply the same scope here:
    // for a LOCAL claiming session (adapter resolvable on this daemon), require its actual
    // workingDir to match the target node's declared workspace. On a confirmed mismatch, refuse the
    // claim so the task returns to pending for the correctly-scoped session/node to pull. Scoped to
    // local sessions where the workspace is verifiable — a remote session lives on another daemon
    // whose paths we cannot compare here (and remote candidates are already nodeId-matched from
    // getRemoteIdleSessions). Conservative by design: when either workspace is unknown we do NOT
    // skip, so a node with no declared workspace keeps its prior behavior and no legitimate claim
    // is starved.
    // WTDISPATCH (residual of WTCLAIM): the cross-node claim guard must reach EVERY claiming
    // session this daemon can observe — not only those whose adapter happens to be in
    // cliManager.adapters. An auto-launched worker session can carry its node binding on the
    // CLI-instance settings while its session-host record shows no_node_binding, and the
    // event-driven / remote-idle drain (agent:ready → setRemoteIdleSession → tryAssignQueueTask)
    // can pass a nodeId that does NOT belong to the claiming session — a sibling worktree node
    // on the SAME daemon. The adapter-only WTCLAIM check (rc.361/4c5b30b1) never engaged for a
    // session observed solely via instanceManager, so session A could pull node B's task and
    // node A's task was left with no session to claim it (no task_dispatched — it never dispatches).
    //
    // Resolve the claiming session's REAL identity from the adapter workingDir, then fall back to
    // the live CLI instance's workspace + its stamped meshNodeId, and refuse a claim that
    // contradicts EITHER (fail-closed). Reuses the shared meshWorkspacesEquivalent / meshNodeIdMatches
    // comparators — no new comparison logic. Conservative: when neither the workspace NOR the stamp
    // is resolvable we do NOT refuse, so a node with no declared workspace keeps prior behavior and
    // a genuinely remote (cross-daemon) candidate stays nodeId-matched from getRemoteIdleSessions.
    const localClaimAdapter = components.cliManager?.adapters?.get(sessionId) as { workingDir?: string } | undefined;
    let claimInstanceWorkspace = '';
    let claimStampedNodeId = '';
    try {
        const claimState = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
        claimInstanceWorkspace = readNonEmptyString(claimState?.workspace);
        const claimSettings = (claimState?.settings as Record<string, unknown>) || {};
        claimStampedNodeId = readNonEmptyString(claimSettings.meshNodeId);
    } catch { /* best-effort — fall through to the conservative (no refuse) path */ }

    const nodeWorkspaceRaw = readNonEmptyString(node?.workspace);
    const sessionWorkspaceRaw = readNonEmptyString(localClaimAdapter?.workingDir) || claimInstanceWorkspace;

    if (claimStampedNodeId && nodeId) {
        // The session carries its OWN meshNodeId stamp — its authoritative node identity, set when
        // the coordinator launched/dispatched it (mesh-routing trusts this stamp FIRST). When it
        // matches the claim target the session genuinely belongs to this node, so the stamp settles
        // it and the workspace heuristic is skipped (a base/worktree pair can legitimately share a
        // workspace). When it does NOT match, the claim is a cross-node leak — refuse, fail-closed.
        if (!meshNodeIdMatches({ id: claimStampedNodeId } as MeshNodeIdentified, nodeId)) {
            LOG.info('MeshQueue', `WTDISPATCH: refusing claim for node ${nodeId} (${sessionId}) — session is bound to node "${claimStampedNodeId}" (cross-node claim blocked)`);
            return false;
        }
    } else if (sessionWorkspaceRaw && nodeWorkspaceRaw && !meshWorkspacesEquivalent(sessionWorkspaceRaw, nodeWorkspaceRaw)) {
        // No stamp (the no_node_binding worker) — fall back to the workspace to tell two co-located
        // sibling worktree sessions apart. WTCLAIM, now reaching instanceManager-observable sessions
        // too. Conservative: unknown workspace on either side → do NOT refuse (no legitimate claim
        // starved; a genuinely remote cross-daemon candidate stays nodeId-matched as before).
        LOG.info('MeshQueue', `WTCLAIM: refusing claim for node ${nodeId} (${sessionId}) — session workspace "${normalizeMeshWorkspaceForCompare(sessionWorkspaceRaw)}" ≠ node workspace "${normalizeMeshWorkspaceForCompare(nodeWorkspaceRaw)}" (cross-workspace dispatch blocked)`);
        return false;
    }

    const capabilityTags = buildMeshNodeCapabilityTags(node, providerType);
    // Per-(node, provider) maxParallel cap (RepoMeshNodePolicy.providerRoles) layers
    // on top of the global/taskMode caps — stricter wins. Resolved here where the
    // claiming session's providerType + node policy are both known, then enforced
    // inside the atomic claim transaction so concurrent claims can't overshoot it.
    const providerMaxParallel = resolveProviderMaxParallel(node?.policy, providerType);
    // WTDISPATCH-FANOUT: tell the atomic claim whether the claiming node is a worktree
    // clone so a `convergence` task (base-only: merge → push → cleanup) is refused for
    // worktree sessions. Without it, every sibling worktree session on this daemon could
    // claim the same convergence intent and race push/production-deploy (the 4-way fan-out).
    const nodeIsWorktree = node?.isLocalWorktree === true;
    const task = claimNextTask(meshId, nodeId, sessionId, capabilityTags, {
        providerType,
        ...(providerMaxParallel !== undefined ? { providerMaxParallel } : {}),
        nodeIsWorktree,
    });
    if (!task) {
        return false;
    }

    const terminal = findTerminalLedgerEvidenceForTask({
        meshId,
        taskId: task.id,
    });
    if (terminal) {
        const status = terminal.kind === 'task_completed' ? 'completed' : 'failed';
        updateTaskStatus(meshId, task.id, status);
        LOG.info('MeshQueue', `Skipped dispatch for terminal task ${task.id} on mesh ${meshId}; ${terminal.kind} ledger evidence already exists`);
        traceMeshEventDrop('dispatch_terminal_ledger', {
            taskId: task.id,
            sessionId,
            nodeId,
            meshId,
            event: 'agent_command',
        }, terminal.kind);
        return false;
    }

    LOG.info('MeshQueue', `Node ${nodeId} (${sessionId}) pulled task ${task.id}`);

    if (node?.daemonId && components.dispatchMeshCommand) {
        const isLocalNode = components.cliManager.adapters.has(sessionId);
        if (!isLocalNode) {
            const localDaemonIdForDispatch = readNonEmptyString(loadConfig().machineId) || undefined;
            // (3) Originating coordinator session that enqueued this task — route its
            // completion back to that exact session (multi-coordinator). Carried over P2P
            // to the remote worker, which echoes it on its completion event.
            const sourceCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId) || undefined;
            const dispatchMeshCommand = components.dispatchMeshCommand;
            const remoteDaemonId = node.daemonId;
            // CONS3: only the transport call differs — everything else (delivery record,
            // status transitions, requeue-on-failure, ledger, Bug B hang timeout) is in
            // the shared deliverTaskToSession helper.
            deliverTaskToSession(
                () => dispatchMeshCommand(remoteDaemonId, 'agent_command', {
                    targetSessionId: sessionId,
                    cliType: providerType,
                    action: 'send_chat',
                    message: task.message,
                    meshContext: {
                        meshId,
                        nodeId,
                        taskId: task.id,
                        ...(localDaemonIdForDispatch ? { coordinatorDaemonId: localDaemonIdForDispatch } : {}),
                        ...(sourceCoordinatorSessionId ? { coordinatorSessionId: sourceCoordinatorSessionId } : {}),
                    },
                }),
                {
                    meshId,
                    nodeId,
                    sessionId,
                    providerType,
                    task,
                    transport: 'remote',
                    ...(sourceCoordinatorSessionId ? { sourceCoordinatorSessionId } : {}),
                    ...(localDaemonIdForDispatch ? { sourceCoordinatorDaemonId: localDaemonIdForDispatch } : {}),
                },
                // Warmup-aware deadline: this dispatch can be the FIRST command to a
                // peer whose mesh DataChannel is still opening — charge the cold-open
                // handshake to the connect budget, not the response budget.
                { daemonId: remoteDaemonId, getConnection: components.getMeshPeerConnectionStatus },
            );
            return true;
        }
    }

    // Stamp mesh context onto the session so completion events route correctly
    // via setupMeshEventForwarding. Without this, manually-opened idle sessions
    // (mesh_launch_session without auto-launch) lack meshNodeFor/meshNodeId and
    // agent:generating_completed is silently dropped as isMeshDelegate=false.
    try {
        const inst = components.instanceManager.getInstance(sessionId);
        if (inst && typeof inst.updateSettings === 'function') {
            // Adopting a (possibly manually-opened) local session as a worker: apply the
            // delegated-worker auto-approve policy here too, so a session that was launched
            // without autoApprove still auto-approves once the coordinator dispatches a task
            // to it (the "approval notification fires only for certain delegated sessions"
            // case). updateSettings preserves runtime mesh keys; passing autoApprove keeps it.
            //
            // This local-dispatch branch also runs on the coordinator daemon for a co-located
            // session, so the coordinator daemon id IS this daemon's id. Stamp it alongside
            // the node identity so the session is fully relay-safe (meshCoordinatorDaemonId is
            // the anchor the forwarder keys on), matching what mesh_launch_session stamps.
            const localDaemonId = readNonEmptyString(loadConfig().machineId);
            const localSourceCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId);
            inst.updateSettings({
                meshNodeFor: meshId,
                meshNodeId: nodeId,
                launchedByCoordinator: true,
                autoApprove: resolveDelegatedWorkerAutoApprove(mesh?.policy, node?.policy),
                ...(localDaemonId ? { meshCoordinatorDaemonId: localDaemonId } : {}),
                // (3) Stamp the originating coordinator session for session-anchored routing
                // of this co-located worker's completion. Absent → daemon-level fallback.
                ...(localSourceCoordinatorSessionId ? { meshCoordinatorSessionId: localSourceCoordinatorSessionId } : {}),
            });
        }
    } catch { /* best-effort — dispatch still proceeds */ }

    // CONS3: same shared dispatch lifecycle as the remote branch — only the transport
    // (cliManager.handleCliCommand) differs.
    deliverTaskToSession(
        () => components.cliManager.handleCliCommand('agent_command', {
            targetSessionId: sessionId,
            cliType: providerType,
            action: 'send_chat',
            message: task.message,
        }),
        {
            meshId,
            nodeId,
            sessionId,
            providerType,
            task,
            transport: 'local',
            ...(readNonEmptyString(task.sourceCoordinatorSessionId) ? { sourceCoordinatorSessionId: readNonEmptyString(task.sourceCoordinatorSessionId) } : {}),
            ...(readNonEmptyString(loadConfig().machineId) ? { sourceCoordinatorDaemonId: readNonEmptyString(loadConfig().machineId) } : {}),
        },
    );

    return true;
}

const autoLaunchInProgress = new Set<string>();
const autoLaunchCooldownUntil = new Map<string, number>();
const AUTO_LAUNCH_COOLDOWN_MS = 5_000;
// A remote auto-launch (launch_cli forward) is fire-and-async: the worker session
// spawns, reaches idle, emits agent:ready, that ready is queued on the worker, pulled
// by this coordinator (reconcile PHASE 1), and only THEN claims the task. That round
// trip routinely exceeds the 5s per-(mesh,node) cooldown, so cooldown alone lets the
// reconcile loop fire a SECOND launch for the same still-pending task before the first
// session's claim lands — every tick spawns yet another orphan session (observed live:
// 26 sessions for one task). This is a per-TASK await-claim window: once a task has a
// successfully-launched session whose claim we are still waiting on, do not launch it
// again until the window lapses. It is generous (a slow remote spawn can take tens of
// seconds) but bounded so a launch that silently never reaches idle is eventually retried.
const AUTO_LAUNCH_AWAIT_CLAIM_MS = 90_000;

// De-dup for repeated `skipped` ledger noise: the reconcile loop re-runs the queue
// trigger every 4s, so a task that can't be claimed (e.g. a remote node with no
// transport, or a node under cooldown) would otherwise append an identical
// session_auto_launch{phase:'skipped'} entry on every tick — flooding the ledger.
// We suppress a `skipped` ledger append when the immediately-prior recorded event
// for that task was the SAME (phase, reason). Any non-skip phase (started/failed/
// completed) or a changed reason resets the de-dup so real transitions still record.
const lastAutoLaunchLedgerKey = new Map<string, string>();
const AUTO_LAUNCH_LEDGER_DEDUP_MAX = 2000;

// Fix (1): actionable dispatch-skip notification.
//
// User-core gap: when a queued task cannot be dispatched the coordinator (Claude Code via
// MCP) had no proactive signal — the skip was only recorded to task.autoLaunch + the ledger,
// both of which the coordinator must poll to discover. For a skip that will NOT self-resolve
// (a routing miss, no capable node, a convergence task pinned to a worktree, an unusable
// provider, an unreachable remote, or a dirty workspace) the coordinator could sit waiting
// for a dispatch that can never happen. We now actively surface those — and ONLY those — as a
// pending coordinator event carrying a "why + how to act" message, routed to the originating
// coordinator (sourceCoordinator*). Transient/back-pressure skips (cooldown, in-progress,
// awaiting-claim, parallel/session caps, node not yet launch-ready, an active assignment) are
// deliberately excluded: they clear on their own and would only spam the coordinator every 4s.
const ACTIONABLE_SKIP_REASON_PREFIXES = [
    'target_node_id_unmatched',
    'no_node_satisfies_required_tags',
    'mesh_convergence_target_is_worktree',
    'remote_auto_launch_unsupported',
    'remote_auto_launch_no_coordinator_daemon_id',
    'missing_provider_priority',
    'provider_loader_unavailable',
    'provider_priority_unusable',
    'provider_unusable',
    'dirty_workspace',
];

// De-dup actionable-skip coordinator notifications: emit once per (mesh, task) until the
// reason CHANGES, so the 4s reconcile loop re-marking the same skip does not re-notify. A
// non-skip transition (or a genuine reason change) re-arms it. In-memory only — a daemon
// restart re-notifies once, which is the correct behaviour after a restart.
const lastActionableSkipNotified = new Map<string, string>();

function isActionableSkipReason(reason?: string): boolean {
    if (!reason) return false;
    return ACTIONABLE_SKIP_REASON_PREFIXES.some(prefix => reason === prefix || reason.startsWith(prefix));
}

function actionableSkipGuidance(reason: string): { summary: string; nextAction: string } {
    if (reason === 'target_node_id_unmatched') return {
        summary: 'it is pinned to a target node id that matches no node in the mesh (the node may have been removed, or its id form does not resolve)',
        nextAction: 'Verify the target node still exists with mesh_status, then re-enqueue without the node pin or with a valid node id (or re-clone the node).',
    };
    if (reason === 'no_node_satisfies_required_tags') return {
        summary: "no node in the mesh can satisfy the task's required capability tags",
        nextAction: "Relax the task's requiredTags, or add/launch a node whose provider produces the required capabilities.",
    };
    if (reason === 'mesh_convergence_target_is_worktree') return {
        summary: 'it is a convergence task (base-only: merge → push → cleanup) but every candidate node is a worktree clone',
        nextAction: 'Dispatch the convergence task to the base node, or run the deterministic fast-forward path (mesh_fast_forward_node / mesh_refine_node) instead.',
    };
    if (reason.startsWith('remote_auto_launch')) return {
        summary: 'the target node is on a remote daemon this coordinator cannot auto-launch a session on (no dispatch transport, or no coordinator daemon id to stamp)',
        nextAction: 'Launch a session on that node yourself with mesh_launch_session, or ensure the remote daemon is connected over P2P.',
    };
    if (reason.startsWith('provider') || reason === 'missing_provider_priority') return {
        summary: 'the node has no usable provider for this task (provider priority missing/unusable, or the provider loader is unavailable)',
        nextAction: "Check the node's providerPriority policy and that the required CLI/ACP provider is installed and enabled on that machine.",
    };
    if (reason === 'dirty_workspace') return {
        summary: "the node's workspace is dirty, so auto-launch is blocked to avoid clobbering uncommitted changes",
        nextAction: "Clean or commit the node's working tree (or fast-forward it); the task will then auto-assign.",
    };
    return {
        summary: `it cannot be dispatched (${reason})`,
        nextAction: 'Inspect the node/mesh state with mesh_status and resolve the blocker, or re-enqueue the task.',
    };
}

/** Surface a non-self-resolving dispatch skip to the originating coordinator as a pending
 *  event (so it is delivered actively, not only on poll). De-duped per (mesh, task, reason). */
function notifyCoordinatorOfActionableSkip(meshId: string, taskId: string, reason: string | undefined, nodeId?: string): void {
    if (!isActionableSkipReason(reason)) return;
    const dedupKey = `${meshId}:${taskId}`;
    if (lastActionableSkipNotified.get(dedupKey) === reason) return;
    lastActionableSkipNotified.set(dedupKey, reason!);
    if (lastActionableSkipNotified.size > AUTO_LAUNCH_LEDGER_DEDUP_MAX) {
        const oldest = lastActionableSkipNotified.keys().next().value;
        if (oldest !== undefined) lastActionableSkipNotified.delete(oldest);
    }
    let task: MeshWorkQueueEntry | undefined;
    try { task = getQueue(meshId).find(t => t.id === taskId); } catch { /* best-effort */ }
    // The queue is owned by this coordinator daemon, so scope the event to this daemon's id;
    // the originating coordinator SESSION (if known) further narrows delivery on this daemon.
    const targetCoordinatorDaemonId = readNonEmptyString(loadConfig().machineId);
    const targetCoordinatorSessionId = readNonEmptyString(task?.sourceCoordinatorSessionId);
    const nodeLabel = readNonEmptyString(nodeId) || readNonEmptyString(task?.targetNodeId);
    const { summary, nextAction } = actionableSkipGuidance(reason!);
    const coordinatorMessage = `[System] A queued mesh task${nodeLabel ? ` for node ${nodeLabel}` : ''} is not being dispatched because ${summary}. ${nextAction} This is an actionable blocker — it will NOT clear on its own; the task stays pending until you resolve it.`;
    try {
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel: nodeLabel || meshId,
            ...(nodeLabel ? { nodeId: nodeLabel } : {}),
            metadataEvent: {
                source: 'mesh_queue_dispatch_skip',
                taskId,
                reason,
                ...(nodeLabel ? { nodeId: nodeLabel } : {}),
                coordinatorMessage,
            },
            coordinatorMessage,
            queuedAt: Date.now(),
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to surface actionable dispatch-skip (${reason}) for task ${taskId}: ${e?.message || e}`);
    }
}

function sweepExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of autoLaunchCooldownUntil) {
        if (now >= until) autoLaunchCooldownUntil.delete(key);
    }
}

function normalizeProviderPriority(policy: unknown): string[] {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

function isTerminalSessionStatus(status: string): boolean {
    return ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(status);
}

function isIdleSessionState(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    if (isTerminalSessionStatus(status)) return false;
    return status === 'idle' || state?.activeChat?.status === 'waiting_input';
}

function isDirtyNode(node: any): boolean {
    return node?.health === 'dirty' || node?.git?.dirty === true;
}

function resolveAutoFastForwardPolicy(mesh: any): { enabled: boolean; maxBehind?: number; requireCleanSubmodules: boolean } {
    const record = mesh?.policy?.autoFastForward && typeof mesh.policy.autoFastForward === 'object' && !Array.isArray(mesh.policy.autoFastForward)
        ? mesh.policy.autoFastForward as Record<string, unknown>
        : {};
    const maxBehind = Number(record.maxBehind);
    return {
        enabled: record.enabled !== false,
        ...(Number.isFinite(maxBehind) && maxBehind >= 0 ? { maxBehind: Math.floor(maxBehind) } : {}),
        requireCleanSubmodules: record.requireCleanSubmodules !== false,
    };
}

function sessionStateLooksActive(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    const chatStatus = readNonEmptyString(state?.activeChat?.status).toLowerCase();
    // 'long_generating' is retained as a legacy alias for the renamed 'no_progress' busy status.
    const active = new Set(['generating', 'streaming', 'no_progress', 'long_generating', 'working', 'starting', 'waiting_approval']);
    return active.has(status) || active.has(chatStatus);
}

function nodeHasActiveMeshWork(components: DaemonComponents, meshId: string, nodeId: string, currentSessionId?: string): boolean {
    if (nodeHasActiveAssignment(meshId, nodeId)) return true;
    return components.instanceManager.getByCategory('cli').some((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (instNodeId !== nodeId) return false;
        const sessionId = readNonEmptyString(state.instanceId);
        if (currentSessionId && sessionId === currentSessionId && isIdleSessionState(state)) return false;
        return sessionStateLooksActive(state);
    });
}

function isLaunchableNode(node: any): boolean {
    if (!node || node.status === 'disabled' || node.status === 'removed') return false;
    const health = readNonEmptyString(node.health).toLowerCase();
    if (!health) return true;
    return health === 'online' || health === 'unknown';
}

/** Whether a mesh node's daemon/machine identity resolves to THIS coordinator daemon
 *  (i.e. the queue session can be spawned by a direct local `launch_cli`). */
function isLocalAutoLaunchNode(node: any): boolean {
    const daemonId = readNonEmptyString(node?.daemonId);
    const machineId = readNonEmptyString(node?.machineId);
    const appConfig = loadConfig();
    const localMachineId = readNonEmptyString(appConfig.machineId) || readNonEmptyString(appConfig.registeredMachineId);

    // Route BOTH the daemonId and the machineId through the canonical machine-core
    // equivalence helper so a node carrying any interchangeable id form (bare `mach_<hex>`
    // or a `daemon_`/`standalone_` prefixed form) resolves to THIS coordinator instead of
    // being misjudged as remote. machineId used to use a raw `===`, which — AND-combined
    // with the daemonId match — would misjudge a local node as remote whenever a
    // form-mismatched machineId arrived, dispatching a local task to a remote node (B-2).
    const daemonMatchesLocal = !daemonId || daemonIdsEquivalent(daemonId, localMachineId);
    const machineMatchesLocal = !machineId || daemonIdsEquivalent(machineId, localMachineId);

    if (node?.isLocalWorktree === true) {
        return daemonMatchesLocal && machineMatchesLocal;
    }
    if (daemonId || machineId) {
        return daemonMatchesLocal && machineMatchesLocal;
    }
    return true;
}

/**
 * Resolve how a pending queue task should be auto-launched onto a node.
 *
 * - `local`: spawn directly on this daemon via cliManager.handleCliCommand('launch_cli').
 * - `remote`: forward `launch_cli` to the node's daemon via dispatchMeshCommand
 *   (mirrors what mesh_launch_session does). Requires dispatchMeshCommand AND a
 *   resolvable coordinator daemonId for relay-safe completion routing.
 * - `skip`: not launchable from here — carries the reason (e.g. a remote node with
 *   no dispatch transport, or no coordinator daemonId to stamp).
 */
function resolveAutoLaunchTarget(components: DaemonComponents, node: any): {
    mode: 'local' | 'remote' | 'skip';
    reason?: string;
    daemonId?: string;
    coordinatorDaemonId?: string;
} {
    if (isLocalAutoLaunchNode(node)) return { mode: 'local' };

    // Remote node. Forwarding the launch is possible only with a dispatch transport
    // (cloud mode) plus a coordinator daemonId to stamp into the worker so completion
    // events route back here. Without either, fall back to a graceful skip.
    const daemonId = readNonEmptyString(node?.daemonId);
    if (!daemonId) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    if (!components.dispatchMeshCommand) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    const coordinatorDaemonId = readNonEmptyString(loadConfig().machineId);
    if (!coordinatorDaemonId) return { mode: 'skip', reason: 'remote_auto_launch_no_coordinator_daemon_id' };
    return { mode: 'remote', daemonId, coordinatorDaemonId };
}

function activeAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any }).length;
}

/** Active assignments that hold the one-active-per-node / global-parallel invariant
 *  (everything except read-only diagnoses, which run unbounded by the write cap). */
export function activeWriteAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => task.taskMode !== 'live_debug_readonly').length;
}

/** Active read-only (live_debug_readonly) assignments, for the read-only safety cap. */
export function activeReadonlyAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => task.taskMode === 'live_debug_readonly').length;
}

function nodeHasActiveAssignment(meshId: string, nodeId: string): boolean {
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedNodeId === nodeId);
}

/** Active (status='assigned') task count for a node — the load metric for
 *  least-loaded / round-robin ranking. Lower = preferred. */
function nodeActiveLoad(meshId: string, nodeId: string): number {
    return MeshRuntimeStore.getInstance().nodeActiveAssignmentCount(meshId, nodeId);
}

/**
 * Resolve the canonical repo root for reading a mesh's in-tree `.adhdev/mesh.json`
 * overlay. Prefers a base (non-worktree) node's repoRoot/workspace — the canonical
 * checkout that carries the repo file — and falls back to any node so a worktree-only
 * mesh still resolves a root. Returns '' when no node declares a path.
 */
function resolveMeshRepoRootForScheduling(mesh: any): string {
    const nodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    const pickRoot = (n: any) => readNonEmptyString(n?.repoRoot) || readNonEmptyString(n?.workspace);
    const base = nodes.find((n: any) => n?.isLocalWorktree !== true && pickRoot(n));
    if (base) return pickRoot(base);
    const anyNode = nodes.find((n: any) => pickRoot(n));
    return anyNode ? pickRoot(anyNode) : '';
}

/**
 * The repo-local `.adhdev/mesh.json` `policy.scheduling` overlay for this mesh, when
 * present and valid. LOCAL-WINS: a value here overrides the stored mesh policy. Cached
 * by mtime in the loader, so calling this on every reconcile tick is cheap.
 */
function resolveMeshSchedulingOverride(mesh: any): MeshJsonSchedulingConfig | undefined {
    const repoRoot = resolveMeshRepoRootForScheduling(mesh);
    if (!repoRoot) return undefined;
    try {
        return loadMeshJsonConfig(repoRoot).config?.scheduling;
    } catch {
        return undefined;
    }
}

/**
 * The mesh-wide scheduling strategy. Resolution order (LOCAL-WINS):
 *   1. `.adhdev/mesh.json` policy.scheduling.distribution (2-mode → strategy), then
 *   2. the stored mesh policy schedulingStrategy raw 4-union (escape hatch), then
 *   3. 'first_eligible' (strict no-change default).
 * Only governs the final tie-break; eligibility, capacity, and priority gates apply
 * identically to every strategy.
 */
function resolveSchedulingStrategy(mesh: any): RepoMeshSchedulingStrategy {
    const override = resolveMeshSchedulingOverride(mesh);
    if (override?.distribution) return distributionToStrategy(override.distribution);
    return normalizeMeshSchedulingStrategy(mesh?.policy?.schedulingStrategy);
}

/**
 * Order eligible nodes for assignment per the mesh scheduling pipeline:
 *   PRIORITY (schedulingPriority desc) → TIE-BREAK (strategy).
 *
 * The caller has already applied the TAG hard-filter and is responsible for the
 * MAX-ALLOC capacity gate (the per-node launch/claim checks). This function only
 * decides the *preference order* among nodes that are otherwise eligible.
 *
 * - 'first_eligible' (default): returns the input order verbatim and does NOT touch
 *   the round-robin cursor — byte-for-byte the pre-feature behavior.
 * - 'priority_only': schedulingPriority desc, then input order (load ignored).
 * - 'least_loaded' (the user-facing 'spread' mode): schedulingPriority desc, then
 *   active load asc, then — among nodes still tied at (priority, load) — the input
 *   order is rotated by a per-mesh cursor that advances once per pass. The rotation
 *   tie-break is ALWAYS on for least_loaded so a single 'spread' mode subsumes the
 *   former separate 'round_robin' strategy (two equal-load nodes still alternate
 *   fairly across passes instead of the lower index always winning).
 * - 'round_robin': retained as an escape-hatch alias; behaves identically to
 *   'least_loaded' now that least_loaded carries the rotation.
 *
 * `nodes` carries the original config/array index so the tie-break can fall back to
 * deterministic input order. `bumpCursor` advances the round-robin cursor exactly
 * once per scheduling pass (consulted for both 'least_loaded' and 'round_robin').
 */
interface RankableNode { nodeId: string; node: any; index: number }

/** Test-only: resolve a mesh's effective scheduling strategy through the full
 *  LOCAL-WINS path (`.adhdev/mesh.json` distribution → strategy, else stored policy).
 *  Exposed so the repo-file overlay wiring can be exercised by a direct call. */
export function __resolveSchedulingStrategyForTests(mesh: any): RepoMeshSchedulingStrategy {
    return resolveSchedulingStrategy(mesh);
}

/** Test-only: the pure node-ordering stage (PRIORITY → TIE-BREAK). Exposed so the
 *  scheduling pipeline can be unit-tested without standing up live CLI sessions. */
export function __orderEligibleNodesForTests(
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    nodes: RankableNode[],
    opts?: { bumpCursor?: boolean },
): RankableNode[] {
    return orderEligibleNodes(meshId, strategy, nodes, opts);
}

function orderEligibleNodes(
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    nodes: RankableNode[],
    opts?: { bumpCursor?: boolean },
): RankableNode[] {
    if (strategy === 'first_eligible' || nodes.length <= 1) {
        return nodes;
    }

    const priorityOf = (n: { node: any }) => resolveNodeSchedulingPriority(n.node?.policy);

    // Round-robin rotation offset: rotate the deterministic input order by a
    // per-mesh cursor so the tie-break winner among equal (priority, load) nodes
    // cycles across passes. The cursor advances once per scheduling pass. Applied
    // to both 'least_loaded' (the 'spread' mode — rotation absorbed as its
    // tie-break) and the legacy 'round_robin' alias.
    let rotation = 0;
    if (strategy === 'least_loaded' || strategy === 'round_robin') {
        const cursor = opts?.bumpCursor
            ? MeshRuntimeStore.getInstance().bumpSchedulerCursor(meshId)
            : MeshRuntimeStore.getInstance().getSchedulerCursor(meshId);
        rotation = ((cursor % nodes.length) + nodes.length) % nodes.length;
    }

    // Rotation rank: position of each node after rotating input order by `rotation`.
    // For non-round-robin strategies rotation is 0, so this is just the input index.
    const rotationRank = (index: number) => (index - rotation + nodes.length) % nodes.length;

    return [...nodes].sort((a, b) => {
        const prioDelta = priorityOf(b) - priorityOf(a); // higher priority first
        if (prioDelta !== 0) return prioDelta;
        if (strategy === 'least_loaded' || strategy === 'round_robin') {
            const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
            if (loadDelta !== 0) return loadDelta;
        }
        return rotationRank(a.index) - rotationRank(b.index);
    });
}

/** Active assignments on a (node, provider) — pre-launch guard for the per-(node,
 *  provider) maxParallel cap. The authoritative enforcement is in the claim
 *  transaction; this only avoids spawning a session that would fail the claim. */
function activeProviderAssignedCount(meshId: string, nodeId: string, providerType: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => task.assignedNodeId === nodeId && task.assignedProviderType === providerType).length;
}

export function sessionHasActiveAssignment(meshId: string, sessionId: string): boolean {
    if (getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedSessionId === sessionId)) {
        return true;
    }
    // Direct dispatches (mesh_send_task) are tracked in mesh_direct_dispatches, not the
    // work queue. A session completing a still-active direct dispatch IS an active
    // assignment — without this, findRecentTerminalLedgerEvidence dedup wrongly suppresses
    // the canonical agent:generating_completed for direct-dispatch tasks (validation/general),
    // so the coordinator polling get_pending_mesh_events never observes task_completed and the
    // session goes silently idle. This check runs before markSessionTerminal marks the
    // dispatch terminal, so the in-flight dispatch is still observable here.
    try {
        if (getActiveDirectDispatches(meshId).some(d => d.sessionId === sessionId)) return true;
        if (hasUnterminalDirectDispatchLedgerEntry(meshId, sessionId)) return true;
    } catch { /* best-effort — fall through to false */ }
    return false;
}

function liveSessionCountForNode(components: DaemonComponents, meshId: string, nodeId: string): number {
    return components.instanceManager.getByCategory('cli').filter((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (instNodeId !== nodeId) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        return !isTerminalSessionStatus(status);
    }).length;
}

function recordAutoLaunchEvent(meshId: string, args: {
    phase: 'skipped' | 'started' | 'failed' | 'completed';
    taskId: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    reason?: string;
    error?: string;
}) {
    // Suppress consecutive identical `skipped` entries for the same task (4s reconcile
    // re-trigger noise). Non-skip phases and changed reasons always record and reset
    // the de-dup so genuine state transitions remain visible in the ledger.
    const dedupKey = `${meshId}:${args.taskId}`;
    const currentSig = `${args.phase}|${args.reason || ''}`;
    if (args.phase === 'skipped' && lastAutoLaunchLedgerKey.get(dedupKey) === currentSig) {
        return;
    }
    lastAutoLaunchLedgerKey.set(dedupKey, currentSig);
    if (lastAutoLaunchLedgerKey.size > AUTO_LAUNCH_LEDGER_DEDUP_MAX) {
        // Bound memory: drop the oldest insertion (Map preserves insertion order).
        const oldest = lastAutoLaunchLedgerKey.keys().next().value;
        if (oldest !== undefined) lastAutoLaunchLedgerKey.delete(oldest);
    }
    try {
        appendLedgerEntry(meshId, {
            kind: 'session_auto_launch',
            nodeId: args.nodeId,
            sessionId: args.sessionId,
            providerType: args.providerType,
            payload: {
                phase: args.phase,
                taskId: args.taskId,
                reason: args.reason,
                error: args.error,
            },
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to record auto-launch ledger event: ${e?.message || e}`);
    }
}

function markAutoLaunch(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    reason?: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    error?: string;
}) {
    recordTaskAutoLaunch(meshId, taskId, {
        status: args.status,
        reason: args.reason || args.error,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
    });
    recordAutoLaunchEvent(meshId, {
        phase: args.status,
        taskId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
        reason: args.reason,
        error: args.error,
    });
    // Fix (1): actively notify the coordinator of a non-self-resolving skip; re-arm the
    // notification on any non-skip transition (started/completed) so a later genuine skip
    // re-notifies.
    if (args.status === 'skipped') {
        notifyCoordinatorOfActionableSkip(meshId, taskId, args.reason, args.nodeId);
    } else {
        lastActionableSkipNotified.delete(`${meshId}:${taskId}`);
    }
}

async function resolveUsableProvider(
    components: DaemonComponents,
    nodeId: string,
    node: any,
    requiredTags?: string[],
): Promise<{ providerType?: string; reason?: string }> {
    const providerPriority = normalizeProviderPriority(node?.policy);
    if (!providerPriority.length) return { reason: 'missing_provider_priority' };
    const providerLoader = components.providerLoader;
    if (!providerLoader) return { reason: 'provider_loader_unavailable' };

    const failed: string[] = [];
    for (const requestedType of providerPriority) {
        const normalizedType = typeof providerLoader.resolveAlias === 'function'
            ? providerLoader.resolveAlias(requestedType)
            : requestedType;
        // Skip providers that can't satisfy the task's requiredTags (e.g. provider=hermes-cli
        // means only hermes-cli qualifies, not any other type in providerPriority).
        if (requiredTags?.length && !nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node, normalizedType))) {
            failed.push(`${requestedType}: required_tags_mismatch`);
            continue;
        }
        if (typeof providerLoader.isMachineProviderEnabled === 'function' && !providerLoader.isMachineProviderEnabled(normalizedType)) {
            failed.push(`${requestedType}: disabled`);
            continue;
        }
        let detected: any;
        try {
            detected = await detectCLI(normalizedType, providerLoader, { includeVersion: false });
        } catch (e: any) {
            failed.push(`${requestedType}: detect failed: ${e?.message || e}`);
            continue;
        }
        if (typeof providerLoader.setCliDetectionResults === 'function') {
            providerLoader.setCliDetectionResults([{
                id: normalizedType,
                installed: !!detected,
                path: detected?.path,
            }], false);
        }
        (components as any).onStatusChange?.();
        if (detected) return { providerType: normalizedType };
        failed.push(`${requestedType}: not detected`);
    }
    return { reason: `provider_priority_unusable: ${failed.join('; ') || nodeId}` };
}

// Canonical mesh node-id normalization. A node may arrive from the local config
// form (`id`) or the inline-cache form (`nodeId`/`node_id`) — see
// readInlineMeshNodeId in commands/router.ts. Comparing only `node.id` against a
// task.targetNodeId silently drops inline-cached worktree nodes, leaving a
// target-routed task permanently pending with a misleading
// `no_node_satisfies_required_tags` skip.
function readMeshNodeId(node: any): string {
    // Delegate to the shared 3-way (id / nodeId / node_id) normalizer so this
    // and every other mesh node-id read agree on identity. Coalesce to '' to
    // preserve the existing string return contract for callers that do
    // `=== task.targetNodeId` / `if (!nodeId)`.
    return normalizeMeshNodeId(node) ?? '';
}

async function maybeAutoLaunchOneQueueSession(components: DaemonComponents, meshId: string, mesh: any): Promise<boolean> {
    const queue = getQueue(meshId);
    const pending = queue.filter(task => task.status === 'pending');
    if (!pending.length) return false;

    // Write cap + read-only cap resolved through the shared helpers, with the
    // repo-local `.adhdev/mesh.json` overlay winning over the stored policy
    // (LOCAL-WINS). Both the cap value and the read-only multiplier route through
    // the same resolvers the observability projection uses, so the enforced and
    // exposed caps can never drift.
    const schedulingOverride = resolveMeshSchedulingOverride(mesh);
    const maxParallelTasks = resolveMaxParallelTasks(
        schedulingOverride?.maxParallel ?? mesh?.policy?.maxParallelTasks,
    );
    // Read-only diagnoses carry no isolation/merge cost, so they are exempt from the
    // write-task parallel cap. To prevent runaway auto-launch they get their own,
    // higher safety cap (readonlyMultiplier × the write cap, default 2×).
    const maxReadonlyParallelTasks = resolveMaxReadonlyParallelTasks(maxParallelTasks, schedulingOverride?.readonlyMultiplier);
    for (const task of pending) {
        const isReadonly = task.taskMode === 'live_debug_readonly';
        if (isReadonly) {
            if (activeReadonlyAssignedCount(meshId) >= maxReadonlyParallelTasks) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_readonly_parallel_tasks_reached' });
                continue;
            }
        } else if (activeWriteAssignedCount(meshId) >= maxParallelTasks) {
            // Write tasks are capped; skip this one but keep scanning so a later
            // read-only task in the queue can still launch under its own cap.
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_parallel_tasks_reached' });
            continue;
        }
        if (task.targetSessionId) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_constraint' });
            continue;
        }

        // Per-task await-claim guard. A prior auto-launch already spawned a session for
        // this task and we are waiting for that session's idle→claim to land (remote
        // claims arrive via the worker→coordinator agent:ready pull, which can lag well
        // past the per-node cooldown). Re-launching now would spawn a duplicate orphan
        // session that never gets work. The task leaves `pending` the instant the claim
        // succeeds, so this guard only suppresses the in-flight window; if the launched
        // session never reaches idle within the window, a later tick retries.
        if (task.autoLaunch?.status === 'completed' && task.autoLaunch.sessionId) {
            const launchedAtMs = Date.parse(task.autoLaunch.updatedAt);
            if (Number.isFinite(launchedAtMs) && Date.now() - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS) {
                // Record the skip in the ledger ONLY (dedup'd). Do NOT call markAutoLaunch
                // here: recordTaskAutoLaunch overwrites task.autoLaunch wholesale, which would
                // erase the very `completed` record (status + sessionId + updatedAt) this guard
                // reads on the next tick, reopening the duplicate-launch hole it closes.
                recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'awaiting_launched_session_claim', nodeId: task.autoLaunch.nodeId, sessionId: task.autoLaunch.sessionId });
                continue;
            }
        }

        const candidateNodes = Array.isArray(mesh?.nodes)
            ? mesh.nodes.filter((node: any) => {
                // Bug A: match the target pin with the shared 3-form (id / nodeId / node_id)
                // normalizer, mirroring the remote-idle drain (meshNodeIdMatches at the
                // getRemoteIdleSessions filter). A strict `readMeshNodeId(node) !== targetNodeId`
                // dropped a target node whose identity arrived under a different form (a freshly
                // mesh_clone_node'd worktree), emptying candidateNodes and mislabelling the skip.
                if (task.targetNodeId && !meshNodeIdMatches(node, task.targetNodeId)) return false;
                // WTDISPATCH-FANOUT: a convergence task is base-only (it merges/pushes onto
                // base). Never auto-launch a worktree-clone session for it — that is the very
                // fan-out the claim guard refuses, so spinning the session up would only waste
                // a launch that can never claim. Mirrors claimNextQueueTask's convergence gate.
                if (task.taskMode === 'convergence' && node?.isLocalWorktree === true) return false;
                // Skip nodes that can never satisfy requiredTags regardless of which provider
                // from providerPriority is selected. A node satisfies tags if at least one
                // provider in its priority list would produce matching capability tags.
                if (task.requiredTags?.length) {
                    const priorities = normalizeProviderPriority(node?.policy);
                    const providerCandidates = priorities.length ? priorities : [undefined as unknown as string];
                    return providerCandidates.some(p =>
                        nodeSatisfiesRequiredTags(task.requiredTags, buildMeshNodeCapabilityTags(node, p))
                    );
                }
                return true;
            })
            : [];
        if (!candidateNodes.length) {
            // Bug A: distinguish the two ways the candidate set empties. A task pinned to a
            // targetNodeId whose node is absent from the mesh (or whose id arrived under a
            // different form) is a ROUTING miss — report it as `target_node_id_unmatched`, not
            // the hard-coded `no_node_satisfies_required_tags`, which mislabelled a 3-form
            // node-id mismatch as a capability failure and sent diagnosis down the wrong path.
            // Only fall back to the tag reason when no target pin is in play, or the pin DID
            // match a node but its tags excluded it (a genuine capability miss).
            const targetPinUnmatched = !!task.targetNodeId
                && !(Array.isArray(mesh?.nodes) && mesh.nodes.some((n: any) => meshNodeIdMatches(n, task.targetNodeId)));
            // Fix (2): a `convergence` task is base-only — the candidate filter above
            // (`taskMode === 'convergence' && node.isLocalWorktree`) deliberately drops every
            // worktree-clone node, so candidateNodes can empty out NOT because the target is
            // missing or tag-incapable, but because every node the task could land on is a
            // worktree. Reporting that as `target_node_id_unmatched` / `no_node_satisfies_
            // required_tags` mislabels the cause and sends diagnosis down the wrong path.
            // Detect it explicitly and report the same reason mesh_send_task uses for a direct
            // convergence dispatch onto a worktree, so both surfaces agree.
            const convergenceOntoWorktree = task.taskMode === 'convergence'
                && Array.isArray(mesh?.nodes)
                && (() => {
                    const matched = (mesh.nodes as any[]).filter((n: any) =>
                        !task.targetNodeId || meshNodeIdMatches(n, task.targetNodeId));
                    return matched.length > 0 && matched.every((n: any) => n?.isLocalWorktree === true);
                })();
            markAutoLaunch(meshId, task.id, {
                status: 'skipped',
                reason: convergenceOntoWorktree
                    ? 'mesh_convergence_target_is_worktree'
                    : (targetPinUnmatched ? 'target_node_id_unmatched' : 'no_node_satisfies_required_tags'),
                nodeId: task.targetNodeId,
            });
            continue;
        }

        // PRIORITY → TIE-BREAK: order the eligible (TAG-filtered) candidate nodes by
        // the mesh scheduling strategy. 'first_eligible' (default) returns them in
        // config/array order unchanged, so distribution is strictly opt-in. The
        // per-node MAX-ALLOC capacity gate (nodeHasActiveAssignment, provider cap,
        // maxConcurrentSessions) is still applied inside the loop below; this only
        // chooses which eligible node is *tried first*.
        const strategy = resolveSchedulingStrategy(mesh);
        const orderedCandidateNodes = strategy === 'first_eligible'
            ? candidateNodes
            : orderEligibleNodes(
                meshId,
                strategy,
                candidateNodes
                    .map((node: any, index: number) => ({ nodeId: readMeshNodeId(node), node, index }))
                    .filter((c: RankableNode) => c.nodeId),
                { bumpCursor: true },
            ).map((c: RankableNode) => c.node);

        for (const node of orderedCandidateNodes) {
            const nodeId = readMeshNodeId(node);
            if (!nodeId) continue;
            const launchKey = `${meshId}:${nodeId}`;
            const now = Date.now();
            const cooldownUntil = autoLaunchCooldownUntil.get(launchKey) || 0;
            if (cooldownUntil > 0 && now >= cooldownUntil) autoLaunchCooldownUntil.delete(launchKey);
            if (autoLaunchInProgress.has(launchKey)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_in_progress', nodeId });
                continue;
            }
            if (now < cooldownUntil) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_cooldown', nodeId });
                continue;
            }
            if (isDirtyNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'dirty_workspace', nodeId });
                continue;
            }
            if (!isLaunchableNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_not_launch_ready', nodeId });
                continue;
            }
            const launchTarget = resolveAutoLaunchTarget(components, node);
            if (launchTarget.mode === 'skip') {
                // Remote node we can't reach (no transport / no coordinator daemonId).
                // Set a cooldown so the 4s reconcile loop doesn't re-attempt this node
                // every tick; the de-dup'd skip ledger keeps it diagnosable without flood.
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: launchTarget.reason || 'auto_launch_unavailable', nodeId });
                autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                continue;
            }
            // Write tasks keep the one-active-per-node invariant (worktree isolation);
            // read-only (live_debug_readonly) diagnoses may auto-launch onto a node
            // that already has an active assignment.
            if (task.taskMode !== 'live_debug_readonly' && nodeHasActiveAssignment(meshId, nodeId)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_has_active_assignment', nodeId });
                continue;
            }
            const maxConcurrentSessions = Number(node?.policy?.maxConcurrentSessions);
            if (Number.isFinite(maxConcurrentSessions) && maxConcurrentSessions >= 0 && liveSessionCountForNode(components, meshId, nodeId) >= maxConcurrentSessions) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_concurrent_sessions_reached', nodeId });
                continue;
            }

            autoLaunchInProgress.add(launchKey);
            try {
                const resolved = await resolveUsableProvider(components, nodeId, node, task.requiredTags);
                if (!resolved.providerType) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: resolved.reason || 'provider_unusable', nodeId });
                    continue;
                }

                // Don't spawn a session for a (node, provider) already at its declared
                // maxParallel cap — it would launch only to fail the claim. The claim
                // transaction enforces the cap regardless; this just avoids a doomed launch.
                const providerCap = resolveProviderMaxParallel(node?.policy, resolved.providerType);
                if (
                    providerCap !== undefined
                    && activeProviderAssignedCount(meshId, nodeId, resolved.providerType) >= providerCap
                ) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_provider_parallel_reached', nodeId, providerType: resolved.providerType });
                    continue;
                }

                // Shared worker-launch envelope. For a local node it spawns directly on this
                // daemon; for a remote node the identical command is forwarded to the node's
                // daemon (mirrors mesh_launch_session), with the coordinator daemonId stamped
                // so the worker's completion events route back to this coordinator.
                const launchSettings: Record<string, unknown> = {
                    // Worker launch envelope: role + mesh context so worker can route completion events.
                    role: 'worker',
                    meshNodeFor: meshId,
                    meshNodeId: nodeId,
                    spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                    // Coordinator-dispatched worker: auto-approve unless mesh/node policy
                    // opts out (default true). Lands in settingsOverride and beats the
                    // global per-provider-type autoApprove config (see shouldAutoApprove).
                    autoApprove: resolveDelegatedWorkerAutoApprove(mesh?.policy, node?.policy),
                    launchedByCoordinator: true,
                    autoLaunchedForQueueTaskId: task.id,
                };

                if (launchTarget.mode === 'remote') {
                    // Relay-safe completion routing: stamp the coordinator anchor the same way
                    // mesh_launch_session does so the worker forwards events back to this daemon.
                    const remoteSettings: Record<string, unknown> = {
                        ...launchSettings,
                        meshCoordinatorDaemonId: launchTarget.coordinatorDaemonId,
                        meshCoordinatorNodeId: nodeId,
                    };
                    markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType });
                    let launchResult: any;
                    try {
                        launchResult = await components.dispatchMeshCommand!(launchTarget.daemonId!, 'launch_cli', {
                            cliType: resolved.providerType,
                            dir: node.workspace,
                            settings: remoteSettings,
                        });
                    } catch (e: any) {
                        markAutoLaunch(meshId, task.id, { status: 'failed', reason: `remote_launch_dispatch_failed: ${e?.message || String(e)}`, nodeId, providerType: resolved.providerType });
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        return false;
                    }
                    const payload = (launchResult && typeof launchResult === 'object' && 'payload' in launchResult && launchResult.payload && typeof launchResult.payload === 'object')
                        ? launchResult.payload
                        : launchResult;
                    if (!payload?.success) {
                        const reason = readNonEmptyString(payload?.error) || 'remote_launch_cli_failed';
                        markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: resolved.providerType });
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        return false;
                    }
                    // Remote launch is async: the worker session will register and emit agent:ready,
                    // which (forwarded back here) drives the claim via the normal event path / PHASE 1
                    // reconcile. Set a cooldown so the 4s loop doesn't re-launch before that lands.
                    const remoteSessionId = readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.id) || readNonEmptyString(payload.runtimeSessionId);
                    markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId: remoteSessionId || undefined });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return true;
                }

                markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType });
                const launchResult: any = await components.cliManager.handleCliCommand('launch_cli', {
                    cliType: resolved.providerType,
                    dir: node.workspace,
                    settings: launchSettings,
                });
                if (!launchResult?.success) {
                    const reason = launchResult?.error || 'launch_cli_failed';
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return false;
                }
                const sessionId = readNonEmptyString(launchResult.sessionId) || readNonEmptyString(launchResult.id) || readNonEmptyString(launchResult.runtimeSessionId);
                if (!sessionId) {
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason: 'launch_missing_session_id', nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return false;
                }
                markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId });
                // Readiness barrier: a freshly-spawned local CLI session is NOT yet
                // interactive — its PTY prints the input prompt (and the adapter flips
                // isReady()) only ~2-6s after launch. Dispatching the task immediately
                // pushes the first (often large) message into a not-yet-ready PTY, which
                // could throw "not ready" and bounce the task through requeue (on win32
                // this raced the auto-launch cooldown and stranded the worker idle).
                // Await interactive readiness before claiming/dispatching so the very
                // first message lands cleanly. The adapter's queue-until-ready path is the
                // backstop if readiness is reported late; this just avoids the churn.
                await waitForLocalSessionReady(components, sessionId);
                tryAssignQueueTask(components, meshId, nodeId, sessionId, resolved.providerType);
                return true;
            } catch (e: any) {
                markAutoLaunch(meshId, task.id, { status: 'failed', error: e?.message || String(e), nodeId });
                autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                return false;
            } finally {
                autoLaunchInProgress.delete(launchKey);
            }
        }
    }
    return false;
}

export interface MeshQueueTriggerResult {
    success: true;
    meshId: string;
    pendingBefore: number;
    assignedBefore: number;
    pendingAfter: number;
    assignedAfter: number;
    claimed: boolean;
    newlyAssignedTasks: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
    }>;
    localIdleSessionsChecked: number;
    remoteIdleSessionsChecked: number;
    skippedSessions: Array<{
        nodeId?: string;
        sessionId?: string;
        reason: string;
        status?: string;
    }>;
    autoLaunchStarted: boolean;
    /**
     * True when a worker session is already on its way to claim a still-pending task —
     * either launched this tick (autoLaunchStarted) or launched on a prior tick and still
     * booting/awaiting-claim. Callers MUST treat this as "wait, do not launch another
     * session": a second launch double-edits the worktree. Mutually informative with
     * `noIdleMeshSessionAvailable`, which is suppressed whenever this is true.
     */
    autoLaunchPending?: boolean;
    noIdleMeshSessionAvailable?: boolean;
}

function countQueueStatus(meshId: string, status: 'pending' | 'assigned'): number {
    return getQueue(meshId, { status: [status] as any }).length;
}

function getQueueStatusById(meshId: string): Map<string, string> {
    return new Map(getQueue(meshId).map(task => [task.id, task.status]));
}

export async function triggerMeshQueue(components: DaemonComponents, meshId: string): Promise<MeshQueueTriggerResult> {
    const mesh = getMeshWithCache(components, meshId);
    const pendingBefore = countQueueStatus(meshId, 'pending');
    const assignedBefore = countQueueStatus(meshId, 'assigned');
    const beforeStatus = getQueueStatusById(meshId);
    const skippedSessions: MeshQueueTriggerResult['skippedSessions'] = [];
    let localIdleSessionsChecked = 0;
    let remoteIdleSessionsChecked = 0;
    let autoLaunchStarted = false;
    if (!mesh) {
        return {
            success: true,
            meshId,
            pendingBefore,
            assignedBefore,
            pendingAfter: pendingBefore,
            assignedAfter: assignedBefore,
            claimed: false,
            newlyAssignedTasks: [],
            localIdleSessionsChecked,
            remoteIdleSessionsChecked,
            skippedSessions: [{ reason: 'mesh_not_found' }],
            autoLaunchStarted,
            noIdleMeshSessionAvailable: true,
        };
    }

    // Collect every idle mesh session (local CLI instances + remote idle records)
    // as drain candidates. The drain ORDER depends on the scheduling strategy:
    //   - 'first_eligible' (default): local-first, then remote, exactly as before.
    //   - otherwise: local + remote merged into one pool and drained in scheduling
    //     order (priority → load → tie-break). This local-first debias is required
    //     because without it the coordinator's own local node is always visited
    //     first and greedily absorbs all untargeted work before any remote idle
    //     session is even considered — the comparator alone can't spread work if
    //     local is always tried first.
    type IdleCandidate = { nodeId: string; sessionId: string; providerType: string; origin: 'local' | 'remote'; node: any };
    const strategy = resolveSchedulingStrategy(mesh);
    const localCandidates: IdleCandidate[] = [];

    const cliInstances = components.instanceManager.getByCategory('cli');
    for (const inst of cliInstances) {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};

        const instMeshId = readNonEmptyString(settings.meshNodeFor);
        if (instMeshId !== meshId) continue;

        const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (!nodeId) continue;

        if (!isIdleSessionState(state)) {
            const status = readNonEmptyString(state.status).toLowerCase();
            skippedSessions.push({
                nodeId,
                sessionId: readNonEmptyString(state.instanceId),
                reason: isTerminalSessionStatus(status) ? 'terminal_session' : 'session_not_idle',
                status: status || undefined,
            });
            continue;
        }

        const sessionId = state.instanceId;
        const providerType = state.type || readNonEmptyString(settings.providerType);

        if (providerType) {
            localIdleSessionsChecked += 1;
            localCandidates.push({ nodeId, sessionId, providerType, origin: 'local', node: mesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId)) });
        } else {
            skippedSessions.push({
                nodeId,
                sessionId,
                reason: 'provider_type_missing',
            });
        }
    }

    let remoteSessions: Array<{ nodeId: string; sessionId: string; providerType: string }> = [];
    try {
        remoteSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId);
    } catch { /* best-effort */ }

    const remoteCandidates: IdleCandidate[] = [];
    for (const idle of remoteSessions) {
        // Match with the shared 3-form normalizer (id / nodeId / node_id), not raw
        // `n.id`, so an inline-cached worktree node whose identity arrived under a
        // different form is not silently dropped — leaving a remote idle session
        // unable to claim its pending queue task.
        const node = mesh.nodes.find((n: any) => meshNodeIdMatches(n, idle.nodeId));
        if (node) {
            remoteIdleSessionsChecked += 1;
            remoteCandidates.push({ nodeId: idle.nodeId, sessionId: idle.sessionId, providerType: idle.providerType, origin: 'remote', node });
        }
    }

    const assignIdleCandidate = (candidate: IdleCandidate): void => {
        const assigned = tryAssignQueueTask(components, meshId, candidate.nodeId, candidate.sessionId, candidate.providerType);
        if (assigned && candidate.origin === 'remote') {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(meshId, candidate.nodeId, candidate.sessionId);
            } catch { /* best-effort */ }
        }
    };

    if (strategy === 'first_eligible') {
        // Strict no-change: drain local idle sessions first (original order), then
        // remote idle sessions. tryAssignQueueTask is a no-op when nothing matches.
        for (const candidate of localCandidates) assignIdleCandidate(candidate);
        for (const candidate of remoteCandidates) assignIdleCandidate(candidate);
    } else {
        // Merge local + remote into one pool and drain in scheduling order. Each
        // assignment mutates a node's active load, and the next pick re-reads it,
        // so re-ranking after every assignment keeps the spread fair as load shifts.
        const pool = [...localCandidates, ...remoteCandidates];
        const baseIndex = new Map<string, number>();
        pool.forEach((c, i) => { if (!baseIndex.has(c.nodeId)) baseIndex.set(c.nodeId, i); });
        // Bump the round-robin cursor once for this whole drain pass.
        const uniqueNodes = [...new Set(pool.map(c => c.nodeId))]
            .map((nodeId, index) => ({ nodeId, node: pool.find(c => c.nodeId === nodeId)?.node, index }));
        const ranked = orderEligibleNodes(meshId, strategy, uniqueNodes, { bumpCursor: true });
        const rankIndex = new Map<string, number>(ranked.map((r, i) => [r.nodeId, i]));
        const remaining = [...pool];
        while (remaining.length > 0) {
            // Re-rank each pass so a node that just took work defers its next session.
            remaining.sort((a, b) => {
                const aPrio = resolveNodeSchedulingPriority(a.node?.policy);
                const bPrio = resolveNodeSchedulingPriority(b.node?.policy);
                if (aPrio !== bPrio) return bPrio - aPrio;
                if (strategy === 'least_loaded' || strategy === 'round_robin') {
                    const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
                    if (loadDelta !== 0) return loadDelta;
                }
                return (rankIndex.get(a.nodeId) ?? 0) - (rankIndex.get(b.nodeId) ?? 0);
            });
            assignIdleCandidate(remaining.shift()!);
        }
    }

    autoLaunchStarted = await maybeAutoLaunchOneQueueSession(components, meshId, mesh);
    const afterQueue = getQueue(meshId);
    const pendingAfter = afterQueue.filter(task => task.status === 'pending').length;
    const assignedAfter = afterQueue.filter(task => task.status === 'assigned').length;
    const newlyAssignedTasks = afterQueue
        .filter(task => task.status === 'assigned' && beforeStatus.get(task.id) !== 'assigned')
        .map(task => ({
            id: task.id,
            nodeId: task.assignedNodeId,
            sessionId: task.assignedSessionId,
        }));

    // An auto-launch is "pending" when the coordinator has already spun a session up
    // for a still-pending task and is waiting on that session's idle→claim. This covers
    // two ticks:
    //   - THIS tick fired the launch (autoLaunchStarted), or
    //   - a PRIOR tick launched a session that is still booting/awaiting-claim — the
    //     per-task await-claim guard (maybeAutoLaunchOneQueueSession) deliberately
    //     declines to launch again, so autoLaunchStarted is false even though a session
    //     is on its way to claim this task.
    // Without this signal, the second tick reports `noIdleMeshSessionAvailable` and the
    // MCP guidance tells the coordinator to launch ANOTHER worker — producing a duplicate
    // session that double-edits the worktree. The claim itself is fine; only the wording
    // was wrong, so we surface `autoLaunchPending` to suppress the bad "launch one more"
    // advice while the just-launched session converges.
    const autoLaunchPending = autoLaunchStarted || afterQueue.some(task => {
        if (task.status !== 'pending') return false;
        const al = task.autoLaunch;
        if (!al || (al.status !== 'started' && al.status !== 'completed')) return false;
        const launchedAtMs = Date.parse(al.updatedAt);
        return Number.isFinite(launchedAtMs) && Date.now() - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS;
    });

    return {
        success: true,
        meshId,
        pendingBefore,
        assignedBefore,
        pendingAfter,
        assignedAfter,
        claimed: newlyAssignedTasks.length > 0,
        newlyAssignedTasks,
        localIdleSessionsChecked,
        remoteIdleSessionsChecked,
        skippedSessions,
        autoLaunchStarted,
        ...(autoLaunchPending ? { autoLaunchPending: true } : {}),
        // Only report "no idle session, go launch one" when nothing is already on its way.
        // A pending auto-launch (this tick or a prior still-converging one) means a session
        // WILL claim shortly, so it is not a no-session-available situation.
        ...(pendingAfter > 0 && newlyAssignedTasks.length === 0 && localIdleSessionsChecked === 0 && remoteIdleSessionsChecked === 0 && !autoLaunchPending
            ? { noIdleMeshSessionAvailable: true }
            : {}),
    };
}

export async function maybeAutoFastForwardIdleNode(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    sessionId?: string;
    providerType?: string;
}): Promise<void> {
    const mesh = getMeshWithCache(components, args.meshId);
    const node = mesh?.nodes?.find((candidate: any) => meshNodeIdMatches(candidate, args.nodeId));
    const workspace = readNonEmptyString(node?.workspace);
    if (!workspace) return;
    if (!existsSync(workspace)) return;

    const policy = resolveAutoFastForwardPolicy(mesh);
    if (!policy.enabled) return;
    if (nodeHasActiveMeshWork(components, args.meshId, args.nodeId, args.sessionId)) return;

    const throttleKey = `${args.meshId}:${args.nodeId}`;
    const now = Date.now();
    const lastAttempt = idleAutoFastForwardLastAttempt.get(throttleKey) || 0;
    if (now - lastAttempt < IDLE_AUTO_FAST_FORWARD_THROTTLE_MS) return;
    idleAutoFastForwardLastAttempt.set(throttleKey, now);

    const submoduleIgnorePaths = Array.isArray(node?.policy?.submoduleIgnorePaths)
        ? node.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
        : undefined;
    try {
        const dryRun = await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace,
            execute: false,
            dryRun: true,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: 'idle_auto',
        });
        if (!dryRun || dryRun.code !== 'fast_forward_available' || dryRun.allowed !== true) return;
        const behind = Number(dryRun.current?.behind);
        if (policy.maxBehind !== undefined && Number.isFinite(behind) && behind > policy.maxBehind) return;
        if (policy.requireCleanSubmodules) {
            const submodules = Array.isArray(dryRun.current?.submodules) ? dryRun.current.submodules : [];
            if (submodules.some((submodule: any) => submodule?.dirty || submodule?.outOfSync || submodule?.error)) return;
        }
        await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace,
            execute: true,
            dryRun: false,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: 'idle_auto',
        });
    } catch (e: any) {
        LOG.warn('MeshFastForward', `Idle auto fast-forward check failed for ${args.nodeId}: ${e?.message || e}`);
    }
}

export function runIdleMaintenanceThenAssignQueue(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    sessionId: string;
    providerType: string;
}): void {
    setImmediate(() => {
        maybeAutoFastForwardIdleNode(components, args)
            .finally(() => {
                try {
                    tryAssignQueueTask(components, args.meshId, args.nodeId, args.sessionId, args.providerType);
                } catch (e: any) {
                    LOG.warn('MeshQueue', `Failed to assign idle queue task after maintenance for ${args.nodeId}: ${e?.message || e}`);
                }
            });
    });
}

