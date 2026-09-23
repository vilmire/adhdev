/**
 * protocol/dashboard-server — the dashboard ↔ UserSessionDO WebSocket link,
 * plus the share-viewer ↔ SharedSessionDO link the same dashboard bundle speaks.
 *
 * Wiring-unification Phase A2 (docs/design/2026-09-23-wiring-unification.md §3 A2).
 *
 * Before this file web-cloud `ws.ts` declared its own `IncomingWSMessage`
 * union and `WSEventType`, the server built every outbound frame as an object
 * literal, and the two disagreed: the server's `connected` frame was missing
 * from the dashboard's type, while the dashboard typed `plan_limit_error`,
 * `plan_limit_warning`, `daemon_screenshot` and `agent_event` that no server
 * path has emitted since the dashboard WS command relay was removed. Those four
 * are gone; `connected` is in.
 *
 * Content boundary: this link is server WS. It carries routing metadata,
 * signaling and the approved approval-modal text only (`modalMessage` /
 * `modalButtons`). Chat content rides the P2P link (./dashboard-daemon-p2p.ts).
 */

import {
    type Envelope,
    type AssertSameMembers,
    isRecord,
    makeTypeGuard,
    readEnvelopeFields,
} from './envelope'
import {
    DAEMON_STATUS_EVENT_NAMES,
    type DaemonStatusEventName,
    type P2PIceWirePayload,
    type P2POfferWirePayload,
    type P2PStatusWireSummary,
    type SeqscribeStatusWireSummary,
    type ReleaseChannelWire,
    type VersionUpdatePolicyWire,
    type VersionUpdateReasonWire,
} from './daemon-server'

// ─── Status events as delivered to a dashboard ─────────────────────────────

/** Server-originated events the dashboard receives in addition to the daemon set. */
export const SERVER_STATUS_EVENT_NAMES = [
    'daemon:disconnect',
    'team:session_viewed',
    'team:view_request',
    'team:view_request_approved',
    'team:view_request_rejected',
] as const

/** Mirror of daemon-core `DashboardStatusEventName`; pinned equal by the server at compile time. */
export const DASHBOARD_STATUS_EVENT_NAMES = [...DAEMON_STATUS_EVENT_NAMES, ...SERVER_STATUS_EVENT_NAMES] as const
export type DashboardStatusEventName = DaemonStatusEventName | typeof SERVER_STATUS_EVENT_NAMES[number]
export const isDashboardStatusEventName = makeTypeGuard(DASHBOARD_STATUS_EVENT_NAMES)

const _dashboardStatusEventNamesCoverUnion: AssertSameMembers<typeof DASHBOARD_STATUS_EVENT_NAMES, DashboardStatusEventName> = true
void _dashboardStatusEventNamesCoverUnion

/**
 * Sanitized status event as the server relays it (UserSession
 * `buildDashboardStatusEvent`). Mirror of daemon-core
 * `DashboardStatusEventPayload` minus the P2P-only structured prompt fields
 * (`interactivePrompt`/`promptId`/`multiSelect`), which the WS relay never
 * carries — they are agent-authored content.
 */
export type DashboardStatusEventWirePayload = {
    event: DashboardStatusEventName
    timestamp: number
    daemonId?: string
    providerType?: string
    targetSessionId?: string
    duration?: number
    elapsedSec?: number
    modalMessage?: string
    modalButtons?: string[]
    requestId?: string
    requesterName?: string
    targetName?: string
    orgId?: string
    permission?: string
    shareUrl?: string
    shareToken?: string
    viewerName?: string
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

/**
 * Cold-start machine card. Mirror of daemon-core `DashboardBootstrapDaemonEntry`
 * (which extends `Partial<CloudDaemonSummaryEntry>`), field for field, so the
 * server's entry assigns in and the dashboard's daemon-core-typed consumer
 * assigns out without a cast.
 */
export type BootstrapDaemonWireEntry = {
    id: string
    type?: string
    machineId?: string
    platform?: string
    hostname?: string
    nickname?: string
    version?: string
    p2p?: P2PStatusWireSummary
    seqscribe?: SeqscribeStatusWireSummary
    cdpConnected?: boolean
    serverVersion?: string
    releaseChannel?: ReleaseChannelWire
    updateChannel?: ReleaseChannelWire
    updatePolicy?: VersionUpdatePolicyWire
    updateCommand?: string
    versionMismatch?: boolean
    versionUpdateRequired?: boolean
    versionUpdateReason?: VersionUpdateReasonWire
    timestamp?: number
}

export const SYSTEM_ANNOUNCEMENT_TYPES = ['info', 'warning', 'critical'] as const
export type SystemAnnouncementTypeWire = typeof SYSTEM_ANNOUNCEMENT_TYPES[number]

/** Admin-authored banner; `null` clears it. Mirror of server `ActiveSystemAnnouncement` / web-cloud `SystemAnnouncement`. */
export type SystemAnnouncementWire = {
    id: string
    message: string
    type: SystemAnnouncementTypeWire
    createdAt: string | null
    expiresAt: string | null
}

export type DashboardBootstrapWirePayload = {
    daemons: BootstrapDaemonWireEntry[]
    announcement?: SystemAnnouncementWire | null
}

export type DashboardConnectedWirePayload = {
    message?: string
    peerId: string
    plan: string
    dashboardCount: number
}

/** Daemon auth rejection relayed to the owner's dashboards — enum reason and counters only (no server-authored sentence). */
export type DashboardAuthErrorWirePayload = {
    reason: string
    limit?: number
    current?: number
}

export type SystemAnnouncementWirePayload = {
    announcement: SystemAnnouncementWire | null
}

// ─── Signaling payloads (server → dashboard, from the daemon offerer) ───────

export type DashboardP2POfferWirePayload = {
    daemonId: string
    peerId?: string
    sdp: string
    type: string
}

export type DashboardP2PIceWirePayload = {
    daemonId: string
    peerId?: string
    candidate: string
    mid?: string
    sdpMid?: string | null
    sdpMLineIndex?: number | null
}

// ─── UserSession → Dashboard ───────────────────────────────────────────────

export const USER_SESSION_TO_DASHBOARD_TYPES = [
    'connected',
    'initial_state',
    'daemon_status',
    'status_event',
    'system_announcement',
    'auth_error',
    'heartbeat',
    'p2p_offer',
    'p2p_ice',
] as const
export type UserSessionToDashboardType = typeof USER_SESSION_TO_DASHBOARD_TYPES[number]
export const isUserSessionToDashboardType = makeTypeGuard(USER_SESSION_TO_DASHBOARD_TYPES)

export type DashboardConnectedMsg = Envelope<'connected', DashboardConnectedWirePayload>
export type DashboardInitialStateMsg = Envelope<'initial_state', DashboardBootstrapWirePayload>
export type DashboardDaemonStatusMsg = Envelope<'daemon_status', DashboardBootstrapWirePayload>
export type DashboardStatusEventMsg = Envelope<'status_event', DashboardStatusEventWirePayload>
export type DashboardSystemAnnouncementMsg = Envelope<'system_announcement', SystemAnnouncementWirePayload>
export type DashboardAuthErrorMsg = Envelope<'auth_error', DashboardAuthErrorWirePayload>
/**
 * Reply to the dashboard's heartbeat. Carries the cached announcement so a
 * stale banner self-corrects; the field is optional because the reply is first
 * of all a liveness signal and must not be dropped by an older server's
 * payload-less spelling.
 */
export type DashboardHeartbeatReplyMsg = Envelope<'heartbeat', Partial<SystemAnnouncementWirePayload>>
export type DashboardP2POfferMsg = Envelope<'p2p_offer', DashboardP2POfferWirePayload>
export type DashboardP2PIceMsg = Envelope<'p2p_ice', DashboardP2PIceWirePayload>

export type UserSessionToDashboardMsg =
    | DashboardConnectedMsg
    | DashboardInitialStateMsg
    | DashboardDaemonStatusMsg
    | DashboardStatusEventMsg
    | DashboardSystemAnnouncementMsg
    | DashboardAuthErrorMsg
    | DashboardHeartbeatReplyMsg
    | DashboardP2POfferMsg
    | DashboardP2PIceMsg

const _userSessionToDashboardNamesCoverUnion: AssertSameMembers<typeof USER_SESSION_TO_DASHBOARD_TYPES, UserSessionToDashboardMsg['type']> = true
void _userSessionToDashboardNamesCoverUnion

export type UserSessionToDashboardPayloadOf<T extends UserSessionToDashboardType> = Extract<UserSessionToDashboardMsg, { type: T }>['payload']

/** Parse boundary for the dashboard. A heartbeat reply is accepted without a payload (liveness first). */
export function decodeUserSessionToDashboard(raw: unknown): UserSessionToDashboardMsg | null {
    if (!isRecord(raw) || !isUserSessionToDashboardType(raw.type)) return null
    if (raw.type === 'heartbeat') {
        return { type: 'heartbeat', payload: isRecord(raw.payload) ? raw.payload : {}, ...readEnvelopeFields(raw) }
    }
    if (!isRecord(raw.payload)) return null
    return { type: raw.type, payload: raw.payload, ...readEnvelopeFields(raw) } as UserSessionToDashboardMsg
}

// ─── Dashboard → UserSession ───────────────────────────────────────────────

export const DASHBOARD_TO_USER_SESSION_TYPES = ['heartbeat', 'refresh', 'p2p_ready', 'p2p_answer', 'p2p_ice'] as const
export type DashboardToUserSessionType = typeof DASHBOARD_TO_USER_SESSION_TYPES[number]
export const isDashboardToUserSessionType = makeTypeGuard(DASHBOARD_TO_USER_SESSION_TYPES)

/** Signals a dashboard (answerer) sends toward a daemon; `daemonId` routes, `peerId` identifies the tab. */
export const DASHBOARD_P2P_SIGNAL_TYPES = ['p2p_ready', 'p2p_answer', 'p2p_ice'] as const
export type DashboardP2PSignalType = typeof DASHBOARD_P2P_SIGNAL_TYPES[number]
export const isDashboardP2PSignalType = makeTypeGuard(DASHBOARD_P2P_SIGNAL_TYPES)

export type DashboardP2PReadyWirePayload = { daemonId: string; peerId: string }
export type DashboardP2PAnswerWirePayload = { daemonId: string; peerId: string; sdp: string; type: string }
export type DashboardP2PLocalIceWirePayload = {
    daemonId: string
    peerId: string
    candidate: string
    sdpMid: string | null
    sdpMLineIndex: number | null
}

export type DashboardHeartbeatMsg = { type: 'heartbeat'; timestamp?: number }
export type DashboardRefreshMsg = { type: 'refresh' }
export type DashboardP2PReadyMsg = Envelope<'p2p_ready', DashboardP2PReadyWirePayload>
export type DashboardP2PAnswerMsg = Envelope<'p2p_answer', DashboardP2PAnswerWirePayload>
export type DashboardP2PLocalIceMsg = Envelope<'p2p_ice', DashboardP2PLocalIceWirePayload>

export type DashboardToUserSessionMsg =
    | DashboardHeartbeatMsg
    | DashboardRefreshMsg
    | DashboardP2PReadyMsg
    | DashboardP2PAnswerMsg
    | DashboardP2PLocalIceMsg

const _dashboardToUserSessionNamesCoverUnion: AssertSameMembers<typeof DASHBOARD_TO_USER_SESSION_TYPES, DashboardToUserSessionMsg['type']> = true
void _dashboardToUserSessionNamesCoverUnion

export type DashboardToUserSessionPayloadOf<T extends DashboardP2PSignalType> = Extract<DashboardToUserSessionMsg, { type: T }>['payload']

/** Parse boundary for UserSessionDO. Signals need a `daemonId` to route; without one there is nothing to do. */
export function decodeDashboardToUserSession(raw: unknown): DashboardToUserSessionMsg | null {
    if (!isRecord(raw) || !isDashboardToUserSessionType(raw.type)) return null
    if (raw.type === 'heartbeat') return { type: 'heartbeat', ...readEnvelopeFields(raw) }
    if (raw.type === 'refresh') return { type: 'refresh' }
    if (!isRecord(raw.payload) || typeof raw.payload.daemonId !== 'string') return null
    return { type: raw.type, payload: raw.payload, ...readEnvelopeFields(raw) } as DashboardToUserSessionMsg
}

// ─── SharedSession ↔ share viewer ──────────────────────────────────────────

export const SHARED_SESSION_TO_VIEWER_TYPES = [
    'share:connected',
    'share:revoked',
    'share:expired',
    'share:error',
    'share:viewer_count',
    'p2p_offer',
    'p2p_ice',
] as const
export type SharedSessionToViewerType = typeof SHARED_SESSION_TO_VIEWER_TYPES[number]
export const isSharedSessionToViewerType = makeTypeGuard(SHARED_SESSION_TO_VIEWER_TYPES)

/** Frames on this link are FLAT (no `payload`), except the relayed signals. Kept as the viewer page reads them. */
export type ShareConnectedMsg = {
    type: 'share:connected'
    viewerId: string
    viewerName: string
    permission: string
    mode: string
    providerType: string
    targetSessionId?: string
    ownerName: string
    daemonId: string
    iceServers: unknown[]
    requiresAuth: boolean
}
export type ShareRevokedMsg = { type: 'share:revoked' }
export type ShareExpiredMsg = { type: 'share:expired' }
export type ShareErrorMsg = { type: 'share:error'; error: string }
export type ShareViewerCountMsg = { type: 'share:viewer_count'; count: number; maxViewers: number }
/**
 * Daemon signal relayed to the addressed viewer, payload as the daemon sent it;
 * `from` is the daemon DO id, which the viewer page folds in as `daemonId`.
 */
export type ShareRelayedP2POfferMsg = { type: 'p2p_offer'; payload: P2POfferWirePayload; from: string }
export type ShareRelayedP2PIceMsg = { type: 'p2p_ice'; payload: P2PIceWirePayload; from: string }

export type SharedSessionToViewerMsg =
    | ShareConnectedMsg
    | ShareRevokedMsg
    | ShareExpiredMsg
    | ShareErrorMsg
    | ShareViewerCountMsg
    | ShareRelayedP2POfferMsg
    | ShareRelayedP2PIceMsg

const _sharedSessionToViewerNamesCoverUnion: AssertSameMembers<typeof SHARED_SESSION_TO_VIEWER_TYPES, SharedSessionToViewerMsg['type']> = true
void _sharedSessionToViewerNamesCoverUnion

export const VIEWER_TO_SHARED_SESSION_TYPES = ['p2p_ready', 'p2p_offer', 'p2p_answer', 'p2p_ice'] as const
export type ViewerToSharedSessionType = typeof VIEWER_TO_SHARED_SESSION_TYPES[number]
export const isViewerToSharedSessionType = makeTypeGuard(VIEWER_TO_SHARED_SESSION_TYPES)

/** The viewer's signal as sent; the DO stamps `daemonId`/`peerId`/`sharePermission` before relaying. */
export type ViewerToSharedSessionMsg = Envelope<ViewerToSharedSessionType, Record<string, unknown>>

const _viewerToSharedSessionNamesCoverUnion: AssertSameMembers<typeof VIEWER_TO_SHARED_SESSION_TYPES, ViewerToSharedSessionMsg['type']> = true
void _viewerToSharedSessionNamesCoverUnion

/** Parse boundary for SharedSessionDO: signaling frames only. */
export function decodeViewerToSharedSession(raw: unknown): ViewerToSharedSessionMsg | null {
    if (!isRecord(raw) || !isViewerToSharedSessionType(raw.type)) return null
    const payload = isRecord(raw.payload) ? raw.payload : {}
    return { type: raw.type, payload, ...readEnvelopeFields(raw) }
}
