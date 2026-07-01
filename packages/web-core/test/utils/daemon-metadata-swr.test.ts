import { describe, expect, it } from 'vitest'
import { shouldLoadDaemonMetadata } from '../../src/utils/daemon-metadata-swr.js'

describe('shouldLoadDaemonMetadata (held-first SWR)', () => {
    const base = {
        force: false,
        hasSubscription: false,
        loadedAt: 0,
        now: 100_000,
        minFreshMs: 60_000,
    }

    it('loads on the first sight (no held data yet)', () => {
        expect(shouldLoadDaemonMetadata({ ...base, loadedAt: 0 })).toBe(true)
    })

    it('always loads when forced, even with fresh held data and a subscription', () => {
        expect(shouldLoadDaemonMetadata({
            ...base,
            force: true,
            hasSubscription: true,
            loadedAt: base.now - 1_000,
        })).toBe(true)
    })

    it('skips when a live subscription already keeps held data fresh', () => {
        expect(shouldLoadDaemonMetadata({
            ...base,
            hasSubscription: true,
            loadedAt: base.now - 5_000,
        })).toBe(false)
    })

    it('serves held (skips freshen) while held data is within minFreshMs', () => {
        expect(shouldLoadDaemonMetadata({
            ...base,
            loadedAt: base.now - 30_000,
            minFreshMs: 60_000,
        })).toBe(false)
    })

    it('freshens in the background once held data ages past minFreshMs', () => {
        expect(shouldLoadDaemonMetadata({
            ...base,
            loadedAt: base.now - 60_000,
            minFreshMs: 60_000,
        })).toBe(true)
    })

    it('first-sight load wins over the subscription short-circuit', () => {
        // A subscription may exist but no data has landed yet (loadedAt === 0):
        // we must still fetch so the held snapshot gets populated.
        expect(shouldLoadDaemonMetadata({
            ...base,
            hasSubscription: true,
            loadedAt: 0,
        })).toBe(true)
    })
})
