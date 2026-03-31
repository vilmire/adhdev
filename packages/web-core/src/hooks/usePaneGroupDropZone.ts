import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'

type DropAction = 'split-left' | 'merge' | 'split-right' | null

interface UsePaneGroupDropZoneOptions {
    conversations: ActiveConversation[]
    numGroups: number
    onMoveTab?: (tabKey: string, direction: 'left' | 'right' | 'split-left' | 'split-right') => void
    onReceiveTab?: (tabKey: string) => void
    onOwnTabDrop: (tabKey: string) => void
    onClearPreviewOrder: () => void
}

function canSplitIntoNewGroup(numGroups: number, onMoveTab?: UsePaneGroupDropZoneOptions['onMoveTab']) {
    return !!(numGroups < 4 && onMoveTab && window.innerWidth >= 768)
}

export function usePaneGroupDropZone({
    conversations,
    numGroups,
    onMoveTab,
    onReceiveTab,
    onOwnTabDrop,
    onClearPreviewOrder,
}: UsePaneGroupDropZoneOptions) {
    const dragCounter = useRef(0)
    const [dragOver, setDragOver] = useState(false)
    const [dropAction, setDropAction] = useState<DropAction>(null)

    const resetDragState = useCallback(() => {
        dragCounter.current = 0
        setDragOver(false)
        setDropAction(null)
    }, [])

    useEffect(() => {
        window.addEventListener('dragend', resetDragState)
        window.addEventListener('drop', resetDragState)
        return () => {
            window.removeEventListener('dragend', resetDragState)
            window.removeEventListener('drop', resetDragState)
        }
    }, [resetDragState])

    const handleDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes('text/tab-key')) return
        dragCounter.current += 1
        setDragOver(true)
    }, [])

    const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes('text/tab-key')) return

        event.preventDefault()
        if (!canSplitIntoNewGroup(numGroups, onMoveTab)) {
            setDropAction('merge')
            return
        }

        const rect = event.currentTarget.getBoundingClientRect()
        const localX = event.clientX - rect.left
        const third = rect.width / 3

        if (localX < third) setDropAction('split-left')
        else if (localX > third * 2) setDropAction('split-right')
        else setDropAction('merge')
    }, [numGroups, onMoveTab])

    const handleDragLeave = useCallback(() => {
        dragCounter.current -= 1
        if (dragCounter.current > 0) return

        dragCounter.current = 0
        setDragOver(false)
        setDropAction(null)
    }, [])

    const handleDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
        dragCounter.current = 0
        setDragOver(false)

        const tabKey = event.dataTransfer.getData('text/tab-key')
        const isOwnTab = tabKey ? conversations.some(conversation => conversation.tabKey === tabKey) : false
        const nextDropAction = dropAction

        setDropAction(null)
        onClearPreviewOrder()

        if (!tabKey) return

        event.preventDefault()
        if (nextDropAction === 'split-left' && canSplitIntoNewGroup(numGroups, onMoveTab)) {
            onMoveTab?.(tabKey, 'split-left')
            return
        }
        if (nextDropAction === 'split-right' && canSplitIntoNewGroup(numGroups, onMoveTab)) {
            onMoveTab?.(tabKey, 'split-right')
            return
        }

        if (isOwnTab) {
            onOwnTabDrop(tabKey)
            return
        }

        onReceiveTab?.(tabKey)
    }, [conversations, dropAction, numGroups, onMoveTab, onReceiveTab, onOwnTabDrop, onClearPreviewOrder])

    return {
        dragOver,
        dropAction,
        resetDragState,
        handleDragEnter,
        handleDragOver,
        handleDragLeave,
        handleDrop,
    }
}
