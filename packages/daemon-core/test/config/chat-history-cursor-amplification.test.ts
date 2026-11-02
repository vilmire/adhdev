/**
 * A time cursor that matches nothing in range must not turn one request into a read of the whole
 * history: the widening loop is bounded (iteration cap, no-growth stop, clamped threshold) and the
 * reply stays an honest "not resolved" so the caller falls back to its count path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const reads: number[] = []
vi.mock('../../src/config/chat-history-tail.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/config/chat-history-tail')>('../../src/config/chat-history-tail')
    return {
        ...actual,
        readBoundedTailRecords: (...args: Parameters<typeof actual.readBoundedTailRecords>) => {
            reads.push(args[3])
            return actual.readBoundedTailRecords(...args)
        },
    }
})

const T0 = 1_800_000_000_000
let dir = ''
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-amp-'))
    process.env.ADHDEV_CONFIG_DIR = dir
    reads.length = 0
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + 100_000_000)
})
afterEach(() => {
    vi.useRealTimers()
    delete process.env.ADHDEV_CONFIG_DIR
    fs.rmSync(dir, { recursive: true, force: true })
})

function write(count: number) {
    const file = path.join(dir, 'history', 'hermes-cli', 'sess_2026-11-01.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const rows: string[] = []
    for (let i = 0; i < count; i += 1) {
        rows.push(JSON.stringify({ role: i % 2 ? 'assistant' : 'user', kind: 'standard', content: `prose-${i}`, receivedAt: T0 + i * 1000,
            ts: new Date(T0 + i * 1000).toISOString(), agent: 'hermes-cli', historySessionId: 'sess' }))
    }
    fs.writeFileSync(file, rows.join('\n') + '\n')
}

describe('time cursor read amplification', () => {
    it('a cursor older than all history widens a bounded number of times and stays unresolved', async () => {
        const { readChatHistory } = await import('../../src/config/chat-history')
        write(20_000)
        const page = readChatHistory('hermes-cli', 0, 30, 'sess', 0, undefined, `ts:${T0 - 5000}:user:00000000`)
        // 1 initial read + at most 5 widenings, never the 200k ceiling.
        expect(reads.length).toBeLessThanOrEqual(6)
        expect(Math.max(...reads)).toBeLessThanOrEqual(80 * 32)
        expect(page.hasMore).toBe(true)
        expect(page.boundaryResolved).toBe(false)
        expect(page.boundaryKind).toBeUndefined()
    })

    it('a huge offset does not inflate the widening threshold', async () => {
        const { readChatHistory } = await import('../../src/config/chat-history')
        write(3000)
        readChatHistory('hermes-cli', 1_000_000_000, 30, 'sess', 0, undefined, `ts:${T0 + 1000}:user:00000000`)
        expect(reads.length).toBeLessThanOrEqual(6)
    })

    it('stops widening as soon as a wider read returns no more records', async () => {
        const { readChatHistory } = await import('../../src/config/chat-history')
        write(40)
        readChatHistory('hermes-cli', 0, 30, 'sess', 0, undefined, `ts:${T0 - 5000}:user:00000000`)
        expect(reads.length).toBeLessThanOrEqual(2)
    })

    it('distinct garbage cursors share one cache slot', async () => {
        const { canonicalHistoryCursorKey } = await import('../../src/config/chat-history-tail')
        const keys = new Set<string>()
        for (let i = 0; i < 500; i += 1) keys.add(canonicalHistoryCursorKey(`ts:${T0 + 1e12 + i}:user:${i}`))
        expect(keys.size).toBe(1)
        expect(canonicalHistoryCursorKey(`ts:${T0}:user:abc`)).not.toBe(canonicalHistoryCursorKey(`ts:${T0 + 1}:user:abc`))
    })

    it('a cursor timestamp beyond now + skew is rejected', async () => {
        const { parseHistoryTimeCursor } = await import('../../src/config/chat-history-tail')
        expect(parseHistoryTimeCursor(`ts:${Date.now() + 60_000}:user:abc`)).not.toBeNull()
        expect(parseHistoryTimeCursor(`ts:${Date.now() + 3_600_000}:user:abc`)).toBeNull()
    })
})
