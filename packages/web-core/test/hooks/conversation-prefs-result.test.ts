import { describe, expect, it } from 'vitest'
import { evaluateConversationPrefsResult } from '../../src/hooks/useConversationPrefs'

// MESH-WORKER-PREFS Fix (3)+(4): the set_conversation_prefs overlay reconcile must recognise a
// remote-worker rejection that arrives through the CLOUD double-envelope
// (`{ success: true, result: { success: false, ... } }`) and a failed coordinator mirror refresh
// (`mirrorStale: true`). Before this the reconcile only inspected the OUTER envelope (always
// success:true on cloud), so every remote-worker rejection was silently treated as confirmed and
// the optimistic overlay stuck on a value the daemon never adopted (the "restore does nothing" +
// stale-revert defect).

describe('evaluateConversationPrefsResult', () => {
    it('confirms a plain daemon success (standalone raw body)', () => {
        expect(evaluateConversationPrefsResult({ success: true, userHidden: false })).toEqual({ confirmed: true })
    })

    it('confirms a cloud-wrapped success', () => {
        expect(evaluateConversationPrefsResult({ success: true, result: { success: true, userHidden: false } }))
            .toEqual({ confirmed: true })
    })

    it('Fix 3: detects a remote-worker success:false nested under the cloud wrapper', () => {
        const verdict = evaluateConversationPrefsResult({
            success: true,
            result: { success: false, error: 'Session not found or does not support preferences' },
        })
        expect(verdict.confirmed).toBe(false)
        expect(verdict.reason).toBe('Session not found or does not support preferences')
    })

    it('detects a raw (unwrapped) success:false too', () => {
        const verdict = evaluateConversationPrefsResult({ success: false, error: 'no response from remote worker daemon' })
        expect(verdict.confirmed).toBe(false)
        expect(verdict.reason).toBe('no response from remote worker daemon')
    })

    it('Fix 4: treats mirrorStale:true as not-confirmed even when success:true', () => {
        const verdict = evaluateConversationPrefsResult({ success: true, result: { success: true, userHidden: false, mirrorStale: true } })
        expect(verdict.confirmed).toBe(false)
        expect(verdict.reason).toBe('the coordinator did not confirm the change')
    })

    it('mirrorRefreshed:true (success) is confirmed', () => {
        expect(evaluateConversationPrefsResult({ success: true, result: { success: true, userHidden: false, mirrorRefreshed: true } }))
            .toEqual({ confirmed: true })
    })

    it('success:false without an error string falls back to a generic reason', () => {
        const verdict = evaluateConversationPrefsResult({ success: true, result: { success: false } })
        expect(verdict.confirmed).toBe(false)
        expect(verdict.reason).toBe('command was rejected')
    })

    it('tolerates a non-object / null result (confirmed — nothing to reject)', () => {
        expect(evaluateConversationPrefsResult(undefined)).toEqual({ confirmed: true })
        expect(evaluateConversationPrefsResult(null)).toEqual({ confirmed: true })
    })
})
