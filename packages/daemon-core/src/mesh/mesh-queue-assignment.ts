import { existsSync } from 'fs';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { MESH_CONNECT_TIMEOUT_MS } from '../runtime-defaults.js';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { detectCLI } from '../detection/cli-detector.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, claimNextTask, updateTaskStatus, getQueue, recordTaskAutoLaunch, getActiveDirectDispatches, isTaskReadonly, taskDependenciesSatisfied, meshTaskNotBeforeReady, meshTaskPriorityRank, requeueTask, expireTaskTargetPin } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { resolveTranscriptAuthorityProfile } from '../providers/transcript-evidence.js';
import { fastForwardMeshNode } from './mesh-fast-forward.js';
import { createSessionDelivery, updateSessionDeliveryStatus } from './mesh-delivery-policy.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { traceMeshEventDrop } from './mesh-event-trace.js';
import { awaitWithWarmupDeadline, resolveWarmupDeadlineOpts } from './mesh-warmup-deadline.js';
import { delegatedWorkerAutoApproveSettings, resolveProviderMaxParallel, resolveNodeSchedulingPriority, normalizeMeshSchedulingStrategy, resolveMaxParallelTasks, resolveMaxReadonlyParallelTasks, resolveCoordinatorIdlePushPolicy } from '../repo-mesh-types.js';
import { loadRepoMeshJsonConfig } from '../config/mesh-json-config.js';
import type { RepoMeshDeclarativeConfig } from '../config/mesh-json-config.js';
import type { RepoMeshSchedulingStrategy } from '../repo-mesh-types.js';
import { normalizeMeshNodeId, meshNodeIdMatches, daemonIdsEquivalent, canonicalDaemonId, expandDaemonIdForms, normalizeMeshWorkspaceForCompare, meshWorkspacesEquivalent, sessionIdsEquivalent, normalizeNodeCapabilitySlots, isMeshTaskDifficulty, withStatusProbeMarker, type MeshNodeIdentified, type NodeCapabilitySlot, type MeshTaskDifficulty } from '@adhdev/mesh-shared';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { findTerminalLedgerEvidenceForTask, hasUnterminalDirectDispatchLedgerEntry } from './mesh-events-stale.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId, isMeshNodeHealthLaunchable, isMeshNodeFreshEnoughToLaunch } from './mesh-node-identity.js';
import { queuePendingMeshCoordinatorEvent, retractPendingDispatchBlockedEvent, drainPendingMeshCoordinatorEvents } from './mesh-events-pending.js';
import { isWorktreeBootstrapStaleRunning, shouldDeferDispatchForBootstrap } from './worktree-bootstrap-config.js';
import { isWithinCloneBootstrapGrace } from './mesh-clone-grace.js';
import { beginTaskDispatchInFlight, endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { isModelCompatibleWithProvider } from './model-provider-compat.js';
import { openTurnAttempt, recordTurnAck, closeAttemptForReassignment, assertPromptInjectionAllowed, noteTargetPinCleared, rebindAttemptToLiveHolder } from './mesh-turn-ledger.js';
import { classifyDuplicateMeshDispatch } from './mesh-duplicate-dispatch.js';

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

// ---------------------------------------------------------------------------
// Idle auto fast-forward throttle state
// ---------------------------------------------------------------------------
const IDLE_AUTO_FAST_FORWARD_THROTTLE_MS = 30 * 60 * 1000;
const idleAutoFastForwardLastAttempt = new Map<string, number>();

// Continuous-mode per-node scan cooldown (mode:"continuous" reconcile scan). The
// reconcile tick fires every ~4s; fetching every connected peer that often would
// hammer the network and each owning daemon's git. This cooldown throttles the
// per-node continuous scan to at most once per window (default 45s), independent of
// the 30-minute idle-edge throttle above (which stays the idle-edge cadence).
const CONTINUOUS_AUTO_FAST_FORWARD_SCAN_COOLDOWN_MS = 45 * 1000;
const continuousAutoFastForwardLastScan = new Map<string, number>();

// Workspace mutation lease. A git-mutating auto ff and the task-assignment path must
// not both touch the same workspace concurrently (an ff mid-checkout while a task is
// being dispatched can move HEAD out from under the worker). The lease is keyed by
// CANONICAL WORKSPACE — not nodeId — so two mesh nodes that reference the same
// on-disk workspace (e.g. a base node and a stale duplicate) cannot both ff it at
// once. Best-effort in-process advisory lock; a crash mid-ff simply leaves a stale
// entry that the finally-release clears on the same tick, so it never wedges.
const autoFastForwardWorkspaceLease = new Set<string>();

function acquireAutoFastForwardLease(workspace: string): boolean {
    const key = normalizeMeshWorkspaceForCompare(workspace);
    if (!key) return false;
    if (autoFastForwardWorkspaceLease.has(key)) return false;
    autoFastForwardWorkspaceLease.add(key);
    return true;
}

function releaseAutoFastForwardLease(workspace: string): void {
    const key = normalizeMeshWorkspaceForCompare(workspace);
    if (key) autoFastForwardWorkspaceLease.delete(key);
}

/** Whether the assignment path currently holds an ff lease on this node's workspace —
 *  used to skip a task claim while an auto ff is mutating the same workspace. */
export function isWorkspaceAutoFastForwardInFlight(workspace: string | undefined): boolean {
    const key = normalizeMeshWorkspaceForCompare(workspace || '');
    return !!key && autoFastForwardWorkspaceLease.has(key);
}

export function __resetIdleAutoFastForwardForTests(): void {
    idleAutoFastForwardLastAttempt.clear();
    continuousAutoFastForwardLastScan.clear();
    autoFastForwardWorkspaceLease.clear();
}

/**
 * Load the repo-shared `.adhdev/mesh.json` for a node's workspace, tolerating a
 * missing/invalid file (returns null → resolver falls back to provider-spec
 * defaults, i.e. exactly the pre-providerDefaults behavior). Only the
 * `providerDefaults` zone influences the delegated-worker MODE selection; it never
 * touches the ENABLE decision. When a node carries no workspace path (should not
 * happen for a launchable node, but be defensive), we skip the read entirely.
 */
function loadRepoConfigForNode(node: any): RepoMeshDeclarativeConfig | null {
    const workspace = typeof node?.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
    if (!workspace) return null;
    try {
        const result = loadRepoMeshJsonConfig(workspace);
        return result.sourceType === 'repo_file' && result.config ? result.config : null;
    } catch {
        return null;
    }
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

// LEDGER-TASK-TRACEABILITY (A/D): the routing rationale captured at claim/dispatch
// time so mesh_task_history / the dashboard can answer "why THIS node/provider/model".
// All fields optional — the event-driven / idle drains don't compute a fitness score,
// so they omit the extras and only `source` is always present.
export interface MeshTaskRoutingDecision {
    // How the task reached this dispatch: a normal queue claim, the auto-launch drain
    // that spawned a fresh worker, or a coordinator direct dispatch (mesh_send_task).
    source: 'queue' | 'autoLaunch' | 'direct';
    // The task→slot fitness score of the selected node (scoreSlotForTask), when the
    // 'fitness' scheduling strategy ranked candidates. Absent for first_eligible etc.
    fitnessScore?: number;
    // Candidate nodes considered but skipped before this one won, with the reason.
    skippedCandidates?: Array<{ nodeId: string; reason: string }>;
    // Required-tag gating result for the selected node.
    requiredTagsResult?: { required: string[]; satisfied: boolean; missing: string[] };
    // The resolved execution profile (D): provider actually launched, and the
    // model/thinking/difficulty axes that shaped it, plus the human-readable reason.
    resolvedProviderType?: string;
    resolvedModel?: string;
    resolvedThinkingLevel?: string;
    resolvedDifficulty?: string;
    reason?: string;
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
        ...(routing?.skippedCandidates?.length ? { skippedCandidates: routing.skippedCandidates } : {}),
        ...(routing?.requiredTagsResult ? { requiredTagsResult: routing.requiredTagsResult } : {}),
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
        if (!isQueued && ctx.task.attemptId) {
            try {
                recordTurnAck({
                    meshId: ctx.meshId,
                    taskId: ctx.task.id,
                    kind: 'delivered',
                    attemptId: ctx.task.attemptId,
                    sessionId: ctx.sessionId,
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
        updateTaskStatus(ctx.meshId, ctx.task.id, 'pending');
        // TURN-LEDGER (Stage 5): the dispatch never reached the worker — close this
        // attempt (reassigned:dispatch_failed); the re-claim opens a fresh attempt.
        try {
            closeAttemptForReassignment({ meshId: ctx.meshId, taskId: ctx.task.id, reason: 'dispatch_failed' });
        } catch { /* best-effort */ }
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
): boolean {
    const mesh = getMeshWithCache(components, meshId);
    // Match with the shared 3-form normalizer (id / nodeId / node_id), not raw
    // `n.id` — a stamp-form nodeId vs the mesh node's config-form id must still
    // resolve, mirroring the remote idle-session path below (:1341).
    const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, nodeId));

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
    // Per-(node, provider) maxParallel cap (summed across the node's slots for this
    // provider) layers on top of the global/taskMode caps — stricter wins. Resolved
    // here where the claiming session's providerType + node policy are both known,
    // then enforced inside the atomic claim transaction so concurrent claims can't
    // overshoot it.
    const providerMaxParallel = resolveProviderMaxParallel(resolveNodeCapabilitySlots(node), providerType);
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
    const task = claimNextTask(meshId, nodeId, sessionId, capabilityTags, {
        providerType,
        ...(providerMaxParallel !== undefined ? { providerMaxParallel } : {}),
        nodeIsWorktree,
        ...(assignedTranscriptProfile ? { assignedTranscriptProfile } : {}),
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
        const isLocalNode = components.cliManager.adapters.has(sessionId);
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
                ...delegatedWorkerAutoApproveSettings(
                    mesh?.policy,
                    node?.policy,
                    components.providerLoader?.getMeta(providerType),
                    loadRepoConfigForNode(node),
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
export const AUTO_LAUNCH_AWAIT_CLAIM_MS = 90_000;

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
// Local mirror of REMOTE_IDLE_SESSION_TTL_MS (mesh-event-forwarding) — kept here to avoid a
// cross-module import cycle. Used when (re)registering a launched remote session as an idle
// claim candidate during the await-claim re-drive.
const AUTO_LAUNCH_REMOTE_IDLE_TTL_MS = 5 * 60 * 1000;

// Per-task await-claim backoff state, keyed `${meshId}::${taskId}`. `cycles` counts how many
// times the window has been extended; `nextAttemptAtMs` rate-limits the re-drive to the backoff
// cadence so the 4s reconcile tick does not hammer it. Cleared once the task claims, the direct
// dispatch fires, or a respawn is authorized. In-memory (per process); a stale entry is harmless
// (it only defers a respawn) and self-clears on the next resolution.
interface AwaitClaimBackoffState { cycles: number; nextAttemptAtMs: number; }
const autoLaunchAwaitClaimBackoff = new Map<string, AwaitClaimBackoffState>();

// Test hooks: reset / seed the await-claim backoff state between cases.
export function __resetAutoLaunchAwaitClaimBackoffForTests(): void {
    autoLaunchAwaitClaimBackoff.clear();
}
export function __seedAutoLaunchAwaitClaimBackoffForTests(meshId: string, taskId: string, state: AwaitClaimBackoffState): void {
    autoLaunchAwaitClaimBackoff.set(`${meshId}::${taskId}`, { ...state });
}

// Backoff window for a given cycle count: 90 → 180 → 360s (capped at the cap-cycle multiplier).
function awaitClaimWindowMs(cycles: number): number {
    return AUTO_LAUNCH_AWAIT_CLAIM_MS * Math.pow(2, Math.min(cycles, AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES));
}

// Does the coordinator's remote-session view (MeshRuntimeStore remote idle sessions, populated by
// mesh event forwarding) currently show this session as a live idle claim candidate? Positive
// evidence the launched remote session is reachable — used to re-drive its claim directly instead
// of respawning. Absence is NOT proof the session is gone (the agent:ready pull may simply have
// been lost), so callers treat a false here as UNKNOWN liveness, never a definitive terminal.
function remoteSessionAppearsLive(meshId: string, sessionId: string): boolean {
    if (!sessionId) return false;
    try {
        return MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
            .some(s => sessionIdsEquivalent(s.sessionId, sessionId));
    } catch {
        return false;
    }
}

// (A) Respawn-guard remote-awareness. The session ids of pending tasks whose auto-launch record
// targets `nodeId` (status started/completed with a sessionId) and is still inside its await-claim
// window — the base 90s window OR an active backoff extension. Such a session is ALREADY on its way
// to claim even when it is REMOTE (invisible to this daemon's instanceManager), so counting it
// suppresses a duplicate launch that would otherwise spawn a ghost.
function inWindowAutoLaunchSessionIdsForNode(meshId: string, nodeId: string): string[] {
    const nowMs = Date.now();
    const out: string[] = [];
    for (const task of getQueue(meshId, { status: ['pending'] as any })) {
        const al = task.autoLaunch;
        const sid = al ? readNonEmptyString(al.sessionId) : '';
        if (!al || (al.status !== 'started' && al.status !== 'completed') || !sid) continue;
        if (!daemonIdsEquivalent(al.nodeId, nodeId)) continue;
        const launchedAtMs = Date.parse(al.updatedAt);
        const inBaseWindow = Number.isFinite(launchedAtMs) && nowMs - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS;
        const inBackoff = autoLaunchAwaitClaimBackoff.has(`${meshId}::${task.id}`);
        if (inBaseWindow || inBackoff) out.push(sid);
    }
    return out;
}

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

// FALSE-BLOCKER-CLONE-QUEUE: the TRANSIENT counterpart of 'target_node_id_unmatched'. A
// queue task pinned to a freshly cloned worktree node can transiently find no matching node
// (its inline-cache entry has not propagated to this coordinator daemon yet, and/or its
// worktree bootstrap is still running). That unmatch SELF-RESOLVES — it is not the permanent
// routing miss the actionable blocker exists for — so it is deliberately NOT listed in
// ACTIONABLE_SKIP_REASON_PREFIXES: isActionableSkipReason() returns false for it, so no
// "actionable blocker — will NOT clear on its own" coordinator page is emitted. The skip is
// still recorded to task.autoLaunch + the ledger for diagnosability.
const TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON = 'target_node_bootstrap_pending';

// De-dup actionable-skip coordinator notifications: emit once per (mesh, task) until the
// reason CHANGES, so the 4s reconcile loop re-marking the same skip does not re-notify. A
// non-skip transition (or a genuine reason change) re-arms it. In-memory only — a daemon
// restart re-notifies once, which is the correct behaviour after a restart.
const lastActionableSkipNotified = new Map<string, string>();

function isActionableSkipReason(reason?: string): boolean {
    if (!reason) return false;
    return ACTIONABLE_SKIP_REASON_PREFIXES.some(prefix => reason === prefix || reason.startsWith(prefix));
}

/**
 * FALSE-BLOCKER-CLONE-QUEUE: a target pin is TRANSIENTLY (not permanently) unresolved when
 * the pinned node is a freshly cloned worktree that will auto-claim once its bootstrap
 * completes / its inline-cache entry propagates — as opposed to a removed/dead node whose
 * unmatch is a permanent, actionable routing miss. Two signals, either suffices:
 *   (a) the node IS visible in the (cache-merged) mesh view but its worktree bootstrap is
 *       still 'running' (and not stuck past the stale backstop), or
 *   (b) the node is NOT visible here yet, but a clone for its id was issued within the grace
 *       window (propagation/bootstrap latency) — see mesh-clone-grace.
 * Conservative: a node neither bootstrap-running nor recently cloned → returns false, so a
 * genuinely dead node keeps its permanent, actionable 'target_node_id_unmatched'.
 */
function isTargetNodeTransientlyUnresolved(mesh: any, task: MeshWorkQueueEntry): boolean {
    const targetNodeId = readNonEmptyString(task.targetNodeId);
    if (!targetNodeId) return false;
    const node = Array.isArray(mesh?.nodes)
        ? mesh.nodes.find((n: any) => meshNodeIdMatches(n, targetNodeId))
        : undefined;
    if (node
        && (node as { worktreeBootstrap?: { status?: string } }).worktreeBootstrap?.status === 'running'
        && !isWorktreeBootstrapStaleRunning(node)) {
        return true;
    }
    return isWithinCloneBootstrapGrace(targetNodeId);
}

// ---------------------------------------------------------------------------
// DEAD-TARGET-SELFHEAL: unpin a queue task hard-pinned to a session/node that has
// died (absent from the live mesh) so a live idle session can claim it, instead of
// leaving it stranded 'pending' forever behind the target_session_constraint skip.
// ---------------------------------------------------------------------------

// Conservative age gate before a pinned-but-dead target is unpinned. A target that is
// merely briefly unassigned or momentarily reconnecting must not be reclaimed on the
// tick it drops out of view; we require the task to have been idle (no updatedAt bump)
// for at least this window first. Sized to comfortably outlast a transient P2P blip /
// reconnect while staying well inside the reclaim cadence of the rest of the file
// (AUTO_LAUNCH_AWAIT_CLAIM_MS is 90s; the stranded-reclaim watchdog fires on similar
// scales), so a real reconnect wins the race and the self-heal only fires on a target
// that is genuinely gone.
const DEAD_TARGET_GRACE_MS = 60_000;

// RC.20 TARGET-PIN TTL (the mesh_queue_requeue wedge): a task hard-pinned with
// target_session_id is delivered when that LIVE, compatible session claims it (the
// tier-1 claim gate matches the pin; the idle→claim drain drives it in seconds). But a
// pin whose target can never claim — a session on a REMOTE node this daemon cannot
// observe (the dead-target verdict stays UNKNOWN there by design), a session that is not
// an idle-claim participant for this mesh, or one that stays busy indefinitely — left
// the task 'pending' FOREVER behind the target_session_constraint skip (observed live
// 2026-07-28 on a cancel/reassignment control). Bounded rule: a pin that has gone
// UNCLAIMED for this TTL (anchored at the task's requeuedAt/createdAt, so per-tick
// updatedAt bumps cannot reset it) is EXPIRED — the target pin is cleared without
// consuming the retry budget and the task becomes claimable by any compatible session.
// Sized far above every legitimate claim window (DEAD_TARGET_GRACE_MS 60s,
// AUTO_LAUNCH_AWAIT_CLAIM_MS 90s, remote agent:ready pull lag, and the 5-min dead-target
// grace used by the live-busy contract) so a genuinely-live claim always wins the race;
// only a pin that demonstrably never delivers expires.
const TARGET_SESSION_PIN_TTL_MS = 15 * 60_000;

/** Age of the task's target pin in ms (anchored at the last requeue, else creation). */
function targetPinAgeMs(task: MeshWorkQueueEntry, nowMs: number = Date.now()): number | null {
    const anchorMs = Date.parse(task.requeuedAt || task.createdAt || '');
    return Number.isFinite(anchorMs) ? nowMs - anchorMs : null;
}

interface DeadTargetVerdict {
    /** The pinned target is confirmed dead and past the grace window → safe to unpin. */
    dead: boolean;
    /** True when the target NODE itself is absent from the live mesh (clear targetNodeId too). */
    nodeDead: boolean;
    /** Short reason string for the ledger/requeue. */
    reason: string;
}

/**
 * Decide whether a task's hard target pin (targetSessionId and/or targetNodeId) points at
 * something that has DIED — i.e. is absent from the live mesh snapshot — and has been so
 * long enough (DEAD_TARGET_GRACE_MS since the task's last update) that unpinning is safe.
 *
 * Two definitive death signals, deliberately conservative to never race a reconnecting node:
 *
 *  (1) NODE dead — the task pins a targetNodeId that matches NO node in the live mesh
 *      (the same `meshNodeIdMatches`-over-mesh.nodes signal the targetPinUnmatched relabel
 *      uses at the empty-candidate site). A pinned session on an absent node is unreachable
 *      regardless, so the session pin is dead too. `nodeDead` ⇒ clear targetNodeId as well.
 *      Excluded: a target that is only TRANSIENTLY unresolved (a freshly-cloned worktree
 *      still propagating / bootstrapping) — isTargetNodeTransientlyUnresolved gates it out.
 *
 *  (2) SESSION dead on a LIVE LOCAL node — the target node IS present and is THIS daemon's
 *      node, but the pinned session is absent from the local instance manager
 *      (resolveSessionBusyVerdict === 'UNKNOWN'). Local session visibility is complete, so
 *      absence here is genuine death, not a busy/generating flip. We KEEP targetNodeId (only
 *      the session died; the node is healthy and can host a replacement claim).
 *
 * A live REMOTE node whose session is not in our idle view is NOT treated as dead: absence
 * from the remote-idle mirror is explicitly UNKNOWN liveness (the session may be busy or its
 * agent:ready pull merely lost), so unpinning it could race healthy in-flight work. Returns
 * dead=false in that case, leaving the existing skip in place.
 */
function resolveDeadTargetVerdict(components: DaemonComponents, meshId: string, mesh: any, task: MeshWorkQueueEntry): DeadTargetVerdict {
    const NOT_DEAD: DeadTargetVerdict = { dead: false, nodeDead: false, reason: '' };
    const targetSessionId = readNonEmptyString(task.targetSessionId);
    const targetNodeId = readNonEmptyString(task.targetNodeId);
    if (!targetSessionId && !targetNodeId) return NOT_DEAD;

    // Age gate: never reclaim a pin younger than the grace window (guards against a target
    // that has only just dropped out of view for a momentary reconnect).
    const lastUpdateMs = Date.parse(task.updatedAt || task.createdAt || '');
    if (Number.isFinite(lastUpdateMs) && Date.now() - lastUpdateMs < DEAD_TARGET_GRACE_MS) return NOT_DEAD;

    const nodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];

    // (1) NODE-dead — a pinned node absent from the live mesh, and NOT merely transiently
    // unresolved (a propagating/bootstrapping clone). This is a permanent routing miss.
    if (targetNodeId) {
        const nodePresent = nodes.some(n => meshNodeIdMatches(n, targetNodeId));
        if (!nodePresent) {
            if (isTargetNodeTransientlyUnresolved(mesh, task)) return NOT_DEAD;
            return { dead: true, nodeDead: true, reason: 'dead_target_node_absent' };
        }
    }

    // (2) SESSION-dead on a LIVE LOCAL node. Only meaningful when a session is pinned.
    if (targetSessionId) {
        // Resolve the pinned target's node (if any) to decide whether we can trust local
        // absence. Without a targetNodeId, fall back to whichever live node hosts the session
        // is unknowable here; treat that as a LOCAL check only (a session id we cannot see
        // locally on a node we cannot resolve remotely stays UNKNOWN → not dead).
        const node = targetNodeId
            ? nodes.find(n => meshNodeIdMatches(n, targetNodeId))
            : undefined;
        // A pinned session on a REMOTE live node: absence from our view is UNKNOWN, not death.
        // Only a LOCAL node (or no node pin at all — same-daemon assumption) lets us conclude
        // death from local instance-manager absence.
        const nodeIsLocal = node ? isLocalAutoLaunchNode(node) : true;
        if (nodeIsLocal) {
            const verdict = resolveSessionBusyVerdict(components, targetSessionId);
            if (verdict === 'UNKNOWN') {
                // Session absent from the complete local session view → genuinely gone.
                return { dead: true, nodeDead: false, reason: 'dead_target_session_absent' };
            }
            // GENERATING / IDLE_CONFIRMED → the session is alive (possibly busy). Never disturb.
        }
    }

    return NOT_DEAD;
}

/**
 * FALSE-BLOCKER-CLONE-QUEUE (stale-event clear): once a task whose actionable blocker we
 * previously paged either gets claimed or transitions to a self-resolving state, re-arm the
 * de-dup ledger (so a later genuine blocker re-notifies) AND retract any still-undelivered
 * dispatch_blocked pending event, so the coordinator's pending queue no longer carries the
 * stale "will NOT clear on its own" warning. Cheap: only touches the pending store when this
 * (mesh, task) actually had a prior actionable notification recorded.
 */
function retractActionableSkipIfPreviouslyNotified(meshId: string, taskId: string): void {
    const dedupKey = `${meshId}:${taskId}`;
    if (!lastActionableSkipNotified.delete(dedupKey)) return; // nothing was paged → nothing to retract
    try {
        const coordinatorDaemonId = readNonEmptyString(loadConfig().machineId) || undefined;
        const removed = retractPendingDispatchBlockedEvent(meshId, taskId, coordinatorDaemonId);
        if (removed > 0) {
            LOG.info('MeshQueue', `Retracted ${removed} stale dispatch-blocked event(s) for task ${taskId} (mesh ${meshId}) — its blocker resolved`);
        }
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to retract stale dispatch-blocked event for task ${taskId} (mesh ${meshId}): ${e?.message || e}`);
    }
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
    // FALSE-BLOCKER-CLONE-QUEUE chokepoint defense: a 'target_node_id_unmatched' skip whose
    // node was cloned within the grace window is a TRANSIENT propagation/bootstrap gap that
    // auto-clears, not a permanent routing miss — never page the coordinator for it (the
    // reason classifier upstream already routes the common case to the transient reason; this
    // is the single-funnel backstop for any path that still labels it as the permanent reason).
    if (reason === 'target_node_id_unmatched' && isWithinCloneBootstrapGrace(readNonEmptyString(nodeId))) return;
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

function isDirtyNode(node: any): boolean {
    return node?.health === 'dirty' || node?.git?.dirty === true;
}

function resolveAutoFastForwardPolicy(mesh: any): { enabled: boolean; maxBehind?: number; requireCleanSubmodules: boolean; remoteNodes: boolean; mode: 'idle' | 'continuous' } {
    const record = mesh?.policy?.autoFastForward && typeof mesh.policy.autoFastForward === 'object' && !Array.isArray(mesh.policy.autoFastForward)
        ? mesh.policy.autoFastForward as Record<string, unknown>
        : {};
    const maxBehind = Number(record.maxBehind);
    return {
        enabled: record.enabled !== false,
        ...(Number.isFinite(maxBehind) && maxBehind >= 0 ? { maxBehind: Math.floor(maxBehind) } : {}),
        requireCleanSubmodules: record.requireCleanSubmodules !== false,
        // Strict opt-in: absent/false → self-only (historical behavior). Only an
        // explicit `true` extends auto ff to remote owning-daemon nodes.
        remoteNodes: record.remoteNodes === true,
        // Absent/anything-but-continuous → 'idle' (historical idle-edge-only detection).
        mode: record.mode === 'continuous' ? 'continuous' : 'idle',
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

function activeAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any }).length;
}

/** Active assignments that hold the one-active-per-node / global-parallel invariant
 *  (everything except read-only diagnoses, which run unbounded by the write cap). */
export function activeWriteAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => !isTaskReadonly(task)).length;
}

/** Active read-only assignments, for the read-only safety cap. */
export function activeReadonlyAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(isTaskReadonly).length;
}

function nodeHasActiveAssignment(meshId: string, nodeId: string): boolean {
    // Canonical-form match, NOT a raw `===`: an assigned row stamped in one daemon-id
    // form (e.g. `daemon_mach_X`) must still register as this node's active work when
    // the candidate nodeId arrives bare (`mach_X`). A raw mismatch makes the node look
    // free, letting a second write task auto-launch onto an already-busy node and
    // breaking the one-write-per-node (worktree isolation) invariant.
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => daemonIdsEquivalent(task.assignedNodeId, nodeId));
}

/** Active (status='assigned') task count for a node — the load metric for
 *  least-loaded / round-robin ranking. Lower = preferred. */
function nodeActiveLoad(meshId: string, nodeId: string): number {
    return MeshRuntimeStore.getInstance().nodeActiveAssignmentCount(meshId, nodeId);
}

/** True when any node in the mesh has an EXPLICIT capability-slot list configured
 *  (policy.slots). Legacy-derived slots don't count — only an operator (or the
 *  orchestrator, with approval) authoring slots signals intent to route by fitness. */
function meshHasExplicitSlots(mesh: any): boolean {
    const nodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    return nodes.some((n: any) => normalizeNodeCapabilitySlots(n?.policy?.slots).length > 0);
}

/**
 * The mesh-wide scheduling strategy, read from the MACHINE-LOCAL stored mesh
 * policy. Resolution order:
 *   1. an EXPLICITLY stored schedulingStrategy (operator picked a mode) wins, else
 *   2. 'fitness' AUTO when the mesh has any node with explicit capability slots —
 *      configuring slots is itself the signal to route tasks by task→slot fitness
 *      (difficulty/capability), no separate strategy toggle required, else
 *   3. 'first_eligible' (strict no-change default for slot-less meshes).
 *
 * Persistence economy drops schedulingStrategy from policy when it equals the
 * first_eligible default (repo-mesh-types normalizeMeshPolicy), so an ABSENT value
 * means "unset" — safe to auto-upgrade — while a PRESENT value means the operator
 * chose it and we never override. Policy is machine-local only; this only governs
 * the final tie-break — eligibility, capacity, and priority gates are unchanged.
 */
function resolveSchedulingStrategy(mesh: any): RepoMeshSchedulingStrategy {
    const raw = mesh?.policy?.schedulingStrategy;
    if (typeof raw === 'string' && raw.trim()) {
        return normalizeMeshSchedulingStrategy(raw);
    }
    // Unset → auto-fitness when slots exist, else the historical default.
    return meshHasExplicitSlots(mesh) ? 'fitness' : normalizeMeshSchedulingStrategy(undefined);
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
    opts?: { bumpCursor?: boolean; task?: { difficulty?: string; requiredTags?: string[] } },
): RankableNode[] {
    return orderEligibleNodes(meshId, strategy, nodes, opts);
}

/** One idle session eligible to claim a queued task, together with the resolved
 *  mesh node record it belongs to. Local candidates come from live CLI instances,
 *  remote candidates from the registered remote-idle-session store; the two arrive
 *  with their `nodeId` under different serialization forms. */
type IdleCandidate = { nodeId: string; sessionId: string; providerType: string; origin: 'local' | 'remote'; node: any };

/**
 * Merge local + remote idle candidates into the scheduling pool with a single,
 * form-canonical node identity.
 *
 * INVARIANT: every candidate in the returned pool carries its `nodeId` in
 * CANONICAL (normalized) form, and `uniqueNodes` has exactly one entry per
 * physical node. Local and remote candidates arrive with their `nodeId` under
 * mixed forms (config `id`, wire `nodeId`, DB `node_id`). Downstream scheduling
 * keys the pool by raw-string equality (Set dedup, baseIndex, rankIndex,
 * nodeActiveLoad), so two candidates for the SAME physical node under two
 * different forms would otherwise be treated as two distinct nodes — form-drift
 * that splits a node's load and double-ranks it. Canonicalizing here (via the
 * resolved node record, which meshNodeIdMatches already matched form-agnostically)
 * makes every later `=== nodeId` comparison operate on one agreed form. Falls back
 * to the raw candidate id when the node is unresolved (an unresolved candidate
 * cannot be normalized, but also has no sibling to collide with).
 */
function buildSchedulingPool(
    localCandidates: IdleCandidate[],
    remoteCandidates: IdleCandidate[],
): { pool: IdleCandidate[]; uniqueNodes: RankableNode[] } {
    const pool = [...localCandidates, ...remoteCandidates].map(c => ({
        ...c,
        nodeId: normalizeMeshNodeId(c.node) ?? c.nodeId,
    }));
    // Both sides are canonical now, so raw `===` in the Set dedup and the node
    // re-lookup is form-safe.
    const uniqueNodes: RankableNode[] = [...new Set(pool.map(c => c.nodeId))]
        .map((nodeId, index) => ({
            nodeId,
            node: pool.find(c => meshNodeIdMatches({ id: c.nodeId } as MeshNodeIdentified, nodeId))?.node,
            index,
        }));
    return { pool, uniqueNodes };
}

/** Test-only: the pool-canonicalization + unique-node collapse stage. Exposed so
 *  the mixed-form dedup invariant can be unit-tested without a live daemon. */
export function __buildSchedulingPoolForTests(
    localCandidates: IdleCandidate[],
    remoteCandidates: IdleCandidate[],
): { pool: IdleCandidate[]; uniqueNodes: RankableNode[] } {
    return buildSchedulingPool(localCandidates, remoteCandidates);
}

// ─────────────────────────────────────────────────────────────────────────────
// Node capability slots — task→node/slot fitness (ORCHESTRATION_NODE_SLOTS.md)
//
// A node's capability slots are the single source of truth for routing. When a
// node has explicit `policy.slots` we use them; otherwise we derive slots from the
// legacy providerPriority + the machine-global difficultyBrains so existing nodes
// keep working (back-compat). The fitness scorer ranks a node for a
// specific task by how well its best slot matches the task's difficulty and
// required tags — with graceful fallback so a task is never blocked by a missing
// exact match.
// ─────────────────────────────────────────────────────────────────────────────

/** The task shape the fitness scorer reads (a subset of MeshWorkQueueEntry). */
interface FitnessTask {
    difficulty?: string;
    requiredTags?: string[];
}

/**
 * Score how well one slot fits a task. Higher = better. A slot whose difficulty
 * range contains the task's difficulty scores highest; a general-purpose slot
 * (no declared difficulty) is a valid fallback; a slot whose capability tags cover
 * the task's requiredTags gets a capability bonus. Never negative — the worst a
 * slot does is score 0 (still selectable as a last-resort fallback).
 */
function scoreSlotForTask(slot: NodeCapabilitySlot, task: FitnessTask): number {
    let score = 1; // base: any slot can run the task (fallback floor)
    const diff = isMeshTaskDifficulty(task.difficulty) ? task.difficulty as MeshTaskDifficulty : undefined;
    if (diff) {
        if (slot.difficulty?.length) {
            score += slot.difficulty.includes(diff) ? 100 : 0; // exact difficulty match dominates
        } else {
            score += 20; // general-purpose slot: decent fallback for any difficulty
        }
    }
    const req = task.requiredTags?.filter(t => !!t) ?? [];
    if (req.length) {
        const cap = new Set(slot.capability ?? []);
        const covered = req.every(t => cap.has(t));
        score += covered ? 30 : 0; // capability coverage bonus (hard filter is applied elsewhere)
    }
    return score;
}

/** Best (slot, score) for a task on a node, or null when the node has no slots. */
function bestSlotForTask(node: any, task: FitnessTask): { slot: NodeCapabilitySlot; score: number } | null {
    const slots = resolveNodeCapabilitySlots(node);
    if (!slots.length) return null;
    let best: { slot: NodeCapabilitySlot; score: number } | null = null;
    for (const slot of slots) {
        const score = scoreSlotForTask(slot, task);
        if (!best || score > best.score) best = { slot, score };
    }
    return best;
}

/** Node-level fitness for a task = its best slot's score (0 when the node has no slots). */
function nodeFitnessForTask(node: any, task: FitnessTask): number {
    return bestSlotForTask(node, task)?.score ?? 0;
}

function orderEligibleNodes(
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    nodes: RankableNode[],
    opts?: { bumpCursor?: boolean; task?: FitnessTask },
): RankableNode[] {
    if (strategy === 'first_eligible' || nodes.length <= 1) {
        return nodes;
    }

    // Fitness strategy: rank by task→slot fit first (when a task is in scope —
    // auto-launch drains per-task), then fall through to priority/load/rotation for
    // ties. Without a task (idle-session drain ranks task-independently) fitness is
    // inert and this behaves like least_loaded.
    if (strategy === 'fitness' && opts?.task) {
        const task = opts.task;
        return [...nodes].sort((a, b) => {
            const fitDelta = nodeFitnessForTask(b.node, task) - nodeFitnessForTask(a.node, task);
            if (fitDelta !== 0) return fitDelta; // higher fitness first
            const prioDelta = resolveNodeSchedulingPriority(b.node?.policy) - resolveNodeSchedulingPriority(a.node?.policy);
            if (prioDelta !== 0) return prioDelta;
            const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
            if (loadDelta !== 0) return loadDelta;
            return a.index - b.index;
        });
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
        .filter(task => daemonIdsEquivalent(task.assignedNodeId, nodeId) && task.assignedProviderType === providerType).length;
}

export function sessionHasActiveAssignment(meshId: string, sessionId: string): boolean {
    if (getQueue(meshId, { status: ['assigned'] as any }).some(task => sessionIdsEquivalent(task.assignedSessionId, sessionId))) {
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
        if (getActiveDirectDispatches(meshId).some(d => sessionIdsEquivalent(d.sessionId, sessionId))) return true;
        if (hasUnterminalDirectDispatchLedgerEntry(meshId, sessionId)) return true;
    } catch { /* best-effort — fall through to false */ }
    return false;
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
        if (task.requiredTags?.length) {
            const sessionProviderType = state.type || readNonEmptyString(settings.providerType);
            if (sessionProviderType && !nodeSatisfiesRequiredTags(task.requiredTags, buildMeshNodeCapabilityTags(node, sessionProviderType))) {
                return false; // provider mismatch → this session can't claim this task; not a pending claimer
            }
        }
        return true; // live + unassigned + provider-capable → will claim the pending task itself
    });
}

function recordAutoLaunchEvent(meshId: string, args: {
    phase: 'skipped' | 'started' | 'failed' | 'completed';
    taskId: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    reason?: string;
    error?: string;
    // LEDGER-TASK-TRACEABILITY (D): the resolved execution profile the auto-launch
    // resolved for this worker, so session_auto_launch records what model/thinking the
    // spawned worker actually launched with (not just the provider).
    model?: string;
    thinkingLevel?: string;
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
            // (B) promote taskId so this entry joins the task lifecycle timeline.
            ...(args.taskId ? { taskId: args.taskId } : {}),
            payload: {
                phase: args.phase,
                taskId: args.taskId,
                reason: args.reason,
                error: args.error,
                // (D) resolved execution profile for the spawned worker.
                ...(args.model ? { resolvedModel: args.model } : {}),
                ...(args.thinkingLevel ? { resolvedThinkingLevel: args.thinkingLevel } : {}),
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
    // LEDGER-TASK-TRACEABILITY (D): resolved execution profile for started/completed.
    model?: string;
    thinkingLevel?: string;
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
        ...(args.model ? { model: args.model } : {}),
        ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
    });
    // Fix (1): actively notify the coordinator of a non-self-resolving skip; re-arm the
    // notification on any non-skip transition (started/completed) so a later genuine skip
    // re-notifies.
    if (args.status === 'skipped') {
        if (isActionableSkipReason(args.reason)) {
            notifyCoordinatorOfActionableSkip(meshId, taskId, args.reason, args.nodeId);
        } else if (args.reason === TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON) {
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

async function resolveUsableProvider(
    components: DaemonComponents,
    nodeId: string,
    node: any,
    requiredTags?: string[],
    task?: FitnessTask,
): Promise<{ providerType?: string; model?: string; thinkingLevel?: string; reason?: string }> {
    const providerLoader = components.providerLoader;
    if (!providerLoader) return { reason: 'provider_loader_unavailable' };

    // Slot-based order (ORCHESTRATION_NODE_SLOTS.md): rank the node's capability
    // slots by task→slot fitness (difficulty/requiredTags) so the best-fit slot's
    // provider is tried first, and its model/thinkingLevel ride along. Falls back
    // to the legacy providerPriority-derived slots when no explicit slots exist.
    const slots = resolveNodeCapabilitySlots(node);
    if (!slots.length) return { reason: 'missing_provider_priority' };
    const orderedSlots = task
        ? [...slots].sort((a, b) => scoreSlotForTask(b, task) - scoreSlotForTask(a, task))
        : slots;

    const failed: string[] = [];
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
            return {
                providerType: normalizedType,
                ...(slot.model ? { model: slot.model } : {}),
                ...(slot.thinkingLevel ? { thinkingLevel: slot.thinkingLevel } : {}),
            };
        }
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
            // RC.20 TARGET-PIN TTL: the pin is NOT provably dead (live session, or a
            // remote/unobservable one the dead-target verdict must not guess about) — yet
            // it has gone UNCLAIMED past the bounded TTL, so it will never deliver through
            // the claim path. Expire the pin (no retry-budget cost) so the task becomes
            // claimable by any compatible session, instead of wedging 'pending' forever.
            // A live compatible session claims within seconds, so reaching the TTL is
            // positive evidence the pin is stale, not a race with a healthy claim.
            const pinAgeMs = targetPinAgeMs(task);
            if (pinAgeMs !== null && pinAgeMs >= TARGET_SESSION_PIN_TTL_MS) {
                const expired = expireTaskTargetPin(meshId, task.id, { reason: 'target_session_pin_expired_unclaimed' });
                if (expired) {
                    noteTargetPinCleared('target_session_pin_expired_unclaimed');
                    traceMeshEventDrop('target_session_pin_expired', {
                        taskId: task.id,
                        sessionId: readNonEmptyString(task.targetSessionId),
                        nodeId: readNonEmptyString(task.targetNodeId),
                        meshId,
                        event: 'agent:ready',
                    }, `unclaimed ${Math.round(pinAgeMs / 1000)}s ≥ ttl ${Math.round(TARGET_SESSION_PIN_TTL_MS / 1000)}s → pin cleared, claimable`);
                    LOG.warn('MeshQueue', `TARGET-PIN-TTL: task ${task.id} (mesh ${meshId}) stayed pinned-but-unclaimed for ${Math.round(pinAgeMs / 1000)}s (ttl ${Math.round(TARGET_SESSION_PIN_TTL_MS / 1000)}s); expired the stale target pin so a compatible session can claim it.`);
                }
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_pin_expired' });
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
                    const slotProviders = resolveNodeCapabilitySlots(node).map(s => s.provider).filter(Boolean);
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
                // pass it through for the 'fitness' strategy's task→slot ranking.
                { bumpCursor: true, task: { difficulty: (task as any).difficulty, requiredTags: task.requiredTags } },
            ).map((c: RankableNode) => c.node);

        // LEDGER-TASK-TRACEABILITY (A): accumulate the candidate nodes that were
        // considered but skipped before the winning node, so task_dispatched can record
        // WHY the other nodes lost (cooldown, dirty, cap, provider mismatch, …). Bounded
        // so a large fleet can't bloat the entry. markSkip mirrors markAutoLaunch's skip
        // side effect AND appends to this list in one call.
        const skippedCandidates: Array<{ nodeId: string; reason: string }> = [];
        const SKIPPED_CANDIDATES_MAX = 12;
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
                markSkip(nodeId, 'node_not_launch_ready');
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
                const resolved = await resolveUsableProvider(components, nodeId, node, task.requiredTags, { difficulty: (task as any).difficulty, requiredTags: task.requiredTags });
                if (!resolved.providerType) {
                    markSkip(nodeId, resolved.reason || 'provider_unusable');
                    continue;
                }
                // Slot-derived model/thinking: an explicit task.model/thinkingLevel
                // (resolved from the enqueue-time brain) still wins; the matched
                // slot fills only what the task left blank (ORCHESTRATION_NODE_SLOTS.md).
                const rawEffectiveModel = (typeof task.model === 'string' && task.model.trim()) ? task.model.trim() : resolved.model;
                const effectiveThinkingLevel = (typeof task.thinkingLevel === 'string' && task.thinkingLevel.trim()) ? task.thinkingLevel.trim() : resolved.thinkingLevel;

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

                // Don't spawn a session for a (node, provider) already at its declared
                // maxParallel cap — it would launch only to fail the claim. The claim
                // transaction enforces the cap regardless; this just avoids a doomed launch.
                const providerCap = resolveProviderMaxParallel(resolveNodeCapabilitySlots(node), resolved.providerType);
                if (
                    providerCap !== undefined
                    && activeProviderAssignedCount(meshId, nodeId, resolved.providerType) >= providerCap
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
                    ...delegatedWorkerAutoApproveSettings(
                        mesh?.policy,
                        node?.policy,
                        components.providerLoader?.getMeta(resolved.providerType),
                        loadRepoConfigForNode(node),
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
                const routingDecision: MeshTaskRoutingDecision = {
                    source: 'autoLaunch',
                    fitnessScore: nodeFitnessForTask(node, { difficulty: (task as any).difficulty, requiredTags: task.requiredTags }),
                    ...(skippedCandidates.length ? { skippedCandidates } : {}),
                    requiredTagsResult: {
                        required: requiredTags,
                        satisfied: !requiredTags.length || nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node, resolved.providerType)),
                        missing: requiredTags.filter(t => !buildMeshNodeCapabilityTags(node, resolved.providerType).includes(t)),
                    },
                    resolvedProviderType: resolved.providerType,
                    ...(effectiveModel ? { resolvedModel: effectiveModel } : {}),
                    ...(effectiveThinkingLevel ? { resolvedThinkingLevel: effectiveThinkingLevel } : {}),
                    ...((task as any).difficulty ? { resolvedDifficulty: String((task as any).difficulty) } : {}),
                    ...(resolved.reason ? { reason: resolved.reason } : {}),
                };
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
                // ordering — the same tiebreak as least_loaded/round_robin.
                if (strategy === 'least_loaded' || strategy === 'round_robin' || strategy === 'fitness') {
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

/** Passed dry-run result satisfies the policy gates (maxBehind + clean submodules).
 *  Shared by the local execute path and the remote preflight re-verification so both
 *  apply exactly the same policy gate. */
function dryRunSatisfiesAutoFastForwardPolicy(
    dryRun: { code?: string; allowed?: boolean; current?: any } | null | undefined,
    policy: { maxBehind?: number; requireCleanSubmodules: boolean },
): boolean {
    if (!dryRun || dryRun.code !== 'fast_forward_available' || dryRun.allowed !== true) return false;
    const behind = Number(dryRun.current?.behind);
    // Behind must be a real, positive count within the policy cap. ahead must be 0 for
    // an ff-only merge — fast_forward_available already encodes that (ahead=0,behind>0),
    // but re-assert behind>0 defensively for the continuous/remote path.
    if (!Number.isFinite(behind) || behind <= 0) return false;
    if (policy.maxBehind !== undefined && behind > policy.maxBehind) return false;
    if (policy.requireCleanSubmodules) {
        const submodules = Array.isArray(dryRun.current?.submodules) ? dryRun.current.submodules : [];
        if (submodules.some((submodule: any) => submodule?.dirty || submodule?.outOfSync || submodule?.error)) return false;
    }
    return true;
}

function readNodeSubmoduleIgnorePaths(node: any): string[] | undefined {
    return Array.isArray(node?.policy?.submoduleIgnorePaths)
        ? node.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
        : undefined;
}

/** Whether a node is eligible to be an auto-ff target this instant: connected (for a
 *  remote node), not disabled/removed/readOnly, not a worktree still bootstrapping,
 *  and holding no active mesh work (assignment / direct dispatch / busy session). The
 *  worktree exclusion for continuous mode is applied by the caller (idle-edge ff still
 *  runs for worktree nodes on their own idle edge). */
function nodeIsAutoFastForwardEligible(components: DaemonComponents, meshId: string, nodeId: string, node: any, currentSessionId?: string): boolean {
    if (!node) return false;
    if (node.status === 'disabled' || node.status === 'removed') return false;
    if (node.readOnly === true || node.policy?.readOnly === true) return false;
    if (isWorktreeBootstrapStaleRunning(node)) return false;
    if (node.worktreeBootstrap?.status === 'running') return false;
    if (nodeHasActiveMeshWork(components, meshId, nodeId, currentSessionId)) return false;
    return true;
}

/** True when the node is connected (has an open peer/DataChannel) per the same
 *  authoritative peer-status getter the remote-event pull uses. When the getter is
 *  UNWIRED (standalone — no remote nodes at all) this returns false so the continuous
 *  scan never claims to reach a remote node it cannot dispatch to. */
function remoteNodeIsConnected(components: DaemonComponents, node: any): boolean {
    const daemonId = readMeshNodeDaemonId(node ?? {});
    if (!daemonId) return false;
    const getPeerStatus = components.getMeshPeerConnectionStatus;
    if (getPeerStatus) {
        const snapshot = getPeerStatus(daemonId);
        return !!snapshot && String(snapshot.state) === 'connected';
    }
    // No peer-status getter: fall back to the node's own reported connection state.
    return readNonEmptyString(node?.connection?.state).toLowerCase() === 'connected';
}

/**
 * Execute an auto fast-forward for a REMOTE owning-daemon node by delegating to that
 * daemon via dispatchMeshCommand('fast_forward_mesh_node'). The owning daemon re-runs
 * the FULL git safety gate on the machine that actually holds the workspace, so the
 * coordinator's earlier dry-run is only an eligibility hint — the fresh preflight on
 * the owning daemon (STATUS_OPTIONS forceFresh) is the TOCTOU-safe decision point.
 *
 * We do NOT execute blindly: we first request a fresh remote dry-run, re-verify it
 * against the policy gate, and only then send execute:true — closing the window
 * between the coordinator's scan and the actual mutation. The lease is held across
 * both remote calls so the assignment path cannot dispatch a task onto this workspace
 * mid-ff.
 */
async function delegateRemoteAutoFastForward(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    node: any;
    daemonId: string;
    workspace: string;
    policy: { maxBehind?: number; requireCleanSubmodules: boolean };
    trigger: string;
}): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;
    if (!acquireAutoFastForwardLease(args.workspace)) return; // another ff already mutating this workspace
    const submoduleIgnorePaths = readNodeSubmoduleIgnorePaths(args.node);
    const mesh = getMeshWithCache(components, args.meshId);
    const baseArgs: Record<string, unknown> = {
        meshId: args.meshId,
        nodeId: args.nodeId,
        workspace: args.workspace,
        inlineMesh: mesh,
        ...(submoduleIgnorePaths ? { submoduleIgnorePaths } : {}),
        trigger: args.trigger,
        // Preserve the pre-fix self-only semantics for submodules: the local idle path
        // never updated submodules (updateSubmodules:false), so the remote path matches.
        updateSubmodules: false,
    };
    try {
        // Fresh remote dry-run (owning daemon re-reads live git state) — TOCTOU re-check.
        const remoteDry = await dispatchMeshCommand(args.daemonId, 'fast_forward_mesh_node', {
            ...baseArgs,
            execute: false,
            dryRun: true,
        }) as { code?: string; allowed?: boolean; current?: any } | null;
        if (!dryRunSatisfiesAutoFastForwardPolicy(remoteDry, args.policy)) return;
        // Re-check eligibility right before mutating: a task may have been dispatched to
        // this node between the scan and now (busy → skip, not an error).
        if (nodeHasActiveMeshWork(components, args.meshId, args.nodeId)) return;
        const executed = await dispatchMeshCommand(args.daemonId, 'fast_forward_mesh_node', {
            ...baseArgs,
            execute: true,
            dryRun: false,
        }) as { executed?: boolean; postStatus?: any; code?: string } | null;
        if (executed?.executed === true) {
            LOG.info('MeshFastForward', `Remote auto fast-forward executed for node ${args.nodeId} (daemon ${String(args.daemonId).slice(0, 12)}, trigger ${args.trigger})`);
        }
    } catch (e: any) {
        LOG.warn('MeshFastForward', `Remote auto fast-forward delegation failed for ${args.nodeId}: ${e?.message || e}`);
    } finally {
        releaseAutoFastForwardLease(args.workspace);
    }
}

/** Execute an auto fast-forward for a LOCAL node (the coordinator's own workspace) —
 *  the historical self-only path, now lease-guarded so a continuous-mode local scan
 *  and the assignment path cannot race the same workspace. */
async function executeLocalAutoFastForward(args: {
    meshId: string;
    nodeId: string;
    node: any;
    workspace: string;
    policy: { maxBehind?: number; requireCleanSubmodules: boolean };
    trigger: string;
}): Promise<void> {
    if (!acquireAutoFastForwardLease(args.workspace)) return;
    const submoduleIgnorePaths = readNodeSubmoduleIgnorePaths(args.node);
    try {
        const dryRun = await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace: args.workspace,
            execute: false,
            dryRun: true,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: args.trigger,
        });
        if (!dryRunSatisfiesAutoFastForwardPolicy(dryRun, args.policy)) return;
        await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace: args.workspace,
            execute: true,
            dryRun: false,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: args.trigger,
        });
    } catch (e: any) {
        LOG.warn('MeshFastForward', `Idle auto fast-forward check failed for ${args.nodeId}: ${e?.message || e}`);
    } finally {
        releaseAutoFastForwardLease(args.workspace);
    }
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

    const policy = resolveAutoFastForwardPolicy(mesh);
    if (!policy.enabled) return;
    if (nodeHasActiveMeshWork(components, args.meshId, args.nodeId, args.sessionId)) return;

    const throttleKey = `${args.meshId}:${args.nodeId}`;
    const now = Date.now();
    const lastAttempt = idleAutoFastForwardLastAttempt.get(throttleKey) || 0;
    if (now - lastAttempt < IDLE_AUTO_FAST_FORWARD_THROTTLE_MS) return;
    idleAutoFastForwardLastAttempt.set(throttleKey, now);

    // Local node (coordinator's own workspace): the historical self-only path. Gate on
    // existsSync — a local workspace must be on THIS disk. Unchanged behavior.
    if (isLocalAutoLaunchNode(node)) {
        if (!existsSync(workspace)) return;
        await executeLocalAutoFastForward({ meshId: args.meshId, nodeId: args.nodeId, node, workspace, policy, trigger: 'idle_auto' });
        return;
    }

    // Remote node: strictly opt-in. Without remoteNodes:true the historical behavior
    // (self-only) is preserved — a remote idle edge simply does nothing here.
    if (!policy.remoteNodes) return;
    const daemonId = readMeshNodeDaemonId(node ?? {});
    if (!daemonId || !components.dispatchMeshCommand) return;
    if (!remoteNodeIsConnected(components, node)) return;
    await delegateRemoteAutoFastForward(components, { meshId: args.meshId, nodeId: args.nodeId, node, daemonId, workspace, policy, trigger: 'idle_auto' });
}

/**
 * Continuous-mode remote auto fast-forward scan (mode:"continuous" only). Called by
 * the reconcile tick BEFORE queue claim. Scans every connected, eligible, non-worktree
 * remote node of every mesh this daemon hosts and delegates an ff to its owning daemon
 * when it is online/clean/behind within policy. Per-node cooldown + the workspace lease
 * keep the ~4s reconcile cadence from hammering peers or racing an assignment.
 *
 * Ephemeral worktree nodes are DELIBERATELY excluded from the continuous catch-up: a
 * Refinery worktree branch must not be silently advanced by a background scan (only its
 * own idle-edge ff, which the coordinator drives intentionally). Non-worktree base
 * nodes are the sole continuous target.
 */
export async function runContinuousAutoFastForwardScan(components: DaemonComponents, mesh: any): Promise<void> {
    if (!components.dispatchMeshCommand) return; // standalone has no remote nodes to scan
    const policy = resolveAutoFastForwardPolicy(mesh);
    if (!policy.enabled || !policy.remoteNodes || policy.mode !== 'continuous') return;
    const meshId = readNonEmptyString(mesh?.id);
    if (!meshId) return;
    const nodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    const now = Date.now();
    for (const node of nodes) {
        const nodeId = normalizeMeshNodeId(node);
        if (!nodeId) continue;
        // Continuous targets non-worktree remote base nodes only.
        if (node?.isLocalWorktree === true) continue;
        if (isLocalAutoLaunchNode(node)) continue; // local is covered by the idle-edge path
        const workspace = readNonEmptyString(node?.workspace);
        if (!workspace) continue;
        const daemonId = readMeshNodeDaemonId(node ?? {});
        if (!daemonId) continue;
        if (!nodeIsAutoFastForwardEligible(components, meshId, nodeId, node)) continue;
        if (!remoteNodeIsConnected(components, node)) continue;
        const cooldownKey = `${meshId}:${nodeId}`;
        const lastScan = continuousAutoFastForwardLastScan.get(cooldownKey) || 0;
        if (now - lastScan < CONTINUOUS_AUTO_FAST_FORWARD_SCAN_COOLDOWN_MS) continue;
        continuousAutoFastForwardLastScan.set(cooldownKey, now);
        await delegateRemoteAutoFastForward(components, { meshId, nodeId, node, daemonId, workspace, policy, trigger: 'reconcile_auto' });
    }
}

/**
 * DS3: drain and act on `coordinator_catchup` markers queued by a remote node's Refinery
 * after it pushed the base branch to origin. The originating coordinator is THIS daemon;
 * its local base checkout is now behind origin. Bring it up to date with a guarded ff-only
 * merge — but ONLY when the coordinator base node has no active mesh work (busy → leave the
 * marker for the next idle tick) and fastForwardMeshNode's own clean/ahead=0/behind>0 gate
 * is satisfied (ahead/diverged/dirty → it returns a structured block, never a rebase).
 *
 * These markers are drained on a DEDICATED event-name filter so they never reach the
 * coordinator chat-injection path (they are actions, not messages). A busy/blocked node
 * re-queues the marker so a later idle tick retries; a successful/no-op ff consumes it.
 */
export async function runPendingCoordinatorCatchupScan(components: DaemonComponents, mesh: any): Promise<void> {
    const meshId = readNonEmptyString(mesh?.id);
    if (!meshId) return;
    const localIds = expandDaemonIdForms([
        readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId),
        readNonEmptyString(loadConfig().machineId),
    ]);
    let markers: Awaited<ReturnType<typeof drainPendingMeshCoordinatorEvents>> = [];
    try {
        markers = drainPendingMeshCoordinatorEvents(
            meshId,
            localIds.length > 0 ? localIds : undefined,
            { onlyEvents: new Set(['coordinator_catchup']) },
        );
    } catch (e: any) {
        LOG.warn('MeshReconcile', `Coordinator-catchup drain failed for mesh ${meshId}: ${e?.message || e}`);
        return;
    }
    if (markers.length === 0) return;
    const nodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    for (const marker of markers) {
        const meta = (marker.metadataEvent || {}) as Record<string, unknown>;
        const nodeId = readNonEmptyString(marker.nodeId) || readNonEmptyString(meta.nodeId as string);
        const workspace = readNonEmptyString(marker.workspace) || readNonEmptyString(meta.workspace as string);
        const baseBranch = readNonEmptyString(meta.baseBranch as string);
        if (!workspace) continue;
        // Busy node → re-queue and defer to the next idle tick (never advance a base a
        // session is actively working on).
        if (nodeId && nodeHasActiveMeshWork(components, meshId, nodeId)) {
            try { queuePendingMeshCoordinatorEvent(marker); } catch { /* best-effort re-queue */ }
            continue;
        }
        try {
            const ff = await fastForwardMeshNode({
                meshId,
                ...(nodeId ? { nodeId } : {}),
                workspace,
                ...(baseBranch ? { branch: baseBranch } : {}),
                mode: 'merge',
                execute: true,
                trigger: 'refine_post_push_catchup',
                allowAutoPublishSubmoduleMainCommits: mesh?.policy?.allowAutoPublishSubmoduleMainCommits === true,
            });
            LOG.info('MeshReconcile', `Coordinator catch-up ff for ${meshId}/${nodeId || workspace}: ${ff.code} (executed=${ff.executed})`);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Coordinator catch-up ff failed for ${meshId}/${nodeId || workspace}: ${e?.message || e}`);
        }
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
