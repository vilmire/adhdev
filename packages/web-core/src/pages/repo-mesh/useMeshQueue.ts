/**
 * useMeshQueue — mesh task queue state and actions
 *
 * Handles both standalone (direct sendCommand) and cloud
 * (resolveCommandTarget + unwrapResult) queue loading.
 */
import { useState, useCallback } from 'react'
import type { RepoMeshContextValue } from '../../context/RepoMeshContext'
import type { MeshEntry, MeshQueueEntry, MeshQueueSummary } from './types'

interface UseMeshQueueOptions {
    primaryDaemonId: string
    activeDaemonId: string
    sendCommand: RepoMeshContextValue['sendCommand']
    unwrapResult: RepoMeshContextValue['unwrapResult']
    loadLiveMesh?: RepoMeshContextValue['loadLiveMesh']
    resolveCommandTarget: RepoMeshContextValue['resolveCommandTarget']
}

function buildQueueSummary(queue: MeshQueueEntry[]): MeshQueueSummary {
    const active = queue.filter(t => t.status === 'pending' || t.status === 'assigned')
    const historical = queue.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    return {
        active: active.length,
        historical: historical.length,
        activeCounts: {
            pending: active.filter(t => t.status === 'pending').length,
            assigned: active.filter(t => t.status === 'assigned').length,
        },
        historicalCounts: {
            completed: historical.filter(t => t.status === 'completed').length,
            failed: historical.filter(t => t.status === 'failed').length,
        },
        counts: {
            pending: queue.filter(t => t.status === 'pending').length,
            assigned: queue.filter(t => t.status === 'assigned').length,
            completed: queue.filter(t => t.status === 'completed').length,
            failed: queue.filter(t => t.status === 'failed').length,
        },
        staleAssignedCount: queue.filter(t => t.staleAssigned).length,
        recent: queue.slice(0, 20),
    }
}

export function useMeshQueue({
    primaryDaemonId,
    activeDaemonId,
    sendCommand,
    unwrapResult,
    loadLiveMesh,
    resolveCommandTarget,
}: UseMeshQueueOptions) {
    const [meshQueue, setMeshQueue] = useState<MeshQueueEntry[]>([])
    const [queueSummary, setQueueSummary] = useState<MeshQueueSummary | null>(null)
    const [queueLoading, setQueueLoading] = useState(false)
    const [queueError, setQueueError] = useState<string | null>(null)

    /**
     * Standalone path: simple direct load, sets meshQueue.
     */
    const loadQueue = useCallback(async (meshId: string | null) => {
        if (!primaryDaemonId || !meshId) { setMeshQueue([]); return }
        try {
            const res: any = await sendCommand(primaryDaemonId, 'get_mesh_queue', { meshId })
            setMeshQueue(res?.success ? (Array.isArray(res.queue) ? res.queue : []) : [])
        } catch { setMeshQueue([]) }
    }, [primaryDaemonId, sendCommand])

    /**
     * Cloud (on-demand) path: resolves command target, builds summary.
     */
    async function handleLoadQueue(selectedMesh: MeshEntry | null) {
        if (!selectedMesh) return
        setQueueLoading(true)
        setQueueError(null)
        try {
            const liveMesh = loadLiveMesh
                ? await loadLiveMesh(activeDaemonId, selectedMesh.id, selectedMesh)
                : null
            const target = resolveCommandTarget(activeDaemonId, selectedMesh.id, selectedMesh, selectedMesh.nodes || [], liveMesh)
            if ('error' in target) throw new Error(target.error)
            const raw = await sendCommand(target.targetDaemonId, 'get_mesh_queue', { meshId: selectedMesh.id })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Queue load failed')
            const queue: MeshQueueEntry[] = Array.isArray(result?.result?.rows ?? result?.rows ?? result?.queue)
                ? (result?.result?.rows ?? result?.rows ?? result?.queue)
                : []
            setQueueSummary(buildQueueSummary(queue))
        } catch (e: any) {
            setQueueError(e?.message || 'Queue load failed')
        } finally {
            setQueueLoading(false)
        }
    }

    return {
        meshQueue,
        setMeshQueue,
        queueSummary,
        queueLoading,
        queueError,
        loadQueue,
        handleLoadQueue,
    }
}
