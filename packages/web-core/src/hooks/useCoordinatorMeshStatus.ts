/**
 * React bindings for the shared coordinator mesh-status store
 * (utils/coordinator-mesh-status-store.ts).
 *
 * `useCoordinatorMeshStatusSnapshot` only reads. `useCoordinatorMeshStatus`
 * also drives reads, with exactly these triggers:
 *   - mount / mesh or coordinator change → refresh:false
 *   - the coordinator's mesh revision advancing → refresh:false
 *   - a slow backstop tick (visible tab only) → refresh:false
 *   - `refresh()` (an explicit user click) → refresh:true
 * No retry loops: node freshness is reported by the coordinator itself
 * (gitObservation / heldRuntime age + refreshing), not chased from the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import {
    getCoordinatorMeshStatusSnapshot,
    loadCoordinatorMeshStatus,
    subscribeCoordinatorMeshStatus,
    type CoordinatorMeshStatusLoader,
    type CoordinatorMeshStatusSnapshot,
} from '../utils/coordinator-mesh-status-store'
import { useMeshStateRevisionRefresh } from './useMeshStateRevisionRefresh'

const noopSubscribe = () => () => {}

export function useCoordinatorMeshStatusSnapshot(meshId: string | null | undefined): CoordinatorMeshStatusSnapshot | null {
    const subscribe = useCallback(
        (listener: () => void) => (meshId ? subscribeCoordinatorMeshStatus(meshId, listener) : noopSubscribe()),
        [meshId],
    )
    const getSnapshot = useCallback(() => getCoordinatorMeshStatusSnapshot(meshId), [meshId])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Default slow backstop for surfaces that also receive revision pushes. */
export const COORDINATOR_MESH_STATUS_BACKSTOP_MS = 60_000

export interface UseCoordinatorMeshStatusArgs {
    meshId: string | null
    /** The mesh's coordinator daemon; nothing is read without one. */
    daemonId: string | null
    load: CoordinatorMeshStatusLoader | null
    extract?: (response: unknown) => RepoMeshStatus | null
    sendData?: (daemonId: string, data: any) => boolean
    backstopMs?: number
}

export function useCoordinatorMeshStatus({
    meshId,
    daemonId,
    load,
    extract,
    sendData,
    backstopMs = COORDINATOR_MESH_STATUS_BACKSTOP_MS,
}: UseCoordinatorMeshStatusArgs) {
    const snapshot = useCoordinatorMeshStatusSnapshot(meshId)
    const loadRef = useRef(load)
    loadRef.current = load
    const extractRef = useRef(extract)
    extractRef.current = extract

    const read = useCallback((refresh: boolean) => {
        const loader = loadRef.current
        if (!meshId || !daemonId || !loader) return Promise.resolve(null)
        return loadCoordinatorMeshStatus({ meshId, daemonId, refresh, load: loader, extract: extractRef.current })
    }, [meshId, daemonId])

    useEffect(() => {
        void read(false)
    }, [read])

    useMeshStateRevisionRefresh({
        daemonIds: useMemo(() => (daemonId ? [daemonId] : []), [daemonId]),
        meshId,
        sendData,
        onRevisionAdvance: () => {
            if (typeof document !== 'undefined' && document.hidden) return
            void read(false)
        },
    })

    useEffect(() => {
        if (!meshId || !daemonId || backstopMs <= 0) return
        const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return
            void read(false)
        }, backstopMs)
        return () => clearInterval(timer)
    }, [meshId, daemonId, backstopMs, read])

    const refresh = useCallback(() => read(true), [read])
    const reload = useCallback(() => read(false), [read])

    return {
        status: snapshot?.status ?? null,
        loading: snapshot?.loading ?? false,
        refreshing: snapshot?.refreshing ?? false,
        error: snapshot?.error ?? null,
        loadedAt: snapshot?.loadedAt ?? null,
        refresh,
        reload,
    }
}
