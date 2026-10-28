import { describe, expect, it } from 'vitest'
import {
    CARRY_OVER_MISSION_TITLE,
    MISSION_LIMITS,
    boundEventPayload,
    deriveItemDedupeKey,
    isCarryOverMissionTitle,
    isMissionOutcome,
    normalizeDecisionInput,
    normalizeMissionItemInput,
    normalizeMissionItemUpdate,
    normalizeMissionRefs,
    normalizeMissionSummary,
    normalizeOutcomeReason,
    normalizeReportCommits,
    decodeMissionUpsertRequest,
    decodeMissionUpsertResponse,
    decodeMissionListQueryResponse,
    TURN_IPC_PROTOCOL_VERSION,
} from '../src'

describe('mission-items normalization (design 2026-10-28 §4)', () => {
    it('clamps summary to 300 and outcome_reason to 500 without rejecting', () => {
        const s = normalizeMissionSummary('x'.repeat(400))!
        expect(s.value.length).toBe(MISSION_LIMITS.summary)
        expect(s.truncated).toBe(true)
        const r = normalizeOutcomeReason('y'.repeat(900))!
        expect(r.value.length).toBe(MISSION_LIMITS.outcomeReason)
        expect(normalizeMissionSummary(5)).toBeNull()
    })

    it('outcome enum', () => {
        for (const o of ['merged', 'verified_live', 'superseded', 'not_needed', 'owner_abandoned', 'unspecified']) expect(isMissionOutcome(o)).toBe(true)
        expect(isMissionOutcome('done')).toBe(false)
    })

    it('item text is clamped to 300; refs to 8 with the {kind, repo?, value, note?} shape', () => {
        const refs = Array.from({ length: 12 }, (_, i) => ({ kind: 'commit', value: `sha${i}` }))
        const n = normalizeMissionItemInput({ kind: 'remaining', text: 'z'.repeat(500), refs })
        if ('error' in n) throw new Error(n.error)
        expect(n.item.text.length).toBe(MISSION_LIMITS.itemText)
        expect(n.item.refs).toHaveLength(8)
        expect(n.item.truncated).toEqual(expect.arrayContaining(['text', 'refs']))
        // bad ref kinds / empty values are dropped, not errors
        expect(normalizeMissionRefs([{ kind: 'nope', value: 'x' }, { kind: 'url', value: '' }, { kind: 'url', value: 'https://a' }]).refs).toEqual([{ kind: 'url', value: 'https://a' }])
    })

    it('decision shape: question 300 / context 600 / options ≤5 (label 60, detail 200); defaults', () => {
        const trunc: string[] = []
        const d = normalizeDecisionInput({
            question: 'q'.repeat(400), context: 'c'.repeat(700),
            options: Array.from({ length: 7 }, (_, i) => ({ label: `L${i}`.padEnd(80, 'x'), detail: 'd'.repeat(300) })),
        }, trunc)!
        expect(d.question.length).toBe(300)
        expect(d.context!.length).toBe(600)
        expect(d.options).toHaveLength(5)
        expect(d.options.map(o => o.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
        expect(d.options[0].label.length).toBe(60)
        expect(d.options[0].detail!.length).toBe(200)
        expect(d.onDue).toBe('remind')
        expect(d.urgency).toBe('normal')
        expect(d.allowFreeText).toBe(true)
        expect(trunc).toEqual(expect.arrayContaining(['question', 'context', 'options']))
        // zero options = free-text decision
        expect(normalizeDecisionInput({ question: 'free?' }, [])!.options).toEqual([])
    })

    it('a caller can never smuggle an answer or delivery state into a decision', () => {
        const d = normalizeDecisionInput({
            question: 'ship?', answer: { text: 'yes', by: 'owner', via: 'cli', at: 'x' }, delivery: { messageId: 'm', state: 'acked' },
            options: [{ label: 'yes' }],
        }, [])!
        expect(d.answer).toBeUndefined()
        expect(d.delivery).toBeUndefined()
        const n = normalizeMissionItemInput({ kind: 'decision', question: 'ship?', decision: { question: 'ship?', answer: { text: 'yes' } } })
        if ('error' in n) throw new Error(n.error)
        expect(n.item.decision!.answer).toBeUndefined()
    })

    it('apply_recommended needs a recommended option, else falls back to remind; recommended may be a label', () => {
        expect(normalizeDecisionInput({ question: 'q', onDue: 'apply_recommended' }, [])!.onDue).toBe('remind')
        const d = normalizeDecisionInput({ question: 'q', options: [{ label: 'Keep' }, { label: 'Drop' }], recommended: 'drop', on_due: 'apply_recommended', due_at: '2026-11-01T00:00:00Z' }, [])!
        expect(d.recommended).toBe('b')
        expect(d.onDue).toBe('apply_recommended')
        expect(d.dueAt).toBe('2026-11-01T00:00:00.000Z')
    })

    it('dedupe key derivation: same question (case/space/trailing punctuation) → same key; machine separates live_check; explicit wins', () => {
        const k = (q: string) => deriveItemDedupeKey('decision', { question: q })
        expect(k('Ship  the budget?')).toBe(k('ship the budget'))
        expect(k('Ship the budget?')).not.toBe(k('Ship the npmrc?'))
        expect(deriveItemDedupeKey('live_check', { text: 'verify X', machine: 'Mac' })).not.toBe(deriveItemDedupeKey('live_check', { text: 'verify X', machine: 'Win' }))
        expect(deriveItemDedupeKey('remaining', { text: 'a', explicit: 'mykey' })).toBe('k:mykey')
        expect(deriveItemDedupeKey('evidence', { refs: [{ kind: 'commit', value: 'abc1234' }] })).toBe('evidence:commit::abc1234')
    })

    it('unusable items are reported per item, never thrown', () => {
        expect('error' in normalizeMissionItemInput({ kind: 'remaining' })).toBe(true)
        expect('error' in normalizeMissionItemInput({ kind: 'bogus', text: 'x' })).toBe(true)
        expect('error' in normalizeMissionItemInput({ kind: 'decision' })).toBe(true)
        expect('error' in normalizeMissionItemInput('str')).toBe(true)
        expect('error' in normalizeMissionItemUpdate({})).toBe(true)
    })

    it('report commits: SHA strings only', () => {
        expect(normalizeReportCommits(['ABCDEF1', 'abcdef1'])).toEqual(['abcdef1'])
        expect(normalizeReportCommits(['not a sha'])).toBeNull()
        expect(normalizeReportCommits('abc1234')).toBeNull()
    })

    it('event payloads are bounded to 16 KiB', () => {
        const json = boundEventPayload({ previousGoal: 'g'.repeat(100_000), goal: 'h'.repeat(100_000) })
        expect(json.length).toBeLessThanOrEqual(MISSION_LIMITS.eventPayloadBytes)
        expect(JSON.parse(json).payloadTruncated).toBe(true)
    })

    it('carry-over title is recognizable', () => {
        expect(isCarryOverMissionTitle(CARRY_OVER_MISSION_TITLE)).toBe(true)
        expect(isCarryOverMissionTitle('Other')).toBe(false)
    })
})

describe('mission_upsert / mission_list_query wire — mixed-version tolerance (design §13.1)', () => {
    const v = TURN_IPC_PROTOCOL_VERSION
    const mission = { id: 'm1', meshId: 'mesh1', title: 't', goal: 'g', status: 'active' }

    it('a legacy request (no new keys) and a legacy response decode exactly as before', () => {
        expect(decodeMissionUpsertRequest({ v, meshId: 'mesh1', title: 't' })).not.toBeNull()
        expect(decodeMissionUpsertResponse({ mission })).not.toBeNull()
        expect(decodeMissionListQueryResponse({ missions: [], historyFold: null, truncated: false, matched: 0 })).not.toBeNull()
    })

    it('the structured request/response keys decode', () => {
        expect(decodeMissionUpsertRequest({
            v, meshId: 'mesh1', id: 'm1', title: '', structured: true, summary: 's', outcome: 'merged', itemsAdd: [{ kind: 'remaining', text: 'x' }],
        })).not.toBeNull()
        expect(decodeMissionUpsertRequest({ v, meshId: 'mesh1', title: '', toCarryOver: true, itemsAdd: [{ text: 'x' }] })).not.toBeNull()
        expect(decodeMissionUpsertResponse({
            mission: { ...mission, summary: 's', version: 3, openItems: { remaining: 1, live_check: 0, decision: 0, evidence: 0 } },
            result: { movedItems: 1 },
        })).not.toBeNull()
    })

    it('an empty title without an id/carry-over target is still refused', () => {
        expect(decodeMissionUpsertRequest({ v, meshId: 'mesh1', title: '' })).toBeNull()
        expect(decodeMissionUpsertRequest({ v, meshId: 'mesh1', title: '', itemsAdd: 'nope' })).toBeNull()
    })
})
