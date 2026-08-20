import type { DaemonData } from '../types'
import type { InteractivePrompt, InteractivePromptResponse } from './types'

export interface InteractivePromptSession {
  daemonId: string
  sessionId: string
  routeId: string
  providerType: string
  title?: string
  prompt: InteractivePrompt
}

export type InteractivePromptSelection = Record<string, {
  selectedLabels?: string[]
  freeformText?: string
}>

export function normalizeInteractivePromptPrompt(value: unknown): InteractivePrompt | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<InteractivePrompt>
  if (typeof record.promptId !== 'string' || !record.promptId.trim()) return null
  if (typeof record.providerType !== 'string' || !record.providerType.trim()) return null
  if (!Array.isArray(record.questions) || record.questions.length === 0) return null
  return record as InteractivePrompt
}

function readPromptFromEntry(entry: DaemonData): InteractivePrompt | null {
  return normalizeInteractivePromptPrompt(entry.activeInteractivePrompt)
    || normalizeInteractivePromptPrompt((entry.activeChat as { activeInteractivePrompt?: unknown } | null | undefined)?.activeInteractivePrompt)
}

function getEntrySessionId(entry: DaemonData): string {
  return entry.sessionId || entry.instanceId || entry.id
}

/**
 * Select the session whose interactive prompt the dashboard should surface.
 *
 * ── Hidden-session suppression ────────────────────────────────────────────
 * Without an explicit `sessionId` this is a GLOBAL scan: it returns the first
 * entry anywhere in `ides` that carries a prompt, and Dashboard.tsx calls it
 * exactly that way. A coordinator-spawned worker (mesh policy
 * `spawnedSessionVisibility: 'hidden'` → `surfaceHidden: true, muted: true`)
 * has no tab, no pane and no ApprovalBanner mount point — yet its choice
 * prompt still rendered as a full-screen modal over the owner's dashboard, and
 * could even preempt a visible session's prompt since only the first match is
 * returned. That is the leak this skip closes.
 *
 * Suppression is deliberately scoped to `surfaceHidden`, not `muted`: mute
 * silences attention side-effects (toast/audio/push) while keeping the session
 * on screen, so a muted-but-visible session must still be answerable here.
 *
 * An EXPLICIT `sessionId` overrides the skip — asking for a specific session's
 * prompt is a direct request, and the coordinator's own answer path depends on
 * being able to resolve a hidden worker's prompt by id. Only the unscoped
 * "surface whatever is pending" scan is filtered.
 */
export function findInteractivePromptSession(
  entries: DaemonData[],
  sessionId?: string | null,
): InteractivePromptSession | null {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  for (const entry of entries) {
    const prompt = readPromptFromEntry(entry)
    if (!prompt) continue
    const entrySessionId = getEntrySessionId(entry)
    if (normalizedSessionId && normalizedSessionId !== entrySessionId && normalizedSessionId !== entry.id) {
      continue
    }
    if (!normalizedSessionId && entry.surfaceHidden === true) {
      continue
    }
    const daemonId = entry.daemonId || entry.id.split(':')[0] || entry.id
    return {
      daemonId,
      sessionId: entrySessionId,
      routeId: entry.id,
      providerType: entry.type,
      title: entry.title || entry.cliName || entry.type,
      prompt,
    }
  }
  return null
}

export function buildInteractivePromptResponse(
  prompt: InteractivePrompt,
  selection: InteractivePromptSelection,
): InteractivePromptResponse {
  const answers: InteractivePromptResponse['answers'] = {}
  for (const question of prompt.questions) {
    const selected = selection[question.questionId] || {}
    const selectedLabels = Array.from(new Set((selected.selectedLabels || [])
      .map(label => label.trim())
      .filter(Boolean)))
    const freeformText = selected.freeformText?.trim()
    answers[question.questionId] = {
      selectedLabels,
      ...(freeformText ? { freeformText } : {}),
    }
  }
  return {
    promptId: prompt.promptId,
    answers,
  }
}
