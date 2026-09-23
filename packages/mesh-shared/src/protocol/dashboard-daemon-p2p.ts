/**
 * protocol/dashboard-daemon-p2p — the dashboard ↔ daemon WebRTC DataChannel
 * link (`data` channel, JSON frames; screenshots ride the same channel as
 * binary and are not frames).
 *
 * Wiring-unification Phase A2 (docs/design/2026-09-23-wiring-unification.md §3 A2).
 *
 * Before this file ~20 kinds were matched as bare string literals on both ends
 * (web-cloud `p2p.ts`, daemon-cloud `data-channel-router.ts`), the shared
 * `DashboardP2PMessageKind` listed 12 of them and was imported by nothing, and
 * the daemon's file-operation replies carried no `type` at all — the browser
 * matched them by `id` as a fallthrough. They are now `response` frames; the
 * browser decoder still accepts the typeless legacy shape from older daemons.
 *
 * Chunking: any request frame may be split by the sender into
 * `<kind>_chunk` frames (`id`, `chunkId`, `index`, `total`, `data`) when it
 * exceeds `MESH_MAX_INLINE_FRAME_BYTES` (../rpc-chunking.ts). Each direction
 * reassembles BEFORE decoding, so the decoders see whole frames; the chunk
 * envelope is typed here so the splitter and the reassembler agree.
 *
 * Content boundary: this is the P2P plane — rich session data (chat, prompts,
 * transcripts, PTY output) is CORRECT here and must not be reduced.
 */

import {
    type CommandPayload,
    type MessageId,
    type AssertSameMembers,
    isRecord,
    isNonEmptyString,
    makeTypeGuard,
} from './envelope'
import type { DaemonStatusEventWirePayload } from './daemon-server'

// ─── Chunk envelope (both directions) ──────────────────────────────────────

export type ChunkFrame<T extends string> = {
    type: T
    /** Request id of the frame being split, when it has one. */
    id?: MessageId
    chunkId: string
    index: number
    total: number
    data: string
}

export function isChunkType(value: unknown): value is `${string}_chunk` {
    return typeof value === 'string' && value.endsWith('_chunk') && value.length > '_chunk'.length
}

function readChunkFields(frame: Record<string, unknown>): Omit<ChunkFrame<string>, 'type'> | null {
    if (!isNonEmptyString(frame.chunkId)) return null
    if (!Number.isInteger(frame.index) || !Number.isInteger(frame.total)) return null
    if (typeof frame.data !== 'string') return null
    return {
        ...(isNonEmptyString(frame.id) ? { id: frame.id } : {}),
        chunkId: frame.chunkId,
        index: frame.index as number,
        total: frame.total as number,
        data: frame.data,
    }
}

// ─── Dashboard → Daemon ────────────────────────────────────────────────────

export const DASHBOARD_TO_DAEMON_P2P_TYPES = [
    'ping',
    'pong',
    'command',
    'input',
    'pty_input',
    'pty_resize',
    'screenshot_start',
    'screenshot_stop',
    'subscribe',
    'unsubscribe',
    'seqscribe_session_interest',
    'read',
    'write',
    'list',
] as const
export type DashboardToDaemonP2PType = typeof DASHBOARD_TO_DAEMON_P2P_TYPES[number]
export const isDashboardToDaemonP2PType = makeTypeGuard(DASHBOARD_TO_DAEMON_P2P_TYPES)

export type DashboardToDaemonChunkType = `${DashboardToDaemonP2PType}_chunk`
export function isDashboardToDaemonChunkType(value: unknown): value is DashboardToDaemonChunkType {
    return isChunkType(value) && isDashboardToDaemonP2PType(value.slice(0, -'_chunk'.length))
}

export type P2PPingMsg = { type: 'ping'; ts: number }
export type P2PPongMsg = { type: 'pong'; ts: number }
/** A command routed through the daemon's command router; `commandType`/`data` are dynamic by design. */
export type P2PCommandMsg = { type: 'command'; id: MessageId; commandType: string; data: CommandPayload }
/** Remote-desktop input (click/type/key) for the target session's IDE surface. */
export type P2PInputMsg = { type: 'input'; id: MessageId; action: string; params: CommandPayload; targetSessionId?: string }
/** Raw PTY input. `sessionId` is canonical; `targetSessionId` is the accepted alias. */
export type P2PPtyInputMsg = { type: 'pty_input'; sessionId?: string; targetSessionId?: string; data: string }
export type P2PPtyResizeMsg = { type: 'pty_resize'; sessionId: string; cols: number; rows: number }
export type P2PScreenshotStartMsg = { type: 'screenshot_start'; targetSessionId: string }
export type P2PScreenshotStopMsg = { type: 'screenshot_stop'; targetSessionId?: string }
/** Topic subscription. `params` is topic-specific (daemon-core `SubscribeRequestMap`); `object` keeps every topic's interface assignable. */
export type P2PSubscribeMsg = { type: 'subscribe'; topic: string; key: string; params: object }
export type P2PUnsubscribeMsg = { type: 'unsubscribe'; topic: string; key: string }
/** Which sessions this peer wants replicated over the seqscribe lane; also the peer's responder proof. */
export type P2PSessionInterestMsg = { type: 'seqscribe_session_interest'; sessionIds: readonly string[] }
export type P2PFileReadMsg = { type: 'read'; id: MessageId; path: string }
export type P2PFileWriteMsg = { type: 'write'; id: MessageId; path: string; content: string }
export type P2PFileListMsg = { type: 'list'; id: MessageId; path: string }
export type DashboardToDaemonChunkMsg = ChunkFrame<DashboardToDaemonChunkType>

export type DashboardToDaemonP2PMsg =
    | P2PPingMsg
    | P2PPongMsg
    | P2PCommandMsg
    | P2PInputMsg
    | P2PPtyInputMsg
    | P2PPtyResizeMsg
    | P2PScreenshotStartMsg
    | P2PScreenshotStopMsg
    | P2PSubscribeMsg
    | P2PUnsubscribeMsg
    | P2PSessionInterestMsg
    | P2PFileReadMsg
    | P2PFileWriteMsg
    | P2PFileListMsg

const _dashboardToDaemonNamesCoverUnion: AssertSameMembers<typeof DASHBOARD_TO_DAEMON_P2P_TYPES, DashboardToDaemonP2PMsg['type']> = true
void _dashboardToDaemonNamesCoverUnion

/** Request kinds the daemon answers by `id`; a frame without one cannot be answered and is dropped at the boundary. */
const DASHBOARD_REQUEST_TYPES = new Set<DashboardToDaemonP2PType>(['command', 'input', 'read', 'write', 'list'])

/** Parse boundary for the daemon's chunk reassembler: one `<kind>_chunk` piece of a split request. */
export function decodeDashboardToDaemonP2PChunk(raw: unknown): DashboardToDaemonChunkMsg | null {
    if (!isRecord(raw) || !isDashboardToDaemonChunkType(raw.type)) return null
    const fields = readChunkFields(raw)
    return fields ? { type: raw.type, ...fields } : null
}

/**
 * Parse boundary for the daemon (after chunk reassembly): a whole request.
 * Chunk pieces are not requests and decode to null here; see
 * `decodeDashboardToDaemonP2PChunk`.
 */
export function decodeDashboardToDaemonP2P(raw: unknown): DashboardToDaemonP2PMsg | null {
    if (!isRecord(raw) || !isDashboardToDaemonP2PType(raw.type)) return null
    if (DASHBOARD_REQUEST_TYPES.has(raw.type) && !isNonEmptyString(raw.id)) return null
    return raw as DashboardToDaemonP2PMsg
}

// ─── Daemon → Dashboard ────────────────────────────────────────────────────

export const DAEMON_TO_DASHBOARD_P2P_TYPES = [
    'ping',
    'pong',
    'p2p_evicted',
    'status_report',
    'status_event',
    'topic_update',
    'topic_update_chunk',
    'session_output',
    'session_output_chunk',
    'session_io_error',
    'command_result',
    'command_result_chunk',
    'response',
] as const
export type DaemonToDashboardP2PType = typeof DAEMON_TO_DASHBOARD_P2P_TYPES[number]
export const isDaemonToDashboardP2PType = makeTypeGuard(DAEMON_TO_DASHBOARD_P2P_TYPES)

/** Rich P2P status snapshot (daemon-core `StatusReportPayload`, or a `_delta` partial of it). Dynamic by design on this plane. */
export type P2PStatusReportWirePayload = Record<string, unknown>

/** The server-bound event plus the P2P-only structured prompt (daemon-core `P2PStatusEventPayload`). */
export type P2PStatusEventWirePayload = DaemonStatusEventWirePayload & {
    interactivePrompt?: unknown
    promptId?: string
    multiSelect?: boolean
}

/** One topic update (daemon-core `TopicUpdateEnvelope`); consumers narrow by `topic`. */
export type TopicUpdateWireEnvelope = { topic: string; key: string }

export type P2PFileEntry = { name: string; type: string; size?: number }

export type P2PEvictedMsg = { type: 'p2p_evicted'; reason: string; maxconnections: number }
export type P2PStatusReportMsg = { type: 'status_report'; payload: P2PStatusReportWirePayload; timestamp: number }
export type P2PStatusEventMsg = { type: 'status_event'; payload: P2PStatusEventWirePayload; timestamp: number }
export type P2PTopicUpdateMsg = { type: 'topic_update'; update: TopicUpdateWireEnvelope }
export type P2PTopicUpdateChunkMsg = ChunkFrame<'topic_update_chunk'>
export type P2PSessionOutputMsg = { type: 'session_output'; sessionId: string; data: string }
export type P2PSessionOutputChunkMsg = ChunkFrame<'session_output_chunk'> & { sessionId: string }
export type P2PSessionIoErrorMsg = { type: 'session_io_error'; sessionId: string; reason: string; error?: string }
/** Result of a `command` frame. The router spreads the handler result in; `resultId` preserves a result-side `id`. */
export type P2PCommandResultMsg = { type: 'command_result'; id: MessageId; success: boolean; error?: string; resultId?: unknown } & Record<string, unknown>
export type P2PCommandResultChunkMsg = ChunkFrame<'command_result_chunk'>
/** Result of an `input` or file (`read`/`write`/`list`) frame. */
export type P2PResponseMsg = {
    type: 'response'
    id: MessageId
    success: boolean
    result?: unknown
    error?: string
    content?: string
    entries?: P2PFileEntry[]
}

export type DaemonToDashboardP2PMsg =
    | P2PPingMsg
    | P2PPongMsg
    | P2PEvictedMsg
    | P2PStatusReportMsg
    | P2PStatusEventMsg
    | P2PTopicUpdateMsg
    | P2PTopicUpdateChunkMsg
    | P2PSessionOutputMsg
    | P2PSessionOutputChunkMsg
    | P2PSessionIoErrorMsg
    | P2PCommandResultMsg
    | P2PCommandResultChunkMsg
    | P2PResponseMsg

const _daemonToDashboardNamesCoverUnion: AssertSameMembers<typeof DAEMON_TO_DASHBOARD_P2P_TYPES, DaemonToDashboardP2PMsg['type']> = true
void _daemonToDashboardNamesCoverUnion

/**
 * Parse boundary for the dashboard (after chunk reassembly).
 *
 * A typeless `{ id, success }` frame is a file/input reply from a daemon that
 * predates the `response` kind; it is promoted here so the union stays
 * exhaustive while the fleet rolls forward.
 */
export function decodeDaemonToDashboardP2P(raw: unknown): DaemonToDashboardP2PMsg | null {
    if (!isRecord(raw)) return null
    if (raw.type === undefined && isNonEmptyString(raw.id) && typeof raw.success === 'boolean') {
        return { ...raw, type: 'response' } as P2PResponseMsg
    }
    if (!isDaemonToDashboardP2PType(raw.type)) return null
    switch (raw.type) {
        case 'ping':
        case 'pong':
        case 'p2p_evicted':
            return raw as DaemonToDashboardP2PMsg
        case 'status_report':
        case 'status_event':
            return isRecord(raw.payload) ? (raw as DaemonToDashboardP2PMsg) : null
        case 'topic_update':
            return isRecord(raw.update) ? (raw as P2PTopicUpdateMsg) : null
        case 'topic_update_chunk':
        case 'command_result_chunk':
        case 'session_output_chunk': {
            const fields = readChunkFields(raw)
            if (!fields) return null
            if (raw.type === 'session_output_chunk') {
                return isNonEmptyString(raw.sessionId) ? { type: raw.type, sessionId: raw.sessionId, ...fields } : null
            }
            return { type: raw.type, ...fields }
        }
        case 'session_output':
            return isNonEmptyString(raw.sessionId) && typeof raw.data === 'string' ? (raw as P2PSessionOutputMsg) : null
        case 'session_io_error':
            return isNonEmptyString(raw.sessionId) ? (raw as P2PSessionIoErrorMsg) : null
        case 'command_result':
        case 'response':
            return isNonEmptyString(raw.id) ? (raw as DaemonToDashboardP2PMsg) : null
    }
}

/** Both directions, for the legacy `DashboardP2PMessageKind` name and the drift gate. */
export const DASHBOARD_P2P_MESSAGE_KINDS = [
    ...new Set<string>([...DASHBOARD_TO_DAEMON_P2P_TYPES, ...DAEMON_TO_DASHBOARD_P2P_TYPES]),
] as ReadonlyArray<DashboardToDaemonP2PType | DaemonToDashboardP2PType>
