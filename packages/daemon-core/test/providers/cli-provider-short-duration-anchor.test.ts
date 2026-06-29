import { describe, expect, it } from 'vitest'
import { computeTurnAnchoredDurationMs } from '../../src/providers/cli-provider-instance.js'

// NOTIF Defect-2a: the reported short-generating duration must be measured from the IMMUTABLE
// turn start (engine.currentTurnStartedAt), not generatingStartedAt — which is reset to 0 on
// every mid-turn waiting_approval/idle blip and re-armed on the next →generating, so a long
// turn that blipped would otherwise report only the final 1.5-2.5s sliver.
describe('computeTurnAnchoredDurationMs (FIX#2a short-generating duration anchor)', () => {
    it('measures the FULL turn from the engine turn-start, surviving a mid-turn blip', () => {
        // Turn started at t=1000; a mid-turn blip reset generatingStartedAt to a late re-arm at
        // t=119000; idle observed at t=120000. The true turn length is 119s — anchoring on the
        // engine turn-start recovers it instead of the 1s generatingStartedAt sliver.
        const turnStart = 1_000
        const generatingReArm = 119_000 // re-armed after a mid-turn blip
        const now = 120_000
        const { durationMs, anchor } = computeTurnAnchoredDurationMs(turnStart, generatingReArm, now)
        expect(anchor).toBe('turn-start')
        expect(durationMs).toBe(119_000) // true turn length, not the 1s sliver
    })

    it('falls back to generatingStartedAt when no engine turn-start is set', () => {
        const { durationMs, anchor } = computeTurnAnchoredDurationMs(0, 117_500, 120_000)
        expect(anchor).toBe('generatingStartedAt')
        expect(durationMs).toBe(2_500)
    })

    it('treats a non-finite / undefined engine turn-start as absent', () => {
        expect(computeTurnAnchoredDurationMs(undefined, 5_000, 6_000).anchor).toBe('generatingStartedAt')
        expect(computeTurnAnchoredDurationMs(Number.NaN, 5_000, 6_000).anchor).toBe('generatingStartedAt')
    })

    it('returns 0 / none when neither anchor is set (startup-phase blip)', () => {
        const { durationMs, anchor } = computeTurnAnchoredDurationMs(0, 0, 120_000)
        expect(durationMs).toBe(0)
        expect(anchor).toBe('none')
    })

    it('prefers the engine turn-start even when generatingStartedAt is also set', () => {
        // Both set: the engine turn-start (earlier, immutable) wins so the reported duration is
        // the full turn, not the post-blip generating window.
        const { durationMs, anchor } = computeTurnAnchoredDurationMs(1_000, 118_000, 120_000)
        expect(anchor).toBe('turn-start')
        expect(durationMs).toBe(119_000)
    })
})
