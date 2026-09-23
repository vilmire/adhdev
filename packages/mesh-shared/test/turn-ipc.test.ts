import { describe, expect, it } from 'vitest'
import {
    MAX_MESH_RECORD_STRING,
    MESH_RECORD_PAYLOAD_KEYS,
    TURN_IPC_COMMANDS,
    TURN_IPC_ERROR_CODES,
    TURN_IPC_PROTOCOL_VERSION,
    decodeMeshIndexQueryRequest,
    decodeMeshIndexQueryResponse,
    decodeMeshRecordRequest,
    decodeMeshRecordResponse,
    decodeMissionQueryRequest,
    decodeMissionQueryResponse,
    decodeMissionUpsertRequest,
    decodeMissionUpsertResponse,
    decodeOperatorStatusRequest,
    decodeOperatorStatusResponse,
    decodeTurnCancelRequest,
    decodeTurnCancelResponse,
    decodeTurnObserveRequest,
    decodeTurnObserveResponse,
    decodeTurnQueryRequest,
    decodeTurnQueryResponse,
    isMeshRecordPayload,
    isTurnIpcCommand,
    isTurnIpcError,
} from '../src/turn-ipc'

// Content-boundary contract (design §5 C2): every request/response in this
// file is identifiers/enums/booleans/counters/timestamps. This test proves
// the decoders actually enforce that — an unknown key (where a caller might
// smuggle free text) is rejected, not silently dropped or passed through.

const evidence = {
    eventId: 'ev-1',
    at: 1_000,
    source: 'mcp_probe',
    sessionId: 'sess-1',
    observedBy: 'daemon-1',
    kind: 'operator_status',
    status: 'completed',
    reason: 'operator_update',
} as const

describe('turn-ipc — command registry', () => {
    // C-W6 (2026-09-23): mission_upsert/mission_query added per the design
    // doc's "Decision" note — missions carry free-text goal/title that
    // cannot fit mesh_record's ProjectedScalars allow-list (see this file's
    // section header comment). Six became eight; the deliberate-update
    // pattern is the same one C-W2's report used for its own count changes.
    it('declares exactly eight commands', () => {
        expect(TURN_IPC_COMMANDS).toHaveLength(8)
        expect([...TURN_IPC_COMMANDS].sort()).toEqual([
            'mesh_index_query', 'mesh_record', 'mission_query', 'mission_upsert',
            'operator_status', 'turn_cancel', 'turn_observe', 'turn_query',
        ])
    })

    it('isTurnIpcCommand accepts only the eight names', () => {
        for (const name of TURN_IPC_COMMANDS) expect(isTurnIpcCommand(name)).toBe(true)
        expect(isTurnIpcCommand('mesh_status')).toBe(false)
        expect(isTurnIpcCommand('appendLedgerEntry')).toBe(false)
    })

    it('every command name is snake_case, no whitespace', () => {
        for (const name of TURN_IPC_COMMANDS) expect(name).toMatch(/^[a-z][a-z_]*[a-z]$/)
    })
})

describe('turn-ipc — error codes', () => {
    it('declares the three-member closed union', () => {
        expect([...TURN_IPC_ERROR_CODES].sort()).toEqual(['daemon_required', 'ledger_not_owner', 'turn_ledger_unavailable'])
    })

    it('isTurnIpcError accepts a bare code and a code+detail, rejects an unknown code or extra key', () => {
        expect(isTurnIpcError({ code: 'daemon_required' })).toBe(true)
        expect(isTurnIpcError({ code: 'daemon_required', detail: 'no ipc transport' })).toBe(true)
        expect(isTurnIpcError({ code: 'no_such_code' })).toBe(false)
        expect(isTurnIpcError({ code: 'daemon_required', message: 'sneaked in' })).toBe(false)
        expect(isTurnIpcError(null)).toBe(false)
    })
})

describe('turn_observe — round trip + rejection', () => {
    it('decodes a valid request built from a real TurnEvidence', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, evidence }
        expect(decodeTurnObserveRequest(req)).toEqual(req)
    })

    it('rejects a wrong protocol version', () => {
        expect(decodeTurnObserveRequest({ v: 2, evidence })).toBeNull()
    })

    it('rejects evidence carrying an undeclared field (where free text could hide)', () => {
        const tampered = { v: TURN_IPC_PROTOCOL_VERSION, evidence: { ...evidence, summary: 'the agent said hello' } }
        expect(decodeTurnObserveRequest(tampered)).toBeNull()
    })

    it('decodes a response', () => {
        const res = { verdict: 'applied', attemptRef: { attemptId: 'a1', generation: 0 }, outcome: 'completed' }
        expect(decodeTurnObserveResponse(res)).toEqual(res)
        expect(decodeTurnObserveResponse({ verdict: 'bogus', attemptRef: { attemptId: 'a1', generation: 0 } })).toBeNull()
    })
})

describe('mesh_record — allow-list parity with daemon-core PROJECTED_PAYLOAD_KEYS', () => {
    // Structural pin: oss/packages/daemon-core/src/seqscribe/mesh-event-projection.ts
    // PROJECTED_PAYLOAD_KEYS, re-counted 2026-09-23 (34 keys; the C-W6 brief's "35
    // keys" is off by one — verified by direct read of the source array).
    const DAEMON_CORE_PROJECTED_PAYLOAD_KEYS = [
        'taskId', 'deliveryId', 'attemptId', 'missionId', 'checkpointId', 'promptId', 'providerSessionId', 'targetNoteId',
        'nodeId', 'sessionId', 'providerType', 'transport', 'attemptedSessionId', 'holderSessionId',
        'reason', 'status', 'outcome', 'terminalKind', 'event',
        'source', 'intentionalStopReason',
        'retryable', 'rebound', 'forced', 'fallback', 'membershipRemoved', 'requestedForce', 'removedByRemoteDaemon',
        'completedViaReady', 'intentional', 'weak',
        'attempt', 'attemptCount', 'count',
    ]

    it('MESH_RECORD_PAYLOAD_KEYS is exactly 34 keys, matching daemon-core (same set, same order)', () => {
        expect(MESH_RECORD_PAYLOAD_KEYS).toHaveLength(34)
        expect([...MESH_RECORD_PAYLOAD_KEYS]).toEqual(DAEMON_CORE_PROJECTED_PAYLOAD_KEYS)
    })

    it('isMeshRecordPayload accepts an allow-listed scalar payload', () => {
        expect(isMeshRecordPayload({ taskId: 't1', status: 'completed', attemptCount: 2, forced: true, terminalKind: null })).toBe(true)
    })

    it('isMeshRecordPayload rejects a key outside the allow-list (the content-boundary check)', () => {
        expect(isMeshRecordPayload({ taskId: 't1', summary: 'free text sentinel' })).toBe(false)
        expect(isMeshRecordPayload({ workerResult: 'free text sentinel' })).toBe(false)
    })

    it('isMeshRecordPayload rejects a nested object or array value', () => {
        expect(isMeshRecordPayload({ taskId: { nested: true } })).toBe(false)
        expect(isMeshRecordPayload({ taskId: ['a', 'b'] })).toBe(false)
    })

    it('isMeshRecordPayload rejects a string longer than MAX_MESH_RECORD_STRING (prose backstop)', () => {
        expect(isMeshRecordPayload({ reason: 'x'.repeat(MAX_MESH_RECORD_STRING) })).toBe(true)
        expect(isMeshRecordPayload({ reason: 'x'.repeat(MAX_MESH_RECORD_STRING + 1) })).toBe(false)
    })

    it('decodes a full mesh_record request and rejects an unknown top-level key', () => {
        const req = {
            v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', ledgerKind: 'task_completed',
            taskId: 't1', payload: { taskId: 't1', outcome: 'completed' },
        }
        expect(decodeMeshRecordRequest(req)).toEqual(req)
        expect(decodeMeshRecordRequest({ ...req, extra: 'nope' })).toBeNull()
    })

    it('decodes a mesh_record response', () => {
        expect(decodeMeshRecordResponse({ eventId: 'ev-9', seq: 42 })).toEqual({ eventId: 'ev-9', seq: 42 })
        expect(decodeMeshRecordResponse({ eventId: 'ev-9', seq: -1 })).toBeNull()
    })
})

describe('turn_cancel — exactly one of attemptId/taskId', () => {
    it('accepts attemptId alone', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, attemptId: 'a1', reason: 'operator_cancel' }
        expect(decodeTurnCancelRequest(req)).toEqual(req)
    })

    it('accepts taskId alone', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, taskId: 't1', reason: 'operator_cancel' }
        expect(decodeTurnCancelRequest(req)).toEqual(req)
    })

    it('rejects neither present', () => {
        expect(decodeTurnCancelRequest({ v: TURN_IPC_PROTOCOL_VERSION, reason: 'operator_cancel' })).toBeNull()
    })

    it('rejects both present', () => {
        expect(decodeTurnCancelRequest({ v: TURN_IPC_PROTOCOL_VERSION, attemptId: 'a1', taskId: 't1', reason: 'operator_cancel' })).toBeNull()
    })

    it('rejects a non-closed reason', () => {
        expect(decodeTurnCancelRequest({ v: TURN_IPC_PROTOCOL_VERSION, attemptId: 'a1', reason: 'because I said so' })).toBeNull()
    })

    it('decodes a response', () => {
        const res = { attemptRef: { attemptId: 'a1', generation: 1 }, verdict: 'applied' }
        expect(decodeTurnCancelResponse(res)).toEqual(res)
    })
})

describe('operator_status', () => {
    it('decodes a valid request', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, taskId: 't1', status: 'completed', reason: 'refine_terminal' }
        expect(decodeOperatorStatusRequest(req)).toEqual(req)
    })

    it('rejects a MeshTaskStatus value like "pending"/"assigned" (not a member of the 2-value operator verdict)', () => {
        expect(decodeOperatorStatusRequest({ v: TURN_IPC_PROTOCOL_VERSION, taskId: 't1', status: 'pending', reason: 'refine_terminal' })).toBeNull()
        expect(decodeOperatorStatusRequest({ v: TURN_IPC_PROTOCOL_VERSION, taskId: 't1', status: 'assigned', reason: 'refine_terminal' })).toBeNull()
    })

    it('decodes the fire-and-forget acknowledgement response', () => {
        expect(decodeOperatorStatusResponse({ accepted: true })).toEqual({ accepted: true })
        expect(decodeOperatorStatusResponse({ accepted: false })).toBeNull()
    })
})

describe('turn_query', () => {
    it('decodes a minimal request (meshId only)', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1' }
        expect(decodeTurnQueryRequest(req)).toEqual(req)
    })

    it('decodes a fully-filtered request', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', taskId: 't1', attemptId: 'a1', sessionId: 's1', state: 'generating', since: 1000, tail: 50 }
        expect(decodeTurnQueryRequest(req)).toEqual(req)
    })

    it('decodes a response with attempt and event rows, no payload_json content leaks through the type', () => {
        const res = {
            attempts: [{ attemptId: 'a1', generation: 0, sessionId: 's1', state: 'generating', acceptedAt: 1000 }],
            events: [{ eventId: 'ev-1', sessionId: 's1', kind: 'turn_started', source: 'fsm_edge', verdict: 'applied', atMs: 1000 }],
        }
        expect(decodeTurnQueryResponse(res)).toEqual(res)
    })

    it('accepts an explicit replicationPending flag (C7-5 freshness passthrough)', () => {
        const res = { attempts: [], events: [], replicationPending: true }
        expect(decodeTurnQueryResponse(res)).toEqual(res)
    })

    it('rejects an event row carrying a payload_json-shaped extra field', () => {
        const res = {
            attempts: [],
            events: [{ eventId: 'ev-1', sessionId: 's1', kind: 'turn_started', source: 'fsm_edge', verdict: 'applied', atMs: 1000, payload: { summary: 'leak' } }],
        }
        expect(decodeTurnQueryResponse(res)).toBeNull()
    })
})

describe('mesh_index_query', () => {
    it('decodes a request with writer scope', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', writer: 'fleet' as const }
        expect(decodeMeshIndexQueryRequest(req)).toEqual(req)
    })

    it('rejects an unknown writer scope', () => {
        expect(decodeMeshIndexQueryRequest({ v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', writer: 'everyone' })).toBeNull()
    })

    it('decodes a response whose rows carry an allow-listed payload only', () => {
        const res = {
            rows: [{ writer: 'w1', seq: 1, meshId: 'm1', eventId: 'ev-1', kind: 'adhdev.mesh.ledger', atMs: 1000, payload: { taskId: 't1' } }],
        }
        expect(decodeMeshIndexQueryResponse(res)).toEqual(res)
    })

    it('rejects a row whose payload carries a non-scalar value (content-boundary sentinel)', () => {
        const res = {
            rows: [{ writer: 'w1', seq: 1, meshId: 'm1', eventId: 'ev-1', kind: 'adhdev.mesh.ledger', atMs: 1000, payload: { note: { text: 'sentinel free text' } } }],
        }
        expect(decodeMeshIndexQueryResponse(res)).toBeNull()
    })
})

// mission_upsert / mission_query (added 2026-09-23 — see the file's section
// header comment above their definitions for why free text is fine here,
// unlike every other command in this file).
describe('mission_upsert', () => {
    it('decodes a create request (no id)', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 'Ship C-W6', goal: 'Move MCP off direct DB access' }
        expect(decodeMissionUpsertRequest(req)).toEqual(req)
    })

    it('decodes an update request (id present)', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', id: 'mission-1', title: 'Ship C-W6', status: 'active' as const }
        expect(decodeMissionUpsertRequest(req)).toEqual(req)
    })

    it('rejects an empty/whitespace-only title', () => {
        expect(decodeMissionUpsertRequest({ v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: '' })).toBeNull()
        expect(decodeMissionUpsertRequest({ v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: '   ' })).toBeNull()
    })

    it('rejects an unknown status value', () => {
        expect(decodeMissionUpsertRequest({ v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 't', status: 'in_progress' })).toBeNull()
    })

    it('rejects an unknown source value', () => {
        expect(decodeMissionUpsertRequest({ v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 't', source: 'user' })).toBeNull()
    })

    it('decodes the response, round-tripping a long free-text goal (local IPC, not the mesh_record boundary)', () => {
        const longGoal = 'x'.repeat(500) // over MAX_MESH_RECORD_STRING on purpose — this command is NOT scalar-length-bounded
        const res = { mission: { id: 'mission-1', meshId: 'm1', title: 't', goal: longGoal, status: 'active' as const } }
        expect(decodeMissionUpsertResponse(res)).toEqual(res)
    })

    it('rejects a response mission missing a required field', () => {
        expect(decodeMissionUpsertResponse({ mission: { id: 'mission-1', meshId: 'm1', title: 't', status: 'active' } })).toBeNull()
    })
})

describe('mission_query', () => {
    it('decodes a request with no filters (every status)', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1' }
        expect(decodeMissionQueryRequest(req)).toEqual(req)
    })

    it('decodes a request filtered by statuses', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', statuses: ['active', 'paused'] as const }
        expect(decodeMissionQueryRequest(req)).toEqual(req)
    })

    it('decodes a single-mission lookup by id', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', id: 'mission-1' }
        expect(decodeMissionQueryRequest(req)).toEqual(req)
    })

    it('rejects an empty statuses array (meaningless filter, likely a caller bug)', () => {
        expect(decodeMissionQueryRequest({ v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', statuses: [] })).toBeNull()
    })

    it('decodes a response with multiple missions', () => {
        const res = {
            missions: [
                { id: 'mission-1', meshId: 'm1', title: 't1', goal: '', status: 'active' as const },
                { id: 'mission-2', meshId: 'm1', title: 't2', goal: 'g2', status: 'completed' as const, source: 'magi' as const },
            ],
        }
        expect(decodeMissionQueryResponse(res)).toEqual(res)
    })
})

describe('content-boundary sentinel — a "summary" field is rejected everywhere a request/response accepts an object', () => {
    const SENTINEL = '__CONTENT_BOUNDARY_SENTINEL__ this looks like a chat message'

    it('turn_observe: evidence with a bare summary string field is rejected (must be a SummaryRef)', () => {
        const tampered = { v: TURN_IPC_PROTOCOL_VERSION, evidence: { ...evidence, kind: 'turn_end', strength: 'genuine', summary: SENTINEL } }
        expect(decodeTurnObserveRequest(tampered)).toBeNull()
    })

    it('mesh_record: a sentinel-valued unknown key is rejected by the payload allow-list', () => {
        expect(isMeshRecordPayload({ progressNote: SENTINEL })).toBe(false)
    })
})
