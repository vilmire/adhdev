// @vitest-environment jsdom
/**
 * (QUEUED-SEND-CANCEL) The Cancel affordance renders INSIDE the queued bubble.
 *
 * Same architectural reason as the Send now button next to it: placing the
 * control in `ChatMessageRow` gives every layout the feature at once — desktop
 * dockview, mobile panes, mobile chat room, remote dialog, standalone and cloud
 * all funnel through ChatPane → ChatMessageList → ChatMessageRow. A per-layout
 * button would need adding six times and would be missed at least once (see
 * PANE-GROUP-CONTENT-SEND-NOW-DRIFT).
 *
 * ★ The pendingId requirement is deliberate and load-bearing: cancelling is
 * destructive and must address exactly ONE queue entry. A bubble carrying no id
 * renders no Cancel button rather than risking a cancel that lands on whichever
 * entry the hook happens to consider current.
 */
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMessageRow, buildChatMessageRowSignature } from '../../src/components/ChatMessageList/chatMessageBubbles'
import { withPendingLocalMessages } from '../../src/components/dashboard/conversation-message-snapshot'

const SENT_AT = 1_700_000_000_000

function pendingBubble(queued: boolean, id = 'entry-1') {
    const [msg] = withPendingLocalMessages(
        [],
        [{ id, content: 'urgent: stop', sentAt: SENT_AT, queued }],
        SENT_AT + 10,
    )
    return msg as any
}

function render(message: any, extra: Record<string, unknown> = {}) {
    return renderToStaticMarkup(
        React.createElement(ChatMessageRow, {
            message,
            receivedAt: SENT_AT,
            agentName: 'Claude',
            userName: 'You',
            isCliMode: false,
            isTextExpanded: false,
            onToggleTextExpanded: () => {},
            ...extra,
        } as any),
    )
}

describe('CANCEL bubble affordance', () => {
    it('★ renders a Cancel button on a QUEUED pending bubble', () => {
        const html = render(pendingBubble(true), { onSendNow: vi.fn(), onCancelQueued: vi.fn() })

        expect(html).toContain('chat-bubble-cancel-queued')
        expect(html).toContain('Cancel')
        // Send now stays — cancel is an ADDITION, not a replacement.
        expect(html).toContain('chat-bubble-send-now')
        expect(html).toContain('Send now')
    })

    it('renders NO cancel affordance on a bubble that is not queued', () => {
        const html = render(pendingBubble(false), { onCancelQueued: vi.fn() })
        expect(html).not.toContain('chat-bubble-cancel-queued')
    })

    it('renders no cancel affordance for a read-only viewer that passes no handler', () => {
        // SessionShare renders the badge without controls.
        const html = render(pendingBubble(true), {})
        expect(html).not.toContain('chat-bubble-cancel-queued')
    })

    it('★ renders no Cancel when the bubble carries no pendingId', () => {
        // Destructive + unaddressable = must not render, rather than guess.
        const message = pendingBubble(true)
        delete message.meta.pendingId
        const html = render(message, { onCancelQueued: vi.fn() })

        expect(html).not.toContain('chat-bubble-cancel-queued')
        // The queued badge itself is unaffected.
        expect(html).toContain('chat-bubble-queued')
    })

    it('disables Cancel while a send-now is in flight', () => {
        const html = render(pendingBubble(true), { onCancelQueued: vi.fn(), isSendingNow: true })
        expect(html).toContain('chat-bubble-cancel-queued')
        expect(html).toContain('disabled')
    })
})

describe('row signature distinguishes queue entries', () => {
    it('★ two entries with identical content AND timestamp hash differently', () => {
        // The exact collision that made one bubble stand in for two: same body
        // queued twice. Without pendingId in the signature the memo renders one
        // row for both.
        const first = pendingBubble(true, 'entry-1')
        const second = pendingBubble(true, 'entry-2')

        expect(first.content).toBe(second.content)
        expect(first.timestamp).toBe(second.timestamp)
        expect(buildChatMessageRowSignature(first)).not.toBe(buildChatMessageRowSignature(second))
    })

    it('the queued flip still changes the signature (SEND-NOW badge appearance)', () => {
        expect(buildChatMessageRowSignature(pendingBubble(false)))
            .not.toBe(buildChatMessageRowSignature(pendingBubble(true)))
    })
})
