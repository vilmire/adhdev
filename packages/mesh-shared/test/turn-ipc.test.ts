import { describe, expect, it } from 'vitest'
import {
    MAX_MESH_RECORD_STRING,
    MESH_RECORD_PAYLOAD_KEYS,
    TURN_IPC_COMMANDS,
    decodeNoteForgetRequest,
    decodeNoteForgetResponse,
    decodeNoteUpsertRequest,
    decodeNoteUpsertResponse,
    TURN_IPC_ERROR_CODES,
    TURN_IPC_PROTOCOL_VERSION,
    decodeLedgerQueryRequest,
    decodeLedgerQueryResponse,
    decodeMeshIndexQueryRequest,
    decodeMeshIndexQueryResponse,
    decodeMeshRecordRequest,
    decodeMeshRecordResponse,
    decodeMissionListQueryRequest,
    decodeMissionListQueryResponse,
    decodeMissionQueryRequest,
    decodeMissionQueryResponse,
    decodeMissionUpsertRequest,
    decodeMissionUpsertResponse,
    decodeOperatorStatusRequest,
    decodeOperatorStatusResponse,
    decodeToolCallRecordRequest,
    decodeToolCallRecordResponse,
    decodeTurnCancelRequest,
    decodeTurnCancelResponse,
    decodeTurnObserveRequest,
    decodeTurnObserveResponse,
    decodeTurnQueryRequest,
    decodeTurnQueryResponse,
    isMeshRecordPayload,
    isTurnIpcCommand,
    isTurnIpcError,
    decodeRecordLocalRequest,
    decodeRecordLocalResponse,
    decodeQueueQueryRequest,
    decodeQueueQueryResponse,
    decodeQueueEnqueueRequest,
    decodeQueueEnqueueResponse,
    decodeQueueEnqueueGraphRequest,
    decodeQueueEnqueueGraphResponse,
    decodeQueueCancelRequest,
    decodeQueueCancelResponse,
    decodeQueueRequeueRequest,
    decodeQueueRequeueResponse,
    decodeDirectDispatchRecordRequest,
    decodeDirectDispatchRecordResponse,
    decodeGraphAuditRecordRequest,
    decodeGraphAuditRecordResponse,
    decodeActiveWorkQueryRequest,
    decodeActiveWorkQueryResponse,
    decodeGraphGateAbandonRequest,
    decodeGraphGateAbandonResponse,
    decodeGraphGateClaimRequest,
    decodeGraphGateClaimResponse,
    decodeGraphGateReleaseRequest,
    decodeGraphGateReleaseResponse,
    decodeGraphNodePatchRequest,
    decodeGraphNodePatchResponse,
    decodeGraphViewQueryRequest,
    decodeGraphViewQueryResponse,
    decodeOrphanedPinNotifyRequest,
    decodeOrphanedPinNotifyResponse,
    decodePruneStaleDirectRequest,
    decodePruneStaleDirectResponse,
    decodeTaskStatsQueryRequest,
    decodeTaskStatsQueryResponse,
    decodeRecoveryContextQueryRequest,
    decodeRecoveryContextQueryResponse,
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
    // C-W8: note_upsert/note_forget added per the 2026-09-24 C-W6b decision —
    // operating-note text is free text like a mission goal (local IPC only).
    // C-W9b (2026-09-24 14:00 stamp "C-W9"): tool_call_record/ledger_query/
    // mission_list_query added — the remaining in-process daemon-core calls
    // this workstream closes (rate-limit counter, general ledger browse,
    // widened mission-list projection). Ten became thirteen.
    // C-W9a: the event ledger retired and the mcp-server's remaining in-process
    // store access (record appends, queue mutations/reads, active work, recovery
    // hints) moved behind ten more commands. Thirteen became twenty-three.
    // C-W9c (2026-09-24 19:00 stamp): the last mcp-server in-process daemon-core
    // paths — graph gates/plan/patch, mission reads (MAGI), task/mission stats,
    // orphaned-pin helpers, one prune audit — moved behind eight more commands.
    // Twenty-three became thirty-one.
    it('declares exactly thirty-one commands', () => {
        expect(TURN_IPC_COMMANDS).toHaveLength(31)
        expect([...TURN_IPC_COMMANDS].sort()).toEqual([
            'active_work_query', 'direct_dispatch_record', 'graph_audit_record',
            'graph_gate_abandon', 'graph_gate_claim', 'graph_gate_release', 'graph_node_patch', 'graph_view_query',
            'ledger_query', 'mesh_index_query', 'mesh_record', 'mission_list_query', 'mission_query', 'mission_upsert',
            'note_forget', 'note_upsert', 'operator_status', 'orphaned_pin_notify',
            'prune_stale_direct',
            'queue_cancel', 'queue_enqueue', 'queue_enqueue_graph', 'queue_query', 'queue_requeue',
            'record_local', 'recovery_context_query', 'task_stats_query',
            'tool_call_record', 'turn_cancel', 'turn_observe', 'turn_query',
        ])
    })

    it('isTurnIpcCommand accepts only the thirty-one names', () => {
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

    // H2 (mission brief, wiring-unification Phase H — docs/design/2026-09-23-
    // wiring-unification.md §7c).
    describe('brief (H2)', () => {
        it('decodes a request carrying a full brief object', () => {
            const req = {
                v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 't',
                brief: {
                    goal: 'land it',
                    constraints: ['no npm install'],
                    doneCriteria: ['tests green'],
                    handoffNotes: ['see design doc'],
                    ownedPaths: ['src/mesh/**'],
                },
            }
            expect(decodeMissionUpsertRequest(req)).toEqual(req)
        })

        it('decodes a request carrying brief: null (explicit clear)', () => {
            const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', id: 'mission-1', title: 't', brief: null }
            expect(decodeMissionUpsertRequest(req)).toEqual(req)
        })

        it('omitting brief entirely still decodes (preserve semantics live in the daemon handler, not this guard)', () => {
            const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 't' }
            expect(decodeMissionUpsertRequest(req)).toEqual(req)
        })

        it('rejects a brief object with no goal', () => {
            const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 't', brief: { constraints: ['x'] } }
            expect(decodeMissionUpsertRequest(req)).toBeNull()
        })

        it('rejects a brief object with a non-string-array field', () => {
            const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 't', brief: { goal: 'g', constraints: [1, 2] } }
            expect(decodeMissionUpsertRequest(req)).toBeNull()
        })

        it('rejects a brief object with an unknown key', () => {
            const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', title: 't', brief: { goal: 'g', extra: 'nope' } }
            expect(decodeMissionUpsertRequest(req)).toBeNull()
        })

        it('round-trips a response mission carrying a brief', () => {
            const res = {
                mission: {
                    id: 'mission-1', meshId: 'm1', title: 't', goal: '', status: 'active' as const,
                    brief: { goal: 'land it', ownedPaths: ['src/**'] },
                },
            }
            expect(decodeMissionUpsertResponse(res)).toEqual(res)
        })

        it('a response mission with no brief still decodes (brief optional)', () => {
            const res = { mission: { id: 'mission-1', meshId: 'm1', title: 't', goal: '', status: 'active' as const } }
            expect(decodeMissionUpsertResponse(res)).toEqual(res)
        })
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

describe('turn-ipc — note_upsert / note_forget (C-W8)', () => {
    it('accepts a full note and refuses unknown keys, an empty text or a bad category', () => {
        const ok = { v: 1, meshId: 'm1', text: 'lesson', category: 'recovery_lesson', pinned: true, expiresAt: '2026-10-01T00:00:00.000Z', subjectKey: 'k', sourceCoordinator: 'coord' }
        expect(decodeNoteUpsertRequest(ok)).toEqual(ok)
        expect(decodeNoteUpsertRequest({ ...ok, extra: 1 })).toBeNull()
        expect(decodeNoteUpsertRequest({ ...ok, text: '   ' })).toBeNull()
        expect(decodeNoteUpsertRequest({ ...ok, category: 'gossip' })).toBeNull()
        expect(decodeNoteUpsertRequest({ ...ok, expiresAt: 'not-a-date' })).toBeNull()
        expect(decodeNoteUpsertResponse({ noteId: 'n1', deduped: false, createdAt: 'x' })).not.toBeNull()
    })

    it('a forget needs a noteId or a text target', () => {
        expect(decodeNoteForgetRequest({ v: 1, meshId: 'm1', noteId: 'n1' })).not.toBeNull()
        expect(decodeNoteForgetRequest({ v: 1, meshId: 'm1', text: 'lesson', reason: 'obsolete' })).not.toBeNull()
        expect(decodeNoteForgetRequest({ v: 1, meshId: 'm1' })).toBeNull()
        expect(decodeNoteForgetResponse({ matched: 2, tombstoneId: 't1' })).not.toBeNull()
        expect(decodeNoteForgetResponse({ matched: -1, tombstoneId: 't1' })).toBeNull()
    })
})

describe('turn-ipc — tool_call_record (C-W9b)', () => {
    it('decodes a request and rejects an unknown callerRole', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', tool: 'mesh_status', sessionId: 's1', callerRole: 'coordinator' as const }
        expect(decodeToolCallRecordRequest(req)).toEqual(req)
        expect(decodeToolCallRecordRequest({ ...req, callerRole: 'worker' })).toBeNull()
    })

    it('decodes a request with no sessionId (unknown caller)', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', tool: 'mesh_status', callerRole: 'unknown' as const }
        expect(decodeToolCallRecordRequest(req)).toEqual(req)
    })

    it('decodes the response and rejects a negative callsInWindow', () => {
        expect(decodeToolCallRecordResponse({ rateLimitExceeded: false, callsInWindow: 0, advisory: null })).not.toBeNull()
        expect(decodeToolCallRecordResponse({ rateLimitExceeded: true, callsInWindow: -1, advisory: null })).toBeNull()
    })
})

describe('turn-ipc — ledger_query (C-W9b)', () => {
    it('decodes a request with kind/since/node/tail filters', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', kind: ['task_dispatched', 'task_failed'], since: '2026-09-24T00:00:00.000Z', node: 'mach_alpha', tail: 50, includeSummary: true }
        expect(decodeLedgerQueryRequest(req)).toEqual(req)
    })

    it('rejects an empty kind array (meaningless filter)', () => {
        expect(decodeLedgerQueryRequest({ v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', kind: [] })).toBeNull()
    })

    it('decodes a response entry with an unbounded JSON payload (local IPC, not the mesh_record boundary)', () => {
        const res = {
            entries: [{
                id: 'e1', meshId: 'm1', timestamp: '2026-09-24T00:00:00.000Z', kind: 'magi_synthesis',
                payload: { nested: { deep: ['anything', 1, true, null] }, question: 'x'.repeat(500) },
            }],
        }
        expect(decodeLedgerQueryResponse(res)).toEqual(res)
    })

    it('decodes a response with the optional summary attached', () => {
        const res = {
            entries: [],
            summary: {
                meshId: 'm1', totalEntries: 0, taskDispatched: 0, taskCompleted: 0, taskFailed: 0, taskStalled: 0,
                sessionLaunched: 0, checkpointCreated: 0, lastActivityAt: null, recentFailures: 0,
            },
        }
        expect(decodeLedgerQueryResponse(res)).toEqual(res)
    })

    it('rejects an entry missing a required field', () => {
        expect(decodeLedgerQueryResponse({ entries: [{ id: 'e1', meshId: 'm1', kind: 'x', payload: {} }] })).toBeNull()
    })
})

describe('turn-ipc — mission_list_query (C-W9b)', () => {
    it('decodes a request with every option', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', statuses: ['active'] as const, verbose: true, includeMagi: true, withStats: true, limit: 10, historyIdLimit: 5 }
        expect(decodeMissionListQueryRequest(req)).toEqual(req)
    })

    it('decodes a verbose (full-goal) mission row', () => {
        const res = {
            missions: [{
                id: 'mission-1', meshId: 'm1', title: 't', goal: 'the goal',
                status: 'active' as const,
                tasks: { total: 1, pending: 1, assigned: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null },
            }],
            historyFold: null, truncated: false, matched: 1,
        }
        expect(decodeMissionListQueryResponse(res)).toEqual(res)
    })

    it('decodes a compact (goalPreview) mission row with stats and a history fold', () => {
        const res = {
            missions: [{
                id: 'mission-1', meshId: 'm1', title: 't', goalPreview: 'preview', goalTruncated: true,
                status: 'completed' as const, source: 'magi' as const,
                tasks: { total: 2, pending: 0, assigned: 0, completed: 2, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: '2026-09-24T00:00:00.000Z' },
                stats: { missionId: 'mission-1', taskCount: 2, completed: 2, failed: 0, totalDurationMs: 1000, wallClockMs: 500, retries: 0, incompleteTaskIds: [] },
            }],
            historyFold: { count: 3, byStatus: { completed: 2, abandoned: 1 }, missionIds: ['m1', 'm2'], note: 'folded' },
            truncated: true, matched: 30, overflowIds: ['m3'],
        }
        expect(decodeMissionListQueryResponse(res)).toEqual(res)
    })

    it('rejects a mission row carrying BOTH goal and goalPreview (exactly one shape)', () => {
        const bad = {
            missions: [{
                id: 'mission-1', meshId: 'm1', title: 't', goal: 'g', goalPreview: 'p', goalTruncated: false,
                status: 'active' as const,
                tasks: { total: 0, pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null },
            }],
            historyFold: null, truncated: false, matched: 1,
        }
        expect(decodeMissionListQueryResponse(bad)).toBeNull()
    })

    // H2 (mission brief): mesh_mission_list echoes the stored brief back too.
    it('decodes a mission row carrying a brief (H2)', () => {
        const res = {
            missions: [{
                id: 'mission-1', meshId: 'm1', title: 't', goal: 'the goal',
                status: 'active' as const,
                tasks: { total: 1, pending: 1, assigned: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null },
                brief: { goal: 'land it', doneCriteria: ['tests green'] },
            }],
            historyFold: null, truncated: false, matched: 1,
        }
        expect(decodeMissionListQueryResponse(res)).toEqual(res)
    })
})

describe('turn-ipc — C-W9a record / queue / active-work commands', () => {
    const v = TURN_IPC_PROTOCOL_VERSION
    const row = { id: 't-1', status: 'pending', message: 'free text is local IPC' }

    it('record_local: nested free-form payload accepted; kind must be an identifier; extra keys rejected', () => {
        expect(decodeRecordLocalRequest({ v, meshId: 'm', kind: 'magi_synthesis', payload: { synthesis: { verdict: 'agree', notes: ['x y'] } } })).not.toBeNull()
        expect(decodeRecordLocalRequest({ v, meshId: 'm', kind: 'has space', payload: {} })).toBeNull()
        expect(decodeRecordLocalRequest({ v, meshId: 'm', kind: 'k', payload: [] })).toBeNull()
        expect(decodeRecordLocalRequest({ v, meshId: 'm', kind: 'k', payload: {}, summary: 'x' })).toBeNull()
        expect(decodeRecordLocalResponse({ eventId: 'e', timestamp: 'T', storedLocally: true, published: false })).not.toBeNull()
        expect(decodeRecordLocalResponse({ eventId: 'e', timestamp: 'T', storedLocally: true })).toBeNull()
    })

    it('queue_query / queue_enqueue / queue_cancel / queue_requeue round-trip their shapes', () => {
        expect(decodeQueueQueryRequest({ v, meshId: 'm', statuses: ['pending', 'assigned'], view: true })).not.toBeNull()
        expect(decodeQueueQueryRequest({ v, meshId: 'm', statuses: ['has space'] })).toBeNull()
        expect(decodeQueueQueryResponse({ entries: [row] })).not.toBeNull()
        expect(decodeQueueQueryResponse({ entries: [{ status: 'pending' }] })).toBeNull()
        expect(decodeQueueEnqueueRequest({ v, meshId: 'm', message: 'do it', options: { difficulty: 'easy' }, decision: { decision: { decision: 'single' } } })).not.toBeNull()
        expect(decodeQueueEnqueueRequest({ v, meshId: 'm' })).toBeNull()
        expect(decodeQueueEnqueueResponse({ entry: row })).not.toBeNull()
        expect(decodeQueueCancelRequest({ v, meshId: 'm', taskId: 't-1', reason: 'no longer needed' })).not.toBeNull()
        expect(decodeQueueCancelResponse({ task: row, before: row })).not.toBeNull()
        expect(decodeQueueCancelResponse({ task: null, before: null })).not.toBeNull()
        expect(decodeQueueCancelResponse({ task: null })).toBeNull()
        expect(decodeQueueRequeueRequest({ v, meshId: 'm', taskId: 't-1', options: { force: true } })).not.toBeNull()
        expect(decodeQueueRequeueResponse({ task: null })).not.toBeNull()
    })

    it('queue_enqueue_graph: mode picks exactly one of specs / plan; the response is ok|refusal', () => {
        expect(decodeQueueEnqueueGraphRequest({ v, meshId: 'm', mode: 'compat', specs: [{ message: 'a' }] })).not.toBeNull()
        expect(decodeQueueEnqueueGraphRequest({ v, meshId: 'm', mode: 'graph', plan: { tasks: [] }, audit: { batchId: 'b' } })).not.toBeNull()
        expect(decodeQueueEnqueueGraphRequest({ v, meshId: 'm', mode: 'graph', specs: [] })).toBeNull()
        expect(decodeQueueEnqueueGraphRequest({ v, meshId: 'm', mode: 'other', specs: [] })).toBeNull()
        expect(decodeQueueEnqueueGraphResponse({ ok: true, tasks: [row], graph: { graphId: 'g' } })).not.toBeNull()
        expect(decodeQueueEnqueueGraphResponse({ ok: false, refusalCode: 'task_graph_too_large', message: 'too big', extra: { limit: 50 } })).not.toBeNull()
        expect(decodeQueueEnqueueGraphResponse({ ok: false })).toBeNull()
        // `code` / `error` are the command ENVELOPE's keys — a refusal result must not reuse them.
        expect(decodeQueueEnqueueGraphResponse({ ok: false, code: 'x', error: 'y' })).toBeNull()
    })

    it('direct_dispatch_record / graph_audit_record', () => {
        expect(decodeDirectDispatchRecordRequest({ v, meshId: 'm', taskId: 't', message: 'msg', task: { assignedNodeId: 'n' }, decision: { via: 'local_direct' } })).not.toBeNull()
        expect(decodeDirectDispatchRecordResponse({ taskRecorded: true, decisionRecorded: false })).not.toBeNull()
        expect(decodeGraphAuditRecordRequest({ v, meshId: 'm', event: 'gate_claimed', fields: { graphId: 'g' } })).not.toBeNull()
        expect(decodeGraphAuditRecordRequest({ v, meshId: 'm', event: 'gate_exploded', fields: {} })).toBeNull()
        expect(decodeGraphAuditRecordResponse({ recorded: true })).not.toBeNull()
    })

    it('active_work_query: the scheduling runtime needs a mesh snapshot; response parts are all optional records', () => {
        expect(decodeActiveWorkQueryRequest({ v, meshId: 'm', nodes: [{ id: 'n' }], includeInputs: true, recordTail: 200 })).not.toBeNull()
        expect(decodeActiveWorkQueryRequest({ v, meshId: 'm', includeSchedulingRuntime: true })).toBeNull()
        expect(decodeActiveWorkQueryRequest({ v, meshId: 'm', includeSchedulingRuntime: true, mesh: { id: 'm', nodes: [] } })).not.toBeNull()
        expect(decodeActiveWorkQueryRequest({ v, meshId: 'm', nodes: 'x' })).toBeNull()
        expect(decodeActiveWorkQueryResponse({ activeWork: { activeWork: [] }, records: [], directDispatches: [], summary: { totalEntries: 0 } })).not.toBeNull()
        expect(decodeActiveWorkQueryResponse({ records: {} })).toBeNull()
    })

    it('recovery_context_query needs a node or a session', () => {
        expect(decodeRecoveryContextQueryRequest({ v, meshId: 'm', nodeId: 'n' })).not.toBeNull()
        expect(decodeRecoveryContextQueryRequest({ v, meshId: 'm' })).toBeNull()
        expect(decodeRecoveryContextQueryResponse({ context: { consecutiveNodeFailures: 0, advice: 'free text' } })).not.toBeNull()
        expect(decodeRecoveryContextQueryResponse({ context: {} })).toBeNull()
    })
})

describe('turn-ipc — C-W9c graph gate/plan/patch/view, task stats, prune, orphaned-pin commands', () => {
    const v = TURN_IPC_PROTOCOL_VERSION
    const gateRow = { gateId: 'g-1', graphId: 'graph-1', state: 'claimed', action: 'approve' }

    it('graph_gate_claim: coordinatorSessionId required; gate is a JSON passthrough', () => {
        expect(decodeGraphGateClaimRequest({ v, meshId: 'm', gateId: 'g-1', coordinatorSessionId: 's-1', probeConvergenceEvidence: true })).not.toBeNull()
        expect(decodeGraphGateClaimRequest({ v, meshId: 'm', gateId: 'g-1' })).toBeNull()
        expect(decodeGraphGateClaimResponse({ claimed: false, reason: 'gate_lease_held', gate: gateRow })).not.toBeNull()
        expect(decodeGraphGateClaimResponse({
            claimed: true, gate: gateRow, leaseGeneration: 1, fencingToken: 'tok', leaseExpiresAt: 'T',
            convergenceEvidence: { landed: false },
        })).not.toBeNull()
        expect(decodeGraphGateClaimResponse({ claimed: 'yes' })).toBeNull()
    })

    it('graph_gate_release: a thrown domain refusal is a RESULT, not an envelope error', () => {
        expect(decodeGraphGateReleaseRequest({
            v, meshId: 'm', gateId: 'g-1', fencingToken: 'tok', leaseGeneration: 1, idempotencyKey: 'k', outcome: 'passed',
            patches: [{ node: 'n-1', baseSpecPatch: { run_if: true } }],
        })).not.toBeNull()
        expect(decodeGraphGateReleaseRequest({ v, meshId: 'm', gateId: 'g-1', fencingToken: '', leaseGeneration: 1, idempotencyKey: 'k', outcome: 'passed' })).toBeNull()
        expect(decodeGraphGateReleaseResponse({ released: true, duplicate: false, gate: gateRow, materializedNodeIds: ['n-1'], downstreamNodeCount: 1, graphCompleted: false })).not.toBeNull()
        expect(decodeGraphGateReleaseResponse({ released: false, refusalCode: 'gate_lease_expired', message: 'gate_lease_expired: stale' })).not.toBeNull()
        // `code` / `error` are the command ENVELOPE's keys — a refusal result must not reuse them.
        expect(decodeGraphGateReleaseResponse({ released: false, code: 'x', error: 'y' })).toBeNull()
    })

    it('graph_gate_abandon: reason required; a duplicate (already-abandoned) reply is still success', () => {
        expect(decodeGraphGateAbandonRequest({ v, meshId: 'm', gateId: 'g-1', reason: 'cancelled upstream', force: true })).not.toBeNull()
        expect(decodeGraphGateAbandonRequest({ v, meshId: 'm', gateId: 'g-1', reason: '' })).toBeNull()
        expect(decodeGraphGateAbandonResponse({
            abandoned: true, gate: gateRow, cancelledNodeIds: ['n-1'], cancelledTaskIds: ['t-1'], graphStatus: 'cancelled',
        })).not.toBeNull()
        expect(decodeGraphGateAbandonResponse({ abandoned: false, reason: 'gate_lease_held', cancelledNodeIds: [], cancelledTaskIds: [] })).not.toBeNull()
    })

    it('graph_node_patch: base_spec_patch must be non-empty; a thrown refusal is a RESULT', () => {
        expect(decodeGraphNodePatchRequest({ v, meshId: 'm', node: 'n-1', graphId: 'g-1', baseSpecPatch: { run_if: false } })).not.toBeNull()
        expect(decodeGraphNodePatchRequest({ v, meshId: 'm', node: 'n-1', baseSpecPatch: {} })).toBeNull()
        expect(decodeGraphNodePatchResponse({
            patched: true, graphId: 'g-1', nodeId: 'n-1', materializationVersion: 2, state: 'materialized', outcomeKind: 'materialized',
        })).not.toBeNull()
        expect(decodeGraphNodePatchResponse({ patched: false, refusalCode: 'node_patch_forbidden', message: 'node_patch_forbidden: x' })).not.toBeNull()
    })

    it('graph_view_query: graphs is a JSON-passthrough array', () => {
        expect(decodeGraphViewQueryRequest({ v, meshId: 'm', activeOnly: false, probeGateEvidence: true, limit: 5 })).not.toBeNull()
        expect(decodeGraphViewQueryResponse({ graphs: [{ graphId: 'g-1', gates: [gateRow] }] })).not.toBeNull()
        expect(decodeGraphViewQueryResponse({ graphs: 'x' })).toBeNull()
    })

    it('task_stats_query: rollup requires missionId; tasks/mission are JSON passthroughs', () => {
        expect(decodeTaskStatsQueryRequest({ v, meshId: 'm', taskIds: ['t-1', 't-2'] })).not.toBeNull()
        expect(decodeTaskStatsQueryRequest({ v, meshId: 'm', missionId: 'ms-1', rollup: true })).not.toBeNull()
        expect(decodeTaskStatsQueryRequest({ v, meshId: 'm', rollup: true })).toBeNull()
        expect(decodeTaskStatsQueryResponse({ tasks: [{ taskId: 't-1', status: 'completed' }], mission: { missionId: 'ms-1', taskCount: 1 } })).not.toBeNull()
        expect(decodeTaskStatsQueryResponse({ tasks: 'x' })).toBeNull()
    })

    it('prune_stale_direct: execute/includeTerminal/source are all optional', () => {
        expect(decodePruneStaleDirectRequest({ v, meshId: 'm', execute: true, includeTerminal: false, source: 'mesh_prune_stale_direct' })).not.toBeNull()
        expect(decodePruneStaleDirectRequest({ v, meshId: 'm' })).not.toBeNull()
        expect(decodePruneStaleDirectResponse({
            mode: 'dry_run', includeTerminal: false, candidateCount: 2, prunable: [{ taskId: 't-1' }], prunedCount: 0,
            preservedUnacknowledged: [], preservedLedgerOnly: [], preservedNotOrphan: [],
        })).not.toBeNull()
        expect(decodePruneStaleDirectResponse({ mode: 'both' })).toBeNull()
    })

    it('orphaned_pin_notify: title is free text (local IPC), orphans is a typed array', () => {
        expect(decodeOrphanedPinNotifyRequest({ v, meshId: 'm', stoppedSessionId: 's-1', excludeTaskId: 't-1', cause: 'Cancelling task t-1' })).not.toBeNull()
        expect(decodeOrphanedPinNotifyRequest({ v, meshId: 'm' })).toBeNull()
        expect(decodeOrphanedPinNotifyResponse({
            orphans: [{ taskId: 't-2', title: 'free text title', targetSessionId: 's-1', targetNodeId: 'n-1', missionId: 'ms-1' }],
        })).not.toBeNull()
        expect(decodeOrphanedPinNotifyResponse({ orphans: [{ taskId: 't-2' }] })).toBeNull()
    })
})
