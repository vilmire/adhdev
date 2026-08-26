import { existsSync } from 'fs';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { LOG } from '../logging/logger.js';
import { loadConfig } from '../config/config.js';
import { fastForwardMeshNode } from './mesh-fast-forward.js';
import { normalizeMeshWorkspaceForCompare, meshNodeIdMatches, normalizeMeshNodeId, expandDaemonIdForms } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import { queuePendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents } from './mesh-events-pending.js';
import { isWorktreeBootstrapStaleRunning } from './worktree-bootstrap-config.js';
import { getMeshWithCache, isIdleSessionState, nodeHasActiveMeshWork, isLocalAutoLaunchNode } from './mesh-queue-assignment.js';

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

export function isDirtyNode(node: any): boolean {
    return node?.health === 'dirty' || node?.git?.dirty === true;
}

export function resolveAutoFastForwardPolicy(mesh: any): { enabled: boolean; maxBehind?: number; requireCleanSubmodules: boolean; remoteNodes: boolean; mode: 'idle' | 'continuous' } {
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
        // Pure gitlink drift (outOfSync alone, working tree itself clean) is tolerated —
        // executeLocalAutoFastForward/delegateRemoteAutoFastForward now run
        // updateSubmodules:true, which resolves the drift as part of the same ff cycle.
        // A genuinely dirty or errored submodule still blocks unconditionally.
        if (submodules.some((submodule: any) => submodule?.dirty || submodule?.error)) return false;
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
        // Mirror the manual mesh_fast_forward_node update_submodules behavior: if the
        // ff-only merge moves a submodule gitlink, run `git submodule update --init
        // --recursive` in the same cycle so the checkout never drifts from the gitlink.
        // Without this, drift accumulates and self-blocks every subsequent auto-ff
        // (collectPreflightBlockers treats out-of-sync submodules as a hard blocker).
        updateSubmodules: true,
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
            // See delegateRemoteAutoFastForward's updateSubmodules comment: mirrors the
            // manual tool so a gitlink-moving ff cannot leave the submodule drifted.
            updateSubmodules: true,
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
            updateSubmodules: true,
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
                // Same gitlink-drift-prevention rationale as executeLocalAutoFastForward /
                // delegateRemoteAutoFastForward — this path pushed the base branch itself,
                // so a submodule gitlink bump here is exactly as likely.
                updateSubmodules: true,
                trigger: 'refine_post_push_catchup',
                allowAutoPublishSubmoduleMainCommits: mesh?.policy?.allowAutoPublishSubmoduleMainCommits === true,
            });
            LOG.info('MeshReconcile', `Coordinator catch-up ff for ${meshId}/${nodeId || workspace}: ${ff.code} (executed=${ff.executed})`);
        } catch (e: any) {
            LOG.warn('MeshReconcile', `Coordinator catch-up ff failed for ${meshId}/${nodeId || workspace}: ${e?.message || e}`);
        }
    }
}