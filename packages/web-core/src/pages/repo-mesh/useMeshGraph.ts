/**
 * useMeshGraph — mesh graph loading state and actions
 *
 * Manages loading of RepoMeshStatus for the graph view.
 */
import { useRef, useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import type { RepoMeshContextValue } from '../../context/RepoMeshContext'
import { buildMeshGraph, isMeshGraphStructurallyComplete } from '../../utils/mesh-visualization'

interface UseMeshGraphOptions {
    selectedMeshId: string | null
    loadMeshStatus: RepoMeshContextValue['loadMeshStatus']
    extractStatus: RepoMeshContextValue['extractStatus']
    normalizeNode?: RepoMeshContextValue['normalizeNode']
    /**
     * Cloud-only opt-in. When true, a structurally-incomplete snapshot (a peer
     * git/submodule report still pending) is NOT committed if a prior complete
     * graph already exists — instead the loader retains the last graph, flags
     * provenance 'settling', and schedules ONE settled background reload. This
     * avoids the sparse-graph flash seen when cloud aggregates over P2P peers.
     * Undefined (standalone) keeps the original commit-always behavior.
     */
    gateIncompleteGraph?: boolean
}

function readBootstrapFallback(response: unknown): boolean {
    if (!response || typeof response !== 'object') return false
    return (response as Record<string, unknown>)._bootstrapFallback === true
}

export function useMeshGraph({
    selectedMeshId,
    loadMeshStatus,
    extractStatus,
    normalizeNode,
    gateIncompleteGraph,
}: UseMeshGraphOptions) {
    const [meshGraphStatus, setMeshGraphStatus] = useState<RepoMeshStatus | null>(null)
    const [graphLoading, setGraphLoading] = useState(false)
    const [graphError, setGraphError] = useState<string | null>(null)
    const [graphProvenance, setGraphProvenance] = useState<'idle' | 'first_paint' | 'settling' | 'settled'>('idle')
    const [graphBootstrapFallback, setGraphBootstrapFallback] = useState(false)
    // Guards the gated settled reload so an incomplete snapshot can only trigger
    // one in-flight background retry, never a reload loop.
    const settledReloadInFlight = useRef(false)

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
            setGraphBootstrapFallback(readBootstrapFallback(response))
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
                // Cloud-only gate: keep the last complete graph instead of
                // flashing a sparse one while peer snapshots are still arriving.
                // Inert for standalone (flag unset) and for the first load (no
                // prior committed status — partial beats blank, the skeleton
                // already covers it). On a settled refresh we always commit so a
                // genuinely-offline peer never strands the user on a spinner.
                if (
                    gateIncompleteGraph
                    && !refresh
                    && meshGraphStatus !== null
                    && !isMeshGraphStructurallyComplete(buildMeshGraph(status))
                ) {
                    setGraphProvenance('settling')
                    if (!settledReloadInFlight.current) {
                        settledReloadInFlight.current = true
                        // Schedule ONE background settled reload. The loader's own
                        // settled retry profile waits for peer snapshots; if it
                        // returns complete it commits, if it's still incomplete the
                        // refresh path commits anyway (peer truly down).
                        void Promise.resolve()
                            .then(() => loadGraph(activeDaemonId, meshId, true))
                            .finally(() => {
                                settledReloadInFlight.current = false
                            })
                    }
                    return
                }
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
        graphBootstrapFallback,
        loadGraph,
    }
}
