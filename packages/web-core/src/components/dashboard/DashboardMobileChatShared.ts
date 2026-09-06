import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import type { ManagedStatus, RecentSessionBucket } from '@adhdev/daemon-core'
import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'

/**
 * Wire-only legacy synonyms that `conversation.status` can carry but that
 * `normalizeManagedStatus` (daemon-core `status/normalize.ts`) does NOT fold
 * into `generating` — its `WORKING_STATUSES` set covers `streaming`/`loading`/
 * `thinking`/`active` but not these two ('no_progress' is the renamed form of
 * legacy 'long_generating'; both are stall-monitor labels, not reducer/FSM
 * output). Confirmed by direct probe against the built normalizer: both
 * currently resolve to `idle`, not `generating`. This alias step exists so
 * fixing the `finalizing`/`starting` blind spot does not regress these two —
 * they must keep counting as generating exactly as before this fix.
 */
const LEGACY_GENERATING_STATUS_ALIASES: ReadonlySet<string> = new Set(['no_progress', 'long_generating'])

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

/**
 * HIDE-FLAP: `surfaceHidden`/`muted` stay `boolean | undefined` here rather than
 * being widened to Required. "This copy did not carry the field" and "this copy
 * says the session is not hidden" are DIFFERENT facts, and collapsing them is
 * what let a copy that merely omitted the field assert "not hidden" and win a
 * render — producing the hide/unhide blinking. Every other field keeps its
 * concrete default because an absent `unread`/`inboxBucket` has no competing
 * meaning. Defaults for these two are applied only at the render boundary
 * (resolveSurfaceHidden / resolveMuted below).
 */
export interface LiveSessionInboxState
    extends Required<Omit<InboxSurfaceStateSource, 'surfaceHidden' | 'muted'>> {
    sessionId: string
    surfaceHidden?: boolean
    muted?: boolean
}

/**
 * Render-boundary defaults. A session whose hide state nobody has reported is
 * SHOWN (the safe direction: a visible session the user can hide beats a
 * silently swallowed one), but that decision is made here, once, instead of
 * being baked into every intermediate copy.
 */
export function resolveSurfaceHidden(state: { surfaceHidden?: boolean } | undefined): boolean {
    return state?.surfaceHidden === true
}

export function resolveMuted(state: { muted?: boolean } | undefined): boolean {
    return state?.muted === true
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
        // HIDE-FLAP: surfaceHidden/muted are deliberately NOT produced here.
        // They are merged across a session's duplicate registrations by the
        // caller (pickKnownFlag) and spread over this result, so emitting a
        // coerced `!!source.x` would be dead code that reads as a safety net it
        // is not. Leaving them out keeps ONE producer for these two fields.
        completionMarker: typeof source.completionMarker === 'string' ? source.completionMarker : '',
        seenCompletionMarker: typeof source.seenCompletionMarker === 'string' ? source.seenCompletionMarker : '',
    }
}

/**
 * Exhaustive classification of every `ManagedStatus` value into "is this
 * conversation actively working" (true) or not (false). Keyed as a `Record`
 * over the full `ManagedStatus` union so that TypeScript raises a compile
 * error here the moment a new status is added to the reducer's output type —
 * this is the "isGenerating doesn't know what the reducer emits" bug class
 * (`finalizing`/`starting` were silently missing from a hand-maintained list)
 * made structurally impossible to repeat silently.
 */
const MANAGED_STATUS_IS_WORKING: Record<ManagedStatus, boolean> = {
    idle: false,
    generating: true,
    starting: true,
    finalizing: true,
    waiting_approval: false,
    waiting_choice: false,
    error: false,
    stopped: false,
    panel_hidden: false,
    not_monitored: false,
    disconnected: false,
}

export function getConversationViewStates(conversation: { status?: string, connectionState?: string }) {
    const isReconnecting = conversation.connectionState === 'failed' || conversation.connectionState === 'closed'
    const isConnecting = conversation.connectionState === 'connecting' || conversation.connectionState === 'new'
    // Route through the canonical normalizer for everything the reducer/FSM
    // actually emits, so this file stays in sync with `ManagedStatus` by
    // construction. The two legacy wire-only synonyms it does NOT cover are
    // aliased first (see LEGACY_GENERATING_STATUS_ALIASES) so they keep
    // resolving to `generating` as before.
    const managedStatus = LEGACY_GENERATING_STATUS_ALIASES.has(conversation.status || '')
        ? 'generating'
        : normalizeManagedStatus(conversation.status)
    const isGenerating = MANAGED_STATUS_IS_WORKING[managedStatus]
    const isWaiting = managedStatus === 'waiting_approval'
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
 * HIDE-FLAP: pick the hide/mute values across duplicate registrations of ONE
 * session, independently of which copy wins the rest of the inbox state.
 *
 * A session legitimately appears twice in `ides` (a top-level entry plus a
 * `childSessions` child), and only one copy may carry hide/mute. The general
 * winner is chosen by recency, so whichever copy was touched last decided
 * visibility — and as the two copies took turns being newest, the session
 * blinked between hidden and shown while the daemon's state never changed.
 *
 * Recency is the right rule for values that genuinely move (unread, bucket,
 * timestamps): a newer reading supersedes an older one. It is the WRONG rule
 * for a field a copy may simply not carry, because "silent" then outranks
 * "informed". So for these two fields only, a copy that KNOWS beats a copy that
 * does not, and ties fall back to recency. That makes alternation structurally
 * impossible: the outcome no longer depends on which copy is newest, so the
 * same set of copies always resolves to the same visibility.
 *
 * Scoped deliberately to surfaceHidden/muted. Widening this to unread or
 * inboxBucket would pin a stale reading forever — those must keep following
 * recency.
 */
function pickKnownFlag(
    existing: boolean | undefined,
    incoming: boolean | undefined,
    incomingIsNewer: boolean,
): boolean | undefined {
    if (existing === undefined) return incoming
    if (incoming === undefined) return existing
    // Both copies know: the newer reading wins, as for any other live value.
    return incomingIsNewer ? incoming : existing
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
 *
 * HIDE-FLAP exception: surfaceHidden/muted are merged ACROSS the duplicates
 * (pickKnownFlag) rather than taken from whichever copy wins overall, because a
 * copy that does not carry them must never outvote one that does. See that
 * helper for why recency is the wrong rule for these two fields specifically.
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
        const existingState = stateBySessionId.get(sessionId)
        const incomingIsNewer = (source.lastUpdated || 0) > (existingSource?.lastUpdated || 0)
        // Merged independently of who wins the row, so the result cannot depend
        // on which duplicate happened to be touched last.
        const surfaceHidden = pickKnownFlag(
            existingState?.surfaceHidden,
            typeof source.surfaceHidden === 'boolean' ? source.surfaceHidden : undefined,
            incomingIsNewer,
        )
        const muted = pickKnownFlag(
            existingState?.muted,
            typeof source.muted === 'boolean' ? source.muted : undefined,
            incomingIsNewer,
        )
        if (existingSource && !shouldReplaceRegisteredInboxState(existingSource, source)) {
            // This copy loses the row, but its hide/mute knowledge is still the
            // only knowledge we may have — keep the merged values.
            if (existingState) stateBySessionId.set(sessionId, { ...existingState, surfaceHidden, muted })
            return
        }
        sourceBySessionId.set(sessionId, source)
        stateBySessionId.set(sessionId, {
            sessionId,
            ...normalizeInboxState(source),
            surfaceHidden,
            muted,
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
        // HIDE-FLAP: `undefined`, not `false`. Having no entry in the map means
        // we have not heard this session's hide state — asserting "not hidden"
        // here made a session pop into view on any tick where the map briefly
        // lacked it, which is the same blink from the other direction. Callers
        // apply the default via resolveSurfaceHidden/resolveMuted.
        surfaceHidden: undefined as boolean | undefined,
        muted: undefined as boolean | undefined,
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
    // Render boundary: this is where "unknown" becomes a concrete decision.
    return resolveSurfaceHidden(getConversationLiveInboxState(conversation, stateBySessionId || new Map()))
}

export { formatRelativeCompact as formatRelativeTime } from '../../utils/time'
