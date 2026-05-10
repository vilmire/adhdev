/**
 * Mesh Sync — Sync local mesh config to/from cloud D1
 *
 * When cloud is available, this module pushes local mesh config
 * to the server and pulls remote meshes that were created from
 * other machines. The local ~/.adhdev/meshes.json remains the
 * canonical source; cloud is a persistence/relay layer.
 *
 * This is called lazily (not on daemon startup) — only when the
 * user explicitly opens the mesh page or runs `adhdev mesh sync`.
 */

import { listMeshes, getMesh, createMesh, deleteMesh, addNode, removeNode } from '../config/mesh-config.js';
import type { LocalMeshEntry, LocalMeshNodeEntry } from '../repo-mesh-types.js';

export interface MeshSyncTransport {
    /** GET /api/v1/repo-meshes */
    listRemoteMeshes(): Promise<{ meshes: RemoteMeshRecord[] }>;
    /** POST /api/v1/repo-meshes */
    createRemoteMesh(data: {
        name: string;
        repo_identity: string;
        repo_remote_url?: string;
        default_branch?: string;
        policy?: string;
    }): Promise<{ mesh: RemoteMeshRecord }>;
    /** DELETE /api/v1/repo-meshes/:id */
    deleteRemoteMesh(meshId: string): Promise<void>;
    /** POST /api/v1/repo-meshes/:id/ledger/sync */
    syncMeshLedger?(meshId: string, data: { newEntries: any[] }): Promise<{ missingEntries: any[] }>;
}

export interface RemoteMeshRecord {
    id: string;
    name: string;
    repo_identity: string;
    repo_remote_url: string | null;
    default_branch: string | null;
    policy: string;
    status: string;
    created_at: string;
    updated_at: string;
}

export interface MeshSyncResult {
    pushed: number;
    pulled: number;
    deleted: number;
    errors: string[];
}

/**
 * Push local meshes to cloud (upsert by repo_identity).
 * Pull remote meshes that don't exist locally.
 */
export async function syncMeshes(transport: MeshSyncTransport): Promise<MeshSyncResult> {
    const result: MeshSyncResult = { pushed: 0, pulled: 0, deleted: 0, errors: [] };

    let remoteMeshes: RemoteMeshRecord[];
    try {
        const res = await transport.listRemoteMeshes();
        remoteMeshes = res.meshes;
    } catch (e: any) {
        result.errors.push(`Failed to list remote meshes: ${e.message}`);
        return result;
    }

    const localMeshes = listMeshes();
    const remoteByIdentity = new Map(remoteMeshes.map(m => [m.repo_identity, m]));
    const localByIdentity = new Map(localMeshes.map(m => [m.repoIdentity, m]));

    // Push: local meshes not in cloud
    for (const local of localMeshes) {
        if (!remoteByIdentity.has(local.repoIdentity)) {
            try {
                await transport.createRemoteMesh({
                    name: local.name,
                    repo_identity: local.repoIdentity,
                    repo_remote_url: local.repoRemoteUrl,
                    default_branch: local.defaultBranch,
                    policy: JSON.stringify(local.policy),
                });
                result.pushed++;
            } catch (e: any) {
                result.errors.push(`Push failed for "${local.name}": ${e.message}`);
            }
        }
    }

    // Pull: remote meshes not in local
    for (const remote of remoteMeshes) {
        if (!localByIdentity.has(remote.repo_identity)) {
            try {
                let policy;
                try { policy = JSON.parse(remote.policy); } catch { policy = undefined; }
                createMesh({
                    name: remote.name,
                    repoIdentity: remote.repo_identity,
                    repoRemoteUrl: remote.repo_remote_url || undefined,
                    defaultBranch: remote.default_branch || undefined,
                    policy,
                });
                result.pulled++;
            } catch (e: any) {
                result.errors.push(`Pull failed for "${remote.name}": ${e.message}`);
            }
        }
    }

    // Sync ledgers for all local meshes if the transport supports it
    if (transport.syncMeshLedger) {
        for (const local of localMeshes) {
            try {
                await syncMeshLedger(local.id, transport);
            } catch (e: any) {
                result.errors.push(`Ledger sync failed for "${local.name}": ${e.message}`);
            }
        }
    }

    return result;
}

/**
 * Sync the task ledger for a specific mesh.
 */
export async function syncMeshLedger(meshId: string, transport: MeshSyncTransport): Promise<void> {
    if (!transport.syncMeshLedger) return;
    const { readLedgerEntries, appendRemoteLedgerEntries } = await import('./mesh-ledger.js');
    
    // Read all local entries (no tail)
    const localEntries = readLedgerEntries(meshId);
    
    // Send to cloud and get missing entries back
    const res = await transport.syncMeshLedger(meshId, { newEntries: localEntries });
    
    // Append any missing entries from the cloud
    if (res.missingEntries && res.missingEntries.length > 0) {
        appendRemoteLedgerEntries(meshId, res.missingEntries);
    }
}
