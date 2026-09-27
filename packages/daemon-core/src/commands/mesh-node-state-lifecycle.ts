/**
 * Daemon lifecycle edges of the coordinator-held node state
 * (mesh/mesh-node-git-state.ts), so a member's restart or reconnect reaches the
 * coordinator within seconds — without polling and without waiting for the held
 * observation to age past MESH_NODE_STATE_STALE_MS (rc.61 live regression: three
 * members upgraded by mesh_restart_daemon kept reporting their previous build
 * for 7+ minutes).
 *
 * Member side
 *   - boot (`restoreMemberNodeStatePush`): restore the persisted push
 *     subscriptions plus memberships derived from mesh host records / config,
 *     then push once the mesh transport is up;
 *   - a peer link to a coordinator opens: push to it now.
 * Coordinator side
 *   - a member daemon's link (re)opens (`handshakeMeshMemberDaemon`, reason
 *     `reconnect`): mark its held entries handshake-pending and nudge each node,
 *     falling back to the handshake probe for a member that is not subscribed
 *     or too old to know the nudge (mixed-version fleets);
 *   - this coordinator restarts / upgrades a member (`mesh_restart_daemon`,
 *     reason `restart`): mark its held entries pending so the next report — from
 *     the NEW process — is taken at once and the held build is not served as
 *     live meanwhile; the member's own boot push and the reconnect handshake
 *     then land it.
 * All of it is event-driven: nothing here starts a timer.
 */
import { getMachineId } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import type { MeshNodeGitStateStore, MeshNodeHandshakeReason } from '../mesh/mesh-node-git-state.js';
import type { MeshNodeGitRefresher } from '../mesh/mesh-node-git-refresher.js';
import type { MeshNodeStatePusher } from '../mesh/mesh-node-state-pusher.js';
import { deriveMemberPushTargets } from '../mesh/mesh-node-state-push-store.js';
import { collectHeldDaemonNodeTargets } from './high-family/mesh-status-node-state.js';

export interface MeshNodeStateLifecyclePort {
    selfDaemonId: string | undefined;
    store: MeshNodeGitStateStore;
    refresher: MeshNodeGitRefresher;
    pusher: MeshNodeStatePusher;
    /** Every mesh this daemon knows (inline view ∪ config). */
    listKnownMeshes(): Promise<any[]>;
    /** Persisted mesh host records (meshId → host daemon). */
    listMeshHostRecords(): Array<{ meshId: string; hostDaemonId: string }>;
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Coordinator side: handshake every held node of member daemon `daemonId`.
 * `restart` only marks (the member is going down; its new process reports on
 * boot / reconnect); `reconnect` marks and nudges now. Returns how many nodes
 * were marked.
 */
export async function handshakeMeshMemberDaemon(
    port: MeshNodeStateLifecyclePort,
    daemonId: string,
    reason: MeshNodeHandshakeReason,
): Promise<number> {
    const wanted = readString(daemonId);
    if (!wanted) return 0;
    let meshes: any[] = [];
    try { meshes = await port.listKnownMeshes(); } catch { meshes = []; }
    const locality = { localMachineId: getMachineId() || '', localDaemonId: port.selfDaemonId };
    let marked = 0;
    for (const mesh of meshes) {
        const meshId = readString(mesh?.id);
        if (!meshId) continue;
        const targets = collectHeldDaemonNodeTargets({ meshId, mesh, daemonId: wanted, store: port.store, locality });
        if (targets.length === 0) continue;
        for (const target of targets) if (port.store.markHandshakePending(meshId, target.nodeId, reason)) marked += 1;
        if (reason === 'reconnect') port.refresher.handshakeDaemon(meshId, targets[0].daemonId, targets);
    }
    if (marked > 0) {
        LOG.info('MeshNodeState', `member daemon ${wanted.slice(0, 16)} ${reason === 'restart' ? 'restarting' : 'reconnected'} — ${marked} held node(s) marked for handshake`);
    }
    return marked;
}

/**
 * Member side, boot: restore the persisted push subscriptions plus memberships
 * derived from mesh host records × this daemon's own nodes. Returns how many
 * were added (not pushed — the caller pushes once the transport is up).
 */
export async function restoreMemberNodeStatePush(port: MeshNodeStateLifecyclePort): Promise<number> {
    let meshes: any[] = [];
    try { meshes = await port.listKnownMeshes(); } catch { meshes = []; }
    const byId = new Map<string, any>();
    for (const mesh of meshes) {
        const id = readString(mesh?.id);
        if (id && !byId.has(id)) byId.set(id, mesh);
    }
    let hostRecords: Array<{ meshId: string; hostDaemonId: string }> = [];
    try { hostRecords = port.listMeshHostRecords(); } catch { hostRecords = []; }
    const derived = deriveMemberPushTargets({
        selfDaemonId: port.selfDaemonId,
        hostRecords,
        getMeshNodes: (meshId) => (Array.isArray(byId.get(meshId)?.nodes) ? byId.get(meshId).nodes : []),
    });
    return port.pusher.restore(derived, { selfDaemonId: port.selfDaemonId });
}
