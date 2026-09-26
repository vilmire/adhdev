// COORDINATOR-HELD NODE STATE — the small held-read primitive.
//
// ONE local IPC read of the coordinator daemon's held mesh view (`mesh_status`),
// plus the pure helpers that answer a node's runtime (sessions / build / upgrade
// marker) from it. Split out of mesh-status-held-git.ts so mesh-tools-internal.ts
// (ipcDispatchToRemoteAgent's session pick) can read held state without an
// import cycle: this module depends only on leaf helpers (mesh-session-helpers,
// mesh-tools-internal-core, mesh-node-identity, daemon-core) and TYPE-only
// imports of the MeshContext shape. mesh-status-held-git.ts re-exports every
// symbol here, so existing importers are unchanged.
//
// Owner principle (2026-09-26): clients only talk to the coordinator daemon,
// which holds every node's latest pushed state; nothing here probes a member.

import { meshNodeIdMatches } from '@adhdev/daemon-core';
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { IpcTransport } from '../transports/ipc.js';
import { unwrapCommandPayload } from './mesh-session-helpers.js';
import { classifyRemoteDelegateRelaySafety, extractDaemonBuildInfo } from './mesh-tools-internal-core.js';
import type { MeshUpgradeFailureSummary } from './mesh-tools-internal-core.js';
import { isLocalControlPlaneNode } from './mesh-node-identity.js';
import type { MeshContext } from './mesh-tools-internal.js';

export interface CoordinatorHeldNodeState {
    /** Daemon-rendered node status, keyed by nodeId. */
    byNodeId: Map<string, Record<string, any>>;
    /** Set when the coordinator daemon could not answer (IPC failure / error result). */
    error?: string;
    /** The daemon answered with held runtime for foreign-daemon nodes (`nodeRuntimeHeld`). */
    runtimeHeld?: boolean;
}

/** Where a node's sessions / build came from on this call. */
export interface HeldNodeRuntimeObservation {
    /** 'local_read' = the coordinator's own daemon, read directly; 'none' = nothing held yet (sessions unknown, not zero). */
    source: 'local_read' | 'member_push' | 'coordinator_probe' | 'none';
    observedAt: number | null;
    refreshing: boolean;
}

/** Same shape as collectLiveStatusProbe's result. */
export interface NodeStatusProbe {
    sessions: any[];
    daemonId?: string;
    daemonBuild?: { commit: string; commitShort: string; version: string; builtAt?: string; track: 'stable' | 'preview' | 'unknown' };
    upgradeFailure?: MeshUpgradeFailureSummary;
}

function readRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

/**
 * ONE local read of the coordinator daemon's held mesh view. Never probes a
 * remote node: the daemon's `mesh_status` answers from its node-git store and
 * only kicks (never awaits) background refreshes — the daemon has no path that
 * blocks a mesh_status read on peers.
 */
export async function readCoordinatorHeldNodeState(
    ctx: MeshContext,
    opts: { refresh?: boolean } = {},
): Promise<CoordinatorHeldNodeState> {
    const byNodeId = new Map<string, Record<string, any>>();
    let raw: any;
    try {
        raw = await ctx.transport.command('mesh_status', {
            meshId: ctx.mesh.id,
            ...(opts.refresh === true ? { refresh: true } : {}),
        });
    } catch (error: any) {
        return { byNodeId, error: error?.message || 'coordinator mesh_status read failed' };
    }
    const payload = unwrapCommandPayload(raw);
    const record = readRecord(payload) ?? readRecord(raw);
    if (!record || record.success === false) {
        return { byNodeId, error: typeof record?.error === 'string' ? record.error : 'coordinator mesh_status returned no node state' };
    }
    const nodes = Array.isArray(record.nodes) ? record.nodes : [];
    for (const node of nodes) {
        const status = readRecord(node);
        const nodeId = typeof status?.nodeId === 'string' ? status.nodeId : '';
        if (status && nodeId) byNodeId.set(nodeId, status);
    }
    return { byNodeId, ...(record.nodeRuntimeHeld === true ? { runtimeHeld: true } : {}) };
}

/**
 * Whether this node's runtime is answered from the coordinator-held state: the
 * daemon holds runtime (marker) and the node is served by another daemon — the
 * exact case in which the legacy path made a P2P get_status_metadata round trip
 * (commandForNode's remote branch).
 */
export function usesHeldNodeRuntime(ctx: MeshContext, node: LocalMeshNodeEntry, state: CoordinatorHeldNodeState): boolean {
    if (state.runtimeHeld !== true) return false;
    if (!(ctx.transport instanceof IpcTransport) || !node.daemonId) return false;
    return !isLocalControlPlaneNode(ctx, node);
}

/**
 * The held runtime as a status probe result — no transport call. A node with no
 * held runtime yet returns no sessions and `source: 'none'` (unknown, the
 * daemon's background refresh is kicked), never a live read.
 */
export function heldNodeStatusProbe(held: Record<string, any> | undefined): { probe: NodeStatusProbe; observation: HeldNodeRuntimeObservation } {
    const runtime = readRecord(held?.heldRuntime);
    const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const source = runtime?.source === 'member_push' || runtime?.source === 'coordinator_probe' ? runtime.source : 'none';
    const observation: HeldNodeRuntimeObservation = {
        source,
        observedAt: source === 'none' ? null : numberOrNull(runtime?.observedAt),
        refreshing: runtime?.refreshing === true,
    };
    if (!runtime || source === 'none') return { probe: { sessions: [] }, observation };
    const daemonBuild = extractDaemonBuildInfo({ daemonBuild: runtime.daemonBuild });
    const failure = readRecord(runtime.upgradeFailure);
    const targetVersion = typeof failure?.targetVersion === 'string' ? failure.targetVersion : undefined;
    const upgradeFailure: MeshUpgradeFailureSummary | undefined = failure
        ? {
            // The notice prose stays on the node (content-free push); the structured facts travel.
            summary: `Daemon upgrade${targetVersion ? ` to ${targetVersion}` : ''} failed on this node (rolled back); the full notice is on that node.`,
            ...(typeof failure.recordedAt === 'string' ? { recordedAt: failure.recordedAt } : {}),
            ...(targetVersion ? { targetVersion } : {}),
            noticePath: typeof failure.noticePath === 'string' ? failure.noticePath : '',
            logPath: typeof failure.logPath === 'string' ? failure.logPath : '',
        }
        : undefined;
    return {
        probe: {
            sessions: Array.isArray(runtime.sessions) ? runtime.sessions : [],
            ...(typeof runtime.daemonId === 'string' && runtime.daemonId ? { daemonId: runtime.daemonId } : {}),
            ...(daemonBuild ? { daemonBuild } : {}),
            ...(upgradeFailure ? { upgradeFailure } : {}),
        },
        observation,
    };
}

/** The daemon-rendered status for `node` (exact id, then canonical id-form match). */
export function findHeldNodeStatus(state: CoordinatorHeldNodeState, node: LocalMeshNodeEntry): Record<string, any> | undefined {
    const exact = state.byNodeId.get(node.id);
    if (exact) return exact;
    for (const [nodeId, status] of state.byNodeId) {
        if (meshNodeIdMatches(node as any, nodeId)) return status;
    }
    return undefined;
}

// Per-call held-state cache, keyed by MeshContext identity (a WeakMap) so
// concurrent tool calls against different contexts never share state, and a
// single tool call that inspects several nodes (or dispatches after a status
// read) issues the held `mesh_status` read at most once.
const holdStateCacheForCall = new WeakMap<MeshContext, Promise<CoordinatorHeldNodeState>>();

/**
 * ONE (cached-per-ctx) read of the coordinator daemon's held mesh view, shared
 * by every `readNodeRuntime` call against the same MeshContext within one tool
 * invocation. A caller that already has a `CoordinatorHeldNodeState` (e.g.
 * mesh_status, which reads it directly for other fields too) should NOT go
 * through this cache — pass it straight to `heldNodeStatusProbe`/
 * `findHeldNodeStatus` instead, as mesh_status already does.
 */
export function cachedHeldNodeState(ctx: MeshContext): Promise<CoordinatorHeldNodeState> {
    const cached = holdStateCacheForCall.get(ctx);
    if (cached) return cached;
    const promise = readCoordinatorHeldNodeState(ctx);
    holdStateCacheForCall.set(ctx, promise);
    // Evict once settled so a LATER, separate tool call against the same
    // long-lived MeshContext (the MCP process keeps one ctx across calls) does
    // not keep answering from an arbitrarily old snapshot — each call gets a
    // held-state read that is fresh as of that call's start, cached only for
    // the concurrent readers within it.
    promise.finally(() => {
        if (holdStateCacheForCall.get(ctx) === promise) holdStateCacheForCall.delete(ctx);
    });
    return promise;
}

/** Clears the per-call held-state cache — test-only (mirrors a fresh MCP call). */
export function __resetNodeRuntimeCacheForTest(ctx: MeshContext): void {
    holdStateCacheForCall.delete(ctx);
}

// ─── Remote dispatch session pick, held-first ───────────────────────────────
//
// ipcDispatchToRemoteAgent (mesh-tools-internal.ts) must pick / verify a
// session on a REMOTE node before sending `agent_command`. That used to be a raw
// per-dispatch `get_status_metadata` round trip to the member. The coordinator
// already holds the member's pushed runtime summary, so the pick reads it.
//
// FIDELITY: the pushed summary is an allow-list (daemon-core
// mesh-node-runtime-summary.ts). Since routing-stamp version 2 it carries every
// settings field the pick and the relay-safety check read — meshNodeFor /
// meshNodeId / launchedByCoordinator AND meshLastNodeId (the WTCLAIM sticky-node
// marker of a DETACHED session) and meshCoordinatorDaemonId (the relay anchor).
// With those stamps the held pick is the same decision a live read would make,
// so it is decisive — zero member calls.
//
// ONE live confirm survives only where the held data cannot answer:
//   - the held summary predates the v2 stamps (an older member: no
//     `sessionStampVersion`) — a detached session's ownership would fall back to
//     the permissive branch without meshLastNodeId, so only a node-stamped
//     session with a safe relay verdict is decisive there;
//   - an explicit session_id that is not in the held list (it may have been
//     launched after the last push).

/** Routing-stamp version the held summary must carry for a fully decisive pick. */
export const HELD_DISPATCH_MIN_SESSION_STAMP_VERSION = 2;

export interface HeldDispatchSessions {
    sessions: any[];
    /** The held summary carries the v2 routing stamps (meshLastNodeId / meshCoordinatorDaemonId). */
    stampsComplete: boolean;
}

/**
 * The node's held session list, or null when the coordinator holds nothing
 * usable for it (older daemon without `nodeRuntimeHeld`, a node served by the
 * coordinator's own daemon, a failed held read, or held source 'none').
 * Never calls a member.
 */
export async function readHeldDispatchSessions(ctx: MeshContext, node: LocalMeshNodeEntry): Promise<HeldDispatchSessions | null> {
    if (!(ctx.transport instanceof IpcTransport) || !node.daemonId || isLocalControlPlaneNode(ctx, node)) return null;
    const state = await cachedHeldNodeState(ctx);
    if (state.error || !usesHeldNodeRuntime(ctx, node, state)) return null;
    const heldStatus = findHeldNodeStatus(state, node);
    const held = heldNodeStatusProbe(heldStatus);
    if (held.observation.source === 'none') return null;
    const stampVersion = readRecord(heldStatus?.heldRuntime)?.sessionStampVersion;
    return {
        sessions: held.probe.sessions,
        stampsComplete: typeof stampVersion === 'number' && stampVersion >= HELD_DISPATCH_MIN_SESSION_STAMP_VERSION,
    };
}

/** A session whose ownership is stamped for a node (not a detached coordinator session). */
function hasNodeOwnershipStamp(session: any): boolean {
    const meshNodeFor = session?.settings?.meshNodeFor;
    return typeof meshNodeFor === 'string' && meshNodeFor.trim().length > 0;
}

/**
 * Whether a pick made from the HELD session list can be acted on without a live
 * confirm. `explicit` = the caller named a session (verify), otherwise auto-pick.
 * An auto-pick that found nothing is decisive (the dispatch goes sessionless and
 * the worker picks / creates the session in the node's workspace). An explicit
 * session missing from the held list is never decisive.
 */
export function isHeldDispatchPickDecisive(
    picked: any,
    args: { explicit: boolean; meshId: string; nodeId: string; coordinatorDaemonId: string; stampsComplete?: boolean },
): boolean {
    if (!picked) return !args.explicit;
    // Full-fidelity held record: the pick and its relay verdict (safe / self_heal /
    // unsafe_alias / missing_anchor) are exactly what a live read would decide.
    if (args.stampsComplete === true) return true;
    if (!hasNodeOwnershipStamp(picked)) return false;
    const safety = classifyRemoteDelegateRelaySafety(picked, args.meshId, args.nodeId, args.coordinatorDaemonId);
    return safety === 'safe' || safety === 'self_heal';
}
