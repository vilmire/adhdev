/**
 * React bindings for the shared coordinator mesh-status store
 * (utils/coordinator-mesh-status-store.ts).
 *
 * `useCoordinatorMeshStatusSnapshot` only reads. `useCoordinatorMeshStatus`
 * also keeps the store current, with exactly these writers:
 *   - the coordinator's `mesh.status` push (snapshot on subscribe, keyed
 *     deltas after — useMeshStatusSubscription);
 *   - `refresh()` / `reload()` — an explicit user action only.
 * No polls, no backstop ticks, no retry loops: node freshness is reported by
 * the coordinator itself (gitObservation / heldRuntime age + refreshing).
 */
import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import {
    getCoordinatorMeshStatusSnapshot,
    loadCoordinatorMeshStatus,
    subscribeCoordinatorMeshStatus,
    type CoordinatorMeshStatusLoader,
    type CoordinatorMeshStatusSnapshot,
} from '../utils/coordinator-mesh-status-store'
import { useMeshStatusSubscription } from './useMeshStatusSubscription'

const noopSubscribe = () => () => {}

export function useCoordinatorMeshStatusSnapshot(meshId: string | null | undefined): CoordinatorMeshStatusSnapshot | null {
    const subscribe = useCallback(
        (listener: () => void) => (meshId ? subscribeCoordinatorMeshStatus(meshId, listener) : noopSubscribe()),
        [meshId],
    )
    const getSnapshot = useCallback(() => getCoordinatorMeshStatusSnapshot(meshId), [meshId])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export interface UseCoordinatorMeshStatusArgs {
    meshId: string | null
    /** The mesh's coordinator daemon; nothing is read without one. */
    daemonId: string | null
    load: CoordinatorMeshStatusLoader | null
    extract?: (response: unknown) => RepoMeshStatus | null
    sendData?: (daemonId: string, data: any) => boolean
}

export function useCoordinatorMeshStatus({
    meshId,
    daemonId,
    load,
    extract,
    sendData,
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

    useMeshStatusSubscription({ meshId, daemonId, sendData })

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
