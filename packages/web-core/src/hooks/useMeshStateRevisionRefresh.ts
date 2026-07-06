import { useEffect, useRef } from 'react'
import type { DaemonMetadataUpdate } from '@adhdev/daemon-core'
import { subscriptionManager } from '../managers/SubscriptionManager'

type UseMeshStateRevisionRefreshArgs = {
    /** Daemon IDs whose daemon.metadata pushes carry mesh revision counters. */
    daemonIds: string[]
    /** The mesh currently being viewed; only its revision advances trigger a refresh. */
    meshId: string | null
    sendData?: (daemonId: string, data: any) => boolean
    /**
     * Called (debounced by the caller if needed) when the daemon reports that the
     * viewed mesh's state advanced since we last saw it. The caller should do a
     * background SWR mesh_status refresh — keeping the current graph on screen.
     */
    onRevisionAdvance: () => void
}

/**
 * Event-driven replacement for the mesh graph's fixed-interval poll.
 *
 * The cloud daemon stamps a per-mesh `meshStateRevisions` counter into every
 * `daemon.metadata` push (bumped on onMeshStateChange). This hook subscribes to
 * that topic for the mesh's daemon(s), and whenever the counter for the VIEWED
 * mesh advances past what we last saw, fires `onRevisionAdvance` so the page can
 * refresh the aggregate mesh_status on demand. The client keeps a slow polling
 * fallback for daemons/builds that don't emit the field (revision stays absent →
 * this hook simply never fires).
 *
 * Reuses the same subscription key as useMeshGraphMetadataSubscription, so the
 * SubscriptionManager multiplexes both handlers onto one P2P subscription — no
 * extra transport cost.
 */
export function useMeshStateRevisionRefresh({
    daemonIds,
    meshId,
    sendData,
    onRevisionAdvance,
}: UseMeshStateRevisionRefreshArgs): void {
    // Last-seen revision per daemon for the active mesh. Reset when the mesh or the
    // daemon set changes so a mesh switch doesn't inherit a stale high-water mark.
    const lastSeenRef = useRef<Map<string, number>>(new Map())
    const onRevisionAdvanceRef = useRef(onRevisionAdvance)
    onRevisionAdvanceRef.current = onRevisionAdvance

    const daemonIdsKey = [...new Set(daemonIds.filter(Boolean))].sort().join(',')

    useEffect(() => {
        lastSeenRef.current = new Map()
    }, [daemonIdsKey, meshId])

    useEffect(() => {
        if (!meshId || !sendData) return
        const ids = [...new Set(daemonIds.filter(Boolean))]
        if (ids.length === 0) return

        const unsubscribes = ids.map(did => subscriptionManager.subscribe(
            { sendData },
            did,
            {
                type: 'subscribe',
                topic: 'daemon.metadata',
                key: `daemon:metadata:${did}`,
                params: { includeSessions: true },
            },
            (update: DaemonMetadataUpdate) => {
                if (update.topic !== 'daemon.metadata') return
                const revisions = update.meshStateRevisions
                if (!revisions) return
                // Prefer the exact mesh's counter; fall back to the shared '*' bucket
                // the daemon bumps when it couldn't attribute the change to a mesh.
                const next = revisions[meshId] ?? revisions['*']
                if (typeof next !== 'number') return
                const prev = lastSeenRef.current.get(did)
                lastSeenRef.current.set(did, next)
                // First observation seeds the baseline without firing (the initial
                // paint already loaded the graph). Only a genuine advance refreshes.
                if (prev !== undefined && next > prev) {
                    onRevisionAdvanceRef.current()
                }
            },
        ))
        return () => {
            for (const unsub of unsubscribes) unsub()
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [daemonIdsKey, meshId, sendData])
}
