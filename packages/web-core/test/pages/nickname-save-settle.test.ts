// A nickname save used to read a refused result as saved, and with the machine's
// connection stuck it never settled, so nothing at all was shown (2026-10-02).
import { describe, expect, it, vi } from 'vitest'
import { settleNicknameSave } from '../../src/pages/machine/useMachineActions'

const opts = { timeoutMs: 1000, timeoutMessage: 'timed out', failedMessage: 'failed' }

describe('settleNicknameSave', () => {
    it('resolves on success', async () => {
        await expect(settleNicknameSave(Promise.resolve({ success: true }), opts)).resolves.toBeUndefined()
    })
    it('throws on a refused result', async () => {
        await expect(settleNicknameSave(Promise.resolve({ success: false, error: 'nope' }), opts)).rejects.toThrow('nope')
        await expect(settleNicknameSave(Promise.resolve({ success: false }), opts)).rejects.toThrow('failed')
    })
    it('throws when the command never settles', async () => {
        vi.useFakeTimers()
        try {
            const p = settleNicknameSave(new Promise(() => {}), opts)
            const assertion = expect(p).rejects.toThrow('timed out')
            await vi.advanceTimersByTimeAsync(1001)
            await assertion
        } finally { vi.useRealTimers() }
    })
})
