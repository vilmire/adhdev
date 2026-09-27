/**
 * useMachineActions — Extracted action handlers for MachineDetail.
 *
 * Groups all async command handlers (launch/stop/restart/workspace/nickname)
 * into a single hook. Each tab can call these without managing the state themselves.
 */
import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatIdeType } from '../../utils/daemon-utils'
import { describeToastError, eventManager } from '../../managers/EventManager'
import type { LogEntry, IdeSessionEntry } from './types'
import { useLaunchCli } from '../../context/LaunchCliContext'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'

export interface LaunchPickState {
    cliType: string
    argsStr?: string
    model?: string
}

interface LaunchCliResult {
    success: false
    pending?: boolean
    sessionId?: string | undefined
}

interface LaunchCliSuccessResult {
    success: true
    pending?: false
    sessionId?: string | undefined
}

type LaunchCliCoreResult = LaunchCliResult | LaunchCliSuccessResult

interface UseMachineActionsOpts {
    machineId: string | undefined
    registeredMachineId?: string | null
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onNicknameSynced?: (args: { machineRuntimeId: string; registeredMachineId?: string | null; nickname: string }) => Promise<void>
    logsEndRef: React.RefObject<HTMLDivElement | null>
}

export function useMachineActions({ machineId, registeredMachineId, sendDaemonCommand, onNicknameSynced, logsEndRef }: UseMachineActionsOpts) {
    const { t } = useTranslation('common')
    const { launchCli } = useLaunchCli()
    // In-app confirm (window.confirm is auto-dismissed in embedded browsers).
    // The consuming page must render `confirmDialog` once in its JSX.
    const { confirm, confirmDialog } = useConfirmDialog()
    const [logs, setLogs] = useState<LogEntry[]>([])
    const [launchingIde, setLaunchingIde] = useState<string | null>(null)
    const [launchingAgentType, setLaunchingAgentType] = useState<string | null>(null)
    const [workspaceBusy, setWorkspaceBusy] = useState(false)
    const [launchPick, setLaunchPick] = useState<LaunchPickState | null>(null)
    const [editingNickname, setEditingNickname] = useState(false)
    const [nicknameInput, setNicknameInput] = useState('')

    // Callbacks for cross-tab state (e.g. setting CLI/ACP launch dirs).
    // Tabs register these via setOnDefaultWorkspaceChanged.
    const onDefaultWorkspaceChangedRef = useRef<((path: string) => void) | null>(null)
    const setOnDefaultWorkspaceChanged = useCallback((fn: ((path: string) => void) | null) => {
        onDefaultWorkspaceChangedRef.current = fn
    }, [])

    /**
     * Log a machine action and optionally toast it. `details` is the raw
     * daemon/transport error: the toast shows the short localized `message`
     * and keeps the raw text behind its "Details" expander; the action log
     * records both.
     */
    const addLog = useCallback((level: LogEntry['level'], message: string, showToast = false, details?: unknown) => {
        const detailText = describeToastError(details)
        const logMessage = detailText && detailText !== message ? `${message} — ${detailText}` : message
        setLogs(prev => [...prev.slice(-100), { timestamp: Date.now(), level, message: logMessage }])
        setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
        if (showToast) {
            if (level === 'error' || level === 'warn') eventManager.showErrorToast(message, details)
            else eventManager.showToast(message, 'success')
        }
    }, [logsEndRef])

    const isTransientLaunchTimeout = useCallback((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error || '')
        return message.includes('P2P command timeout')
            || message.includes('P2P not connected')
            || message.includes('P2P not available')
    }, [])

    const handleLaunchIde = useCallback(async (ideType: string, opts?: { workspace?: string; useDefaultWorkspace?: boolean }) => {
        if (!machineId || launchingIde) return false
        setLaunchingIde(ideType)
        addLog('info', t('machine.actions.launching', { name: formatIdeType(ideType) }))
        try {
            const body: Record<string, unknown> = { ideType, enableCdp: true }
            if (opts?.workspace?.trim()) body.workspace = opts.workspace.trim()
            else if (opts?.useDefaultWorkspace) body.useDefaultWorkspace = true
            const res: any = await sendDaemonCommand(machineId, 'launch_ide', body)
            if (res?.success) addLog('info', t('machine.actions.launched', { name: formatIdeType(ideType) }), true)
            else addLog('error', t('machine.actions.launchFailed', { name: formatIdeType(ideType) }), true, res?.error)
            return !!res?.success
        } catch (e: any) {
            addLog('error', t('machine.actions.launchFailed', { name: formatIdeType(ideType) }), true, e)
            return false
        }
        finally { setLaunchingIde(null) }
    }, [machineId, launchingIde, addLog, sendDaemonCommand, t])

    const runLaunchCliCore = useCallback(async (opts: {
        cliType: string; dir?: string; workspaceId?: string
        useDefaultWorkspace?: boolean; useHome?: boolean; argsStr?: string; model?: string; resumeSessionId?: string
    }): Promise<LaunchCliCoreResult> => {
        if (!machineId) return { success: false as const }
        const { cliType, dir, workspaceId, useDefaultWorkspace, useHome, argsStr, model, resumeSessionId } = opts
        if (!cliType) {
            addLog('warn', t('machine.actions.selectProviderFirst'), true)
            return { success: false as const }
        }
        const cliArgs = argsStr ? argsStr.split(/\s+/).filter(Boolean) : undefined
        const dirHint = dir?.trim() || (workspaceId ? `(saved id)` : useDefaultWorkspace ? '(default workspace)' : useHome ? '(home)' : '')
        addLog('info', t('machine.actions.launching', { name: cliType }), false, [dirHint, model].filter(Boolean).join(' · ') || undefined)
        setLaunchingAgentType(cliType)
        try {
            const body: Record<string, unknown> = { cliType, cliArgs, initialModel: model || undefined }
            if (dir?.trim()) body.dir = dir.trim()
            else if (workspaceId) body.workspaceId = workspaceId
            else if (useDefaultWorkspace) body.useDefaultWorkspace = true
            else if (useHome) body.useHome = true
            if (resumeSessionId) body.resumeSessionId = resumeSessionId
            const res: any = await launchCli(machineId, body)
            const payload = res?.result || res
            if (res?.success) {
                addLog('info', t('machine.actions.launched', { name: cliType }), true)
                if (payload?.launchSource === 'home') addLog('info', t('machine.actions.runningInHome'))
                else if (payload?.launchSource === 'defaultWorkspace') addLog('info', t('machine.actions.usingDefaultWorkspace'))
                return { success: true as const, sessionId: payload?.sessionId as string | undefined }
            } else {
                addLog('error', t('machine.actions.launchFailed', { name: cliType }), true, res?.error || payload?.error)
                if (res?.code === 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED') setLaunchPick({ cliType, argsStr, model })
                return { success: false as const, sessionId: payload?.sessionId as string | undefined }
            }
        } catch (e: any) {
            if (isTransientLaunchTimeout(e)) {
                addLog('warn', t('machine.actions.launchPending', { name: cliType }), true)
                return { success: false as const, pending: true }
            }
            addLog('error', t('machine.actions.launchFailed', { name: cliType }), true, e)
            return { success: false as const }
        } finally {
            setLaunchingAgentType(null)
        }
    }, [machineId, addLog, isTransientLaunchTimeout, sendDaemonCommand, t])

    const handleLaunchCli = useCallback(async (cliType: string, dir: string, argsStr?: string, model?: string) => {
        if (!machineId) return { success: false as const }
        if (!cliType) {
            addLog('warn', t('machine.actions.selectProvider'), true)
            return { success: false as const }
        }
        if (!dir.trim()) {
            setLaunchPick({ cliType, argsStr, model })
            return { success: false as const }
        }
        return runLaunchCliCore({ cliType, dir, argsStr, model })
    }, [machineId, addLog, runLaunchCliCore, t])

    const handleStopCli = useCallback(async (cliType: string, dir: string, entryId?: string) => {
        if (!machineId) return
        if (!(await confirm({
            title: t('cliStop.title', { agent: cliType }),
            description: t('machine.actions.stopCliConfirmDescription'),
            confirmLabel: t('cliStop.stop'),
            tone: 'danger',
        }))) return
        try {
            const res: any = await sendDaemonCommand(machineId, 'stop_cli', { cliType, dir, targetSessionId: entryId })
            if (res?.success) addLog('info', t('machine.actions.stopped', { name: cliType }), true)
            else addLog('error', t('machine.actions.stopFailed'), true, res?.error)
        } catch (e: any) { addLog('error', t('machine.actions.stopFailed'), true, e) }
    }, [machineId, addLog, confirm, sendDaemonCommand, t])

    const handleRestartIde = useCallback(async (ide: IdeSessionEntry) => {
        try {
            await sendDaemonCommand(ide.daemonId, 'restart_ide', { ideType: ide.type })
            addLog('info', t('machine.actions.restartInitiated', { name: formatIdeType(ide.type) }), true)
        } catch (e: any) { addLog('error', t('machine.actions.restartFailed'), true, e) }
    }, [addLog, sendDaemonCommand, t])

    const handleStopIde = useCallback(async (ide: IdeSessionEntry) => {
        if (!(await confirm({
            title: t('cliStop.title', { agent: formatIdeType(ide.type) }),
            description: t('machine.actions.stopIdeConfirmDescription'),
            confirmLabel: t('cliStop.stop'),
            tone: 'danger',
        }))) return
        try {
            const res: any = await sendDaemonCommand(ide.daemonId, 'stop_ide', { ideType: ide.type, killProcess: true })
            if (res?.success) addLog('info', t('machine.actions.stopped', { name: formatIdeType(ide.type) }), true)
            else addLog('error', t('machine.actions.stopFailed'), true, res?.error)
        } catch (e: any) { addLog('error', t('machine.actions.stopFailed'), true, e) }
    }, [addLog, confirm, sendDaemonCommand, t])

    const handleDetectIdes = useCallback(async () => {
        if (!machineId) return
        try {
            const res: any = await sendDaemonCommand(machineId, 'detect_ides', {})
            addLog('info', t('machine.actions.idesFound', { count: (res?.result || []).length }), true)
        } catch (e: any) { addLog('error', t('machine.actions.detectFailed'), true, e) }
    }, [machineId, addLog, sendDaemonCommand, t])

    const handleWorkspaceAdd = useCallback(async (path: string) => {
        if (!machineId || !path.trim()) return false
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_add', { path: path.trim() })
            if (res?.success) {
                addLog('info', t('machine.actions.workspaceAdded'), false, path.trim())
                return true
            }
            addLog('error', t('machine.actions.workspaceActionFailed'), false, res?.error)
            return false
        } catch (e: any) {
            addLog('error', t('machine.actions.workspaceActionFailed'), false, e)
            return false
        }
        finally { setWorkspaceBusy(false) }
    }, [machineId, addLog, sendDaemonCommand, t])

    // Confirmation is the caller's job (inline two-step button in
    // ManagedWorkspacesSection) — window.confirm is silently auto-dismissed in
    // embedded/webview browsers, which made this a no-op there.
    const handleWorkspaceRemove = useCallback(async (id: string) => {
        if (!machineId) return
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_remove', { id })
            if (res?.success) addLog('info', t('machine.actions.workspaceRemoved'), true)
            else addLog('error', t('machine.actions.workspaceActionFailed'), true, res?.error)
        } catch (e: any) { addLog('error', t('machine.actions.workspaceActionFailed'), true, e) }
        finally { setWorkspaceBusy(false) }
    }, [machineId, addLog, sendDaemonCommand, t])

    const handleWorkspaceSetDefault = useCallback(async (id: string | null) => {
        if (!machineId) return
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_set_default',
                id === null ? { clear: true } : { id })
            if (res?.success) {
                addLog('info', id ? t('machine.actions.defaultWorkspaceUpdated') : t('machine.actions.defaultWorkspaceCleared'), true)
                const dp = typeof res.defaultWorkspacePath === 'string' ? res.defaultWorkspacePath : ''
                if (dp) onDefaultWorkspaceChangedRef.current?.(dp)
            }
            else addLog('error', t('machine.actions.workspaceActionFailed'), true, res?.error)
        } catch (e: any) { addLog('error', t('machine.actions.workspaceActionFailed'), true, e) }
        finally { setWorkspaceBusy(false) }
    }, [machineId, addLog, sendDaemonCommand, t])

    const handleWorkspaceSetLabel = useCallback(async (path: string, label: string) => {
        if (!machineId || !path.trim()) return false
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_set_label', {
                path: path.trim(),
                label,
            })
            if (res?.success) {
                await sendDaemonCommand(machineId, 'workspace_list', {})
                addLog('info', t('machine.actions.workspaceLabelUpdated'), true)
                return true
            }
            addLog('error', t('machine.managedWorkspaces.renameFailed'), true, res?.error)
            return false
        } catch (e: any) {
            addLog('error', t('machine.managedWorkspaces.renameFailed'), true, e)
            return false
        } finally {
            setWorkspaceBusy(false)
        }
    }, [machineId, addLog, sendDaemonCommand, t])

    const handleWorkspaceResumePath = useCallback(async (absPath: string) => {
        if (!machineId || !absPath.trim()) return
        const p = absPath.trim()
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_set_default', { path: p })
            if (res?.success) {
                addLog('info', t('machine.actions.defaultWorkspaceUpdated'))
                onDefaultWorkspaceChangedRef.current?.(p)
            }
            else addLog('error', t('machine.actions.workspaceActionFailed'), false, res?.error || t('machine.actions.pathMissing'))
        } catch (e: any) { addLog('error', t('machine.actions.workspaceActionFailed'), false, e) }
        finally { setWorkspaceBusy(false) }
    }, [machineId, addLog, sendDaemonCommand, t])

    const handleSaveNickname = useCallback(async () => {
        if (!machineId) return
        try {
            await sendDaemonCommand(machineId, 'set_machine_nickname', { nickname: nicknameInput })
            if (onNicknameSynced) {
                try {
                    await onNicknameSynced({
                        machineRuntimeId: machineId,
                        registeredMachineId,
                        nickname: nicknameInput,
                    })
                } catch (e: any) {
                    addLog('warn', t('machine.actions.nicknameSyncFailed'), false, e)
                }
            }
            addLog('info', t('machine.actions.nicknameSaved'))
            setEditingNickname(false)
        } catch (e: any) { addLog('error', t('machine.actions.nicknameFailed'), true, e) }
    }, [machineId, nicknameInput, registeredMachineId, addLog, onNicknameSynced, sendDaemonCommand, t])

    return {
        // State
        logs, launchingIde, launchingAgentType, workspaceBusy,
        launchPick, setLaunchPick,
        editingNickname, setEditingNickname,
        nicknameInput, setNicknameInput,
        // Actions
        addLog,
        handleLaunchIde, runLaunchCliCore, handleLaunchCli,
        handleStopCli, handleRestartIde, handleStopIde, handleDetectIdes,
        handleWorkspaceAdd, handleWorkspaceRemove,
        handleWorkspaceSetDefault, handleWorkspaceSetLabel, handleWorkspaceResumePath,
        handleSaveNickname,
        // Must be rendered once by the consuming page for confirm() to show.
        confirmDialog,
        setOnDefaultWorkspaceChanged,
    }
}
