import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import type { RecentSessionBucket } from '@adhdev/daemon-core'

export interface MobileConversationListItem {
    conversation: ActiveConversation
    timestamp: number
    preview: string
    unread: boolean
    requiresAction: boolean
    isWorking: boolean
    inboxBucket?: RecentSessionBucket
}

export interface MobileMachineCard {
    id: string
    label: string
    subtitle: string
    unread: number
    total: number
    /**
     * Number of conversations on this machine that are currently generating,
     * including hidden/collapsed ones. Surfaces "still working" activity even
     * when the underlying chat is folded away. Derived via the centralized
     * `getConversationViewStates` predicate so it matches every other surface.
     */
    generatingCount: number
    latestConversation: ActiveConversation | null
    latestTimestamp?: number
    fallbackActivityAt?: number
    preview: string
}

export interface MobileMachineActionState {
    state: 'idle' | 'loading' | 'done' | 'error'
    message: string
}

export interface InboxSurfaceStateSource {
    unread?: boolean
    lastSeenAt?: number
    lastUpdated?: number
    inboxBucket?: RecentSessionBucket
    surfaceHidden?: boolean
    muted?: boolean
    completionMarker?: string
    seenCompletionMarker?: string
}

export interface LiveSessionInboxState extends Required<InboxSurfaceStateSource> {
    sessionId: string
}

export interface ConversationInboxSurfaceState {
    unread: boolean
    requiresAction: boolean
    isWorking: boolean
    isReconnecting: boolean
    isConnecting: boolean
    isGenerating: boolean
    isWaiting: boolean
    inboxBucket: RecentSessionBucket
}

function normalizeInboxState(source: InboxSurfaceStateSource) {
    return {
        unread: !!source.unread,
        lastSeenAt: source.lastSeenAt || 0,
        lastUpdated: source.lastUpdated || 0,
        inboxBucket: source.inboxBucket || 'idle',
        surfaceHidden: !!source.surfaceHidden,
        muted: !!source.muted,
        completionMarker: typeof source.completionMarker === 'string' ? source.completionMarker : '',
        seenCompletionMarker: typeof source.seenCompletionMarker === 'string' ? source.seenCompletionMarker : '',
    }
}

export function getConversationViewStates(conversation: { status?: string, connectionState?: string }) {
    const isReconnecting = conversation.connectionState === 'failed' || conversation.connectionState === 'closed'
    const isConnecting = conversation.connectionState === 'connecting' || conversation.connectionState === 'new'
    const isGenerating = conversation.status === 'generating'
        || conversation.status === 'no_progress'
        || conversation.status === 'long_generating'
        || conversation.status === 'streaming'
    const isWaiting = conversation.status === 'waiting_approval'
    return { isReconnecting, isConnecting, isGenerating, isWaiting }
}

/**
 * Centralized "is this conversation generating" test — the single source of
 * truth for every surface (mobile machine cards, mobile hidden group, desktop
 * hidden indicator). Always route through `getConversationViewStates` so the
 * generating status set stays defined in exactly one place.
 */
export function isConversationGenerating(conversation: { status?: string, connectionState?: string }): boolean {
    return getConversationViewStates(conversation).isGenerating
}

/** Count how many of the given conversations are currently generating. */
export function countGeneratingConversations(conversations: { status?: string, connectionState?: string }[]): number {
    let count = 0
    for (const conversation of conversations) {
        if (isConversationGenerating(conversation)) count++
    }
    return count
}

/**
 * Deterministic winner selection between two registered copies of the same
 * session's inbox state. Mirrors the shape of the conversation-state dedupe
 * contract (`dedupeChatIdes` in hooks/useDashboardConversations.ts: prefer
 * richer evidence, order by remote-domain timestamp, stay stable) adapted to
 * the inbox-state fields, which that richness score does not cover.
 *
 * Order of rules:
 *  1. Newer `lastUpdated` (remote-domain daemon timestamp) wins — a stale
 *     duplicate carrying `inboxBucket: 'working'` with an older/absent
 *     `lastUpdated` can NEVER override a fresher `idle` copy, while a
 *     genuinely fresher working copy still can.
 *  2. Timestamp tie → richer evidence wins: the copy that actually carries
 *     explicit inbox fields (e.g. an explicit `inboxBucket`) beats one that
 *     would only contribute defaults.
 *  3. Full tie → keep the FIRST registered copy (stable input order, no
 *     reordering).
 */
function inboxStateEvidenceScore(source: InboxSurfaceStateSource): number {
    let score = 0
    if (source.unread !== undefined) score += 1
    if (source.lastSeenAt !== undefined) score += 1
    if (source.lastUpdated !== undefined) score += 1
    if (source.inboxBucket !== undefined) score += 1
    if (source.surfaceHidden !== undefined) score += 1
    if (source.muted !== undefined) score += 1
    if (source.completionMarker !== undefined) score += 1
    if (source.seenCompletionMarker !== undefined) score += 1
    return score
}

function shouldReplaceRegisteredInboxState(
    existing: InboxSurfaceStateSource,
    incoming: InboxSurfaceStateSource,
): boolean {
    const existingTs = existing.lastUpdated || 0
    const incomingTs = incoming.lastUpdated || 0
    if (incomingTs !== existingTs) return incomingTs > existingTs
    const existingEvidence = inboxStateEvidenceScore(existing)
    const incomingEvidence = inboxStateEvidenceScore(incoming)
    if (incomingEvidence !== existingEvidence) return incomingEvidence > existingEvidence
    return false
}

/**
 * Pure projection over the already-reconciled `ides` array: maps sessionId →
 * normalized inbox surface state for mobile surfaces. A sessionId can appear
 * twice in `ides` (a stale duplicate entry plus the fresh one, or a top-level
 * entry plus a `childSessions` child), so duplicate registrations are resolved
 * deterministically — newer remote `lastUpdated` wins, timestamp ties break
 * toward the copy with richer explicit evidence, and full ties keep the first
 * registered copy (stable input order). This is dedupe only: no new status
 * semantics, no mobile-only lifecycle authority.
 */
export function buildLiveSessionInboxStateMap(ides: DaemonData[]) {
    const stateBySessionId = new Map<string, LiveSessionInboxState>()
    const sourceBySessionId = new Map<string, InboxSurfaceStateSource>()

    const register = (
        sessionId: string | undefined,
        source: InboxSurfaceStateSource,
    ) => {
        if (!sessionId) return
        const existingSource = sourceBySessionId.get(sessionId)
        if (existingSource && !shouldReplaceRegisteredInboxState(existingSource, source)) return
        sourceBySessionId.set(sessionId, source)
        stateBySessionId.set(sessionId, {
            sessionId,
            ...normalizeInboxState(source),
        })
    }

    for (const entry of ides) {
        if (entry.type === 'adhdev-daemon') continue
        register(entry.sessionId, entry)
        for (const child of entry.childSessions || []) {
            register(child.id, child)
        }
    }

    return stateBySessionId
}

export function getConversationLiveInboxState(
    conversation: ActiveConversation,
    stateBySessionId: Map<string, InboxSurfaceStateSource>,
) {
    if (conversation.sessionId) {
        const liveState = stateBySessionId.get(conversation.sessionId)
        if (liveState) return liveState
    }
    return {
        sessionId: conversation.sessionId || conversation.tabKey,
        unread: false,
        lastSeenAt: 0,
        lastUpdated: 0,
        inboxBucket: 'idle',
        surfaceHidden: false,
        muted: false,
        completionMarker: '',
        seenCompletionMarker: '',
    }
}

export function getConversationInboxSurfaceState(
    conversation: ActiveConversation,
    stateBySessionId: Map<string, InboxSurfaceStateSource>,
    options?: {
        hideOpenTaskCompleteUnread?: boolean
        isOpenConversation?: boolean
    },
): ConversationInboxSurfaceState {
    const liveState = getConversationLiveInboxState(conversation, stateBySessionId)
    const viewStates = getConversationViewStates(conversation)

    const isReconnecting = viewStates.isReconnecting
    const isConnecting = viewStates.isConnecting
    const isGenerating = viewStates.isGenerating
    const isWaiting = viewStates.isWaiting

    const requiresAction = liveState.inboxBucket === 'needs_attention' || conversation.status === 'needs_attention' || conversation.status === 'waiting_for_user_input' || isWaiting
    const isWorking = liveState.inboxBucket === 'working' || isGenerating
    const taskCompleteUnread = liveState.inboxBucket === 'task_complete' && liveState.unread
    const unread = !!(
        taskCompleteUnread
        && !(options?.hideOpenTaskCompleteUnread && options?.isOpenConversation)
    )

    return {
        unread,
        requiresAction,
        isWorking,
        isReconnecting,
        isConnecting,
        isGenerating,
        isWaiting,
        inboxBucket: requiresAction
            ? 'needs_attention'
            : isWorking
                ? 'working'
                : unread
                    ? 'task_complete'
                    : 'idle',
    }
}

export function isConversationTaskCompleteUnread(
    conversation: ActiveConversation,
    stateBySessionId: Map<string, InboxSurfaceStateSource>,
    options?: {
        isOpenConversation?: boolean
    },
) {
    return getConversationInboxSurfaceState(conversation, stateBySessionId, {
        hideOpenTaskCompleteUnread: true,
        isOpenConversation: options?.isOpenConversation,
    }).unread
}

export function isHiddenNativeIdeParentConversation(
    conversation: ActiveConversation,
    _conversations: ActiveConversation[],
    stateBySessionId?: Map<string, LiveSessionInboxState>,
) {
    return getConversationLiveInboxState(conversation, stateBySessionId || new Map()).surfaceHidden
}

export { formatRelativeCompact as formatRelativeTime } from '../../utils/time'
