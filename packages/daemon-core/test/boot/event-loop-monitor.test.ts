import { describe, expect, it } from 'vitest'

import {
    DEFAULT_EVENT_LOOP_LAG_SUMMARY_TICKS,
    DEFAULT_EVENT_LOOP_LAG_WARN_MS,
    DEFAULT_EVENT_LOOP_MONITOR_INTERVAL_MS,
    EVENT_LOOP_LAG_SUMMARY_TICKS_ENV,
    EVENT_LOOP_LAG_WARN_ENV,
    EVENT_LOOP_MONITOR_INTERVAL_ENV,
    resolveEventLoopLagSummaryTicks,
    resolveEventLoopLagWarnMs,
    resolveEventLoopMonitorIntervalMs,
    startEventLoopMonitor,
} from '../../src/boot/event-loop-monitor'

/**
 * EVENT-LOOP-LAG-HEARTBEAT — the 2026-08-18 freeze was diagnosable only from
 * log ABSENCE. This monitor turns a whole-process stall into a WARN line
 * naming the blackout duration on the first tick after the process resumes.
 */

describe('event-loop monitor env resolution', () => {
    it('defaults: 10s sample interval, 5s warn threshold, 6-tick summary', () => {
        expect(resolveEventLoopMonitorIntervalMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_EVENT_LOOP_MONITOR_INTERVAL_MS)
        expect(DEFAULT_EVENT_LOOP_MONITOR_INTERVAL_MS).toBe(10_000)
        expect(resolveEventLoopLagWarnMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_EVENT_LOOP_LAG_WARN_MS)
        expect(DEFAULT_EVENT_LOOP_LAG_WARN_MS).toBe(5_000)
        expect(resolveEventLoopLagSummaryTicks({} as NodeJS.ProcessEnv)).toBe(DEFAULT_EVENT_LOOP_LAG_SUMMARY_TICKS)
        expect(DEFAULT_EVENT_LOOP_LAG_SUMMARY_TICKS).toBe(6)
    })

    it('honors overrides and falls back on unparseable values', () => {
        expect(resolveEventLoopMonitorIntervalMs({ [EVENT_LOOP_MONITOR_INTERVAL_ENV]: '1000' } as NodeJS.ProcessEnv)).toBe(1000)
        expect(resolveEventLoopLagWarnMs({ [EVENT_LOOP_LAG_WARN_ENV]: '500' } as NodeJS.ProcessEnv)).toBe(500)
        expect(resolveEventLoopLagSummaryTicks({ [EVENT_LOOP_LAG_SUMMARY_TICKS_ENV]: '3' } as NodeJS.ProcessEnv)).toBe(3)
        expect(resolveEventLoopMonitorIntervalMs({ [EVENT_LOOP_MONITOR_INTERVAL_ENV]: 'abc' } as NodeJS.ProcessEnv)).toBe(10_000)
    })
})

describe('startEventLoopMonitor', () => {
    it('interval 0 disables the monitor (no-op handle)', () => {
        const lines: string[] = []
        const handle = startEventLoopMonitor({ intervalMs: 0, logFn: (_level, msg) => lines.push(msg) })
        expect(() => handle.stop()).not.toThrow()
        expect(lines).toEqual([])
    })

    it('a blocked event loop produces a WARN naming the blackout on the next tick', async () => {
        const lines: Array<{ level: string; msg: string }> = []
        const handle = startEventLoopMonitor({
            intervalMs: 25,
            warnMs: 20,
            logFn: (level, msg) => lines.push({ level, msg }),
        })
        try {
            // Block the loop for ~80ms in one synchronous stretch — the
            // self-blocked shape (this process burning CPU), at test scale.
            const until = Date.now() + 80
            while (Date.now() < until) { /* spin */ }
            // Let a couple of monitor ticks fire post-stall.
            await new Promise(resolve => setTimeout(resolve, 90))

            const warns = lines.filter(l => l.level === 'warn')
            expect(warns.length).toBeGreaterThanOrEqual(1)
            expect(warns[0].msg).toMatch(/event-loop lag: drift=\d+ms/)
            expect(warns[0].msg).toContain('EXCEEDS 20ms')
            // The WARN must offer the discriminator, not assert a cause. The
            // old line claimed "machine saturation, not one slow handler"
            // unconditionally, which is the opposite of what this test just
            // produced: the loop was blocked by this process itself.
            expect(warns[0].msg).toContain('selfCpu')
            expect(warns[0].msg).toContain('blocked its own loop')
            expect(warns[0].msg).toContain('machine saturation')
            expect(warns[0].msg).not.toMatch(/frozen\/unscheduled \(machine saturation\), not one slow handler/)
        } finally {
            handle.stop()
        }
    })

    it('stop() ends the heartbeat — no lines after stopping', async () => {
        const lines: string[] = []
        const handle = startEventLoopMonitor({ intervalMs: 15, warnMs: 60_000, logFn: (_l, msg) => lines.push(msg) })
        await new Promise(resolve => setTimeout(resolve, 40))
        handle.stop()
        const countAtStop = lines.length
        expect(countAtStop).toBeGreaterThanOrEqual(1) // sanity: it WAS ticking
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(lines.length).toBe(countAtStop)
    })
})

describe('summary rollup — numeric max visible without raising the daemon log level', () => {
    it('emits an INFO line with a numeric max after summaryTicks ticks, independent of the (unfired) WARN', async () => {
        const lines: Array<{ level: string; msg: string }> = []
        // warnMs high enough that ordinary tick lag never crosses it — this
        // proves the summary line is not gated behind (or coupled to) WARN.
        const handle = startEventLoopMonitor({
            intervalMs: 15,
            warnMs: 60_000,
            summaryTicks: 3,
            logFn: (level, msg) => lines.push({ level, msg }),
        })
        try {
            await new Promise(resolve => setTimeout(resolve, 15 * 3 + 40))
            const warns = lines.filter(l => l.level === 'warn')
            const infos = lines.filter(l => l.level === 'info')
            expect(warns).toEqual([])
            expect(infos.length).toBeGreaterThanOrEqual(1)
            expect(infos[0].msg).toMatch(/event-loop lag summary: max=\d+ms p99=\d+ms mean=[\d.]+ms over 3 ticks \/ 45ms/)
        } finally {
            handle.stop()
        }
    })

    it('summaryTicks 0 disables the summary line while leaving DEBUG/WARN intact', async () => {
        const lines: Array<{ level: string; msg: string }> = []
        const handle = startEventLoopMonitor({
            intervalMs: 15,
            warnMs: 60_000,
            summaryTicks: 0,
            logFn: (level, msg) => lines.push({ level, msg }),
        })
        try {
            await new Promise(resolve => setTimeout(resolve, 15 * 4 + 40))
            expect(lines.filter(l => l.level === 'info')).toEqual([])
            expect(lines.filter(l => l.level === 'debug').length).toBeGreaterThanOrEqual(1)
        } finally {
            handle.stop()
        }
    })
})
