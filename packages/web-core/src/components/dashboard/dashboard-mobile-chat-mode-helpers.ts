import type { DaemonData } from '../../types'
import type { MachineRecentLaunch } from '../../pages/machine/types'
import { getDaemonEntryActivityAt, getMachineDisplayName, isAcpEntry, isCliEntry } from '../../utils/daemon-utils'
import type { MobileConversationListItem, MobileMachineCard } from './DashboardMobileChatShared'
import { getConversationMachineId } from './conversation-selectors'
import { getConversationMachineCardPreview } from './conversation-presenters'

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
            subtitle: launch.currentModel || launch.workspace || undefined,
            workspace: launch.workspace,
            currentModel: launch.currentModel,
        }))
    }

    return ides
        .filter(entry => !entry.daemonMode && entry.daemonId === selectedMachineEntry.id)
        .map(entry => {
            const kind: MachineRecentLaunch['kind'] = isCliEntry(entry) ? 'cli' : isAcpEntry(entry) ? 'acp' : 'ide'
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
                    ? (entry.currentModel || entry.workspace || undefined)
                    : (entry.workspace || undefined),
                workspace: entry.workspace || undefined,
                currentModel: entry.currentModel,
                timestamp: entry.activeChat?.messages?.at?.(-1)?.timestamp || 0,
            }
        })
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(({ timestamp, ...session }) => session)
}

export function buildMobileMachineCards(
    machineEntries: DaemonData[],
    items: MobileConversationListItem[],
): MobileMachineCard[] {
    const groupedItems = new Map<string, MobileConversationListItem[]>()

    for (const item of items) {
        const key = getConversationMachineId(item.conversation)
        const bucket = groupedItems.get(key)
        if (bucket) bucket.push(item)
        else groupedItems.set(key, [item])
    }

    return machineEntries.map((machineEntry) => {
        const machineItems = groupedItems.get(machineEntry.id) || []
        const latestItem = [...machineItems].sort((a, b) => b.timestamp - a.timestamp)[0] || null
        const latestConversation = latestItem?.conversation || null
        const fallbackActivityAt = getDaemonEntryActivityAt(machineEntry)
        const unread = machineItems.filter(item => item.unread || item.requiresAction).length
        const statusLabel = machineEntry.status === 'online'
            ? 'Connected'
            : machineEntry.status || 'Unknown'
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
            latestConversation,
            latestTimestamp: latestItem?.timestamp || 0,
            fallbackActivityAt,
            preview: latestConversation
                ? getConversationMachineCardPreview(latestConversation)
                : 'No active conversations yet. Open the machine, choose a workspace, then launch an IDE, CLI, or ACP session.',
        }
    }).sort((a, b) => {
        const aTs = a.latestTimestamp || a.fallbackActivityAt || 0
        const bTs = b.latestTimestamp || b.fallbackActivityAt || 0
        if (bTs !== aTs) return bTs - aTs
        return a.label.localeCompare(b.label)
    })
}
