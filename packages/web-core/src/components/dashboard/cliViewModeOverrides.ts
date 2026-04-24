import type { SessionEntry } from '@adhdev/daemon-core'
import type { Dispatch, SetStateAction } from 'react'
import type { DaemonData } from '../../types'
import { getConversationMachineId, getConversationProviderType } from './conversation-selectors'
import type { ActiveConversation, CliConversationViewMode } from './types'
import { getCliConversationViewMode, isAcpConv, isCliConv } from './types'

export type CliViewModeOverrideMap = Record<string, CliConversationViewMode>

function getCliViewModeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

export function isExpectedCliViewModeTransportError(error: unknown): boolean {
  const message = getCliViewModeErrorMessage(error)
  return message.includes('P2P command timeout')
    || message.includes('P2P not connected')
    || message.includes('P2P channel not open')
    || message.includes('P2P not available')
    || message.includes('P2P data channel closed')
    || message.includes('P2P receiver stopped')
}

export function shouldRetainOptimisticCliViewModeOverrideOnError(error: unknown): boolean {
  const message = getCliViewModeErrorMessage(error)
  return message.includes('P2P command timeout')
    || message.includes('P2P data channel closed')
    || message.includes('P2P receiver stopped')
}

interface SwitchCliConversationViewModeOptions {
  conversation: ActiveConversation | null | undefined
  mode: CliConversationViewMode
  ides: DaemonData[]
  sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
  setCliViewModeOverrides: Dispatch<SetStateAction<CliViewModeOverrideMap>>
}

export async function switchCliConversationViewModeOptimistically({
  conversation,
  mode,
  ides,
  sendDaemonCommand,
  setCliViewModeOverrides,
}: SwitchCliConversationViewModeOptions): Promise<void> {
  if (!conversation || !isCliConv(conversation) || isAcpConv(conversation)) return

  const currentMode = getCliConversationViewMode(conversation)
  if (currentMode === mode) return

  const sessionId = conversation.sessionId
  if (sessionId) {
    setCliViewModeOverrides((prev) => ({ ...prev, [sessionId]: mode }))
  }

  try {
    await sendDaemonCommand(getConversationMachineId(conversation) || conversation.routeId, 'set_cli_view_mode', {
      targetSessionId: conversation.sessionId,
      cliType: getConversationProviderType(conversation),
      mode,
    })
  } catch (error) {
    const shouldRetainOverride = shouldRetainOptimisticCliViewModeOverrideOnError(error)
    if (sessionId && !shouldRetainOverride) {
      setCliViewModeOverrides((prev) => {
        const next = { ...prev }
        if (currentMode === getCliViewModeForSession(ides, sessionId)) {
          delete next[sessionId]
        } else {
          next[sessionId] = currentMode
        }
        return next
      })
    }

    if (!isExpectedCliViewModeTransportError(error)) {
      console.error('Failed to switch CLI view mode:', error)
    } else {
      console.warn(
        shouldRetainOverride
          ? 'CLI view mode result was lost after send; keeping optimistic mode override:'
          : 'Skipped CLI view mode switch:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

function applySessionModeOverride<T extends { id?: string; sessionId?: string; transport?: SessionEntry['transport']; mode?: 'terminal' | 'chat' }>(
  session: T,
  overrides: CliViewModeOverrideMap,
): T {
  const sessionId = typeof session.sessionId === 'string' && session.sessionId
    ? session.sessionId
    : typeof session.id === 'string'
      ? session.id
      : ''
  if (!sessionId || session.transport !== 'pty') return session
  const nextMode = overrides[sessionId]
  if (!nextMode || session.mode === nextMode) return session
  return { ...session, mode: nextMode }
}

export function applyCliViewModeOverrides(
  entries: DaemonData[],
  overrides: CliViewModeOverrideMap,
): DaemonData[] {
  if (!Array.isArray(entries) || entries.length === 0) return entries
  if (!overrides || Object.keys(overrides).length === 0) return entries

  let changed = false
  const next = entries.map((entry) => {
    const nextEntry = applySessionModeOverride(entry, overrides)
    const childSessions = Array.isArray(entry.childSessions)
      ? entry.childSessions.map((child) => applySessionModeOverride(child, overrides))
      : entry.childSessions
    const childChanged = childSessions !== entry.childSessions
    if (nextEntry !== entry || childChanged) {
      changed = true
      return {
        ...nextEntry,
        ...(childChanged ? { childSessions } : {}),
      }
    }
    return entry
  })

  return changed ? next : entries
}

export function getCliViewModeForSession(
  entries: DaemonData[],
  sessionId: string | null | undefined,
): CliConversationViewMode | null {
  if (!sessionId) return null
  for (const entry of entries) {
    if (entry.sessionId === sessionId && entry.transport === 'pty') {
      return entry.mode === 'chat' ? 'chat' : 'terminal'
    }
    for (const child of entry.childSessions || []) {
      if (child.id === sessionId && child.transport === 'pty') {
        return child.mode === 'chat' ? 'chat' : 'terminal'
      }
    }
  }
  return null
}

export function reconcileCliViewModeOverrides(
  overrides: CliViewModeOverrideMap,
  entries: DaemonData[],
): CliViewModeOverrideMap {
  if (!overrides || Object.keys(overrides).length === 0) return overrides

  let changed = false
  const next: CliViewModeOverrideMap = { ...overrides }
  for (const [sessionId, mode] of Object.entries(overrides)) {
    const serverMode = getCliViewModeForSession(entries, sessionId)
    if (serverMode === mode) {
      delete next[sessionId]
      changed = true
    }
  }
  return changed ? next : overrides
}
