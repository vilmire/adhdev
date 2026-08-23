// ---------------------------------------------------------------------------
// LOG-SURVIVES-BLOCKED-LOOP regression.
//
// AsyncBatchWriter flushes on a setTimeout. A setTimeout callback runs in the
// event loop's timers phase, so a handler that blocks the loop synchronously
// starves it: every queued line stays in memory for as long as the block lasts.
//
// In production that is not a 50ms nuisance. A daemon burning 100% CPU on a
// synchronous status tick wrote ZERO log lines for 4h56m — the log that would
// have named the stall was suppressed by the stall, and an empty log reads as
// "nothing happened". These tests pin the escape hatches that make the writer
// make forward progress without the loop's cooperation.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AsyncBatchWriter } from '../../src/logging/async-batch-writer.js'

/** Block the event loop synchronously, the way a long sync fs walk does. */
function blockLoopFor(ms: number): void {
    const until = Date.now() + ms
    while (Date.now() < until) { /* spin — no await, no timer can fire */ }
}

describe('AsyncBatchWriter — lines survive a blocked event loop', () => {
    let dir: string
    let logFile: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-batch-writer-'))
        logFile = path.join(dir, 'daemon.log')
        AsyncBatchWriter.flushSync() // drop anything a previous test queued
    })

    afterEach(() => {
        AsyncBatchWriter.flushSync()
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    })

    it('flushSync() lands a queued line while the loop is blocked', () => {
        AsyncBatchWriter.write(logFile, 'STALL-EVIDENCE\n')

        // Before the fix this was the whole bug: the line is buffered, the
        // timer cannot fire, and nothing is on disk.
        AsyncBatchWriter.flushSync()
        blockLoopFor(60) // longer than the 50ms flush timer — it never fires

        expect(fs.existsSync(logFile)).toBe(true)
        expect(fs.readFileSync(logFile, 'utf-8')).toContain('STALL-EVIDENCE')
    })

    it('crossing the pending-line threshold flushes without any timer tick', () => {
        // Never awaits, so the timers phase is never reached: anything on disk
        // at the end got there through the synchronous threshold path.
        for (let i = 0; i < 100; i++) {
            AsyncBatchWriter.write(logFile, `line-${i}\n`)
        }
        blockLoopFor(60)

        expect(fs.existsSync(logFile)).toBe(true)
        const written = fs.readFileSync(logFile, 'utf-8')
        expect(written).toContain('line-0')
        expect(written).toContain('line-63') // first 64-line batch went out
        // Bounded loss: the tail below the threshold is still buffered, which
        // is the deliberate trade (no syscall per line).
        expect(written.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(64)
    })

    it('a large single line flushes on the byte threshold', () => {
        const big = 'x'.repeat(70 * 1024) + '\n' // > MAX_PENDING_BYTES (64 KiB)
        AsyncBatchWriter.write(logFile, big)
        blockLoopFor(60)

        expect(fs.existsSync(logFile)).toBe(true)
        expect(fs.statSync(logFile).size).toBeGreaterThan(64 * 1024)
    })

    it('still batches on the timer when the loop is healthy (no syscall per line)', async () => {
        // Below both thresholds: nothing should hit disk synchronously...
        AsyncBatchWriter.write(logFile, 'a\n')
        AsyncBatchWriter.write(logFile, 'b\n')
        expect(fs.existsSync(logFile)).toBe(false)

        // ...and the timer delivers once the loop is free.
        await new Promise(resolve => setTimeout(resolve, 120))
        expect(fs.readFileSync(logFile, 'utf-8')).toBe('a\nb\n')
    })

    it('flushSync() is safe with nothing buffered', () => {
        expect(() => AsyncBatchWriter.flushSync()).not.toThrow()
    })

    it('a failing path never throws into the caller', () => {
        const bad = path.join(dir, 'no-such-subdir', 'x.log')
        expect(() => {
            AsyncBatchWriter.write(bad, 'y\n')
            AsyncBatchWriter.flushSync()
        }).not.toThrow()
    })
})
