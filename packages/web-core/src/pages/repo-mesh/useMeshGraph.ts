/**
 * useMeshGraph — mesh graph loading state and actions
 *
 * Manages loading of RepoMeshStatus for the graph view.
 */
import { useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import type { RepoMeshContextValue } from '../../context/RepoMeshContext'

interface UseMeshGraphOptions {
    selectedMeshId: string | null
    loadMeshStatus: RepoMeshContextValue['loadMeshStatus']
    extractStatus: RepoMeshContextValue['extractStatus']
    normalizeNode?: RepoMeshContextValue['normalizeNode']
}

export function useMeshGraph({
    selectedMeshId,
    loadMeshStatus,
    extractStatus,
    normalizeNode,
}: UseMeshGraphOptions) {
    const [meshGraphStatus, setMeshGraphStatus] = useState<RepoMeshStatus | null>(null)
    const [graphLoading, setGraphLoading] = useState(false)
    const [graphError, setGraphError] = useState<string | null>(null)
    const [graphProvenance, setGraphProvenance] = useState<'idle' | 'first_paint' | 'settling' | 'settled'>('idle')

    async function loadGraph(activeDaemonId: string, meshId: string | null = selectedMeshId, refresh = false) {
        if (!activeDaemonId || !meshId) return
        try {
            setGraphLoading(!refresh && meshGraphStatus === null)
            setGraphProvenance(refresh ? 'settling' : 'first_paint')
            setGraphError(null)
            const response = await loadMeshStatus(activeDaemonId, meshId, {
                refresh,
                retryProfile: refresh ? 'settled' : 'interactive',
            })
            const rawStatus = extractStatus(response)
            const status = normalizeNode && rawStatus
                ? {
                    ...rawStatus,
                    nodes: (rawStatus.nodes ?? []).map((node: any) =>
                        normalizeNode(node, rawStatus.meshId ?? meshId, '')
                    ),
                }
                : rawStatus
            if (status) {
                setMeshGraphStatus(status)
                setGraphProvenance('settled')
            } else {
                setMeshGraphStatus(null)
                setGraphError('mesh_status returned an unexpected payload.')
                setGraphProvenance('idle')
            }
        } catch (e: any) {
            if (!meshGraphStatus) setMeshGraphStatus(null)
            setGraphError(e?.message || 'Failed to load mesh graph')
            setGraphProvenance('idle')
        } finally {
            setGraphLoading(false)
        }
    }

    return {
        meshGraphStatus,
        setMeshGraphStatus,
        graphLoading,
        graphError,
        setGraphError,
        graphProvenance,
        loadGraph,
    }
}
