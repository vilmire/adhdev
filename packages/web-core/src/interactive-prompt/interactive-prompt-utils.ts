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
