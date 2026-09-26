/**
 * useMeshGraph — mesh graph loading state and actions
 *
 * Reads the selected mesh's RepoMeshStatus from the shared coordinator
 * mesh-status store (utils/coordinator-mesh-status-store.ts), the same holder
 * the dashboard graph dialog and the session info dialog read. `loadGraph`
 * asks the COORDINATOR daemon once — no retry/settle loop: node freshness is
 * reported by the coordinator per node (gitObservation / heldRuntime).
 */
import { useMemo, useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import type { RepoMeshContextValue } from '../../context/RepoMeshContext'
import {
    getCoordinatorMeshStatusSnapshot,
    loadCoordinatorMeshStatus,
    peekCoordinatorMeshStatus,
    primeCoordinatorMeshStatus,
} from '../../utils/coordinator-mesh-status-store'
import { useCoordinatorMeshStatusSnapshot } from '../../hooks/useCoordinatorMeshStatus'

interface UseMeshGraphOptions {
    selectedMeshId: string | null
    loadMeshStatus: RepoMeshContextValue['loadMeshStatus']
    extractStatus: RepoMeshContextValue['extractStatus']
    normalizeNode?: RepoMeshContextValue['normalizeNode']
}

function readBootstrapFallback(response: unknown): boolean {
    if (!response || typeof response !== 'object') return false
    return (response as Record<string, unknown>)._bootstrapFallback === true
}

/** Last-good status for a mesh from the shared store (survives route re-entry). */
export function getCachedMeshGraphStatus(meshId: string | null): RepoMeshStatus | null {
    return peekCoordinatorMeshStatus(meshId)
}

export function useMeshGraph({
    selectedMeshId,
    loadMeshStatus,
    extractStatus,
    normalizeNode,
}: UseMeshGraphOptions) {
    const snapshot = useCoordinatorMeshStatusSnapshot(selectedMeshId)
    const [graphError, setGraphError] = useState<string | null>(null)
    const [graphProvenance, setGraphProvenance] = useState<'idle' | 'first_paint' | 'settling' | 'settled'>('idle')

    const rawStatus = snapshot?.status ?? null
    // Platform node normalization is a VIEW over the shared status, so the store
    // keeps the coordinator's answer untouched for the other surfaces.
    const meshGraphStatus = useMemo<RepoMeshStatus | null>(() => {
        if (!rawStatus || !normalizeNode) return rawStatus
        return {
            ...rawStatus,
            nodes: (rawStatus.nodes ?? []).map((node: any) => normalizeNode(node, rawStatus.meshId ?? selectedMeshId ?? '', '')),
        }
    }, [rawStatus, normalizeNode, selectedMeshId])

    /** Overwrite the held status for the selected mesh (null clears it). */
    function setMeshGraphStatus(status: RepoMeshStatus | null) {
        if (!selectedMeshId) return
        primeCoordinatorMeshStatus(selectedMeshId, status, snapshot?.daemonId ?? null)
    }

    /**
     * Read the coordinator's mesh_status. `refresh` is true ONLY for an explicit
     * user action; every automatic trigger reads the coordinator's held answer.
     */
    async function loadGraph(activeDaemonId: string, meshId: string | null = selectedMeshId, refresh = false) {
        if (!activeDaemonId || !meshId) return
        setGraphError(null)
        setGraphProvenance(refresh ? 'settling' : 'first_paint')
        const status = await loadCoordinatorMeshStatus({
            meshId,
            daemonId: activeDaemonId,
            refresh,
            load: (daemonId, targetMeshId, options) => loadMeshStatus(daemonId, targetMeshId, { refresh: options.refresh }),
            extract: response => extractStatus(response),
        })
        if (status) {
            setGraphProvenance('settled')
        } else {
            setGraphError(getCoordinatorMeshStatusSnapshot(meshId)?.error || 'Failed to load mesh graph')
            setGraphProvenance('idle')
        }
    }

    return {
        meshGraphStatus,
        setMeshGraphStatus,
        graphLoading: !!snapshot?.loading && !rawStatus,
        graphError: graphError ?? (rawStatus ? null : snapshot?.error ?? null),
        setGraphError,
        graphProvenance,
        graphBootstrapFallback: readBootstrapFallback(snapshot?.response),
        loadGraph,
    }
}
