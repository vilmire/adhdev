import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { buildChatMessageSignature } from '@adhdev/daemon-core/chat/chat-signatures'
import type { SessionChatTailUpdate, SubscribeRequest } from '@adhdev/daemon-core'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core/seqscribe/transcript-projection'
import type { ActiveConversation, DashboardMessage } from './types'
import {
  isMappableTranscriptSnapshot,
  mapTranscriptSnapshotToChatTailUpdate,
} from './transcript-chat-pane-adapter'
import { useTransport } from '../../context/TransportContext'
import { subscriptionManager, type SubscriptionHandle, type SubscriptionManager } from '../../managers/SubscriptionManager'
import { getConversationHistorySessionIdForRead } from './conversation-identity'
import { recordTranscriptReplicaFallbackForDiagnostics } from './transcript-fallback-diagnostics'
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
  /**
   * (§8 unit 9) ★ This session was being served by the replica and REGRESSED to
   * legacy. The signal behind the user-visible degradation notice.
   *
   * ── Why this is not `transcriptReadSource === 'legacy'` ────────────────────
   * That condition is true for the overwhelming majority of healthy sessions:
   * every session on a `shadow`-mode daemon (the default) is legacy and always
   * was, and nothing is wrong with it. Alarming on it would put a permanent
   * warning on a working product — which is precisely how the retired
   * "이전 내용 생략" banner failed (it fired when nothing was wrong, was twice
   * reported as a defect, and had to be removed).
   *
   * So this is strictly the TRANSITION: false until a verified replica snapshot
   * has landed at least once, and true only after a fallback follows it. A
   * session that never reached the replica can never set it, by construction —
   * `everHadHealthyReplica` gates the assignment.
   *
   * Cleared when the replica recovers, so the notice disappears on its own
   * rather than latching for the rest of the session.
   */
  transcriptReplicaDegraded: boolean
}

export interface SessionChatHistoryPageRequest {
  offset: number
  excludeRecentCount: number
  /**
   * (SEAM) Identity of the OLDEST message in the live window — the boundary
   * history must page strictly older than.
   *
   * `excludeRecentCount` is counted in this window's BUBBLE space but the daemon
   * subtracts it from COLLAPSED-RECORD space. Those differ whenever collapse
   * shrinks the set (empty content dropped, same-signature neighbours merged,
   * consecutive assistant turns collapsed), and the overshoot makes the
   * in-between messages permanently unreachable — a silent hole.
   *
   * Empty string when this window's oldest message carries no stable identity
   * (legacy transcripts, the PTY path). The daemon then uses the count path
   * unchanged, so an old browser and a new daemon still interoperate.
   */
  excludeFromIdentity: string
}

/**
 * (SEAM) The identity string the daemon resolves a history boundary against.
 *
 * ★ This MUST stay byte-identical to `buildHistoryMessageIdentity` in
 * daemon-core's `config/chat-history.ts` — same preference order, same prefixes.
 * The two are a matched pair across the wire: a key minted here is compared by
 * string equality there, so a divergence does not throw, it just silently stops
 * resolving and falls back to the buggy count path.
 *
 * `_turnKey` is deliberately NOT a candidate: it is turn-grained, so it would
 * resolve the boundary to an arbitrary bubble within the turn.
 */
export function buildHistoryBoundaryIdentity(message?: DashboardMessage): string {
  if (!message) return ''
  const record = message as DashboardMessage & {
    providerUnitKey?: string
    bubbleId?: string
    sequence?: number
  }
  if (record.providerUnitKey) return `unit:${record.providerUnitKey}`
  if (record.bubbleId) return `bubble:${record.bubbleId}`
  if (typeof record.sequence === 'number' && Number.isFinite(record.sequence)) {
    return `seq:${record.sequence}`
  }
  return ''
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
 * (LIVENESS) How often the watchdog ASKS the controller whether a refresh is
 * warranted. This is only the tick rate of a boolean check — it is NOT the
 * request rate. Every tick runs `shouldRefreshForLiveness()`, which almost
 * always answers false; the actual read_chat spacing is governed by the two
 * quiet-period constants below.
 */
const CHAT_TAIL_LIVENESS_TICK_MS = 5_000
/**
 * (LIVENESS) Quiet period after which a BUSY session (generating / streaming /
 * working …) is considered to have stalled and is re-pulled.
 *
 * A generating session normally pushes updates continuously, so 20s of total
 * silence while still claiming to generate means the push lane dropped
 * something. Short, because this is exactly the window in which the user is
 * staring at the pane waiting for the answer.
 */
const CHAT_TAIL_LIVENESS_BUSY_QUIET_MS = 20_000
/**
 * (LIVENESS) Quiet period for an IDLE session. Long, because an idle pane that
 * receives nothing is usually CORRECT — nothing is happening. This exists only
 * to bound the "we missed the final push and the session settled" case, where
 * no further event will ever arrive to correct us.
 */
const CHAT_TAIL_LIVENESS_IDLE_QUIET_MS = 120_000
/**
 * (LEASE) How long a session may go without an APPLIED replica revision before
 * `replicaHealthy` expires and the legacy transport is brought back.
 *
 * ── Why a lease at all ────────────────────────────────────────────────────
 * `replicaHealthy` was a one-shot latch: the first verified snapshot set it
 * true, legacy stood down, and nothing ever re-examined it. A replica that then
 * stopped advancing — the host wedged, the producer stalled, revisions simply
 * stopped — kept reading "healthy" forever, because health was never a function
 * of revision AGE or ADVANCEMENT. With legacy retired and no browser poll, the
 * pane froze indefinitely. The watchdog added earlier cannot rescue this case
 * either: `shouldRefreshForLiveness` refuses outright while `replicaHealthy` is
 * true (a legacy read_chat landing after a newer replica revision is the
 * last-writer-wins hazard). So the latch had to become a lease.
 *
 * ── Why this value ────────────────────────────────────────────────────────
 * Deliberately the SAME 20s the watchdog uses for a busy session
 * (CHAT_TAIL_LIVENESS_BUSY_QUIET_MS), because it answers the identical
 * question about the identical situation: "this session claims to be generating
 * but has produced nothing — how long is that still plausible?" The two paths
 * differ only in which transport is silent, and giving them different numbers
 * would mean a session's stall is detected at 20s or at some other time purely
 * by which lane happened to be serving it. Expressed as a reference to that
 * constant rather than a second literal so the two cannot drift apart.
 */
const CHAT_TAIL_REPLICA_LEASE_BUSY_MS = CHAT_TAIL_LIVENESS_BUSY_QUIET_MS

/**
 * (B) What `handleUpdate` did with an update.
 *
 * `handleUpdate` was `void`, which made every caller unable to distinguish "the
 * pane now shows this" from "this was dropped". The replica path used it as if
 * it meant the former and set `replicaHealthy = true` regardless — so a snapshot
 * that arrived but was deferred/no-op'd/refused could retire the legacy
 * transport without ever putting replica content on screen.
 *
 *  - `applied`  — the snapshot is now the rendered live window.
 *  - `deferred` — arrived and was well-formed, but the shrink-defense / busy
 *                 deferral kept the existing content. Lane is alive; screen
 *                 unchanged.
 *  - `noop`     — arrived and was identical to what is already rendered. Lane is
 *                 alive; screen unchanged, and correctly so.
 *  - `rejected` — not for this session, or an error frame. Tells us nothing.
 */
type ChatTailUpdateOutcome = 'applied' | 'deferred' | 'noop' | 'rejected'
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
    transcriptReplicaDegraded: false,
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
  /**
   * (LIVENESS) Wall-clock of the last moment this controller observed ANY
   * inbound activity for the session — an applied update, or a completed
   * authoritative re-pull. It is the watchdog's staleness clock.
   *
   * ★ Stamped on APPLY, not on arrival: an update that `handleUpdate` rejects
   * (shrink-defense, unchanged signature) has told us the lane is alive, so it
   * would be wrong to treat the pane as stale — but see `lastInboundAt`, which
   * is the field that actually carries that "lane is alive" meaning. This one
   * answers "when did the rendered content last change".
   */
  private lastAppliedAt = 0
  /**
   * (LIVENESS) Wall-clock of the last inbound update of any kind, applied or
   * not. The watchdog measures quiet against THIS, not `lastAppliedAt`: a
   * session that is pushing updates we correctly discard as no-ops is a
   * HEALTHY session, and re-pulling it would be pure waste. Only total silence
   * is evidence that the push lane has dropped.
   */
  private lastInboundAt = 0
  /**
   * (LIVENESS) Last status this controller saw on the wire. Selects which quiet
   * threshold applies — busy sessions get the short one, idle sessions the long
   * one. Starts undefined ("nothing seen yet"), which is treated as idle.
   */
  private lastKnownStatus: unknown = undefined
  /**
   * (§8 unit 9) True once THIS session has applied a verified replica snapshot
   * and has not fallen back since. It is the sole gate on the legacy
   * `session.chat_tail` subscription — see `shouldRunLegacySubscription`.
   *
   * ★ Deliberately NOT derived from `snapshot.transcriptReadSource`, even
   * though the two agree most of the time. `transcriptReadSource` is a LABEL on
   * the last update and is reset by `clearLiveSnapshot()` (tab switch, session
   * reset) back to `'legacy'`; the legacy transport's arming must not be
   * silently toggled by a label reset that says nothing about whether the
   * replica lane is alive. This field tracks the LANE, that field describes the
   * DATA, and conflating them is how a healthy replica session would start
   * re-subscribing to legacy on every pane reset.
   */
  private replicaHealthy = false
  /**
   * (§8 unit 9) Has a verified replica snapshot EVER landed on this session?
   *
   * ★ This is the strictness gate for the degradation notice, and the whole
   * reason it cannot fire on a healthy legacy-only session. `replicaHealthy`
   * alone cannot distinguish "the replica broke" from "there has never been a
   * replica here" — both read false, and the second is the normal state for
   * every session on a `shadow`-mode daemon. Only a session that once had a
   * working replica can be said to have DEGRADED.
   *
   * Never cleared while the controller lives (a lane that worked once is
   * expected to work again); reset by `dispose()` alongside `replicaHealthy`.
   */
  private everHadHealthyReplica = false
  /**
   * (LEASE) Wall-clock of the last moment the replica lane demonstrably MOVED
   * for this session — a snapshot whose revision was higher than the previous
   * one. This is the lease clock, and it is deliberately stamped on
   * ADVANCEMENT rather than on arrival: a lane re-delivering the same revision
   * forever is precisely the stall this exists to detect, so counting those
   * deliveries as health would renew the lease off the very symptom.
   */
  private lastReplicaAdvanceAt = 0
  /**
   * (LEASE) Highest replica revision seen for this session, the comparison
   * basis for "did it advance". Replica revisions are monotonic within one
   * producer epoch (transcript-chat-pane-adapter.ts maps `snapshot.revision`),
   * which is the only ordering property this needs — it never orders replica
   * against legacy, and must not be confused with the seq-ordering that
   * `applyTranscriptReplicaSnapshot` documents as deliberately absent.
   */
  private lastReplicaRevision = 0
  /**
   * (LEASE) Wall-clock of the last replica snapshot that reported a BUSY status,
   * which is the activity signal that arms lease expiry at all.
   *
   * ★ Without this the lease is actively harmful. A session whose agent is
   * genuinely idle produces no new revisions BY DESIGN — that is the correct
   * steady state of every settled session on the dashboard. Expiring the lease
   * on quiet alone would therefore revive the legacy subscription on every idle
   * session in the workspace, permanently, manufacturing exactly the transport
   * load unit 9 removed and doing it worst on the sessions that need it least.
   *
   * So the lease only expires for a session the replica ITSELF last described as
   * generating: the lane asserted work was in progress, then stopped reporting
   * on it. That is a contradiction the replica cannot explain, and the only
   * shape of silence that is evidence of a stall rather than of calm.
   */
  private lastReplicaBusyAt = 0

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
    // (§8 unit 9) ★ RE-ARM FIRST, and OUTSIDE the dedup guard below.
    //
    // Any fallback, for any reason, means the replica is no longer serving this
    // session — so the legacy transport must come back before anything else,
    // including before the early return. The dedup guard exists to avoid
    // re-emitting an identical label; it must never be allowed to skip the
    // re-arm, because the second identical report is exactly the case where a
    // resubscribe was previously dropped (report `no_node`, controller
    // retained later, report `no_node` again → still unsubscribed forever).
    const wasHealthy = this.replicaHealthy
    this.replicaHealthy = false
    if (wasHealthy || !this.transportSubscription) this.syncLegacySubscription()

    // (§8 unit 9) ★ Make the regression VISIBLE — but only for a session that
    // actually had a working replica. A session that never reached the replica
    // is not degraded, it is simply a legacy session, and marking it would put
    // a permanent warning on every session of a `shadow`-mode daemon.
    //
    // ★ Counted BEFORE the dedup return below, for the same reason the re-arm
    // is: the diagnostic must not miss a repeat report.
    const degraded = this.everHadHealthyReplica
    if (degraded && wasHealthy) recordTranscriptReplicaFallbackForDiagnostics(reason)

    if (
      this.snapshot.transcriptReadSource === 'legacy'
      && this.snapshot.transcriptFallbackReason === reason
      && this.snapshot.transcriptReplicaDegraded === degraded
    ) return
    this.snapshot = {
      ...this.snapshot,
      transcriptReadSource: 'legacy',
      transcriptFallbackReason: reason,
      transcriptReplicaDegraded: degraded,
    }
    this.emit()
  }

  /**
   * (§8 unit 4b) Apply a verified transcript replica snapshot.
   *
   * Routes through the SAME `handleUpdate` every legacy `session.chat_tail`
   * update takes, deliberately: the shrink-defense, dedup, force-apply and
   * busy-deferral rules there are transcript-source-agnostic and must not be
   * bypassed just because this update came from the replica. The only thing
   * that differs is the labelling the adapter puts on the update
   * (`transcriptReadSource: 'replica'`, plus `omittedBefore`/`stale`), which
   * `handleUpdate` already reads.
   *
   * The two sources are never merged into one live window: whichever update
   * arrives last wins, exactly as two legacy updates would.
   *
   * ── Why last-writer-wins, and NOT `seq` ordering ───────────────────────────
   * `handleUpdate` deliberately does not read `update.seq`. It is not an
   * oversight to fix by adding a comparison: the three sources that reach this
   * method carry `seq` values from three INCOMPARABLE domains, and each has a
   * defect that makes it unusable as an ordering key.
   *
   *   1. `read_chat` re-pull (`refreshAuthoritativeTail`) hardcodes `seq: 0`.
   *      That path exists precisely to OVERRIDE a stale live window (D8
   *      self-heal); ordering it by seq would make the self-heal always lose.
   *   2. Legacy `session.chat_tail` seq is a PER-SUBSCRIPTION counter — the
   *      daemon seeds `seq: 0` per subscription entry (topic-registry.ts) and
   *      increments per delivery (subscription-updates.ts). It resets on every
   *      resubscribe, so after a WS reconnect every fresh update would sit
   *      below the pre-reconnect high-water mark and be rejected forever.
   *   3. Replica seq is `snapshot.revision` (transcript-chat-pane-adapter.ts),
   *      a transcript revision from an unrelated numbering space.
   *
   * Per-SOURCE monotonicity (rejecting only replica-vs-replica regressions) is
   * the one variant that is not immediately self-defeating, but it does not
   * address the risk either: the flap this would be meant to prevent is
   * CROSS-source interleaving, which per-source ordering cannot order by
   * construction. Ordering these sources needs a shared monotonic clock the
   * wire does not currently carry — introducing one is a protocol change, not a
   * local fix here. Until then last-writer-wins is the deliberate contract, and
   * the shrink-defense / force-apply / dedup rules above are what actually
   * protect the window from a bad update.
   *
   * ── (§8 unit 9-pre-c) Structural refusal ───────────────────────────────
   * ★ A snapshot missing a required field is REFUSED here and reported as a
   * `revision_invalid` fallback, rather than being mapped on a best-effort
   * basis. The motivating case is `activeModal`: the mapper's
   * `snapshot.activeModal ? ... : null` cannot tell "no modal" from "the
   * projection stopped sending the field", so a regression rendered an
   * approval-waiting session with no approval UI and reported nothing.
   *
   * Refusing keeps the pane on whatever legacy already put there and makes the
   * fault observable — the same decline-and-fall-back contract roster ids 3-8
   * already have (`isUsableSnapshot` in mcp-server / unit 7's daemon router).
   * It does not throw: this runs inside a MessagePort `onmessage` handler with
   * no catch above it, where a throw would drop the delivery silently.
   */
  applyTranscriptReplicaSnapshot(
    snapshot: ReplicatedTranscriptSnapshotV1,
    options: { omittedBefore: boolean; stale?: boolean },
  ): void {
    if (!isMappableTranscriptSnapshot(snapshot)) {
      this.reportTranscriptReplicaFallback('revision_invalid')
      return
    }
    const outcome = this.handleUpdate(
      mapTranscriptSnapshotToChatTailUpdate(snapshot, {
        subscriptionKey: this.subscriptionKey,
        omittedBefore: options.omittedBefore,
        stale: options.stale === true,
      }),
    )

    // (LEASE) Renew on ADVANCEMENT, before the health gate below. A revision
    // that moved forward is the lane demonstrating it is still producing, which
    // is the one fact the lease measures. Revisions that repeat or regress
    // deliberately do NOT renew: re-delivery of a frozen revision is the stall
    // itself, and letting it renew would make the lease unexpirable.
    const revision = typeof snapshot.revision === 'number' ? snapshot.revision : 0
    const advanced = revision > this.lastReplicaRevision
    if (advanced) {
      this.lastReplicaRevision = revision
      this.lastReplicaAdvanceAt = this.now()
    }
    // (LEASE) Arm expiry only while the replica itself says work is in progress.
    // See `lastReplicaBusyAt` — an idle session's silence is correct, and
    // expiring on it would revive legacy across every settled session.
    if (isBusyChatTailStatus(snapshot.status)) this.lastReplicaBusyAt = this.now()

    // (§8 unit 9) ★ Suppress legacy only AFTER a verified snapshot has actually
    // been applied — never on arrival, and never before the structural refusal
    // above. Ordering is the whole safety property: retiring the legacy
    // transport on the *promise* of a replica read is what would produce an
    // empty pane, so the transport is stood down only once this session has
    // real replica content on screen.
    //
    // (B) ★ "Applied" means APPLIED. This gate previously fired on arrival,
    // treating a `deferred`/`noop`/`rejected` outcome as proof of health on the
    // reasoning that delivery alone shows the lane is alive. That reasoning is
    // right about the LANE and wrong about the SCREEN, and this flag controls
    // the screen: it retires the only other transport feeding the pane. The
    // dangerous case is the FIRST snapshot — arriving during a busy-deferral
    // window it is held, nothing replica-authored is rendered, and legacy is
    // nonetheless torn down, leaving the pane on whatever legacy last put there
    // with no source able to correct it. A deferred snapshot keeps legacy
    // running; the next one that actually lands earns the retirement.
    if (!this.replicaHealthy && outcome === 'applied') {
      this.replicaHealthy = true
      this.everHadHealthyReplica = true
      // (LEASE) Seed the lease clock at the moment health is granted. A first
      // snapshot that applied without advancing a revision (revision 0, or a
      // re-applied same revision) would otherwise start life with
      // `lastReplicaAdvanceAt === 0` and be judged instantly stale.
      if (this.lastReplicaAdvanceAt === 0) this.lastReplicaAdvanceAt = this.now()
      this.syncLegacySubscription()
    }

    // (§8 unit 9) The lane is serving again — retract the degradation notice.
    // Recovery clears it rather than latching, so the notice describes CURRENT
    // health and disappears on its own once the replica is back.
    if (this.snapshot.transcriptReplicaDegraded) {
      this.snapshot = { ...this.snapshot, transcriptReplicaDegraded: false }
      this.emit()
    }
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
    // (§8 unit 4c) 0 → 1 is the edge where this session becomes READ, which is
    // exactly when transcript interest must widen to include it. Only the edge
    // notifies: a second consumer retaining an already-read controller changes
    // no interest set, and notifying on it would churn every subscriber.
    if (this.retainCount === 1) notifyControllerRegistryChanged()
  }

  /**
   * (§8 unit 4c) Is some mounted consumer currently reading this controller?
   *
   * The registry is append-only — a controller is never deleted once created,
   * so registry MEMBERSHIP is a record of every session ever opened this page
   * load, not of what is being read now. `retainCount` is the only thing that
   * distinguishes the two, which makes this the least-privilege filter for
   * transcript session interest: declaring on membership would grant the
   * daemon-side transcript topics for every session the user ever clicked.
   */
  isRetained(): boolean {
    return this.retainCount > 0
  }

  /**
   * (§8 unit 4c) The routing pair this controller reads, for callers that must
   * group controllers by daemon. Deliberately omits `historySessionId`: the
   * session-interest wire contract is a set of SESSION ids, and two controllers
   * for one session (pane + warm inbox) must collapse to one declared id.
   */
  getIdentity(): { daemonId: string; sessionId: string } {
    return { daemonId: this.daemonId, sessionId: this.sessionId }
  }

  release(): void {
    const wasRetained = this.retainCount > 0
    this.retainCount = Math.max(0, this.retainCount - 1)
    // (§8 unit 4c) The 1 → 0 edge NARROWS transcript interest. Notified before
    // the deferred disconnect below so the grant is revoked promptly rather
    // than waiting on the transport teardown timer.
    if (wasRetained && this.retainCount === 0) notifyControllerRegistryChanged()
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
          // The boundary is the OLDEST message of the live window — history pages
          // strictly older than it. Sent alongside the count, never instead of
          // it: the daemon falls back to the count whenever it cannot resolve
          // this identity, so a mixed-version fleet degrades to today's behavior
          // rather than mis-seaming.
          excludeFromIdentity: buildHistoryBoundaryIdentity(this.snapshot.liveMessages[0]),
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
  /**
   * (LIVENESS) Should the watchdog spend a `read_chat` right now?
   *
   * ── The defect this closes ────────────────────────────────────────────────
   * Every existing `refreshAuthoritativeTail` trigger is an EDGE: mount,
   * Dockview hidden→visible, `visibilitychange`→visible, P2P reconnect. A pane
   * that stays continuously visible therefore has no recovery path at all — if
   * it misses one push it renders a stale tail INDEFINITELY, which is exactly
   * the reported "messages never update unless I switch tabs or send". The
   * user's own workaround (bounce to another view and back) is just them
   * manufacturing the `refreshEnabled` false→true edge by hand.
   *
   * ── Why this is not simply a poll ─────────────────────────────────────────
   * Polling every visible pane on a fixed short interval would multiply
   * read_chat traffic by (open panes × session lifetime) for a defect that
   * fires rarely. So the answer is false in every healthy case, and the checks
   * are ordered cheapest-first:
   *
   *   1. Nothing has EVER arrived → the mount pull owns this, not us. A
   *      session that has produced no inbound update has no "stopped
   *      updating" to detect, and firing here would race the mount pull.
   *   2. A re-pull is already in flight → single-flight; never stack requests.
   *   3. The replica lane is healthy → the transcript replica is the
   *      authority for this session and pushes its own revisions. A watchdog
   *      read_chat here is the last-writer-wins hazard called out in review:
   *      a legacy tail landing after a newer replica revision would overwrite
   *      current content with older content. Refuse outright.
   *   4. Quiet period not yet elapsed, measured against `lastInboundAt` and
   *      scaled by status — short while busy (a generating session that has
   *      gone silent is anomalous), long while idle (silence is the normal
   *      and correct state).
   */
  /**
   * (LEASE) Expire `replicaHealthy` when the replica lane has stopped advancing
   * on a session it last described as busy, re-arming legacy in its place.
   *
   * ── Why the busy gate is load-bearing, not a refinement ───────────────────
   * The hard part of this defect is not detecting silence — it is telling a
   * STALLED replica apart from an IDLE agent, because both look identical from
   * here: no new revisions. Idle is the steady state of nearly every session on
   * the dashboard, so a lease that expires on quiet alone would resubscribe
   * legacy for all of them and never stop, which is a worse and much broader
   * regression than the freeze it set out to fix.
   *
   * `lastReplicaBusyAt` is the discriminator. It is sourced from the replica's
   * OWN last reported status, which makes the expiry condition a
   * self-contradiction rather than an inference: the lane said "generating" and
   * then went silent about it. An idle session never arms it, so an idle
   * session's lease never expires and its legacy transport stays retired.
   *
   * ★ The busy stamp deliberately is NOT refreshed by the passage of time — it
   * ages out with the same lease window. A session that was busy long ago and
   * has since been quiet is not "still busy"; requiring the busy report to be
   * recent keeps this from firing once on every session that ever generated.
   */
  private expireStaleReplicaLease(): void {
    if (!this.replicaHealthy) return
    if (this.lastReplicaBusyAt === 0) return
    const nowMs = this.now()
    // Never armed for this window — the last busy report is itself older than
    // the lease, so treat the session as settled rather than stalled.
    if ((nowMs - this.lastReplicaBusyAt) > CHAT_TAIL_REPLICA_LEASE_BUSY_MS) return
    if ((nowMs - this.lastReplicaAdvanceAt) < CHAT_TAIL_REPLICA_LEASE_BUSY_MS) return
    // Route through the existing fallback path rather than clearing the flag
    // inline: it re-arms legacy, records the diagnostic and surfaces the
    // degradation notice, all of which apply verbatim to a stalled lane.
    this.reportTranscriptReplicaFallback('replica_lease_expired')
  }

  shouldRefreshForLiveness(): boolean {
    // (LEASE) Evaluated on the watchdog's existing 5s tick — the lease needs no
    // timer of its own, and this is the same cadence that already decides pane
    // staleness. Runs FIRST so a lease that expires on this tick also releases
    // the `replicaHealthy` refusal below, letting the authoritative re-pull that
    // rescues the frozen pane happen on the very same tick instead of the next.
    this.expireStaleReplicaLease()
    if (this.lastInboundAt === 0) return false
    if (this.authoritativeRefreshPromise) return false
    // ★ Replica is authoritative and self-pushing — a legacy read_chat here
    // could regress the pane to older content (last-writer-wins).
    if (this.replicaHealthy) return false
    const quietMs = this.now() - this.lastInboundAt
    const threshold = isBusyChatTailStatus(this.lastKnownStatus)
      ? CHAT_TAIL_LIVENESS_BUSY_QUIET_MS
      : CHAT_TAIL_LIVENESS_IDLE_QUIET_MS
    return quietMs >= threshold
  }

  /**
   * (LIVENESS) Test/diagnostic view of the watchdog clocks. Read-only.
   */
  getLivenessStateForTest(): { lastInboundAt: number; lastAppliedAt: number; lastKnownStatus: unknown } {
    return {
      lastInboundAt: this.lastInboundAt,
      lastAppliedAt: this.lastAppliedAt,
      lastKnownStatus: this.lastKnownStatus,
    }
  }

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
        // (LIVENESS) A completed re-pull resets the quiet clock even when the
        // response carried nothing new. Without this, a session whose lane is
        // genuinely dead would satisfy the quiet threshold on EVERY subsequent
        // tick and the watchdog would degenerate into a fixed-interval poll —
        // the RPC storm this design exists to avoid. `handleUpdate` already
        // stamped it when an update did arrive; this covers the empty case.
        this.lastInboundAt = this.now()
      } catch {
        // Best-effort self-heal — a failed re-pull just leaves the existing
        // snapshot untouched; the next focus/reconnect retries.
        // (LIVENESS) Reset the quiet clock on failure too. An offline or erroring
        // daemon must back off to one attempt per quiet period, not one per tick.
        this.lastInboundAt = this.now()
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

  /**
   * (§8 unit 9) Whether the legacy `session.chat_tail` push subscription should
   * be running for this session RIGHT NOW.
   *
   * ── Why per-session replica health, and not the build flag ────────────────
   * The obvious gate — `isTranscriptWorkerEnabled()` — is unusable, and using
   * it would delete the chat pane's only working transport. That flag is a
   * BROWSER BUILD-TIME boolean: it says the worker was wired into this bundle,
   * not that any daemon is actually producing replica revisions. A daemon whose
   * `ADHDEV_SEQSCRIBE_TRANSCRIPT` is unset resolves to `shadow`
   * (`daemon-core/src/seqscribe/transcript-mode.ts:39`) — and `shadow` is the
   * DEFAULT. So "flag on" routinely coexists with "zero replica content", and
   * gating on it would blank those panes with nothing to fall back to.
   *
   * The lane can also disappear at runtime long after any flag was read: the
   * daemon closing the replication channel surfaces as `onSeqscribeTransport(null)`
   * → `stopTranscriptHost` → a `no_node` fallback report (web-cloud
   * `p2p-manager.ts`). A build-time constant cannot observe that at all.
   *
   * So the gate is the only signal that actually tracks the thing we care
   * about: has a VERIFIED replica snapshot been applied to this very session,
   * and has nothing reported a fallback since. It is self-healing in both
   * directions and needs no environment knowledge whatsoever — a shadow daemon,
   * a severed lane, and a browser built without the worker all look identical
   * from here (`replicaHealthy === false`) and all keep legacy running.
   */
  private shouldRunLegacySubscription(): boolean {
    return !this.replicaHealthy
  }

  /**
   * (§8 unit 9) Bring the legacy transport in line with current replica health.
   *
   * Called on every health transition. Idempotent in both directions:
   * `connect()` no-ops when a subscription already exists and `disconnect()`
   * no-ops when none does, so a repeated fallback report or a burst of replica
   * snapshots does not churn the subscription.
   */
  private syncLegacySubscription(): void {
    if (this.retainCount <= 0) return
    if (this.shouldRunLegacySubscription()) this.connect()
    else this.disconnect()
  }

  private connect(): void {
    if (this.transportSubscription || !this.sendData || !this.daemonId || !this.sessionId) return
    // (§8 unit 9) A healthy replica serves this session; legacy stays dormant
    // until a fallback re-arms it.
    if (!this.shouldRunLegacySubscription()) return
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
    // (§8 unit 9) ★ Disarm the suppression, not just the subscription. A
    // disposed controller may be retained again later (the registry recycles by
    // key), and the replica lane does NOT survive disposal — the worker host is
    // per-daemon and re-seeds interest on reconnect. Leaving this true would
    // bring the controller back up with legacy suppressed and no replica
    // feeding it: a permanently empty pane. Health must be re-earned by an
    // actual snapshot after every dispose.
    this.replicaHealthy = false
    // ★ Reset the degradation gate too. A recycled controller has no lane, so
    // it has no history of one either — otherwise the next fallback on a fresh
    // controller would claim a regression that never happened here.
    this.everHadHealthyReplica = false
    // (LEASE) Reset the lease clocks with the health they measure. A recycled
    // controller inherits no revision history — keeping the old high-water
    // revision would make the next lane's first snapshots read as "not
    // advancing" and expire a perfectly healthy lease.
    this.lastReplicaAdvanceAt = 0
    this.lastReplicaRevision = 0
    this.lastReplicaBusyAt = 0
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.snapshot))
  }

  private handleUpdate(update: SessionChatTailUpdate): ChatTailUpdateOutcome {
    if (update.error) return 'rejected'
    const updateSessionId = readUpdateStringField(update, 'sessionId')
    if (updateSessionId && updateSessionId !== this.sessionId) return 'rejected'

    const updateHistorySessionId = readUpdateStringField(update, 'historySessionId')
    if (updateHistorySessionId && this.historySessionId && updateHistorySessionId !== this.historySessionId) return 'rejected'

    const nextMessages = readChatTailUpdateMessages(update)
    const incomingMessageSource = (update as SessionChatTailUpdate & { messageSource?: Record<string, unknown> }).messageSource

    // (CHAT-DISAPPEAR-REAPPEAR) Compute the generating→idle transition window using
    // the PREVIOUS active-status stamp, then refresh the stamp for THIS update if it
    // is itself warm/active or busy. An `idle` update that lands within
    // DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS of the last active status is
    // still subjected to the shrink-defense, so the stale short tail emitted at the
    // instant generating ends cannot overwrite the hydrated bubbles.
    const updateTime = this.now()
    // (LIVENESS) The lane is demonstrably alive: stamp inbound BEFORE any
    // apply/discard decision, so a stream of correctly-discarded no-op updates
    // still counts as health and never triggers a watchdog re-pull.
    this.lastInboundAt = updateTime
    this.lastKnownStatus = update.status
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
      return 'deferred'
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
    if (unchanged) return 'noop'
    this.lastAppliedAt = updateTime
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
    return 'applied'
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

/**
 * (§8 unit 4b) Deliver a verified replica snapshot to every warm controller for
 * `(daemonId, sessionId)`.
 *
 * Prefix-matched rather than exact-keyed because one session can have several
 * controllers alive at once — the pane's (keyed by `historySessionId`) and the
 * mobile inbox's warm one (keyed by the sessionId) — and BOTH are legitimate
 * consumers of the same transcript. This is what makes `web_warm_mobile_preview`
 * need no separate subscription: it reads the snapshot this call already
 * applied.
 *
 * Returns how many controllers were updated; 0 means nothing is warm for this
 * session, which is normal (the replica arrived for a session the user is not
 * looking at) and NOT a fallback condition.
 */
export function applyTranscriptReplicaSnapshotToControllers(
  daemonId: string,
  sessionId: string,
  snapshot: ReplicatedTranscriptSnapshotV1,
  options: { omittedBefore: boolean; stale?: boolean },
): number {
  if (!daemonId || !sessionId) return 0
  const prefix = `${daemonId}::${sessionId}::`
  let applied = 0
  for (const [key, controller] of controllerRegistry.entries()) {
    if (!key.startsWith(prefix)) continue
    controller.applyTranscriptReplicaSnapshot(snapshot, options)
    applied += 1
  }
  return applied
}

/**
 * (§8 unit 4b, design §5.6) Label every warm controller for this session as
 * having fallen back to legacy, with a reason.
 *
 * Telemetry only — it never touches `liveMessages`, so the legacy
 * `session.chat_tail` subscription that is still running remains the single
 * source of what is displayed. That is the whole fallback direction: replica →
 * legacy, never the reverse.
 */
export function reportTranscriptReplicaFallbackForSession(
  daemonId: string,
  sessionId: string,
  reason: string,
): void {
  if (!daemonId || !sessionId) return
  const prefix = `${daemonId}::${sessionId}::`
  for (const [key, controller] of controllerRegistry.entries()) {
    if (key.startsWith(prefix)) controller.reportTranscriptReplicaFallback(reason)
  }
}

/**
 * (§8 unit 4c) Which sessions, per daemon, are being READ right now.
 *
 * This is the transcript-replica interest source, and it is derived rather
 * than declared for one reason: the set of sessions the chat pane and the warm
 * mobile preview are reading is ALREADY materialized here, as the retained
 * entries of the controller registry. Those are exactly roster ids 1-2
 * (`web_chat_pane` / `web_warm_mobile_preview`, design §4) — the two consumers
 * a replica snapshot is delivered to by
 * `applyTranscriptReplicaSnapshotToControllers`. Deriving from the same
 * registry keeps "what we asked the daemon to replicate" and "what we can
 * actually deliver to" from drifting apart; threading the selection through
 * React separately would let one change without the other, which is the
 * failure mode that leaves the lane granted but the panes on legacy.
 *
 * ── Least privilege (design §9 item 4) ────────────────────────────────────
 * Filtered on `isRetained()`, NOT on registry membership. The registry is
 * append-only, so membership accumulates every session opened this page load;
 * granting on that would keep widening the daemon's grant map for the whole
 * session. Retention drops on unmount, so the declared set tracks what is
 * mounted.
 *
 * Keys are daemonIds; values are deduped and sorted so a caller can compare
 * two results for equality without normalizing first.
 */
export function collectRetainedTranscriptSessionInterest(): Map<string, string[]> {
  const byDaemon = new Map<string, Set<string>>()
  for (const controller of controllerRegistry.values()) {
    if (!controller.isRetained()) continue
    const { daemonId, sessionId } = controller.getIdentity()
    if (!daemonId || !sessionId) continue
    const existing = byDaemon.get(daemonId)
    if (existing) existing.add(sessionId)
    else byDaemon.set(daemonId, new Set([sessionId]))
  }
  // A controller is keyed by `daemonId::sessionId::historySessionId`, so one
  // session can have two entries (pane + warm inbox, differing history id).
  // The wire contract is a set of SESSION ids, hence the dedup above.
  const result = new Map<string, string[]>()
  for (const [daemonId, sessionIds] of byDaemon.entries()) {
    result.set(daemonId, [...sessionIds].sort())
  }
  return result
}

/**
 * (§8 unit 4c) Subscribe to changes in the retained-session set.
 *
 * Fires on controller creation and on every retain/release EDGE (0↔1), which
 * are precisely the transitions that change the result of
 * `collectRetainedTranscriptSessionInterest`. Callers re-read and diff; this
 * intentionally carries no payload so there is one derivation path, not two.
 */
export function subscribeTranscriptSessionInterest(listener: () => void): () => void {
  return subscribeControllerRegistry(listener)
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
  options?: { enabled?: boolean; tailLimit?: number; refreshEnabled?: boolean },
): SessionChatTailControllerHandle {
  const { sendData, sendCommand, isConnected } = useTransport()
  const enabled = options?.enabled !== false
  // (CHAT-TAB-SWITCH-STALE-FALLBACK) Panel visibility must NOT gate `enabled`.
  // Dropping the controller when a pane is merely hidden empties the snapshot
  // (`hasLiveSnapshot: false`), which makes the pane fall back to the stale
  // status-meta `conversation.messages` list — the "old messages then catch-up"
  // the user sees on every session-tab switch. Visibility only gates the
  // one-shot authoritative re-pull below, which is the part that actually costs
  // a round trip; holding the (registry-shared, refcounted) subscription while
  // hidden is what keeps the live window intact across a switch.
  const refreshEnabled = options?.refreshEnabled !== false
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
    await controller.loadHistoryPage(async ({ offset, excludeRecentCount, excludeFromIdentity }) => {
      const agentType = activeConv.agentType
      const raw = await sendCommand(daemonId, 'chat_history', {
        agentType,
        offset,
        limit: 30,
        targetSessionId: sessionId,
        historySessionId,
        excludeRecentCount,
        // Omitted when empty so the payload an old browser sends and the payload
        // a new browser sends for an identity-less transcript are the same shape.
        ...(excludeFromIdentity ? { excludeFromIdentity } : {}),
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
    if (!controller || !enabled || !refreshEnabled || !daemonId || !sessionId) return
    // Initial mount pull. Also fires on the hidden→visible edge, because
    // `refreshEnabled` is a dep: a pane that comes back into view re-pulls the
    // authoritative tail once. It does so on top of a live snapshot that was
    // never dropped, so it corrects rather than repopulates — no stale-fallback
    // frame in between.
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

    // (LIVENESS) Watchdog for the continuously-visible pane. Every existing
    // trigger above is an edge — mount, hidden→visible, focus, reconnect — so a
    // pane that never changes visibility has no recovery path and stays stale
    // forever once it misses a push. This tick is only a boolean check; the
    // controller decides (single-flight, replica-safe, status-scaled quiet
    // period) and answers false in every healthy case, so it costs no RPC
    // unless the lane has actually gone silent.
    const livenessTimer = setInterval(() => {
      if (!controller.shouldRefreshForLiveness()) return
      void refreshAuthoritativeTail()
    }, CHAT_TAIL_LIVENESS_TICK_MS)

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
      clearInterval(reconnectTimer)
      clearInterval(livenessTimer)
    }
    // refreshAuthoritativeTail is stable across renders for a given session
    // identity; excluded to keep this a mount/session-scoped effect rather than
    // re-running on every meta append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, daemonId, enabled, refreshEnabled, sessionId, historySessionId])

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
