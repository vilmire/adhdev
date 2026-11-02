/**
 * (PAGING-CURSOR) "Load earlier" pages by a stable TIME cursor, not by counts
 * measured against a history length that moves while the user pages.
 *
 * The cursor (`ts:<receivedAt>:<role>:<hash>`) rides in `excludeFromIdentity`.
 * It must (a) resolve exactly, (b) fall back to the first row at/after the
 * timestamp when the anchor row is not in the (activity-filtered) record space,
 * (c) be unaffected by rows appended after the anchor was taken, (d) reach a
 * cursor sitting deep in a long history through the bounded-tail reader, and
 * (e) be unrecognised-but-harmless to a daemon that predates it (the count path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    buildHistoryTimeCursor,
    hashHistoryCursorContent,
    pageHistoryRecords,
} from '../../src/config/chat-history-tail'

const T0 = 1_800_000_000_000

interface Row { role: 'user' | 'assistant'; kind: string; content: string; receivedAt: number }

function transcript(count: number, toolEvery = 0): Row[] {
    const rows: Row[] = []
    for (let i = 0; i < count; i += 1) {
        const tool = toolEvery > 0 && i % toolEvery !== 0
        rows.push({
            role: tool || i % 2 === 1 ? 'assistant' : 'user',
            kind: tool ? 'tool' : 'standard',
            content: `${tool ? 'tool' : 'prose'}-${i}`,
            receivedAt: T0 + i * 1000,
        })
    }
    return rows
}

const toRecord = (row: Row) => ({ ...row, ts: new Date(row.receivedAt).toISOString(), agent: 'hermes-cli' }) as any

describe('pageHistoryRecords time cursor', () => {
    it('hash is whitespace-normalized FNV-1a and stable', () => {
        expect(hashHistoryCursorContent('a  b\n')).toBe(hashHistoryCursorContent(' a b'))
        expect(hashHistoryCursorContent('')).toBe('811c9dc5')
    })

    it('pages strictly older than the anchor and acknowledges the cursor', () => {
        const rows = transcript(100).map(toRecord)
        const anchor = rows[60]
        const page = pageHistoryRecords('hermes-cli', rows, 0, 30, 0, undefined, buildHistoryTimeCursor(anchor))
        expect(page.boundaryResolved).toBe(true)
        expect(page.boundaryKind).toBe('time')
        expect(page.messages.map((m) => m.content)).toEqual(rows.slice(30, 60).map((m: any) => m.content))
        expect(page.hasMore).toBe(true)
    })

    it('rows appended after the anchor do not move the boundary (count path would)', () => {
        const base = transcript(100).map(toRecord)
        const cursor = buildHistoryTimeCursor(base[60])
        const grown = [...base, ...transcript(110).slice(100).map(toRecord)]
        const a = pageHistoryRecords('hermes-cli', base, 0, 30, 0, undefined, cursor)
        const b = pageHistoryRecords('hermes-cli', grown, 0, 30, 0, undefined, cursor)
        expect(b.messages.map((m) => m.content)).toEqual(a.messages.map((m) => m.content))
        // The pre-existing count semantics DO drift: same excludeRecentCount, grown history.
        const countA = pageHistoryRecords('hermes-cli', base, 0, 30, 40)
        const countB = pageHistoryRecords('hermes-cli', grown, 0, 30, 40)
        expect(countB.messages.map((m) => m.content)).not.toEqual(countA.messages.map((m) => m.content))
    })

    it('an anchor that is an activity row (filtered out) falls back to the first row at/after its time', () => {
        const rows = transcript(60, 3).map(toRecord) // tool rows at i % 3 !== 0
        const anchor = rows[31] // tool row
        expect(anchor.kind).toBe('tool')
        const page = pageHistoryRecords('hermes-cli', rows, 0, 100, 0, undefined, buildHistoryTimeCursor(anchor), true)
        expect(page.boundaryResolved).toBe(true)
        const contents = page.messages.map((m) => m.content)
        expect(contents[contents.length - 1]).toBe('prose-30')
        expect(contents).not.toContain('prose-33')
    })

    it('a cursor newer than all history pages the whole tail; older than all yields nothing', () => {
        const rows = transcript(10).map(toRecord)
        const newer = pageHistoryRecords('hermes-cli', rows, 0, 30, 0, undefined, `ts:${T0 + 999_999}:user:00000000`)
        expect(newer.messages).toHaveLength(10)
        expect(newer.boundaryKind).toBe('time')
        const older = pageHistoryRecords('hermes-cli', rows, 0, 30, 0, undefined, `ts:${T0 - 5}:user:00000000`)
        expect(older.messages).toHaveLength(0)
        expect(older.hasMore).toBe(false)
    })

    it('a malformed ts cursor is unresolved and does not claim the time path', () => {
        const rows = transcript(10).map(toRecord)
        const page = pageHistoryRecords('hermes-cli', rows, 0, 3, 2, undefined, 'ts:nonsense')
        expect(page.boundaryResolved).toBe(false)
        expect(page.boundaryKind).toBeUndefined()
        expect(page.messages.map((m) => m.content)).toEqual(['prose-5', 'prose-6', 'prose-7'])
    })

    it('pages an unrelated-scheme (old-daemon) cursor through the count path', () => {
        const rows = transcript(10).map(toRecord)
        const page = pageHistoryRecords('hermes-cli', rows, 0, 3, 2, undefined, 'unit:does-not-exist')
        expect(page.boundaryKind).toBeUndefined()
        expect(page.messages.map((m) => m.content)).toEqual(['prose-5', 'prose-6', 'prose-7'])
    })
})

describe('readChatHistory time cursor over the bounded-tail reader', () => {
    let dir = ''
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-ts-'))
        process.env.ADHDEV_CONFIG_DIR = dir
        vi.resetModules()
    })
    afterEach(() => {
        delete process.env.ADHDEV_CONFIG_DIR
        fs.rmSync(dir, { recursive: true, force: true })
    })

    function write(rows: Row[]) {
        const file = path.join(dir, 'history', 'hermes-cli', 'sess_2026-11-01.jsonl')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, rows.map((r) => JSON.stringify({ ...r, ts: new Date(r.receivedAt).toISOString(), agent: 'hermes-cli', historySessionId: 'sess' })).join('\n') + '\n')
    }

    it('walks a 500-row history to the start from a deep anchor, each row exactly once, rows arriving between pages', async () => {
        const { readChatHistory } = await import('../../src/config/chat-history')
        const all = transcript(500)
        write(all)
        // Live window = newest 200 -> anchor is row 300. Pages of 30 via the cursor only.
        let anchor: Row = all[300]
        const seen: string[] = []
        let appended = 500
        for (let guard = 0; guard < 40; guard += 1) {
            const page = readChatHistory('hermes-cli', 0, 30, 'sess', 0, undefined, buildHistoryTimeCursor(anchor))
            expect(page.boundaryKind).toBe('time')
            seen.unshift(...page.messages.map((m) => m.content))
            if (page.messages.length === 0 || !page.hasMore) break
            anchor = page.messages[0] as unknown as Row
            // New messages land between pages.
            all.push(...transcript(appended + 7).slice(appended)); appended += 7
            write(all)
        }
        expect(seen).toEqual(all.slice(0, 300).map((r) => r.content))
        expect(new Set(seen).size).toBe(seen.length)
    })

    it('tool-heavy history with the activity filter on: prose pages are contiguous and complete', async () => {
        const { readChatHistory } = await import('../../src/config/chat-history')
        const all = transcript(400, 4)
        write(all)
        let anchor: Row = all[250]
        const seen: string[] = []
        for (let guard = 0; guard < 40; guard += 1) {
            const page = readChatHistory('hermes-cli', 0, 20, 'sess', 0, undefined, buildHistoryTimeCursor(anchor), true)
            seen.unshift(...page.messages.map((m) => m.content))
            if (page.messages.length === 0 || !page.hasMore) break
            anchor = page.messages[0] as unknown as Row
        }
        expect(seen).toEqual(all.slice(0, 250).filter((r) => r.kind === 'standard').map((r) => r.content))
    })
})
