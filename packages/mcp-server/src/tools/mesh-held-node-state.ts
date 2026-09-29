// NODE RUNTIME, answered by the COORDINATOR DAEMON only.
//
// Owner principle ④ (2026-09-26 / data-path audit 2026-09-29 P1-1): members push
// their state to the coordinator daemon, and tools ask only the coordinator. A
// node's runtime (sessions / daemon build / upgrade marker / provider catalog)
// therefore comes from exactly two coordinator reads, never from a member:
//   - a node served by the coordinator daemon itself → ONE local
//     `get_status_metadata` (the coordinator's own status);
//   - a node served by another daemon → the coordinator's held view
//     (`mesh_status`, node section): the runtime summary that member pushed,
//     stamped as `heldRuntime`. Nothing held yet = `source: 'none'` (unknown,
//     not zero) — the coordinator has already nudged the member to push.
// There is no live-probe fallback: a tool that cannot answer from the held
// state reports "not held yet" instead of reaching the member.
//
// This module depends only on leaf helpers so mesh-tools-internal.ts
// (ipcDispatchToRemoteAgent's session pick) can import it without a cycle.

import { meshNodeIdMatches } from '@adhdev/daemon-core';
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { extractStatusMetadataSessions, unwrapCommandPayload } from './mesh-session-helpers.js';
import { extractDaemonBuildInfo, extractUpgradeFailureSummary } from './mesh-tools-internal-core.js';
import type { MeshUpgradeFailureSummary } from './mesh-tools-internal-core.js';
import { isLocalControlPlaneNode } from './mesh-node-identity.js';
import type { MeshContext } from './mesh-tools-internal.js';
import { ensureMeshNodeRoutes, meshNodeRouteOf } from './mesh-node-routes.js';
import { readOptionalRecord } from '@adhdev/mesh-shared';

interface CoordinatorHeldNodeState {
    /** Daemon-rendered node status, keyed by nodeId. */
    byNodeId: Map<string, Record<string, any>>;
    /** Set when the coordinator daemon could not answer (IPC failure / error result). */
    error?: string;
}

/** Where a node's runtime came from on this call. */
interface HeldNodeRuntimeObservation {
    /** 'local_read' = the coordinator's own daemon; 'none' = nothing held yet (sessions unknown, not zero). */
    source: 'local_read' | 'member_push' | 'coordinator_probe' | 'none';
    observedAt: number | null;
    refreshing: boolean;
}

/** A node's runtime as the tools read it. */
interface NodeStatusProbe {
    sessions: any[];
    daemonId?: string;
    daemonBuild?: { commit: string; commitShort: string; version: string; builtAt?: string; track: 'stable' | 'preview' | 'unknown' };
    upgradeFailure?: MeshUpgradeFailureSummary;
    /** The node's provider catalog rows (type / category / installed / versions). */
    providers?: any[];
    /** When the coordinator built its own status (its `status.timestamp`) — local reads only. */
    observedAt?: number;
}

interface NodeRuntimeResult {
    probe: NodeStatusProbe;
    observation: HeldNodeRuntimeObservation;
    /** 'local' = the coordinator's own status; 'held' = a member's pushed runtime. */
    source: 'local' | 'held';
    /** False when the coordinator could not answer (its own status read failed / nothing held). */
    known: boolean;
}

/**
 * ONE local read of the coordinator daemon's held mesh view (node section).
 * Never probes a remote node: the daemon's `mesh_status` answers from its
 * node-state store and only kicks (never awaits) member nudges.
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
            // Only the node section: the whole dashboard payload is ~97% queue rows.
            sections: ['nodes'],
            ...(opts.refresh === true ? { refresh: true } : {}),
        });
    } catch (error: any) {
        return { byNodeId, error: error?.message || 'coordinator mesh_status read failed' };
    }
    return parseCoordinatorHeldNodeState(raw);
}

/** The node section of a coordinator `mesh_status` answer, keyed by node id. */
export function parseCoordinatorHeldNodeState(raw: unknown): CoordinatorHeldNodeState {
    const byNodeId = new Map<string, Record<string, any>>();
    const record = readOptionalRecord(unwrapCommandPayload(raw)) ?? readOptionalRecord(raw);
    if (!record || record.success === false) {
        return { byNodeId, error: typeof record?.error === 'string' ? record.error : 'coordinator mesh_status returned no node state' };
    }
    for (const node of Array.isArray(record.nodes) ? record.nodes : []) {
        const status = readOptionalRecord(node);
        const nodeId = typeof status?.nodeId === 'string' ? status.nodeId : '';
        if (status && nodeId) byNodeId.set(nodeId, status);
    }
    return { byNodeId };
}

/**
 * Whether the coordinator daemon itself serves this node's runtime (its own
 * status answers it). A checkout on the coordinator's machine that ANOTHER
 * daemon serves (stable + preview side by side) is that daemon's runtime —
 * held, like any other member's.
 */
export function isCoordinatorServedNode(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    if (!isLocalControlPlaneNode(ctx, node)) return false;
    return meshNodeRouteOf(ctx, node)?.reason !== 'checkout_on_this_machine';
}

/** The coordinator's own status as a node runtime. */
export function localStatusProbe(localStatus: unknown): NodeStatusProbe | null {
    if (!readOptionalRecord(localStatus) || (localStatus as any).success === false) return null;
    const payload = unwrapCommandPayload(localStatus);
    const daemonId = typeof payload?.status?.instanceId === 'string' ? payload.status.instanceId.trim() : '';
    const daemonBuild = extractDaemonBuildInfo(localStatus);
    const upgradeFailure = extractUpgradeFailureSummary(localStatus);
    const providers = payload?.status?.availableProviders ?? payload?.availableProviders;
    const observedAt = payload?.status?.timestamp;
    return {
        sessions: extractStatusMetadataSessions(localStatus),
        ...(typeof observedAt === 'number' && Number.isFinite(observedAt) ? { observedAt } : {}),
        ...(daemonId ? { daemonId } : {}),
        ...(daemonBuild ? { daemonBuild } : {}),
        ...(upgradeFailure ? { upgradeFailure } : {}),
        ...(Array.isArray(providers) ? { providers } : {}),
    };
}

/**
 * The held runtime as a node runtime — no transport call. A node with no held
 * runtime yet returns no sessions and `source: 'none'` (unknown), never a live read.
 */
export function heldNodeStatusProbe(held: Record<string, any> | undefined): { probe: NodeStatusProbe; observation: HeldNodeRuntimeObservation } {
    const runtime = readOptionalRecord(held?.heldRuntime);
    const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const source = runtime?.source === 'member_push' || runtime?.source === 'coordinator_probe' ? runtime.source : 'none';
    const observation: HeldNodeRuntimeObservation = {
        source,
        observedAt: source === 'none' ? null : numberOrNull(runtime?.observedAt),
        refreshing: runtime?.refreshing === true,
    };
    if (!runtime || source === 'none') return { probe: { sessions: [] }, observation };
    const daemonBuild = extractDaemonBuildInfo({ daemonBuild: runtime.daemonBuild });
    const failure = readOptionalRecord(runtime.upgradeFailure);
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
            ...(Array.isArray(runtime.providers) ? { providers: runtime.providers } : {}),
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

/**
 * The runtime of `node` from ONE pair of coordinator answers (its own status +
 * its held view). Pure — mesh_status renders with it from the composed view.
 */
export function resolveNodeRuntime(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    answers: { local: NodeStatusProbe | null; held: CoordinatorHeldNodeState | null },
): NodeRuntimeResult {
    if (isCoordinatorServedNode(ctx, node)) {
        return {
            probe: answers.local ?? { sessions: [] },
            observation: { source: 'local_read', observedAt: answers.local?.observedAt ?? null, refreshing: false },
            source: 'local',
            known: !!answers.local,
        };
    }
    const held = heldNodeStatusProbe(answers.held ? findHeldNodeStatus(answers.held, node) : undefined);
    return { probe: held.probe, observation: held.observation, source: 'held', known: held.observation.source !== 'none' };
}

// Per-call caches keyed by MeshContext identity (a WeakMap): one tool call that
// inspects several nodes issues each coordinator read at most once, and a later
// call gets reads fresh as of its own start (entries evict once settled).
const heldStateForCall = new WeakMap<MeshContext, Promise<CoordinatorHeldNodeState>>();
const localStatusForCall = new WeakMap<MeshContext, Promise<NodeStatusProbe | null>>();

function sharedForCall<T>(cache: WeakMap<MeshContext, Promise<T>>, ctx: MeshContext, read: () => Promise<T>): Promise<T> {
    const cached = cache.get(ctx);
    if (cached) return cached;
    const promise = read();
    cache.set(ctx, promise);
    promise.finally(() => {
        if (cache.get(ctx) === promise) cache.delete(ctx);
    }).catch(() => { /* the read itself never rejects */ });
    return promise;
}

/** ONE (per-call shared) read of the coordinator daemon's held node view. */
export function cachedHeldNodeState(ctx: MeshContext, opts: { refresh?: boolean } = {}): Promise<CoordinatorHeldNodeState> {
    return sharedForCall(heldStateForCall, ctx, () => readCoordinatorHeldNodeState(ctx, opts));
}

/** ONE (per-call shared) read of the coordinator daemon's own status. */
function cachedLocalStatus(ctx: MeshContext): Promise<NodeStatusProbe | null> {
    return sharedForCall(localStatusForCall, ctx, async () => {
        try {
            return localStatusProbe(await ctx.transport.command('get_status_metadata', {}));
        } catch {
            return null;
        }
    });
}

/**
 * THE entry point for a node's runtime. Asks only the coordinator daemon; never
 * throws (a failed read resolves to `known: false` with no sessions).
 */
export async function readNodeRuntime(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    opts: { refresh?: boolean } = {},
): Promise<NodeRuntimeResult> {
    await ensureMeshNodeRoutes(ctx);
    if (isCoordinatorServedNode(ctx, node)) {
        return resolveNodeRuntime(ctx, node, { local: await cachedLocalStatus(ctx), held: null });
    }
    return resolveNodeRuntime(ctx, node, { local: null, held: await cachedHeldNodeState(ctx, opts) });
}

/**
 * Every mesh node with its `sessions` replaced by the coordinator's answer and
 * `__liveProbeVerified` stamped when the answer is known (a confirmed-empty list
 * counts; "nothing held yet" never does — it is not evidence of absence).
 */
export async function collectMeshNodesWithRuntime(ctx: MeshContext, opts?: { refresh?: boolean }): Promise<any[]> {
    return Promise.all(ctx.mesh.nodes.map(async (node) => {
        const result = await readNodeRuntime(ctx, node as LocalMeshNodeEntry, opts);
        return result.known
            ? { ...node, sessions: result.probe.sessions, __liveProbeVerified: true }
            : { ...node, __liveProbeVerified: false };
    }));
}
