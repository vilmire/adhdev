import { describe, expect, it } from 'vitest'
import {
    RelayReprobeScheduler,
    computeRelayReprobeDelay,
    type RelayReprobeOutcome,
} from '../src/relay-reprobe'

function harness(opts: { shouldProbe?: () => boolean; outcomes: RelayReprobeOutcome[] }) {
    const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
    const probes: number[] = []
    const sched = new RelayReprobeScheduler({
        random: () => 0.5, // zero jitter
        setTimer: (cb, ms) => { const t = { cb, ms, cleared: false }; timers.push(t); return t },
        clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
        shouldProbe: opts.shouldProbe ?? (() => true),
        probe: async () => { probes.push(timers.length); return opts.outcomes.shift() ?? 'failed' },
    })
    const fire = async () => {
        const t = [...timers].reverse().find(x => !x.cleared)!
        t.cleared = true
        t.cb()
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    }
    return { sched, timers, probes, fire }
}

describe('relay reprobe scheduler', () => {
    it('delay doubles 60s -> 5min cap with bounded jitter', () => {
        const r = () => 0.5
        expect([0, 1, 2, 3, 4, 9].map(n => computeRelayReprobeDelay(n, r))).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
        expect(computeRelayReprobeDelay(0, () => 0)).toBe(48_000)
        expect(computeRelayReprobeDelay(0, () => 1)).toBe(72_000)
    })

    it('relay detected -> probe scheduled at 60s; failures grow the backoff', async () => {
        const h = harness({ outcomes: ['relay', 'failed', 'relay'] })
        h.sched.start()
        expect(h.timers.map(t => t.ms)).toEqual([60_000])
        await h.fire(); await h.fire(); await h.fire()
        expect(h.timers.map(t => t.ms)).toEqual([60_000, 120_000, 240_000, 300_000])
        expect(h.sched.failures).toBe(3)
        expect(h.sched.isRunning).toBe(true)
    })

    it('direct outcome stops probing for good', async () => {
        const h = harness({ outcomes: ['direct'] })
        h.sched.start()
        await h.fire()
        expect(h.sched.isRunning).toBe(false)
        expect(h.timers.filter(t => !t.cleared)).toHaveLength(0)
    })

    it('not idle/visible -> skipped tick, backoff NOT grown, no probe', async () => {
        let idle = false
        const h = harness({ shouldProbe: () => idle, outcomes: ['direct'] })
        h.sched.start()
        await h.fire()
        expect(h.probes).toHaveLength(0)
        expect(h.timers.map(t => t.ms)).toEqual([60_000, 60_000])
        idle = true
        await h.fire()
        expect(h.probes).toHaveLength(1)
    })

    it('stop() cancels the timer and discards an in-flight verdict', async () => {
        let resolve!: (o: RelayReprobeOutcome) => void
        const timers: Array<{ cb: () => void; cleared: boolean }> = []
        const sched = new RelayReprobeScheduler({
            random: () => 0.5,
            setTimer: (cb) => { const t = { cb, cleared: false }; timers.push(t); return t },
            clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
            shouldProbe: () => true,
            probe: () => new Promise(r => { resolve = r }),
        })
        sched.start()
        timers[0].cb()
        await Promise.resolve()
        expect(sched.probing).toBe(true)
        sched.stop()
        resolve('relay')
        await Promise.resolve(); await Promise.resolve()
        expect(sched.failures).toBe(0)
        expect(timers).toHaveLength(1) // nothing rescheduled
    })

    it('a throwing probe counts as failed', async () => {
        const timers: Array<{ cb: () => void; ms: number }> = []
        const sched = new RelayReprobeScheduler({
            random: () => 0.5,
            setTimer: (cb, ms) => { timers.push({ cb, ms }); return timers.length },
            clearTimer: () => {},
            shouldProbe: () => true,
            probe: async () => { throw new Error('boom') },
        })
        sched.start()
        timers[0].cb()
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
        expect(sched.failures).toBe(1)
        expect(timers[1].ms).toBe(120_000)
    })
})
