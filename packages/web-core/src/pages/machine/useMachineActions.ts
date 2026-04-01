/**
 * useMachineActions — Extracted action handlers for MachineDetail.
 *
 * Groups all async command handlers (launch/stop/restart/workspace/nickname)
 * into a single hook. Each tab can call these without managing the state themselves.
 */
import { useState, useCallback, useRef } from 'react'
import { formatIdeType } from '../../utils/daemon-utils'
import { eventManager } from '../../managers/EventManager'
import type { LogEntry, IdeSessionEntry } from './types'

export interface LaunchPickState {
    cliType: string
    argsStr?: string
    model?: string
}

interface UseMachineActionsOpts {
    machineId: string | undefined
    registeredMachineId?: string | null
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onNicknameSynced?: (args: { machineRuntimeId: string; registeredMachineId?: string | null; nickname: string }) => Promise<void>
    logsEndRef: React.RefObject<HTMLDivElement | null>
}

export function useMachineActions({ machineId, registeredMachineId, sendDaemonCommand, onNicknameSynced, logsEndRef }: UseMachineActionsOpts) {
    const [logs, setLogs] = useState<LogEntry[]>([])
    const [launchingIde, setLaunchingIde] = useState<string | null>(null)
    const [launchingAgentType, setLaunchingAgentType] = useState<string | null>(null)
    const [loadingWorkspaces, setLoadingWorkspaces] = useState(false)
    const [workspaceBusy, setWorkspaceBusy] = useState(false)
    const [loadingHistory, setLoadingHistory] = useState(false)
    const [cliHistory, setCliHistory] = useState<any[]>([])
    const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([])
    const [launchPick, setLaunchPick] = useState<LaunchPickState | null>(null)
    const [editingNickname, setEditingNickname] = useState(false)
    const [nicknameInput, setNicknameInput] = useState('')

    // Callbacks for cross-tab state (e.g. setting CLI/ACP launch dirs).
    // Tabs register these via setOnDefaultWorkspaceChanged.
    const onDefaultWorkspaceChangedRef = useRef<((path: string) => void) | null>(null)
    const setOnDefaultWorkspaceChanged = useCallback((fn: ((path: string) => void) | null) => {
        onDefaultWorkspaceChangedRef.current = fn
    }, [])

    const addLog = useCallback((level: LogEntry['level'], message: string, showToast = false) => {
        setLogs(prev => [...prev.slice(-100), { timestamp: Date.now(), level, message }])
        setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
        if (showToast) {
            eventManager.showToast(message, level === 'error' ? 'warning' : level === 'warn' ? 'warning' : 'success')
        }
    }, [logsEndRef])

    const handleLaunchIde = useCallback(async (ideType: string, opts?: { workspace?: string; useDefaultWorkspace?: boolean }) => {
        if (!machineId || launchingIde) return false
        setLaunchingIde(ideType)
        addLog('info', `Launching ${formatIdeType(ideType)}${opts?.workspace ? ` in ${opts.workspace}` : ''}...`)
        try {
            const body: Record<string, unknown> = { ideType, enableCdp: true }
            if (opts?.workspace?.trim()) body.workspace = opts.workspace.trim()
            else if (opts?.useDefaultWorkspace) body.useDefaultWorkspace = true
            const res: any = await sendDaemonCommand(machineId, 'launch_ide', body)
            addLog(res?.success ? 'info' : 'error', res?.success ? `${formatIdeType(ideType)} launched` : `Failed: ${res?.error}`, true)
            return !!res?.success
        } catch (e: any) {
            addLog('error', `Launch error: ${e.message}`, true)
            return false
        }
        finally { setLaunchingIde(null) }
    }, [machineId, launchingIde, addLog, sendDaemonCommand])

    const runLaunchCliCore = useCallback(async (opts: {
        cliType: string; dir?: string; workspaceId?: string
        useDefaultWorkspace?: boolean; useHome?: boolean; argsStr?: string; model?: string
    }) => {
        if (!machineId) return { success: false as const }
        const { cliType, dir, workspaceId, useDefaultWorkspace, useHome, argsStr, model } = opts
        if (!cliType) {
            addLog('warn', 'Select a CLI or ACP provider first', true)
            return { success: false as const }
        }
        const cliArgs = argsStr ? argsStr.split(/\s+/).filter(Boolean) : undefined
        const dirHint = dir?.trim() || (workspaceId ? `(saved id)` : useDefaultWorkspace ? '(default workspace)' : useHome ? '(home)' : '')
        addLog('info', `Launching ${cliType}${dirHint ? ` in ${dirHint}` : ''}${model ? ` (model: ${model})` : ''}...`)
        setLaunchingAgentType(cliType)
        try {
            const body: Record<string, unknown> = { cliType, cliArgs, initialModel: model || undefined }
            if (dir?.trim()) body.dir = dir.trim()
            else if (workspaceId) body.workspaceId = workspaceId
            else if (useDefaultWorkspace) body.useDefaultWorkspace = true
            else if (useHome) body.useHome = true
            const res: any = await sendDaemonCommand(machineId, 'launch_cli', body)
            const payload = res?.result || res
            if (res?.success) {
                addLog('info', `${cliType} launched`, true)
                if (payload?.launchSource === 'home') addLog('info', `📂 Running in home directory (explicit choice)`)
                else if (payload?.launchSource === 'defaultWorkspace') addLog('info', `📂 Using default workspace (explicit choice)`)
                return { success: true as const, sessionId: payload?.sessionId as string | undefined }
            } else {
                addLog('error', `Failed: ${res?.error || payload?.error}`, true)
                if (res?.code === 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED') setLaunchPick({ cliType, argsStr, model })
                return { success: false as const, sessionId: payload?.sessionId as string | undefined }
            }
        } catch (e: any) {
            addLog('error', `Launch error: ${e.message}`, true)
            return { success: false as const }
        } finally {
            setLaunchingAgentType(null)
        }
    }, [machineId, addLog, sendDaemonCommand])

    const handleLaunchCli = useCallback(async (cliType: string, dir: string, argsStr?: string, model?: string) => {
        if (!machineId) return { success: false as const }
        if (!cliType) {
            addLog('warn', 'Select a provider', true)
            return { success: false as const }
        }
        if (!dir.trim()) {
            setLaunchPick({ cliType, argsStr, model })
            return { success: false as const }
        }
        return runLaunchCliCore({ cliType, dir, argsStr, model })
    }, [machineId, addLog, runLaunchCliCore])

    const handleStopCli = useCallback(async (cliType: string, dir: string, entryId?: string) => {
        if (!machineId) return
        if (!window.confirm(`Stop ${cliType}?\nThis will terminate the process.`)) return
        try {
            const res: any = await sendDaemonCommand(machineId, 'stop_cli', { cliType, dir, targetSessionId: entryId })
            if (res?.success) addLog('info', `${cliType} stopped`, true)
            else addLog('error', `Stop failed: ${res?.error || 'Unknown error'}`, true)
        } catch (e: any) { addLog('error', `Stop failed: ${e.message}`, true) }
    }, [machineId, addLog, sendDaemonCommand])

    const handleRestartIde = useCallback(async (ide: IdeSessionEntry) => {
        try {
            await sendDaemonCommand(ide.daemonId, 'restart_ide', { ideType: ide.type })
            addLog('info', `${formatIdeType(ide.type)} restart initiated`, true)
        } catch (e: any) { addLog('error', `Restart failed: ${e.message}`, true) }
    }, [addLog, sendDaemonCommand])

    const handleStopIde = useCallback(async (ide: IdeSessionEntry) => {
        if (!window.confirm(`Stop ${formatIdeType(ide.type)}?\nThis will disconnect CDP and optionally kill the process.`)) return
        try {
            const res: any = await sendDaemonCommand(ide.daemonId, 'stop_ide', { ideType: ide.type, killProcess: true })
            if (res?.success) addLog('info', `${formatIdeType(ide.type)} stopped`, true)
            else addLog('error', `Stop failed: ${res?.error || 'Unknown error'}`, true)
        } catch (e: any) { addLog('error', `Stop failed: ${e.message}`, true) }
    }, [addLog, sendDaemonCommand])

    const handleDetectIdes = useCallback(async () => {
        if (!machineId) return
        try {
            const res: any = await sendDaemonCommand(machineId, 'detect_ides', {})
            addLog('info', `Found ${(res?.result || []).length} IDE(s)`, true)
        } catch (e: any) { addLog('error', `Detection failed: ${e.message}`, true) }
    }, [machineId, addLog, sendDaemonCommand])

    const handleLoadRecentWorkspaces = useCallback(async () => {
        if (!machineId) return
        setLoadingWorkspaces(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'get_recent_workspaces', {})
            if (res?.success && Array.isArray(res?.result)) setRecentWorkspaces(res.result)
        } catch (e: any) { addLog('error', `Failed: ${e.message}`) }
        finally { setLoadingWorkspaces(false) }
    }, [machineId, addLog, sendDaemonCommand])

    const handleWorkspaceAdd = useCallback(async (path: string) => {
        if (!machineId || !path.trim()) return
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_add', { path: path.trim() })
            if (res?.success) addLog('info', `Workspace added: ${path.trim()}`)
            else addLog('error', res?.error || 'workspace_add failed')
        } catch (e: any) { addLog('error', e.message) }
        finally { setWorkspaceBusy(false) }
        return true
    }, [machineId, addLog, sendDaemonCommand])

    const handleWorkspaceRemove = useCallback(async (id: string) => {
        if (!machineId || !window.confirm('Remove this workspace from the list?')) return
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_remove', { id })
            if (res?.success) addLog('info', 'Workspace removed', true)
            else addLog('error', res?.error || 'workspace_remove failed', true)
        } catch (e: any) { addLog('error', e.message, true) }
        finally { setWorkspaceBusy(false) }
    }, [machineId, addLog, sendDaemonCommand])

    const handleWorkspaceSetDefault = useCallback(async (id: string | null) => {
        if (!machineId) return
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_set_default',
                id === null ? { clear: true } : { id })
            if (res?.success) {
                addLog('info', id ? 'Default workspace updated' : 'Default workspace cleared', true)
                const dp = typeof res.defaultWorkspacePath === 'string' ? res.defaultWorkspacePath : ''
                if (dp) onDefaultWorkspaceChangedRef.current?.(dp)
            }
            else addLog('error', res?.error || 'workspace_set_default failed', true)
        } catch (e: any) { addLog('error', e.message, true) }
        finally { setWorkspaceBusy(false) }
    }, [machineId, addLog, sendDaemonCommand])

    const handleWorkspaceResumePath = useCallback(async (absPath: string) => {
        if (!machineId || !absPath.trim()) return
        const p = absPath.trim()
        setWorkspaceBusy(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'workspace_set_default', { path: p })
            if (res?.success) {
                addLog('info', 'Default workspace set from history')
                onDefaultWorkspaceChangedRef.current?.(p)
            }
            else addLog('error', res?.error || 'Could not set default (path missing on disk?)')
        } catch (e: any) { addLog('error', e.message) }
        finally { setWorkspaceBusy(false) }
    }, [machineId, addLog, sendDaemonCommand])

    const loadCliHistory = useCallback(async () => {
        if (!machineId) return
        setLoadingHistory(true)
        try {
            const res: any = await sendDaemonCommand(machineId, 'get_cli_history', {})
            const hist = res?.history ?? res?.result?.history
            if (res?.success && Array.isArray(hist)) setCliHistory(hist)
        } catch { }
        setLoadingHistory(false)
    }, [machineId, sendDaemonCommand])

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
                    addLog('warn', `Live nickname updated, but account sync failed: ${e.message}`)
                }
            }
            addLog('info', `Nickname set to "${nicknameInput || '(cleared)'}"`)
            setEditingNickname(false)
        } catch (e: any) { addLog('error', `Failed: ${e.message}`) }
    }, [machineId, nicknameInput, registeredMachineId, addLog, onNicknameSynced, sendDaemonCommand])

    return {
        // State
        logs, launchingIde, launchingAgentType, loadingWorkspaces, workspaceBusy,
        loadingHistory, cliHistory, recentWorkspaces,
        launchPick, setLaunchPick,
        editingNickname, setEditingNickname,
        nicknameInput, setNicknameInput,
        // Actions
        addLog,
        handleLaunchIde, runLaunchCliCore, handleLaunchCli,
        handleStopCli, handleRestartIde, handleStopIde, handleDetectIdes,
        handleLoadRecentWorkspaces,
        handleWorkspaceAdd, handleWorkspaceRemove,
        handleWorkspaceSetDefault, handleWorkspaceResumePath,
        loadCliHistory, handleSaveNickname,
        setOnDefaultWorkspaceChanged,
    }
}
