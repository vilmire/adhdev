import { describe, expect, it } from 'vitest'
import {
    buildNeedsYouEntries,
    clearDecisionFromQuery,
    confirmationOptionKey,
    parseCloseConfirmationContext,
    dueInfo,
    filterNeedsYou,
    isCloseConfirmation,
    mayAlreadyBeInProgress,
    mergeNeedsYouSnapshots,
    missionDisplayTitle,
    needsYouCount,
    parseNeedsYouList,
    parseNeedsYouQuery,
    planRecommendedAnswers,
    sortNeedsYou,
    type NeedsYouDecision,
    type NeedsYouLiveCheck,
} from '../../src/components/needs-you/needs-you-model'
import { resolveSwipe } from '../../src/components/needs-you/useSwipe'
import type { PendingApprovalItem } from '../../src/components/MeshGraph/PendingApprovalsInbox'

const decision = (over: Partial<NeedsYouDecision> = {}): NeedsYouDecision => ({
    daemonId: 'd1', meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship', itemId: 'mi_1', question: 'Q?',
    options: [{ id: 'a', label: 'Temp' }, { id: 'b', label: 'Final' }], allowFreeText: true, urgency: 'normal', onDue: 'remind',
    source: 'coordinator', createdAt: '2026-10-29T00:00:00.000Z', ...over,
})
const check = (over: Partial<NeedsYouLiveCheck> = {}): NeedsYouLiveCheck => ({
    daemonId: 'd1', meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship', itemId: 'lc_1', text: 'verify on win32', createdAt: '2026-10-28T00:00:00.000Z', ...over,
})
const approval = (over: Partial<PendingApprovalItem> = {}): PendingApprovalItem => ({ nodeId: 'n1', sessionId: 's1', waitingSince: 1000, actionable: true, ...over })

describe('sorting', () => {
    it('orders approvals, blocking decisions, due-soonest decisions, confirmations, then live checks', () => {
        const confirm = decision({
            itemId: 'mi_c', question: "The coordinator closed this as 'owner abandoned' — correct?", source: 'daemon',
            options: [{ id: 'a', label: 'Correct' }, { id: 'b', label: 'Reopen' }],
        })
        const entries = buildNeedsYouEntries({
            decisions: [
                decision({ itemId: 'mi_late', dueAt: '2026-10-31T00:00:00.000Z' }),
                confirm,
                decision({ itemId: 'mi_soon', dueAt: '2026-10-30T00:00:00.000Z' }),
                decision({ itemId: 'mi_block', urgency: 'blocking', createdAt: '2026-10-29T05:00:00.000Z' }),
                decision({ itemId: 'mi_none', createdAt: '2026-10-20T00:00:00.000Z' }),
            ],
            liveChecks: [check()],
        }, [approval({ sessionId: 's-new', waitingSince: 5000 }), approval({ sessionId: 's-old', waitingSince: 1000 })])
        const order = sortNeedsYou(entries).map(e => e.kind === 'approval' ? e.approval.sessionId : e.kind === 'live_check' ? e.check.itemId : e.decision.itemId)
        expect(order).toEqual(['s-old', 's-new', 'mi_block', 'mi_soon', 'mi_late', 'mi_none', 'mi_c', 'lc_1'])
    })

    it('recognizes the owner_abandoned close confirmation and gives it its own kind', () => {
        const c = decision({ question: "The coordinator closed this as 'owner abandoned' — correct?", options: [{ id: 'a', label: 'Correct' }, { id: 'b', label: 'Reopen' }] })
        expect(isCloseConfirmation(c)).toBe(true)
        expect(isCloseConfirmation(decision())).toBe(false)
        expect(buildNeedsYouEntries({ decisions: [c], liveChecks: [] }, [])[0].kind).toBe('confirmation')
    })
})

describe('filtering and counting', () => {
    const entries = buildNeedsYouEntries({
        decisions: [decision({ itemId: 'a1' }), decision({ itemId: 'b1', meshId: 'm2' })],
        liveChecks: [check({ meshId: 'm2' })],
    }, [approval()])
    it('filters by kind and by project (approvals carry no project)', () => {
        expect(filterNeedsYou(entries, { kind: 'all', meshId: 'all' })).toHaveLength(4)
        expect(filterNeedsYou(entries, { kind: 'decision', meshId: 'all' })).toHaveLength(2)
        expect(filterNeedsYou(entries, { kind: 'approval', meshId: 'all' })).toHaveLength(1)
        expect(filterNeedsYou(entries, { kind: 'all', meshId: 'm2' }).map(e => e.kind).sort()).toEqual(['decision', 'live_check'])
    })
    it('the nav badge counts decisions and approvals, not live checks', () => {
        expect(needsYouCount(entries)).toBe(3)
    })
})

describe('answer all with recommended', () => {
    it('plans only decisions whose recommended option exists, one line each', () => {
        const entries = buildNeedsYouEntries({
            decisions: [
                decision({ itemId: 'has', recommended: 'b' }),
                decision({ itemId: 'none' }),
                decision({ itemId: 'bogus', recommended: 'z' }),
            ],
            liveChecks: [],
        }, [])
        const plan = planRecommendedAnswers(entries)
        expect(plan.map(p => [p.decision.itemId, p.optionId, p.optionLabel])).toEqual([['has', 'b', 'Final']])
    })
})

describe('deep link', () => {
    it('parses mesh / decision / choose and drops choose without a decision', () => {
        expect(parseNeedsYouQuery('?mesh=m1&decision=mi_9&choose=b')).toEqual({ meshId: 'm1', decisionId: 'mi_9', choose: 'b' })
        expect(parseNeedsYouQuery('?mesh=m1')).toEqual({ meshId: 'm1' })
        expect(parseNeedsYouQuery('?choose=b')).toEqual({})
        expect(parseNeedsYouQuery('')).toEqual({})
    })
})

describe('close confirmation text + deep-link clearing', () => {
    it('parses the stored context into title + reason without the mission id; other shapes are not parsed', () => {
        const id = '09094c4a-1111-2222-3333-444455556666'
        expect(parseCloseConfirmationContext(`Mission "Ship budget" (${id}) — reason: not needed anymore`)).toEqual({ title: 'Ship budget', reason: 'not needed anymore' })
        expect(parseCloseConfirmationContext(`Mission "Say "hi" now" (${id})`)).toEqual({ title: 'Say "hi" now' })
        expect(parseCloseConfirmationContext('something else')).toBeNull()
        expect(parseCloseConfirmationContext(undefined)).toBeNull()
    })
    it('maps the two canonical option labels', () => {
        expect(confirmationOptionKey('Correct')).toBe('optionCorrect')
        expect(confirmationOptionKey('Reopen')).toBe('optionReopen')
        expect(confirmationOptionKey('Other')).toBeUndefined()
    })
    it('clearDecisionFromQuery drops decision/choose and keeps mesh', () => {
        expect(clearDecisionFromQuery('?mesh=m1&decision=mi_9&choose=b')).toBe('?mesh=m1')
        expect(clearDecisionFromQuery('?decision=mi_9&choose=b')).toBe('')
        expect(clearDecisionFromQuery('')).toBe('')
    })
})

describe('labels', () => {
    it('answers older than 10 minutes may already be in progress', () => {
        const now = Date.parse('2026-10-29T01:00:00Z')
        expect(mayAlreadyBeInProgress('2026-10-29T00:55:00Z', now)).toBe(false)
        expect(mayAlreadyBeInProgress('2026-10-29T00:40:00Z', now)).toBe(true)
    })
    it('due info flags overdue and auto-apply', () => {
        const now = Date.parse('2026-10-29T01:00:00Z')
        expect(dueInfo({ dueAt: '2026-10-29T00:00:00Z', onDue: 'apply_recommended', recommended: 'a' }, now)).toMatchObject({ state: 'overdue', autoApply: true })
        expect(dueInfo({ dueAt: '2026-10-29T02:00:00Z', onDue: 'remind' }, now)).toMatchObject({ state: 'upcoming', autoApply: false })
        expect(dueInfo({ onDue: 'remind' }, now)).toBeNull()
    })
    it('carry-over mission title is localized via the flag, with the stored English/legacy title as fallback', () => {
        expect(missionDisplayTitle({ title: 'whatever', carryOver: true }, 'LOCALIZED')).toBe('LOCALIZED')
        expect(missionDisplayTitle({ title: 'Carry-over — open items from closed missions' }, 'LOCALIZED')).toBe('LOCALIZED')
        expect(missionDisplayTitle({ title: '이월 — 닫힌 미션에서 넘어온 항목' }, 'LOCALIZED')).toBe('LOCALIZED')
        expect(missionDisplayTitle({ title: 'Big refactor' }, 'LOCALIZED')).toBe('Big refactor')
    })
})

describe('swipe', () => {
    it('commits right/left only for a dominant, long-enough horizontal drag', () => {
        expect(resolveSwipe(120, 10)).toBe('right')
        expect(resolveSwipe(-120, -5)).toBe('left')
        expect(resolveSwipe(40, 0)).toBeNull()
        expect(resolveSwipe(100, 90)).toBeNull()
    })
})

describe('wire parsing', () => {
    it('parses decisions, live checks, answered rows, mission structure; unwraps the cloud result layer; drops junk', () => {
        const body = {
            success: true,
            ownerDecisions: [{ meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship', itemId: 'mi_1', question: 'Q?', options: [{ id: 'a', label: 'A' }, { bad: 1 }], recommended: 'a', allowFreeText: false, urgency: 'blocking', onDue: 'apply_recommended', source: 'worker', createdAt: 'x', carryOver: true }, { junk: true }],
            liveChecks: [{ meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship', itemId: 'lc', text: 'check', createdAt: 'x' }],
            recentlyAnswered: [{ meshId: 'm1', missionId: 'ms1', itemId: 'mi_2', question: 'Q2', answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: '2026-10-29T00:00:00Z' }, revision: 2, deliveryState: 'queued', autoApplied: false, options: [{ id: 'a', label: 'A' }], allowFreeText: true }],
            missions: [{ meshId: 'm1', missionId: 'ms1', summary: 'sum', openItems: { remaining: 2, live_check: 1, decision: 1, evidence: 0 }, carryOver: true }],
            hostedMeshIds: ['m1'], meshNames: { m1: 'adhdev' },
        }
        for (const raw of [body, { success: true, result: body }]) {
            const s = parseNeedsYouList(raw, 'dX')
            expect(s.decisions).toHaveLength(1)
            expect(s.decisions[0]).toMatchObject({ daemonId: 'dX', urgency: 'blocking', source: 'worker', allowFreeText: false, carryOver: true })
            expect(s.decisions[0].options).toEqual([{ id: 'a', label: 'A' }])
            expect(s.liveChecks).toHaveLength(1)
            expect(s.answered[0]).toMatchObject({ itemId: 'mi_2', deliveryState: 'queued', revision: 2 })
            expect(s.missions[0]).toMatchObject({ summary: 'sum', carryOver: true, openItems: { remaining: 2, live_check: 1 } })
            expect(s.meshNames).toEqual({ m1: 'adhdev' })
        }
        expect(parseNeedsYouList({ success: false }, 'd').decisions).toEqual([])
        expect(mergeNeedsYouSnapshots([parseNeedsYouList(body, 'a'), parseNeedsYouList(body, 'b')]).decisions).toHaveLength(2)
    })
})

describe('owner-held staged approvals', () => {
    const staged = { id: 'driver-activation-1', kind: 'driver_activation', action: 'activate', target: 'browser', origin: 'driver', createdAt: '2026-10-29T00:00:00.000Z' } as any
    it('appear under the approval filter, count in the badge, and sort with approvals', () => {
        const entries = buildNeedsYouEntries({ decisions: [decision()], liveChecks: [] }, [], [staged])
        expect(entries.map(e => e.kind)).toEqual(['staged', 'decision'])
        expect(needsYouCount(entries)).toBe(2)
        expect(filterNeedsYou(entries, { kind: 'approval', meshId: 'all' }).map(e => e.kind)).toEqual(['staged'])
        expect(filterNeedsYou(entries, { kind: 'decision', meshId: 'all' }).map(e => e.kind)).toEqual(['decision'])
        expect(sortNeedsYou(entries)[0].kind).toBe('staged')
    })
})
