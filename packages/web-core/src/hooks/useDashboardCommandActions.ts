import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { ActiveConversation } from '../components/dashboard/types'
import {
  switchCliConversationViewModeOptimistically,
} from '../components/dashboard/cliViewModeOverrides'
import { browseMachineDirectories, type BrowseDirectoryResult } from '../components/machine/workspaceBrowse'
import type { SavedSessionHistoryEntry } from '../components/dashboard/HistoryModal'
import type { DaemonData } from '../types'
import { isP2PLaunchTimeout } from './useDashboardPendingLaunch'

interface DashboardLaunchTracker {
  machineId: string
  kind: 'ide' | 'cli' | 'acp'
  providerType: string
  workspacePath?: string | null
  resumeSessionId?: string | null
  startedAt: number
}

interface LaunchResult {
  ok: boolean
  error?: string
}

interface LaunchProviderOptions {
  workspaceId?: string | null
  workspacePath?: string | null
  resumeSessionId?: string | null
  cliArgs?: string[]
  initialModel?: string | null
}

interface UseDashboardCommandActionsOptions {
  sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
  trackPendingLaunch: (launch: DashboardLaunchTracker) => void
  onOpenSession: (sessionId: string) => void
  activeConv: ActiveConversation | undefined
  ides: DaemonData[]
  setCliViewModeOverrides: Dispatch<SetStateAction<Record<string, 'chat' | 'terminal'>>>
}

export function useDashboardCommandActions({
  sendDaemonCommand,
  trackPendingLaunch,
  onOpenSession,
  activeConv,
  ides,
  setCliViewModeOverrides,
}: UseDashboardCommandActionsOptions) {
  const handleBrowseMachineDirectory = useCallback(async (machineId: string, path: string): Promise<BrowseDirectoryResult> => (
    browseMachineDirectories(sendDaemonCommand, machineId, path)
  ), [sendDaemonCommand])

  const handleSaveMachineWorkspace = useCallback(async (machineId: string, path: string): Promise<LaunchResult> => {
    if (!path.trim()) return { ok: false, error: 'Choose a workspace path first.' }
    try {
      const res: any = await sendDaemonCommand(machineId, 'workspace_add', { path: path.trim() })
      if (res?.success) return { ok: true }
      return { ok: false, error: res?.error || 'Could not save workspace' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not save workspace' }
    }
  }, [sendDaemonCommand])

  const handleLaunchMachineIde = useCallback(async (
    machineId: string,
    ideType: string,
    opts?: { workspacePath?: string | null },
  ): Promise<LaunchResult> => {
    try {
      const payload: Record<string, unknown> = { ideType, enableCdp: true }
      if (opts?.workspacePath?.trim()) payload.workspace = opts.workspacePath.trim()
      const res: any = await sendDaemonCommand(machineId, 'launch_ide', payload)
      if (!res?.success && res?.success !== undefined) {
        return { ok: false, error: res?.error || 'Could not launch IDE' }
      }
      trackPendingLaunch({
        machineId,
        kind: 'ide',
        providerType: ideType,
        workspacePath: opts?.workspacePath || null,
        startedAt: Date.now(),
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not launch IDE' }
    }
  }, [sendDaemonCommand, trackPendingLaunch])

  const handleLaunchMachineProvider = useCallback(async (
    machineId: string,
    kind: 'cli' | 'acp',
    providerType: string,
    opts?: LaunchProviderOptions,
  ): Promise<LaunchResult> => {
    const startedAt = Date.now()
    try {
      const payload: Record<string, unknown> = { cliType: providerType }
      if (opts?.workspacePath?.trim()) payload.dir = opts.workspacePath.trim()
      else if (opts?.workspaceId) payload.workspaceId = opts.workspaceId
      if (opts?.resumeSessionId?.trim()) payload.resumeSessionId = opts.resumeSessionId.trim()
      if (Array.isArray(opts?.cliArgs) && opts.cliArgs.length > 0) payload.cliArgs = opts.cliArgs
      if (opts?.initialModel?.trim()) payload.initialModel = opts.initialModel.trim()
      const res: any = await sendDaemonCommand(machineId, 'launch_cli', payload)
      const result = res?.result || res
      const launchedSessionId = result?.sessionId || result?.id
      if (res?.success && launchedSessionId) {
        onOpenSession(launchedSessionId)
        return { ok: true }
      }
      if (res?.success) {
        trackPendingLaunch({
          machineId,
          kind,
          providerType,
          workspacePath: opts?.workspacePath || null,
          resumeSessionId: opts?.resumeSessionId || null,
          startedAt,
        })
        return { ok: true }
      }
      return { ok: false, error: res?.error || result?.error || `Could not launch ${kind.toUpperCase()} session` }
    } catch (error) {
      if (isP2PLaunchTimeout(error)) {
        trackPendingLaunch({
          machineId,
          kind,
          providerType,
          workspacePath: opts?.workspacePath || null,
          resumeSessionId: opts?.resumeSessionId || null,
          startedAt,
        })
        return { ok: true }
      }
      return { ok: false, error: error instanceof Error ? error.message : `Could not launch ${kind.toUpperCase()} session` }
    }
  }, [onOpenSession, sendDaemonCommand, trackPendingLaunch])

  const handleListMachineSavedSessions = useCallback(async (
    machineId: string,
    providerType: string,
  ): Promise<SavedSessionHistoryEntry[]> => {
    if (!machineId || !providerType) return []
    try {
      const raw: any = await sendDaemonCommand(machineId, 'list_saved_sessions', {
        providerType,
        kind: 'cli',
        limit: 30,
      })
      const result = raw?.result ?? raw
      return Array.isArray(result?.sessions) ? result.sessions : []
    } catch (error) {
      console.error('List saved sessions failed', error)
      return []
    }
  }, [sendDaemonCommand])

  const setActiveCliViewMode = useCallback(async (mode: 'chat' | 'terminal') => {
    await switchCliConversationViewModeOptimistically({
      conversation: activeConv,
      mode,
      ides,
      sendDaemonCommand,
      setCliViewModeOverrides,
    })
  }, [activeConv, ides, sendDaemonCommand, setCliViewModeOverrides])

  return {
    handleBrowseMachineDirectory,
    handleSaveMachineWorkspace,
    handleLaunchMachineIde,
    handleLaunchMachineProvider,
    handleListMachineSavedSessions,
    setActiveCliViewMode,
  }
}
