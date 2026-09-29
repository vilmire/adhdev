/**
 * useMeshStatusSubscription — the dashboard mesh view's ONE lane.
 *
 * Subscribes to the coordinator daemon's `mesh.status` topic for one mesh: the
 * daemon answers with a snapshot of its held `mesh_status` and afterwards
 * sends only keyed deltas (the nodes / queue tasks / missions that changed;
 * an unchanged mesh sends nothing). SubscriptionManager folds the deltas, and
 * every materialized status is committed to the shared coordinator mesh-status
 * store, which every mesh surface reads. Same contract on cloud (P2P) and
 * standalone (WS) — there is no poll and no revision-then-refetch round trip.
 */
import { useEffect } from 'react'
import type { MeshStatusSnapshotUpdate } from '@adhdev/daemon-core'
import { subscriptionManager } from '../managers/SubscriptionManager'
import { extractRepoMeshStatus } from '../utils/repo-mesh-status'
import {
    commitCoordinatorMeshStatusPush,
    markCoordinatorMeshStatusAwaitingPush,
} from '../utils/coordinator-mesh-status-store'

export function meshStatusSubscriptionKey(meshId: string): string {
    return `mesh:status:${meshId}`
}

export interface UseMeshStatusSubscriptionArgs {
    meshId: string | null | undefined
    /** The mesh's coordinator daemon (the one holding every node's state). */
    daemonId: string | null | undefined
    sendData?: (daemonId: string, data: any) => boolean
}

export function useMeshStatusSubscription({ meshId, daemonId, sendData }: UseMeshStatusSubscriptionArgs): void {
    useEffect(() => {
        if (!meshId || !daemonId || !sendData) return
        markCoordinatorMeshStatusAwaitingPush(meshId)
        return subscriptionManager.subscribe<MeshStatusSnapshotUpdate>(
            { sendData },
            daemonId,
            { type: 'subscribe', topic: 'mesh.status', key: meshStatusSubscriptionKey(meshId), params: { meshId } },
            (update) => {
                if (update.topic !== 'mesh.status' || update.meshId !== meshId) return
                const status = extractRepoMeshStatus(update.status)
                if (status) commitCoordinatorMeshStatusPush(meshId, status, daemonId)
            },
            { retryIntervalMs: 2_000 },
        )
    }, [meshId, daemonId, sendData])
}
