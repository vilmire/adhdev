/**
 * Member side, restart survival of the node-state push (mesh-node-state-pusher.ts).
 *
 * A member daemon's push subscriptions used to live in memory only: after a
 * restart (an upgrade by `mesh_restart_daemon`, a crash, a reboot) the member
 * stayed silent until the coordinator re-probed it, and the coordinator only
 * re-probes a member-pushed node once its held state is older than
 * MESH_NODE_STATE_STALE_MS — so for up to ten minutes the coordinator (and the
 * deploy verifier reading its mesh_status) reported the replaced build.
 *
 * Two inputs let a restarted member push at once, without being asked:
 *   1. the persisted subscription set (`<configDir>/mesh-node-push-subscriptions.json`):
 *      coordinator daemon id, mesh id, node id, workspace — identifiers and a
 *      local path only, never state;
 *   2. memberships derived from what the member already knows: its mesh host
 *      records (which daemon hosts a mesh — mesh-host-memory.ts) crossed with
 *      its config's nodes of that mesh that this daemon owns and whose
 *      workspace is on this machine.
 * The coordinator's owner gate (`mesh_node_git_report` → node_owner) still
 * decides; a report for a node it does not hold is refused and the member drops
 * that subscription.
 *
 * P2P only — this file never leaves the machine.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeMeshNodeId } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import type { MeshNodeStatePushPersistence, MeshNodeStatePushTarget } from './mesh-node-state-pusher.js';

const FILE_NAME = 'mesh-node-push-subscriptions.json';
/** Upper bound on persisted subscriptions (meshes cap at 10 nodes; a daemon serves a handful of meshes). */
export const MESH_NODE_PUSH_PERSIST_MAX = 64;

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readTarget(value: unknown): MeshNodeStatePushTarget | null {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!record) return null;
    const target = {
        coordinatorDaemonId: readString(record.coordinatorDaemonId),
        meshId: readString(record.meshId),
        nodeId: readString(record.nodeId),
        workspace: readString(record.workspace),
    };
    return target.coordinatorDaemonId && target.meshId && target.nodeId && target.workspace ? target : null;
}

/** File-backed persistence under the daemon config dir. Never throws. */
export function createFileMeshNodeStatePushPersistence(getDir: () => string = getConfigDir): MeshNodeStatePushPersistence {
    const filePath = () => join(getDir(), FILE_NAME);
    return {
        load() {
            try {
                const path = filePath();
                if (!existsSync(path)) return [];
                const parsed = JSON.parse(readFileSync(path, 'utf8'));
                const rows = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
                return rows.map(readTarget).filter((t: MeshNodeStatePushTarget | null): t is MeshNodeStatePushTarget => !!t)
                    .slice(0, MESH_NODE_PUSH_PERSIST_MAX);
            } catch {
                return [];
            }
        },
        save(targets) {
            try {
                const path = filePath();
                const rows = targets.map(readTarget).filter((t): t is MeshNodeStatePushTarget => !!t).slice(0, MESH_NODE_PUSH_PERSIST_MAX);
                const tmp = `${path}.${process.pid}.tmp`;
                writeFileSync(tmp, JSON.stringify({ version: 1, subscriptions: rows }, null, 2), 'utf8');
                renameSync(tmp, path);
            } catch { /* best-effort: the coordinator handshake still re-subscribes */ }
        },
    };
}

/**
 * Memberships this daemon can derive without anyone asking: for each mesh host
 * record naming ANOTHER daemon, the nodes of that mesh (config / inline view)
 * owned by this daemon whose workspace exists on this machine.
 */
export function deriveMemberPushTargets(args: {
    selfDaemonId: string | undefined;
    hostRecords: Array<{ meshId: string; hostDaemonId: string }>;
    getMeshNodes: (meshId: string) => unknown[];
    workspaceExists?: (workspace: string) => boolean;
}): MeshNodeStatePushTarget[] {
    const self = readString(args.selfDaemonId);
    if (!self) return [];
    const exists = args.workspaceExists ?? ((workspace: string) => {
        try { return existsSync(workspace); } catch { return false; }
    });
    const out: MeshNodeStatePushTarget[] = [];
    for (const record of args.hostRecords) {
        const meshId = readString(record?.meshId);
        const host = readString(record?.hostDaemonId);
        if (!meshId || !host || daemonIdsEquivalent(host, self)) continue;
        let nodes: unknown[] = [];
        try { nodes = args.getMeshNodes(meshId) ?? []; } catch { nodes = []; }
        for (const raw of nodes) {
            const node = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
            if (!node) continue;
            const daemonId = readString(node.daemonId);
            const nodeId = readString(normalizeMeshNodeId(node as any));
            const workspace = readString(node.workspace);
            if (!daemonId || !nodeId || !workspace || !daemonIdsEquivalent(daemonId, self)) continue;
            if (!exists(workspace)) continue;
            if (out.some((t) => t.meshId === meshId && meshNodeIdMatches({ id: t.nodeId }, nodeId))) continue;
            out.push({ coordinatorDaemonId: host, meshId, nodeId, workspace });
        }
    }
    return out;
}
