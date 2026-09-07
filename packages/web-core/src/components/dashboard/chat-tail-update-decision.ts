// Pure move out of session-chat-tail-controller.ts (file-size gate, 2026-09-07):
// the single-decision-point logic for whether an incoming chat-tail update is
// applied, deferred, or skipped. Every export here is a pure function of its
// arguments — no controller instance state — so `handleUpdate` in the
// controller is the only consumer and this module has no reason to import
// anything from it.
import { buildChatMessageSignature } from '@adhdev/daemon-core/chat/chat-signatures'
import type { SessionChatTailUpdate } from '@adhdev/daemon-core'
import type { DashboardMessage } from './types'
import type { SessionChatTailCursor, SessionChatTailSnapshot } from './session-chat-tail-controller'
import { isBusyChatTailStatus, shouldGuardTailShrinkForStatus } from './chat-tail-status-classification'

export const DEFAULT_TAIL_LIMIT = 60

export function buildLastMessageSignature(message: DashboardMessage | null | undefined): string {
  return buildChatMessageSignature(message)
}

export function buildReadChatCursor(_messages: DashboardMessage[], tailLimit = DEFAULT_TAIL_LIMIT): SessionChatTailCursor {
  return { tailLimit }
}

export function buildChatSnapshotSignature(messages: DashboardMessage[], status?: string): string {
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage) return `empty:${status || ''}`

  let content = ''
  try {
    content = JSON.stringify(lastMessage.content ?? '')
  } catch {
    content = String(lastMessage.content ?? '')
  }

  return [
    status || '',
    messages.length,
    String(lastMessage.id || ''),
    String(lastMessage.index ?? ''),
    String(lastMessage.receivedAt ?? lastMessage.timestamp ?? ''),
    content,
  ].join('|')
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    return content.map(flattenMessageContent).join('\n')
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>
    return flattenMessageContent(record.text ?? record.content ?? record.value ?? '')
  }
  return String(content)
}

function isNonSubstantiveChatMessage(message: DashboardMessage): boolean {
  const text = flattenMessageContent((message as { content?: unknown }).content)
  const withoutChrome = text.replace(/[─━═│┃┄┅┈┉┌┐└┘├┤┬┴┼╭╮╰╯╴╶╷╵\s]+/g, '')
  return withoutChrome.length === 0
}

function isTransientNonSubstantiveTail(messages: DashboardMessage[]): boolean {
  return messages.length === 0 || messages.every(isNonSubstantiveChatMessage)
}

/**
 * The role of the LAST substantive (non-empty, non-chrome) message in a tail, or
 * '' when the tail has no substantive message. System/tool bubbles do not gate a
 * turn — walk past them — so this reports whether the human-visible tail ends on
 * an assistant answer or is still sitting on the user prompt.
 */
function lastSubstantiveRole(messages: DashboardMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; kind?: unknown }
    const role = typeof message?.role === 'string' ? message.role : ''
    const kind = typeof message?.kind === 'string' ? message.kind : ''
    if (role === 'system' || kind === 'system') continue
    if (kind === 'tool' || kind === 'thought' || kind === 'terminal' || kind === 'activity') continue
    if (isNonSubstantiveChatMessage(messages[i])) continue
    return role
  }
  return ''
}

/**
 * Stable identity of the LAST substantive assistant bubble in a tail, or '' when
 * the tail has no substantive assistant. Keyed on the bubble's durable identity
 * (bubbleId / providerUnitKey / id) plus a flattened content hash — deliberately
 * NOT on volatile per-tick fields (timestamps of unchanged bubbles), so it stays
 * stable across identical repeat snapshots and only changes when the substantive
 * assistant answer itself is added or replaced.
 *
 * Folded into the unchanged-signature short-circuit so a user-only → [user,
 * assistant] transition (which buildChatSnapshotSignature can miss when the two
 * tails happen to share a last message / length) always has a DISTINCT signature
 * and is never suppressed as a no-op (D6 transition-window race, cause (a)).
 */
export function lastSubstantiveAssistantIdentity(messages: DashboardMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; kind?: unknown }
    const role = typeof message?.role === 'string' ? message.role : ''
    const kind = typeof message?.kind === 'string' ? message.kind : ''
    if (role === 'system' || kind === 'system') continue
    if (kind === 'tool' || kind === 'thought' || kind === 'terminal' || kind === 'activity') continue
    if (isNonSubstantiveChatMessage(messages[i])) continue
    if (role !== 'assistant') return ''
    const record = messages[i] as unknown as Record<string, unknown>
    const identity = String(record.bubbleId ?? record.providerUnitKey ?? record.id ?? '')
    return `${identity}#${flattenMessageContent(record.content).length}`
  }
  return ''
}

/**
 * True when the incoming tail delivers an assistant answer that the current
 * snapshot does not yet show — i.e. its last substantive bubble is `assistant`
 * while the snapshot's is not. Such a tail is real forward progress even when it
 * is SHORTER than the on-screen tail (the daemon's finalized native-history tail
 * is routinely shorter than the busy-phase PTY/partial tail it replaces, because
 * chrome/duplicate bubbles collapse). The shrink-defense must never defer it:
 * deferring here is exactly what strands an antigravity/MAGI session showing only
 * the user prompt until a full-page reload rebuilds the snapshot from scratch.
 */
function tailDeliversNewAssistantAnswer(
  snapshot: SessionChatTailSnapshot,
  nextMessages: DashboardMessage[],
): boolean {
  if (lastSubstantiveRole(nextMessages) !== 'assistant') return false
  const existing = Array.isArray(snapshot.liveMessages) ? snapshot.liveMessages : []
  return lastSubstantiveRole(existing) !== 'assistant'
}

/**
 * (REPLICA-PROVENANCE-SCALAR-LOSS) Accept BOTH messageSource shapes: the legacy
 * lane ships the producer's full object, the replica lane a bare `selected`
 * scalar (§2.4) that the adapter re-wraps. Reading the string too means a
 * producer skipping that re-wrap still gets the provenance escape hatches below
 * instead of silently falling onto the count heuristic — the failure mode that
 * wedged the chat pane mid-generation.
 */
export function normalizeMessageSource(
  messageSource: Record<string, unknown> | string | undefined,
): Record<string, unknown> | undefined {
  return typeof messageSource === 'string' ? { selected: messageSource } : messageSource
}

/**
 * True when `selected` is the daemon's locked native transcript — authoritative,
 * so a native tail adding an assistant answer the view lacks is forward progress
 * even after the shrink-defense transition window has lapsed.
 */
function isNativeHistorySource(messageSource: Record<string, unknown> | string | undefined): boolean {
  const normalized = normalizeMessageSource(messageSource)
  return !!normalized && (normalized as { selected?: unknown }).selected === 'native-history'
}

/**
 * (D6 — generating→idle transition-window race) Force-apply gate.
 *
 * The transition-window shrink-defense already lets a NEW-assistant tail through
 * WHILE the window is engaged (tailDeliversNewAssistantAnswer inside
 * shouldDeferBusyTailUpdate). But the same corrective native-history
 * [user, assistant] snapshot can also arrive AFTER the window has lapsed, or be
 * suppressed by the unchanged-signature short-circuit — either way stranding the
 * rendered tail at a user-only intermediate until a full-page reload.
 *
 * This gate force-applies such a snapshot independent of BOTH the transition-window
 * timer AND the unchanged-signature short-circuit, strictly when: the incoming tail
 * is the daemon's locked native transcript (`selected === 'native-history'`) AND it
 * adds a substantive assistant answer the current rendered `liveMessages` lacks. A
 * busy PTY tail (selected !== 'native-history') is never force-applied, so the
 * shrink-defense against a short/stale PTY substitute stays intact.
 */
export function shouldForceApplyNativeAssistantTail(
  snapshot: SessionChatTailSnapshot,
  nextMessages: DashboardMessage[],
  messageSource: Record<string, unknown> | string | undefined,
): boolean {
  if (!isNativeHistorySource(messageSource)) return false
  return tailDeliversNewAssistantAnswer(snapshot, nextMessages)
}

function getExistingVisibleMessageCount(snapshot: SessionChatTailSnapshot, fallbackRecentCount: number): number {
  return Math.max(
    Math.max(0, fallbackRecentCount),
    Array.isArray(snapshot.liveMessages) ? snapshot.liveMessages.length : 0,
  )
}

function shouldDeferBusyTailUpdate(
  snapshot: SessionChatTailSnapshot,
  fallbackRecentCount: number,
  nextMessages: DashboardMessage[],
  status: unknown,
  messageSource: Record<string, unknown> | string | undefined,
  withinRecentActiveWindow: boolean,
  transcriptReadSource: 'replica' | 'legacy',
): boolean {
  // Engage the shrink-defense for any warm/active status (incl. waiting_approval)
  // OR any strictly-busy status (no_progress/long_generating are busy but not in
  // WARM_ACTIVE). Union of the two keeps every previously-protected busy state
  // protected while adding the approval window.
  //
  // (CHAT-DISAPPEAR-REAPPEAR) Also engage during the generating→idle TRANSITION
  // WINDOW: when the daemon flips status to `idle` the instant generating ends, it
  // can still ship a stale/short user-only tail that — without this guard — would
  // overwrite the longer hydrated bubbles and make the assistant/system bubbles
  // disappear-then-reappear. `idle` is neither WARM_ACTIVE nor busy, so we widen
  // the gate to also fire for a short window after the last active-status update.
  // OUTSIDE that window (genuinely-settled idle: new-chat/reset, old sessions) we
  // keep the previous behaviour and let legitimate tail shrinks through.
  //
  // The transition window only protects an already-HYDRATED snapshot (real bubbles
  // to lose). It must NOT engage for the fallback-count path used while not yet
  // hydrated — otherwise the first real idle tail right after a deferred
  // generating placeholder would be wrongly deferred against the fallback count.
  const statusIsActive = shouldGuardTailShrinkForStatus(status) || isBusyChatTailStatus(status)
  const transitionWindowEngaged = withinRecentActiveWindow && snapshot.hasLiveSnapshot
  if (!statusIsActive && !transitionWindowEngaged) return false
  // For the warm/busy path keep the existing fallback-inflated baseline. For the
  // idle TRANSITION-window-only path compare against the ACTUAL hydrated bubble
  // count (not the inflated fallback) so a legitimately GROWING idle tail right
  // after generation is still applied — we only defend against a real shrink below
  // what is currently on screen.
  const existingCount = statusIsActive
    ? getExistingVisibleMessageCount(snapshot, fallbackRecentCount)
    : (Array.isArray(snapshot.liveMessages) ? snapshot.liveMessages.length : 0)
  if (existingCount <= 0) return false

  if (isTransientNonSubstantiveTail(nextMessages)) return true

  // (ANTIGRAVITY-TAIL-USER-ONLY) On the generating→idle TRANSITION of an already
  // HYDRATED snapshot, an incoming tail that finally carries the assistant answer
  // — while the on-screen tail still ends on the user prompt — is forward
  // progress, not a shrink to defend against. The daemon's finalized
  // native-history tail is often SHORTER than the busy-phase tail it replaces
  // (chrome/partial/duplicate bubbles collapse on finalization), so the length
  // heuristic below would wrongly defer it and strand the session showing only
  // the user prompt until a full-page reload. Restricted to the transition window
  // (not the warm/busy path) so a not-yet-hydrated short busy tail is still
  // deferred against the fallback baseline — only a real, already-shown user turn
  // getting its answer is force-applied.
  if (transitionWindowEngaged && !statusIsActive && tailDeliversNewAssistantAnswer(snapshot, nextMessages)) {
    return false
  }

  // (A3) When the daemon ships a ChatSourceMachine decision, trust it.
  // The machine already knows whether the incoming tail is the locked
  // native transcript (don't defer) or a PTY substitute (defer until
  // native catches up). v1 had to infer this from message count, which
  // misfired whenever PTY ran ahead of native legitimately.
  const normalizedMessageSource = normalizeMessageSource(messageSource)
  if (normalizedMessageSource) {
    const selected = normalizedMessageSource.selected
    const fallbackReason = normalizedMessageSource.fallbackReason
    // Native-history is authoritative — never defer.
    if (selected === 'native-history') return false
    // Provider declined native ('provider_native_transcript_not_supported',
    // 'native_history_not_checked', or any non-'native_history_' code) —
    // PTY is the only source we have, so accept it instead of insisting on
    // the larger stale snapshot.
    if (typeof fallbackReason === 'string'
        && fallbackReason !== ''
        && !fallbackReason.startsWith('native_history_')) {
      return false
    }
    // Otherwise (genuine native_history_* fallback during busy) fall through
    // to the count heuristic — native is expected but transiently behind.
  }

  // (REPLICA-PROVENANCE-SCALAR-LOSS — defense in depth) A replica snapshot is
  // NEVER judged by the count heuristic below: it is hash-verified and
  // monotonically revisioned, so a shorter tail is a legitimate bubble merge
  // during generation, not the stale/partial shrink that heuristic defends
  // against. This is the CLASS defense — if a future provenance field is lost on
  // the wire the way `messageSource` was, the pane still updates instead of
  // silently wedging. The legacy lane keeps the heuristic unchanged.
  if (transcriptReadSource === 'replica') return false

  // Legacy heuristic for v1 daemons or v1-only producers that do not emit a
  // ChatSourceMachine decision. Doomed once the v1 vocabulary is removed.
  return nextMessages.length < existingCount
}

function isTransientUnavailableEmptyTail(
  snapshot: SessionChatTailSnapshot,
  fallbackRecentCount: number,
  nextMessages: DashboardMessage[],
  messageSourceInput: Record<string, unknown> | string | undefined,
): boolean {
  if (nextMessages.length !== 0) return false
  const existingCount = getExistingVisibleMessageCount(snapshot, fallbackRecentCount)
  if (existingCount <= 0) return false

  // An explicit local clear (new-chat/reset flow) intentionally sets an empty
  // live snapshot. Do not resurrect fallback rows after that.
  if (snapshot.hasLiveSnapshot && snapshot.liveMessages.length === 0) return false

  const messageSource = normalizeMessageSource(messageSourceInput)
  if (!messageSource) return false
  const selected = messageSource.selected
  const fallbackReason = messageSource.fallbackReason
  const nativeSource = messageSource.nativeSource

  // Codex can briefly report an empty tail before its provider-native rollout
  // id is bound. Treat that as "not hydrated yet" instead of letting an empty
  // PTY/native-unavailable result erase visible fallback/live bubbles.
  if (selected === 'native-history') {
    // Defense in depth (zero-bubble fix): a daemon running the STICKY-NATIVE
    // empty hold ships selected=native-history with ZERO messages and
    // fallbackReason=native_history_transient_gap_held. Trusting `selected`
    // here would apply an authoritative empty live snapshot and clobber the
    // last real snapshot. That combination is by definition a transient gap,
    // never a real clear — treat it as transient even though selected is
    // native-history. A genuine native-history empty (no held-gap marker)
    // still applies as before.
    return fallbackReason === 'native_history_transient_gap_held'
  }
  if (nativeSource === 'native-unavailable') return true
  return typeof fallbackReason === 'string' && fallbackReason.startsWith('native_history_')
}

/**
 * Outcome of evaluating an incoming chat-tail update against the live snapshot.
 * - 'defer-busy-shrink': a warm/busy (incl. waiting_approval) shrink that would
 *   transiently drop hydrated bubbles — ignore it (CHATFLICKER shrink-defense).
 * - 'skip-transient-empty': an empty tail from a not-yet-hydrated native/PTY
 *   source that would erase visible fallback/live bubbles — ignore it.
 * - 'apply': accept the update.
 */
export type ChatTailUpdateDecision = 'apply' | 'defer-busy-shrink' | 'skip-transient-empty'

/**
 * Single decision point for whether to accept an incoming tail update. The gate
 * predicates (shouldDeferBusyTailUpdate / isTransientUnavailableEmptyTail) are
 * evaluated in the same order as before. The shrink-defense's waiting_approval
 * coverage (via shouldGuardTailShrinkForStatus) is preserved untouched, and the
 * generating→idle transition window (withinRecentActiveWindow) widens the
 * shrink-defense to the moment immediately after generating ends.
 */
export function decideChatTailUpdate(
  snapshot: SessionChatTailSnapshot,
  fallbackRecentCount: number,
  nextMessages: DashboardMessage[],
  status: unknown,
  messageSource: Record<string, unknown> | string | undefined,
  withinRecentActiveWindow: boolean,
  transcriptReadSource: 'replica' | 'legacy',
): ChatTailUpdateDecision {
  if (shouldDeferBusyTailUpdate(snapshot, fallbackRecentCount, nextMessages, status, messageSource, withinRecentActiveWindow, transcriptReadSource)) {
    return 'defer-busy-shrink'
  }
  if (isTransientUnavailableEmptyTail(snapshot, fallbackRecentCount, nextMessages, messageSource)) {
    return 'skip-transient-empty'
  }
  return 'apply'
}

export function readChatTailUpdateMessages(update: SessionChatTailUpdate): DashboardMessage[] {
  if (Array.isArray(update.messages)) return update.messages as DashboardMessage[]
  const tailMessages = (update as SessionChatTailUpdate & { messagesTail?: unknown }).messagesTail
  return Array.isArray(tailMessages) ? tailMessages as DashboardMessage[] : []
}

export function readUpdateStringField(update: SessionChatTailUpdate, field: 'sessionId' | 'historySessionId'): string {
  const value = (update as SessionChatTailUpdate & Record<typeof field, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

/**
 * (§8 unit 5) `transcript-chat-pane-adapter.ts`'s mapped update sets
 * `transcriptReadSource: 'replica'` explicitly; every legacy
 * `session.chat_tail`/`read_chat` update has no such field, which reads as
 * 'legacy' — the correct default, never a guess.
 */
export function readUpdateTranscriptReadSource(update: SessionChatTailUpdate): 'replica' | 'legacy' {
  const value = (update as SessionChatTailUpdate & { transcriptReadSource?: unknown }).transcriptReadSource
  return value === 'replica' ? 'replica' : 'legacy'
}

export function readUpdateBooleanField(update: SessionChatTailUpdate, field: 'omittedBefore' | 'stale'): boolean {
  const value = (update as SessionChatTailUpdate & Record<typeof field, unknown>)[field]
  return value === true
}

export function readUpdateOptionalStringField(update: SessionChatTailUpdate, field: 'transcriptFallbackReason'): string | undefined {
  const value = (update as SessionChatTailUpdate & Record<typeof field, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
