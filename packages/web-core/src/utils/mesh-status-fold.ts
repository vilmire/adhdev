/**
 * mesh-status-fold — materialize the `mesh.status` lane.
 *
 * The coordinator sends a snapshot of its held `mesh_status` first and then
 * keyed deltas (only the nodes / queue tasks / missions that changed — see
 * daemon-core's topic-registry and mesh-shared's keyed-doc-delta). Consumers
 * never handle a delta: SubscriptionManager folds each one into the held
 * snapshot here and delivers the materialized snapshot.
 *
 * Returns `null` when a delta cannot be applied — no held snapshot, or a seq
 * gap — so the caller re-subscribes (the daemon answers with a fresh snapshot).
 */
import type { MeshStatusSnapshotUpdate, MeshStatusWireUpdate } from '@adhdev/daemon-core'
import { foldKeyedDoc, MESH_STATUS_DOC_SPEC } from '@adhdev/mesh-shared'

export function materializeMeshStatusUpdate(
    held: MeshStatusSnapshotUpdate | undefined,
    update: MeshStatusWireUpdate,
): MeshStatusSnapshotUpdate | null {
    if (update.mode !== 'delta') return { ...update, mode: 'snapshot' }
    if (!held || !held.status) return null
    if (typeof held.seq === 'number' && update.seq !== held.seq + 1) return null
    return {
        topic: 'mesh.status',
        key: update.key,
        mode: 'snapshot',
        meshId: update.meshId || held.meshId,
        status: foldKeyedDoc(held.status, update.delta, MESH_STATUS_DOC_SPEC),
        seq: update.seq,
        timestamp: update.timestamp,
    }
}
