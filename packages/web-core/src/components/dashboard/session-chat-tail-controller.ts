import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { buildChatMessageSignature } from '@adhdev/daemon-core/chat/chat-signatures'
import type { SessionChatTailUpdate, SubscribeRequest } from '@adhdev/daemon-core'
import type { ActiveConversation, DashboardMessage } from './types'
import { useTransport } from '../../context/TransportContext'
import { subscriptionManager, type SubscriptionHandle, type SubscriptionManager } from '../../managers/SubscriptionManager'
import { getConversationHistorySessionIdForRead } from './conversation-identity'
import { getConversationDaemonRouteId } from './conversation-selectors'


export interface SessionChatTailCursor {
  tailLimit: number
}

export interface SessionChatTailSnapshot {
  liveMessages: DashboardMessage[]
  hasLiveSnapshot: boolean
  cursor: SessionChatTailCursor
  historyMessages: DashboardMessage[]
  historyOffset: number
  hasMoreHistory: boolean
  historyError: string | null
  /**
   * (A3) Latest ChatSourceMachine decision delivered from the daemon.
   * Carries selected ('native-history' | 'pty-parser'), fallbackReason,
   * coverage, identityStatus, staleness, lockState. Consumed by the
   * source debug badge and SourceTimeline. Undefined for v1 daemons /
   * pre-A2 subscriptions.
   */
  messageSource?: Record<string, unknown>
  /**
   * (§8 unit 5) Which transport produced `liveMessages` — design §5.6's
   * single-source-of-truth telemetry field: "rollback이 두 소스 merge로 변질되지
   * 않게 source 선택 결과를 응답에 transcriptReadSource: replica|legacy와
   * reason으로 단일 표기한다." Defaults to 'legacy' — every existing
   * `session.chat_tail`/`read_chat` update path is unaffected; only a mapped
   * transcript-replica update (`transcript-chat-pane-adapter.ts`) sets 'replica'.
   */
  transcriptReadSource: 'replica' | 'legacy'
  /** Set with `transcriptReadSource` when it flips back to 'legacy' — never set for a session that never tried the replica. */
  transcriptFallbackReason?: string
  /**
   * Ring/SNAP-reset discontinuity carried by a replica update (design §3.7's
   * "이전 내용 생략" signal). False for every legacy update.
   */
  omittedBefore: boolean
  /** A replica-sourced tail whose freshness gate did not hold (design §5.5's "stale idle UI"). False for every legacy update. */
  stale: boolean
}

export interface SessionChatHistoryPageRequest {
  offset: number
  excludeRecentCount: number
}

export interface SessionChatTailControllerOptions {
  manager?: SubscriptionManager
  sendData?: (daemonId: string, data: any) => boolean
  daemonId: string
  sessionId: string
  historySessionId?: string
  subscriptionKey: string
  tailLimit?: number
  fallbackRecentCount?: number
  /**
   * Injectable wall-clock for the generating→idle shrink-defense window. Defaults
   * to Date.now. Tests override it to drive the recent-activity window
   * deterministically.
   */
  now?: () => number
}

export interface SessionChatTailControllerHandle extends SessionChatTailSnapshot {
  loadHistoryPage: () => Promise<void>
}

export interface WarmSessionChatTailDescriptor {
  daemonId: string
  sessionId: string
  // Read-safe: a REAL distinct provider conv id, or undefined for a coordinator
  // whose providerSessionId isn't surfaced (never the runtime sessionId — that
  // is the read poison). Undefined → the subscribe request omits historySessionId
  // and the daemon runs its owner-confirmed native resolution.
  historySessionId?: string
  subscriptionKey: string
}

const DEFAULT_TAIL_LIMIT = 60
const CHAT_TAIL_SUBSCRIBE_RETRY_MS = 1_000
/**
 * (D8) Minimum spacing between one-shot authoritative tail re-pulls. Mount,
 * WS-reconnect and tab-focus can all fire near-simultaneously (e.g. a
 * background→foreground flip that also reconnects the socket); this collapses
 * that burst into a single read_chat instead of a small storm.
 */
const AUTHORITATIVE_TAIL_REFRESH_DEBOUNCE_MS = 750
/**
 * Upper bound on retained history messages from "Load older" paging.
 *
 * Each "Load older" page prepends into `historyMessages` with no prior cap, so a
 * user repeatedly paging back grows the rendered (non-virtualized) set without
 * bound and the chat slows down. We keep the most-recent N retained history
 * messages (the ones nearest the live window, i.e. the tail of the array) and
 * drop the oldest beyond that. Paging still works: `historyOffset` keeps
 * advancing by the full fetched page size, so the next request asks the daemon
 * for the correct next page even though we don't keep every row in memory.
 */
const DEFAULT_MAX_RETAINED_HISTORY_MESSAGES = 500
const DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS = 120_000
const WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES = new Set([
  'generating',
  'waiting_approval',
  'starting',
  'streaming',
  'working',
])
const controllerRegistry = new Map<string, SessionChatTailController>()

// Bumped whenever a controller is added to / removed from the registry. Lets
// reactive consumers (useWarmSessionChatTailSnapshotVersion) re-run their
// per-controller subscription effect when membership changes — the warm-retain
// effect may create a controller AFTER the version hook's effect first ran, so
// the version hook needs a signal to (re)subscribe once the controller exists.
let controllerRegistryGeneration = 0
const controllerRegistryListeners = new Set<() => void>()

function notifyControllerRegistryChanged(): void {
  controllerRegistryGeneration += 1
  for (const listener of controllerRegistryListeners) listener()
}

function subscribeControllerRegistry(listener: () => void): () => void {
  controllerRegistryListeners.add(listener)
  return () => {
    controllerRegistryListeners.delete(listener)
  }
}

function getControllerRegistryGeneration(): number {
  return controllerRegistryGeneration
}

function getControllerKey(daemonId: string, sessionId: string, historySessionId?: string): string {
  return `${daemonId}::${sessionId}::${historySessionId || sessionId}`
}

function buildEmptySnapshot(tailLimit = DEFAULT_TAIL_LIMIT): SessionChatTailSnapshot {
  return {
    liveMessages: [],
    hasLiveSnapshot: false,
    cursor: buildReadChatCursor([], tailLimit),
    historyMessages: [],
    historyOffset: 0,
    hasMoreHistory: true,
    historyError: null,
    transcriptReadSource: 'legacy',
    omittedBefore: false,
    stale: false,
  }
}

export function buildLastMessageSignature(message: DashboardMessage | null | undefined): string {
  return buildChatMessageSignature(message)
}

export function buildReadChatCursor(_messages: DashboardMessage[], tailLimit = DEFAULT_TAIL_LIMIT): SessionChatTailCursor {
  return { tailLimit }
}

function buildChatSnapshotSignature(messages: DashboardMessage[], status?: string): string {
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
function lastSubstantiveAssistantIdentity(messages: DashboardMessage[]): string {
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
 * True when `messageSource.selected` is the daemon's locked native transcript.
 * Native-history is authoritative; a native tail that adds an assistant answer the
 * current view lacks is real forward progress even after the shrink-defense
 * transition window has lapsed.
 */
function isNativeHistorySource(messageSource: Record<string, unknown> | undefined): boolean {
  return !!messageSource
    && typeof messageSource === 'object'
    && (messageSource as { selected?: unknown }).selected === 'native-history'
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
function shouldForceApplyNativeAssistantTail(
  snapshot: SessionChatTailSnapshot,
  nextMessages: DashboardMessage[],
  messageSource: Record<string, unknown> | undefined,
): boolean {
  if (!isNativeHistorySource(messageSource)) return false
  return tailDeliversNewAssistantAnswer(snapshot, nextMessages)
}

function isBusyChatTailStatus(status: unknown): boolean {
  const value = typeof status === 'string' ? status.toLowerCase() : ''
  return value === 'generating' || value === 'no_progress' || value === 'long_generating' || value === 'streaming' || value === 'working' || value === 'starting'
}

/**
 * Shrink-defer gate (NOT a "busy" predicate). Returns true for every status that
 * keeps a session warm/active, i.e. every member of
 * WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES, which crucially includes
 * `waiting_approval`.
 *
 * `isBusyChatTailStatus` intentionally EXCLUDES `waiting_approval` (and other
 * warm states like `starting`) because its callers rely on the strict "busy"
 * meaning. But the chat-tail shrink-defense must protect the approval window
 * too: during `waiting_approval` the daemon can emit a short partial tail (e.g.
 * only the user prompt, assistant bubble briefly missing) that — without this
 * guard — replaces the longer hydrated `liveMessages` and makes the assistant
 * bubble transiently disappear/return (CHATFLICKER on approve). We widen ONLY
 * this shrink-defer gate to WARM_ACTIVE membership; `isBusyChatTailStatus` keeps
 * its existing busy semantics untouched.
 */
function shouldGuardTailShrinkForStatus(status: unknown): boolean {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : ''
  return WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES.has(value)
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
  messageSource: Record<string, unknown> | undefined,
  withinRecentActiveWindow: boolean,
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
  if (messageSource && typeof messageSource === 'object') {
    const selected = (messageSource as { selected?: unknown }).selected
    const fallbackReason = (messageSource as { fallbackReason?: unknown }).fallbackReason
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

  // Legacy heuristic for v1 daemons or v1-only producers that do not emit a
  // ChatSourceMachine decision. Doomed once the v1 vocabulary is removed.
  return nextMessages.length < existingCount
}

function isTransientUnavailableEmptyTail(
  snapshot: SessionChatTailSnapshot,
  fallbackRecentCount: number,
  nextMessages: DashboardMessage[],
  messageSource: Record<string, unknown> | undefined,
): boolean {
  if (nextMessages.length !== 0) return false
  const existingCount = getExistingVisibleMessageCount(snapshot, fallbackRecentCount)
  if (existingCount <= 0) return false

  // An explicit local clear (new-chat/reset flow) intentionally sets an empty
  // live snapshot. Do not resurrect fallback rows after that.
  if (snapshot.hasLiveSnapshot && snapshot.liveMessages.length === 0) return false

  if (!messageSource || typeof messageSource !== 'object') return false
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
function decideChatTailUpdate(
  snapshot: SessionChatTailSnapshot,
  fallbackRecentCount: number,
  nextMessages: DashboardMessage[],
  status: unknown,
  messageSource: Record<string, unknown> | undefined,
  withinRecentActiveWindow: boolean,
): ChatTailUpdateDecision {
  if (shouldDeferBusyTailUpdate(snapshot, fallbackRecentCount, nextMessages, status, messageSource, withinRecentActiveWindow)) {
    return 'defer-busy-shrink'
  }
  if (isTransientUnavailableEmptyTail(snapshot, fallbackRecentCount, nextMessages, messageSource)) {
    return 'skip-transient-empty'
  }
  return 'apply'
}

function readChatTailUpdateMessages(update: SessionChatTailUpdate): DashboardMessage[] {
  if (Array.isArray(update.messages)) return update.messages as DashboardMessage[]
  const tailMessages = (update as SessionChatTailUpdate & { messagesTail?: unknown }).messagesTail
  return Array.isArray(tailMessages) ? tailMessages as DashboardMessage[] : []
}

function readUpdateStringField(update: SessionChatTailUpdate, field: 'sessionId' | 'historySessionId'): string {
  const value = (update as SessionChatTailUpdate & Record<typeof field, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

/**
 * (§8 unit 5) `transcript-chat-pane-adapter.ts`'s mapped update sets
 * `transcriptReadSource: 'replica'` explicitly; every legacy
 * `session.chat_tail`/`read_chat` update has no such field, which reads as
 * 'legacy' — the correct default, never a guess.
 */
function readUpdateTranscriptReadSource(update: SessionChatTailUpdate): 'replica' | 'legacy' {
  const value = (update as SessionChatTailUpdate & { transcriptReadSource?: unknown }).transcriptReadSource
  return value === 'replica' ? 'replica' : 'legacy'
}

function readUpdateBooleanField(update: SessionChatTailUpdate, field: 'omittedBefore' | 'stale'): boolean {
  const value = (update as SessionChatTailUpdate & Record<typeof field, unknown>)[field]
  return value === true
}

function readUpdateOptionalStringField(update: SessionChatTailUpdate, field: 'transcriptFallbackReason'): string | undefined {
  const value = (update as SessionChatTailUpdate & Record<typeof field, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class SessionChatTailController {
  private manager: SubscriptionManager
  private sendData?: (daemonId: string, data: any) => boolean
  private daemonId: string
  private sessionId: string
  private historySessionId?: string
  private subscriptionKey: string
  private fallbackRecentCount: number
  private snapshot: SessionChatTailSnapshot
  private transportSubscription: SubscriptionHandle | null = null
  private listeners = new Set<(snapshot: SessionChatTailSnapshot) => void>()
  private retainCount = 0
  private loadHistoryPromise: Promise<void> | null = null
  private pendingDisconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * (D8) In-flight one-shot authoritative tail re-pull, and the wall-clock of
   * the last one, so mount/reconnect/focus collapse into a single read_chat.
   */
  private authoritativeRefreshPromise: Promise<void> | null = null
  private lastAuthoritativeRefreshAt = 0
  private now: () => number
  /**
   * Wall-clock time (ms) of the last update whose status was warm/active or busy.
   * Drives the generating→idle shrink-defense window: an `idle` update arriving
   * within DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS of this stamp is still
   * subjected to the shrink count-heuristic, blocking the transition-moment flicker.
   * 0 means "no active update seen yet" (settled idle — no transition protection).
   */
  private lastActiveStatusAt = 0

  constructor(options: SessionChatTailControllerOptions) {
    this.manager = options.manager || subscriptionManager
    this.sendData = options.sendData
    this.daemonId = options.daemonId
    this.sessionId = options.sessionId
    this.historySessionId = options.historySessionId
    this.subscriptionKey = options.subscriptionKey
    this.fallbackRecentCount = Math.max(0, options.fallbackRecentCount ?? 0)
    this.now = options.now ?? (() => Date.now())
    this.snapshot = buildEmptySnapshot(Math.max(0, options.tailLimit ?? DEFAULT_TAIL_LIMIT))
  }

  updateOptions(options: Partial<SessionChatTailControllerOptions>): void {
    const previousSendData = this.sendData
    const previousDaemonId = this.daemonId
    const previousSessionId = this.sessionId
    if (options.manager) this.manager = options.manager
    if (options.sendData) this.sendData = options.sendData
    if (options.historySessionId) this.historySessionId = options.historySessionId
    if (options.now) this.now = options.now
    if (options.fallbackRecentCount !== undefined) {
      this.fallbackRecentCount = Math.max(0, options.fallbackRecentCount)
    }
    if (options.tailLimit !== undefined) {
      const nextTailLimit = Math.max(0, options.tailLimit)
      if (nextTailLimit !== this.snapshot.cursor.tailLimit) {
        this.snapshot = {
          ...this.snapshot,
          cursor: { tailLimit: nextTailLimit },
        }
        if (this.transportSubscription) {
          this.disconnect()
          this.connect()
        }
      }
    }
    if (
      this.retainCount > 0
      && (
        previousSendData !== this.sendData
        || previousDaemonId !== this.daemonId
        || previousSessionId !== this.sessionId
      )
    ) {
      this.disconnect()
      this.connect()
    }
  }

  getSnapshot(): SessionChatTailSnapshot {
    return this.snapshot
  }

  clearLiveSnapshot(): void {
    this.snapshot = {
      ...buildEmptySnapshot(this.snapshot.cursor.tailLimit),
      hasLiveSnapshot: true,
    }
    this.emit()
  }

  /**
   * (§8 unit 5, design §5.6) Record that the replica read fell back to legacy
   * for this session — telemetry only, never touches `liveMessages`. Never
   * merges two sources: this only flips the `transcriptReadSource`/
   * `transcriptFallbackReason` labels on whatever `liveMessages` the next
   * legacy update (or the current one) already carries.
   */
  reportTranscriptReplicaFallback(reason: string): void {
    if (this.snapshot.transcriptReadSource === 'legacy' && this.snapshot.transcriptFallbackReason === reason) return
    this.snapshot = {
      ...this.snapshot,
      transcriptReadSource: 'legacy',
      transcriptFallbackReason: reason,
    }
    this.emit()
  }

  subscribe(listener: (snapshot: SessionChatTailSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  retain(): void {
    if (this.pendingDisconnectTimer) {
      clearTimeout(this.pendingDisconnectTimer)
      this.pendingDisconnectTimer = null
    }
    this.retainCount += 1
    this.connect()
  }

  release(): void {
    this.retainCount = Math.max(0, this.retainCount - 1)
    if (this.retainCount !== 0 || this.pendingDisconnectTimer) {
      return
    }
    this.pendingDisconnectTimer = setTimeout(() => {
      this.pendingDisconnectTimer = null
      if (this.retainCount === 0) {
        this.disconnect()
      }
    }, 0)
  }

  async loadHistoryPage(loader: (request: SessionChatHistoryPageRequest) => Promise<{ messages?: DashboardMessage[]; hasMore?: boolean }>): Promise<void> {
    if (this.loadHistoryPromise) return this.loadHistoryPromise
    this.snapshot = {
      ...this.snapshot,
      historyError: null,
    }
    this.emit()
    const run = (async () => {
      try {
        const hadLiveSnapshot = this.snapshot.hasLiveSnapshot
        const excludeRecentCount = hadLiveSnapshot
          ? this.snapshot.liveMessages.length
          : Math.max(this.snapshot.liveMessages.length, this.fallbackRecentCount)
        const result = await loader({
          offset: this.snapshot.historyOffset,
          excludeRecentCount,
        })
        const nextMessages = Array.isArray(result.messages) ? result.messages : []
        const shouldKeepHistoryOpen = !hadLiveSnapshot
          && nextMessages.length === 0
          && result.hasMore !== true
          && this.fallbackRecentCount > 0
        // Cap retained history so unbounded "Load older" paging can't grow the
        // rendered set without limit. History is oldest-first, so the most-recent
        // (nearest the live window) rows are the array tail — keep those.
        const mergedHistory = [...nextMessages, ...this.snapshot.historyMessages]
        const cappedHistory = mergedHistory.length > DEFAULT_MAX_RETAINED_HISTORY_MESSAGES
          ? mergedHistory.slice(mergedHistory.length - DEFAULT_MAX_RETAINED_HISTORY_MESSAGES)
          : mergedHistory
        this.snapshot = {
          ...this.snapshot,
          historyMessages: cappedHistory,
          // historyOffset advances by the full fetched page size (not the capped
          // retained length) so the next page request stays correctly aligned.
          historyOffset: this.snapshot.historyOffset + nextMessages.length,
          hasMoreHistory: shouldKeepHistoryOpen ? true : result.hasMore === true,
          historyError: null,
        }
      } catch (error) {
        this.snapshot = {
          ...this.snapshot,
          historyError: error instanceof Error ? error.message : 'Failed to load history',
        }
      }
      this.emit()
    })().finally(() => {
      this.loadHistoryPromise = null
    })
    this.loadHistoryPromise = run
    return run
  }

  /**
   * (D8 — web self-heal) One-shot authoritative tail re-pull. On chat-panel
   * MOUNT, WS RECONNECT, and tab focus (visibilitychange→visible) the owning
   * hook calls this so a browser holding a stale user-only `liveMessages`
   * re-pulls the daemon's authoritative [user, assistant] tail and applies it —
   * regardless of push timing. This is the direct fix for "hard refresh / Load
   * older doesn't help": the completion tail was marked delivered on the
   * daemon's FLUSH-FIRE (not browser-APPLIED), so a browser that dropped the one
   * push (D6 shrink-defer) or subscribed just after it fired stayed user-only
   * forever. Re-pulling on focus/reconnect recovers it.
   *
   * The fetched tail is fed through the SAME `applyIncomingUpdate` path the
   * subscription uses, so D2 sort/dedup and the D6 force-apply / shrink-defense
   * still compose — the re-pulled [user, assistant] replaces the stale [user]
   * with NO duplicate assistant bubble (identical bubble identity is a no-op).
   *
   * Debounced/guarded to ONE request per burst (mount+reconnect+focus can fire
   * together) and coalesced with any in-flight refresh — never a per-render loop.
   */
  refreshAuthoritativeTail(
    fetcher: () => Promise<SessionChatTailUpdate | null>,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (this.authoritativeRefreshPromise) return this.authoritativeRefreshPromise
    const nowMs = this.now()
    if (
      !options.force
      && this.lastAuthoritativeRefreshAt > 0
      && (nowMs - this.lastAuthoritativeRefreshAt) < AUTHORITATIVE_TAIL_REFRESH_DEBOUNCE_MS
    ) {
      return Promise.resolve()
    }
    this.lastAuthoritativeRefreshAt = nowMs
    const run = (async () => {
      try {
        const update = await fetcher()
        if (update) this.handleUpdate(update)
      } catch {
        // Best-effort self-heal — a failed re-pull just leaves the existing
        // snapshot untouched; the next focus/reconnect retries.
      }
    })().finally(() => {
      this.authoritativeRefreshPromise = null
    })
    this.authoritativeRefreshPromise = run
    return run
  }

  private buildSubscribeRequest(): SubscribeRequest {
    return {
      type: 'subscribe',
      topic: 'session.chat_tail',
      key: this.subscriptionKey,
      params: {
        targetSessionId: this.sessionId,
        ...(this.historySessionId ? { historySessionId: this.historySessionId } : {}),
        ...(this.snapshot.cursor.tailLimit > 0 ? { tailLimit: this.snapshot.cursor.tailLimit } : {}),
      },
    }
  }

  private connect(): void {
    if (this.transportSubscription || !this.sendData || !this.daemonId || !this.sessionId) return
    this.transportSubscription = this.manager.subscribe(
      { sendData: this.sendData },
      this.daemonId,
      this.buildSubscribeRequest(),
      (update: SessionChatTailUpdate) => {
        this.handleUpdate(update)
      },
      { retryIntervalMs: CHAT_TAIL_SUBSCRIBE_RETRY_MS },
    )
  }

  private disconnect(): void {
    this.transportSubscription?.()
    this.transportSubscription = null
  }

  dispose(): void {
    if (this.pendingDisconnectTimer) {
      clearTimeout(this.pendingDisconnectTimer)
      this.pendingDisconnectTimer = null
    }
    this.disconnect()
    this.listeners.clear()
    this.retainCount = 0
    this.loadHistoryPromise = null
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.snapshot))
  }

  private handleUpdate(update: SessionChatTailUpdate): void {
    if (update.error) return
    const updateSessionId = readUpdateStringField(update, 'sessionId')
    if (updateSessionId && updateSessionId !== this.sessionId) return

    const updateHistorySessionId = readUpdateStringField(update, 'historySessionId')
    if (updateHistorySessionId && this.historySessionId && updateHistorySessionId !== this.historySessionId) return

    const nextMessages = readChatTailUpdateMessages(update)
    const incomingMessageSource = (update as SessionChatTailUpdate & { messageSource?: Record<string, unknown> }).messageSource

    // (CHAT-DISAPPEAR-REAPPEAR) Compute the generating→idle transition window using
    // the PREVIOUS active-status stamp, then refresh the stamp for THIS update if it
    // is itself warm/active or busy. An `idle` update that lands within
    // DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS of the last active status is
    // still subjected to the shrink-defense, so the stale short tail emitted at the
    // instant generating ends cannot overwrite the hydrated bubbles.
    const updateTime = this.now()
    const withinRecentActiveWindow = this.lastActiveStatusAt > 0
      && (updateTime - this.lastActiveStatusAt) <= DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS
    if (shouldGuardTailShrinkForStatus(update.status) || isBusyChatTailStatus(update.status)) {
      this.lastActiveStatusAt = updateTime
    }

    // (D6) A native-history tail that adds a substantive assistant answer the
    // current view lacks is force-applied: it overrides BOTH the shrink-defense /
    // transition-window decision below AND the unchanged-signature short-circuit,
    // so the corrective [user, assistant] snapshot can never be stranded behind a
    // lapsed transition-window timer or an unchanged deliverySignature. Strictly
    // gated on selected === 'native-history', so a busy PTY tail is untouched.
    const forceApplyNativeAssistant = shouldForceApplyNativeAssistantTail(
      this.snapshot,
      nextMessages,
      incomingMessageSource,
    )

    if (
      !forceApplyNativeAssistant
      && decideChatTailUpdate(this.snapshot, this.fallbackRecentCount, nextMessages, update.status, incomingMessageSource, withinRecentActiveWindow) !== 'apply'
    ) {
      return
    }
    const nextCursor: SessionChatTailCursor = { tailLimit: this.snapshot.cursor.tailLimit }
    // Fold the last-substantive-assistant identity into the no-op check so a
    // user-only → [user, assistant] transition always registers as a change even
    // when the coarse last-message/length signature happens to match (D6 cause (a)).
    const unchanged = !forceApplyNativeAssistant
      && buildChatSnapshotSignature(this.snapshot.liveMessages)
        === buildChatSnapshotSignature(nextMessages)
      && lastSubstantiveAssistantIdentity(this.snapshot.liveMessages)
        === lastSubstantiveAssistantIdentity(nextMessages)
      && this.snapshot.cursor.tailLimit === nextCursor.tailLimit
    if (unchanged) return
    this.snapshot = {
      ...this.snapshot,
      liveMessages: nextMessages,
      hasLiveSnapshot: true,
      cursor: nextCursor,
      // (A3) Track latest source decision for the debug badge / SourceTimeline.
      // Read-only consumption; daemon is source of truth.
      messageSource: incomingMessageSource,
      // (§8 unit 5) A legacy `session.chat_tail`/`read_chat` update never sets
      // these three fields, so they default to the "legacy, no discontinuity"
      // reading — only a mapped transcript-replica update
      // (transcript-chat-pane-adapter.ts) sets transcriptReadSource:'replica'
      // and/or omittedBefore/stale.
      transcriptReadSource: readUpdateTranscriptReadSource(update),
      omittedBefore: readUpdateBooleanField(update, 'omittedBefore'),
      stale: readUpdateBooleanField(update, 'stale'),
      ...(readUpdateOptionalStringField(update, 'transcriptFallbackReason') !== undefined
        ? { transcriptFallbackReason: readUpdateOptionalStringField(update, 'transcriptFallbackReason') }
        : {}),
    }
    this.emit()
  }
}

export function getOrCreateSessionChatTailController(options: SessionChatTailControllerOptions): SessionChatTailController {
  const key = getControllerKey(options.daemonId, options.sessionId, options.historySessionId)
  const existing = controllerRegistry.get(key)
  if (existing) {
    existing.updateOptions(options)
    return existing
  }
  const controller = new SessionChatTailController(options)
  controllerRegistry.set(key, controller)
  notifyControllerRegistryChanged()
  return controller
}

export function clearSessionChatTailControllerSnapshot(
  daemonId: string | undefined,
  sessionId: string | undefined,
  historySessionId?: string,
): void {
  if (!daemonId || !sessionId) return
  const prefix = `${daemonId}::${sessionId}::`
  const exactKey = getControllerKey(daemonId, sessionId, historySessionId)
  for (const [key, controller] of controllerRegistry.entries()) {
    if (key === exactKey || key.startsWith(prefix)) {
      controller.clearLiveSnapshot()
    }
  }
}

/**
 * (B2) Read the live chat_tail snapshot the warm controller ALREADY holds for a
 * conversation, if any. The mobile inbox uses this to build its list-item preview
 * from the same transcript authority ChatPane renders — keeping the inbox preview
 * and the opened chat body in sync — WITHOUT opening a second subscription. It
 * resolves the exact same registry key the warm/hook paths use
 * (getControllerKey with the read-safe historySessionId, falling back to the
 * sessionId), so it observes the warmed controller instead of creating one.
 *
 * Returns undefined when no controller is warm for this conversation (e.g. an
 * idle session outside the warm window); callers then fall back to
 * conversation.messages exactly as before.
 */
export function getSessionChatTailSnapshotForConversation(
  conversation: ActiveConversation,
): SessionChatTailSnapshot | undefined {
  const daemonId = getConversationDaemonRouteId(conversation)
  const sessionId = conversation.sessionId || ''
  if (!daemonId || !sessionId) return undefined
  const historySessionIdForRead = getConversationHistorySessionIdForRead(conversation)
  const key = getControllerKey(daemonId, sessionId, historySessionIdForRead || sessionId)
  const controller = controllerRegistry.get(key)
  if (!controller) return undefined
  const snapshot = controller.getSnapshot()
  return snapshot.hasLiveSnapshot ? snapshot : undefined
}

export function resetSessionChatTailControllersForTest(): void {
  for (const controller of controllerRegistry.values()) {
    controller.dispose()
  }
  controllerRegistry.clear()
}

function buildControllerHandle(
  snapshot: SessionChatTailSnapshot,
  loadHistoryPage: SessionChatTailControllerHandle['loadHistoryPage'],
): SessionChatTailControllerHandle {
  return {
    ...snapshot,
    loadHistoryPage,
  }
}

function compareWarmSessionChatTailDescriptors(
  left: WarmSessionChatTailDescriptor,
  right: WarmSessionChatTailDescriptor,
): number {
  return left.subscriptionKey.localeCompare(right.subscriptionKey)
    || left.daemonId.localeCompare(right.daemonId)
    || left.sessionId.localeCompare(right.sessionId)
    || (left.historySessionId || '').localeCompare(right.historySessionId || '')
}

function shouldWarmSessionChatTailConversation(
  conversation: ActiveConversation,
  options: { now?: number; recentActivityMs?: number } = {},
): boolean {
  const status = String(conversation.status || '').trim().toLowerCase()
  if (WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES.has(status)) return true
  if ((conversation.modalMessage || '').trim()) return true
  if (Array.isArray(conversation.modalButtons) && conversation.modalButtons.length > 0) return true

  const now = options.now ?? Date.now()
  const recentActivityMs = Math.max(0, Number(options.recentActivityMs ?? DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS))
  const lastActivityAt = Math.max(
    Number(conversation.lastUpdated || 0),
    Number(conversation.lastMessageAt || 0),
  )
  if (lastActivityAt > 0) {
    return (now - lastActivityAt) <= recentActivityMs
  }

  return Array.isArray(conversation.messages) && conversation.messages.length > 0
}

export function getWarmSessionChatTailDescriptorRefreshMs(recentActivityMs = DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS): number {
  return Math.max(1_000, Math.min(30_000, Math.max(0, Number(recentActivityMs || 0))))
}

export function buildWarmSessionChatTailDescriptorState(
  conversations: ActiveConversation[],
  options: { now?: number; recentActivityMs?: number } = {},
): { descriptors: WarmSessionChatTailDescriptor[]; signature: string } {
  const seen = new Set<string>()
  const descriptors: WarmSessionChatTailDescriptor[] = []
  for (const conversation of conversations) {
    if (!shouldWarmSessionChatTailConversation(conversation, options)) continue
    const daemonId = getConversationDaemonRouteId(conversation)
    const sessionId = conversation.sessionId || ''
    if (!daemonId || !sessionId) continue
    // Read-safe id (undefined for an agy coordinator) is what gets SENT to the
    // daemon; the controller/dedup key still uses the sessionId fallback so
    // warm descriptors stay stable and de-duplicated.
    const historySessionIdForRead = getConversationHistorySessionIdForRead(conversation)
    const key = getControllerKey(daemonId, sessionId, historySessionIdForRead || sessionId)
    if (seen.has(key)) continue
    seen.add(key)
    descriptors.push({
      daemonId,
      sessionId,
      // Outgoing (subscribe) id only — undefined for a coordinator so the arg is
      // omitted; the dedup key above still uses the sessionId fallback.
      historySessionId: historySessionIdForRead,
      subscriptionKey: `daemon:${daemonId}:session:${sessionId}`,
    })
  }
  descriptors.sort(compareWarmSessionChatTailDescriptors)
  return {
    descriptors,
    signature: descriptors
      .map((descriptor) => `${descriptor.subscriptionKey}|${descriptor.historySessionId}`)
      .join('||'),
  }
}

export function useSessionChatTailController(
  activeConv: ActiveConversation,
  options?: { enabled?: boolean; tailLimit?: number },
): SessionChatTailControllerHandle {
  const { sendData, sendCommand, isConnected } = useTransport()
  const enabled = options?.enabled !== false
  const daemonId = getConversationDaemonRouteId(activeConv)
  const sessionId = activeConv.sessionId || ''
  // Only a REAL, DISTINCT provider conv id is sent to the daemon as
  // historySessionId; for an agy coordinator (no surfaced providerSessionId)
  // this is undefined so every native read (subscribe / read_chat / chat_history)
  // OMITS the arg and the daemon runs its owner-confirmed native resolution
  // instead of fail-closing on the runtime session id. Never fall back to
  // sessionId here — that fallback is the read poison.
  const historySessionId = getConversationHistorySessionIdForRead(activeConv)
  const subscriptionKey = `daemon:${daemonId}:session:${sessionId}`
  const tailLimit = Math.max(0, options?.tailLimit ?? DEFAULT_TAIL_LIMIT)

  const fallbackRecentCount = activeConv.messages.length

  const controller = useMemo(() => {
    if (!enabled || !daemonId || !sessionId) return null
    return getOrCreateSessionChatTailController({
      daemonId,
      sessionId,
      historySessionId,
      subscriptionKey,
      sendData,
      tailLimit,
      fallbackRecentCount,
    })
    // `fallbackRecentCount` (activeConv.messages.length) is intentionally NOT a
    // dep: it changes on every meta append, and including it tore down and
    // recreated the controller (and its subscription) on every tick — pure
    // resubscribe churn. The controller is keyed by stable ids; we push the
    // fresh fallback count via updateOptions() in the effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonId, enabled, historySessionId, sendData, sessionId, subscriptionKey, tailLimit])

  // Keep the (already-stable) controller's fallback count current without
  // recreating it. updateOptions only resubscribes when an identity field
  // (sendData/daemonId/sessionId) actually changes, so a plain count bump is a
  // cheap in-place update.
  useEffect(() => {
    controller?.updateOptions({ fallbackRecentCount })
  }, [controller, fallbackRecentCount])

  const [snapshot, setSnapshot] = useState<SessionChatTailSnapshot>(() => (
    controller?.getSnapshot() || buildEmptySnapshot(tailLimit)
  ))

  useEffect(() => {
    if (!controller) {
      setSnapshot(buildEmptySnapshot(tailLimit))
      return
    }
    controller.retain()
    setSnapshot(controller.getSnapshot())
    const unsubscribe = controller.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot)
    })
    return () => {
      unsubscribe()
      controller.release()
    }
  }, [controller, tailLimit])

  const loadHistoryPage = useCallback(async () => {
    if (!controller || !daemonId || !sessionId) return
    await controller.loadHistoryPage(async ({ offset, excludeRecentCount }) => {
      const agentType = activeConv.agentType
      const raw = await sendCommand(daemonId, 'chat_history', {
        agentType,
        offset,
        limit: 30,
        targetSessionId: sessionId,
        historySessionId,
        excludeRecentCount,
      })
      const result = raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)
        ? (raw as { result?: { messages?: DashboardMessage[]; hasMore?: boolean } }).result || {}
        : (raw as { messages?: DashboardMessage[]; hasMore?: boolean } | undefined) || {}
      return {
        messages: Array.isArray(result.messages) ? result.messages : [],
        hasMore: result.hasMore === true,
      }
    })
  }, [activeConv.agentType, controller, daemonId, historySessionId, sendCommand, sessionId])

  // (D8 — web self-heal) One-shot authoritative tail re-pull via read_chat. Fed
  // through the controller's SAME apply path as the subscription, so a stale
  // user-only liveMessages is replaced by the daemon's [user, assistant] tail
  // (D2/D6 compose; no duplicate assistant bubble). Fires on mount, on tab focus
  // (visibilitychange→visible), and on WS reconnect — debounced to one request
  // per burst inside the controller.
  const refreshAuthoritativeTail = useCallback((force = false): Promise<void> => {
    if (!controller || !daemonId || !sessionId) return Promise.resolve()
    return controller.refreshAuthoritativeTail(async () => {
      const raw = await sendCommand(daemonId, 'read_chat', {
        agentType: activeConv.agentType,
        targetSessionId: sessionId,
        historySessionId,
        ...(tailLimit > 0 ? { tailLimit } : {}),
      })
      // Response shape differs by transport (see TransportContext note): unwrap
      // the Cloud `result` wrapper, then read the daemon's raw read_chat body.
      const body = (raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)
        ? (raw as { result?: unknown }).result
        : raw) as Record<string, unknown> | undefined
      if (!body || typeof body !== 'object') return null
      if (body.success === false) return null
      const messages = Array.isArray(body.messages)
        ? body.messages as DashboardMessage[]
        : (Array.isArray(body.messagesTail) ? body.messagesTail as DashboardMessage[] : [])
      // Map the read_chat body into the same SessionChatTailUpdate shape the
      // subscription delivers, so handleUpdate applies it identically.
      return {
        topic: 'session.chat_tail',
        key: subscriptionKey,
        sessionId,
        historySessionId,
        seq: 0,
        timestamp: 0,
        messages,
        status: typeof body.status === 'string' ? body.status : 'idle',
        ...(body.messageSource && typeof body.messageSource === 'object'
          ? { messageSource: body.messageSource as Record<string, unknown> }
          : {}),
      } as unknown as SessionChatTailUpdate
    }, { force })
  }, [activeConv.agentType, controller, daemonId, historySessionId, sendCommand, sessionId, subscriptionKey, tailLimit])

  // Mount + tab-focus + reconnect self-heal. Mount fire happens once per active
  // session (deps are the stable identity fields). Focus and reconnect re-pull
  // the authoritative tail so a browser stranded on a stale user-only snapshot
  // recovers without a hard refresh.
  useEffect(() => {
    if (!controller || !enabled || !daemonId || !sessionId) return
    // Initial mount pull.
    void refreshAuthoritativeTail(true)

    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refreshAuthoritativeTail()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }

    // Poll the transport connection state (edge-detect disconnect→connect) to
    // re-pull after a WS reconnect. Cheap: a boolean read on a short interval,
    // and the re-pull itself is debounced.
    let lastConnected = isConnected ? isConnected(daemonId) : true
    const reconnectTimer = setInterval(() => {
      if (!isConnected) return
      const connectedNow = isConnected(daemonId)
      if (connectedNow && !lastConnected) {
        void refreshAuthoritativeTail()
      }
      lastConnected = connectedNow
    }, 2_000)

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
      clearInterval(reconnectTimer)
    }
    // refreshAuthoritativeTail is stable across renders for a given session
    // identity; excluded to keep this a mount/session-scoped effect rather than
    // re-running on every meta append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, daemonId, enabled, sessionId, historySessionId])

  return useMemo(
    () => buildControllerHandle(snapshot, loadHistoryPage),
    [loadHistoryPage, snapshot],
  )
}

export function useWarmSessionChatTailControllers(
  conversations: ActiveConversation[],
  options?: { enabled?: boolean; tailLimit?: number; recentActivityMs?: number },
): void {
  const { sendData } = useTransport()
  const enabled = options?.enabled !== false
  const tailLimit = Math.max(0, options?.tailLimit ?? DEFAULT_TAIL_LIMIT)
  const recentActivityMs = Math.max(0, Number(options?.recentActivityMs ?? DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS))
  const refreshMs = getWarmSessionChatTailDescriptorRefreshMs(recentActivityMs)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!enabled || conversations.length === 0) return
    const timer = setInterval(() => {
      setRefreshTick((prev) => prev + 1)
    }, refreshMs)
    return () => {
      clearInterval(timer)
    }
  }, [conversations.length, enabled, refreshMs])

  const descriptorState = useMemo(
    () => buildWarmSessionChatTailDescriptorState(conversations, { recentActivityMs }),
    [conversations, recentActivityMs, refreshTick],
  )

  useEffect(() => {
    if (!enabled || !sendData || descriptorState.descriptors.length === 0) return
    const controllers = descriptorState.descriptors.map((descriptor) => getOrCreateSessionChatTailController({
      ...descriptor,
      sendData,
      tailLimit,
    }))
    controllers.forEach((controller) => {
      controller.retain()
    })
    return () => {
      controllers.forEach((controller) => controller.release())
    }
  }, [descriptorState.signature, enabled, sendData, tailLimit])
}

/**
 * (B2) Reactive version counter that bumps whenever any warm chat_tail controller
 * for the given conversations emits a new snapshot.
 *
 * The mobile inbox derives its list-item preview/timestamp from the warm
 * controller snapshots via getSessionChatTailSnapshotForConversation(), which is
 * an imperative read of a non-reactive module-level registry Map. That read alone
 * does NOT re-run the inbox `items` memo when a `session.chat_tail` push updates a
 * controller — so previews only refreshed when some OTHER dependency (e.g. opening
 * and closing a conversation) forced the memo to recompute.
 *
 * This hook subscribes to the same controllers the inbox reads and returns a
 * number that increments on every snapshot change. Feed the returned value into
 * the inbox `items` memo dependency array so the memo recomputes (and re-reads the
 * now-updated snapshot) as soon as a new tail arrives — no re-entry required.
 */
export function useWarmSessionChatTailSnapshotVersion(
  conversations: ActiveConversation[],
): number {
  const [version, setVersion] = useState(0)

  const controllerKeys = useMemo(() => {
    const keys: string[] = []
    for (const conversation of conversations) {
      const daemonId = getConversationDaemonRouteId(conversation)
      const sessionId = conversation.sessionId || ''
      if (!daemonId || !sessionId) continue
      const historySessionIdForRead = getConversationHistorySessionIdForRead(conversation)
      keys.push(getControllerKey(daemonId, sessionId, historySessionIdForRead || sessionId))
    }
    return keys
  }, [conversations])

  const controllerKeySignature = controllerKeys.join('|')

  // Track registry membership changes so we (re)subscribe once a warm controller
  // for one of our keys is actually created (it may not exist yet at first run).
  const registryGeneration = useSyncExternalStore(
    subscribeControllerRegistry,
    getControllerRegistryGeneration,
    getControllerRegistryGeneration,
  )

  useEffect(() => {
    if (controllerKeys.length === 0) return
    const unsubscribes: Array<() => void> = []
    for (const key of controllerKeys) {
      const controller = controllerRegistry.get(key)
      if (!controller) continue
      // subscribe() synchronously seeds the listener once with the current
      // snapshot; skip that first call so mount/(re)subscribe doesn't bump.
      let seededSnapshot = false
      unsubscribes.push(
        controller.subscribe(() => {
          if (!seededSnapshot) {
            seededSnapshot = true
            return
          }
          setVersion((prev) => prev + 1)
        }),
      )
    }
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
    // Re-run on membership change (controllerKeySignature) and when a controller
    // is added/removed from the registry (registryGeneration) so late-created
    // warm controllers get subscribed.
  }, [controllerKeySignature, registryGeneration])

  return version
}
