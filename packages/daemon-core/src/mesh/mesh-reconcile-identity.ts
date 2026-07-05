// ---------------------------------------------------------------------------
// mesh-reconcile-identity — daemon-id / self-identity resolution for the reconcile loop
// ---------------------------------------------------------------------------
// Pure move out of mesh-reconcile-loop.ts (no behavior change). This is the single
// source of truth for "which id-forms does THIS daemon answer to?" across both the
// coordinator-daemon drain scope and the per-mesh host gate / remote pull filter.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { loadConfig } from '../config/config.js';
import { expandDaemonIdForms, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';

// The set of coordinator-daemon ids THIS daemon answers to when draining the
// pending-events queue. A unicast completion event is stamped with the worker's
// meshCoordinatorDaemonId, which can be either:
//   - the daemon's canonical status id (`standalone_<machineId>` / `daemon_<machineId>`),
//     stamped by the MCP layer via ctx.localDaemonId (= getStatus().status.instanceId), or
//   - the bare machineId, stamped by the local queue-assignment path (loadConfig().machineId).
//   - the config-form node daemonId (`daemon_<machineId>`), which the MCP layer's
//     resolveCoordinatorDaemonId prefers and stamps onto direct-dispatch workers.
// Draining with only one of these silently misses events stamped with the other —
// the exact reason a generating coordinator never self-received local completions,
// and the base-node completion-surface bug (base completions land full-form
// `daemon_<machineId>` while a coordinator that only knows itself as bare
// `<machineId>` never matches them). We expand to EVERY equivalent form so the
// scope match (host gate, self-node detection, and the drain IN-filter downstream)
// succeeds regardless of which path stamped the event.
export function resolveCoordinatorDaemonIds(components: DaemonComponents): string[] {
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const machineId = readNonEmptyString(loadConfig().machineId);
    return expandDaemonIdForms([statusInstanceId, machineId]);
}

// Whether THIS daemon is the coordinator/host for a mesh — i.e. the daemon that
// owns coordinator ownership and must collect every worker node's completion
// events into its local queue. This is true regardless of whether a *live CLI*
// coordinator session currently exists: the coordinator is frequently a pure
// stdio MCP LLM (no live CLI session to inject into), and that LLM only sees the
// queue when it next calls a mesh tool. For it to see remote worker completions
// at all, the daemon must have already pulled them into the local queue on the
// timer — which is exactly what this predicate gates.
//
// Rule: this daemon hosts the mesh when meshHost.role is 'host' (the default for
// standalone-compat meshes with no host metadata) AND, when a hostDaemonId is
// pinned, it resolves to one of this daemon's ids. Member-only daemons return
// false — their own queue is pulled BY the host, not the other way around.
//
// `daemonIds` here is the EXPANDED self-identity set (runtime drain ids ∪ this
// daemon's mesh-config node id forms) — see resolveCoordinatorSelfIds. The
// pinned hostDaemonId is itself a config-form id and frequently does NOT equal a
// runtime id (bare machineId / status id), so gating on the runtime ids alone
// would wrongly classify the real host as a non-host and skip the remote pull
// entirely.
export function daemonHostsMesh(mesh: LocalMeshEntry, daemonIds: string[]): boolean {
    const host = mesh.meshHost;
    // No metadata → default host (standalone compatibility, see createDefaultMeshHostMetadata).
    if (!host) return true;
    if (host.role && host.role !== 'host') return false;
    const hostDaemonId = readNonEmptyString(host.hostDaemonId);
    // Host role but no pinned hostDaemonId → treat as host (single-daemon / legacy).
    if (!hostDaemonId) return true;
    return daemonIdListIncludes(daemonIds, hostDaemonId);
}

export function daemonIdListIncludes(ids: readonly string[], id: string | undefined): boolean {
    if (!id) return false;
    return ids.some(candidate => candidate === id || daemonIdsEquivalent(candidate, id));
}

// Resolve EVERY id-form this daemon answers to FOR A GIVEN MESH: the runtime drain
// ids (status id + bare machineId) unioned with this daemon's mesh-config identity
// forms — the self node's daemonId/machineId (the node whose daemonId/machineId
// matches a runtime id) and the pinned meshHost.hostDaemonId WHEN it is provably
// ours. This is the single source of truth for "is this id me?" across both the
// host gate and the remote pull filter; the worker's meshCoordinatorDaemonId stamp
// is guaranteed to be one of these forms (it comes from resolveCoordinatorDaemonId,
// which prefers the coordinator node's config-form daemonId over the runtime status id).
export function resolveCoordinatorSelfIds(mesh: LocalMeshEntry, drainDaemonIds: string[]): string[] {
    const ids = new Set<string>(drainDaemonIds);
    // Expand with the config-form id(s) of the self node — the mesh node whose
    // daemonId/machineId matches a runtime id. Its config-form daemonId is exactly
    // what resolveCoordinatorNode()→resolveCoordinatorDaemonId() stamps onto a worker.
    for (const node of mesh.nodes) {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        const nodeMachineId = readNonEmptyString(node.machineId);
        const isSelf = (nodeDaemonId && daemonIdListIncludes(drainDaemonIds, nodeDaemonId))
            || (nodeMachineId && daemonIdListIncludes(drainDaemonIds, nodeMachineId));
        if (!isSelf) continue;
        if (nodeDaemonId) ids.add(nodeDaemonId);
        if (nodeMachineId) ids.add(nodeMachineId);
    }
    // The pinned host id is included ONLY when it is provably one of THIS daemon's ids
    // (it already matches a runtime id or a resolved self-node id). A hostDaemonId that
    // names a DIFFERENT daemon must NOT be claimed — that would make a member-only
    // daemon believe it is the host and pull queues it does not own. Having a node on
    // this daemon does not make this daemon the host; daemonHostsMesh still honours a
    // foreign hostDaemonId and rejects ownership.
    const hostDaemonId = readNonEmptyString(mesh.meshHost?.hostDaemonId);
    if (hostDaemonId && daemonIdListIncludes([...ids], hostDaemonId)) ids.add(hostDaemonId);
    return [...ids];
}
