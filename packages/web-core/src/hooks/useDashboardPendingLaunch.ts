import { useCallback, useEffect, useState } from 'react'

import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'
import { isAcpEntry, isCliEntry } from '../utils/daemon-utils'
import { resolveDashboardSessionTargetFromEntry } from '../utils/dashboard-route-paths'
import type { WorkspaceLaunchKind } from '../pages/machine/types'

interface PendingDashboardLaunch {
    machineId: string
    kind: WorkspaceLaunchKind
    providerType: string
    workspacePath?: string | null
    resumeSessionId?: string | null
    startedAt: number
}

interface UseDashboardPendingLaunchOptions {
    ides: DaemonData[]
    conversations: ActiveConversation[]
    onOpenSession: (sessionId: string) => void
}

function getRouteMachineId(id: string | null | undefined) {
    if (!id) return ''
    const value = String(id)
    return value.includes(':') ? value.split(':')[0] || value : value
}

function normalizeWorkspacePath(path: string | null | undefined) {
    return String(path || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
}

export function isP2PLaunchTimeout(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    return message.includes('P2P command timeout')
}

export function useDashboardPendingLaunch({
    ides,
    conversations,
    onOpenSession,
}: UseDashboardPendingLaunchOptions) {
    const [pendingDashboardLaunch, setPendingDashboardLaunch] = useState<PendingDashboardLaunch | null>(null)

    const trackPendingLaunch = useCallback((launch: PendingDashboardLaunch) => {
        setPendingDashboardLaunch(launch)
    }, [])

    useEffect(() => {
        if (!pendingDashboardLaunch) return

        const normalizedTargetWorkspace = normalizeWorkspacePath(pendingDashboardLaunch.workspacePath)
        const matchingEntry = ides.find((entry) => {
            if (!entry || entry.type === 'adhdev-daemon') return false
            const entryMachineId = getRouteMachineId(entry.daemonId || entry.id)
            if (entryMachineId !== pendingDashboardLaunch.machineId) return false

            const entryKind: WorkspaceLaunchKind = isCliEntry(entry)
                ? 'cli'
                : isAcpEntry(entry)
                    ? 'acp'
                    : 'ide'
            if (entryKind !== pendingDashboardLaunch.kind) return false

            const entryProviderType = String(entry.agentType || entry.type || '')
            if (entryProviderType !== pendingDashboardLaunch.providerType) return false

            if (pendingDashboardLaunch.resumeSessionId) {
                const entryProviderSessionId = String(entry.providerSessionId || '')
                return entryProviderSessionId === pendingDashboardLaunch.resumeSessionId
            }

            if (normalizedTargetWorkspace) {
                const entryWorkspace = normalizeWorkspacePath(entry.workspace || entry.runtimeWorkspaceLabel)
                if (!entryWorkspace) return false
                return entryWorkspace === normalizedTargetWorkspace
            }

            const activityAt = Number(
                entry.lastUpdated
                || entry._lastUpdate
                || entry.timestamp
                || entry.activeChat?.messages?.at?.(-1)?.timestamp
                || 0,
            )
            return activityAt >= (pendingDashboardLaunch.startedAt - 5_000)
        })

        if (!matchingEntry) return

        const targetSessionId = resolveDashboardSessionTargetFromEntry({
            entrySessionId: matchingEntry.sessionId,
            entryInstanceId: matchingEntry.instanceId,
            entryRouteId: matchingEntry.id,
            conversations,
        })

        if (!targetSessionId) return

        setPendingDashboardLaunch(null)
        onOpenSession(targetSessionId)
    }, [conversations, ides, onOpenSession, pendingDashboardLaunch])

    useEffect(() => {
        if (!pendingDashboardLaunch) return
        const timeout = window.setTimeout(() => {
            setPendingDashboardLaunch(current => {
                if (!current || current.startedAt !== pendingDashboardLaunch.startedAt) return current
                return null
            })
        }, 45_000)
        return () => window.clearTimeout(timeout)
    }, [pendingDashboardLaunch])

    return {
        trackPendingLaunch,
    }
}
