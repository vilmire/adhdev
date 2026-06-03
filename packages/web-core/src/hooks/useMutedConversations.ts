/**
 * useMutedConversations — device-local mute state for conversations.
 *
 * "Muted" means:
 *   - excluded from the attention/unread bucket on the inbox
 *   - no toast / notification / badge bump on new messages
 *   - the conversation is still visible in the chat list and openable
 *
 * Contrast with "hidden" (useHiddenTabs): hidden removes the conversation
 * from the inbox entirely; muted keeps it visible but silent.
 *
 * Coordinator-spawned mesh node sessions are auto-muted on first sight, so
 * the user only sees noise from conversations they actually started.
 *
 * Storage parallels useHiddenTabs: a Set<string> of conversation lookup keys
 * persisted to localStorage. We never sync this across devices.
 */
import { useState, useCallback } from 'react'
import type { ConversationTarget } from '../components/dashboard/conversation-identity'
import { buildConversationLookupKeys, buildConversationTargetKey } from '../components/dashboard/conversation-identity'
import { shouldAutoHideMeshConversation, type AutoHideConversationTarget } from './useHiddenTabs'

const STORAGE_KEY = 'adhdev_mutedConversations'
const AUTO_MUTED_STORAGE_KEY = 'adhdev_autoMutedMeshConversations'

function loadFromStorage(key: string): Set<string> {
    try {
        const raw = localStorage.getItem(key)
        if (raw) return new Set(JSON.parse(raw))
    } catch { /* noop */ }
    return new Set()
}

function saveToStorage(key: string, set: Set<string>): void {
    try {
        localStorage.setItem(key, JSON.stringify([...set]))
    } catch { /* noop */ }
}

export function isConversationMuted(mutedSet: Set<string>, target: ConversationTarget): boolean {
    return buildConversationLookupKeys(target).some(key => mutedSet.has(key))
}

export function useMutedConversations() {
    const [mutedTargets, setMutedTargets] = useState<Set<string>>(() => loadFromStorage(STORAGE_KEY))
    const [autoMutedTargets, setAutoMutedTargets] = useState<Set<string>>(() => loadFromStorage(AUTO_MUTED_STORAGE_KEY))

    const muteTarget = useCallback((target: ConversationTarget) => {
        const key = buildConversationTargetKey(target)
        setMutedTargets(prev => {
            if (prev.has(key)) return prev
            const next = new Set(prev)
            next.add(key)
            saveToStorage(STORAGE_KEY, next)
            return next
        })
    }, [])

    const unmuteTarget = useCallback((target: ConversationTarget) => {
        const lookupKeys = buildConversationLookupKeys(target)
        setMutedTargets(prev => {
            let changed = false
            const next = new Set(prev)
            for (const k of lookupKeys) {
                if (next.delete(k)) changed = true
            }
            if (!changed) return prev
            saveToStorage(STORAGE_KEY, next)
            return next
        })
        // Also clear the auto-muted record so it stays unmuted across reloads.
        setAutoMutedTargets(prev => {
            let changed = false
            const next = new Set(prev)
            for (const k of lookupKeys) {
                if (next.delete(k)) changed = true
            }
            if (!changed) return prev
            saveToStorage(AUTO_MUTED_STORAGE_KEY, next)
            return next
        })
    }, [])

    const toggleTarget = useCallback((target: ConversationTarget) => {
        const lookupKeys = buildConversationLookupKeys(target)
        const alreadyMuted = lookupKeys.some(k => mutedTargets.has(k))
        if (alreadyMuted) unmuteTarget(target)
        else muteTarget(target)
    }, [mutedTargets, muteTarget, unmuteTarget])

    /**
     * Auto-mute on first sight of a coordinator-spawned mesh node session.
     * Idempotent — once we record we auto-muted a target we never re-do it,
     * even if the user unmutes afterwards (see unmute, which clears both
     * sets).
     */
    const autoMuteIfCoordinator = useCallback((target: AutoHideConversationTarget) => {
        if (!shouldAutoHideMeshConversation(target)) return
        const key = buildConversationTargetKey(target)
        if (autoMutedTargets.has(key)) return
        setAutoMutedTargets(prev => {
            if (prev.has(key)) return prev
            const next = new Set(prev)
            next.add(key)
            saveToStorage(AUTO_MUTED_STORAGE_KEY, next)
            return next
        })
        setMutedTargets(prev => {
            if (prev.has(key)) return prev
            const next = new Set(prev)
            next.add(key)
            saveToStorage(STORAGE_KEY, next)
            return next
        })
    }, [autoMutedTargets])

    const isMuted = useCallback(
        (target: ConversationTarget) => isConversationMuted(mutedTargets, target),
        [mutedTargets],
    )

    return {
        mutedTargets,
        autoMutedTargets,
        muteTarget,
        unmuteTarget,
        toggleTarget,
        autoMuteIfCoordinator,
        isMuted,
    }
}
