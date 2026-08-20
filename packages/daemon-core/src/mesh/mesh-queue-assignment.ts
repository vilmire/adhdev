import { existsSync } from 'fs';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { MESH_CONNECT_TIMEOUT_MS } from '../runtime-defaults.js';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { detectCLI } from '../detection/cli-detector.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, claimNextTask, updateTaskStatus, getQueue, recordTaskAutoLaunch, getActiveDirectDispatches, isTaskReadonly, taskDependenciesSatisfied, meshTaskNotBeforeReady, meshTaskPriorityRank, requeueTask, parkTaskTargetPin, failRetentionExpiredParkedTask } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { resolveTranscriptAuthorityProfile } from '../providers/transcript-evidence.js';
import { fastForwardMeshNode } from './mesh-fast-forward.js';
import { createSessionDelivery, updateSessionDeliveryStatus } from './mesh-delivery-policy.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { traceMeshEventDrop } from './mesh-event-trace.js';
import { awaitWithWarmupDeadline, resolveWarmupDeadlineOpts } from './mesh-warmup-deadline.js';
import { delegatedWorkerAutoApproveSettings, resolveProviderMaxParallel, resolveSlotMaxParallel, resolveNodeSchedulingPriority, normalizeMeshSchedulingStrategy, resolveMaxParallelTasks, resolveMaxReadonlyParallelTasks, resolveCoordinatorIdlePushPolicy } from '../repo-mesh-types.js';
import { loadRepoMeshJsonConfig } from '../config/mesh-json-config.js';
import type { RepoMeshDeclarativeConfig } from '../config/mesh-json-config.js';
import type { RepoMeshSchedulingStrategy, RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { normalizeMeshNodeId, meshNodeIdMatches, daemonIdsEquivalent, canonicalDaemonId, expandDaemonIdForms, normalizeMeshWorkspaceForCompare, meshWorkspacesEquivalent, sessionIdsEquivalent, normalizeNodeCapabilitySlots, isMeshTaskDifficulty, withStatusProbeMarker, type MeshNodeIdentified, type NodeCapabilitySlot, type MeshTaskDifficulty } from '@adhdev/mesh-shared';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { resolveDaemonSiblingNodeIds, effectiveSlotCap } from './mesh-daemon-slot-axis.js';
import { evaluateProviderQuotaGate, quotaSpreadBonusByProvider, rankProvidersByQuotaGate, recordLastQuotaRanking, quotaFactsContextForLiveRouting, ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON, type ProviderQuotaGateBlock, type QuotaFactsContext } from './mesh-quota-routing.js';
import { findTerminalLedgerEvidenceForTask, hasUnterminalDirectDispatchLedgerEntry } from './mesh-events-stale.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId, isMeshNodeHealthLaunchable, isMeshNodeFreshEnoughToLaunch } from './mesh-node-identity.js';
import { queuePendingMeshCoordinatorEvent, retractPendingDispatchBlockedEvent, drainPendingMeshCoordinatorEvents } from './mesh-events-pending.js';
import { isWorktreeBootstrapStaleRunning, shouldDeferDispatchForBootstrap } from './worktree-bootstrap-config.js';
import { isWithinCloneBootstrapGrace } from './mesh-clone-grace.js';
import { beginTaskDispatchInFlight, endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { isModelCompatibleWithProvider } from './model-provider-compat.js';
import { decideSlotForModel, isModelAllowedBySlot, SLOT_MODEL_ABSENT_SKIP_REASON, SLOT_MODEL_BUSY_SKIP_REASON } from './slot-model-enforcement.js';
import { openTurnAttempt, recordTurnAck, closeAttemptForReassignment, assertPromptInjectionAllowed, noteTargetPinCleared, rebindAttemptToLiveHolder } from './mesh-turn-ledger.js';
import { classifyDuplicateMeshDispatch } from './mesh-duplicate-dispatch.js';
import { isWorkspaceAutoFastForwardInFlight, resolveAutoFastForwardPolicy, isDirtyNode, maybeAutoFastForwardIdleNode } from './mesh-auto-fast-forward.js';
import { isActionableSkipReason, isTargetNodeTransientlyUnresolved, resolveDeadTargetVerdict, retractActionableSkipIfPreviouslyNotified, notifyCoordinatorOfActionableSkip, resolveTargetPinTtlVerdict, TARGET_SESSION_PIN_TTL_MS, TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON } from './mesh-skip-notify.js';
import { PARKED_SKIP_REASON, parkExpiredTargetPin, settleParkedQueueTask, taskIsParked } from './mesh-task-parking.js';
import { activeWriteAssignedCount, activeReadonlyAssignedCount, activeAssignedCount, nodeHasActiveAssignment, sessionHasActiveAssignment, meshHasExplicitSlots, resolveSchedulingStrategy, buildSchedulingPool, orderEligibleNodes, orderSlotsForProviderSelection, bestSlotForTask, scoreSlotForTask, nodeActiveLoad, activeProviderAssignedCount, slotCoversTaskDifficulty, slotDifficultyTierForTask, taskRequiresDifficultyFloor, slotHasCapacity, slotCapacityRemaining, resolveLaunchAxis, type RankableNode, type IdleCandidate, type FitnessTask } from './mesh-scheduling-fitness.js';
import { AUTO_LAUNCH_LEDGER_DEDUP_MAX, clearAllQuotaClaimCandidatesBlockedState, clearQuotaClaimBlockState, logAllQuotaClaimCandidatesBlocked, logAutoLaunchQuotaFallbackSuccess, logQuotaClaimBlockTransition, logQuotaClaimFallbackSuccess, recordAutoLaunchEvent, type QuotaClaimDrainTrace } from './mesh-queue-observability.js';
import { buildAutoLaunchRoutingDecision, buildProviderSelectionDiagnostics, selectionRationaleFrom, type MeshTaskRoutingDecision, type ResolvedProviderSelection } from './mesh-routing-decision.js';
import {
    sweepAutoLaunchOrphanSessions,
    autoLaunchWriteWouldClobberWinner,
    autoLaunchAwaitClaimBackoff,
    awaitClaimWindowMs,
    remoteSessionAppearsLive,
    inWindowAutoLaunchSessionIdsForNode,
    AUTO_LAUNCH_REMOTE_IDLE_TTL_MS,
    AUTO_LAUNCH_AWAIT_CLAIM_MS,
    __clearAwaitClaimBackoffForTests,
    __resetAutoLaunchOrphanNotifiedForTests,
} from './mesh-autolaunch-integrity.js';
import { allowedClassifiedDifficultiesForSession, handleDifficultyFloorSkip, isDifficultyFloorWaitReason, readSessionModel, taskMeetsSessionDifficultyFloor } from './mesh-difficulty-floor.js';

export type { MeshTaskRoutingDecision } from './mesh-routing-decision.js';
export { DIFFICULTY_FLOOR_REPORT_AFTER_MS, resetDifficultyFloorReportsForTests as __resetDifficultyFloorReportsForTests } from './mesh-difficulty-floor.js';

// The four concerns below were split out of this module (pure move). Their public
// symbols are re-exported here so the module's export surface — which several suites
// and the mesh-events / mesh-events-coordinator barrels import through — is unchanged.
export {
    isWorkspaceAutoFastForwardInFlight,
    maybeAutoFastForwardIdleNode,
    runContinuousAutoFastForwardScan,
    runPendingCoordinatorCatchupScan,
    __resetIdleAutoFastForwardForTests,
} from './mesh-auto-fast-forward.js';
export { __isActionableSkipReasonForTests } from './mesh-skip-notify.js';
// activeWriteAssignedCount / activeReadonlyAssignedCount / sessionHasActiveAssignment are
// imported above for internal use, so they are re-exported by name rather than via
// `export ... from` (which would collide with the import binding).
export { activeWriteAssignedCount, activeReadonlyAssignedCount, sessionHasActiveAssignment };
export { AUTO_LAUNCH_LEDGER_DEDUP_MAX };
export {
    __resolveSchedulingStrategyForTests,
    __orderEligibleNodesForTests,
    __buildSchedulingPoolForTests,
    __decideSlotForModelForTests,
    __orderSlotsForProviderSelectionForTests,
    __scoreSlotForTaskForTests,
    __slotHasCapacityForTests,
} from './mesh-scheduling-fitness.js';

/**
 * CANON: the single canonical coordinator-daemon id this daemon stamps onto every
 * worker dispatch (meshContext.coordinatorDaemonId / sourceCoordinatorDaemonId / the
 * co-located meshCoordinatorDaemonId anchor). loadConfig().machineId is the bare
 * `mach_X` form; canonicalizing to `daemon_mach_X` unifies it with the MCP-side
 * resolveCoordinatorDaemonId producer so the two dispatch paths can never stamp a
 * worker's coordinator anchor in two different forms — the CANON-IDENTITY
 * double-dispatch root cause. Consumers of the anchor already compare under
 * daemonIdsEquivalent / expandDaemonIdForms, so the exact form is form-agnostic on
 * the read side; this only removes the producer-side skew.
 */
function localCoordinatorDaemonId(): string | undefined {
    return canonicalDaemonId(readNonEmptyString(loadConfig().machineId));
}


/**
 * Load the repo-shared `.adhdev/mesh.json` for a node's workspace, tolerating a
 * missing/invalid file (returns null → resolver falls back to provider-spec
 * defaults, i.e. exactly the pre-providerDefaults behavior). Only the
 * `providerDefaults` zone influences the delegated-worker MODE selection; it never
 * touches the ENABLE decision. When a node carries no workspace path (should not
 * happen for a launchable node, but be defensive), we skip the read entirely.
 */
export function loadRepoConfigForNode(node: any): RepoMeshDeclarativeConfig | null {
    const workspace = typeof node?.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
    if (!workspace) return null;
    try {
        const result = loadRepoMeshJsonConfig(workspace);
        if (result.sourceType !== 'repo_file' || !result.config) return null;
        // REMOTE-NODE-AUTO-APPROVE-MODE-DELIVERY: loadRepoMeshJsonConfig falls back to
        // process.cwd() when the requested workspace carries no config. On a coordinator
        // running inside its own checkout, that fallback would return the COORDINATOR's
        // mesh.json for a REMOTE node whose workspace lives on another machine —
        // attributing one machine's declared modes to another. Only accept a file that
        // actually lives under the node's own workspace; the worker re-resolves its real
        // config at launch time (delegated-worker-mode-delivery.ts).
        if (!isConfigPathInsideWorkspace(result.path, workspace)) return null;
        return result.config;
    } catch {
        return null;
    }
}

/** True when the matched config file actually lives under `workspace`. */
function isConfigPathInsideWorkspace(configPath: string | undefined, workspace: string): boolean {
    if (typeof configPath !== 'string' || !configPath) return false;
    const toPosix = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const ws = toPosix(workspace);
    const target = toPosix(configPath);
    return !!ws && (target === ws || target.startsWith(`${ws}/`));
}

/**
 * Coordinator-side observability for the previously SILENT downgrade: the repo asked
 * for a mode but this process could not read that node's workspace (the remote-node
 * case), so the envelope carries the provider-spec default instead. The worker
 * re-resolves at launch, but the coordinator log is what makes the gap visible from
 * the side that made the decision.
 */
function warnUnreadableRepoConfigForNode(node: any, providerType: string | undefined): void {
    const workspace = typeof node?.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
    if (!workspace) return;
    const nodeId = readNonEmptyString(node?.id) || readNonEmptyString(node?.nodeId) || 'unknown-node';
    LOG.warn(
        'MeshQueue',
        `repo mesh.json unreadable from this daemon for node=${nodeId} workspace=${workspace} `
        + `provider=${providerType || 'unknown'} — delegated auto-approve MODE falls back to the provider `
        + `default here; the worker daemon re-resolves it from its own checkout at launch`,
    );
}

/**
 * Resolve the delegated-worker auto-approve envelope for a node, warning when the
 * repo config that should decide the MODE is not readable from this process.
 */
function delegatedWorkerAutoApproveSettingsForNode(
    mesh: any,
    node: any,
    provider: any,
    providerType: string | undefined,
): ReturnType<typeof delegatedWorkerAutoApproveSettings> {
    const repoConfig = loadRepoConfigForNode(node);
    if (!repoConfig) warnUnreadableRepoConfigForNode(node, providerType);
    return delegatedWorkerAutoApproveSettings(mesh?.policy, node?.policy, provider, repoConfig, providerType);
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
 * local config stay config-authoritative — their STATIC fields are taken verbatim
 * from localMesh, so base node claim/matching is byte-for-byte unchanged. Only nodes
 * that exist solely in the inline cache (the cloned worktree nodes) are appended.
 * Identity comparison uses the shared 3-form normalizer (id / nodeId / node_id),
 * identical to every other claim-path consumer — the matching logic is untouched,
 * only which nodes are visible.
 *
 * BOOTSTRAP-DEFER VIEW-CONSISTENCY (this fix): for a worktree node that IS registered
 * in local config, the union previously took the config node verbatim and discarded the
 * inline-cache entry entirely. But the inline cache holds the FRESHER runtime bootstrap
 * state — markWorktreeBootstrapTerminalState stamps worktreeBootstrap.status='complete'
 * synchronously into the inline cache, while local config lags behind the detached async
 * persist chain (and on the coordinator may never receive it at all). A config-registered
 * worktree node therefore read a permanently stale 'running' here, so
 * shouldDeferDispatchForBootstrap deferred its claim forever. We now MERGE the inline
 * cache's dynamic runtime bootstrap state onto the config node (config keeps its static
 * fields; worktreeBootstrap is preferred from the inline cache) so EVERY consumer of the
 * merged view — not just tryAssignQueueTask's gate — observes the terminal stamp.
 *
 * RESIDUAL-getMeshWithCache-bootstrap-overlay (precedence guard): the overlay is DIRECTIONAL —
 * it prefers the inline entry ONLY when the inline runtime state is actually fresher, never
 * merely because the inline entry carries a status. inlineBootstrapIsFresher() (below) permits
 * the overlay in exactly two cases, mirroring the mission's "terminal OR strictly newer" rule:
 *   (1) the inline state is TERMINAL ('complete'/'failed') while the config state is NOT — the
 *       markWorktreeBootstrapTerminalState synchronous stamp the async config persist has not
 *       yet caught up to; this is the whole point of the overlay (opens the gate).
 *   (2) both states are non-terminal but the inline startedAt is STRICTLY newer — a re-driven
 *       bootstrap whose fresher 'running' epoch the config has not observed.
 * It REFUSES the overlay when the config state is already terminal and the inline state is a
 * stale/non-terminal 'running' — otherwise a stale inline 'running' would MASK a genuinely
 * complete config node and re-defer its claim forever (the exact anti-case this guard closes).
 * And when both are 'running' with no newer epoch, the config value is kept and the gate still
 * defers — the half-built-worktree → empty-session defense is preserved: only a terminal-confirmed
 * inline state, never an ambiguous read, ever opens the gate.
 */
const BOOTSTRAP_TERMINAL_STATUSES = new Set(['complete', 'failed']);

function bootstrapEpochMs(bootstrap: any): number {
    const raw = readNonEmptyString(bootstrap?.startedAt) || readNonEmptyString(bootstrap?.completedAt);
    if (!raw) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Directional freshness test for the bootstrap overlay: may the inline runtime state
 * REPLACE the config runtime state? True only when the inline state is terminal and the
 * config state is not (the synchronous terminal stamp the async persist lags), or when
 * both are non-terminal but the inline epoch is strictly newer. A terminal config state is
 * never overwritten by a non-terminal inline read (the stale-'running'-masks-complete
 * anti-case), and equal states never trigger a rewrite.
 */
function inlineBootstrapIsFresher(inlineBootstrap: any, configBootstrap: any): boolean {
    const inlineStatus = readNonEmptyString(inlineBootstrap?.status);
    if (!inlineStatus) return false;
    const configStatus = readNonEmptyString(configBootstrap?.status);
    const inlineTerminal = BOOTSTRAP_TERMINAL_STATUSES.has(inlineStatus);
    const configTerminal = !!configStatus && BOOTSTRAP_TERMINAL_STATUSES.has(configStatus);
    // Config already terminal: only a DIFFERENT terminal inline state (e.g. config 'complete'
    // vs a later 'failed' re-drive) may supersede it; a non-terminal inline read must never
    // mask a terminal config state.
    if (configTerminal) {
        return inlineTerminal && inlineStatus !== configStatus
            && bootstrapEpochMs(inlineBootstrap) > bootstrapEpochMs(configBootstrap);
    }
    // Config not terminal: an inline terminal state is always fresher (opens the gate).
    if (inlineTerminal) return true;
    // Both non-terminal: prefer inline only when its epoch is strictly newer (a re-driven
    // bootstrap the config has not observed). Equal/older ⇒ keep config, gate still defers.
    return bootstrapEpochMs(inlineBootstrap) > bootstrapEpochMs(configBootstrap);
}

function mergeInlineCacheOnlyNodes(localMesh: any, cachedMesh: any): any {
    const localNodes = Array.isArray(localMesh?.nodes) ? localMesh.nodes : [];
    const cachedNodes = Array.isArray(cachedMesh?.nodes) ? cachedMesh.nodes : [];
    if (!cachedNodes.length) return localMesh;
    // Index inline-cache nodes by identity so we can (a) append cache-only nodes and
    // (b) prefer the inline runtime bootstrap state on config-registered nodes.
    const cacheOnly = cachedNodes.filter((cachedNode: any) => {
        const cachedId = readMeshNodeId(cachedNode);
        // Unidentifiable cache entries can never be a claim/route target — skip them
        // rather than appending junk that no consumer can address.
        if (!cachedId) return false;
        return !localNodes.some((localNode: any) => meshNodeIdMatches(localNode, cachedId));
    });
    // Overlay the inline cache's fresher worktreeBootstrap state onto any config node that
    // also exists in the inline cache. inlineBootstrapIsFresher() gates the overlay to the
    // "terminal OR strictly newer" cases, so a stale inline 'running' can never mask a
    // terminal config state and the gate's deferral is preserved for a genuine 'running'.
    let overlaidLocalNodes: any[] = localNodes;
    let overlaid = false;
    for (let i = 0; i < localNodes.length; i++) {
        const localNode = localNodes[i];
        const localId = readMeshNodeId(localNode);
        if (!localId) continue;
        const inlineMatch = cachedNodes.find((cachedNode: any) => meshNodeIdMatches(cachedNode, localId));
        if (!inlineMatch) continue;
        if (!inlineBootstrapIsFresher(inlineMatch.worktreeBootstrap, localNode.worktreeBootstrap)) continue;
        if (!overlaid) {
            overlaidLocalNodes = [...localNodes];
            overlaid = true;
        }
        // Keep the config node's static fields; overlay only the dynamic worktreeBootstrap
        // runtime substate (fresher terminal stamp / epoch) — config identity is unchanged.
        overlaidLocalNodes[i] = { ...localNode, worktreeBootstrap: inlineMatch.worktreeBootstrap };
    }
    if (!cacheOnly.length && !overlaid) return localMesh;
    return { ...localMesh, nodes: [...overlaidLocalNodes, ...cacheOnly] };
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
    // LEDGER-TASK-TRACEABILITY (A): routing rationale to record on task_dispatched.
    routingDecision?: MeshTaskRoutingDecision;
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
    appendLedgerEntry(ctx.meshId, {
        kind: 'task_dispatched',
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
        },
    });
}

export const __recordTaskDispatchedLedgerForTests = recordTaskDispatchedLedger;

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
        const isQueued = res && typeof res === 'object' && res.status === 'queued';
        updateSessionDeliveryStatus(delivery.id, isQueued ? 'queued' : 'delivered');
        // TURN-LEDGER (Stage 5): the transport confirm IS the delivered evidence — the
        // prompt/input submission reached the provider/PTY boundary and the durable
        // delivery record was just committed above. Record the ACK idempotently; a
        // consumed-stage attempt (worker ack raced ahead) is left untouched by the
        // monotonic guard.
        //
        // DISPATCH-ACK-EVIDENCE: a QUEUED result is a positive receipt too, and it used to
        // record nothing at all. The adapter buffered the prompt in its outbound queue
        // because the session was busy — the message IS held for that session and will be
        // submitted when it frees up. Leaving the attempt at 'accepted' made that state
        // byte-identical to "never dispatched", which is what let downstream consumers
        // conclude a delta was lost when it was merely waiting. The delivery record already
        // distinguishes the two ('queued' vs no row); the turn ledger now does as well.
        //
        // Still NOT 'delivered': queued means handed to the adapter's buffer, not to the
        // PTY. Recording it as delivered would license the redrive gates to treat a merely
        // buffered prompt as submitted. The stage stays 'accepted' and the distinction is
        // carried as evidence on the ack, so nothing that keys on stage rank changes
        // behavior — this is an observability addition, not a control-flow change.
        if (ctx.task.attemptId) {
            try {
                recordTurnAck({
                    meshId: ctx.meshId,
                    taskId: ctx.task.id,
                    kind: isQueued ? 'accepted' : 'delivered',
                    attemptId: ctx.task.attemptId,
                    sessionId: ctx.sessionId,
                    ...(isQueued ? { evidence: { source: 'transport_queued_in_adapter' } } : {}),
                });
            } catch { /* ACK is best-effort — the delivery record above is the pre-Stage-5 witness */ }
        }
    }).catch((e: any) => {
        if (timer) clearTimeout(timer);
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
            const rebind = rebindAttemptToLiveHolder({
                meshId: ctx.meshId,
                taskId: ctx.task.id,
                holderSessionId: duplicate.holderSessionId,
            });
            if (rebind.rebound || rebind.reason === 'same_session') {
                LOG.info('MeshQueue', `Duplicate dispatch of task ${ctx.task.id} refused by node ${ctx.nodeId}: it is already being worked by live session ${duplicate.holderSessionId}. Task stays assigned; turn attempt ${rebind.attemptId ?? 'n/a'} ${rebind.rebound ? 'rebound to that session' : 'was already bound to it'}.`);
                updateSessionDeliveryStatus(delivery.id, 'delivered');
                try {
                    appendLedgerEntry(ctx.meshId, {
                        kind: 'dispatch_duplicate_rebound',
                        nodeId: ctx.nodeId,
                        sessionId: duplicate.holderSessionId,
                        payload: {
                            taskId: ctx.task.id,
                            deliveryId: delivery.id,
                            transport: ctx.transport,
                            attemptedSessionId: ctx.sessionId,
                            holderSessionId: duplicate.holderSessionId,
                            ...(rebind.attemptId ? { attemptId: rebind.attemptId } : {}),
                            rebound: rebind.rebound,
                        },
                    });
                } catch { /* ledger write is best-effort */ }
                return;
            }
            // The refusal was genuine but the attempt could not be rebound (already
            // terminal, or no attempt row). Fall through: the task returns to pending and
            // a later tick re-dispatches it — the pre-fix behavior, which is safe here.
            LOG.warn('MeshQueue', `Duplicate dispatch of task ${ctx.task.id} refused by node ${ctx.nodeId} (holder ${duplicate.holderSessionId}), but the turn attempt could not be rebound (${rebind.reason}) — falling back to the requeue path.`);
        }
        // A dispatch failure (transport reject OR hang timeout) is most often transient —
        // a busy/refusing adapter, or a relay that never acked — not a permanent task
        // failure. Marking the task terminal here would permanently kill tasks a later
        // tick delivers fine. Return it to 'pending' and record a retryable dispatch_failed
        // ledger entry so the reconcile loop re-dispatches it. Identical for both transports.
        LOG.error('MeshQueue', `Failed to dispatch task via ${ctx.transport} to node ${ctx.nodeId}: ${e?.message}`);
        updateSessionDeliveryStatus(delivery.id, 'failed', { lastError: e?.message, incrementAttempt: true });
        // The dispatch failed — the task is no longer in-flight (it returns to pending
        // for a clean re-dispatch). Clear the single-flight mark so a legitimate
        // requeue/re-claim is not blocked as if a worker were still generating.
        endTaskDispatchInFlight(ctx.meshId, ctx.task.id);
        // TURN-LEDGER (Stage 5): the dispatch never reached the worker — close this
        // attempt (reassigned:dispatch_failed); the re-claim opens a fresh attempt.
        try {
            closeAttemptForReassignment({ meshId: ctx.meshId, taskId: ctx.task.id, reason: 'dispatch_failed' });
        } catch { /* best-effort */ }
        // DEAD-DISPATCH-BOUND: return the row to 'pending' THROUGH the retry budget rather
        // than with a bare status flip.
        //
        // The bare `updateTaskStatus(..., 'pending')` this replaces was the unbounded leg of
        // the re-dispatch loop: it reset the row to claimable while touching neither
        // requeueCount nor any other counter, so a target that fails EVERY time — a node
        // absent from the live mesh, whose P2P dial can never be answered — was re-claimed
        // and re-failed on every drain forever. Observed live 2026-08-11 (task 25994f43 →
        // node_d4bc9f12…, 17 dispatches in 64s, dispatchNonce to 23, ended only by a manual
        // mesh_queue_cancel). `isRetryableDispatchFailure` already existed but was computed
        // ONLY for the ledger payload below — purely descriptive, gating nothing — so even
        // the self-dial classification it was written for never actually stopped the cycle.
        //
        // requeueTask supplies the bound that was missing: it increments requeueCount and,
        // past maxRetries, auto-fails the row (`max_retries_exceeded`) and cascades to
        // dependents, so an undeliverable task reaches a terminal state instead of cycling.
        // This is the SAME budget every other requeue path spends, so a genuinely transient
        // failure keeps its ordinary retries — the fix bounds the loop, it does not remove
        // retrying. Pins are preserved (clearTargetSession:false): a dispatch failure says
        // nothing about whether the pin is still the right destination, and DEAD-TARGET-
        // SELFHEAL owns unpinning on its own liveness evidence.
        //
        // A failure the transport classified as non-recoverable (self-dial: a retry re-runs
        // an identical decision on identical inputs) skips the budget entirely and fails the
        // row now — retrying it is provably pointless.
        const retryable = isRetryableDispatchFailure(e);
        if (!retryable) {
            failTaskAsUndeliverable(ctx, `dispatch_unrecoverable: ${e?.message || 'transport reported the failure as non-recoverable'}`);
        } else {
            // DISPATCH-BOOT-RACE: route through the dispatch-failure axis, NOT
            // requeueCount/maxTaskRetries — the worker never started this task, so it
            // must not spend the same budget a worker-side execution failure spends.
            // See dispatchFailureCount / MAX_DISPATCH_FAILURES doc (mesh-work-queue.ts).
            // This also carries the escalating backoff (notBefore) that keeps a
            // re-dispatch from racing the exact boot window that just failed.
            const requeued = requeueTask(ctx.meshId, ctx.task.id, {
                reason: 'dispatch_failed',
                clearTargetSession: false,
                dispatchFailure: true,
            });
            // requeueTask no-ops (null) only when the row is already gone/terminal — nothing
            // left to schedule. When it auto-failed on the cap, say so plainly in the log so
            // the terminal state is not mistaken for a silent drop.
            if (requeued?.status === 'failed') {
                LOG.error('MeshQueue', `Task ${ctx.task.id} (mesh ${ctx.meshId}) failed after repeated dispatch failures to node ${ctx.nodeId} — the worker never started it: ${requeued.cancelReason || 'dispatch_never_started'}. Dependents were unblocked.`);
            }
        }
        try {
            appendLedgerEntry(ctx.meshId, {
                kind: 'dispatch_failed' as any,
                nodeId: ctx.nodeId,
                sessionId: ctx.sessionId,
                payload: { taskId: ctx.task.id, deliveryId: delivery.id, error: e?.message, retryable, transport: ctx.transport },
            });
        } catch { /* ledger write is best-effort */ }
    });
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
        appendLedgerEntry(ctx.meshId, {
            kind: 'task_failed' as any,
            nodeId: ctx.nodeId,
            sessionId: ctx.sessionId,
            payload: { taskId: ctx.task.id, reason, undeliverable: true },
        });
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

// WTCLAIM: workspace normalization for base-vs-worktree comparison now lives in
// @adhdev/mesh-shared (normalizeMeshWorkspaceForCompare) so the enqueue→claim path,
// the mesh_status per-node session filter, and the read_chat node scope guard all
// share one comparison rule instead of drifting module-private copies.

/**
 * Resolve the transcript-authority profile of the LIVE claiming session's
 * provider module (runtime capability, not manifest — a manifest may declare
 * nativeHistory the live-loaded session doesn't have). Row-lean subset: the
 * nativeHistory config itself stays local. Undefined when the session isn't
 * locally observable — the row simply carries no stamp and consumers fall
 * back to local resolution (older-daemon rows look the same).
 */
function resolveClaimingSessionTranscriptProfile(
    components: DaemonComponents,
    sessionId: string,
): MeshWorkQueueEntry['assignedTranscriptProfile'] {
    try {
        const instances = components.instanceManager?.getByCategory?.('cli') || [];
        const inst = instances.find((i: any) => {
            const sid = i?.getState?.().instanceId;
            return typeof sid === 'string' && sid && sessionIdsEquivalent(sid, sessionId);
        }) as { provider?: unknown } | undefined;
        const provider = inst?.provider;
        if (!provider || typeof provider !== 'object') return undefined;
        const profile = resolveTranscriptAuthorityProfile(provider as Parameters<typeof resolveTranscriptAuthorityProfile>[0]);
        return { class: profile.class, timing: profile.timing, emitsPtyTurnEvents: profile.emitsPtyTurnEvents };
    } catch {
        return undefined;
    }
}

export function tryAssignQueueTask(
    components: DaemonComponents,
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string,
    // LEDGER-TASK-TRACEABILITY (A): routing rationale computed by the auto-launch drain
    // (fitness score, skipped candidates, resolved model/thinking). Threaded to the
    // task_dispatched ledger entry. Other claim paths (event/idle drain) omit it and the
    // entry records source:'queue' with just the resolved provider from the claimed row.
    routingDecision?: MeshTaskRoutingDecision,
    quotaClaimTrace?: QuotaClaimDrainTrace,
): boolean {
    const mesh = getMeshWithCache(components, meshId);
    // Match with the shared 3-form normalizer (id / nodeId / node_id), not raw
    // `n.id` — a stamp-form nodeId vs the mesh node's config-form id must still
    // resolve, mirroring the remote idle-session path below (:1341).
    const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, nodeId));

    // OBSERVABILITY (quota-ranking gap C): this is the single funnel every claim
    // path flows through (auto-launch, event-driven agent:ready, idle drain,
    // reconcile re-drain). Only the auto-launch path (source:'autoLaunch') just
    // ran the ranking loop and already wrote a real record for this nodeId —
    // every OTHER path adopts whatever provider the already-running session
    // already has, without ranking anything. Recording that fact here (instead
    // of leaving it silently absent) makes the gap itself visible in
    // getLastQuotaRanking/mesh_status, rather than looking identical to "never
    // dispatched here yet".
    if (routingDecision?.source !== 'autoLaunch') {
        recordLastQuotaRanking(nodeId, { decidedAt: Date.now(), winner: providerType, adopted: true });
    }

    // AUTO-FF LEASE: an auto fast-forward may be mutating this node's workspace right
    // now (git merge --ff-only can move HEAD). Dispatching a task into it mid-checkout
    // would run the worker against an inconsistent tree. Skip the claim while the lease
    // is held — the task stays pending (return false without touching its status) and
    // re-fires on the next drain tick, by which time the short ff has released the lease.
    // Keyed by canonical workspace so a node sharing a workspace with the one being ff'd
    // is also gated. No-op unless an auto ff is actually in flight (default: never).
    if (isWorkspaceAutoFastForwardInFlight(readNonEmptyString(node?.workspace))) {
        LOG.info('MeshQueue', `Deferring queue claim for node ${nodeId} (${sessionId}): an auto fast-forward is mutating its workspace — task left pending, claim re-fires next tick`);
        return false;
    }

    // QUOTA GATE (claim path): the same evaluateProviderQuotaGate the auto-launch
    // loop applies before SPAWNING a session also gates an idle session's CLAIM —
    // otherwise an idle session on a quota-exhausted node would pull the pending
    // task the launch gate deliberately left queued. Same WAIT semantics: the
    // window resets, so the block is not actionable — the task stays pending
    // (return false without touching its status) and the drain simply moves on to
    // the next candidate / re-fires on the next tick. Reads only the in-memory
    // nodeFacts bundle or same-daemon clone source (synchronous; never triggers a
    // quota fetch). Missing/stale/unmarked non-'ok' snapshots fail OPEN exactly as
    // in the launch path; fresh last-good windows remain measurable. Log-only
    // like the lease defer above — no ledger entry, so a repeatedly gated claim
    // does not flood the ledger every drain tick.
    const quotaClaimBlock = evaluateProviderQuotaGate(node, providerType, mesh?.policy?.quotaRouting ?? null, Date.now(), quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader));
    if (quotaClaimTrace) quotaClaimTrace.evaluated += 1;
    if (quotaClaimBlock) {
        const observation = { nodeId, sessionId, providerType, block: quotaClaimBlock };
        logQuotaClaimBlockTransition(meshId, observation);
        quotaClaimTrace?.blocked.push(observation);
        return false;
    }
    clearQuotaClaimBlockState(meshId, nodeId, sessionId, providerType);
    if (quotaClaimTrace) quotaClaimTrace.clear += 1;

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
    // COMPLETION-PROPAGATION F7 (C2 SSOT): resolve the node's bootstrap status from the router's
    // synchronous inline cache FIRST — the authoritative source markWorktreeBootstrapTerminalState
    // stamps synchronously — falling back to the merged claim view only when the inline node carries
    // no bootstrap status. getMeshWithCache takes a config-REGISTERED node verbatim from local
    // config, whose bootstrap status lags the inline stamp (the detached async persist chain), so a
    // config-registered worktree node could read a stale 'running' here and defer a claim whose
    // bootstrap is already complete. Reading the inline node removes that stale-'running' defer,
    // symmetric with the remote dispatch guard (cli-agent.ts F6). Conservative: only override with
    // the inline node when it actually carries a status (an incomplete inline entry never masks a
    // genuine config 'running').
    const inlineBootstrapNode = (() => {
        try {
            const inlineMesh = components.router?.getCachedInlineMesh?.(meshId);
            const inlineNode = Array.isArray(inlineMesh?.nodes)
                ? inlineMesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId))
                : undefined;
            return readNonEmptyString(inlineNode?.worktreeBootstrap?.status) ? inlineNode : undefined;
        } catch { return undefined; }
    })();
    const bootstrapGateNode = inlineBootstrapNode ?? node;
    if ((bootstrapGateNode as { worktreeBootstrap?: { status?: string } } | undefined)?.worktreeBootstrap?.status === 'running') {
        // Fix (3) safety net + F7: shouldDeferDispatchForBootstrap returns false when the 'running'
        // state is stale (older than the backstop AND git-clean) — treat that as silently complete
        // and allow the claim; otherwise defer (leave the task pending) so the claim re-fires once
        // bootstrap reaches a terminal state and never dispatches into a half-built worktree.
        if (!shouldDeferDispatchForBootstrap(bootstrapGateNode as any)) {
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
    let claimStampedNodeId = '', claimState: any;
    try {
        claimState = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
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
    // Per-(node, provider) maxParallel cap (summed across the node's slots for this
    // provider) layers on top of the global/taskMode caps — stricter wins. Resolved
    // here where the claiming session's providerType + node policy are both known,
    // then enforced inside the atomic claim transaction so concurrent claims can't
    // overshoot it.
    const nodeSlotsForCap = resolveNodeCapabilitySlots(node, meshId);
    const providerMaxParallel = resolveProviderMaxParallel(nodeSlotsForCap, providerType);
    // PER-SLOT cap. `maxParallel` bounds ONE SLOT (a (provider, model) pair), not a
    // shared provider pool: a node pinning claude-cli/opus to 1 means opus runs one
    // task at a time even while the claude-cli/sonnet slot sits idle. Summing them
    // (the provider cap above) let opus borrow sonnet's headroom and run up to the
    // total, defeating the cost/rate-limit intent of pinning it.
    //
    // Auto-launch knows the selected model; idle/event claims use live model metadata
    // when available and otherwise apply the conservative intersection of provider slots.
    const assignedModel = typeof routingDecision?.resolvedModel === 'string' && routingDecision.resolvedModel.trim()
        ? routingDecision.resolvedModel.trim()
        : readSessionModel(claimState);
    const allowedTaskDifficulties = allowedClassifiedDifficultiesForSession(node, nodeSlotsForCap, providerType, assignedModel);
    const claimingSlot = nodeSlotsForCap.find(s =>
        s.provider?.trim() === providerType && isModelAllowedBySlot(assignedModel, s));
    const slotMaxParallel = claimingSlot
        ? resolveSlotMaxParallel(nodeSlotsForCap, providerType, claimingSlot.model, isModelAllowedBySlot)
        : undefined;
    // WTDISPATCH-FANOUT: tell the atomic claim whether the claiming node is a worktree
    // clone so a `convergence` task (base-only: merge → push → cleanup) is refused for
    // worktree sessions. Without it, every sibling worktree session on this daemon could
    // claim the same convergence intent and race push/production-deploy (the 4-way fan-out).
    const nodeIsWorktree = node?.isLocalWorktree === true;
    // P1 transcript-authority stamp: the claim runs on the daemon that owns the
    // session, so the LIVE provider module (runtime capability, not manifest) is
    // resolvable here — classify once and persist it on the row so coordinator-side
    // gates (early-arm / redrive) can classify this worker without local access.
    const assignedTranscriptProfile = resolveClaimingSessionTranscriptProfile(components, sessionId);
    // ★ DAEMON-AXIS CAP SCOPE. The provider/slot maxParallel caps above are counted
    // over the physical DAEMON MACHINE, not this node alone: `maxParallel` bounds a
    // machine resource (CPU, memory, upstream rate limit, one on-disk CLI auth),
    // while a node is a branch-isolation unit. Counting per node meant cloning a
    // worktree multiplied the budget — three worktrees of one repo on one laptop
    // each carried their own `opus: 1` and ran three opus processes against a cap of
    // one. Remote machines declare their own daemonId and so keep separate budgets.
    const daemonNodeIds = resolveDaemonSiblingNodeIds(nodeId, mesh?.nodes);
    const task = claimNextTask(meshId, nodeId, sessionId, capabilityTags, {
        providerType,
        ...(providerMaxParallel !== undefined ? { providerMaxParallel } : {}),
        ...(assignedModel ? { assignedModel } : {}),
        ...(slotMaxParallel !== undefined ? { slotMaxParallel } : {}),
        daemonNodeIds,
        nodeIsWorktree,
        ...(allowedTaskDifficulties ? { allowedTaskDifficulties } : {}),
        ...(assignedTranscriptProfile ? { assignedTranscriptProfile } : {}),
    });
    if (!task) {
        return false;
    }

    if (quotaClaimTrace?.blocked.length) {
        logQuotaClaimFallbackSuccess(quotaClaimTrace.blocked, task.id, { nodeId, sessionId, providerType });
        quotaClaimTrace.blocked = [];
        quotaClaimTrace.evaluated = 0;
        quotaClaimTrace.clear = 0;
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

    // TURN-LEDGER (Stage 5): open the authoritative attempt for THIS dispatch. The
    // claim already bumped the dispatch nonce, so the attempt's seq (= nonce) makes a
    // crash-retried open idempotent and a later reclaim's re-dispatch a NEW attempt.
    // Stamping entry.attemptId persists the correlation key on the queue row; the
    // meshContext below carries it to the worker, which echoes it on every lifecycle
    // event. Best-effort: a store failure degrades to the pre-Stage-5 nonce-only path.
    let dispatchAttemptId: string | undefined;
    try {
        const { attempt } = openTurnAttempt({
            meshId,
            taskId: task.id,
            dispatchNonce: task.dispatchNonce ?? 0,
            nodeId,
            sessionId,
            providerType,
            coordinatorDaemonId: localCoordinatorDaemonId(),
            coordinatorSessionId: readNonEmptyString(task.sourceCoordinatorSessionId) || undefined,
        });
        dispatchAttemptId = attempt.attemptId;
        task.attemptId = attempt.attemptId;
        MeshRuntimeStore.getInstance().updateQueueEntry(task);
    } catch (e: any) {
        LOG.warn('TurnLedger', `Failed to open turn attempt for task ${task.id} (dispatch proceeds on the legacy nonce path): ${e?.message || e}`);
    }
    // TURN-LEDGER (Stage 5): a prompt must never be injected into an attempt that has
    // already CONSUMED one. The fresh claim above normally guarantees a pre-consumed
    // attempt, but a same-tick duplicate dispatch path (or a crash/replay) must fail
    // closed here rather than double-execute the task.
    if (dispatchAttemptId) {
        try {
            const attemptRow = MeshRuntimeStore.getInstance().getTurnAttempt(dispatchAttemptId);
            if (!assertPromptInjectionAllowed(attemptRow, `queue claim dispatch task ${task.id} → session ${sessionId}`)) {
                updateTaskStatus(meshId, task.id, 'pending');
                return false;
            }
        } catch { /* guard is best-effort */ }
    }

    // LEDGER-TASK-TRACEABILITY (C): the task just transitioned pending→assigned. Record
    // the claim (distinct from the later task_dispatched, which fires when the message is
    // handed to the transport in deliverTaskToSession). This is the single funnel every
    // claim path (event/idle drain, auto-launch, remote reclaim) flows through, so one
    // append here covers them all. Best-effort — a ledger write must never fail a claim.
    try {
        appendLedgerEntry(meshId, {
            kind: 'task_claimed',
            nodeId,
            sessionId,
            providerType,
            taskId: task.id,
            payload: {
                taskId: task.id,
                ...(task.missionId ? { missionId: task.missionId } : {}),
                nodeId,
                sessionId,
                providerType,
                claimedAt: new Date().toISOString(),
            },
        });
    } catch { /* best-effort — claim proceeds regardless */ }

    // FALSE-BLOCKER-CLONE-QUEUE (stale-event clear): the task just claimed and will dispatch,
    // so any actionable blocker previously paged for it (e.g. a 'target_node_id_unmatched'
    // emitted during the clone/bootstrap propagation window before the node became
    // claimable) is now stale — re-arm the de-dup ledger and retract any undelivered
    // dispatch_blocked event so the coordinator does not keep seeing a resolved blocker.
    retractActionableSkipIfPreviouslyNotified(meshId, task.id);

    // CANON-IDENTITY single-flight: mark the just-claimed task in-flight the moment it
    // is handed to a transport. The atomic claim already prevents a concurrent claim,
    // but this lets requeueTask distinguish a genuinely-generating task (refuse the
    // operator requeue — it would open a second session) from a stale assigned row
    // (still requeueable). Cleared when the task leaves `assigned` (terminal / dispatch
    // failure / cancel / reclaim).
    beginTaskDispatchInFlight(meshId, task.id);

    // COORDINATOR-SILENT-IDLE (opt-in): when the mesh policy is
    // 'auto_silent_on_dispatch', carry a one-shot silent-idle-push signal in the
    // dispatch meshContext. The worker stamps settings.silentNextIdlePush on its own
    // live session (cli-manager send_chat), so the SINGLE completion that follows this
    // dispatch rides a muted status snapshot and the server suppresses ONLY that
    // routine idle push. Status-gated + TTL-bounded downstream (see resolveMuted), so
    // approval/failure/long-running notifications and never-completing workers are
    // unaffected. Default 'always' → this stays undefined and nothing changes.
    const silentIdlePushOnDispatch =
        resolveCoordinatorIdlePushPolicy(mesh?.policy) === 'auto_silent_on_dispatch';

    // CANON-IDENTITY: read the remote daemon id through the normalizing helper so a node
    // whose daemonId arrives in a non-top-level-camelCase serialization form (daemon_id /
    // machine.daemonId / lastProbe.machine.daemon_id / …) is still recognized as remote.
    // Reading raw `node.daemonId` here made the guard false for those forms, so the remote
    // block was skipped and execution fell through to the LOCAL cliManager.handleCliCommand
    // path — which has no adapter for the remote sessionId and threw
    // 'Cannot read properties of undefined (reading handleCliCommand)'.
    const remoteDaemonId = readMeshNodeDaemonId(node ?? {});
    if (remoteDaemonId && components.dispatchMeshCommand) {
        // WTDISPATCH-SELFDIAL: locality is a DAEMON-IDENTITY question, not a session-presence
        // one. This used to ask only `cliManager.adapters.has(sessionId)` — a raw Map lookup
        // that is false for any session whose id is not byte-identical to a live adapter key
        // on this daemon (a co-located worktree sibling observed solely through the
        // remote-idle store, an ACP worker whose instanceId is minted independently of its
        // adapter key, a prefixed id form). A local worktree node INHERITS the coordinator's
        // own daemonId from the node it was cloned from (mesh-crud.ts addNode), so
        // readMeshNodeDaemonId above returns THIS daemon's id and the false branch dialed
        // P2P to ourselves — which daemon-mesh-manager's isSelfDial correctly refuses
        // ("Refusing to send mesh command … to this daemon's own id"), failing the dispatch
        // deterministically while the ledger booked it retryable.
        //
        // Ask the identity question FIRST, through the same canon-aware predicate the
        // auto-launch path already uses (isLocalAutoLaunchNode → daemonIdsEquivalent, with
        // an explicit isLocalWorktree branch). The adapter probe stays as a secondary
        // signal so a node carrying NO resolvable daemon identity keeps its prior behavior.
        const isLocalNode = isLocalAutoLaunchNode(node) || components.cliManager.adapters.has(sessionId);
        if (!isLocalNode) {
            const localDaemonIdForDispatch = localCoordinatorDaemonId();
            // (3) Originating coordinator session that enqueued this task — route its
            // completion back to that exact session (multi-coordinator). Carried over P2P
            // to the remote worker, which echoes it on its completion event.
            const sourceCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId) || undefined;
            const dispatchMeshCommand = components.dispatchMeshCommand;
            // CONS3: only the transport call differs — everything else (delivery record,
            // status transitions, requeue-on-failure, ledger, Bug B hang timeout) is in
            // the shared deliverTaskToSession helper.
            deliverTaskToSession(
                () => dispatchMeshCommand(remoteDaemonId, 'agent_command', {
                    targetSessionId: sessionId,
                    cliType: providerType,
                    action: 'send_chat',
                    message: task.message,
                    // DISPATCH-SOURCE-TRACE: call-site tag echoed in the worker daemon log.
                    dispatchSource: 'mesh-queue-assignment:tryAssignQueueTask:remote',
                    meshContext: {
                        meshId,
                        nodeId,
                        taskId: task.id,
                        // REDRIVE-DUP: carry the current dispatch nonce so the worker can echo it
                        // back on generating_started; a reclaim bumps this row's nonce, making an
                        // already-in-flight stale inject rejectable on arrival.
                        ...(typeof task.dispatchNonce === 'number' ? { dispatchNonce: task.dispatchNonce } : {}),
                        // TURN-LEDGER (Stage 5): the opaque attempt identity for this dispatch —
                        // echoed on the worker's lifecycle events so ACKs/completion proposals
                        // correlate to (taskId, attemptId, session), not just the nonce.
                        ...(dispatchAttemptId ? { attemptId: dispatchAttemptId } : {}),
                        ...(localDaemonIdForDispatch ? { coordinatorDaemonId: localDaemonIdForDispatch } : {}),
                        ...(sourceCoordinatorSessionId ? { coordinatorSessionId: sourceCoordinatorSessionId } : {}),
                        ...(silentIdlePushOnDispatch ? { silentIdlePush: true } : {}),
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
                    ...(routingDecision ? { routingDecision } : {}),
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
            // without an auto-approve boolean/mode still resolves the delegated policy once dispatched
            // to it (the "approval notification fires only for certain delegated sessions"
            // case). updateSettings preserves runtime mesh keys; passing autoApprove keeps it.
            //
            // This local-dispatch branch also runs on the coordinator daemon for a co-located
            // session, so the coordinator daemon id IS this daemon's id. Stamp it alongside
            // the node identity so the session is fully relay-safe (meshCoordinatorDaemonId is
            // the anchor the forwarder keys on), matching what mesh_launch_session stamps.
            const localDaemonId = localCoordinatorDaemonId();
            const localSourceCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId);
            inst.updateSettings({
                meshNodeFor: meshId,
                meshNodeId: nodeId,
                launchedByCoordinator: true,
                ...delegatedWorkerAutoApproveSettingsForNode(
                    mesh,
                    node,
                    components.providerLoader?.getMeta(providerType),
                    providerType,
                ),
                ...(localDaemonId ? { meshCoordinatorDaemonId: localDaemonId } : {}),
                // COMPLETION-PROPAGATION F5: (re)stamp the coordinator SESSION anchor from THIS
                // task's sourceCoordinatorSessionId with PRIORITY — a manually-launched (or reused)
                // session may already carry a stale anchor from mesh_launch_session or a prior task,
                // and a stale session anchor makes the completion unicast to the wrong/absent
                // coordinator session (targetCoordinatorSessionId), stranding it. When this task
                // carries a source, overwrite; when it carries NONE, CLEAR the anchor to undefined
                // (updateSettings merges, so an explicit undefined overrides) so the completion
                // cannot be misrouted by a stale unicast anchor and instead BROADCASTS — the real
                // coordinator (which drains its own pending queue) then picks it up. Daemon-level
                // routing (meshCoordinatorDaemonId above) is unaffected.
                meshCoordinatorSessionId: localSourceCoordinatorSessionId || undefined,
            });
        }
    } catch { /* best-effort — dispatch still proceeds */ }

    // CONS3: same shared dispatch lifecycle as the remote branch — only the transport
    // (cliManager.handleCliCommand) differs.
    // ARCH-REFACTOR R1: carry meshContext (incl. taskId) on the LOCAL dispatch too, so
    // handleCliCommand's send_chat path binds this task to its turn (per-turn identity).
    // Previously only the remote branch shipped meshContext.taskId; the local path relied
    // on the last-write-wins session scalar, which races a follow-up task and made the
    // completion echo the wrong taskId (the standalone NOTIF-MISDELIVER repro).
    deliverTaskToSession(
        () => components.cliManager.handleCliCommand('agent_command', {
            targetSessionId: sessionId,
            cliType: providerType,
            action: 'send_chat',
            message: task.message,
            // DISPATCH-SOURCE-TRACE: call-site tag echoed in the daemon log.
            dispatchSource: 'mesh-queue-assignment:tryAssignQueueTask:local',
            meshContext: {
                meshId,
                nodeId,
                taskId: task.id,
                // REDRIVE-DUP: carry the current dispatch nonce (see remote branch above).
                ...(typeof task.dispatchNonce === 'number' ? { dispatchNonce: task.dispatchNonce } : {}),
                // TURN-LEDGER (Stage 5): the opaque attempt identity (see remote branch above).
                ...(dispatchAttemptId ? { attemptId: dispatchAttemptId } : {}),
                ...(localCoordinatorDaemonId() ? { coordinatorDaemonId: localCoordinatorDaemonId() } : {}),
                ...(readNonEmptyString(task.sourceCoordinatorSessionId) ? { coordinatorSessionId: readNonEmptyString(task.sourceCoordinatorSessionId) } : {}),
                ...(silentIdlePushOnDispatch ? { silentIdlePush: true } : {}),
            },
        }),
        {
            meshId,
            nodeId,
            sessionId,
            providerType,
            task,
            transport: 'local',
            ...(readNonEmptyString(task.sourceCoordinatorSessionId) ? { sourceCoordinatorSessionId: readNonEmptyString(task.sourceCoordinatorSessionId) } : {}),
            ...(localCoordinatorDaemonId() ? { sourceCoordinatorDaemonId: localCoordinatorDaemonId() } : {}),
            ...(routingDecision ? { routingDecision } : {}),
        },
    );

    return true;
}

// Per-(mesh,NODE) launch lock: two concurrent launches never land on the SAME node. It does
// NOT cover the same TASK across DIFFERENT nodes — autoLaunchTaskInProgress below closes that.
const autoLaunchInProgress = new Set<string>();
// AUTOLAUNCH-TASK-RACE. Per-(mesh,TASK) launch lock, keyed `${meshId}::${taskId}`. Held across
// the WHOLE per-task iteration (all gates + the launch), released in a `finally` so no early
// `continue` / `return` / throw can strand it — a stranded entry would wedge the task pending
// forever, which is strictly worse than the duplicate it prevents.
// Why a per-TASK lock is needed on top of the per-node one, and the live evidence for it:
// see the AUTOLAUNCH-TASK-RACE section at the top of mesh-autolaunch-integrity.ts.
const autoLaunchTaskInProgress = new Set<string>();
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
// Defined in mesh-autolaunch-integrity (alongside the backoff state that consumes them) and
// re-exported here, which is the path existing callers/tests import from.
export { AUTO_LAUNCH_AWAIT_CLAIM_MS };
export { __seedAutoLaunchAwaitClaimBackoffForTests } from './mesh-autolaunch-integrity.js';

// AUTOLAUNCH-CLAIM-CHURN. For a REMOTE node the launch→claim handshake is purely
// event-sourced: the worker's agent:ready must be pulled (reconcile PHASE 1) to run
// setRemoteIdleSession before the drain can claim. If that pull is lost, nothing recovers,
// and after AUTO_LAUNCH_AWAIT_CLAIM_MS the loop used to blindly RESPAWN a new session — whose
// respawn guards (nodeHasLiveSessionPendingClaim / liveSessionCountForNode) scan only the LOCAL
// instanceManager, so the remote pending-claim session is invisible and a fresh ghost accumulates
// every ~90s (observed live 2026-07-04: task 8b188c64, and 7 ghost sessions on this worktree's
// own task at 11:23-11:34). Instead of respawning on window expiry, we re-drive the claim for the
// EXISTING session; when its liveness cannot be positively determined we EXTEND the window with
// exponential backoff (90 → 180 → 360s) and, only after the cap, deliver the task directly into
// the launched session (the mesh_send_task-equivalent) rather than spawning another worker.
const AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES = 2;


// Test hooks: reset / seed the await-claim backoff state between cases.
export function __resetAutoLaunchAwaitClaimBackoffForTests(): void {
    __clearAwaitClaimBackoffForTests();
    autoLaunchTaskInProgress.clear();
    autoLaunchInProgress.clear();
    __resetAutoLaunchOrphanNotifiedForTests();
}
/** @internal Test-only: is the per-task auto-launch lock held? The AUTOLAUNCH-TASK-RACE suite
 *  asserts it is released on every exit path (a leak would wedge the task pending forever). */
export function __autoLaunchTaskLockHeldForTests(meshId: string, taskId: string): boolean {
    return autoLaunchTaskInProgress.has(`${meshId}::${taskId}`);
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

// Exported (Fix B, rc.15 orchestration RCA) so the explicit mesh_send_task dispatch path
// (med-family/cli-agent.ts) can reuse the SAME status/liveness probe to independently confirm a
// pinned target session is genuinely ready before overriding the coarse worktreeBootstrap
// 'running' defer for that one session. Never returns true for 'starting' / 'waiting_approval' /
// 'generating' / any other non-idle status — those still refuse the override.
export function isIdleSessionState(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    if (isTerminalSessionStatus(status)) return false;
    return status === 'idle' || state?.activeChat?.status === 'waiting_input';
}


function sessionStateLooksActive(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    const chatStatus = readNonEmptyString(state?.activeChat?.status).toLowerCase();
    // 'long_generating' is retained as a legacy alias for the renamed 'no_progress' busy status.
    const active = new Set(['generating', 'streaming', 'no_progress', 'long_generating', 'working', 'starting', 'waiting_approval']);
    return active.has(status) || active.has(chatStatus);
}

/** @internal Split-visibility only: the auto-fast-forward module gates its ff on the
 *  same "is this node busy" predicate. Not public surface — no consumer outside
 *  src/mesh imports it, and neither re-export barrel lists it. */
export function nodeHasActiveMeshWork(components: DaemonComponents, meshId: string, nodeId: string, currentSessionId?: string): boolean {
    if (nodeHasActiveAssignment(meshId, nodeId)) return true;
    return components.instanceManager.getByCategory('cli').some((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        // Match under canonical machine-core form, NOT a raw `!==`: a session's stamped
        // meshNodeId and the candidate nodeId can carry interchangeable daemon-id forms
        // (bare `mach_X` vs `daemon_mach_X`). A raw mismatch makes a BUSY node look idle,
        // so the active-work gate passes and a SECOND session is launched/claimed for a
        // task already running here — the CANON-IDENTITY duplicate dispatch.
        if (!daemonIdsEquivalent(instNodeId, nodeId)) return false;
        const sessionId = readNonEmptyString(state.instanceId);
        if (currentSessionId && sessionIdsEquivalent(sessionId, currentSessionId) && isIdleSessionState(state)) return false;
        return sessionStateLooksActive(state);
    });
}

function isLaunchableNode(node: any): boolean {
    if (!node || node.status === 'disabled' || node.status === 'removed') return false;
    // BOOTSTRAP-POLICY-CONSISTENCY (Fix B, rc.15 orchestration RCA): a worktree node whose
    // bootstrap is still 'running' must be excluded from auto-launch candidacy, not merely
    // deferred at claim time. Before this, isLaunchableNode passed a bootstrapping node through,
    // so maybeAutoLaunchOneQueueSession could spawn a session (launch_cli) on it — an ORPHAN,
    // since tryAssignQueueTask's own bootstrap gate (mirrors this same predicate) then defers the
    // claim onto that freshly-spawned session anyway, leaving it stranded with nothing assigned
    // while the node's real bootstrap-driven session comes up separately. Reusing
    // shouldDeferDispatchForBootstrap (rather than a raw status check) keeps this in agreement
    // with the claim gate's stale-running backstop: a 'running' stamp old enough and verified
    // git-clean is treated as silently complete and does not block launch.
    if (shouldDeferDispatchForBootstrap(node as { worktreeBootstrap?: { status?: string; startedAt?: string; updatedAt?: string; completedAt?: string }; workspace?: string })) {
        return false;
    }
    // Delegate the health gate to the shared resolver so the auto-launch gate and the
    // MAGI fan-out planner agree on exactly what "launchable health" means (online /
    // unknown / absent pass; degraded / offline / dirty / wrong_branch are blocked).
    return isMeshNodeHealthLaunchable(node);
}

/** Whether a mesh node's daemon/machine identity resolves to THIS coordinator daemon
 *  (i.e. the queue session can be spawned by a direct local `launch_cli`). */
/** @internal Split-visibility only: the auto-fast-forward and skip-notify modules both
 *  need the same local-vs-remote node verdict. Not public surface — no consumer outside
 *  src/mesh imports it, and neither re-export barrel lists it. */
export function isLocalAutoLaunchNode(node: any): boolean {
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
    //
    // CANON-IDENTITY: read the daemonId through the normalizing helper (same defect class
    // as the dispatch guard above). A raw `node.daemonId` read misses non-top-level-camelCase
    // serialization forms (daemon_id / machine.daemonId / lastProbe.machine.daemon_id / …),
    // so a genuinely-remote node arriving in one of those forms read empty here and was
    // wrongly skipped as `remote_auto_launch_unsupported`. readMeshNodeDaemonId returns
    // undefined (falsy) when absent — equivalent to the old readNonEmptyString + !daemonId
    // guard, so local/self auto-launch is unchanged.
    const daemonId = readMeshNodeDaemonId(node ?? {});
    if (!daemonId) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    if (!components.dispatchMeshCommand) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    // CANON: stamp the canonical `daemon_mach_` coordinator anchor onto the remote
    // worker (meshCoordinatorDaemonId) so its completion forwards back under the same
    // form every other dispatch path uses — no producer-side coordinator-id skew.
    const coordinatorDaemonId = localCoordinatorDaemonId();
    if (!coordinatorDaemonId) return { mode: 'skip', reason: 'remote_auto_launch_no_coordinator_daemon_id' };
    return { mode: 'remote', daemonId, coordinatorDaemonId };
}
/**
 * CANON-IDENTITY single-flight hardening (restart-safe, observation-based).
 *
 * The in-memory single-flight Set (mesh-task-inflight) is process-local and is LOST on a
 * daemon restart — after a restart, a task still being generated by a live local worker is
 * no longer marked in-flight, so requeueTask's Set check passes and would re-open the task
 * for a duplicate second dispatch. This recovers the "still generating" signal from
 * observable runtime state instead of the in-memory mark: a session is actively generating
 * when its live local CLI instance reports an active (generating/streaming/…) status — the
 * same predicate the dispatch active-work gate uses (sessionStateLooksActive).
 *
 * Local-only by design: it inspects THIS daemon's instanceManager. The primary cross-process
 * fix (IpcTransport requeue delegating to the mesh-host daemon) keeps begin (dispatch) and
 * check (requeue guard) co-located so the in-memory mark stays authoritative in the common
 * path; this is the restart-safety net for sessions hosted on this daemon. A genuinely
 * dead/stale session is not generating → returns false → the requeue proceeds as before.
 */
export function isSessionActivelyGenerating(components: DaemonComponents, sessionId: string): boolean {
    if (!sessionId) return false;
    const state = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
    if (!state) return false;
    return sessionStateLooksActive(state);
}

/**
 * RECLAIM-FALSEPOS tri-state busy verdict for a session id.
 *
 * The binary isSessionActivelyGenerating() folds "absence of a positive generating
 * signal" into a definitive NEGATIVE (returns false when the instance is absent). But a
 * REMOTE session (never in THIS daemon's instanceManager) — or a locally-present session
 * looked up under a skewed id form — then looks "not generating" and can be reclaimed out
 * from under a worker that is genuinely mid-turn. This resolves an explicit three-way
 * verdict instead:
 *   - GENERATING       — a locally-present instance reports an active/streaming state.
 *   - IDLE_CONFIRMED    — a locally-present instance reports a non-active (idle/terminal)
 *                         state. Positive local evidence the worker is not working.
 *   - UNKNOWN           — no locally-present instance matches (remote / gone / id-skew) or
 *                         the observation failed. NEVER treated as IDLE_CONFIRMED.
 *
 * The lookup scans getByCategory('cli') with sessionIdsEquivalent (the same equivalence
 * matching nodeHasActiveMeshWork / liveSessionCountForNode use) rather than a raw
 * instanceManager.getInstance(id) Map.get, so an id-form-skewed but present session is
 * found (closing the same id-form-skew hole class e245c2f9's F1 fixed elsewhere).
 */
export type SessionBusyVerdict = 'GENERATING' | 'IDLE_CONFIRMED' | 'UNKNOWN';
export function resolveSessionBusyVerdict(components: DaemonComponents, sessionId: string): SessionBusyVerdict {
    if (!sessionId) return 'UNKNOWN';
    try {
        const instances = components.instanceManager?.getByCategory?.('cli') || [];
        const inst = instances.find((i: any) => {
            const sid = readNonEmptyString(i?.getState?.().instanceId);
            return sid && sessionIdsEquivalent(sid, sessionId);
        });
        if (!inst) return 'UNKNOWN'; // remote / gone / id-form skew not present locally
        const state = inst.getState?.();
        if (!state) return 'UNKNOWN';
        return sessionStateLooksActive(state) ? 'GENERATING' : 'IDLE_CONFIRMED';
    } catch {
        return 'UNKNOWN'; // failed observation ⇒ unknown, never a definitive idle
    }
}

function liveSessionCountForNode(components: DaemonComponents, meshId: string, nodeId: string): number {
    const localInstances = components.instanceManager.getByCategory('cli').filter((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        // Canonical-form match (see nodeHasActiveMeshWork): a daemon-id form skew between
        // the session's stamped nodeId and the candidate nodeId must not undercount this
        // node's live sessions, which would defeat the maxConcurrentSessions cap.
        if (!daemonIdsEquivalent(instNodeId, nodeId)) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        return !isTerminalSessionStatus(status);
    });
    let count = localInstances.length;
    // (A) AUTOLAUNCH-CLAIM-CHURN: also count launched-but-not-yet-claimed sessions targeting this
    // node whose await-claim window is still open. A REMOTE such session is invisible to the local
    // instanceManager above, so without this the maxConcurrentSessions cap undercounts it and a
    // duplicate ghost launch slips through. Exclude any id already represented by a local instance
    // so a co-located launch is not double-counted.
    const localSessionIds = localInstances
        .map((inst: any) => readNonEmptyString(inst.getState().instanceId))
        .filter(Boolean);
    for (const sid of inWindowAutoLaunchSessionIdsForNode(meshId, nodeId)) {
        if (!localSessionIds.some(local => sessionIdsEquivalent(local, sid))) count += 1;
    }
    return count;
}

/**
 * DOUBLE-DISPATCH auto-launch gate: does this node already have a LIVE mesh session that
 * is NOT holding an assigned queue task — i.e. one that is idle, booting toward its first
 * claim, or in a momentary non-idle flip? Such a session WILL claim a still-pending task
 * on its own via the idle→claim / agent:ready drain, so spawning a NEW session here only
 * races it and yields a duplicate worker that double-stamps the same taskId (the
 * enqueue → drain-miss → auto-launch RCA: the drain skipped a momentarily-non-idle idle
 * session as a candidate, and the write-only nodeHasActiveAssignment gate — which only
 * inspects status='assigned' rows — could not see the about-to-claim session either).
 *
 * A session that already HOLDS an assigned queue task is genuine concurrent work, not a
 * free claimer, and is excluded — so a read-only auto-launch onto a busy-but-no-idle node
 * is still allowed. A node with NO live mesh session at all (dead, or never launched) does
 * not match, preserving the legitimate first-session spawn.
 *
 * PROVIDER-MATCH gate (DISPATCH-DEADLOCK-PROVIDER-MISMATCH): a live session only suppresses
 * this launch if it could ACTUALLY claim THIS task. A session whose providerType does not
 * satisfy the task's requiredTags (e.g. a claude-cli coordinator/worker session on a node,
 * while the pending task is required_tags: [provider=codex-cli]) is NOT a pending claimer for
 * this task — claimNextQueueTask's nodeSatisfiesRequiredTags gate would reject its claim. Left
 * unchecked, such a mismatched session made this gate return true for a task it can never claim,
 * so the required-provider worker never auto-launched AND no session could claim → nobody made
 * progress → permanent silent deadlock. Mirror the claim path: build the session's own
 * capability tags (its providerType pinned onto the node) and only count it as a pending claimer
 * when those tags satisfy task.requiredTags. `node` is passed in so the tag set reflects this
 * node's os/arch/worktree/converge context, matching claimNextQueueTask exactly.
 */
function nodeHasLiveSessionPendingClaim(components: DaemonComponents, meshId: string, nodeId: string, task: MeshWorkQueueEntry, node: any): boolean {
    // (A) AUTOLAUNCH-CLAIM-CHURN remote-awareness: a task whose auto-launch record targets this
    // node and is still inside its await-claim window (base or backoff) already has a session on
    // its way to claim — even when that session is REMOTE and thus invisible to the local
    // instanceManager scan below. Treat it as a live pending-claim session so a duplicate launch
    // is suppressed and no ghost accumulates every ~90s.
    if (inWindowAutoLaunchSessionIdsForNode(meshId, nodeId).length > 0) return true;
    // Session ids currently holding an assigned queue task on this node — those are busy,
    // not pending claimers, so they must NOT suppress a (read-only) launch.
    const busySessionIds = new Set(
        getQueue(meshId, { status: ['assigned'] as any })
            .filter(task => daemonIdsEquivalent(task.assignedNodeId, nodeId))
            .map(task => readNonEmptyString(task.assignedSessionId))
            .filter(Boolean),
    );
    return components.instanceManager.getByCategory('cli').some((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        // DISPATCH-DEADLOCK-COORD-SESSION-SLOT: a coordinator session for THIS mesh
        // (meshCoordinatorFor === meshId) is never a pending-claim worker — the idle→claim
        // drain (drainMeshQueue, isIdleSessionState + worker role) never picks it up, because
        // a coordinator is generating/non-idle and is the dispatcher, not a claimer. The claim
        // path excludes it structurally; the skip gate must apply the SAME exclusion. Without
        // this, a node whose only live mesh session is the coordinator makes this gate return
        // true, so no worker auto-launches and no session ever claims → the task pends forever
        // with no error/requeue (silent deadlock). The busy-set / non-idle guards below don't
        // help because the coordinator holds no *assigned* queue task, so it is neither busy
        // nor terminal here.
        if (readNonEmptyString(settings.meshCoordinatorFor) === meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        // Canonical-form match (see nodeHasActiveMeshWork / liveSessionCountForNode): a
        // daemon-id form skew must not make a present session look absent and reopen the
        // duplicate-launch hole.
        if (!daemonIdsEquivalent(instNodeId, nodeId)) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        if (isTerminalSessionStatus(status)) return false; // dead → no claimer here, allow launch
        const sessionId = readNonEmptyString(state.instanceId);
        if (sessionId && busySessionIds.has(sessionId)) return false; // busy with its own assigned task
        // PROVIDER-MATCH gate (DISPATCH-DEADLOCK-PROVIDER-MISMATCH): only count this session as a
        // pending claimer if its own provider could satisfy THIS task's requiredTags. A session
        // whose providerType does not match (e.g. a claude-cli session while task requires
        // provider=codex-cli) can never claim this task via claimNextQueueTask's
        // nodeSatisfiesRequiredTags gate, so it must not suppress the required-provider launch —
        // otherwise the task deadlocks (mismatched session blocks launch, yet cannot claim). Mirror
        // the claim path: pin the session's providerType onto this node and check the tags.
        const sessionProviderType = state.type || readNonEmptyString(settings.providerType);
        if (task.requiredTags?.length) {
            if (sessionProviderType && !nodeSatisfiesRequiredTags(task.requiredTags, buildMeshNodeCapabilityTags(node, sessionProviderType))) {
                return false; // provider mismatch → this session can't claim this task; not a pending claimer
            }
        }
        const allowance = allowedClassifiedDifficultiesForSession(node, resolveNodeCapabilitySlots(node, meshId), sessionProviderType, readSessionModel(state));
        if (!taskMeetsSessionDifficultyFloor(task, allowance)) return false;
        return true; // live + unassigned + provider-capable → will claim the pending task itself
    });
}

function markAutoLaunch(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    reason?: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    error?: string;
    // LEDGER-TASK-TRACEABILITY (D): resolved execution profile for started/completed.
    model?: string;
    thinkingLevel?: string;
}) {
    const reason = args.reason || args.error;
    const difficultyFloorSkip = args.status === 'skipped' && isDifficultyFloorWaitReason(reason);
    if (difficultyFloorSkip) {
        handleDifficultyFloorSkip({ meshId, taskId, reason: reason!, nodeId: args.nodeId, coordinatorDaemonId: localCoordinatorDaemonId() });
    } else if (!autoLaunchWriteWouldClobberWinner(meshId, taskId, args, AUTO_LAUNCH_AWAIT_CLAIM_MS)) {
        recordTaskAutoLaunch(meshId, taskId, {
            status: args.status,
            reason,
            nodeId: args.nodeId,
            providerType: args.providerType,
            sessionId: args.sessionId,
        });
    }
    recordAutoLaunchEvent(meshId, {
        phase: args.status,
        taskId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
        reason: args.reason,
        error: args.error,
        ...(args.model ? { model: args.model } : {}),
        ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
    });
    // Fix (1): actively notify the coordinator of a non-self-resolving skip; re-arm the
    // notification on any non-skip transition (started/completed) so a later genuine skip
    // re-notifies.
    if (args.status === 'skipped') {
        if (isActionableSkipReason(args.reason)) {
            notifyCoordinatorOfActionableSkip(meshId, taskId, args.reason, args.nodeId);
        } else if (!difficultyFloorSkip && args.reason === TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON) {
            // FALSE-BLOCKER-CLONE-QUEUE (stale-event clear): the unmatch is now known to be a
            // self-resolving clone/bootstrap window — retract any earlier actionable blocker we
            // paged for this same task. Other transient/back-pressure reasons (cooldown, caps)
            // intentionally do NOT retract: they can mask a still-standing real blocker.
            retractActionableSkipIfPreviouslyNotified(meshId, taskId);
        }
    } else {
        // started/completed: the task is progressing — re-arm the de-dup ledger and retract
        // any still-undelivered stale blocker for it.
        retractActionableSkipIfPreviouslyNotified(meshId, taskId);
    }
}

export const __markAutoLaunchForTests = markAutoLaunch;

async function resolveUsableProvider(
    components: DaemonComponents,
    nodeId: string,
    node: any,
    meshId: string | undefined,
    requiredTags?: string[],
    task?: FitnessTask,
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null,
    quotaFactsContext?: QuotaFactsContext | null,
    taskId?: string,
): Promise<ResolvedProviderSelection & { quotaGated?: Array<{ providerType: string; block: ProviderQuotaGateBlock }> }> {
    const providerLoader = components.providerLoader;
    if (!providerLoader) return { reason: 'provider_loader_unavailable' };

    // Slot-based order (ORCHESTRATION_NODE_SLOTS.md): rank the node's capability
    // slots by task→slot fitness (difficulty/requiredTags) so the best-fit slot's
    // provider is tried first, and its model/thinkingLevel ride along. Falls back
    // to the legacy providerPriority-derived slots when no explicit slots exist.
    // The QUOTA SPREAD bonus folds into the fitness score as a per-provider number
    // computed HERE (the caller side) so scoreSlotForTask itself stays pure.
    //
    // SATURATED-SLOT STARVATION (kimi-never-selected): fitness alone ranked a
    // SATURATED slot ahead of an idle equally-fit one, and this loop returns the
    // first slot whose CLI is detected — it never consulted capacity. On a node
    // with `claude-cli/opus [difficult] maxParallel:1` and `kimi [difficult]
    // maxParallel:2`, both score the same +100 difficulty match, so the stable
    // sort put opus first by ARRAY ORDER on every difficult task and kimi was
    // never selected — not once. Worse, when opus was busy the loop still
    // returned claude-cli, and the downstream SLOT MODEL GUARD ('wait') / the
    // provider-cap check skipped the WHOLE NODE rather than falling through to
    // the node's idle second slot. So a second provider configured precisely to
    // absorb difficult-task overflow was unreachable whether opus was free OR
    // busy. (The quota-spread bonus widened the same gap: a provider whose quota
    // reads 'ok' earns up to +30 while one reporting an error earns 0, turning
    // the tie into a decisive loss.)
    //
    // Capacity is therefore the PRIMARY sort key: an idle slot outranks a
    // saturated one regardless of fitness, and fitness orders within each group.
    // Saturated slots are kept (not filtered) and merely sorted last, so when
    // EVERY slot is at its cap the selection — and the wait/notify semantics the
    // downstream guard derives from it — is byte-identical to before.
    const slots = resolveNodeCapabilitySlots(node, meshId);
    if (!slots.length) return { reason: 'missing_provider_priority' };
    const quotaBonusByProvider = task ? quotaSpreadBonusByProvider(node, quotaRouting, Date.now(), quotaFactsContext) : undefined;
    const orderedSlots = task
        ? orderSlotsForProviderSelection(slots, meshId ?? '', nodeId, node, task, quotaBonusByProvider)
        : slots;
    const difficultyFloorRequired = !!task && taskRequiresDifficultyFloor(node, task);
    if (difficultyFloorRequired && !orderedSlots.length) {
        return { reason: `task_difficulty_floor_unavailable:${task!.difficulty}` };
    }

    const failed: string[] = [];
    // DYNAMIC PROVIDER PRIORITY BY QUOTA: the loop no longer returns the FIRST
    // detected slot. It enumerates EVERY usable (detected) candidate so the
    // quota gate can be applied INSIDE the selection loop — a quota-gated first
    // choice must fall through to the node's next provider, not skip the whole
    // node (previously the gate ran after this function returned a single pair,
    // so a gated provider sent the task to the next NODE even when this node
    // had another provider with quota to spare). Candidates are de-duped per
    // provider, keeping the first — best-ordered — slot for that provider.
    const usableSlots: Array<{ slot: NodeCapabilitySlot; providerType: string }> = [];
    for (const slot of orderedSlots) {
        const requestedType = slot.provider;
        const normalizedType = typeof providerLoader.resolveAlias === 'function'
            ? providerLoader.resolveAlias(requestedType)
            : requestedType;
        // Skip providers that can't satisfy the task's requiredTags (e.g. provider=hermes-cli
        // means only hermes-cli qualifies, not any other slot's provider).
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
        if (detected) {
            usableSlots.push({ slot, providerType: normalizedType });
            continue;
        }
        failed.push(`${requestedType}: not detected`);
    }
    if (!usableSlots.length) {
        if (difficultyFloorRequired) {
            return { reason: `task_difficulty_floor_unavailable:${task!.difficulty}` };
        }
        return { reason: `provider_priority_unusable: ${failed.join('; ') || nodeId}` };
    }

    // HARD DIFFICULTY FLOOR: exclude lower and saturated slots before quota ranking,
    // or WAIT when every sufficient slot is full. Freeform/legacy stay unchanged.
    let candidateSlots = usableSlots;
    if (difficultyFloorRequired) {
        const available = usableSlots.filter(candidate => slotHasCapacity(meshId ?? '', nodeId, node, candidate.slot));
        if (!available.length) return { reason: `task_difficulty_floor_wait:${task!.difficulty}` };
        const tier = Math.min(...available.map(candidate => slotDifficultyTierForTask(candidate.slot, task!.difficulty) ?? Number.POSITIVE_INFINITY));
        candidateSlots = available.filter(candidate => slotDifficultyTierForTask(candidate.slot, task!.difficulty) === tier);
    }
    const candidates: Array<{ slot: NodeCapabilitySlot; providerType: string }> = [];
    const seenProviders = new Set<string>();
    for (const candidate of candidateSlots) {
        if (seenProviders.has(candidate.providerType)) continue;
        seenProviders.add(candidate.providerType);
        candidates.push(candidate);
    }

    // QUOTA GATE, inside the loop: split the usable candidates by the gate and
    // order the survivors by EXPIRY RISK, descending (remaining × elapsed window
    // fraction × reading confidence — an unused remainder evaporates at the
    // window reset, so the least-consumable-in-time remainder is spent first;
    // the owner-confirmed dynamic priority). Fail-open is inherited from
    // evaluateProviderQuotaGate unchanged: missing / stale / unmarked transient
    // readings are never BLOCKED, and a no-longer-current reading that still
    // carries real windows RANKS at a confidence discount instead of sorting
    // unconditionally last (rankProvidersByQuotaGate, RETAINED READINGS — the
    // fleet-wide stranding that fixed). ALL-gated is reported under its own
    // reason so a quota WAIT is never conflated with a slot config error.
    const ranked = rankProvidersByQuotaGate(node, candidates.map(c => c.providerType), quotaRouting, Date.now(), quotaFactsContext);
    const winner = ranked.clear.length
        ? candidates.find(candidate => candidate.providerType === ranked.clear[0]) ?? candidates[0]
        : undefined;
    // `allLosers` is destructured OUT: the rationale's input, not durable.
    const { riskSnapshot, allLosers, ...routingDiagnostics } = buildProviderSelectionDiagnostics({
        node, nodeId, meshId, task, taskId, quotaRouting, quotaFactsContext,
        quotaBonusByProvider, difficultyFloorRequired, usableSlots, candidateSlots, ranked, winner,
    });
    const rationale = selectionRationaleFrom(routingDiagnostics.selectionTrajectory, allLosers);
    if (!ranked.clear.length) {
        const detail = ranked.gated.map(g => `${g.providerType}: ${g.block.reason}`).join('; ');
        LOG.info('MeshQueue', `QUOTA GATE: every usable provider on node ${nodeId} is quota-gated (${detail}); leaving the task queued until a quota window resets`);
        recordLastQuotaRanking(nodeId, {
            decidedAt: Date.now(),
            clear: riskSnapshot,
            gated: ranked.gated.map(g => ({ providerType: g.providerType, reason: g.block.reason })), ...(taskId ? { taskId } : {}),
        });
        return { reason: `${ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON}: ${detail}` };
    }
    const selectedWinner = winner!;
    LOG.debug('MeshQueue', `QUOTA RANK: node ${nodeId} clear=[${riskSnapshot.map(s => `${s.providerType}:${s.risk?.toFixed(1) ?? '?'}`).join(',')}] gated=[${ranked.gated.map(g => `${g.providerType}:${g.block.reason}`).join(',')}] winner=${selectedWinner.providerType}`);
    recordLastQuotaRanking(nodeId, {
        decidedAt: Date.now(),
        winner: selectedWinner.providerType,
        clear: riskSnapshot,
        gated: ranked.gated.map(g => ({ providerType: g.providerType, reason: g.block.reason })),
        ...(taskId ? { taskId } : {}), ...(rationale ? { rationale } : {}),
    });
    return {
        providerType: selectedWinner.providerType,
        ...(ranked.gated.length ? { quotaGated: ranked.gated } : {}),
        ...(selectedWinner.slot.model ? { model: selectedWinner.slot.model } : {}),
        ...(selectedWinner.slot.thinkingLevel ? { thinkingLevel: selectedWinner.slot.thinkingLevel } : {}),
        // The slot that won selection. Returned so the caller can enforce
        // "the launch model must be one this slot declares" — a preset
        // model must not widen what the operator configured. See
        // slot-model-enforcement.ts.
        slot: selectedWinner.slot,
        ...routingDiagnostics,
    };
}

/** Test hook: provider selection with the quota gate applied inside the loop
 *  (dynamic provider priority by quota). */
export const __resolveUsableProviderForTests = resolveUsableProvider;



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

// AUTOLAUNCH-CLAIM-CHURN. The await-claim window for a launched (remote) session has expired
// without a claim. Instead of a blind respawn, re-drive the claim for the EXISTING session,
// backing off when its liveness is unknown, and only respawning when it is provably unclaimable.
// Returns a directive for the caller:
//   - 'claimed'  — the re-drive claimed/dispatched the task into the existing session (progress).
//   - 'fallback' — the post-cap direct dispatch delivered the task into the existing session.
//   - 'backoff'  — liveness unknown; the window was extended (or is still cooling down). No launch.
//   - 'respawn'  — the session is provably gone/unclaimable; the caller may launch a fresh one.
function driveExpiredAwaitClaim(
    components: DaemonComponents,
    meshId: string,
    task: MeshWorkQueueEntry,
    ctx: { sessionId: string; nodeId: string; providerType: string },
): 'claimed' | 'fallback' | 'backoff' | 'respawn' {
    const { sessionId, nodeId, providerType } = ctx;
    const backoffKey = `${meshId}::${task.id}`;
    const nowMs = Date.now();
    const state = autoLaunchAwaitClaimBackoff.get(backoffKey) || { cycles: 0, nextAttemptAtMs: 0 };
    // Rate-limit re-drive attempts to the backoff cadence so the 4s reconcile tick does not hammer
    // a still-cooling-down window. The initial (no-state) expiry proceeds immediately.
    if (state.nextAttemptAtMs && nowMs < state.nextAttemptAtMs) return 'backoff';

    const atCap = state.cycles >= AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES;
    const live = remoteSessionAppearsLive(meshId, sessionId);

    // (B) Re-drive when the remote view shows the session live; (C) after the backoff cap, force the
    // same direct dispatch unconditionally. Both funnel through tryAssignQueueTask, which
    // idempotently (re)registers the session, delivers the task message (send_chat), and marks the
    // row assigned — the exact operation a coordinator performs manually via mesh_send_task. (D)
    // The setRemoteIdleSession re-register makes this robust to a dropped agent:ready.
    if ((live || atCap) && nodeId && providerType) {
        try {
            MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, nodeId, sessionId, providerType, nowMs + AUTO_LAUNCH_REMOTE_IDLE_TTL_MS);
        } catch { /* best-effort re-register */ }
        const assigned = tryAssignQueueTask(components, meshId, nodeId, sessionId, providerType);
        if (assigned) {
            autoLaunchAwaitClaimBackoff.delete(backoffKey);
            const isFallback = atCap && !live;
            recordAutoLaunchEvent(meshId, {
                phase: 'completed',
                taskId: task.id,
                reason: isFallback ? 'await_claim_direct_dispatch_fallback' : 'await_claim_redriven',
                nodeId,
                sessionId,
            });
            // Content-free progress line (ids only).
            LOG.info('MeshQueue', `Auto-launch await-claim ${isFallback ? 'direct-dispatch fallback' : 're-drive'} claimed task ${task.id} into existing session ${sessionId} on node ${nodeId} (mesh ${meshId})`);
            return isFallback ? 'fallback' : 'claimed';
        }
        if (atCap) {
            // The forced dispatch could not claim — the session is genuinely gone/unclaimable.
            // Authorize a fresh respawn (ghosts were already prevented through the backoff window).
            autoLaunchAwaitClaimBackoff.delete(backoffKey);
            return 'respawn';
        }
    }
    // Liveness unknown (or live-but-not-claimable) and not at cap → extend the window with backoff.
    const cycles = Math.min(state.cycles + 1, AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES);
    autoLaunchAwaitClaimBackoff.set(backoffKey, { cycles, nextAttemptAtMs: nowMs + awaitClaimWindowMs(cycles) });
    recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'awaiting_launched_session_claim_backoff', nodeId, sessionId });
    return 'backoff';
}

async function maybeAutoLaunchOneQueueSession(components: DaemonComponents, meshId: string, mesh: any): Promise<boolean> {
    const queue = getQueue(meshId);
    // DEPENDSON-GATE-SYMMETRY: status index over the FULL queue (incl. completed)
    // so the dependency gate below sees the terminal state of every referenced
    // dependency, not just the still-active rows.
    const statusById = new Map(queue.map(task => [task.id, task.status] as const));
    // G6: scan higher task-level priority first so a high-priority task auto-launches its
    // session ahead of an older normal/low task (getQueue is FIFO; a stable sort by priority
    // rank descending keeps created_at order within a priority band). The claim path applies
    // the same ordering, so the launched session pulls the same task the scan chose.
    const pending = queue
        .filter(task => task.status === 'pending')
        .sort((a, b) => meshTaskPriorityRank(b.priority) - meshTaskPriorityRank(a.priority));
    // AUTOLAUNCH-CLAIM-CHURN: prune await-claim backoff state for tasks of this mesh that are no
    // longer pending (claimed/completed/cancelled) so the map cannot grow without bound.
    {
        const pendingIds = new Set(pending.map(t => t.id));
        const prefix = `${meshId}::`;
        for (const key of [...autoLaunchAwaitClaimBackoff.keys()]) {
            if (key.startsWith(prefix) && !pendingIds.has(key.slice(prefix.length))) autoLaunchAwaitClaimBackoff.delete(key);
        }
    }
    if (!pending.length) return false;

    // Launch-freshness threshold: reuse the auto-fast-forward policy's maxBehind (default
    // 0 → any behind blocks) so the launch gate and the repair path agree on how far
    // behind is tolerable. Resolved once per pass and shared across every candidate node.
    const freshnessGate = { maxBehind: resolveAutoFastForwardPolicy(mesh).maxBehind };

    // Write cap + read-only cap resolved through the shared helpers from the
    // MACHINE-LOCAL stored mesh policy (no repo-file overlay). These are the same
    // resolvers the observability projection uses, so the enforced and exposed
    // caps can never drift.
    const maxParallelTasks = resolveMaxParallelTasks(mesh?.policy?.maxParallelTasks);
    // Read-only diagnoses carry no isolation/merge cost, so they are exempt from the
    // write-task parallel cap. To prevent runaway auto-launch they get their own,
    // higher safety cap (default 2× the write cap).
    const maxReadonlyParallelTasks = resolveMaxReadonlyParallelTasks(maxParallelTasks);
    for (const task of pending) {
        // AUTOLAUNCH-TASK-RACE: take the per-TASK lock before ANY gate — everything below is
        // await-interruptible, so this is the only point that can serialize two overlapping
        // triggerMeshQueue passes onto the same task (rationale: mesh-autolaunch-integrity.ts).
        // The busy branch records to the LEDGER ONLY: markAutoLaunch would overwrite
        // task.autoLaunch wholesale and clobber the in-flight racer's record.
        const taskLaunchKey = `${meshId}::${task.id}`;
        if (autoLaunchTaskInProgress.has(taskLaunchKey)) {
            recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'auto_launch_task_in_progress' });
            continue;
        }
        autoLaunchTaskInProgress.add(taskLaunchKey);
        try {
            // DEPENDSON-GATE-SYMMETRY: never spawn a session for a task whose
            // dependsOn set is not all-completed (or that carries a system block). The
            // launched session would idle→claim and be refused by the SAME predicate in
            // claimNextQueueTask, producing orphan-session / re-launch churn. Skip it so
            // a later tick — after the dependency completes — launches it. Tasks with no
            // dependsOn pass through unchanged (predicate is true).
            if (!taskDependenciesSatisfied(task, statusById)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'dependencies_unsatisfied' });
                continue;
            }
            // G7: never spawn a session for a task still held by its notBefore gate — the launched
            // session would idle→claim and be refused by the SAME gate in claimNextQueueTask,
            // producing orphan-session churn. Skip it so a later tick (after not_before passes)
            // launches it. Tasks with no notBefore pass through unchanged.
            if (!meshTaskNotBeforeReady(task)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'not_before_delayed' });
                continue;
            }
            const isReadonly = isTaskReadonly(task);
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
            // PIN-PARKING: a parked row awaits a COORDINATOR decision, so no daemon-side
            // self-heal may touch it. Must stay BEFORE the pin branch below: the dead-target
            // self-heal would otherwise "rescue" a parked task by requeueing it with the
            // session pin cleared — silently re-homing the very delta parking protects.
            if (taskIsParked(task)) {
                settleParkedQueueTask(
                    meshId,
                    task,
                    reason => markAutoLaunch(meshId, task.id, { status: 'skipped', reason }),
                    failRetentionExpiredParkedTask,
                );
                continue;
            }
            if (task.targetSessionId) {
                // DEAD-TARGET-SELFHEAL: before the unconditional target_session_constraint skip,
                // check whether the pinned session/node has DIED (absent from the live mesh). A
                // hard-pinned task whose target is gone can NEVER re-enter 'assigned' (the claim
                // gate refuses every non-matching session) and this skip fires forever with no
                // liveness check — the triple-walled stranded-pending defect. If the pin is
                // confirmed dead past the grace window, requeue it (clearing the dead session
                // pin, and the node pin too when the NODE itself is gone) so a live idle session
                // can claim it. requeueTask counts toward maxTaskRetries → bounded self-heal that
                // auto-fails past the cap (the desired terminal state, unblocking dependents).
                const deadTarget = resolveDeadTargetVerdict(components, meshId, mesh, task);
                if (deadTarget.dead) {
                    const requeued = requeueTask(meshId, task.id, {
                        reason: deadTarget.reason,
                        clearTargetSession: true,
                        // Keep the node pin if only the SESSION died on a still-live node; clear it
                        // when the NODE itself is absent (nothing to pin to).
                        clearTargetNode: deadTarget.nodeDead,
                    });
                    if (requeued) {
                        noteTargetPinCleared(deadTarget.reason);
                        LOG.warn('MeshQueue', `DEAD-TARGET-SELFHEAL: task ${task.id} (mesh ${meshId}) was pinned to a dead target (${deadTarget.reason}); requeued${deadTarget.nodeDead ? ' and unpinned node' : ''} (requeueCount=${requeued.requeueCount ?? '?'}, status=${requeued.status}).`);
                    }
                    // Keep the skip for THIS tick (the requeue already flipped the row to
                    // pending/failed); a later tick assigns/launches the now-unpinned task.
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_dead_requeued' });
                    continue;
                }
                // TARGET-PIN TTL → PARKING. The pin is NOT provably dead (a live session, or a
                // remote/unobservable one the dead-target verdict must not guess about) but has
                // waited past the bounded TTL, measured over UNPRODUCTIVE time only. On expiry
                // the task PARKS rather than unpinning: a cleared pin let any compatible session
                // claim a delta written for one session's context — a wrong delivery, not a late
                // one. See mesh-task-parking.
                if (parkExpiredTargetPin(meshId, task, resolveTargetPinTtlVerdict(components, task), TARGET_SESSION_PIN_TTL_MS, (m, t, r) => parkTaskTargetPin(m, t, { reason: r }))) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: PARKED_SKIP_REASON });
                    continue;
                }
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
                const alSessionId = readNonEmptyString(task.autoLaunch.sessionId);
                const alNodeId = readNonEmptyString(task.autoLaunch.nodeId);
                const alProvider = readNonEmptyString(task.autoLaunch.providerType);
                if (Number.isFinite(launchedAtMs) && Date.now() - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS) {
                    // Record the skip in the ledger ONLY (dedup'd). Do NOT call markAutoLaunch
                    // here: recordTaskAutoLaunch overwrites task.autoLaunch wholesale, which would
                    // erase the very `completed` record (status + sessionId + updatedAt) this guard
                    // reads on the next tick, reopening the duplicate-launch hole it closes.
                    recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'awaiting_launched_session_claim', nodeId: alNodeId, sessionId: alSessionId });
                    continue;
                }
                // AUTOLAUNCH-CLAIM-CHURN: the initial await-claim window expired. Rather than a blind
                // respawn (which the local-only respawn guards can't dedup for a remote pending-claim
                // session → ghost accumulation), re-drive the claim for the EXISTING launched session,
                // backing off on unknown liveness and direct-dispatching after the cap. Only a
                // 'respawn' directive falls through to a fresh launch below.
                if (Number.isFinite(launchedAtMs) && alSessionId && alNodeId) {
                    const outcome = driveExpiredAwaitClaim(components, meshId, task, { sessionId: alSessionId, nodeId: alNodeId, providerType: alProvider });
                    if (outcome === 'claimed' || outcome === 'fallback') return true; // progress; suppress a duplicate launch
                    if (outcome === 'backoff') continue;                              // window extended; no respawn
                    // outcome === 'respawn' → session provably gone; proceed to a fresh launch below.
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
                    // is selected. A node satisfies tags if at least one provider it can launch
                    // would produce matching capability tags. Enumerate providers from the node's
                    // capability slots (the single source of truth — a provider that lives only in
                    // slots, e.g. cursor-cli, is otherwise invisible to providerPriority-keyed
                    // enumeration), falling back to the legacy providerPriority.
                    if (task.requiredTags?.length) {
                        const slotProviders = resolveNodeCapabilitySlots(node, meshId).map(s => s.provider).filter(Boolean);
                        const priorities = slotProviders.length ? slotProviders : normalizeProviderPriority(node?.policy);
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
                // FALSE-BLOCKER-CLONE-QUEUE: an unmatched target pin is only a PERMANENT routing
                // miss when the node is genuinely absent — a freshly cloned worktree whose
                // inline-cache entry has not propagated here yet (or whose bootstrap is still
                // running) is TRANSIENTLY unresolved and auto-claims shortly. Report that as the
                // transient (non-actionable) reason so the coordinator is not paged with a false
                // "actionable blocker — will NOT clear on its own". A genuinely dead node is neither
                // bootstrap-running nor inside the clone grace window → stays 'target_node_id_unmatched'.
                const targetTransientlyUnresolved = targetPinUnmatched
                    && isTargetNodeTransientlyUnresolved(mesh, task);
                markAutoLaunch(meshId, task.id, {
                    status: 'skipped',
                    reason: convergenceOntoWorktree
                        ? 'mesh_convergence_target_is_worktree'
                        : targetTransientlyUnresolved
                            ? TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON
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
                    // Auto-launch drains one task at a time, so the task IS in scope here —
                    // pass it through for the 'fitness' strategy's task→slot ranking. The
                    // mesh's quotaRouting thresholds ride along so the fitness score can
                    // include the quota-headroom spread bonus (fail-open when unset).
                    { bumpCursor: true, task: { difficulty: (task as any).difficulty, requiredTags: task.requiredTags }, quotaRouting: mesh?.policy?.quotaRouting ?? null, quotaFactsContext: quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader) },
                ).map((c: RankableNode) => c.node);

            // LEDGER-TASK-TRACEABILITY (A): accumulate the candidate nodes that were
            // considered but skipped before the winning node, so task_dispatched can record
            // WHY the other nodes lost (cooldown, dirty, cap, provider mismatch, …). Bounded
            // so a large fleet can't bloat the entry. markSkip mirrors markAutoLaunch's skip
            // side effect AND appends to this list in one call.
            const skippedCandidates: Array<{ nodeId: string; reason: string }> = [];
            const SKIPPED_CANDIDATES_MAX = 5;
            const markSkip = (nodeIdForSkip: string, reason: string, extra?: { providerType?: string }) => {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason, nodeId: nodeIdForSkip, ...(extra || {}) });
                if (nodeIdForSkip && skippedCandidates.length < SKIPPED_CANDIDATES_MAX) {
                    skippedCandidates.push({ nodeId: nodeIdForSkip, reason });
                }
            };

            for (const node of orderedCandidateNodes) {
                const nodeId = readMeshNodeId(node);
                if (!nodeId) continue;
                const launchKey = `${meshId}:${nodeId}`;
                const now = Date.now();
                const cooldownUntil = autoLaunchCooldownUntil.get(launchKey) || 0;
                if (cooldownUntil > 0 && now >= cooldownUntil) autoLaunchCooldownUntil.delete(launchKey);
                if (autoLaunchInProgress.has(launchKey)) {
                    markSkip(nodeId, 'auto_launch_in_progress');
                    continue;
                }
                if (now < cooldownUntil) {
                    markSkip(nodeId, 'auto_launch_cooldown');
                    continue;
                }
                if (isDirtyNode(node)) {
                    markSkip(nodeId, 'dirty_workspace');
                    continue;
                }
                if (!isLaunchableNode(node)) {
                    // Names the HEALTH gate specifically (isMeshNodeHealthLaunchable:
                    // resolved health must be 'online' or 'unknown'). Deliberately NOT
                    // called `node_not_launch_ready`: that read as the negation of the
                    // node status field `launchReady`, which answers an entirely
                    // different question — finalizeMeshNodeStatus computes it from
                    // daemonId + machineStatus/connection + worktree bootstrap, and
                    // never consults health. A node can therefore legitimately report
                    // `launchReady: true` while being skipped here for degraded/dirty/
                    // wrong_branch health, which looked like a contradiction rather
                    // than two independent gates. Matches the self-describing style of
                    // the sibling reasons (dirty_workspace, node_stale_behind_upstream).
                    markSkip(nodeId, 'node_health_not_launchable');
                    continue;
                }
                // FRESHNESS gate (distinct from the health gate above): a clean-tree node that
                // is `behind` its upstream reads as 'online' and passes isLaunchableNode, so
                // without this it could win fitness routing and run a fresh worker against
                // stale code. Skip a node whose git telemetry proves it stale (behind >
                // maxBehind, or a submodule out of sync). Reuse the auto-fast-forward policy's
                // maxBehind threshold so "how far behind is tolerable" is configured in ONE
                // place. Telemetry-absent nodes pass (never block on missing data). The 4s
                // reconcile retries once the node's auto-ff repair path catches it up.
                if (!isMeshNodeFreshEnoughToLaunch(node, freshnessGate)) {
                    markSkip(nodeId, 'node_stale_behind_upstream');
                    continue;
                }
                const launchTarget = resolveAutoLaunchTarget(components, node);
                if (launchTarget.mode === 'skip') {
                    // Remote node we can't reach (no transport / no coordinator daemonId).
                    // Set a cooldown so the 4s reconcile loop doesn't re-attempt this node
                    // every tick; the de-dup'd skip ledger keeps it diagnosable without flood.
                    markSkip(nodeId, launchTarget.reason || 'auto_launch_unavailable');
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    continue;
                }
                // DOUBLE-DISPATCH auto-launch gate (see nodeHasLiveSessionPendingClaim): when this
                // node already has a live session on its way to claim (idle / booting / momentary
                // non-idle flip), do NOT spawn a second one — that session pulls the pending task
                // via the normal idle→claim / agent:ready drain. Launching here races it and yields
                // a duplicate worker that double-stamps the same taskId. Applies to read-only tasks
                // too: an idle session can claim either kind, while a genuinely BUSY session (holding
                // its own assigned task) is excluded by the helper, so a read-only launch onto a
                // busy-but-no-idle node is still allowed. Skip with a transient (non-actionable)
                // reason so the coordinator is not paged; the 4s reconcile retries, and once the
                // existing session goes terminal this gate clears and a legitimate launch proceeds.
                if (nodeHasLiveSessionPendingClaim(components, meshId, nodeId, task, node)) {
                    markSkip(nodeId, 'node_has_live_session_pending_claim');
                    continue;
                }
                // Write tasks keep the one-active-per-node invariant (worktree isolation);
                // read-only diagnoses may auto-launch onto a node that already has an active
                // assignment. Classified by the shared isTaskReadonly predicate.
                if (!isTaskReadonly(task) && nodeHasActiveAssignment(meshId, nodeId)) {
                    markSkip(nodeId, 'node_has_active_assignment');
                    continue;
                }
                const maxConcurrentSessions = Number(node?.policy?.maxConcurrentSessions);
                if (Number.isFinite(maxConcurrentSessions) && maxConcurrentSessions >= 0 && liveSessionCountForNode(components, meshId, nodeId) >= maxConcurrentSessions) {
                    markSkip(nodeId, 'max_concurrent_sessions_reached');
                    continue;
                }

                autoLaunchInProgress.add(launchKey);
                try {
                    const resolved = await resolveUsableProvider(components, nodeId, node, meshId, task.requiredTags, { difficulty: (task as any).difficulty, requiredTags: task.requiredTags }, mesh?.policy?.quotaRouting ?? null, quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader), task.id);
                    if (!resolved.providerType) {
                        // The QUOTA GATE now runs INSIDE resolveUsableProvider's selection
                        // loop (a gated first-choice provider falls through to the node's
                        // next provider instead of skipping the whole node), so a quota
                        // refusal arrives here as the reason: the non-actionable
                        // ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON when every usable provider
                        // is gated (WAIT — the window resets, the task stays queued, the
                        // coordinator is not paged), never the actionable
                        // 'provider_priority_unusable' (slot configuration error).
                        markSkip(nodeId, resolved.reason || 'provider_unusable');
                        continue;
                    }
                    // Slot-derived model/thinking precedence (see resolveLaunchAxis):
                    // an EXPLICIT task.model/thinkingLevel always wins; a
                    // PRESET-stamped one yields to the difficulty-covering slot's
                    // own value; otherwise the slot fills what the task left blank.
                    const slotCoversDifficulty = slotCoversTaskDifficulty(resolved.slot, (task as any).difficulty);
                    const requestedModel = resolveLaunchAxis(task.model, (task as any).modelSource, resolved.model, slotCoversDifficulty);
                    const effectiveThinkingLevel = resolveLaunchAxis(task.thinkingLevel, (task as any).thinkingLevelSource, resolved.thinkingLevel, slotCoversDifficulty);

                    // SLOT MODEL GUARD: the requested model must be one this node's slots
                    // declare. The difficulty→brain presets stamp a model at enqueue time
                    // (difficult → 'opus'), so without this a task launched with
                    // `--model opus` on a node whose only slot is claude-cli/sonnet — a
                    // model the operator never configured there.
                    //
                    // Three outcomes, and 'busy' must stay distinct from 'absent':
                    //   run    → a declaring slot has capacity; launch with ITS model
                    //   wait   → a declaring slot exists but is at maxParallel. Skip with a
                    //            NON-actionable reason so the task stays queued and claims
                    //            the slot when it frees. This is the queue working, not a
                    //            failure, so the coordinator is not paged.
                    //   notify → no slot declares the model. Waiting can never help, so skip
                    //            with an ACTIONABLE reason, which pages the coordinator to
                    //            re-drive the task another way.
                    // Substituting a different model is deliberately not an option: silently
                    // running a model the user did not choose breaks the same invariant.
                    const slotDecision = decideSlotForModel({
                        requestedModel,
                        slots: resolveNodeCapabilitySlots(node, meshId).map(slot => ({
                            slot,
                            available: slotHasCapacity(meshId, nodeId, node, slot, mesh?.nodes, isReadonly),
                        })),
                    });
                    if (slotDecision.outcome === 'wait') {
                        LOG.info('MeshQueue', `SLOT MODEL GUARD: model '${requestedModel}' is declared on node ${nodeId} but every matching slot is at its maxParallel cap (task ${task.id}); leaving the task queued until a slot goes idle`);
                        markSkip(nodeId, slotDecision.reason, { providerType: resolved.providerType });
                        continue;
                    }
                    if (slotDecision.outcome === 'notify') {
                        LOG.warn('MeshQueue', `SLOT MODEL GUARD: no slot on node ${nodeId} declares model '${requestedModel}' (declared: ${slotDecision.declaredModels.join(', ') || 'none'}) for task ${task.id}; not launching — surfacing to the coordinator to re-drive`);
                        markSkip(nodeId, slotDecision.reason, { providerType: resolved.providerType });
                        continue;
                    }
                    const rawEffectiveModel = slotDecision.model;
                    const winningModel = resolved.slot?.model?.trim() || undefined;
                    const finalizedModel = slotDecision.slot.model?.trim() || undefined;
                    const slotWasDemoted = resolved.slot?.provider !== slotDecision.slot.provider
                        || winningModel !== finalizedModel;
                    const demotionReason = slotWasDemoted
                        ? (slotHasCapacity(meshId, nodeId, node, resolved.slot!, mesh?.nodes, isReadonly)
                            ? 'slot_reselected_during_launch'
                            : 'winning_slot_capacity_exhausted')
                        : undefined;

                    // CODEX-400 GUARD: the difficulty→brain presets (and MAGI slots) carry
                    // provider-agnostic Anthropic model aliases (opus/sonnet/haiku). Now that
                    // resolved.providerType is definitively known, drop the model if it is a
                    // Claude model but the provider is NOT Anthropic-backed (codex-cli /
                    // antigravity-cli / hermes-cli): forwarding `claude-*` as an initialModel
                    // makes those providers convert it to `-c model='claude-...'`, and a
                    // ChatGPT-account codex then rejects the launch with a 400. Stripping it
                    // lets the provider fall back to its own default model; the provider-neutral
                    // thinkingLevel axis is preserved. This is the single authoritative point
                    // that enforces the invariant across every model source (preset, slot,
                    // explicit) because both remote and local launch consume effectiveModel below.
                    const effectiveModel = isModelCompatibleWithProvider(rawEffectiveModel, resolved.providerType)
                        ? rawEffectiveModel
                        : undefined;
                    if (rawEffectiveModel && effectiveModel === undefined) {
                        LOG.info('MeshQueue', `CODEX-400 GUARD: dropped incompatible launch model '${rawEffectiveModel}' for non-Anthropic provider '${resolved.providerType}' on node ${nodeId} (task ${task.id}); provider will use its own default model`);
                    }

                    // Don't spawn a session for a (daemon, provider) already at its declared
                    // maxParallel cap — it would launch only to fail the claim. The claim
                    // transaction enforces the cap regardless; this just avoids a doomed launch.
                    // Counted over the daemon machine (sibling worktrees included), matching
                    // the claim-side scope so the two layers cannot disagree.
                    const providerCap = effectiveSlotCap(
                        resolveProviderMaxParallel(resolveNodeCapabilitySlots(node, meshId), resolved.providerType),
                        isReadonly,
                    );
                    if (
                        providerCap !== undefined
                        && activeProviderAssignedCount(
                            meshId,
                            nodeId,
                            resolved.providerType,
                            resolveDaemonSiblingNodeIds(nodeId, mesh?.nodes),
                        ) >= providerCap
                    ) {
                        markSkip(nodeId, 'max_provider_parallel_reached', { providerType: resolved.providerType });
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
                        // global per-provider-type boolean/mode through explicit opposite-key clearing.
                        ...delegatedWorkerAutoApproveSettingsForNode(
                            mesh,
                            node,
                            components.providerLoader?.getMeta(resolved.providerType),
                            resolved.providerType,
                        ),
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
                        markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                        let launchResult: any;
                        try {
                            // OFFLINE-NODE-BLOCKING: no peer-connected pre-check before this remote
                            // launch_cli meant an OFFLINE target node sank the dispatch into the 90s
                            // connect deadline, stalling the 4s auto-launch loop for a full 90s. Stamp
                            // the status-origin marker so the daemon-cloud relay grants the SHORT
                            // connect-wait budget — an offline node throws in ~2s, the catch below sets
                            // the 25s cooldown (autoLaunchCooldownUntil) that already gates retries, so
                            // the loop moves on. The marker only affects the connect wait and is
                            // stripped before launch_cli executes, so a live node spawns identically.
                            launchResult = await components.dispatchMeshCommand!(launchTarget.daemonId!, 'launch_cli', withStatusProbeMarker({
                                cliType: resolved.providerType,
                                dir: node.workspace,
                                settings: remoteSettings,
                                // MAGI-KIND-PANEL model axis: forward the task's model override so the
                                // remote worker session launches with it (initialModel). Best-effort.
                                // Slot-aware: task override wins, else the matched slot's model.
                                ...(effectiveModel ? { initialModel: effectiveModel } : {}),
                                // BRAIN-ROUTING thinking axis: forward the effective thinking level (initialThinkingLevel).
                                ...(effectiveThinkingLevel ? { initialThinkingLevel: effectiveThinkingLevel } : {}),
                            }));
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
                        markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId: remoteSessionId || undefined, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                        logAutoLaunchQuotaFallbackSuccess(resolved, task.id, nodeId, remoteSessionId || undefined);
                        autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                        return true;
                    }

                    markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                    const launchResult: any = await components.cliManager.handleCliCommand('launch_cli', {
                        cliType: resolved.providerType,
                        dir: node.workspace,
                        settings: launchSettings,
                        // MAGI-KIND-PANEL model axis: local launch forwards the effective model
                        // (task override, else matched slot) as initialModel (CLI → modelLaunchArgs; ACP → setConfigOption).
                        ...(effectiveModel ? { initialModel: effectiveModel } : {}),
                        // BRAIN-ROUTING thinking axis: forward the effective thinking level (initialThinkingLevel).
                        ...(effectiveThinkingLevel ? { initialThinkingLevel: effectiveThinkingLevel } : {}),
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
                    markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}) });
                    logAutoLaunchQuotaFallbackSuccess(resolved, task.id, nodeId, sessionId);
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
                    // LEDGER-TASK-TRACEABILITY (A/D): the auto-launch drain has all the routing
                    // rationale in scope (resolved provider/model/thinking, skipped candidates,
                    // fitness score). Fold it into the task_dispatched entry the claim writes.
                    // All values are already computed above — no extra work on the dispatch path.
                    const requiredTags = Array.isArray(task.requiredTags) ? task.requiredTags.filter((t): t is string => !!t) : [];
                    const routingDecision = buildAutoLaunchRoutingDecision({
                        node,
                        meshId,
                        task: { difficulty: (task as any).difficulty, requiredTags: task.requiredTags },
                        resolved: resolved as ResolvedProviderSelection & { providerType: string; slot: NodeCapabilitySlot },
                        quotaRouting: mesh?.policy?.quotaRouting ?? null,
                        quotaFactsContext: quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader),
                        skippedCandidates,
                        requiredTagsResult: {
                            required: requiredTags,
                            satisfied: !requiredTags.length || nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node, resolved.providerType)),
                            missing: requiredTags.filter(t => !buildMeshNodeCapabilityTags(node, resolved.providerType).includes(t)),
                        },
                        effectiveModel,
                        effectiveThinkingLevel,
                        executedSlot: slotDecision.slot,
                        demotionReason,
                    });
                    tryAssignQueueTask(components, meshId, nodeId, sessionId, resolved.providerType, routingDecision);
                    return true;
                } catch (e: any) {
                    markAutoLaunch(meshId, task.id, { status: 'failed', error: e?.message || String(e), nodeId });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                    return false;
                } finally {
                    autoLaunchInProgress.delete(launchKey);
                }
            }
        } finally {
            // Every exit path: fallthrough, `continue`, `return`, and any throw from the
            // awaited provider resolution / launch dispatch. A leak wedges the task forever.
            autoLaunchTaskInProgress.delete(taskLaunchKey);
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

    const quotaClaimTrace: QuotaClaimDrainTrace = { blocked: [], evaluated: 0, clear: 0 };
    const assignIdleCandidate = (candidate: IdleCandidate): void => {
        const assigned = tryAssignQueueTask(components, meshId, candidate.nodeId, candidate.sessionId, candidate.providerType, undefined, quotaClaimTrace);
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
        // buildSchedulingPool canonicalizes every candidate's nodeId so the Set
        // dedup, baseIndex, rankIndex, and nodeActiveLoad keying below all agree on
        // one form (see the invariant on that helper).
        const { pool, uniqueNodes } = buildSchedulingPool(localCandidates, remoteCandidates);
        const baseIndex = new Map<string, number>();
        pool.forEach((c, i) => { if (!baseIndex.has(c.nodeId)) baseIndex.set(c.nodeId, i); });
        // Bump the round-robin cursor once for this whole drain pass.
        const ranked = orderEligibleNodes(meshId, strategy, uniqueNodes, { bumpCursor: true });
        const rankIndex = new Map<string, number>(ranked.map((r, i) => [r.nodeId, i]));
        const remaining = [...pool];
        while (remaining.length > 0) {
            // Re-rank each pass so a node that just took work defers its next session.
            remaining.sort((a, b) => {
                const aPrio = resolveNodeSchedulingPriority(a.node?.policy);
                const bPrio = resolveNodeSchedulingPriority(b.node?.policy);
                if (aPrio !== bPrio) return bPrio - aPrio;
                // The idle-session drain ranks task-independently (a session pulls
                // whatever task matches), so 'fitness' here reduces to load-aware
                // ordering — the former least_loaded/round_robin tiebreak, which
                // normalize has already folded into 'fitness'.
                if (strategy === 'fitness') {
                    const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
                    if (loadDelta !== 0) return loadDelta;
                }
                return (rankIndex.get(a.nodeId) ?? 0) - (rankIndex.get(b.nodeId) ?? 0);
            });
            assignIdleCandidate(remaining.shift()!);
        }
    }

    autoLaunchStarted = await maybeAutoLaunchOneQueueSession(components, meshId, mesh);
    // AUTOLAUNCH-ORPHAN-SWEEP: run AFTER the drain + auto-launch so it reads post-claim
    // assignment state (a session that just won its claim must not be reported as an orphan).
    sweepAutoLaunchOrphanSessions(components, meshId);
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

    // A successful claim logs its blocked→winner transition at the atomic claim point.
    // If no candidate cleared the quota gate and auto-launch also made no progress, emit
    // a distinct all-gated conclusion once for this pending-task/gate-state fingerprint.
    if (newlyAssignedTasks.length === 0 && !autoLaunchStarted) {
        logAllQuotaClaimCandidatesBlocked(meshId, quotaClaimTrace, afterQueue.filter(task => task.status === 'pending').map(task => task.id));
    } else {
        clearAllQuotaClaimCandidatesBlockedState(meshId);
    }

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

/** Passed dry-run result satisfies the policy gates (maxBehind + clean submodules).
 *  Shared by the local execute path and the remote preflight re-verification so both
 *  apply exactly the same policy gate. */

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
