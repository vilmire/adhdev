import { useState, useCallback } from 'react'
import type { MeshReviewInboxItem } from '@adhdev/daemon-core'

export interface UseMeshReviewInboxOptions {
    primaryDaemonId: string
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

export function useMeshReviewInbox({ primaryDaemonId, sendCommand }: UseMeshReviewInboxOptions) {
    const [items, setItems] = useState<MeshReviewInboxItem[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [remoteNodesExcluded, setRemoteNodesExcluded] = useState(false)
    const [dismissedNodeIds, setDismissedNodeIds] = useState<Set<string>>(new Set())

    const loadInbox = useCallback(async (meshId: string) => {
        if (!primaryDaemonId || !meshId) { setItems([]); return }
        setLoading(true)
        setError(null)
        try {
            const res: any = await sendCommand(primaryDaemonId, 'get_mesh_review_inbox', { meshId })
            if (res?.success) {
                setItems(Array.isArray(res.inbox) ? res.inbox : [])
                setRemoteNodesExcluded(res.remoteNodesExcluded === true)
            } else {
                setError(res?.error || 'Failed to load review inbox')
                setItems([])
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to load review inbox')
            setItems([])
        } finally {
            setLoading(false)
        }
    }, [primaryDaemonId, sendCommand])

    const dismissItem = useCallback((nodeId: string) => {
        setDismissedNodeIds(prev => new Set([...prev, nodeId]))
    }, [])

    const visibleItems = items.filter(item => !dismissedNodeIds.has(item.nodeId))

    return {
        items: visibleItems,
        allItems: items,
        loading,
        error,
        remoteNodesExcluded,
        dismissedNodeIds,
        loadInbox,
        dismissItem,
    }
}
