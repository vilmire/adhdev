/**
 * useMutedConversations — device-local mute state for conversations.
 *
 * "Muted" means:
 *   - excluded from the attention/unread bucket on the inbox
 *   - no toast / audio / browser notification on new messages
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
 *
 * The mute state is backed by a module-level singleton store (not per-hook
 * useState) so every consumer — the dashboard, the mobile chat mode, AND the
 * non-React notification channels (EventManager toast/audio, browser
 * notifications) — reads a single reactive source of truth. `isConversationMutedNow`
 * is the non-React accessor those channels use.
 */
import { useCallback, useSyncExternalStore } from 'react'
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

// ─── Module-level singleton store ─────────────────
// Sets are replaced (new identity) on every mutation so useSyncExternalStore
// snapshots compare by reference.
let mutedSet: Set<string> = loadFromStorage(STORAGE_KEY)
let autoMutedSet: Set<string> = loadFromStorage(AUTO_MUTED_STORAGE_KEY)
const listeners = new Set<() => void>()

function emit(): void {
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

function setMuted(next: Set<string>): void {
    mutedSet = next
    saveToStorage(STORAGE_KEY, next)
    emit()
}

function setAutoMuted(next: Set<string>): void {
    autoMutedSet = next
    saveToStorage(AUTO_MUTED_STORAGE_KEY, next)
    emit()
}

export function isConversationMuted(set: Set<string>, target: ConversationTarget): boolean {
    return buildConversationLookupKeys(target).some(key => set.has(key))
}

/**
 * Non-React accessor: is this conversation currently muted? Used by the
 * notification channels (EventManager, browser notifications) that live
 * outside React but must honour the same device-local mute state.
 */
export function isConversationMutedNow(target: ConversationTarget): boolean {
    return isConversationMuted(mutedSet, target)
}

/** Non-React mutator: mute a conversation. */
export function muteConversation(target: ConversationTarget): void {
    const key = buildConversationTargetKey(target)
    if (mutedSet.has(key)) return
    const next = new Set(mutedSet)
    next.add(key)
    setMuted(next)
}

/**
 * Non-React mutator: unmute a conversation.
 *
 * Removes every lookup key from the muted set AND records the canonical target
 * key in the auto-muted set. Recording it (rather than clearing it) is what makes
 * a manual unmute stick: autoMuteConversationIfCoordinator skips any target already
 * in the auto-muted set, so a later auto-mute pass — on reconnect or reload — never
 * re-mutes a session the user chose to unmute. Mirrors useHiddenTabs.showTarget.
 */
export function unmuteConversation(target: ConversationTarget): void {
    const lookupKeys = buildConversationLookupKeys(target)
    let changedMuted = false
    const nextMuted = new Set(mutedSet)
    for (const k of lookupKeys) {
        if (nextMuted.delete(k)) changedMuted = true
    }
    if (changedMuted) setMuted(nextMuted)
    const autoKey = buildConversationTargetKey(target)
    if (!autoMutedSet.has(autoKey)) {
        const nextAuto = new Set(autoMutedSet)
        nextAuto.add(autoKey)
        setAutoMuted(nextAuto)
    }
}

/**
 * Auto-mute on first sight of a coordinator-spawned mesh node session.
 * Idempotent — once we record we auto-muted a target we never re-do it,
 * even if the user unmutes afterwards (unmute keeps the auto-muted marker).
 */
export function autoMuteConversationIfCoordinator(target: AutoHideConversationTarget): void {
    if (!shouldAutoHideMeshConversation(target)) return
    const key = buildConversationTargetKey(target)
    if (autoMutedSet.has(key)) return
    const nextAuto = new Set(autoMutedSet)
    nextAuto.add(key)
    setAutoMuted(nextAuto)
    if (!mutedSet.has(key)) {
        const nextMuted = new Set(mutedSet)
        nextMuted.add(key)
        setMuted(nextMuted)
    }
}

export function useMutedConversations() {
    const mutedTargets = useSyncExternalStore(subscribe, () => mutedSet, () => mutedSet)
    const autoMutedTargets = useSyncExternalStore(subscribe, () => autoMutedSet, () => autoMutedSet)

    const muteTarget = useCallback((target: ConversationTarget) => muteConversation(target), [])
    const unmuteTarget = useCallback((target: ConversationTarget) => unmuteConversation(target), [])
    const toggleTarget = useCallback((target: ConversationTarget) => {
        const lookupKeys = buildConversationLookupKeys(target)
        const alreadyMuted = lookupKeys.some(k => mutedTargets.has(k))
        if (alreadyMuted) unmuteConversation(target)
        else muteConversation(target)
    }, [mutedTargets])
    const autoMuteIfCoordinator = useCallback((target: AutoHideConversationTarget) => autoMuteConversationIfCoordinator(target), [])

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
