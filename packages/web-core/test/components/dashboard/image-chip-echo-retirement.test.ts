/**
 * (IMAGE-TRIPLE-BUBBLE ①) Optimistic-bubble retirement for IMAGE sends.
 *
 * Live defect (2026-09-23): sending text + an image produced a permanent
 * text-only ghost bubble. The daemon delivers the built prompt and claude-cli
 * rewrites the transcript echo into a paste chip plus the typed text —
 * "[Image #2]그게…" — so the exact-content echo match could never retire the
 * pending entry "그게…". The daemon's own runtime ack renders the same send as
 * "[image: image/png]\n그게…" (content-free marker, see buildCliInputAckText).
 *
 * The fix recognises a LEADING run of exactly those two token shapes and
 * requires the remainder to equal the pending body EXACTLY. These tests pin
 * both directions: the two real echo shapes retire the bubble (revert the fix
 * → red), and the match does not go loose (a non-chip prefix, a chip echo with
 * different trailing text, or a mid-body chip must never retire).
 */
import { describe, expect, it } from 'vitest'
import {
    hasEchoedPendingMessage,
    retirePendingLocalMessages,
    withPendingLocalMessages,
    type PendingLocalMessage,
} from '../../../src/components/dashboard/conversation-message-snapshot'
import type { DashboardMessage } from '../../../src/components/dashboard/types'

function userEcho(content: string, id = `echo-${content}`): DashboardMessage {
    return { id, role: 'user', content, receivedAt: 2_000 } as unknown as DashboardMessage
}

function pendingEntry(content: string, id = `pending-${content}`): PendingLocalMessage {
    return { id, content, sentAt: 1_000 }
}

const NOW = 10_000

describe('image-chip echo retirement (IMAGE-TRIPLE-BUBBLE ①)', () => {
    it('★ retires the pending body when the CLI echo carries a leading [Image #N] paste chip', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('그게 관통되는거 흐릿해서')],
            [userEcho('[Image #2]그게 관통되는거 흐릿해서')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(1)
        expect(result.entries).toEqual([])
    })

    it('★ retires when the echo is the daemon ack shape — [image: <mime>] marker line + text', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('describe this screenshot')],
            [userEcho('[image: image/png]\ndescribe this screenshot')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(1)
        expect(result.entries).toEqual([])
    })

    it('handles a run of several chips (multi-image send)', () => {
        expect(hasEchoedPendingMessage(
            [userEcho('[Image #1][Image #2]compare these')],
            pendingEntry('compare these'),
        )).toBe(true)
    })

    it('plain exact-match retirement still works unchanged', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('continue')],
            [userEcho('continue')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(1)
    })

    it('★ does NOT go loose: a non-chip prefix never retires', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('deploy it')],
            [userEcho('please deploy it')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(0)
        expect(result.entries).toHaveLength(1)
    })

    it('★ does NOT retire when the text after the chip differs from the pending body', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('그게 관통되는거')],
            [userEcho('[Image #1]완전히 다른 메시지')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(0)
    })

    it('does NOT strip a chip that is not leading — mid-body brackets are user content', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('body')],
            [userEcho('prefix [Image #1] body')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(0)
    })

    it('an echo that is ONLY chips retires nothing', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('caption')],
            [userEcho('[Image #1]')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(0)
    })

    it('★ one chip echo retires exactly ONE of two identical pending bodies', () => {
        const result = retirePendingLocalMessages(
            [pendingEntry('same text', 'p1'), pendingEntry('same text', 'p2')],
            [userEcho('[Image #1]same text')],
            NOW,
        )
        expect(result.retiredByEcho).toBe(1)
        expect(result.entries).toHaveLength(1)
    })

    it('render-time suppression (withPendingLocalMessages) recognises the chip echo too', () => {
        const live = [userEcho('[Image #3]ship it')]
        const out = withPendingLocalMessages(live, [pendingEntry('ship it')], NOW)
        // The echo accounts for the entry — no extra optimistic bubble appended.
        expect(out).toBe(live)
    })
})
