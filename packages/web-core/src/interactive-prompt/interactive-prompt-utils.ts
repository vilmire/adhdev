import type { DaemonData } from '../types'
import { isProviderQuestionBinding } from '@adhdev/mesh-shared'
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
  if (record.providerType === 'codex-cli') {
    const validQuestions = record.questions.every(q => q && typeof q.questionId === 'string' && !!q.questionId
      && typeof q.question === 'string' && typeof q.multiSelect === 'boolean' && Array.isArray(q.options)
      && q.options.every(o => o && typeof o.label === 'string' && !!o.label.trim() && (o.description === undefined || typeof o.description === 'string'))
      && new Set(q.options.map(o => o.label)).size === q.options.length)
      && new Set(record.questions.map(q => q?.questionId)).size === record.questions.length
    const validLifecycle = record.lifecycle === 'pending' || record.lifecycle === 'submitted'
    const expectedSupport = record.binding?.transport === 'codex_rpc' ? 'request_bound' : 'product_local'
    if (!validQuestions || !isProviderQuestionBinding(record.binding) || !validLifecycle || typeof record.blocking !== 'boolean'
      || record.support !== expectedSupport) {
      return { ...record, questions: [], support: 'uncertain', lifecycle: 'unknown' } as InteractivePrompt
    }
  }
  return record as InteractivePrompt
}

function readPromptFromEntry(entry: DaemonData): InteractivePrompt | null {
  return normalizeInteractivePromptPrompt(entry.activeInteractivePrompt)
    || normalizeInteractivePromptPrompt((entry.activeChat as { activeInteractivePrompt?: unknown } | null | undefined)?.activeInteractivePrompt)
}

function getEntrySessionId(entry: DaemonData): string {
  return entry.sessionId || entry.instanceId || entry.id
}

export interface FindInteractivePromptOptions {
  /** Restrict the scan to one session — matched against `sessionId`/`instanceId`/`id`. */
  sessionId?: string | null
  /**
   * Allow a `surfaceHidden` entry to be returned. Defaults to FALSE — hidden
   * sessions stay suppressed no matter how the scan is scoped.
   */
  includeHidden?: boolean
}

/**
 * Select the session whose interactive prompt a dashboard should surface.
 *
 * ── Two independent axes ──────────────────────────────────────────────────
 * SCOPE (`sessionId`) — *which* session's prompt to return.
 * POLICY (`includeHidden`) — *whether* a `surfaceHidden` session is eligible.
 *
 * These used to be one parameter: passing a `sessionId` implicitly enabled
 * hidden entries. That made the two unsatisfiable together, because a UI that
 * wants "the selected tab's prompt" must scope the scan, and scoping silently
 * switched hidden suppression off. They are now separate so a caller can scope
 * *and* keep suppression, which is what every dashboard surface actually wants.
 *
 * ── Hidden-session suppression ────────────────────────────────────────────
 * A coordinator-spawned worker (mesh policy `spawnedSessionVisibility:
 * 'hidden'` → `surfaceHidden: true, muted: true`) has no tab, no pane and no
 * ApprovalBanner mount point — yet its choice prompt still rendered as a
 * full-screen modal over the owner's dashboard. Suppression defaults ON.
 *
 * Suppression is deliberately scoped to `surfaceHidden`, not `muted`: mute
 * silences attention side-effects (toast/audio/push) while keeping the session
 * on screen, so a muted-but-visible session must still be answerable here.
 *
 * `includeHidden: true` is for the coordinator's own answer path, which must be
 * able to resolve a hidden worker's prompt by id — suppressing it there would
 * strand the worker waiting forever. It is opt-in precisely so that adding a
 * scope to a user-facing surface can never re-open the leak by accident.
 *
 * ── Unscoped scans ────────────────────────────────────────────────────────
 * With no `sessionId` this is a GLOBAL first-match scan over `ides`, whose
 * order is a status-report merge artifact and therefore unstable. Any surface
 * tied to a user's selection should pass a `sessionId`; an unscoped call will
 * happily render some *other* session's question.
 */
export function findInteractivePromptSession(
  entries: DaemonData[],
  options?: string | null | FindInteractivePromptOptions,
): InteractivePromptSession | null {
  // Legacy positional form `(entries, sessionId)` keeps its original semantics:
  // an explicit id also opted into hidden entries. Callers that want scoping
  // WITHOUT that opt-in pass the options object instead.
  let resolved: FindInteractivePromptOptions
  if (options == null) {
    resolved = {}
  } else if (typeof options === 'string') {
    resolved = { sessionId: options, includeHidden: !!options.trim() }
  } else {
    resolved = options
  }
  const normalizedSessionId = typeof resolved.sessionId === 'string' ? resolved.sessionId.trim() : ''
  const includeHidden = resolved.includeHidden === true
  for (const entry of entries) {
    let prompt = readPromptFromEntry(entry)
    if (!prompt) continue
    const entrySessionId = getEntrySessionId(entry)
    if (prompt.binding) {
      const runtime = (entry as unknown as { runtime?: { runtimeKey?: string; surfaceKind?: string } }).runtime
      if (prompt.binding.sessionId !== entrySessionId || ['offline', 'stopped', 'error'].includes(entry.status)
        || (runtime?.runtimeKey && runtime.runtimeKey !== prompt.binding.generation)
        || (runtime?.surfaceKind && runtime.surfaceKind !== 'live_runtime')) {
        prompt = { ...prompt, support: 'uncertain', lifecycle: 'unknown' }
      }
    }
    if (normalizedSessionId && normalizedSessionId !== entrySessionId && normalizedSessionId !== entry.id) {
      continue
    }
    if (!includeHidden && entry.surfaceHidden === true) {
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
  const answers: InteractivePromptResponse['answers'] = Object.create(null)
  for (const question of prompt.questions) {
    const selected = selection[question.questionId] || {}
    const selectedLabels = Array.from(new Set((selected.selectedLabels || [])
      .map(label => prompt.binding ? label : label.trim())
      .filter(Boolean)))
    const freeformText = selected.freeformText?.trim()
    answers[question.questionId] = {
      selectedLabels,
      ...(freeformText ? { freeformText } : {}),
    }
  }
  return {
    promptId: prompt.promptId,
    ...(prompt.binding ? { binding: prompt.binding } : {}),
    answers,
  }
}
