import type { SessionChatTailUpdate, SubscribeRequest } from '@adhdev/daemon-core'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core/seqscribe/transcript-projection'
import type { ActiveConversation, DashboardMessage } from './types'
import {
  isMappableTranscriptSnapshot,
  mapTranscriptSnapshotToChatTailUpdate,
  type TranscriptChatTailUpdate,
} from './transcript-chat-pane-adapter'
import { subscriptionManager, type SubscriptionHandle, type SubscriptionManager } from '../../managers/SubscriptionManager'
import { getConversationHistorySessionIdForRead } from './conversation-identity'
import {
  WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES,
  isBusyChatTailStatus,
  isTerminalChatTailStatusEvent,
  shouldGuardTailShrinkForStatus,
} from './chat-tail-status-classification'

// Barrel-preserving re-export: `src/index.ts` and existing importers resolve
// `isTerminalChatTailStatusEvent` through this module. See the pure-move note in
// `chat-tail-status-classification.ts`.
export { isTerminalChatTailStatusEvent }
import { recordTranscriptReplicaFallbackForDiagnostics } from './transcript-fallback-diagnostics'
import { getConversationDaemonRouteId } from './conversation-selectors'
import {
  DEFAULT_TAIL_LIMIT,
  buildChatSnapshotSignature,
  buildLastMessageSignature,
  buildReadChatCursor,
  decideChatTailUpdate,
  lastSubstantiveAssistantIdentity,
  normalizeMessageSource,
  readChatTailUpdateMessages,
  readUpdateBooleanField,
  readUpdateOptionalStringField,
  readUpdateStringField,
  readUpdateTranscriptReadSource,
  shouldForceApplyNativeAssistantTail,
} from './chat-tail-update-decision'

// Barrel-preserving re-export: the web-core test suite, `session-chat-tail-hooks.ts`,
// and any external importer resolve these through this module (pre-move path).
// Pure move — see `chat-tail-update-decision.ts`.
export { DEFAULT_TAIL_LIMIT, buildLastMessageSignature, buildReadChatCursor }


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
   * Dashboard activity-toggle state. When true, the legacy `session.chat_tail`
   * subscription (and the daemon push it drives) asks read_chat for
   * tool/terminal/thought rows inline (`includeActivity`). Off keeps the wire
   * byte-identical to the pre-toggle behavior — no bandwidth change. The
   * replica lane is unaffected either way (its snapshots are
   * caller-independent and always carry activity; rendering filters by
   * classification).
   */
  includeActivity?: boolean
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
export const CHAT_TAIL_LIVENESS_TICK_MS = 5_000
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
 * (LIVENESS) Floor on the quiet period for a HIDDEN pane, applied on top of the
 * status-scaled window above (the effective threshold is the MAX of the two).
 *
 * ── Why the hidden case needs its own floor ───────────────────────────────
 * The watchdog is armed on `enabled` (session identity), not `refreshEnabled`
 * (panel visibility), because a backstop that switches off exactly when no edge
 * can fire is not a backstop — see the effect in `useSessionChatTailController`.
 * That is correct for recovery but changes the LOAD shape, in two ways that do
 * not apply to a visible pane:
 *
 *   1. CARDINALITY. Visible panes are bounded by screen real estate — a handful.
 *      Hidden controllers are retained for every warm session in the workspace
 *      (`useWarmSessionChatTailControllers`), so the armed population becomes
 *      "every session" rather than "every pane the user can see". The per-
 *      controller cost is unchanged; the number of controllers is not.
 *   2. URGENCY. A visible pane's staleness is being read RIGHT NOW, which is why
 *      a busy one is worth checking at 20s. A hidden pane is not being read at
 *      all; its staleness only has to be gone by the time the user looks at it,
 *      and re-entering the pane fires the mount/visibility edge anyway. So the
 *      deadline that matters is "before it is next shown", not "within 20s".
 *
 * The floor is therefore set to the BUSY case's benefit: it collapses the busy
 * window (20s → 60s) where the asymmetry is largest, while leaving the idle
 * window (120s) already above it and untouched. A hidden lane that is genuinely
 * dead costs one read_chat per 60s at worst, versus three under the visible
 * window — and the backoff in `refreshAuthoritativeTail` (which stamps
 * `lastInboundAt` on empty and failed pulls alike) is what makes "at worst"
 * hold, rather than one request per 5s tick.
 */
export const CHAT_TAIL_LIVENESS_HIDDEN_QUIET_FLOOR_MS = 60_000
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
export const DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS = 120_000
export const controllerRegistry = new Map<string, SessionChatTailController>()

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

export function subscribeControllerRegistry(listener: () => void): () => void {
  controllerRegistryListeners.add(listener)
  return () => {
    controllerRegistryListeners.delete(listener)
  }
}

export function getControllerRegistryGeneration(): number {
  return controllerRegistryGeneration
}

export function getControllerKey(daemonId: string, sessionId: string, historySessionId?: string): string {
  return `${daemonId}::${sessionId}::${historySessionId || sessionId}`
}

export function buildEmptySnapshot(tailLimit = DEFAULT_TAIL_LIMIT): SessionChatTailSnapshot {
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

export class SessionChatTailController {
  private manager: SubscriptionManager
  private sendData?: (daemonId: string, data: any) => boolean
  private daemonId: string
  private sessionId: string
  private historySessionId?: string
  private subscriptionKey: string
  private fallbackRecentCount: number
  /** Dashboard activity-toggle state — see SessionChatTailControllerOptions. */
  private includeActivity: boolean
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
   * not. It means "the push lane is alive", and it is stamped before the apply
   * decision precisely so a correctly-discarded no-op still counts.
   *
   * ★ (D3) It is NO LONGER the watchdog's quiet clock — that is `lastAppliedAt`.
   * The original reasoning ("a session pushing no-ops is healthy, re-pulling it
   * is waste") is right about the LANE and wrong about the SCREEN, and the
   * watchdog guards the screen: a producer re-emitting one frozen revision is
   * inbound traffic on every tick, which pinned quiet at zero forever and
   * disarmed the watchdog on the exact failure it exists for. This field still
   * gates the "nothing has ever arrived" check, where its meaning is the one
   * required.
   */
  private lastInboundAt = 0
  /**
   * (LIVENESS) Last status this controller saw on the wire. Selects which quiet
   * threshold applies — busy sessions get the short one, idle sessions the long
   * one. Starts undefined ("nothing seen yet"), which is treated as idle.
   */
  private lastKnownStatus: unknown = undefined
  /**
   * (PERF) The last replica snapshot whose mapping this controller already ran
   * AND which resolved to `noop` — the key for the map-skip in
   * `applyTranscriptReplicaSnapshot`. Held by REFERENCE, never deep-compared:
   * the assembler reuses one frozen object across repeat deliveries of a
   * revision, so `===` is a sound "provably unchanged" test and a new revision
   * is always a new object. Cleared on any non-`noop` outcome so a deferral or
   * an apply can never be replayed as a skip.
   */
  private lastMappedRevisionSnapshot: ReplicatedTranscriptSnapshotV1 | null = null
  /** (PERF) Caller-decided delivery flags the map-skip key above is scoped to. */
  private lastMappedOmittedBefore = false
  private lastMappedStale = false
  /**
   * (D1) A terminal/settled status event arrived and the authoritative tail has
   * not been re-pulled since. One-shot: consumed by the next
   * `shouldRefreshForLiveness` that answers true.
   *
   * ── Why the status lane is the rescue signal ──────────────────────────────
   * The replica lane and the status lane are SIBLING handlers on the same P2P
   * DataChannel (`p2p-manager.ts` `onSnapshot` / `onStatusEvent`). When the
   * replica lane wedges, the status lane keeps delivering — observed live: the
   * completion toast fires while the transcript stays frozen. So the surviving
   * lane can vouch for the dead one.
   *
   * That matters because the controller cannot otherwise tell a wedged replica
   * from a healthy one: `expireStaleReplicaLease` only arms on
   * `lastReplicaBusyAt`, which is stamped ONLY from an inbound replica snapshot
   * (see `applyTranscriptReplicaSnapshot`). A lane that dies takes the evidence
   * of its own death with it — the lease never arms, and the `replicaHealthy`
   * refusal is never released. This latch is the out-of-band evidence.
   */
  private terminalStatusRefreshPending = false
  /**
   * (D3) Wall-clock of the last COMPLETED authoritative re-pull, successful or
   * not. Backoff only — it is not evidence of anything about the lane.
   *
   * Needed because the quiet window now measures `lastAppliedAt` (rendered
   * content) rather than `lastInboundAt` (lane traffic). A re-pull that returns
   * nothing new does not advance `lastAppliedAt` — correctly, since the screen
   * did not change — so without a separate backoff stamp a genuinely dead lane
   * would satisfy the quiet threshold on every 5s tick and the watchdog would
   * degenerate into the fixed-interval poll it exists to avoid. The old code got
   * this for free by stamping `lastInboundAt`; that shortcut is unavailable now
   * precisely because the two meanings have been separated.
   */
  private lastLivenessAttemptAt = 0
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
    this.includeActivity = options.includeActivity === true
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
    // Activity-toggle flip: the subscription params must change with it (the
    // daemon composes read_chat args from them), so resubscribe like a
    // tailLimit change. `undefined` (a caller that does not know about the
    // toggle — e.g. warm descriptors) leaves the current value untouched.
    if (options.includeActivity !== undefined && options.includeActivity !== this.includeActivity) {
      this.includeActivity = options.includeActivity
      if (this.transportSubscription) {
        this.disconnect()
        this.connect()
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
    // (PERF) ★ The map-skip key asserts "re-delivering this snapshot would
    // change nothing on screen". Blanking the screen invalidates exactly that,
    // so the next delivery of the SAME revision must map and re-apply rather
    // than be skipped into a permanently empty pane.
    this.lastMappedRevisionSnapshot = null
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
    options: {
      omittedBefore: boolean
      stale?: boolean
      /**
       * (PERF) A mapping of THIS snapshot+options that the caller already
       * computed, to be reused instead of recomputed. Optional and purely an
       * optimization: omitting it produces an identical result. Only
       * `applyTranscriptReplicaSnapshotToControllers` passes it, and only
       * because every controller it fans out to derives the same
       * `subscriptionKey` from the same `(daemonId, sessionId)`.
       */
      mapped?: TranscriptChatTailUpdate
    },
  ): void {
    if (!isMappableTranscriptSnapshot(snapshot)) {
      this.reportTranscriptReplicaFallback('revision_invalid')
      return
    }

    // ── (PERF) Skip the O(N) mapping for a re-delivered identical revision ────
    // `mapTranscriptSnapshotToChatTailUpdate` allocates a new object per message
    // (`snapshot.messages.map`), and it ran BEFORE `handleUpdate` could discover
    // the update changes nothing. A frozen lane re-sends the same revision on
    // every heartbeat and a SNAP replays the ring, so this was the dominant
    // per-message cost on screens that were not changing at all.
    //
    // The gate is deliberately NARROW — the same `(revision, snapshot object)`
    // pair this controller already mapped and resolved to `noop`. Identity
    // (`===`) on the snapshot, not a deep compare: the assembler hands the SAME
    // frozen object to every controller for a repeat revision (see the codec's
    // re-decode short-circuit), so reference equality is exactly the "nothing
    // could have changed" proof, and a genuinely new revision is a new object
    // that never matches.
    //
    // ★ `omittedBefore`/`stale` are part of the key. They are the CALLER's
    // per-delivery decision, not a property of the snapshot, and they land in
    // the applied snapshot — so a delivery that flips either must NOT be
    // short-circuited even though the revision repeats.
    const mapSkippable = this.lastMappedRevisionSnapshot === snapshot
      && this.lastMappedOmittedBefore === options.omittedBefore
      && this.lastMappedStale === (options.stale === true)

    let outcome: ChatTailUpdateOutcome
    if (mapSkippable) {
      // ★ Reproduce the `noop` path's side effects EXACTLY. `handleUpdate`
      // stamps these before any apply/discard decision, deliberately: a stream
      // of correctly-discarded no-op updates still counts as lane liveness and
      // must not trip the watchdog. Dropping them here would turn a healthy
      // frozen-but-alive lane into a watchdog re-pull storm — which is why this
      // is a duplicated stamp rather than an early `return`.
      const updateTime = this.now()
      this.lastInboundAt = updateTime
      this.lastKnownStatus = snapshot.status
      if (shouldGuardTailShrinkForStatus(snapshot.status) || isBusyChatTailStatus(snapshot.status)) {
        this.lastActiveStatusAt = updateTime
      }
      outcome = 'noop'
    } else {
      // (PERF) `options.mapped` is the fan-out's shared mapping — see
      // `applyTranscriptReplicaSnapshotToControllers`. Absent (direct callers,
      // tests) this maps as before; the two are the same value by construction,
      // since every controller in one fan-out shares a `subscriptionKey`.
      outcome = this.handleUpdate(
        options.mapped
          ?? mapTranscriptSnapshotToChatTailUpdate(snapshot, {
            subscriptionKey: this.subscriptionKey,
            omittedBefore: options.omittedBefore,
            stale: options.stale === true,
          }),
      )
      // Arm the skip only for an outcome that provably left the screen alone.
      // `applied` changed the snapshot, and `deferred`/`rejected` mean the next
      // delivery of these same bytes may legitimately decide differently (the
      // busy window lapses, a force-apply becomes eligible) — so neither may be
      // short-circuited into a silent `noop`.
      if (outcome === 'noop') {
        this.lastMappedRevisionSnapshot = snapshot
        this.lastMappedOmittedBefore = options.omittedBefore
        this.lastMappedStale = options.stale === true
      } else {
        this.lastMappedRevisionSnapshot = null
      }
    }

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
   * ★ This is why the watchdog is armed on `enabled`, NOT on `refreshEnabled`:
   * a backstop for "no edge will fire" cannot itself be gated on the edge it
   * exists to compensate for. Gated, it switched off for exactly the pane that
   * needed it (hidden, missing pushes) and only came back once the user had
   * already produced the edge that would have healed the pane anyway — it could
   * never fire on a path where it was the thing doing the rescuing.
   * `visible` scales the quiet window instead of silencing the timer.
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
   *   3b. (D1) …UNLESS a terminal status event arrived on the sibling status
   *      lane. That is the one sanctioned bypass of check 3 — see
   *      `noteTerminalStatusEvent`.
   *   4. Quiet period not yet elapsed, measured against `lastAppliedAt` and
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
    // (REPLICA-PROVENANCE-SCALAR-LOSS — observability) The lease measured LANE
    // advance only, which is why this defect ran silent: snapshots kept arriving
    // (~29.5/min) so the lane looked healthy, while every one was deferred and
    // the SCREEN never moved. Measure the screen too — a busy session whose
    // rendered content is frozen past the same window is wedged whatever the
    // cause, and routes through the identical fallback path. A class detector,
    // deliberately not specific to the bug fixed above.
    const laneStalled = (nowMs - this.lastReplicaAdvanceAt) >= CHAT_TAIL_REPLICA_LEASE_BUSY_MS
    const screenStalled = this.lastAppliedAt > 0
      && (nowMs - this.lastAppliedAt) >= CHAT_TAIL_REPLICA_LEASE_BUSY_MS
    if (!laneStalled && !screenStalled) return
    // Route through the existing fallback path rather than clearing the flag
    // inline: it re-arms legacy, records the diagnostic and surfaces the
    // degradation notice, all of which apply verbatim to a stalled lane.
    this.reportTranscriptReplicaFallback(laneStalled ? 'replica_lease_expired' : 'replica_screen_stalled')
  }

  /**
   * (D1) Record that the STATUS lane reported this session settled.
   *
   * Non-terminal events are ignored outright, so the bypass below can never be
   * armed mid-generation — see `isTerminalChatTailStatusEvent`.
   *
   * This deliberately does NOT touch `lastInboundAt`, `lastAppliedAt` or
   * `lastKnownStatus`: those describe the CHAT TAIL lane, and letting a status
   * event write them would make a healthy status lane mask a dead transcript
   * lane — the same self-referential trap that leaves the lease unarmed.
   */
  noteTerminalStatusEvent(event: unknown): void {
    if (!isTerminalChatTailStatusEvent(event)) return
    this.terminalStatusRefreshPending = true
  }

  shouldRefreshForLiveness(options: { visible?: boolean } = {}): boolean {
    // (LEASE) Evaluated on the watchdog's existing 5s tick — the lease needs no
    // timer of its own, and this is the same cadence that already decides pane
    // staleness. Runs FIRST so a lease that expires on this tick also releases
    // the `replicaHealthy` refusal below, letting the authoritative re-pull that
    // rescues the frozen pane happen on the very same tick instead of the next.
    this.expireStaleReplicaLease()
    if (this.lastInboundAt === 0) return false
    if (this.authoritativeRefreshPromise) return false

    // (D1) ★ The one sanctioned bypass of the `replicaHealthy` refusal below.
    //
    // Placed AFTER the single-flight guard and BEFORE the health veto, which is
    // the entire point: a terminal status event is out-of-band proof that this
    // session settled, delivered by a lane that is still alive when the replica
    // lane is not. Without it, a wedged replica is indistinguishable from a
    // healthy one (its silence removes the very evidence `expireStaleReplicaLease`
    // needs) and the pane stays frozen forever.
    //
    // ★ Why bypassing is safe HERE and nowhere else: the veto guards against a
    // legacy `read_chat` landing behind a newer replica revision. At a terminal
    // event the replica is BY DEFINITION not producing — the turn is over or the
    // agent is parked on a human decision — so that race window is closed. This
    // is a bypass for one instant, not a standing exemption: the latch is
    // consumed here and the veto resumes on the next tick.
    //
    // ★ It also deliberately does not consult the quiet window. The quiet
    // thresholds exist to guess whether a lane has stopped; a terminal event is
    // not a guess, and waiting 20-120s to act on it would leave the pane frozen
    // for exactly the interval the user is staring at it. `refreshAuthoritativeTail`
    // still applies its own 750ms debounce and single-flight, which bounds the
    // cost of a burst of terminal events.
    if (this.terminalStatusRefreshPending) {
      this.terminalStatusRefreshPending = false
      return true
    }

    // ★ Replica is authoritative and self-pushing — a legacy read_chat here
    // could regress the pane to older content (last-writer-wins).
    if (this.replicaHealthy) return false
    // (D3) Quiet is measured against `lastAppliedAt` — when the RENDERED CONTENT
    // last changed — not `lastInboundAt`, which stamps on every inbound update
    // before the apply decision.
    //
    // Both fields are correct about different things and the watchdog needs the
    // other one. `lastInboundAt` answers "is the lane alive", and for a lane
    // that is merely idle it is exactly right. But this watchdog exists to
    // detect a FROZEN SCREEN, and a lane can be provably alive while the screen
    // is stuck: a producer re-emitting one frozen revision, or shipping tails
    // the shrink-defense correctly rejects, keeps resetting `lastInboundAt` to
    // now and holds the quiet clock at zero permanently. The watchdog then never
    // fires on the one failure mode where nothing else will rescue the pane.
    //
    // `lastInboundAt` is left untouched and still gates the "nothing has ever
    // arrived" check above, where its meaning is the one required.
    //
    // `lastLivenessAttemptAt` is folded in as pure BACKOFF, not as evidence:
    // it stops a dead lane from re-qualifying on every tick once the quiet
    // threshold is crossed.
    const quietSince = Math.max(this.lastAppliedAt, this.lastLivenessAttemptAt)
    const quietMs = this.now() - quietSince
    const statusThreshold = isBusyChatTailStatus(this.lastKnownStatus)
      ? CHAT_TAIL_LIVENESS_BUSY_QUIET_MS
      : CHAT_TAIL_LIVENESS_IDLE_QUIET_MS
    // (LIVENESS) A hidden pane still needs the backstop — that is the whole
    // point of arming on `enabled` rather than `refreshEnabled` — but it does
    // not need it as URGENTLY, and there are far more hidden controllers than
    // visible ones. Raise the floor instead of switching the watchdog off.
    // Defaults to the hidden (more conservative) window when the caller does not
    // say, so a new call site cannot silently opt into the tighter one.
    const threshold = options.visible === true
      ? statusThreshold
      : Math.max(statusThreshold, CHAT_TAIL_LIVENESS_HIDDEN_QUIET_FLOOR_MS)
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
        this.lastLivenessAttemptAt = this.now()
      } catch {
        // Best-effort self-heal — a failed re-pull just leaves the existing
        // snapshot untouched; the next focus/reconnect retries.
        // (LIVENESS) Reset the quiet clock on failure too. An offline or erroring
        // daemon must back off to one attempt per quiet period, not one per tick.
        this.lastInboundAt = this.now()
        this.lastLivenessAttemptAt = this.now()
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
        // Omitted when off so the request an old browser sends and the request
        // a toggle-off browser sends are byte-identical.
        ...(this.includeActivity ? { includeActivity: true } : {}),
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
    // (PERF) A recycled controller renders from a blank snapshot, so no prior
    // mapping describes its screen — see `clearLiveSnapshot` for the same rule.
    this.lastMappedRevisionSnapshot = null
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
    const incomingMessageSource = (update as SessionChatTailUpdate & { messageSource?: Record<string, unknown> | string }).messageSource

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
      // The read-source of the INCOMING update, not the snapshot's — the gate is
      // judging this update's authority, and the snapshot may still be labelled
      // 'legacy' from a prior lane.
      && decideChatTailUpdate(this.snapshot, this.fallbackRecentCount, nextMessages, update.status, incomingMessageSource, withinRecentActiveWindow, readUpdateTranscriptReadSource(update)) !== 'apply'
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
      // Read-only consumption; daemon is source of truth. Normalized so the
      // PUBLIC snapshot type stays one shape for consumers.
      messageSource: normalizeMessageSource(incomingMessageSource),
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
  // (PERF) Map ONCE for the whole fan-out. A session routinely has two warm
  // controllers alive (the pane's, keyed by historySessionId, and the mobile
  // inbox's, keyed by sessionId) and each was running the same O(messages)
  // mapping over the same snapshot.
  //
  // ★ Sharing is sound because the mapped update depends only on
  // `(snapshot, subscriptionKey, omittedBefore, stale)`, and every controller
  // here derives `subscriptionKey` as `daemon:${daemonId}:session:${sessionId}`
  // from the SAME pair this function was called with — the registry key differs
  // between them only in `historySessionId`, which the mapping does not read.
  //
  // Built lazily so a fan-out that matches no warm controller (the common case:
  // a snapshot for a session nobody is looking at) does no mapping work at all.
  let mapped: TranscriptChatTailUpdate | undefined
  let applied = 0
  for (const [key, controller] of controllerRegistry.entries()) {
    if (!key.startsWith(prefix)) continue
    if (!mapped && isMappableTranscriptSnapshot(snapshot)) {
      mapped = mapTranscriptSnapshotToChatTailUpdate(snapshot, {
        subscriptionKey: `daemon:${daemonId}:session:${sessionId}`,
        omittedBefore: options.omittedBefore,
        stale: options.stale === true,
      })
    }
    controller.applyTranscriptReplicaSnapshot(snapshot, { ...options, mapped })
    applied += 1
  }
  return applied
}

/**
 * (D1) Route a daemon status event to every warm controller for this session.
 *
 * Prefix-matched for the same reason `applyTranscriptReplicaSnapshotToControllers`
 * is: one session can have a pane controller and a warm inbox controller alive
 * at once, and a frozen transcript is equally wrong in both.
 *
 * ── Why the status lane is wired to the transcript watchdog at all ─────────
 * `onStatusEvent` and `onSnapshot` are sibling handlers on the SAME P2P
 * DataChannel (`p2p-manager.ts`). Observed live: the completion toast fires off
 * the first while the transcript rendered by the second stays frozen. That makes
 * the status lane the only in-band signal that survives a wedged replica — and
 * `expireStaleReplicaLease` cannot substitute for it, because the stamp it arms
 * on comes from the replica lane itself.
 *
 * Non-terminal events are dropped inside `noteTerminalStatusEvent`; this
 * function is intentionally a dumb fan-out so the terminal-only rule has exactly
 * one definition. Returns how many controllers were notified; 0 is normal (an
 * event for a session nobody is reading).
 */
export function noteTerminalStatusEventForControllers(
  daemonId: string,
  sessionId: string,
  event: unknown,
): number {
  if (!daemonId || !sessionId) return 0
  if (!isTerminalChatTailStatusEvent(event)) return 0
  const prefix = `${daemonId}::${sessionId}::`
  let notified = 0
  for (const [key, controller] of controllerRegistry.entries()) {
    if (!key.startsWith(prefix)) continue
    controller.noteTerminalStatusEvent(event)
    notified += 1
  }
  return notified
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

export function buildControllerHandle(
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

/**
 * (F4) Arming decision for the liveness watchdog, split out as a pure function
 * so the GATE itself is testable — the defect this closes was never in
 * `shouldRefreshForLiveness`, it was in which effect the timer lived in, and a
 * controller-level test cannot see that. Mirrors the pattern of
 * `buildChatPaneTailControllerOptions` in ChatPane.tsx.
 *
 * ★ `refreshEnabled` is deliberately absent from the arming condition and
 * present only as the quiet-window selector. Re-adding it to `armed` reproduces
 * the original bug: the backstop for "this pane gets no edges" switching itself
 * off for exactly the panes that get no edges.
 */
export function buildChatTailLivenessWatchdogPlan(input: {
  hasController: boolean
  enabled: boolean
  daemonId?: string
  sessionId?: string
  refreshEnabled: boolean
}): { armed: boolean; visible: boolean } {
  return {
    armed: !!(input.hasController && input.enabled && input.daemonId && input.sessionId),
    visible: input.refreshEnabled,
  }
}

// Barrel-preserving re-export: the React hook layer moved to
// `session-chat-tail-hooks.ts` (pure move, no behavior change) so this module
// stays a transport/state controller with no React dependency. Existing
// importers — including `src/index.ts` — continue to resolve the hooks here.
export {
  useSessionChatTailController,
  useWarmSessionChatTailControllers,
  useWarmSessionChatTailSnapshotVersion,
} from './session-chat-tail-hooks'
