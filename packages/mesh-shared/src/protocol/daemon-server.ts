/**
 * protocol/daemon-server — the daemon ↔ Workers-server WebSocket link.
 *
 * Wiring-unification Phase A2 (docs/design/2026-09-23-wiring-unification.md §3 A2).
 *
 * Before this file the link shared NAME lists only (`ws-protocol.ts`), payloads
 * were `any` on both ends, `daemon_mesh_command` was sent by a raw `ws.send`
 * outside the typed funnel, and the P2P signaling names in the shared list
 * (`offer|answer|ice`) had drifted from the wire (`p2p_offer|p2p_answer|p2p_ice`)
 * without anything noticing, because nothing imported them.
 *
 * Two directions:
 *   - `DaemonToServerMsg`  — every frame the daemon writes to the server WS.
 *   - `ServerToDaemonMsg`  — every frame the server writes to a daemon WS. This
 *     is a CLOSED control set plus one OPEN namespace: the public REST API
 *     (`POST /api/v1/daemons/:id/command`, `daemonCommandSchema` = any string)
 *     relays a caller-chosen command name as the frame `type`, so that member is
 *     typed with a branded string rather than a literal list. The brand is what
 *     keeps `msg.type === 'auth_ok'` narrowing to the control member instead of
 *     collapsing into "some string".
 *
 * Payloads are structural mirrors of the daemon-core types the two ends assign
 * into them (see ./envelope.ts for why mesh-shared cannot import daemon-core).
 */

import type { AuthOkPlanLimits } from '../ws-protocol'
import type { SessionStatus } from '../session-status'
import {
    type CommandPayload,
    type Envelope,
    type MessageId,
    type AssertSameMembers,
    isRecord,
    isNonEmptyString,
    makeTypeGuard,
    readEnvelopeFields,
} from './envelope'

// ─── Status events (mirror of daemon-core `DaemonStatusEventName`) ─────────

/**
 * Daemon-originated status events. The daemon relays these to the server
 * (push notifications, webhooks) AND over P2P (dashboard). Mirror of
 * daemon-core `DaemonStatusEventName`; the server pins the two equal at compile
 * time (UserSession.ts), so adding a member here without adding it there — or
 * vice versa — fails `tsc`.
 */
export const DAEMON_STATUS_EVENT_NAMES = [
    'agent:generating_started',
    'agent:waiting_approval',
    'agent:waiting_choice',
    'agent:generating_completed',
    'agent:stopped',
    'monitor:no_progress',
    /** Legacy alias for `monitor:no_progress`, still emitted by older daemons. */
    'monitor:long_generating',
] as const
export type DaemonStatusEventName = typeof DAEMON_STATUS_EVENT_NAMES[number]
export const isDaemonStatusEventName = makeTypeGuard(DAEMON_STATUS_EVENT_NAMES)

/**
 * Server-bound status event. Content boundary: identifiers, enums, counters
 * and booleans only — plus the approved approval-modal exception
 * (`modalMessage`/`modalButtons`, CLAUDE.md "Push notification exception").
 * Mirror of daemon-core `DaemonStatusEventPayload`.
 */
export type DaemonStatusEventWirePayload = {
    event: DaemonStatusEventName
    timestamp: number
    targetSessionId?: string
    providerType?: string
    providerSessionId?: string
    workspaceName?: string
    duration?: number
    elapsedSec?: number
    modalMessage?: string
    modalButtons?: string[]
    surfaceHidden?: boolean
    muted?: boolean
}

// ─── Status report (mirror of daemon-core `CloudStatusReportPayload`) ──────

/** Routing-only session entry the daemon reports over the server WS. Mirror of daemon-core `RoutingSessionEntry`. */
export type RoutingSessionWireEntry = {
    id: string
    parentId: string | null
    providerType: string
    providerName: string
    kind: string
    transport: string
    status: SessionStatus
    workspace: string | null
    cdpConnected?: boolean
    surfaceHidden?: boolean
    muted?: boolean
}

/** Counters and enums only — never a peer id or address. Mirror of daemon-core `P2PStatusSummary`. */
export type P2PStatusWireSummary = {
    available: boolean
    state: string
    peers: number
    screenshotActive?: boolean
    direct?: number
    relay?: number
    unknownTransport?: number
    directTotal?: number
    relayTotal?: number
}

/**
 * seqscribe replication health — pre-bucketed counters and booleans only,
 * never a topic name or peer id. Mirror of daemon-core `SeqscribeStatusSummary`
 * (which should derive from this once shared-types is on the protocol).
 */
export type SeqscribeStatusWireSummary = {
    topics: number
    peers: number
    peersReady: number
    pendingBucket: number
    consumerLagBucket: number
    queueBucket: number
    fgenAgeBucket: number
    quarantined: boolean
    authority: boolean
    dualWrite?: boolean
    dualWriteFailedBucket?: number
    dualWriteDroppedBucket?: number
    dualWriteBackfilledBucket?: number
    parityMismatchBucket?: number
    parityRan?: boolean
    parityMissingInShadowBucket?: number
    parityExtraInShadowBucket?: number
    parityFieldMismatchBucket?: number
    transcriptPublish?: boolean
    transcriptPublishedBucket?: number
    transcriptPublishFailedBucket?: number
    transcriptDedupedBucket?: number
    transcriptOversizedBucket?: number
    transcriptDroppedBucket?: number
    transcriptParityRan?: boolean
    transcriptParityMismatchBucket?: number
}

export type CloudStatusReportWirePayload = {
    sessions: RoutingSessionWireEntry[]
    p2p?: P2PStatusWireSummary
    seqscribe?: SeqscribeStatusWireSummary
    timestamp: number
}

// ─── Release / update vocabulary (mirror of daemon-core shared-types) ──────

export const RELEASE_CHANNELS = ['stable', 'preview'] as const
export type ReleaseChannelWire = typeof RELEASE_CHANNELS[number]
export const NPM_UPDATE_TAGS = ['latest', 'next'] as const
export type NpmUpdateTagWire = typeof NPM_UPDATE_TAGS[number]
export const VERSION_UPDATE_REASONS = ['force_update_below', 'major_minor_mismatch', 'patch_mismatch', 'daemon_ahead'] as const
export type VersionUpdateReasonWire = typeof VERSION_UPDATE_REASONS[number]

/** Mirror of daemon-core `VersionUpdatePolicy`. */
export type VersionUpdatePolicyWire = {
    channel: ReleaseChannelWire
    npmTag: NpmUpdateTagWire
    targetVersion: string
    minVersion?: string
    updateCommand: string
}

export type StatusHeartbeatWirePayload = {
    timestamp?: number
    p2pPeers?: number
}

// ─── Auth ──────────────────────────────────────────────────────────────────

/** What the daemon says about itself at auth time (`ServerConnectionOptions.cliInfo`). */
export type DaemonAuthIdentity = {
    type: string
    version: string
    platform: string
    hostname?: string
    machineId?: string
    /** Canonical mesh identity `daemon_<machineId>`; the server keys its DO and status by it. */
    instanceId: string
}

export type DaemonAuthWirePayload = {
    token: string
    daemon: DaemonAuthIdentity
}

export type IceServerWireEntry = {
    urls: string | string[]
    username?: string
    credential?: string
}

export type AuthOkWirePayload = {
    message?: string
    plan: string
    iceServers: IceServerWireEntry[]
    turnenabled: boolean
    serverVersion: string
    releaseChannel?: ReleaseChannelWire
    updatePolicy?: VersionUpdatePolicyWire
    machineNickname: string | null
    seqscribeFleetSecret?: string
    seqscribeFleetSecretVersion?: number
    /** Beacon board seed for cold start (advisory, may be absent). */
    beaconSeed?: { reports: unknown[]; truncated: number }
    limits: AuthOkPlanLimits
}

export type AuthErrorWirePayload = {
    reason: string
    message: string
    limit?: number
    current?: number
}

/** `machine_evicted` / `force_disconnect` / `token_revoked` — a reason token plus human text, then the socket closes. */
export type DisconnectNoticeWirePayload = {
    reason: string
    message: string
}

export type VersionMismatchWirePayload = {
    current: string
    latest: string
    required: false
    reason: VersionUpdateReasonWire
    channel: ReleaseChannelWire
    npmTag: NpmUpdateTagWire
    updatePolicy: VersionUpdatePolicyWire
    updateCommand: string
}

export type ForceUpdateRequiredWirePayload = {
    current: string
    latest: string
    minVersion: string
    required: true
    reason: VersionUpdateReasonWire
    channel: ReleaseChannelWire
    npmTag: NpmUpdateTagWire
    updatePolicy: VersionUpdatePolicyWire
    updateCommand: string
    forceUpdateBelow?: string
    message: string
}

// ─── Commands and results ──────────────────────────────────────────────────

export type CommandResultWirePayload = {
    requestId: MessageId
    success: boolean
    source?: string
} & Record<string, unknown>

export type DaemonErrorWirePayload = {
    message?: string
    detail?: unknown
}

// ─── Beacon (seqscribe vector board, design §7.1) ──────────────────────────

export type BeaconVectorsWirePayload =
    | { op: 'put'; report: unknown }
    | { op: 'get'; topics: string[]; requestId: string }

// ─── P2P signaling (dashboard ↔ daemon through the server) ─────────────────

export const P2P_SIGNAL_TYPES = ['p2p_ready', 'p2p_offer', 'p2p_answer', 'p2p_ice'] as const
export type P2PSignalType = typeof P2P_SIGNAL_TYPES[number]
export const isP2PSignalType = makeTypeGuard(P2P_SIGNAL_TYPES)

/** Signals the daemon originates (it is the WebRTC offerer). */
export const DAEMON_P2P_SIGNAL_TYPES = ['p2p_offer', 'p2p_ice'] as const
export type DaemonP2PSignalType = typeof DAEMON_P2P_SIGNAL_TYPES[number]
export const isDaemonP2PSignalType = makeTypeGuard(DAEMON_P2P_SIGNAL_TYPES)

export type P2POfferWirePayload = { sdp: string; type: string; peerId: string }
export type P2PIceWirePayload = { candidate: string; mid: string; peerId: string }

/**
 * A dashboard-originated signal as relayed to the daemon. `peerId` is stamped
 * by UserSession/SharedSession, `sharePermission` only by SharedSession (server
 * authority, never the client). Field names follow the browser/node-datachannel
 * spellings both ends already read.
 */
export type RelayedP2PSignalWirePayload = {
    peerId?: string
    daemonId?: string
    sharePermission?: string
    sdp?: string
    type?: string
    candidate?: string
    mid?: string
    sdpMid?: string | null
    sdpMLineIndex?: number | null
}

export const MESH_P2P_SIGNAL_TYPES = ['mesh_p2p_ready', 'mesh_p2p_offer', 'mesh_p2p_answer', 'mesh_p2p_ice'] as const
export type MeshP2PSignalType = typeof MESH_P2P_SIGNAL_TYPES[number]
export const isMeshP2PSignalType = makeTypeGuard(MESH_P2P_SIGNAL_TYPES)

/** Daemon→daemon signal as delivered to the target daemon: the sender's args plus the server-stamped canonical sender id. */
export type MeshP2PSignalWirePayload = { senderDaemonId: string } & Record<string, unknown>

// ─── Daemon → Server ───────────────────────────────────────────────────────

export const DAEMON_TO_SERVER_TYPES = [
    'auth',
    'status_report',
    'status_heartbeat',
    'status_event',
    'command_result',
    'error',
    'agent_event',
    'beacon_vectors',
    'daemon_mesh_command',
    'p2p_offer',
    'p2p_ice',
] as const
export type DaemonToServerType = typeof DAEMON_TO_SERVER_TYPES[number]
export const isDaemonToServerType = makeTypeGuard(DAEMON_TO_SERVER_TYPES)

export type DaemonAuthMsg = Envelope<'auth', DaemonAuthWirePayload>
export type StatusReportMsg = Envelope<'status_report', CloudStatusReportWirePayload>
export type StatusHeartbeatMsg = Envelope<'status_heartbeat', StatusHeartbeatWirePayload>
export type DaemonStatusEventMsg = Envelope<'status_event', DaemonStatusEventWirePayload>
export type CommandResultMsg = Envelope<'command_result', CommandResultWirePayload>
export type DaemonErrorMsg = Envelope<'error', DaemonErrorWirePayload>
/** Agent-level event forwarded verbatim to the `agent:status` webhook (throttled server-side). Dynamic by design. */
export type AgentEventMsg = Envelope<'agent_event', CommandPayload>
export type BeaconVectorsMsg = Envelope<'beacon_vectors', BeaconVectorsWirePayload>
export type DaemonP2POfferMsg = Envelope<'p2p_offer', P2POfferWirePayload>
export type DaemonP2PIceMsg = Envelope<'p2p_ice', P2PIceWirePayload>
/**
 * Daemon→daemon signaling relay request. Fields are TOP-LEVEL (no `payload`):
 * this is the wire shape the live fleet speaks, kept as-is so mixed-version
 * daemons and servers keep interoperating during a rollout.
 */
export type DaemonMeshCommandMsg = {
    type: 'daemon_mesh_command'
    requestId: string
    targetDaemonId: string
    command: MeshP2PSignalType
    args: Record<string, unknown>
    timestamp: number
}

export type DaemonToServerMsg =
    | DaemonAuthMsg
    | StatusReportMsg
    | StatusHeartbeatMsg
    | DaemonStatusEventMsg
    | CommandResultMsg
    | DaemonErrorMsg
    | AgentEventMsg
    | BeaconVectorsMsg
    | DaemonMeshCommandMsg
    | DaemonP2POfferMsg
    | DaemonP2PIceMsg

const _daemonToServerNamesCoverUnion: AssertSameMembers<typeof DAEMON_TO_SERVER_TYPES, DaemonToServerMsg['type']> = true
void _daemonToServerNamesCoverUnion

/** Members that carry a `payload` object (everything except `daemon_mesh_command`). */
export type DaemonToServerPayloadType = Exclude<DaemonToServerMsg, DaemonMeshCommandMsg>['type']
export type DaemonToServerPayloadOf<T extends DaemonToServerPayloadType> = Extract<DaemonToServerMsg, { type: T }>['payload']

/**
 * Parse boundary for the server: is `raw` a frame this link accepts from a daemon?
 * Checks membership and the minimal envelope shape; `auth` additionally needs a
 * token string because nothing downstream can proceed without one.
 */
export function decodeDaemonToServer(raw: unknown): DaemonToServerMsg | null {
    if (!isRecord(raw) || !isDaemonToServerType(raw.type)) return null
    if (raw.type === 'daemon_mesh_command') {
        // Handler-side validation replies with a correlated `daemon_mesh_result`
        // error, so only the discriminant is checked here.
        return {
            type: 'daemon_mesh_command',
            requestId: typeof raw.requestId === 'string' ? raw.requestId : String(raw.requestId ?? ''),
            targetDaemonId: typeof raw.targetDaemonId === 'string' ? raw.targetDaemonId : '',
            command: raw.command as MeshP2PSignalType,
            args: isRecord(raw.args) ? raw.args : {},
            timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
        }
    }
    if (!isRecord(raw.payload)) return null
    if (raw.type === 'auth' && !isNonEmptyString(raw.payload.token)) return null
    return { type: raw.type, payload: raw.payload, ...readEnvelopeFields(raw) } as DaemonToServerMsg
}

// ─── Server → Daemon ───────────────────────────────────────────────────────

export const SERVER_TO_DAEMON_CONTROL_TYPES = [
    'auth_ok',
    'auth_error',
    'machine_evicted',
    'force_disconnect',
    'token_revoked',
    'version_mismatch',
    'force_update_required',
    'command',
    'agent_command',
    'resolve_action',
    'beacon_vectors_result',
    'daemon_mesh_result',
    'p2p_ready',
    'p2p_offer',
    'p2p_answer',
    'p2p_ice',
    'mesh_p2p_ready',
    'mesh_p2p_offer',
    'mesh_p2p_answer',
    'mesh_p2p_ice',
] as const
export type ServerToDaemonControlType = typeof SERVER_TO_DAEMON_CONTROL_TYPES[number]
export const isServerToDaemonControlType = makeTypeGuard(SERVER_TO_DAEMON_CONTROL_TYPES)

/** Optional routing fields the server stamps on relayed commands. */
type ServerRelayFields = { id?: MessageId; source?: string; timestamp?: number }

export type AuthOkMsg = Envelope<'auth_ok', AuthOkWirePayload>
export type AuthErrorMsg = Envelope<'auth_error', AuthErrorWirePayload>
export type MachineEvictedMsg = Envelope<'machine_evicted', DisconnectNoticeWirePayload>
export type ForceDisconnectMsg = Envelope<'force_disconnect', DisconnectNoticeWirePayload>
export type TokenRevokedMsg = Envelope<'token_revoked', DisconnectNoticeWirePayload>
export type VersionMismatchMsg = Envelope<'version_mismatch', VersionMismatchWirePayload>
export type ForceUpdateRequiredMsg = Envelope<'force_update_required', ForceUpdateRequiredWirePayload>
/** Wrapped command: `payload.command` names the command, `payload.args` carries it. */
export type ServerCommandMsg = Envelope<'command', { command: string; args?: CommandPayload } & Record<string, unknown>> & ServerRelayFields
export type ServerAgentCommandMsg = Envelope<'agent_command', { action: string } & Record<string, unknown>> & ServerRelayFields
export type ServerResolveActionMsg = Envelope<'resolve_action', CommandPayload> & ServerRelayFields
export type ServerP2PSignalMsg = Envelope<P2PSignalType, RelayedP2PSignalWirePayload> & ServerRelayFields
export type ServerMeshP2PSignalMsg = Envelope<MeshP2PSignalType, MeshP2PSignalWirePayload> & ServerRelayFields
/** Reply to a `beacon_vectors` GET, correlated by `requestId` (top-level, no payload). A PUT gets no reply. */
export type BeaconVectorsResultMsg = {
    type: 'beacon_vectors_result'
    requestId: string
    success: boolean
    reports?: unknown[]
    truncated?: number
    error?: string
}
/** Correlated ack/nack of a `daemon_mesh_command` (top-level, no payload). */
export type DaemonMeshResultMsg = {
    type: 'daemon_mesh_result'
    requestId: string
    success: boolean
    result?: unknown
    error?: string
}

export type ServerToDaemonControlMsg =
    | AuthOkMsg
    | AuthErrorMsg
    | MachineEvictedMsg
    | ForceDisconnectMsg
    | TokenRevokedMsg
    | VersionMismatchMsg
    | ForceUpdateRequiredMsg
    | ServerCommandMsg
    | ServerAgentCommandMsg
    | ServerResolveActionMsg
    | BeaconVectorsResultMsg
    | DaemonMeshResultMsg
    | ServerP2PSignalMsg
    | ServerMeshP2PSignalMsg

const _serverToDaemonControlNamesCoverUnion: AssertSameMembers<typeof SERVER_TO_DAEMON_CONTROL_TYPES, ServerToDaemonControlMsg['type']> = true
void _serverToDaemonControlNamesCoverUnion

declare const directCommandBrand: unique symbol
/**
 * A command name relayed as the frame `type` — the OPEN namespace the REST API
 * and `shortcuts` routes feed (`read_chat`, `send_chat`, `stop_cli`, `git_*`,
 * `clone_mesh_node`, `terminal_exec`, ...). The daemon routes it by name
 * through its command router. Branded so it cannot be confused with a control
 * member at the type level; `decodeServerToDaemon` is the only producer.
 */
export type DaemonDirectCommandType = string & { readonly [directCommandBrand]?: true }

export type ServerDirectCommandMsg = {
    type: DaemonDirectCommandType
    payload: CommandPayload
    id?: MessageId
    source?: string
    timestamp?: number
}

export type ServerToDaemonMsg = ServerToDaemonControlMsg | ServerDirectCommandMsg
export type ServerToDaemonType = ServerToDaemonMsg['type']

export function isServerDirectCommandMsg(msg: ServerToDaemonMsg): msg is ServerDirectCommandMsg {
    return !isServerToDaemonControlType(msg.type)
}

/** Members of the control set that carry a `payload` object. */
export type ServerToDaemonPayloadType = Exclude<ServerToDaemonControlMsg, BeaconVectorsResultMsg | DaemonMeshResultMsg>['type']
export type ServerToDaemonPayloadOf<T extends ServerToDaemonPayloadType> = Extract<ServerToDaemonControlMsg, { type: T }>['payload']

/** Command types a daemon must never receive as a direct command: they are daemon→server frames or reserved envelope words. */
const DIRECT_COMMAND_TYPE_PATTERN = /^[a-z][a-z0-9_:.-]{0,63}$/

export function isDaemonDirectCommandType(value: unknown): value is DaemonDirectCommandType {
    return typeof value === 'string' && DIRECT_COMMAND_TYPE_PATTERN.test(value) && !isServerToDaemonControlType(value)
}

/**
 * Parse boundary for the daemon: is `raw` a frame this link accepts from the server?
 * Control members are checked for their discriminant and envelope shape; the
 * two payload-less replies need their `requestId`; any other well-formed
 * command name becomes a `ServerDirectCommandMsg`.
 */
export function decodeServerToDaemon(raw: unknown): ServerToDaemonMsg | null {
    if (!isRecord(raw) || typeof raw.type !== 'string') return null
    const relay = {
        ...readEnvelopeFields(raw),
        ...(isNonEmptyString(raw.source) ? { source: raw.source } : {}),
    }
    if (raw.type === 'beacon_vectors_result' || raw.type === 'daemon_mesh_result') {
        if (!isNonEmptyString(raw.requestId)) return null
        const base = { requestId: raw.requestId, success: raw.success === true }
        if (raw.type === 'beacon_vectors_result') {
            return {
                type: 'beacon_vectors_result',
                ...base,
                ...(Array.isArray(raw.reports) ? { reports: raw.reports } : {}),
                ...(typeof raw.truncated === 'number' ? { truncated: raw.truncated } : {}),
                ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
            }
        }
        return {
            type: 'daemon_mesh_result',
            ...base,
            ...('result' in raw ? { result: raw.result } : {}),
            ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        }
    }
    if (!isRecord(raw.payload)) return null
    if (isServerToDaemonControlType(raw.type)) {
        return { type: raw.type, payload: raw.payload, ...relay } as ServerToDaemonControlMsg
    }
    if (!isDaemonDirectCommandType(raw.type)) return null
    return { type: raw.type, payload: raw.payload, ...relay }
}
