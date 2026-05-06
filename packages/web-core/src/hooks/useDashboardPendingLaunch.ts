import { useCallback, useEffect, useRef, useState } from 'react'

import type { ActiveConversation } from '../components/dashboard/types'
import { eventManager, type StatusEventPayload } from '../managers/EventManager'
import type { DaemonData } from '../types'
import { isAcpEntry, isCliEntry } from '../utils/daemon-utils'
import { getDashboardActiveTabKeyForConversation, resolveDashboardSessionTargetFromEntry } from '../utils/dashboard-route-paths'
import type { WorkspaceLaunchKind } from '../pages/machine/types'

export interface PendingDashboardLaunch {
    machineId: string
    kind: WorkspaceLaunchKind
    providerType?: string
    workspacePath?: string | null
    resumeSessionId?: string | null
    startedAt: number
}

function normalizeSessionToken(value: string | null | undefined) {
    return String(value || '').trim()
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

function isSameOrNestedWorkspace(candidate: string, target: string) {
    if (!candidate || !target) return false
    return candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`)
}

function resolveConversationTargetFromEvent(payload: StatusEventPayload, conversations: ActiveConversation[]) {
    const providerSessionId = normalizeSessionToken(payload.providerSessionId)
    const targetSessionId = normalizeSessionToken(payload.targetSessionId)
    const matchingConversation = conversations.find((conversation) => {
        const tokens = [
            conversation.providerSessionId,
            conversation.sessionId,
            conversation.nativeSessionId,
            conversation.tabKey,
            conversation.routeId,
        ].map(normalizeSessionToken).filter(Boolean)
        return Boolean(
            (providerSessionId && tokens.includes(providerSessionId))
            || (targetSessionId && tokens.includes(targetSessionId)),
        )
    })
    if (matchingConversation) {
        return getDashboardActiveTabKeyForConversation(matchingConversation)
    }
    return targetSessionId || providerSessionId || null
}

export function resolvePendingLaunchTargetFromStatusEvent(
    launch: PendingDashboardLaunch,
    payload: StatusEventPayload,
    conversations: ActiveConversation[],
): string | null {
    if (payload.event !== 'agent:generating_completed') return null

    const eventMachineId = getRouteMachineId(payload.daemonId)
    if (eventMachineId && eventMachineId !== launch.machineId) return null

    const eventProviderType = normalizeSessionToken(payload.providerType)
    if (launch.providerType && eventProviderType !== launch.providerType) return null

    const resumeSessionId = normalizeSessionToken(launch.resumeSessionId)
    const providerSessionId = normalizeSessionToken(payload.providerSessionId)
    const targetSessionId = normalizeSessionToken(payload.targetSessionId)
    if (resumeSessionId && resumeSessionId !== providerSessionId && resumeSessionId !== targetSessionId) return null

    const expectedWorkspace = normalizeWorkspacePath(launch.workspacePath)
    if (expectedWorkspace) {
        const eventWorkspace = normalizeWorkspacePath(payload.workspaceName)
        if (eventWorkspace && !isSameOrNestedWorkspace(eventWorkspace, expectedWorkspace)) return null
    }

    return resolveConversationTargetFromEvent(payload, conversations)
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
    const pendingDashboardLaunchRef = useRef<PendingDashboardLaunch | null>(null)

    const clearPendingLaunch = useCallback(() => {
        pendingDashboardLaunchRef.current = null
        setPendingDashboardLaunch(null)
    }, [])

    const trackPendingLaunch = useCallback((launch: PendingDashboardLaunch) => {
        pendingDashboardLaunchRef.current = launch
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
            if (pendingDashboardLaunch.providerType && entryProviderType !== pendingDashboardLaunch.providerType) return false

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

        clearPendingLaunch()
        onOpenSession(targetSessionId)
    }, [clearPendingLaunch, conversations, ides, onOpenSession, pendingDashboardLaunch])

    useEffect(() => {
        return eventManager.onStatusEvent((payload) => {
            const pendingLaunch = pendingDashboardLaunchRef.current
            if (!pendingLaunch) return
            const targetSessionId = resolvePendingLaunchTargetFromStatusEvent(pendingLaunch, payload, conversations)
            if (!targetSessionId) return
            clearPendingLaunch()
            onOpenSession(targetSessionId)
        })
    }, [clearPendingLaunch, conversations, onOpenSession])

    useEffect(() => {
        if (!pendingDashboardLaunch) return
        const timeout = window.setTimeout(() => {
            setPendingDashboardLaunch(current => {
                if (!current || current.startedAt !== pendingDashboardLaunch.startedAt) return current
                pendingDashboardLaunchRef.current = null
                return null
            })
        }, 45_000)
        return () => window.clearTimeout(timeout)
    }, [pendingDashboardLaunch])

    return {
        trackPendingLaunch,
    }
}
