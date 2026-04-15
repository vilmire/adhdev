import type { SessionEntry } from '@adhdev/daemon-core'
import type { DaemonData } from '../../types'
import type { CliConversationViewMode } from './types'

type CliViewModeOverrideMap = Record<string, CliConversationViewMode>

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
