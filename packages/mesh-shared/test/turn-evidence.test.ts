import { describe, expect, it } from 'vitest'
import {
    EVIDENCE_ENVELOPE_FIELD_SPECS,
    TURN_EVIDENCE_FIELD_SPECS,
    TURN_EVIDENCE_KINDS,
    isMeshTopicEntry,
    isSummaryRef,
    isTurnEvidence,
    projectTurnEvidenceEntry,
    type EvidenceFieldSpec,
    type TurnEvidence,
} from '../src/turn-evidence'

// Content-boundary contract (design §5 C1/C2): evidence crosses machines, so no
// field may hold user/agent-authored text. Text lives in a content-class topic
// and evidence carries only a SummaryRef pointer to it.

const TEXT_FIELD_NAMES = ['summary', 'text', 'message', 'content', 'note', 'body', 'prompt', 'title', 'detail']
const ALLOWED_CLASSES = new Set(['id', 'enum', 'bool', 'int', 'ms', 'summary_ref', 'attempt_ref', 'live', 'native_marker', 'coordinator'])

function everyField(): Array<{ owner: string; field: string; spec: EvidenceFieldSpec }> {
    const out: Array<{ owner: string; field: string; spec: EvidenceFieldSpec }> = []
    for (const [field, spec] of Object.entries(EVIDENCE_ENVELOPE_FIELD_SPECS)) out.push({ owner: 'envelope', field, spec })
    for (const kind of TURN_EVIDENCE_KINDS) {
        for (const [field, spec] of Object.entries(TURN_EVIDENCE_FIELD_SPECS[kind] as Record<string, EvidenceFieldSpec>)) {
            out.push({ owner: kind, field, spec })
        }
    }
    return out
}

const ref = { topic: 'mesh.m1.handoff', writer: 'w1', seq: 7 }
const envelope = { eventId: 'ev-1', at: 1_000, source: 'fsm_edge', sessionId: 'sess-1', observedBy: 'daemon-1' } as const

describe('turn evidence — content-free by construction', () => {
    it('declares 23 evidence kinds (the §5 C1 union)', () => {
        expect([...TURN_EVIDENCE_KINDS].sort()).toEqual([
            'cancel', 'coordinator_ack', 'delivered', 'delivery_refused', 'dispatch_accepted', 'dispatch_failed',
            'duplicate_dispatch_refusal', 'git_side_effect', 'hold_expired', 'liveness', 'no_progress', 'operator_status',
            'process_exit', 'session_error', 'session_rebound', 'suspension', 'suspension_resolved', 'transcript_activity',
            'transcript_final', 'turn_end', 'turn_started', 'worker_progress', 'worker_report',
        ])
    })

    it('no declared field is named like text unless it is a SummaryRef', () => {
        const offenders = everyField().filter(({ field, spec }) =>
            TEXT_FIELD_NAMES.includes(field) && spec.t !== 'summary_ref')
        expect(offenders).toEqual([])
    })

    it('every declared field has a non-text class', () => {
        const classes = everyField().map(({ owner, field, spec }) => ({ where: `${owner}.${field}`, t: spec.t }))
        expect(classes.filter((c) => !ALLOWED_CLASSES.has(c.t))).toEqual([])
        // Sanity: the walk actually visited fields (guards against an empty registry).
        expect(classes.length).toBeGreaterThan(60)
    })

    it('SummaryRef is a pointer, not text', () => {
        expect(isSummaryRef(ref)).toBe(true)
        expect(isSummaryRef({ ...ref, text: 'hello' })).toBe(false)
        expect(isSummaryRef({ topic: 'mesh.m1.handoff', writer: 'w1' })).toBe(false)
    })
})

describe('isTurnEvidence', () => {
    const report: TurnEvidence = { ...envelope, source: 'worker_tool', kind: 'worker_report', outcome: 'completed', summary: ref, hasHandoffNotes: false }

    it('accepts well-formed evidence', () => {
        expect(isTurnEvidence(report)).toBe(true)
        expect(isTurnEvidence({ ...envelope, kind: 'turn_started', retro: false, attemptRef: { attemptId: 'a1', generation: 0 } })).toBe(true)
        expect(isTurnEvidence({ ...envelope, kind: 'process_exit', exitCode: null })).toBe(true)
    })

    it('rejects an undeclared field (the way free text would be smuggled in)', () => {
        expect(isTurnEvidence({ ...report, summaryText: 'SENTINEL secret text' })).toBe(false)
    })

    it('rejects prose in an identifier slot', () => {
        expect(isTurnEvidence({ ...report, sessionId: 'this is a sentence the agent wrote' })).toBe(false)
    })

    it('rejects an out-of-vocabulary enum and a missing required field', () => {
        expect(isTurnEvidence({ ...envelope, kind: 'cancel', reason: 'because I said so' })).toBe(false)
        expect(isTurnEvidence({ ...envelope, kind: 'turn_started' })).toBe(false)
        expect(isTurnEvidence({ ...envelope, kind: 'nope' })).toBe(false)
    })
})

describe('mesh topic entries', () => {
    it('projects evidence onto a v2 turn.evidence entry that carries no text', () => {
        const ev: TurnEvidence = {
            ...envelope, kind: 'turn_end', strength: 'weak', hollow: true, summary: ref, afterFinalizationTimeout: true,
        }
        const entry = projectTurnEvidenceEntry(ev, { attemptId: 'a1', generation: 2, ownerDaemonId: 'daemon-c' })
        expect(entry).toMatchObject({ v: 2, k: 'turn.evidence', attemptId: 'a1', generation: 2, ev: 'turn_end', strength: 'weak', flags: { hollow: true, afterFinalizationTimeout: true } })
        expect(isMeshTopicEntry(entry)).toBe(true)
    })

    it('validates the four entry kinds and rejects unknown ones', () => {
        const base = { v: 2, eventId: 'e1', at: 5 }
        expect(isMeshTopicEntry({ ...base, k: 'turn.committed', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' })).toBe(true)
        expect(isMeshTopicEntry({ ...base, k: 'turn.notify', notify: 'completed', targetDaemonId: 'd1' })).toBe(true)
        expect(isMeshTopicEntry({ ...base, k: 'mesh.record', ledgerKind: 'node_joined', payload: { count: 1, ok: true } })).toBe(true)
        expect(isMeshTopicEntry({ ...base, k: 'turn.committed', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine', reason: 'free text reason' })).toBe(false)
        expect(isMeshTopicEntry({ ...base, v: 1, k: 'turn.notify', notify: 'completed', targetDaemonId: 'd1' })).toBe(false)
        expect(isMeshTopicEntry({ ...base, k: 'turn.other' })).toBe(false)
    })
})
