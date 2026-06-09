/**
 * StandaloneRepoMeshProvider
 *
 * Wraps the shared RepoMesh page with standalone-specific implementations:
 * - sendCommand / sendData from TransportContext
 * - single daemon from BaseDaemonContext
 * - direct mesh_status call (no retry)
 * - simple coordinator launch (meshId + cliType only)
 */
import { useMemo, type ReactNode } from 'react'
import { useTransport } from './TransportContext'
import { useBaseDaemons } from './BaseDaemonContext'
import { RepoMeshContext, STANDALONE_FEATURES, type RepoMeshContextValue, type RepoMeshDaemonEntry } from './RepoMeshContext'
import { extractRepoMeshStatus } from '../utils/repo-mesh-status'

export function StandaloneRepoMeshProvider({ children }: { children: ReactNode }) {
    const { sendCommand, sendData } = useTransport()
    const { ides } = useBaseDaemons()

    const daemons: RepoMeshDaemonEntry[] = useMemo(
        () => (ides as any[])
            .filter(d => d.daemonMode || d.type === 'adhdev-daemon')
            .map(d => d as RepoMeshDaemonEntry),
        [ides],
    )

    const value = useMemo<RepoMeshContextValue>(() => ({
        sendCommand,
        sendData,
        daemons,
        userName: undefined,

        loadMeshStatus: async (daemonId, meshId) => {
            return sendCommand(daemonId, 'mesh_status', { meshId })
        },

        launchCoordinator: async (daemonId, params) => {
            const payload: Record<string, unknown> = { meshId: params.meshId }
            if (params.cliType) payload.cliType = params.cliType
            const raw = await sendCommand(daemonId, 'launch_mesh_coordinator', payload)
            const res = raw?.result ?? raw
            if (res?.success === false) throw new Error(res.error || 'Coordinator launch failed')
            const sessionId = res?.sessionId || res?.session?.id || res?.targetSessionId
            return { sessionId, message: sessionId ? `Coordinator launched (${sessionId})` : 'Coordinator launch command sent' }
        },

        loadLiveMesh: undefined,

        extractStatus: extractRepoMeshStatus,

        unwrapResult: (raw: any) => raw,

        normalizeMesh: (raw: any, _sourceDaemonId: string) => raw,

        normalizeNode: (raw: any, _meshId: string, _sourceDaemonId: string) => raw,

        resolveCommandTarget: (daemonId) => ({ targetDaemonId: daemonId }),

        features: STANDALONE_FEATURES,
    }), [sendCommand, sendData, daemons])

    return <RepoMeshContext.Provider value={value}>{children}</RepoMeshContext.Provider>
}
