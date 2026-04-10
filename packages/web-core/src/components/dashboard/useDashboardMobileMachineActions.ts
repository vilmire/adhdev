import { useCallback, useEffect, useState } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import type { DaemonData } from '../../types'
import type { MachineRecentLaunch } from '../../pages/machine/types'
import { browseMachineDirectories, type BrowseDirectoryResult } from '../machine/workspaceBrowse'
import type { ActiveConversation } from './types'

interface PendingWorkspaceLaunch {
    machineId: string
    kind: 'cli' | 'acp'
    providerType: string
    workspaceId?: string | null
    workspacePath?: string | null
    resumeSessionId?: string | null
    startedAt: number
}

interface UseDashboardMobileMachineActionsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    navigate: NavigateFunction
    ides: DaemonData[]
    conversations: ActiveConversation[]
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

function isP2PLaunchTimeout(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    return message.includes('P2P command timeout')
}

export function useDashboardMobileMachineActions({
    sendDaemonCommand,
    navigate,
    ides,
    conversations,
}: UseDashboardMobileMachineActionsOptions) {
    const [machineActionState, setMachineActionState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
    const [machineActionMessage, setMachineActionMessage] = useState('')
    const [pendingWorkspaceLaunch, setPendingWorkspaceLaunch] = useState<PendingWorkspaceLaunch | null>(null)

    const resetMachineAction = useCallback(() => {
        setMachineActionState('idle')
        setMachineActionMessage('')
        setPendingWorkspaceLaunch(null)
    }, [])

    const handleLaunchDetectedIde = useCallback(async (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage(`Launching ${ideType}…`)
            const payload: Record<string, unknown> = {
                ideType,
                enableCdp: true,
            }
            if (opts?.workspacePath?.trim()) payload.workspace = opts.workspacePath.trim()
            await sendDaemonCommand(machineId, 'launch_ide', payload)
            setMachineActionState('done')
            setMachineActionMessage(`${ideType} launch requested`)
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Launch IDE failed')
            console.error('Launch IDE failed', error)
        }
    }, [sendDaemonCommand])

    const handleAddWorkspace = useCallback(async (
        machineId: string,
        path: string,
        opts?: { createIfMissing?: boolean },
    ) => {
        if (!path.trim()) return
        try {
            setMachineActionState('loading')
            setMachineActionMessage(opts?.createIfMissing ? 'Creating folder…' : 'Saving workspace…')
            const res: any = await sendDaemonCommand(machineId, 'workspace_add', {
                path: path.trim(),
                createIfMissing: opts?.createIfMissing === true,
            })
            if (res?.success) {
                setMachineActionState('done')
                setMachineActionMessage(opts?.createIfMissing ? 'Folder created and workspace saved' : 'Workspace saved')
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.error || 'Could not save workspace')
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Could not save workspace')
        }
    }, [sendDaemonCommand])

    const handleMachineUpgrade = useCallback(async (machineId: string) => {
        try {
            setMachineActionState('loading')
            setMachineActionMessage('Starting daemon upgrade…')
            const res: any = await sendDaemonCommand(machineId, 'daemon_upgrade', {})
            if (res?.result?.alreadyLatest) {
                setMachineActionState('done')
                setMachineActionMessage(`Already on v${res?.result?.version || 'latest'}.`)
                return
            }
            if (res?.result?.upgraded || res?.result?.success) {
                setMachineActionState('done')
                setMachineActionMessage(`Upgrade to v${res?.result?.version || 'latest'} started. Daemon is restarting…`)
                return
            }
            setMachineActionState('error')
            setMachineActionMessage(res?.result?.error || 'Upgrade failed')
        } catch (error) {
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : 'Upgrade failed')
        }
    }, [sendDaemonCommand])

    const handleLaunchWorkspaceProvider = useCallback(async (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: {
            workspaceId?: string | null
            workspacePath?: string | null
            resumeSessionId?: string | null
            args?: string | null
            model?: string | null
        },
    ) => {
        const startedAt = Date.now()
        const pendingLaunch: PendingWorkspaceLaunch = {
            machineId,
            kind,
            providerType,
            workspaceId: opts?.workspaceId || null,
            workspacePath: opts?.workspacePath || null,
            resumeSessionId: opts?.resumeSessionId || null,
            startedAt,
        }
        try {
            setMachineActionState('loading')
            setMachineActionMessage(`Launching ${providerType}…`)
            setPendingWorkspaceLaunch(pendingLaunch)
            const payload: Record<string, unknown> = { cliType: providerType }
            if (opts?.workspacePath?.trim()) payload.dir = opts.workspacePath.trim()
            else if (opts?.workspaceId) payload.workspaceId = opts.workspaceId
            if (opts?.resumeSessionId) payload.resumeSessionId = opts.resumeSessionId
            if (opts?.args?.trim()) payload.cliArgs = opts.args.trim().split(/\s+/).filter(Boolean)
            if (opts?.model?.trim()) payload.initialModel = opts.model.trim()
            const res: any = await sendDaemonCommand(machineId, 'launch_cli', payload)
            const result = res?.result || res
            const launchedSessionId = result?.sessionId || result?.id
            if (res?.success && launchedSessionId) {
                setPendingWorkspaceLaunch(null)
                setMachineActionState('done')
                setMachineActionMessage(`${providerType} launched`)
                navigate(`/dashboard?activeTab=${encodeURIComponent(launchedSessionId)}`)
                return
            }
            if (res?.success) {
                setMachineActionState('loading')
                setMachineActionMessage(`${providerType} launch requested — waiting for session…`)
                return
            }
            setPendingWorkspaceLaunch(null)
            setMachineActionState('error')
            setMachineActionMessage(res?.error || result?.error || `Could not launch ${kind.toUpperCase()} workspace`)
        } catch (error) {
            if (isP2PLaunchTimeout(error)) {
                setMachineActionState('loading')
                setMachineActionMessage(`${providerType} launch requested — waiting for session…`)
                return
            }
            setPendingWorkspaceLaunch(null)
            setMachineActionState('error')
            setMachineActionMessage(error instanceof Error ? error.message : `Could not launch ${kind.toUpperCase()} workspace`)
        }
    }, [navigate, sendDaemonCommand])

    const handleListSavedSessions = useCallback(async (machineId: string, providerType: string) => {
        try {
            const raw: any = await sendDaemonCommand(machineId, 'list_saved_sessions', {
                providerType,
                kind: 'cli',
                limit: 30,
            })
            const result = raw?.result ?? raw
            return Array.isArray(result?.sessions) ? result.sessions : []
        } catch (error) {
            console.error('Failed to list saved sessions on mobile:', error)
            return []
        }
    }, [sendDaemonCommand])

    const handleBrowseDirectory = useCallback(async (machineId: string, path: string): Promise<BrowseDirectoryResult> => (
        browseMachineDirectories(sendDaemonCommand, machineId, path)
    ), [sendDaemonCommand])

    useEffect(() => {
        if (!pendingWorkspaceLaunch) return

        const normalizedTargetWorkspace = normalizeWorkspacePath(pendingWorkspaceLaunch.workspacePath)
        const matchingEntry = ides.find(entry => {
            if (!entry || entry.type === 'adhdev-daemon' || entry.daemonMode) return false
            const entryMachineId = getRouteMachineId(entry.daemonId || entry.id)
            if (entryMachineId !== pendingWorkspaceLaunch.machineId) return false

            const entryKind = entry.transport === 'acp'
                ? 'acp'
                : entry.transport === 'pty'
                    ? 'cli'
                    : null
            if (entryKind !== pendingWorkspaceLaunch.kind) return false

            const entryProviderType = String(entry.agentType || entry.ideType || entry.type || '')
            if (entryProviderType !== pendingWorkspaceLaunch.providerType) return false

            const entryProviderSessionId = String(entry.providerSessionId || '')
            if (pendingWorkspaceLaunch.resumeSessionId && entryProviderSessionId) {
                return entryProviderSessionId === pendingWorkspaceLaunch.resumeSessionId
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
            return activityAt >= (pendingWorkspaceLaunch.startedAt - 5_000)
        })

        if (!matchingEntry) return

        const targetSessionId = typeof matchingEntry.sessionId === 'string' && matchingEntry.sessionId
            ? matchingEntry.sessionId
            : typeof matchingEntry.instanceId === 'string' && matchingEntry.instanceId
                ? matchingEntry.instanceId
                : conversations.find((conversation) => conversation.ideId === matchingEntry.id)?.sessionId

        if (!targetSessionId) return

        setPendingWorkspaceLaunch(null)
        setMachineActionState('done')
        setMachineActionMessage(`${pendingWorkspaceLaunch.providerType} launched`)
        navigate(`/dashboard?activeTab=${encodeURIComponent(targetSessionId)}`)
    }, [conversations, ides, navigate, pendingWorkspaceLaunch])

    useEffect(() => {
        if (!pendingWorkspaceLaunch) return
        const timeout = window.setTimeout(() => {
            setPendingWorkspaceLaunch((current) => {
                if (!current || current.startedAt !== pendingWorkspaceLaunch.startedAt) return current
                setMachineActionState('error')
                setMachineActionMessage('Launch response timed out. The session may already be running in Dashboard.')
                return null
            })
        }, 45_000)
        return () => window.clearTimeout(timeout)
    }, [pendingWorkspaceLaunch])

    const handleOpenRecent = useCallback(async (machineId: string, session: MachineRecentLaunch) => {
        if (session.kind === 'ide' && session.providerType) {
            await handleLaunchDetectedIde(machineId, session.providerType, {
                workspacePath: session.workspace || null,
            })
            return
        }
        if ((session.kind === 'cli' || session.kind === 'acp') && session.providerType) {
            await handleLaunchWorkspaceProvider(machineId, session.kind, session.providerType, {
                workspacePath: session.workspace || null,
                resumeSessionId: session.providerSessionId || null,
            })
        }
    }, [handleLaunchDetectedIde, handleLaunchWorkspaceProvider])

    return {
        machineAction: {
            state: machineActionState,
            message: machineActionMessage,
        },
        resetMachineAction,
        handleLaunchDetectedIde,
        handleAddWorkspace,
        handleMachineUpgrade,
        handleLaunchWorkspaceProvider,
        handleListSavedSessions,
        handleBrowseDirectory,
        handleOpenRecent,
    }
}
