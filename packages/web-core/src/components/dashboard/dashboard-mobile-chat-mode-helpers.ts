import type { DaemonData } from '../../types'
import type { MachineRecentLaunch } from '../../pages/machine/types'
import { getDaemonEntryActivityAt, getMachineDisplayName, getProviderSummaryLine, isAcpEntry, isCliEntry } from '../../utils/daemon-utils'
import type { MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { isConversationGenerating } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import { getConversationMachineId } from './conversation-selectors'
import { getConversationMachineCardPreview } from './conversation-presenters'
import { getSessionChatTailSnapshotForConversation } from './session-chat-tail-controller'

export interface MobileInboxBuckets {
    attentionItems: MobileConversationListItem[]
    unreadItems: MobileConversationListItem[]
    workingItems: MobileConversationListItem[]
    completedItems: MobileConversationListItem[]
}

export function sortMobileInboxItems(items: MobileConversationListItem[]) {
    return [...items].sort((left, right) => {
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

export function groupMobileInboxItems(
    items: MobileConversationListItem[],
    previousLiveOrder: string[] = [],
): MobileInboxBuckets {
    const attentionItems = items.filter(item => item.requiresAction)
    const unreadItems = items.filter(item => item.unread && !item.requiresAction)
    const workingCandidates = items.filter(item => !item.unread && !item.requiresAction && item.isWorking)
    const completedItems = items.filter(item => !item.unread && !item.requiresAction && !item.isWorking)

    return {
        attentionItems: sortMobileInboxItems(attentionItems),
        unreadItems: sortMobileInboxItems(unreadItems),
        workingItems: sortStableMobileLiveItems(workingCandidates, previousLiveOrder),
        completedItems: sortMobileInboxItems(completedItems),
    }
}

export function getMobileMachineConnectionLabel(machineEntry: DaemonData): 'Connected' | 'Connecting' | 'Offline' {
    const p2pState = machineEntry.p2p?.state || ''
    if (p2pState === 'connected') return 'Connected'
    if (p2pState === 'connecting' || p2pState === 'new' || p2pState === 'checking') return 'Connecting'
    // Standalone (localhost WS, no P2P) never populates `p2p`, so P2P state alone would
    // mislabel a live local daemon as Offline. When there is no P2P telemetry at all, fall
    // back to the daemon entry's own reported status — its presence means the daemon is
    // reporting over WS, and desktop Machines derives "online" from this same signal. Cloud
    // entries always carry p2p telemetry, so this fallback never changes cloud behavior.
    const hasP2pTelemetry = !!machineEntry.p2p?.available || !!machineEntry.p2p?.state
    if (!hasP2pTelemetry && machineEntry.status && machineEntry.status !== 'offline') {
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
            const kind: MachineRecentLaunch['kind'] = isCliEntry(entry) ? 'cli' : isAcpEntry(entry) ? 'acp' : 'ide'
            const summaryLine = getProviderSummaryLine(entry.summaryMetadata)
            return {
                id: `${kind}:${entry.type}:${entry.workspace || ''}`,
                label: entry.activeChat?.title
                    || (isCliEntry(entry)
                        ? (entry.cliName || entry.type)
                        : isAcpEntry(entry)
                            ? (entry.cliName || entry.type)
                            : entry.type),
                kind,
                providerType: entry.type,
                providerSessionId: entry.providerSessionId,
                subtitle: isAcpEntry(entry)
                    ? (summaryLine || entry.workspace || undefined)
                    : (entry.workspace || undefined),
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
        const statusLabel = getMobileMachineConnectionLabel(machineEntry)
        const subtitleParts = [
            machineEntry.platform || 'machine',
            statusLabel,
        ].filter(Boolean)

        return {
            id: machineEntry.id,
            label: getMachineDisplayName(machineEntry, { fallbackId: machineEntry.id }),
            subtitle: subtitleParts.join(' · '),
            unread,
            total: machineItems.length,
            generatingCount,
            latestConversation,
            latestTimestamp: latestItem?.timestamp || 0,
            fallbackActivityAt,
            preview: latestConversation
                // (B2) Same chat_tail snapshot authority as the inbox rows so the
                // machine card preview stays consistent with the opened chat body.
                ? getConversationMachineCardPreview(
                    latestConversation,
                    getSessionChatTailSnapshotForConversation(latestConversation),
                )
                : 'No active conversations yet. Open the machine, choose a workspace, then launch an IDE, CLI, or ACP session.',
        }
    }).sort((a, b) => {
        const aTs = a.latestTimestamp || a.fallbackActivityAt || 0
        const bTs = b.latestTimestamp || b.fallbackActivityAt || 0
        if (bTs !== aTs) return bTs - aTs
        return a.label.localeCompare(b.label)
    })
}
