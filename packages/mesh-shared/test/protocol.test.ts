import { describe, expect, it } from 'vitest'
import {
    DAEMON_TO_SERVER_TYPES,
    SERVER_TO_DAEMON_CONTROL_TYPES,
    USER_SESSION_TO_DASHBOARD_TYPES,
    DASHBOARD_TO_USER_SESSION_TYPES,
    SHARED_SESSION_TO_VIEWER_TYPES,
    VIEWER_TO_SHARED_SESSION_TYPES,
    DASHBOARD_TO_DAEMON_P2P_TYPES,
    DAEMON_TO_DASHBOARD_P2P_TYPES,
    DASHBOARD_P2P_MESSAGE_KINDS,
    DAEMON_STATUS_EVENT_NAMES,
    DASHBOARD_STATUS_EVENT_NAMES,
    P2P_SIGNAL_TYPES,
    MESH_P2P_SIGNAL_TYPES,
    decodeDaemonToServer,
    decodeServerToDaemon,
    isServerDirectCommandMsg,
    decodeUserSessionToDashboard,
    decodeDashboardToUserSession,
    decodeViewerToSharedSession,
    decodeDashboardToDaemonP2P,
    decodeDashboardToDaemonP2PChunk,
    decodeDaemonToDashboardP2P,
    isDashboardToDaemonChunkType,
    type DaemonToServerMsg,
    type ServerToDaemonControlMsg,
    type UserSessionToDashboardMsg,
    type DashboardToUserSessionMsg,
    type SharedSessionToViewerMsg,
    type ViewerToSharedSessionMsg,
    type DashboardToDaemonP2PMsg,
    type DaemonToDashboardP2PMsg,
    type AssertSameMembers,
} from '../src/protocol'
import {
    DAEMON_TO_SERVER_WS_MSGS,
    SERVER_TO_DAEMON_WS_MSGS,
    type DaemonToServerWsMsg,
    type ServerToDaemonWsMsg,
    type P2PSignalingWsMsg,
    type DashboardP2PMessageKind,
} from '../src/ws-protocol'

/**
 * Drift gate (A2): every exported name tuple must equal its union's members,
 * and the legacy name lists in ws-protocol.ts must agree with protocol/.
 *
 * The tuple↔union equality is a COMPILE-TIME fact (`AssertSameMembers` in each
 * protocol file, re-asserted below so this test file fails `tsc` too); the
 * runtime assertions here catch the remaining ways a list can drift —
 * duplicates, a tuple that is not the array a consumer actually iterates,
 * and the legacy aliases diverging from the derived source.
 */

const _d2s: AssertSameMembers<typeof DAEMON_TO_SERVER_TYPES, DaemonToServerMsg['type']> = true
const _s2d: AssertSameMembers<typeof SERVER_TO_DAEMON_CONTROL_TYPES, ServerToDaemonControlMsg['type']> = true
const _u2d: AssertSameMembers<typeof USER_SESSION_TO_DASHBOARD_TYPES, UserSessionToDashboardMsg['type']> = true
const _d2u: AssertSameMembers<typeof DASHBOARD_TO_USER_SESSION_TYPES, DashboardToUserSessionMsg['type']> = true
const _s2v: AssertSameMembers<typeof SHARED_SESSION_TO_VIEWER_TYPES, SharedSessionToViewerMsg['type']> = true
const _v2s: AssertSameMembers<typeof VIEWER_TO_SHARED_SESSION_TYPES, ViewerToSharedSessionMsg['type']> = true
const _b2d: AssertSameMembers<typeof DASHBOARD_TO_DAEMON_P2P_TYPES, DashboardToDaemonP2PMsg['type']> = true
const _d2b: AssertSameMembers<typeof DAEMON_TO_DASHBOARD_P2P_TYPES, DaemonToDashboardP2PMsg['type']> = true
// Legacy aliases in ws-protocol.ts are derived, so they must be the SAME sets.
const _legacyD2s: AssertSameMembers<typeof DAEMON_TO_SERVER_TYPES, DaemonToServerWsMsg> = true
const _legacyS2d: AssertSameMembers<typeof SERVER_TO_DAEMON_CONTROL_TYPES, ServerToDaemonWsMsg> = true
const _legacySignal: AssertSameMembers<[...typeof P2P_SIGNAL_TYPES, ...typeof MESH_P2P_SIGNAL_TYPES], P2PSignalingWsMsg> = true
const _legacyP2P: AssertSameMembers<[...typeof DASHBOARD_TO_DAEMON_P2P_TYPES, ...typeof DAEMON_TO_DASHBOARD_P2P_TYPES], DashboardP2PMessageKind> = true
void [_d2s, _s2d, _u2d, _d2u, _s2v, _v2s, _b2d, _d2b, _legacyD2s, _legacyS2d, _legacySignal, _legacyP2P]

function expectUniqueNames(names: readonly string[]): void {
    expect(new Set(names).size).toBe(names.length)
}

describe('protocol name tuples', () => {
    it('have no duplicate members', () => {
        for (const names of [
            DAEMON_TO_SERVER_TYPES,
            SERVER_TO_DAEMON_CONTROL_TYPES,
            USER_SESSION_TO_DASHBOARD_TYPES,
            DASHBOARD_TO_USER_SESSION_TYPES,
            SHARED_SESSION_TO_VIEWER_TYPES,
            VIEWER_TO_SHARED_SESSION_TYPES,
            DASHBOARD_TO_DAEMON_P2P_TYPES,
            DAEMON_TO_DASHBOARD_P2P_TYPES,
            DAEMON_STATUS_EVENT_NAMES,
            DASHBOARD_STATUS_EVENT_NAMES,
        ]) {
            expectUniqueNames(names)
        }
    })

    it('legacy ws-protocol lists are the protocol tuples', () => {
        expect([...DAEMON_TO_SERVER_WS_MSGS]).toEqual([...DAEMON_TO_SERVER_TYPES])
        expect([...SERVER_TO_DAEMON_WS_MSGS]).toEqual([...SERVER_TO_DAEMON_CONTROL_TYPES])
        expect(DAEMON_TO_SERVER_WS_MSGS).not.toContain('log')
        expect(DAEMON_TO_SERVER_WS_MSGS).toContain('daemon_mesh_command')
        expect([...DASHBOARD_P2P_MESSAGE_KINDS].sort()).toEqual(
            [...new Set([...DASHBOARD_TO_DAEMON_P2P_TYPES, ...DAEMON_TO_DASHBOARD_P2P_TYPES])].sort(),
        )
    })

    it('dashboard status events extend the daemon status events', () => {
        for (const name of DAEMON_STATUS_EVENT_NAMES) expect(DASHBOARD_STATUS_EVENT_NAMES).toContain(name)
        expect(DAEMON_STATUS_EVENT_NAMES).toContain('agent:waiting_choice')
    })
})

describe('decodeDaemonToServer', () => {
    it('accepts every member with an object payload and rejects unknown or payload-less frames', () => {
        for (const type of DAEMON_TO_SERVER_TYPES) {
            if (type === 'daemon_mesh_command') continue
            const frame = { type, payload: type === 'auth' ? { token: 'adm_x', daemon: {} } : { a: 1 }, timestamp: 1 }
            expect(decodeDaemonToServer(frame)?.type).toBe(type)
            expect(decodeDaemonToServer({ type, timestamp: 1 })).toBeNull()
        }
        expect(decodeDaemonToServer({ type: 'log', payload: {} })).toBeNull()
        expect(decodeDaemonToServer({ type: 'auth', payload: {} })).toBeNull()
        expect(decodeDaemonToServer('nope')).toBeNull()
    })

    it('keeps daemon_mesh_command flat (top-level fields) as the fleet speaks it', () => {
        const decoded = decodeDaemonToServer({
            type: 'daemon_mesh_command', requestId: 'r1', targetDaemonId: 'daemon_mach_b', command: 'mesh_p2p_offer', args: { sdp: 'x' }, timestamp: 5,
        })
        expect(decoded).toEqual({
            type: 'daemon_mesh_command', requestId: 'r1', targetDaemonId: 'daemon_mach_b', command: 'mesh_p2p_offer', args: { sdp: 'x' }, timestamp: 5,
        })
        // Malformed fields are left for the handler, which replies with a correlated error.
        expect(decodeDaemonToServer({ type: 'daemon_mesh_command' })?.type).toBe('daemon_mesh_command')
    })
})

describe('decodeServerToDaemon', () => {
    it('narrows control members and brands everything else as a direct command', () => {
        const authOk = decodeServerToDaemon({ type: 'auth_ok', payload: { plan: 'pro' }, timestamp: 1 })
        expect(authOk && !isServerDirectCommandMsg(authOk) && authOk.type).toBe('auth_ok')
        const direct = decodeServerToDaemon({ type: 'read_chat', payload: { targetSessionId: 's' }, id: 'msg_1', source: 'api', timestamp: 2 })
        expect(direct && isServerDirectCommandMsg(direct)).toBe(true)
        expect(direct).toEqual({ type: 'read_chat', payload: { targetSessionId: 's' }, id: 'msg_1', source: 'api', timestamp: 2 })
        for (const type of SERVER_TO_DAEMON_CONTROL_TYPES) {
            if (type === 'beacon_vectors_result' || type === 'daemon_mesh_result') continue
            const decoded = decodeServerToDaemon({ type, payload: {} })
            expect(decoded?.type).toBe(type)
            expect(decoded && isServerDirectCommandMsg(decoded)).toBe(false)
        }
    })

    it('requires a requestId on the two payload-less replies', () => {
        expect(decodeServerToDaemon({ type: 'daemon_mesh_result', success: false, error: 'x' })).toBeNull()
        expect(decodeServerToDaemon({ type: 'daemon_mesh_result', requestId: 'r', success: true, result: { ok: 1 } })).toEqual({
            type: 'daemon_mesh_result', requestId: 'r', success: true, result: { ok: 1 },
        })
        expect(decodeServerToDaemon({ type: 'beacon_vectors_result', requestId: 'b', success: true, reports: [], truncated: 0 })).toEqual({
            type: 'beacon_vectors_result', requestId: 'b', success: true, reports: [], truncated: 0,
        })
    })

    it('rejects command names that are not well formed', () => {
        expect(decodeServerToDaemon({ type: 'Read Chat', payload: {} })).toBeNull()
        expect(decodeServerToDaemon({ type: '', payload: {} })).toBeNull()
        expect(decodeServerToDaemon({ type: 'read_chat' })).toBeNull()
    })
})

describe('dashboard ↔ UserSession decoders', () => {
    it('accept every server frame with an object payload, including connected', () => {
        for (const type of USER_SESSION_TO_DASHBOARD_TYPES) {
            expect(decodeUserSessionToDashboard({ type, payload: {}, timestamp: 1 })?.type).toBe(type)
        }
        expect(decodeUserSessionToDashboard({ type: 'plan_limit_error', payload: {} })).toBeNull()
        expect(decodeUserSessionToDashboard({ type: 'connected' })).toBeNull()
        // Liveness first: a payload-less heartbeat reply still counts as a pong.
        expect(decodeUserSessionToDashboard({ type: 'heartbeat', timestamp: 7 })).toEqual({ type: 'heartbeat', payload: {}, timestamp: 7 })
    })

    it('route dashboard signals by daemonId and accept the two control frames', () => {
        expect(decodeDashboardToUserSession({ type: 'heartbeat', timestamp: 3 })).toEqual({ type: 'heartbeat', timestamp: 3 })
        expect(decodeDashboardToUserSession({ type: 'refresh' })).toEqual({ type: 'refresh' })
        expect(decodeDashboardToUserSession({ type: 'p2p_ready', payload: { peerId: 'p' } })).toBeNull()
        expect(decodeDashboardToUserSession({ type: 'p2p_answer', payload: { daemonId: 'd', peerId: 'p', sdp: 's', type: 'answer' } })?.type).toBe('p2p_answer')
        expect(decodeDashboardToUserSession({ type: 'p2p_offer', payload: { daemonId: 'd' } })).toBeNull()
    })

    it('share viewers may only send signaling', () => {
        for (const type of VIEWER_TO_SHARED_SESSION_TYPES) {
            expect(decodeViewerToSharedSession({ type, payload: { sdp: 'x' } })).toEqual({ type, payload: { sdp: 'x' } })
        }
        expect(decodeViewerToSharedSession({ type: 'chat', payload: {} })).toBeNull()
    })
})

describe('P2P decoders', () => {
    it('daemon side: request kinds need an id, chunk kinds are derived from the request kinds', () => {
        expect(decodeDashboardToDaemonP2P({ type: 'command', commandType: 'send_chat', data: {} })).toBeNull()
        expect(decodeDashboardToDaemonP2P({ type: 'command', id: 'c1', commandType: 'send_chat', data: {} })?.type).toBe('command')
        expect(decodeDashboardToDaemonP2P({ type: 'pty_input', targetSessionId: 's', data: 'x' })?.type).toBe('pty_input')
        expect(isDashboardToDaemonChunkType('command_chunk')).toBe(true)
        expect(isDashboardToDaemonChunkType('status_report_chunk')).toBe(false)
        expect(decodeDashboardToDaemonP2PChunk({ type: 'input_chunk', id: 'i1', chunkId: 'k', index: 0, total: 2, data: '{' })).toEqual({
            type: 'input_chunk', id: 'i1', chunkId: 'k', index: 0, total: 2, data: '{',
        })
        expect(decodeDashboardToDaemonP2PChunk({ type: 'input_chunk', chunkId: 'k', index: 'x', total: 2, data: '{' })).toBeNull()
        expect(decodeDashboardToDaemonP2PChunk({ type: 'status_report_chunk', chunkId: 'k', index: 0, total: 1, data: '{' })).toBeNull()
        // A chunk piece is not a request: the whole-frame decoder refuses it.
        expect(decodeDashboardToDaemonP2P({ type: 'input_chunk', id: 'i1', chunkId: 'k', index: 0, total: 2, data: '{' })).toBeNull()
        expect(decodeDashboardToDaemonP2P({ type: 'status_report', payload: {} })).toBeNull()
    })

    it('dashboard side: promotes a legacy typeless file reply to response and checks minimal shapes', () => {
        expect(decodeDaemonToDashboardP2P({ id: 'r1', success: true, content: 'hi' })).toEqual({ type: 'response', id: 'r1', success: true, content: 'hi' })
        expect(decodeDaemonToDashboardP2P({ type: 'response', id: 'r1', success: false, error: 'nope' })?.type).toBe('response')
        expect(decodeDaemonToDashboardP2P({ type: 'command_result', success: true })).toBeNull()
        expect(decodeDaemonToDashboardP2P({ type: 'session_output', sessionId: 's', data: 'x' })?.type).toBe('session_output')
        expect(decodeDaemonToDashboardP2P({ type: 'session_output', data: 'x' })).toBeNull()
        expect(decodeDaemonToDashboardP2P({ type: 'session_output_chunk', sessionId: 's', chunkId: 'k', index: 0, total: 1, data: '{}' })).toEqual({
            type: 'session_output_chunk', sessionId: 's', chunkId: 'k', index: 0, total: 1, data: '{}',
        })
        expect(decodeDaemonToDashboardP2P({ type: 'topic_update' })).toBeNull()
        expect(decodeDaemonToDashboardP2P({ type: 'topic_update', update: { topic: 't', key: 'k' } })?.type).toBe('topic_update')
        expect(decodeDaemonToDashboardP2P({ type: 'status_event', payload: { event: 'agent:stopped', timestamp: 1 }, timestamp: 1 })?.type).toBe('status_event')
        expect(decodeDaemonToDashboardP2P({ type: 'p2p_evicted', reason: 'P2P_LIMIT_REACHED', maxconnections: 1 })?.type).toBe('p2p_evicted')
        expect(decodeDaemonToDashboardP2P({ type: 'command', id: 'x', commandType: 'y', data: {} })).toBeNull()
    })
})
