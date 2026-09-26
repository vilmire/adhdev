import { existsSync } from 'fs';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import { listMeshes } from '../config/mesh-config.js';
import { fastForwardMeshNode } from './mesh-fast-forward.js';
import { normalizeMeshWorkspaceForCompare, meshNodeIdMatches, normalizeMeshNodeId } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId, readObjectRecord } from './mesh-node-identity.js';
import { meshNoticeRuntime } from './turn-ledger/deliver.js';
import { isWorktreeBootstrapStaleRunning } from './worktree-bootstrap-config.js';
import { getMeshWithCache, isIdleSessionState, nodeHasActiveMeshWork, isLocalAutoLaunchNode } from './mesh-queue-assignment.js';
import { resolveTunedReconcileMs } from './mesh-tuned-env.js';

// ── cadence tunables (moved from mesh-reconcile-config.ts, deleted in C4) ──
// P6 (2026-09-23 IPC-load audit, finding 6): the continuous auto-ff scan used to
// run INSIDE the 4s reconcile tick, awaited serially — one P2P dry-run per remote
// base node, every ~4s subject only to a 45s per-node cooldown. Measured: 15,177
// of 16,040 logged P2P mesh sends over ~3.5 days (94.6%, ~4,300/day, ~1.2s each),
// 23% of daemon log lines, and the 13-34s event-loop spikes coincided with this
// traffic. Two changes:
//   1. The scan now runs on its OWN scheduler (see startContinuousAutoFastForwardScheduler
//      in mesh-auto-fast-forward.ts) — never awaited by the reconcile tick — so a
//      slow/degraded peer cannot stall queue-claim or event-pull phases.
//   2. Per-node backoff GROWS when a dry-run reports nothing to do (no upstream
//      movement), instead of re-polling every fixed interval forever. This is the
//      dominant cost: most dry-runs are no-ops (nothing changed since last scan).

// Base interval between successive scans of a single node's backoff cursor. Same
// order of magnitude as the historical 45s cooldown, so a genuinely-behind node is
// still caught up within roughly one tick of it falling behind. Only a node whose
// LAST scan was a confirmed no-op backs off past this floor.
export const DEFAULT_AUTO_FF_SCAN_BASE_MS = 45_000; // 45s

// Ceiling for the exponential backoff below. 10 minutes bounds the worst-case
// staleness of a long-idle, never-changing remote base node while still keeping
// the eventual catch-up latency well inside a normal work session.
export const DEFAULT_AUTO_FF_SCAN_MAX_MS = 10 * 60_000; // 10m

// Multiplier applied per consecutive confirmed-no-op round: 45s → 90s → 180s →
// 360s → 600s(capped). Any round that finds real movement (or executes an ff)
// resets the node back to the base interval — see noteAutoFastForwardScanResult.
export const AUTO_FF_SCAN_BACKOFF_MULTIPLIER = 2;

export function resolveAutoFastForwardScanBaseMs(): number {
    // Floor 5s so a mis-set env cannot turn this into a busy-loop; ceiling 5min so
    // the base itself cannot be tuned past the max below (resolveAutoFastForwardScanMaxMs
    // still wins as the hard ceiling regardless).
    return resolveTunedReconcileMs('MESH_AUTO_FF_SCAN_BASE_MS', DEFAULT_AUTO_FF_SCAN_BASE_MS, 5_000, 5 * 60_000);
}

export function resolveAutoFastForwardScanMaxMs(): number {
    // Floor = the base default, so the ceiling can never be tuned below the floor
    // it bounds; ceiling 1h so a mis-set env cannot disable catch-up altogether.
    return resolveTunedReconcileMs('MESH_AUTO_FF_SCAN_MAX_MS', DEFAULT_AUTO_FF_SCAN_MAX_MS, DEFAULT_AUTO_FF_SCAN_BASE_MS, 60 * 60_000);
}

// Per-call budget for a single remote fast_forward_mesh_node dry-run dispatch.
// Bounds a slow/degraded peer so it cannot stall the scheduler tick for other
// nodes — see runAutoFastForwardScanTick's per-node Promise.race in
// mesh-auto-fast-forward.ts. Below the historical measured ~1.2s typical
// round-trip there would be false timeouts on a healthy peer, so the floor
// leaves ample headroom.
export const DEFAULT_AUTO_FF_CALL_TIMEOUT_MS = 8_000; // 8s

export function resolveAutoFastForwardCallTimeoutMs(): number {
    // Floor 2s (still >> the ~1.2s measured healthy round-trip) so the timeout
    // cannot be tuned into spurious failures; ceiling 60s so a mis-set env cannot
    // let one stuck peer occupy the scheduler for a full minute per node.
    return resolveTunedReconcileMs('MESH_AUTO_FF_CALL_TIMEOUT_MS', DEFAULT_AUTO_FF_CALL_TIMEOUT_MS, 2_000, 60_000);
}

// ---------------------------------------------------------------------------
// Idle auto fast-forward throttle state
// ---------------------------------------------------------------------------
const IDLE_AUTO_FAST_FORWARD_THROTTLE_MS = 30 * 60 * 1000;
const idleAutoFastForwardLastAttempt = new Map<string, number>();

// Continuous-mode per-node scan cooldown (mode:"continuous" scan, now run by its OWN
// scheduler — see startContinuousAutoFastForwardScheduler — NOT the 4s reconcile tick).
//
// P6 (2026-09-23 IPC-load audit, finding 6): this used to be a FIXED per-node cooldown
// (45s), so a node that never has anything to fast-forward was re-polled with a P2P
// dry-run every 45s forever. Measured: 15,177 of 16,040 logged P2P mesh sends over
// ~3.5 days (94.6%, ~4,300/day). This is now an EXPONENTIAL BACKOFF per node: a
// confirmed no-op round (dry-run says nothing to do, or the cheap git-status precheck
// already shows nothing to do) grows the node's next-eligible time; any round that
// finds real movement (or executes an ff) resets it back to the base interval. The
// map's value is the NEXT time (ms epoch) this node is eligible to be scanned again —
// not merely "last scanned at" — so a stale entry from a previous scan interval never
// causes an early re-scan when the base/max tunables change at runtime (env override).
interface AutoFastForwardScanState {
    nextEligibleAtMs: number;
    // Current backoff step width, in ms. Starts at the base interval; doubles on each
    // consecutive no-op, capped at the configured max; resets to the base the moment a
    // scan finds real movement or executes.
    currentStepMs: number;
}
const continuousAutoFastForwardScanState = new Map<string, AutoFastForwardScanState>();
// Legacy alias kept for the existing per-node-cooldown regression test's mental model
// (still exercised via runContinuousAutoFastForwardScan — see mesh-auto-ff-remote-nodes.test.ts).
const continuousAutoFastForwardLastScan = continuousAutoFastForwardScanState;

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
// Sentinel thrown by withCallTimeout on expiry, distinguished from a real transport
// rejection so callers can log/backoff differently for "peer never answered" vs
// "peer answered with an error".
class AutoFastForwardCallTimeoutError extends Error {
    constructor(ms: number) {
        super(`auto fast-forward call timed out after ${ms}ms`);
        this.name = 'AutoFastForwardCallTimeoutError';
    }
}

/** Race a dispatchMeshCommand call against a fixed budget so a slow/degraded peer
 *  cannot stall the CALLER (the continuous scheduler tick) for other nodes. This
 *  does NOT cancel the underlying P2P request — dispatchMeshCommand has no cancel
 *  primitive at this layer — it only stops the SCANNER from waiting on it. A late
 *  reply after the timeout is simply discarded here. Used for the continuous scan's
 *  dry-run precheck; the idle-edge path and the TOCTOU execute keep the full
 *  transport timeout, since a mutating execute racing its own cancellation would be
 *  the wrong trade (better to wait than to risk a lease held past an abandoned
 *  await, though the lease is always released via `finally` regardless). */
function withCallTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AutoFastForwardCallTimeoutError(timeoutMs)), timeoutMs);
        if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function delegateRemoteAutoFastForward(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    node: any;
    daemonId: string;
    workspace: string;
    policy: { maxBehind?: number; requireCleanSubmodules: boolean };
    trigger: string;
    // Continuous scan only: bounds the dry-run round-trip so one slow peer cannot
    // stall the scanner for every OTHER node. Omitted (idle-edge path) = no timeout,
    // matching historical behavior exactly.
    dryRunTimeoutMs?: number;
}): Promise<{ outcome: 'executed' | 'available' | 'no_op' | 'skipped' | 'error' }> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return { outcome: 'skipped' };
    if (!acquireAutoFastForwardLease(args.workspace)) return { outcome: 'skipped' }; // another ff already mutating this workspace
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
        const dryRunCall = dispatchMeshCommand(args.daemonId, 'fast_forward_mesh_node', {
            ...baseArgs,
            execute: false,
            dryRun: true,
        }) as Promise<{ code?: string; allowed?: boolean; current?: any } | null>;
        const remoteDry = await (args.dryRunTimeoutMs ? withCallTimeout(dryRunCall, args.dryRunTimeoutMs) : dryRunCall);
        if (!dryRunSatisfiesAutoFastForwardPolicy(remoteDry, args.policy)) {
            // Whether the dry-run says "nothing to do" or "blocked by a real
            // condition" (dirty, over maxBehind, ahead>0, …), both back off the
            // scanner the same way — the policy gate itself already logs specifics
            // on the manual/idle paths, so this scan-scheduler layer only needs to
            // know "not eligible to execute right now".
            return { outcome: 'no_op' };
        }
        // Re-check eligibility right before mutating: a task may have been dispatched to
        // this node between the scan and now (busy → skip, not an error).
        if (nodeHasActiveMeshWork(components, args.meshId, args.nodeId)) return { outcome: 'skipped' };
        const executed = await dispatchMeshCommand(args.daemonId, 'fast_forward_mesh_node', {
            ...baseArgs,
            execute: true,
            dryRun: false,
        }) as { executed?: boolean; postStatus?: any; code?: string } | null;
        if (executed?.executed === true) {
            LOG.info('MeshFastForward', `Remote auto fast-forward executed for node ${args.nodeId} (daemon ${String(args.daemonId).slice(0, 12)}, trigger ${args.trigger})`);
            return { outcome: 'executed' };
        }
        return { outcome: 'available' };
    } catch (e: any) {
        const isTimeout = e instanceof AutoFastForwardCallTimeoutError;
        LOG.warn('MeshFastForward', `Remote auto fast-forward delegation failed for ${args.nodeId}: ${e?.message || e}`);
        return { outcome: isTimeout ? 'skipped' : 'error' };
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

// How stale a peer's last-reported git status may be before the cheap precheck
// below refuses to rely on it and falls through to a real P2P dry-run. Wider than
// the scan's own base interval so a node currently backed off (scanned less often
// than the base) doesn't force a dry-run purely because its cached status aged out
// between scans; narrower than the max backoff so a truly stale peer eventually
// gets a fresh dry-run regardless of what the cache claims.
const AUTO_FF_GIT_PRECHECK_MAX_AGE_MS = 15 * 60_000; // 15m

/**
 * Cheap "has the tracked ref moved?" precheck using data the daemon ALREADY has —
 * the coordinator-held git of the node (member-pushed, mesh-node-git-state.ts)
 * when present, else the peer's last-reported git status carried on the mesh
 * node object: `node.git` first, falling back to `node.cachedStatus.git` — the SAME precedence
 * `resolveEffectiveNodeGit` in mesh-node-identity.ts uses for node health, so this
 * precheck agrees with the rest of the mesh layer about which telemetry is "the
 * node's git status right now". No network call.
 *
 * Returns `true` only when the cached status POSITIVELY shows nothing to do: a
 * FRESH, RECENT upstream check with ahead=0 and behind=0 — the exact
 * fast_forward_available precondition already enforced by
 * dryRunSatisfiesAutoFastForwardPolicy, just read from cache instead of a live
 * dry-run. Any other case (stale/unchecked/unavailable status, missing counters,
 * or an actual ahead/behind) returns `false` so the caller falls through to the
 * real P2P dry-run — this precheck may only SKIP a call, never substitute a
 * positive "go ahead and ff" decision, so a false-negative here just costs one
 * extra (now-backed-off, not per-tick) dry-run rather than a missed fast-forward.
 */
function cachedGitStatusShowsNoMovement(node: any, nowMs: number, heldGit?: Record<string, unknown> | null): boolean {
    // The coordinator-HELD git (member pushes: upstream re-fetched every push
    // heartbeat) first — remote node records rarely carry git of their own, which
    // used to send every scan to a live P2P dry-run.
    const directGit = heldGit ? readObjectRecord(heldGit) : readObjectRecord(node?.git);
    const git = Object.keys(directGit).length > 0
        ? directGit
        : readObjectRecord(readObjectRecord(node?.cachedStatus).git);
    if (Object.keys(git).length === 0) return false;
    if (git.upstreamStatus !== 'fresh') return false;
    const fetchedAt = Number(git.upstreamFetchedAt);
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return false;
    if (nowMs - fetchedAt > AUTO_FF_GIT_PRECHECK_MAX_AGE_MS) return false;
    return git.ahead === 0 && git.behind === 0;
}

function autoFastForwardScanCooldownKey(meshId: string, nodeId: string): string {
    return `${meshId}:${nodeId}`;
}

/** Whether `key` is currently within its backoff window. Does not mutate state —
 *  separate from noteAutoFastForwardScanResult so a caller can check-then-conditionally-
 *  scan without prematurely consuming a state transition. */
function isAutoFastForwardScanBackedOff(key: string, nowMs: number): boolean {
    const state = continuousAutoFastForwardScanState.get(key);
    return !!state && nowMs < state.nextEligibleAtMs;
}

/** Record the outcome of a scan round for `key` and update its backoff step.
 *  no_op → grow the step (doubling, capped at the configured max); anything else
 *  (executed / available / skipped / error) → reset to the base interval. `skipped`
 *  resets rather than backs off deliberately: a skip (busy node, lease held, peer
 *  disconnected moments ago) is not evidence the upstream hasn't moved, so treating
 *  it as a no-op would silently extend staleness for a reason unrelated to git
 *  state. */
function noteAutoFastForwardScanResult(key: string, outcome: 'executed' | 'available' | 'no_op' | 'skipped' | 'error' | 'precheck_skip', nowMs: number): void {
    const baseMs = resolveAutoFastForwardScanBaseMs();
    const maxMs = resolveAutoFastForwardScanMaxMs();
    const prev = continuousAutoFastForwardScanState.get(key);
    if (outcome === 'no_op' || outcome === 'precheck_skip') {
        const nextStep = Math.min(maxMs, Math.max(baseMs, (prev?.currentStepMs ?? baseMs) * AUTO_FF_SCAN_BACKOFF_MULTIPLIER));
        continuousAutoFastForwardScanState.set(key, { nextEligibleAtMs: nowMs + nextStep, currentStepMs: nextStep });
        return;
    }
    continuousAutoFastForwardScanState.set(key, { nextEligibleAtMs: nowMs + baseMs, currentStepMs: baseMs });
}

/**
 * Continuous-mode remote auto fast-forward scan (mode:"continuous" only). Runs on
 * its OWN scheduler (startContinuousAutoFastForwardScheduler below) — NOT the 4s
 * reconcile tick; the tick never awaits this. Scans every connected, eligible,
 * non-worktree remote node of the given mesh and delegates an ff to its owning
 * daemon when it is online/clean/behind within policy. A per-node EXPONENTIAL
 * BACKOFF (grows on confirmed no-op, resets on real movement — see
 * noteAutoFastForwardScanResult) plus the workspace lease keep this from hammering
 * peers or racing an assignment.
 *
 * Before issuing a P2P dry-run, a cheap in-memory precheck
 * (cachedGitStatusShowsNoMovement) checks the peer's own last-reported git status
 * for a fresh, recent, ahead=0/behind=0 reading — if so, the round is treated as a
 * confirmed no-op WITHOUT a network call at all.
 *
 * Ephemeral worktree nodes are DELIBERATELY excluded from the continuous catch-up: a
 * Refinery worktree branch must not be silently advanced by a background scan (only its
 * own idle-edge ff, which the coordinator drives intentionally). Non-worktree base
 * nodes are the sole continuous target.
 *
 * Kept callable per-mesh (unchanged signature) for the existing regression suite
 * (mesh-auto-ff-remote-nodes.test.ts) and for the scheduler, which calls it once per
 * hosted mesh per scheduler tick.
 */
export async function runContinuousAutoFastForwardScan(components: DaemonComponents, mesh: any): Promise<void> {
    if (!components.dispatchMeshCommand) return; // standalone has no remote nodes to scan
    const policy = resolveAutoFastForwardPolicy(mesh);
    if (!policy.enabled || !policy.remoteNodes || policy.mode !== 'continuous') return;
    const meshId = readNonEmptyString(mesh?.id);
    if (!meshId) return;
    const nodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    const now = Date.now();
    const dryRunTimeoutMs = resolveAutoFastForwardCallTimeoutMs();
    // One node at a time (sequential, not Promise.all): this scan already runs off
    // the reconcile tick on its own cadence, so there is no per-tick deadline
    // forcing parallelism, and going one-at-a-time keeps concurrent P2P load
    // (and workspace-lease contention) bounded to whatever the caller's own
    // scheduler cadence allows rather than bursting every node in the mesh at once.
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
        const cooldownKey = autoFastForwardScanCooldownKey(meshId, nodeId);
        if (isAutoFastForwardScanBackedOff(cooldownKey, now)) continue;
        // Cheap precheck FIRST — no network call, no backoff-map write races with a
        // concurrent scan of the same key (there is none; this loop is sequential).
        const heldEntry = components.router?.meshNodeGitState?.get(meshId, nodeId);
        const heldGit = heldEntry?.git && heldEntry.unreachableSince === null ? heldEntry.git : null;
        if (cachedGitStatusShowsNoMovement(node, now, heldGit)) {
            noteAutoFastForwardScanResult(cooldownKey, 'precheck_skip', now);
            LOG.debug('MeshFastForward', `Continuous auto-ff precheck: ${nodeId} cached git status shows no movement — skipping dry-run`);
            continue;
        }
        const result = await delegateRemoteAutoFastForward(components, { meshId, nodeId, node, daemonId, workspace, policy, trigger: 'reconcile_auto', dryRunTimeoutMs });
        noteAutoFastForwardScanResult(cooldownKey, result.outcome, Date.now());
    }
}

interface AutoFastForwardSchedulerHandle {
    stop(): void;
}

/**
 * Start the continuous auto-fast-forward scan on its OWN timer — independent of,
 * and never awaited by, the 4s mesh reconcile tick (P6, 2026-09-23 IPC-load audit).
 * Runs `runContinuousAutoFastForwardScan` for every mesh this daemon hosts, at a
 * fixed poll cadence; the actual per-node work rate is governed by each node's own
 * backoff state (see noteAutoFastForwardScanResult), not by this timer's period —
 * the timer only needs to be at least as frequent as the SHORTEST possible backoff
 * step (the base interval) so a freshly-reset node is picked up promptly.
 *
 * `listMeshesFn` is injectable for tests; defaults to the real config reader.
 */
export function startContinuousAutoFastForwardScheduler(
    components: DaemonComponents,
    listMeshesFn: () => any[] = listMeshes,
): AutoFastForwardSchedulerHandle {
    let running = false;
    const pollMs = Math.max(1_000, Math.min(resolveAutoFastForwardScanBaseMs(), DEFAULT_AUTO_FF_SCAN_BASE_MS));
    const tick = () => {
        if (running) return; // never overlap scans
        running = true;
        void (async () => {
            try {
                const meshes = listMeshesFn();
                for (const mesh of meshes) {
                    try {
                        await runContinuousAutoFastForwardScan(components, mesh);
                    } catch (e: any) {
                        LOG.warn('MeshFastForward', `Continuous auto fast-forward scheduler failed for mesh ${mesh?.id}: ${e?.message || e}`);
                    }
                }
            } catch (e: any) {
                LOG.warn('MeshFastForward', `Continuous auto fast-forward scheduler tick failed: ${e?.message || e}`);
            } finally {
                running = false;
            }
        })();
    };
    const timer = setInterval(tick, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    return {
        stop() {
            clearInterval(timer);
        },
    };
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
    // C2 (wiring-unification): the markers are `turn.notify{mesh_event}` rows the
    // Refinery addressed to this daemon (the pending-events table is gone). A
    // marker is claimed only after its action ran; a busy node leaves it for a
    // later idle tick (the legacy re-queue).
    const runtime = meshNoticeRuntime.current();
    if (!runtime) return;
    let control: ReturnType<typeof runtime.controlNotices>;
    try {
        control = runtime.controlNotices(meshId, 'coordinator_catchup');
    } catch (e: any) {
        LOG.warn('MeshReconcile', `Coordinator-catchup read failed for mesh ${meshId}: ${e?.message || e}`);
        return;
    }
    if (control.notices.length === 0) return;
    for (const marker of control.notices) {
        const meta = marker.metadataEvent;
        const nodeId = readNonEmptyString(marker.nodeId) || readNonEmptyString(meta.nodeId as string);
        const workspace = readNonEmptyString(marker.workspace) || readNonEmptyString(meta.workspace as string);
        const baseBranch = readNonEmptyString(meta.baseBranch as string);
        if (!workspace) {
            control.take(marker);
            continue;
        }
        // Busy node → leave the marker and defer to the next idle tick (never
        // advance a base a session is actively working on).
        if (nodeId && nodeHasActiveMeshWork(components, meshId, nodeId)) continue;
        control.take(marker);
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