/**
 * (MULTI-QUEUE + BOTTOM-PINNING) Rendering several waiting bodies at the tail.
 *
 * The owner's report was three-part: queued messages disappear on restart, they
 * should always show at the BOTTOM, and there should be more than one of them.
 * This file covers the render half — that every waiting entry produces a bubble,
 * in FIFO order, after every delivered message, and that the echo contract still
 * retires them one-for-one rather than all-at-once.
 */

import { describe, it, expect } from 'vitest'
import {
    withPendingLocalMessages,
    withPendingLocalMessage,
    buildVisibleConversationMessages,
    type PendingLocalMessage,
} from '../../../src/components/dashboard/conversation-message-snapshot'
import type { DashboardMessage } from '../../../src/components/dashboard/types'

function msg(role: string, content: string, timestamp = 0): DashboardMessage {
    return { id: `${role}-${content}-${timestamp}`, role, content, timestamp } as unknown as DashboardMessage
}

/**
 * Fixed clock. `withPendingLocalMessages` expires entries older than
 * PENDING_LOCAL_MESSAGE_MAX_AGE_MS (120s) against `now`, so tests must pass an
 * explicit `now` — otherwise small literal timestamps read as ancient against
 * the real wall clock and every bubble is silently dropped.
 */
const NOW = 10_000_000

function pending(id: string, content: string, sentAt: number, queued = true): PendingLocalMessage {
    return { id, content, sentAt, queued }
}

function metaOf(message: DashboardMessage): Record<string, unknown> {
    return (message as unknown as { meta?: Record<string, unknown> }).meta || {}
}

describe('MULTI-QUEUE — every waiting body renders', () => {
    it('★ renders ALL queued entries, not just the newest (the single-slot defect)', () => {
        const live = [msg('assistant', 'working on it', 10)]
        const result = withPendingLocalMessages(live, [
            pending('a', 'first queued', NOW - 300),
            pending('b', 'second queued', NOW - 200),
            pending('c', 'third queued', NOW - 100),
        ], NOW)

        const pendingBubbles = result.filter(m => metaOf(m).pendingLocal === true)
        expect(pendingBubbles).toHaveLength(3)
        expect(pendingBubbles.map(m => m.content)).toEqual(['first queued', 'second queued', 'third queued'])
    })

    it('★ pins every queued bubble AFTER all delivered messages', () => {
        const live = [
            msg('user', 'earlier prompt', 1),
            msg('assistant', 'earlier answer', 2),
        ]
        const result = withPendingLocalMessages(live, [
            pending('a', 'waiting one', NOW - 200),
            pending('b', 'waiting two', NOW - 100),
        ], NOW)

        // The last two rows are the waiting ones; nothing delivered follows them.
        expect(result.map(m => m.content)).toEqual([
            'earlier prompt', 'earlier answer', 'waiting one', 'waiting two',
        ])
        expect(metaOf(result[result.length - 1]).pendingLocal).toBe(true)
        expect(metaOf(result[result.length - 2]).pendingLocal).toBe(true)
    })

    it('★ stays at the bottom even when the queued bodies are OLDER than the live tail', () => {
        // The pending overlay is applied after the chronological sort by design.
        // A stale `sentAt` must not float a still-waiting bubble up into history.
        const live = [msg('assistant', 'very recent answer', NOW + 9_000)]
        // Older than the live row, but still inside the max-age window.
        const result = withPendingLocalMessages(live, [pending('a', 'queued long ago', NOW - 100_000)], NOW)

        expect(result[result.length - 1].content).toBe('queued long ago')
    })

    it('gives each bubble a distinct id and pendingId so React keys never collide', () => {
        // Same content AND same timestamp — the exact collision `sentAt`-keyed ids had.
        const result = withPendingLocalMessages([], [
            pending('id-1', 'continue', NOW - 500),
            pending('id-2', 'continue', NOW - 500),
        ], NOW)

        expect(result).toHaveLength(2)
        expect(new Set(result.map(m => m.id)).size).toBe(2)
        expect(result.map(m => metaOf(m).pendingId)).toEqual(['id-1', 'id-2'])
    })

    it('marks queued vs not-yet-confirmed entries separately', () => {
        const result = withPendingLocalMessages([], [
            pending('a', 'parked', NOW - 200, true),
            pending('b', 'still sending', NOW - 100, false),
        ], NOW)
        expect(result.map(m => metaOf(m).queued)).toEqual([true, false])
    })
})

describe('MULTI-QUEUE — echo retirement stays one-for-one', () => {
    it('retires only the entry an echo accounts for, keeping the rest visible', () => {
        // The daemon echoed the first body; the second is still parked.
        const live = [msg('user', 'first queued', NOW - 300)]
        const result = withPendingLocalMessages(live, [
            pending('a', 'first queued', NOW - 200),
            pending('b', 'second queued', NOW - 100),
        ], NOW)

        const pendingBubbles = result.filter(m => metaOf(m).pendingLocal === true)
        expect(pendingBubbles.map(m => m.content)).toEqual(['second queued'])
    })

    it('★ two identical bodies: ONE echo retires ONE entry, not both', () => {
        // The owner queued "continue" twice. A boolean "was it echoed?" check
        // would hide both bubbles on the first echo — losing a body that is
        // genuinely still in the daemon FIFO.
        const live = [msg('user', 'continue', NOW - 300)]
        const result = withPendingLocalMessages(live, [
            pending('a', 'continue', NOW - 200),
            pending('b', 'continue', NOW - 100),
        ], NOW)

        expect(result.filter(m => metaOf(m).pendingLocal === true)).toHaveLength(1)
    })

    it('two echoes retire both identical entries', () => {
        const live = [msg('user', 'continue', NOW - 400), msg('user', 'continue', NOW - 300)]
        const result = withPendingLocalMessages(live, [
            pending('a', 'continue', NOW - 200),
            pending('b', 'continue', NOW - 100),
        ], NOW)
        expect(result.filter(m => metaOf(m).pendingLocal === true)).toHaveLength(0)
    })

    it('returns the input array unchanged when nothing is waiting (render short-circuit)', () => {
        const live = [msg('assistant', 'done', 1)]
        expect(withPendingLocalMessages(live, [], NOW)).toBe(live)
        expect(withPendingLocalMessages(live, null, NOW)).toBe(live)
    })

    it('drops entries past the max age', () => {
        const now = 1_000_000
        const result = withPendingLocalMessages([], [
            pending('old', 'expired body', now - 500_000),
            pending('new', 'fresh body', now - 1_000),
        ], now)
        expect(result.map(m => m.content)).toEqual(['fresh body'])
    })
})

describe('single-entry wrapper stays behaviour-compatible', () => {
    it('withPendingLocalMessage still appends one bubble', () => {
        const live = [msg('assistant', 'hi', 1)]
        const result = withPendingLocalMessage(live, { content: 'solo', sentAt: NOW - 100, queued: true }, NOW)
        expect(result).toHaveLength(2)
        expect(result[1].content).toBe('solo')
        expect(metaOf(result[1]).queued).toBe(true)
    })

    it('withPendingLocalMessage returns input unchanged for null/echoed/empty', () => {
        const live = [msg('user', 'echoed', 1)]
        expect(withPendingLocalMessage(live, null, NOW)).toBe(live)
        expect(withPendingLocalMessage(live, { content: '   ', sentAt: NOW - 100 }, NOW)).toBe(live)
        expect(withPendingLocalMessage(live, { content: 'echoed', sentAt: NOW - 100 }, NOW)).toBe(live)
    })
})

describe('bottom pinning composes with the visible-window builder', () => {
    it('★ queued bubbles survive windowing and remain last', () => {
        // A long tail that the window would normally slice, plus history.
        const live = Array.from({ length: 40 }, (_, i) => msg('assistant', `live-${i}`, NOW - 1_000 + i))
        const withPending = withPendingLocalMessages(live, [
            pending('a', 'queued A', NOW - 20),
            pending('b', 'queued B', NOW - 10),
        ], NOW)

        const visible = buildVisibleConversationMessages({
            historyMessages: [msg('user', 'old history', NOW - 500_000)],
            liveMessages: withPending,
            visibleLiveCount: 10,
        })

        expect(visible[visible.length - 2].content).toBe('queued A')
        expect(visible[visible.length - 1].content).toBe('queued B')
    })
})
