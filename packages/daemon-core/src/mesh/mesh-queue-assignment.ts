import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { MESH_CONNECT_TIMEOUT_MS } from '../runtime-defaults.js';
import { getMachineId } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { buildMeshNodeCapabilityTags, claimNextTask, updateTaskStatus, getQueue, requeueTask, recordAckedHoldDispatchOutcome } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { resolveTranscriptAuthorityProfile } from '../providers/transcript-evidence.js';
import { createSessionDelivery, updateSessionDeliveryStatus } from './mesh-delivery-policy.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { clearClaimDeferralForNode, noteClaimDeferredForNode, type MeshClaimRefusal } from './mesh-claim-refusal.js';
import { traceMeshEventDrop, traceMeshEventStage } from '../shared/mesh-event-trace.js';
import { buildRedriveProvenance, describeRedriveProviderFlip } from './mesh-redrive-provenance.js';
import { awaitWithWarmupDeadline, resolveWarmupDeadlineOpts } from './mesh-warmup-deadline.js';
import { delegatedWorkerAutoApproveSettings, resolveProviderMaxParallel, resolveSlotMaxParallel, resolveNodeSchedulingPriority, resolveCoordinatorIdlePushPolicy } from '../repo-mesh-types.js';
import { loadRepoMeshJsonConfig } from '../config/mesh-json-config.js';
import type { RepoMeshDeclarativeConfig } from '../config/mesh-json-config.js';
import { normalizeMeshNodeId, meshNodeIdMatches, daemonIdsEquivalent, canonicalDaemonId, expandDaemonIdForms, normalizeMeshWorkspaceForCompare, meshWorkspacesEquivalent, sessionIdsEquivalent, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { resolveDaemonSiblingNodeIds } from './mesh-daemon-slot-axis.js';
import { recordLastQuotaRanking, recordLastQuotaRankingOutcome } from './mesh-quota-routing.js';
import { evaluateQuotaClaimGateForAssignment } from './mesh-queue-claim-gate.js';
import { findTerminalLedgerEvidenceForTask } from './mesh-events-stale.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import { shouldDeferDispatchForBootstrap } from './worktree-bootstrap-config.js';
import { beginTaskDispatchInFlight, endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { isModelAllowedBySlot } from './slot-model-enforcement.js';
import { openTurnAttempt, recordTurnAck, closeAttemptForReassignment, assertPromptInjectionAllowed, rebindAttemptToLiveHolder } from './mesh-turn-ledger.js';
import { classifyDuplicateMeshDispatch } from './mesh-duplicate-dispatch.js';
import { isWorkspaceAutoFastForwardInFlight, maybeAutoFastForwardIdleNode } from './mesh-auto-fast-forward.js';
import { retractActionableSkipIfPreviouslyNotified } from './mesh-skip-notify.js';
import { notifyCoordinatorOfPinnedDispatchFailure } from './mesh-dispatch-failed-notify.js';
import { activeWriteAssignedCount, activeReadonlyAssignedCount, sessionHasActiveAssignment, resolveSchedulingStrategy, buildSchedulingPool, orderEligibleNodes, nodeActiveLoad, type IdleCandidate } from './mesh-scheduling-fitness.js';
import { AUTO_LAUNCH_LEDGER_DEDUP_MAX, clearAllQuotaClaimCandidatesBlockedState, clearClaimRefusalState, clearWorktreeBootstrapStaleBypassState, logAllQuotaClaimCandidatesBlocked, logQuotaClaimFallbackSuccess, logWorktreeBootstrapStaleBypass, recordClaimRefusal, type QuotaClaimDrainTrace } from './mesh-queue-observability.js';
import { type MeshTaskRoutingDecision } from './mesh-routing-decision.js';
import { sweepAutoLaunchOrphanSessions, AUTO_LAUNCH_AWAIT_CLAIM_MS } from './mesh-autolaunch-integrity.js';
import { allowedClassifiedDifficultiesForSession, handleClaimPathDifficultyFloorRefusal, readSessionModel } from './mesh-difficulty-floor.js';
import { isWorkerMcpEnabled, mintWorkerTaskToken } from './worker-mcp-isolation.js';
import { resolveDispatchMessage } from './worker-handoff-dispatch.js';
import { isTerminalSessionStatus, isIdleSessionState, nodeHasActiveMeshWork, isLocalAutoLaunchNode, isSessionActivelyGenerating, resolveSessionBusyVerdict, type SessionBusyVerdict } from './mesh-candidacy-predicates.js';

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
// Auto-launch candidacy predicates were split out (pure move, 2026-08-23) — see
// mesh-candidacy-predicates.ts. They are imported above for internal use, so they are
// re-exported by name rather than via `export ... from` (which would collide with the
// import binding). isIdleSessionState / nodeHasActiveMeshWork / isLocalAutoLaunchNode /
// isSessionActivelyGenerating / resolveSessionBusyVerdict were already public here and
// are read through this module by mesh-auto-fast-forward, mesh-skip-notify,
// mesh-reconcile-stranded-dispatch, med-family/cli-agent and several suites, so the
// surface must stay identical.
export {
    isIdleSessionState,
    nodeHasActiveMeshWork,
    isLocalAutoLaunchNode,
    isSessionActivelyGenerating,
    resolveSessionBusyVerdict,
};
export type { SessionBusyVerdict };

/**
 * CANON: the single canonical coordinator-daemon id this daemon stamps onto every
 * worker dispatch (meshContext.coordinatorDaemonId / sourceCoordinatorDaemonId / the
 * co-located meshCoordinatorDaemonId anchor). getMachineId() is the bare
 * `mach_X` form; canonicalizing to `daemon_mach_X` unifies it with the MCP-side
 * resolveCoordinatorDaemonId producer so the two dispatch paths can never stamp a
 * worker's coordinator anchor in two different forms — the CANON-IDENTITY
 * double-dispatch root cause. Consumers of the anchor already compare under
 * daemonIdsEquivalent / expandDaemonIdForms, so the exact form is form-agnostic on
 * the read side; this only removes the producer-side skew.
 */
export function localCoordinatorDaemonId(): string | undefined {
    return canonicalDaemonId(readNonEmptyString(getMachineId()));
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
export function delegatedWorkerAutoApproveSettingsForNode(
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
        const bootstrapFresher = inlineBootstrapIsFresher(inlineMatch.worktreeBootstrap, localNode.worktreeBootstrap);
        // Dual-source (5-c / 5-b C): mesh_status stamps lastGit on the INLINE node; the claim
        // view used to take the config node verbatim whenever bootstrap wasn't fresher, so
        // shouldDeferDispatchForBootstrap never saw the P2P git evidence and the stale-running
        // backstop could not open. Overlay lastGit independently of bootstrap freshness.
        const inlineGit = inlineMatch.lastGit ?? inlineMatch.last_git;
        if (!bootstrapFresher && !inlineGit) continue;
        if (!overlaid) {
            overlaidLocalNodes = [...localNodes];
            overlaid = true;
        }
        // Keep the config node's static fields; overlay only dynamic runtime substate
        // (fresher terminal stamp / epoch, and live lastGit). Config identity is unchanged.
        overlaidLocalNodes[i] = {
            ...localNode,
            ...(bootstrapFresher ? { worktreeBootstrap: inlineMatch.worktreeBootstrap } : {}),
            ...(inlineGit ? { lastGit: inlineGit, last_git: inlineGit } : {}),
        };
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
    // COORD-NOTIFY-STUCK: carried so a dispatch failure in the catch below can look up
    // the target node's other live sessions for the coordinator notification without
    // threading a second parameter through deliverTaskToSession.
    components: DaemonComponents;
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
    // REDRIVE-PROVIDER-FLIP (a): if a stranded-reclaim tore an assignment down before this
    // dispatch, fold what it tore down into THIS entry. A redrive re-claims an idle session
    // without recomputing routing, so the provider can change silently; previously the only
    // way to see that was to hand-join two task_dispatched entries and diff providerType.
    // null for an ordinary first dispatch → payload shape unchanged for the common case.
    const redriveProvenance = buildRedriveProvenance(task.lastReclaim, ctx.providerType);
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
            ...(redriveProvenance ? { redriveProvenance } : {}),
        },
    });
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
            appendLedgerEntry(ctx.meshId, {
                kind: 'redrive_provider_changed',
                nodeId: ctx.nodeId,
                sessionId: ctx.sessionId,
                providerType: ctx.providerType,
                taskId: task.id,
                payload: { taskId: task.id, deliveryId, transport: ctx.transport, ...redriveProvenance },
            });
        } catch { /* best-effort: never fail a dispatch on a diagnostic write */ }
    }
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
        recordAckedHoldDispatchOutcome(ctx.meshId, ctx.task.id, { ok: true });
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
        recordAckedHoldDispatchOutcome(ctx.meshId, ctx.task.id, { ok: false, reason: e?.message });
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
            } else if (requeued?.status === 'pending' && readNonEmptyString(requeued.targetSessionId)) {
                // COORD-NOTIFY-STUCK: the row is back to 'pending' STILL PINNED (clearTargetSession
                // was false above) — the coordinator gets no other signal this happened, and could
                // otherwise re-target the same dead session. Page it now rather than let it find
                // out only when the slower dead-target/pin-TTL backstops eventually clear the pin.
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
            appendLedgerEntry(ctx.meshId, {
                // 'dispatch_failed' is a real MeshLedgerKind and a member of
                // TASK_LIFECYCLE_LEDGER_KINDS, so appendLedgerEntry derives the top-level
                // taskId from payload.taskId below. It spent its whole life as
                // `as any` — off the union, hence off the lifecycle set, hence written to
                // the indexed SQLite task_id column as NULL and unreachable by the
                // kind+taskId join every reader uses. Do not reintroduce the cast.
                kind: 'dispatch_failed',
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
    trigger: string = 'queue_claim',
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
    // AUTOLAUNCH-DEFERRED-CLAIM (rationale + live evidence: mesh-claim-refusal.ts). The
    // "re-fires next tick" promise below was NOT kept on the auto-launch path, whose single
    // inline claim attempt this gate could swallow while the launch still stamped
    // autoLaunch='completed'. Mark the deferral so the await-claim guard re-drives instead of
    // waiting out a window that assumes a claim is already in flight.
    if (isWorkspaceAutoFastForwardInFlight(readNonEmptyString(node?.workspace))) {
        LOG.info('MeshQueue', `Deferring queue claim for node ${nodeId} (${sessionId}): an auto fast-forward is mutating its workspace — task left pending, claim re-fires next tick`);
        noteClaimDeferredForNode(meshId, nodeId);
        return false;
    }

    // QUOTA GATE (claim path) + PIN OVERRIDE: see mesh-queue-claim-gate.ts for the
    // full rationale (same evaluateProviderQuotaGate the auto-launch loop applies
    // before spawning also gates an idle session's claim; a task pinned to this
    // provider via requiredTags overrides the gate and logs 'overridden_by_pin'
    // instead of 'blocked'). Returns true when the claim must be refused — the
    // task stays pending (return false without touching its status).
    if (evaluateQuotaClaimGateForAssignment({ meshId, nodeId, sessionId, providerType, model: routingDecision?.selectedSlot?.model, trigger, node, mesh, providerLoader: components.providerLoader, quotaClaimTrace })) {
        return false;
    }

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
    // Dual-source (5-c): inline is authoritative for bootstrap status but often lacks lastGit.
    const bootstrapGateNode = (() => {
        const base = inlineBootstrapNode ?? node;
        if (!base) return base;
        const git = (inlineBootstrapNode as any)?.lastGit ?? (inlineBootstrapNode as any)?.last_git
            ?? (node as any)?.lastGit ?? (node as any)?.last_git;
        return git ? { ...base, lastGit: git, last_git: git } : base;
    })();
    if ((bootstrapGateNode as { worktreeBootstrap?: { status?: string } } | undefined)?.worktreeBootstrap?.status === 'running') {
        // Fix (3) safety net + F7: shouldDeferDispatchForBootstrap returns false when the 'running'
        // state is stale (older than the backstop AND git-clean) — treat that as silently complete
        // and allow the claim; otherwise defer (leave the task pending) so the claim re-fires once
        // bootstrap reaches a terminal state and never dispatches into a half-built worktree.
        if (!shouldDeferDispatchForBootstrap(bootstrapGateNode as any)) {
            // Transition-deduped (mesh-queue-observability): this bypass re-fires on every
            // ~4s drain tick while the terminal stamp is missing — 1,130 duplicate warnings
            // in a day for one node on 2026-08-21 — so only the first entry into the stuck
            // state warns.
            logWorktreeBootstrapStaleBypass(meshId, nodeId, sessionId);
        } else {
            LOG.info('MeshQueue', `Gating queue claim for worktree node ${nodeId} (${sessionId}): worktree bootstrap still running — task left pending; claim re-fires once bootstrap reaches a terminal state (guards against dispatching into a half-built worktree → empty session)`);
            return false;
        }
    } else {
        // Bootstrap is no longer 'running' (the terminal stamp landed, or never was
        // running): clear the dedup fingerprint so a genuinely new stuck episode warns.
        clearWorktreeBootstrapStaleBypassState(meshId, nodeId, sessionId);
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
    // A6-SILENT-REFUSAL: collect WHICH gate refused so the `!task` exit below stops being
    // the silent funnel that made a permanently-stuck task look like an idle queue.
    const claimRefusal: MeshClaimRefusal = {};
    const task = claimNextTask(meshId, nodeId, sessionId, capabilityTags, {
        providerType,
        ...(providerMaxParallel !== undefined ? { providerMaxParallel } : {}),
        ...(assignedModel ? { assignedModel } : {}),
        ...(slotMaxParallel !== undefined ? { slotMaxParallel } : {}),
        daemonNodeIds,
        nodeIsWorktree,
        ...(allowedTaskDifficulties ? { allowedTaskDifficulties } : {}),
        ...(assignedTranscriptProfile ? { assignedTranscriptProfile } : {}),
        outRefusal: claimRefusal,
    });
    if (!task) {
        const refusalReason = claimRefusal.reason || 'no_pending_candidates';
        recordClaimRefusal(meshId, {
            nodeId,
            sessionId,
            ...(providerType ? { providerType } : {}),
            reason: refusalReason,
            ...(claimRefusal.detail ? { detail: claimRefusal.detail } : {}),
        });
        // Qualify the ranking written at the top of this function so it can no longer be
        // misread as evidence that a task was dispatched to this node.
        recordLastQuotaRankingOutcome(nodeId, 'refused', refusalReason);
        handleClaimPathDifficultyFloorRefusal({ meshId, nodeId, refusalReason, claimRefusal, coordinatorDaemonId: localCoordinatorDaemonId() }); return false;
    }
    // A claim succeeded — drop any refusal fingerprint so a later genuine re-entry into
    // the same gate is reported again rather than suppressed as an unchanged verdict, and
    // retire the ff-deferred-claim marker (AUTOLAUNCH-DEFERRED-CLAIM) now that this node
    // has demonstrably claimed. Both are keyed so a stale entry cannot outlive the
    // condition it describes.
    clearClaimRefusalState(meshId, nodeId, sessionId);
    clearClaimDeferralForNode(meshId, nodeId);
    recordLastQuotaRankingOutcome(nodeId, 'claimed');

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

    // WORKER-MCP (design §9.2.1): mint the per-task worker token now that the
    // attempt exists. This is the queue-claim arm; the direct-dispatch arm
    // mints in recordDirectDispatchTask, because that path bypasses the claim
    // entirely and a worker without a token fails closed once Phase B lands.
    //
    // Deliberately AFTER openTurnAttempt so the token carries a real attemptId:
    // binding to the task alone would let a late report from a superseded
    // dispatch land on the retry's row, which is the REDRIVE-DUP family.
    // Best-effort like the attempt open above — a mint failure must not sink a
    // dispatch that is otherwise sound.
    if (isWorkerMcpEnabled()) {
        try {
            mintWorkerTaskToken({
                meshId,
                taskId: task.id,
                attemptId: dispatchAttemptId,
                sessionId,
                nodeId,
            });
        } catch (e: any) {
            LOG.warn('WorkerMcp', `Failed to mint worker task token for ${task.id}: ${e?.message || e}`);
        }
    }

    // WORKER-MCP decision C: the dispatched body may carry handoff notes from
    // related earlier work. Composed ONCE here (not per dispatch arm) so the
    // remote and local arms cannot drift, and applied to the DISPATCHED body
    // only — `task.message` stays the authored text. Gate-off ⇒ unchanged.
    const dispatchMessage = resolveDispatchMessage(task, meshId, node);

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
                    // Handoff-note enclosure applies to the DISPATCHED body only;
                    // task.message stays the authored text (see composition above).
                    message: dispatchMessage,
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
                    components,
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
            // Same enclosure as the remote arm — one composed body, both paths.
            message: dispatchMessage,
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
            components,
            ...(readNonEmptyString(task.sourceCoordinatorSessionId) ? { sourceCoordinatorSessionId: readNonEmptyString(task.sourceCoordinatorSessionId) } : {}),
            ...(localCoordinatorDaemonId() ? { sourceCoordinatorDaemonId: localCoordinatorDaemonId() } : {}),
            ...(routingDecision ? { routingDecision } : {}),
        },
    );

    return true;
}

// The auto-launch subsystem (launch locks, cooldown clock, target resolution,
// in-loop quota-gated provider selection, markAutoLaunch ledger writes, and the
// maybeAutoLaunchOneQueueSession scan) was split out to mesh-queue-autolaunch.ts
// (pure move — this file is a frozen file-size baseline entry). Its test hooks are
// re-exported below so existing import paths are unaffected;
// maybeAutoLaunchOneQueueSession is imported back for triggerMeshQueue — a
// function-level circular import mirroring the earlier splits from this file.
import { maybeAutoLaunchOneQueueSession } from './mesh-queue-autolaunch.js';
export {
    __autoLaunchTaskLockHeldForTests,
    __markAutoLaunchForTests,
    __resetAutoLaunchAwaitClaimBackoffForTests,
    __resolveUsableProviderForTests,
} from './mesh-queue-autolaunch.js';

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
// AUTOLAUNCH-DEFERRED-CLAIM state lives in mesh-claim-refusal (this file is a frozen
// file-size baseline entry). Re-exported here, which is the path tests import from.
export { __resetClaimDeferralForTests } from './mesh-claim-refusal.js';
export { __seedAutoLaunchAwaitClaimBackoffForTests } from './mesh-autolaunch-integrity.js';

// Canonical mesh node-id normalization. A node may arrive from the local config
// form (`id`) or the inline-cache form (`nodeId`/`node_id`) — see
// readInlineMeshNodeId in commands/router.ts. Comparing only `node.id` against a
// task.targetNodeId silently drops inline-cached worktree nodes, leaving a
// target-routed task permanently pending with a misleading
// `no_node_satisfies_required_tags` skip.
export function readMeshNodeId(node: any): string {
    // Delegate to the shared 3-way (id / nodeId / node_id) normalizer so this
    // and every other mesh node-id read agree on identity. Coalesce to '' to
    // preserve the existing string return contract for callers that do
    // `=== task.targetNodeId` / `if (!nodeId)`.
    return normalizeMeshNodeId(node) ?? '';
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

// IPC-ACCEPT-ASYNC-BOUNDARY: in-flight backgrounded auto-launch scans, per mesh. The
// launch is deliberately NOT awaited by triggerMeshQueue (see the call site), so this is
// the only handle on work that outlives the call. Production uses it to drain in-flight
// launches on shutdown; tests use awaitInFlightAutoLaunches() to observe post-spawn state
// deterministically instead of sleeping.
const inFlightAutoLaunches = new Map<string, Set<Promise<boolean>>>();

function trackInFlightAutoLaunch(meshId: string, promise: Promise<boolean>): void {
    let set = inFlightAutoLaunches.get(meshId);
    if (!set) { set = new Set(); inFlightAutoLaunches.set(meshId, set); }
    set.add(promise);
    void promise.finally(() => {
        set!.delete(promise);
        if (set!.size === 0) inFlightAutoLaunches.delete(meshId);
    });
}

/**
 * Await every auto-launch scan currently in flight for `meshId` (all meshes when omitted).
 * Resolves immediately when none are pending. Settles repeatedly until quiet, because one
 * scan can enqueue follow-on work that starts another.
 */
export async function awaitInFlightAutoLaunches(meshId?: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
        const pending = meshId
            ? [...(inFlightAutoLaunches.get(meshId) ?? [])]
            : [...inFlightAutoLaunches.values()].flatMap(set => [...set]);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
    }
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
        const assigned = tryAssignQueueTask(components, meshId, candidate.nodeId, candidate.sessionId, candidate.providerType, undefined, quotaClaimTrace, 'idle_claim_scan');
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

    // IPC-ACCEPT-ASYNC-BOUNDARY (2026-09-13): the auto-launch is NOT awaited. Spawning a
    // worker session is the single heaviest thing this function can do — detectCLI's
    // per-provider sequential --version chain, a remote `launch_cli` dispatch, and then
    // waitForRemote/LocalSessionReady — which pushed trigger_mesh_queue past its caller's
    // IPC deadline even though the assignment work below was already finished. The caller
    // needs the ASSIGNMENT result; the spawn's outcome reaches it through queue state on a
    // later tick, which is how a launch started on a prior tick was always reported anyway.
    //
    // `autoLaunchStarted` therefore reports only that a launch was INITIATED this tick, not
    // that it completed. The duplicate-launch protection does not depend on the await:
    // maybeAutoLaunchOneQueueSession takes its per-task lock (autoLaunchTaskInProgress) and
    // writes markAutoLaunch SYNCHRONOUSLY-ish before any spawn await, and `autoLaunchPending`
    // below independently re-reads task.autoLaunch from the queue, so a launch still
    // converging is seen by the next tick exactly as before.
    const autoLaunchPromise = maybeAutoLaunchOneQueueSession(components, meshId, mesh)
        .catch(e => {
            LOG.warn('MeshQueue', `Auto-launch scan failed for mesh ${meshId}: ${e?.message || e}`);
            return false;
        });
    trackInFlightAutoLaunch(meshId, autoLaunchPromise);
    // Give the launch scan its synchronous prologue (gates + per-task lock + markAutoLaunch)
    // a chance to land before we snapshot the queue, without waiting on any spawn I/O. If it
    // settles within this turn we report it exactly as the old await did.
    autoLaunchStarted = await Promise.race([
        autoLaunchPromise,
        new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ]);
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
                    tryAssignQueueTask(components, args.meshId, args.nodeId, args.sessionId, args.providerType, undefined, undefined, 'idle_maintenance');
                } catch (e: any) {
                    LOG.warn('MeshQueue', `Failed to assign idle queue task after maintenance for ${args.nodeId}: ${e?.message || e}`);
                }
            });
    });
}
