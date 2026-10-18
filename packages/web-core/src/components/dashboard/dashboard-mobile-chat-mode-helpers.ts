import type { DaemonData } from '../../types'
import type { MachineRecentLaunch } from '../../pages/machine/types'
import { getDaemonEntryActivityAt, getMachineDisplayName, getProviderSummaryLine, isCliEntry } from '../../utils/daemon-utils'
import type { MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { isConversationGenerating } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import { getConversationMachineId } from './conversation-selectors'
import { getConversationMachineCardPreview } from './conversation-presenters'
import { getSessionChatSnapshotForConversation } from './session-chat-controller'
import { compareAssistantFirst, isAssistantConversation } from './assistant-session'

export interface MobileInboxBuckets {
    /**
     * The personal assistant, pinned above every bucket (desktop pins it first in
     * the session list). It leaves its status bucket so it is never listed twice;
     * the row still shows that status via {@link getMobileInboxRowType}.
     */
    assistantItems: MobileConversationListItem[]
    attentionItems: MobileConversationListItem[]
    unreadItems: MobileConversationListItem[]
    workingItems: MobileConversationListItem[]
    completedItems: MobileConversationListItem[]
}

export function sortMobileInboxItems(items: MobileConversationListItem[]) {
    return [...items].sort((left, right) => {
        const assistantDiff = compareAssistantFirst(left.conversation, right.conversation)
        if (assistantDiff !== 0) return assistantDiff
        const timestampDiff = right.timestamp - left.timestamp
        if (timestampDiff !== 0) return timestampDiff
        return left.conversation.tabKey.localeCompare(right.conversation.tabKey)
    })
}

export function sortStableMobileLiveItems(
    items: MobileConversationListItem[],
    previousLiveOrder: string[] = [],
) {
    const itemByTabKey = new Map(items.map(item => [item.conversation.tabKey, item]))
    const previousOrderedItems = previousLiveOrder
        .map(tabKey => itemByTabKey.get(tabKey))
        .filter((item): item is MobileConversationListItem => !!item)

    if (previousOrderedItems.length === items.length) {
        return previousOrderedItems
    }

    return sortMobileInboxItems(items)
}

export type MobileInboxRowType = 'needs_attention' | 'task_complete' | 'working' | 'earlier'

/** The row style a conversation would get in its status bucket. */
export function getMobileInboxRowType(item: Pick<MobileConversationListItem, 'requiresAction' | 'unread' | 'isWorking'>): MobileInboxRowType {
    if (item.requiresAction) return 'needs_attention'
    if (item.unread) return 'task_complete'
    if (item.isWorking) return 'working'
    return 'earlier'
}

export function groupMobileInboxItems(
    allItems: MobileConversationListItem[],
    previousLiveOrder: string[] = [],
): MobileInboxBuckets {
    const assistantItems = allItems.filter(item => isAssistantConversation(item.conversation))
    const items = assistantItems.length > 0
        ? allItems.filter(item => !isAssistantConversation(item.conversation))
        : allItems
    const attentionItems = items.filter(item => item.requiresAction)
    const unreadItems = items.filter(item => item.unread && !item.requiresAction)
    const workingCandidates = items.filter(item => !item.unread && !item.requiresAction && item.isWorking)
    const completedItems = items.filter(item => !item.unread && !item.requiresAction && !item.isWorking)

    return {
        assistantItems: sortMobileInboxItems(assistantItems),
        attentionItems: sortMobileInboxItems(attentionItems),
        unreadItems: sortMobileInboxItems(unreadItems),
        workingItems: sortStableMobileLiveItems(workingCandidates, previousLiveOrder),
        completedItems: sortMobileInboxItems(completedItems),
    }
}

/**
 * areConversationsLoaded — has the conversation list finished loading?
 *
 * `initialDataLoaded` (BaseDaemonContext `initialLoaded`) only means the DAEMON
 * discovery snapshot landed. On cloud that snapshot is deliberately daemon-only
 * (`expandServerBootstrapDaemons` passes `daemonOnlyId: () => true`), so it never
 * carries sessions: conversations arrive strictly later over the P2P data channel.
 * Gating the conversation empty state on `initialDataLoaded` alone therefore claims
 * "no conversations yet" during the window between WS bootstrap and the first P2P
 * status snapshot — against data that had not arrived yet.
 *
 * `_sessionListAuthoritative` is set only by `statusPayloadToEntries`
 * (`utils/status-transform.ts`) and means "this daemon entry was built from a status
 * payload that carried an explicit sessions array" — i.e. exactly "the session list
 * for this daemon has arrived", even when that list is legitimately empty. It is
 * sticky: a later daemon-only WS bootstrap merges through `mergeWeakEntry`, which
 * spreads the existing entry, so the flag never flips back and cannot cause a
 * loading↔empty flicker.
 *
 * A daemon is only awaited while it is actually reachable — an offline or
 * still-connecting machine would otherwise pin the list in a loading state forever.
 * Standalone injects sessions in the same payload that marks load complete, so every
 * entry is authoritative on arrival and this returns `initialDataLoaded` unchanged.
 */
export interface MobileMachineConnectionOptions {
    isStandalone?: boolean
    connectionStates?: Record<string, string | undefined>
    statusLabels?: Partial<Record<'Connected' | 'Connecting' | 'Offline', string>>
}

export function areConversationsLoaded(
    ides: DaemonData[],
    initialDataLoaded: boolean,
    options?: MobileMachineConnectionOptions,
): boolean {
    if (!initialDataLoaded) return false

    const connectedDaemons = ides.filter(entry => (
        entry.type === 'adhdev-daemon'
        && getMobileMachineConnectionLabel(entry, options) === 'Connected'
    ))

    // No reachable daemon → nothing further to wait for; the empty state is honest
    // ("no machines connected" is rendered ahead of "no conversations").
    if (connectedDaemons.length === 0) return true

    return connectedDaemons.some(entry => entry._sessionListAuthoritative === true)
}

export function getMobileMachineConnectionLabel(
    machineEntry: DaemonData,
    options?: MobileMachineConnectionOptions,
): 'Connected' | 'Connecting' | 'Offline' {
    if (machineEntry.status === 'offline') return 'Offline'
    const isStandalone = options?.isStandalone ?? (options?.connectionStates === undefined)
    if (!isStandalone) {
        if (options?.connectionStates !== undefined) {
            return options.connectionStates[machineEntry.id] === 'connected' ? 'Connected' : 'Connecting'
        }
        const p2pState = machineEntry.p2p?.state || ''
        if (p2pState === 'connected') return 'Connected'
        return 'Connecting'
    }
    const p2pState = machineEntry.p2p?.state || ''
    if (p2pState === 'connected') return 'Connected'
    if (p2pState === 'connecting' || p2pState === 'new' || p2pState === 'checking') return 'Connecting'
    // Standalone (localhost WS, no P2P) never populates `p2p`, so P2P state alone would
    // mislabel a live local daemon as Offline. When there is no P2P telemetry at all, fall
    // back to the daemon entry's own reported status — gated on standalone mode only.
    const hasP2pTelemetry = !!machineEntry.p2p?.available || !!machineEntry.p2p?.state
    if (isStandalone && !hasP2pTelemetry && machineEntry.status && machineEntry.status !== 'offline') {
        return 'Connected'
    }
    return 'Offline'
}

export function buildSelectedMachineRecentLaunches(
    selectedMachineEntry: DaemonData | null,
    ides: DaemonData[],
): MachineRecentLaunch[] {
    if (!selectedMachineEntry) return []

    const recentLaunches = selectedMachineEntry.recentLaunches || []
    if (recentLaunches.length > 0) {
        return recentLaunches.map((launch) => ({
            id: launch.id,
            label: launch.title || launch.providerName || launch.providerType,
            kind: launch.kind,
            providerType: launch.providerType,
            providerSessionId: launch.providerSessionId,
            subtitle: getProviderSummaryLine(launch.summaryMetadata) || launch.workspace || undefined,
            workspace: launch.workspace,
            summaryMetadata: launch.summaryMetadata,
        }))
    }

    return ides
        .filter(entry => entry.type !== 'adhdev-daemon' && entry.daemonId === selectedMachineEntry.id)
        .map(entry => {
            const kind: MachineRecentLaunch['kind'] = isCliEntry(entry) ? 'cli' : 'ide'
            return {
                id: `${kind}:${entry.type}:${entry.workspace || ''}`,
                label: entry.activeChat?.title
                    || (isCliEntry(entry)
                        ? (entry.cliName || entry.type)
                        : entry.type),
                kind,
                providerType: entry.type,
                providerSessionId: entry.providerSessionId,
                subtitle: entry.workspace || undefined,
                workspace: entry.workspace || undefined,
                timestamp: entry.lastMessageAt || 0,
            }
        })
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(({ timestamp, ...session }) => session)
}

export function buildMobileMachineCards(
    machineEntries: DaemonData[],
    items: MobileConversationListItem[],
    hiddenConversations: ActiveConversation[] = [],
    options?: MobileMachineConnectionOptions,
): MobileMachineCard[] {
    const groupedItems = new Map<string, MobileConversationListItem[]>()

    for (const item of items) {
        const key = getConversationMachineId(item.conversation)
        const bucket = groupedItems.get(key)
        if (bucket) bucket.push(item)
        else groupedItems.set(key, [item])
    }

    // Hidden conversations are excluded from `items` (visible inbox rows), but a
    // hidden chat can still be generating. Group them per machine separately so
    // the card's generating count reflects folded-away work too.
    const groupedHidden = new Map<string, ActiveConversation[]>()
    for (const conversation of hiddenConversations) {
        const key = getConversationMachineId(conversation)
        const bucket = groupedHidden.get(key)
        if (bucket) bucket.push(conversation)
        else groupedHidden.set(key, [conversation])
    }

    const statusOrder = (label: MobileMachineCard['statusLabel']): number => {
        if (label === 'Connected') return 0
        if (label === 'Connecting') return 1
        return 2
    }

    return machineEntries.map((machineEntry) => {
        const machineItems = groupedItems.get(machineEntry.id) || []
        const machineHidden = groupedHidden.get(machineEntry.id) || []
        const latestItem = [...machineItems].sort((a, b) => b.timestamp - a.timestamp)[0] || null
        const latestConversation = latestItem?.conversation || null
        const fallbackActivityAt = getDaemonEntryActivityAt(machineEntry)
        const unread = machineItems.filter(item => item.unread || item.requiresAction).length
        // Generating count spans both visible and hidden conversations so the
        // card signals "still working" even when every active chat is folded.
        const generatingCount =
            machineItems.filter(item => isConversationGenerating(item.conversation)).length
            + machineHidden.filter(isConversationGenerating).length
        const statusLabel = getMobileMachineConnectionLabel(machineEntry, options)
        const displayStatus = options?.statusLabels?.[statusLabel] ?? statusLabel
        const subtitleParts = [
            machineEntry.platform || 'machine',
            displayStatus,
        ].filter(Boolean)

        return {
            id: machineEntry.id,
            label: getMachineDisplayName(machineEntry, { fallbackId: machineEntry.id }),
            subtitle: subtitleParts.join(' · '),
            statusLabel,
            unread,
            total: machineItems.length,
            generatingCount,
            latestConversation,
            latestTimestamp: latestItem?.timestamp || 0,
            fallbackActivityAt,
            preview: latestConversation
                // (B2) Same keyed-chat snapshot authority as the inbox rows so the
                // machine card preview stays consistent with the opened chat body.
                ? getConversationMachineCardPreview(
                    latestConversation,
                    getSessionChatSnapshotForConversation(latestConversation),
                )
                : 'No active conversations yet. Open the machine, choose a workspace, then launch an IDE or CLI session.',
        }
    }).sort((a, b) => {
        const statusDiff = statusOrder(a.statusLabel) - statusOrder(b.statusLabel)
        if (statusDiff !== 0) return statusDiff
        const aTs = a.latestTimestamp || a.fallbackActivityAt || 0
        const bTs = b.latestTimestamp || b.fallbackActivityAt || 0
        if (bTs !== aTs) return bTs - aTs
        return a.label.localeCompare(b.label)
    })
}
