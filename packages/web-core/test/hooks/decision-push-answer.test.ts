import { describe, expect, it } from 'vitest'
import { buildDecisionFallbackUrl, decisionAnswerFailed, planDecisionPushAnswer } from '../../src/hooks/decisionPushAnswer'

const msg = { type: 'notification_action', action: 'decision_choose', meshId: 'mesh_1', itemId: 'mi_1', optionId: 'a', daemonId: 'daemon-1' }

describe('planDecisionPushAnswer', () => {
    it('plans a via:push answer routed to the emitting daemon, with a /needs-you fallback', () => {
        expect(planDecisionPushAnswer(msg)).toEqual({
            routeId: 'daemon-1',
            payload: { meshId: 'mesh_1', itemId: 'mi_1', optionId: 'a', via: 'push' },
            fallbackUrl: '/needs-you?mesh=mesh_1&decision=mi_1&choose=a',
        })
    })
    it('ignores approval actions, other messages and incomplete decision messages', () => {
        expect(planDecisionPushAnswer({ ...msg, action: 'approval_0' })).toBeNull()
        expect(planDecisionPushAnswer({ ...msg, type: 'sw_navigate' })).toBeNull()
        expect(planDecisionPushAnswer({ ...msg, optionId: '' })).toBeNull()
        expect(planDecisionPushAnswer({ ...msg, daemonId: undefined })).toBeNull()
        expect(planDecisionPushAnswer(null)).toBeNull()
    })
    it('builds the deep link without choose when no option', () => {
        expect(buildDecisionFallbackUrl('m', 'i')).toBe('/needs-you?mesh=m&decision=i')
    })
})

describe('decisionAnswerFailed', () => {
    it('treats success:false / ok:false / error text as failure', () => {
        expect(decisionAnswerFailed({ success: false })).toBe(true)
        expect(decisionAnswerFailed({ ok: false, code: 'decision_not_open' })).toBe(true)
        expect(decisionAnswerFailed({ error: 'boom' })).toBe(true)
        expect(decisionAnswerFailed({ success: true, ok: true })).toBe(false)
        expect(decisionAnswerFailed(undefined)).toBe(false)
    })
})
