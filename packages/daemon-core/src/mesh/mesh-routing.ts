import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getActiveDirectDispatches } from './mesh-work-queue.js';
import { hasUnterminalDirectDispatchLedgerEntry } from './mesh-events-stale.js';
import { appendLedgerEntry, readLedgerEntries } from './mesh-ledger.js';
import { LOG } from '../logging/logger.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';

// ---------------------------------------------------------------------------
// R1: single-source coordinator routing resolution
//
// Worker→node→mesh→coordinator routing used to be reconstructed inline inside
// setupMeshEventForwarding by reading six settings "stamp" fields
// (meshNodeFor / meshNodeId / meshCoordinatorFor / meshCoordinatorDaemonId /
// meshCoordinatorNodeId / launchedByCoordinator) plus two ledger queries plus a
// workspace fallback, scattered across ~50 lines. Any missing stamp silently
// changed the routing decision (delegate dropped, mesh unresolved) — design
// vulnerability #2.
//
// resolveWorkerDelegateRouting() is the ONE place that interprets those inputs.
// The stamps are inputs *internal to this function*; no external branch reads
// them to make a routing decision. The forwarder consumes the typed result only.
// ---------------------------------------------------------------------------

export type WorkerDelegateRejectionReason =
    | 'not_cli'
    | 'no_workspace'
    | 'no_worker_envelope'
    | 'coordinator_not_dispatch_target'
    | 'mesh_unresolved';

export interface WorkerDelegateRouting {
    /** True when the source session is a mesh worker whose events must route to a coordinator. */
    isDelegate: boolean;
    /** Resolved mesh id (runtime stamp, direct-dispatch recovery, or workspace lookup). */
    meshId: string;
    /** Resolved node id within the mesh, or '' when it cannot be determined. */
    nodeId: string;
    /** Human-readable node label for the coordinator system message. */
    nodeLabel: string;
    /** Coordinator daemon anchor (prefixed id) when the worker carries one; '' otherwise. */
    coordinatorDaemonId: string;
    /** Source session workspace (best-effort; '' when the session/workspace is missing). */
    workspace: string;
    /** Source session id echoed back, so diagnostics can name the dropped event's origin. */
    sessionId: string;
    /** Why routing was rejected (isDelegate=false), for fail-loud diagnostics (R4). */
    rejectionReason?: WorkerDelegateRejectionReason;
}

interface ResolveDeps {
    /** Resolve a mesh by id (local config + inline cache). */
    getMeshById: (meshId: string) => any | undefined;
    /** Resolve a mesh by workspace path (cached repo lookup). */
    getMeshByWorkspace: (workspace: string) => any | undefined;
}

function readSettings(state: any): Record<string, unknown> {
    return state?.settings && typeof state.settings === 'object'
        ? state.settings as Record<string, unknown>
        : {};
}

/**
 * Resolve how a source CLI session's mesh events should route to a coordinator.
 *
 * This is the single authoritative interpretation of the worker envelope. It folds
 * together every signal that previously lived in inline branches:
 *  - runtime stamps (meshNodeFor / meshNodeId)
 *  - the coordinator anchor (meshCoordinatorDaemonId) and launch marker (launchedByCoordinator,
 *    meshCoordinatorNodeId) — any one proves delegation even if the node/mesh stamp was dropped
 *  - direct-dispatch recovery: a coordinator session that is itself a dispatch target
 *  - workspace→mesh fallback when no runtime mesh id survived
 *
 * Returns isDelegate=false (with a rejectionReason) instead of throwing, so the caller
 * can either ignore non-delegate events or surface a diagnostic.
 */
export function resolveWorkerDelegateRouting(
    components: DaemonComponents,
    instanceId: string,
    deps: ResolveDeps,
): WorkerDelegateRouting {
    const sessionId = readNonEmptyString(instanceId);
    let workspace = '';
    let coordinatorDaemonId = '';
    // Runtime node-id stamp, surfaced even on rejection so the unresolved-mesh fallback
    // forward can name the worker node for the coordinator.
    let runtimeNodeId = '';
    const reject = (rejectionReason: WorkerDelegateRejectionReason): WorkerDelegateRouting => ({
        isDelegate: false,
        meshId: '',
        nodeId: runtimeNodeId,
        nodeLabel: '',
        coordinatorDaemonId,
        workspace,
        sessionId,
        rejectionReason,
    });

    const sourceInstance = components.instanceManager.getInstance(instanceId);
    if (!sourceInstance || sourceInstance.category !== 'cli') return reject('not_cli');

    const state = sourceInstance.getState();
    workspace = readNonEmptyString(state.workspace);
    if (!workspace) return reject('no_workspace');

    const settings = readSettings(state);
    coordinatorDaemonId = readNonEmptyString(settings.meshCoordinatorDaemonId);
    runtimeNodeId = readNonEmptyString(settings.meshNodeId);

    // A coordinator session (meshCoordinatorFor set) is only treated as a worker delegate
    // when it is itself the target of an active direct dispatch — otherwise its own events
    // must not be routed back to a coordinator (it IS the coordinator).
    const coordinatorMeshId = readNonEmptyString(settings.meshCoordinatorFor);
    let meshIdFromDirectDispatch = '';
    if (coordinatorMeshId) {
        let hasActiveDispatch = false;
        try {
            hasActiveDispatch =
                getActiveDirectDispatches(coordinatorMeshId).some(d => d.sessionId === instanceId)
                || hasUnterminalDirectDispatchLedgerEntry(coordinatorMeshId, instanceId);
        } catch { /* best-effort */ }
        if (!hasActiveDispatch) return reject('coordinator_not_dispatch_target');
        meshIdFromDirectDispatch = coordinatorMeshId;
    }

    const meshIdFromRuntime = readNonEmptyString(settings.meshNodeFor) || meshIdFromDirectDispatch;

    // Worker-envelope proof of delegation. A worker can arrive carrying only the routing
    // anchor (meshCoordinatorDaemonId) without meshNodeFor — e.g. when the node/mesh stamp
    // was dropped on a direct dispatch or relaunch. Treat any envelope marker as proof and
    // recover the mesh id by workspace when the runtime id is absent.
    const hasWorkerEnvelope = Boolean(
        meshIdFromRuntime
        || settings.launchedByCoordinator
        || coordinatorDaemonId
        || readNonEmptyString(settings.meshCoordinatorNodeId),
    );
    if (!hasWorkerEnvelope) return reject('no_worker_envelope');

    const mesh = meshIdFromRuntime ? deps.getMeshById(meshIdFromRuntime) : deps.getMeshByWorkspace(workspace);
    const meshId = meshIdFromRuntime || readNonEmptyString(mesh?.id);
    if (!meshId) return reject('mesh_unresolved');

    // Node resolution authority: the runtime stamp (meshNodeId) is the worker's
    // own identity, set when the coordinator dispatched/launched it. Trust it FIRST,
    // matched against mesh.nodes with the 3-form normalizer (id / nodeId / node_id).
    // Workspace lookup is only a fallback for workers that never carried a node stamp.
    //
    // This is the P1 fix: a worktree clone and its base node can share the same
    // `workspace`, or a freshly-cloned node may not yet be in mesh.nodes — in either
    // case `.find(n => n.workspace === workspace)` would match the BASE node (or
    // undefined) and stamp the completion event with the wrong/absent nodeId, so the
    // event fails post-hoc node matching and the coordinator never sees the completion.
    // The stamped meshNodeId splits base vs worktree correctly even on shared workspace.
    const stampedNode = runtimeNodeId
        ? mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, runtimeNodeId))
        : undefined;
    const targetNode = stampedNode || mesh?.nodes?.find((n: any) => n.workspace === workspace);
    const nodeId = runtimeNodeId || readNonEmptyString(targetNode?.id);
    // Label off the resolved nodeId (which now prefers the stamp) so a node matched
    // by its `nodeId`/`node_id` form — where `targetNode.id` may be absent — never
    // renders as `Node 'undefined'`.
    const nodeLabel = nodeId
        ? `Node '${nodeId}'`
        : `Agent at ${workspace}`;

    return {
        isDelegate: true,
        meshId,
        nodeId,
        nodeLabel,
        coordinatorDaemonId,
        workspace,
        sessionId,
    };
}

// ---------------------------------------------------------------------------
// R4: fail-loud routing diagnostics
//
// A rejection is only worth surfacing when the session DID present a worker
// envelope but routing still couldn't complete (`mesh_unresolved`). Before R4
// that event was dropped silently — setupMeshEventForwarding returned, the
// completion never reached a coordinator and never landed in the pending queue,
// and there was no trace of why. The benign rejections (not_cli / no_workspace /
// no_worker_envelope / coordinator_not_dispatch_target) are ordinary non-delegate
// traffic and must NOT spam the ledger.
//
// The diagnostic is keyed under a single shared stream id so all unroutable drops
// across meshes are discoverable in one place (the dropped event has no resolvable
// mesh by definition). A short per-(session+event) dedup window keeps a chatty
// session from flooding the ledger.
// ---------------------------------------------------------------------------

/** Ledger stream that collects delivery_unroutable diagnostics (no real mesh id exists for them). */
export const UNROUTABLE_DIAGNOSTIC_STREAM = '__unroutable__';

const UNROUTABLE_DIAGNOSTIC_DEDUP_MS = 60 * 1000;
const recentUnroutableDiagnostics = new Map<string, number>();

export function __resetUnroutableDiagnosticsForTests(): void {
    recentUnroutableDiagnostics.clear();
}

/** True only for rejections that represent a silently-dropped delegate event worth a diagnostic. */
export function isUnroutableDelegateRejection(routing: WorkerDelegateRouting): boolean {
    return !routing.isDelegate && routing.rejectionReason === 'mesh_unresolved';
}

/**
 * R4: record that a worker event with a valid envelope could not be routed to a coordinator.
 * Writes a `delivery_unroutable` ledger entry (deduped within a short window) so operators see
 * WHY a completion never arrived instead of it vanishing. No-op for non-diagnostic rejections.
 */
export function recordUnroutableDelegateEvent(routing: WorkerDelegateRouting, eventName: string): boolean {
    if (!isUnroutableDelegateRejection(routing)) return false;

    const dedupKey = `${routing.sessionId}::${eventName}::${routing.workspace}`;
    const now = Date.now();
    const last = recentUnroutableDiagnostics.get(dedupKey);
    if (last !== undefined && now - last < UNROUTABLE_DIAGNOSTIC_DEDUP_MS) return false;
    recentUnroutableDiagnostics.set(dedupKey, now);
    // Opportunistic sweep so the map can't grow unbounded.
    if (recentUnroutableDiagnostics.size > 256) {
        for (const [key, ts] of recentUnroutableDiagnostics) {
            if (now - ts >= UNROUTABLE_DIAGNOSTIC_DEDUP_MS) recentUnroutableDiagnostics.delete(key);
        }
    }

    try {
        appendLedgerEntry(UNROUTABLE_DIAGNOSTIC_STREAM, {
            kind: 'delivery_unroutable',
            sessionId: routing.sessionId || undefined,
            payload: {
                event: eventName,
                reason: routing.rejectionReason,
                workspace: routing.workspace || undefined,
                coordinatorDaemonId: routing.coordinatorDaemonId || undefined,
                detail: 'Worker envelope was present but no mesh could be resolved; the event could not be routed to a coordinator.',
            },
        });
        LOG.warn('MeshEvents', `delivery_unroutable: ${eventName} from session ${routing.sessionId || '(unknown)'} at ${routing.workspace || '(no workspace)'} — envelope present but mesh unresolved`);
        return true;
    } catch (e: any) {
        LOG.warn('MeshEvents', `Failed to record delivery_unroutable diagnostic: ${e?.message || e}`);
        return false;
    }
}

export interface UnroutableDeliveryDiagnostic {
    timestamp: string;
    event: string;
    sessionId?: string;
    workspace?: string;
    coordinatorDaemonId?: string;
}

/**
 * R4 visibility: recent delivery_unroutable diagnostics, newest first. Surfaced in mesh_status
 * so an operator/coordinator can see that completions were dropped (envelope present, mesh
 * unresolved) rather than the drops being invisible in a ledger nobody reads. The diagnostics
 * live in a single shared stream because an unroutable event has no resolvable mesh.
 */
export function getRecentUnroutableDeliveries(opts?: { sinceMs?: number; limit?: number }): UnroutableDeliveryDiagnostic[] {
    const sinceMs = opts?.sinceMs ?? 60 * 60 * 1000; // last hour by default
    const limit = opts?.limit ?? 20;
    let entries: ReturnType<typeof readLedgerEntries>;
    try {
        entries = readLedgerEntries(UNROUTABLE_DIAGNOSTIC_STREAM, { kind: ['delivery_unroutable'], tail: 200 });
    } catch {
        return [];
    }
    const cutoff = Date.now() - sinceMs;
    const out: UnroutableDeliveryDiagnostic[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const ts = new Date(entry.timestamp).getTime();
        if (!Number.isNaN(ts) && ts < cutoff) continue;
        const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload as Record<string, unknown> : {};
        out.push({
            timestamp: entry.timestamp,
            event: readNonEmptyString(payload.event),
            sessionId: readNonEmptyString(entry.sessionId) || readNonEmptyString(payload.sessionId) || undefined,
            workspace: readNonEmptyString(payload.workspace) || undefined,
            coordinatorDaemonId: readNonEmptyString(payload.coordinatorDaemonId) || undefined,
        });
        if (out.length >= limit) break;
    }
    return out;
}
