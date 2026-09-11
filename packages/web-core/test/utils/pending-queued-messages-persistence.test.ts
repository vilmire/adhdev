// @vitest-environment jsdom
/**
 * (QUEUED-SEND-RESTART-LOSS) The durable store behind the waiting bubbles.
 *
 * ★ What was actually broken, and what these tests pin.
 *
 * The body was NEVER lost on an app restart — it stays parked in the daemon's
 * `FsmDriver.pendingSends` FIFO and drains normally. What was lost was the UI's
 * memory of it: the pane rendered the waiting bubble out of a React `useState`
 * slot and the daemon reports no queue depth to any surface, so a reload erased
 * every trace of a message that was still going to be sent. The owner read that
 * as data loss.
 *
 * Two independent defects lived in that one slot, and both are covered here:
 *   ① not persisted  → gone on restart
 *   ② SINGLE slot    → a second queued message OVERWROTE the first, so the
 *                      first bubble vanished while its body was still queued
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    createPendingQueuedMessageId,
    readPendingQueuedMessages,
    writePendingQueuedMessages,
    prunePendingQueuedMessages,
    PENDING_QUEUED_MESSAGE_MAX_AGE_MS,
    MAX_PENDING_QUEUED_MESSAGES,
    type PendingQueuedMessage,
} from '../../src/utils/pendingQueuedMessages'

const KEY = 'daemon-1::session-a'

function entry(overrides: Partial<PendingQueuedMessage> = {}): PendingQueuedMessage {
    return {
        id: overrides.id || createPendingQueuedMessageId(),
        content: overrides.content ?? 'hello',
        sentAt: overrides.sentAt ?? Date.now(),
        queued: overrides.queued,
    }
}

/**
 * A REAL in-memory localStorage for this file only.
 *
 * `test/setup.ts` installs a deliberately inert stub (getItem returns 'en' for
 * the language key, setItem is a no-op) so every suite boots the English i18n
 * catalog deterministically. That stub cannot store anything, so persistence
 * would silently "pass" by never writing — the exact false-green this suite
 * exists to prevent. Overriding locally keeps the shared i18n pin intact for
 * every other suite while giving these tests storage that actually round-trips.
 */
function installMemoryLocalStorage(): void {
    let data: Record<string, string> = {}
    const storage: Storage = {
        getItem: (key: string) => (key === 'lang' ? 'en' : (key in data ? data[key] : null)),
        setItem: (key: string, value: string) => { data[key] = String(value) },
        removeItem: (key: string) => { delete data[key] },
        clear: () => { data = {} },
        key: (index: number) => Object.keys(data)[index] ?? null,
        get length() { return Object.keys(data).length },
    }
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
    ;(globalThis as { localStorage?: Storage }).localStorage = storage
}

beforeEach(() => {
    installMemoryLocalStorage()
    window.localStorage.clear()
})

it('sanity: the harness storage actually round-trips (guards a false green)', () => {
    window.localStorage.setItem('probe', 'value')
    expect(window.localStorage.getItem('probe')).toBe('value')
})

describe('pending queued messages — durable across an app restart', () => {
    it('★ survives a simulated restart: written entries read back from a fresh load', () => {
        const first = entry({ content: 'first body', sentAt: 1_000, queued: true })
        const second = entry({ content: 'second body', sentAt: 2_000, queued: true })
        writePendingQueuedMessages(KEY, [first, second], 2_000)

        // A restart keeps localStorage but drops all module/React state. Reading
        // fresh is exactly what the pane does on mount.
        const restored = readPendingQueuedMessages(KEY, 2_000)

        expect(restored.map(e => e.content)).toEqual(['first body', 'second body'])
        expect(restored.every(e => e.queued === true)).toBe(true)
    })

    it('★ keeps MULTIPLE entries — the single-slot overwrite is gone', () => {
        const entries = [
            entry({ content: 'one', sentAt: 1_000 }),
            entry({ content: 'two', sentAt: 2_000 }),
            entry({ content: 'three', sentAt: 3_000 }),
        ]
        writePendingQueuedMessages(KEY, entries, 3_000)

        const restored = readPendingQueuedMessages(KEY, 3_000)
        expect(restored).toHaveLength(3)
        expect(restored.map(e => e.content)).toEqual(['one', 'two', 'three'])
    })

    it('★ preserves FIFO order — oldest first, matching the daemon drain order', () => {
        // Deliberately written out of order: the store must not trust input order.
        writePendingQueuedMessages(KEY, [
            entry({ id: 'c', content: 'third', sentAt: 3_000 }),
            entry({ id: 'a', content: 'first', sentAt: 1_000 }),
            entry({ id: 'b', content: 'second', sentAt: 2_000 }),
        ], 3_000)

        expect(readPendingQueuedMessages(KEY, 3_000).map(e => e.content))
            .toEqual(['first', 'second', 'third'])
    })

    it('★ keeps insertion order for entries sharing a timestamp (same-millisecond sends)', () => {
        // Two sends inside one millisecond is the COMMON case here: queueing
        // happens precisely when the owner is firing messages at a busy agent.
        // Breaking the tie by (random UUID) id scrambled FIFO order across a
        // reload — caught by the restart test, pinned here at the store level.
        writePendingQueuedMessages(KEY, [
            entry({ id: 'zzz-sorts-last', content: 'sent first', sentAt: 5_000 }),
            entry({ id: 'aaa-sorts-first', content: 'sent second', sentAt: 5_000 }),
        ], 5_000)

        expect(readPendingQueuedMessages(KEY, 5_000).map(e => e.content))
            .toEqual(['sent first', 'sent second'])
    })

    it('scopes queues per conversation — a restore never leaks across tabs', () => {
        writePendingQueuedMessages(KEY, [entry({ content: 'for A', sentAt: 1_000 })], 1_000)
        writePendingQueuedMessages('daemon-1::session-b', [entry({ content: 'for B', sentAt: 1_000 })], 1_000)

        expect(readPendingQueuedMessages(KEY, 1_000).map(e => e.content)).toEqual(['for A'])
        expect(readPendingQueuedMessages('daemon-1::session-b', 1_000).map(e => e.content)).toEqual(['for B'])
    })

    it('removing the last entry deletes the bucket rather than leaving an empty array', () => {
        writePendingQueuedMessages(KEY, [entry({ content: 'only', sentAt: 1_000 })], 1_000)
        writePendingQueuedMessages(KEY, [], 1_000)

        const raw = JSON.parse(window.localStorage.getItem('adhdev-pending-queued-messages-v1') || '{}')
        expect(raw.byKey?.[KEY]).toBeUndefined()
    })

    it('drops entries past the max age so a forgotten body cannot be pinned forever', () => {
        const now = 10_000_000
        writePendingQueuedMessages(KEY, [
            entry({ content: 'ancient', sentAt: now - PENDING_QUEUED_MESSAGE_MAX_AGE_MS - 1 }),
            entry({ content: 'fresh', sentAt: now - 1_000 }),
        ], now)

        expect(readPendingQueuedMessages(KEY, now).map(e => e.content)).toEqual(['fresh'])
    })

    it('caps a runaway queue at MAX_PENDING_QUEUED_MESSAGES, keeping the newest', () => {
        const many = Array.from({ length: MAX_PENDING_QUEUED_MESSAGES + 5 }, (_, i) =>
            entry({ id: `id-${i}`, content: `body-${i}`, sentAt: 1_000 + i }))
        writePendingQueuedMessages(KEY, many, 9_999)

        const restored = readPendingQueuedMessages(KEY, 9_999)
        expect(restored).toHaveLength(MAX_PENDING_QUEUED_MESSAGES)
        // Newest survive — an old body is far more likely to have already drained.
        expect(restored[restored.length - 1].content).toBe(`body-${MAX_PENDING_QUEUED_MESSAGES + 4}`)
    })

    it('survives a corrupt / hand-edited store without throwing', () => {
        window.localStorage.setItem('adhdev-pending-queued-messages-v1', 'not json{{')
        expect(readPendingQueuedMessages(KEY)).toEqual([])

        window.localStorage.setItem('adhdev-pending-queued-messages-v1', JSON.stringify({
            byKey: { [KEY]: [{ nope: true }, null, 'string', { content: '   ', sentAt: 1, id: 'x' }] },
        }))
        expect(readPendingQueuedMessages(KEY)).toEqual([])
    })

    it('mints unique ids so two same-millisecond sends stay distinguishable', () => {
        const ids = new Set(Array.from({ length: 50 }, () => createPendingQueuedMessageId(1_000)))
        expect(ids.size).toBe(50)
    })

    it('prune clears buckets whose entries have all aged out', () => {
        const now = 10_000_000
        writePendingQueuedMessages(KEY, [entry({ content: 'old', sentAt: now - 1_000 })], now)
        prunePendingQueuedMessages(now + PENDING_QUEUED_MESSAGE_MAX_AGE_MS + 5_000)

        const raw = JSON.parse(window.localStorage.getItem('adhdev-pending-queued-messages-v1') || '{}')
        expect(raw.byKey?.[KEY]).toBeUndefined()
    })
})
