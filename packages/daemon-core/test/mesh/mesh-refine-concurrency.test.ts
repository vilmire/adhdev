import { describe, expect, it, afterEach } from 'vitest'

import {
    DEFAULT_REFINE_MAX_CONCURRENT_JOBS,
    REFINE_MAX_CONCURRENT_JOBS_ENV,
    refineExecutionQueueStats,
    resolveRefineMaxConcurrentJobs,
    runWithRefineExecutionSlot,
} from '../../src/mesh/mesh-refine-concurrency'

/**
 * REFINE-CONCURRENCY-CAP regression suite.
 *
 * 2026-08-18 RCA (verdict D — whole-process resource saturation): two
 * independent 19-gate refine pipelines overlapped on a 16GB/10-core host and
 * blacked out the daemon event loop for 28–34s stretches. The cap serializes
 * pipeline EXECUTION (accept stays async-ack): a second accepted job must WAIT
 * in the FIFO queue and start automatically once the running job terminates —
 * never be rejected back to the caller.
 *
 * These tests drive the slot mechanism directly (the router wiring is a thin
 * `setImmediate(() => runWithRefineExecutionSlot(...))` at the two dispatch
 * sites in router-refine.ts).
 */

const ENV = REFINE_MAX_CONCURRENT_JOBS_ENV

afterEach(() => {
    delete process.env[ENV]
})

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

describe('resolveRefineMaxConcurrentJobs', () => {
    it('defaults to 1 (serial) when the env var is unset or empty', () => {
        delete process.env[ENV]
        expect(resolveRefineMaxConcurrentJobs()).toBe(1)
        expect(DEFAULT_REFINE_MAX_CONCURRENT_JOBS).toBe(1)
        expect(resolveRefineMaxConcurrentJobs({ [ENV]: '' } as NodeJS.ProcessEnv)).toBe(1)
    })

    it('honors a positive integer override', () => {
        expect(resolveRefineMaxConcurrentJobs({ [ENV]: '3' } as NodeJS.ProcessEnv)).toBe(3)
    })

    it('falls back to 1 for unparseable or sub-1 values (never silently uncapped)', () => {
        for (const bad of ['abc', '0', '-2', '1.5x']) {
            expect(resolveRefineMaxConcurrentJobs({ [ENV]: bad } as NodeJS.ProcessEnv)).toBe(1)
        }
    })
})

describe('runWithRefineExecutionSlot — serialization', () => {
    it('two concurrent jobs at the default limit: the second WAITS, then runs after the first finishes', async () => {
        delete process.env[ENV]
        const events: string[] = []
        const gateA = deferred()

        const taskA = runWithRefineExecutionSlot('job-A', async () => {
            events.push('a:start')
            await gateA.promise
            events.push('a:end')
            return 'A'
        })
        const taskB = runWithRefineExecutionSlot('job-B', async () => {
            events.push('b:start')
            events.push('b:end')
            return 'B'
        })

        // Let both tasks reach their first await.
        await new Promise(resolve => setTimeout(resolve, 10))

        // A holds the only slot; B must be parked — provably NOT started.
        expect(events).toEqual(['a:start'])
        expect(refineExecutionQueueStats()).toMatchObject({ active: 1, waiting: 1, limit: 1 })

        // Releasing A lets B run to completion without any caller re-invoke.
        gateA.resolve()
        await expect(taskA).resolves.toBe('A')
        await expect(taskB).resolves.toBe('B')

        expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
        expect(refineExecutionQueueStats()).toMatchObject({ active: 0, waiting: 0 })
    })

    it('a throwing job still releases the slot so the queued job runs (no wedge)', async () => {
        delete process.env[ENV]
        const events: string[] = []
        const gateA = deferred()

        const taskA = runWithRefineExecutionSlot('job-A', async () => {
            await gateA.promise
            throw new Error('pipeline blew up')
        })
        const taskB = runWithRefineExecutionSlot('job-B', async () => {
            events.push('b:ran')
        })

        await new Promise(resolve => setTimeout(resolve, 10))
        expect(refineExecutionQueueStats().waiting).toBe(1)

        gateA.resolve()
        await expect(taskA).rejects.toThrow('pipeline blew up')
        await taskB
        expect(events).toEqual(['b:ran'])
        expect(refineExecutionQueueStats()).toMatchObject({ active: 0, waiting: 0 })
    })

    it('limit 2 via env: two jobs overlap instead of serializing', async () => {
        process.env[ENV] = '2'
        const events: string[] = []
        const gate = deferred()

        const taskA = runWithRefineExecutionSlot('job-A', async () => { events.push('a:start'); await gate.promise; events.push('a:end') })
        const taskB = runWithRefineExecutionSlot('job-B', async () => { events.push('b:start'); await gate.promise; events.push('b:end') })

        await new Promise(resolve => setTimeout(resolve, 10))
        // Both started before either finished — overlap is now ALLOWED.
        expect(events.sort()).toEqual(['a:start', 'b:start'])
        expect(refineExecutionQueueStats()).toMatchObject({ active: 2, waiting: 0, limit: 2 })

        gate.resolve()
        await Promise.all([taskA, taskB])
        expect(refineExecutionQueueStats()).toMatchObject({ active: 0, waiting: 0 })
    })
})
