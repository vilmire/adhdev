// @vitest-environment jsdom
/**
 * SEND-NOW: the queued badge and its button render INSIDE the optimistic bubble.
 *
 * ★ Why this matters beyond "does the button appear": placing the affordance in
 * `ChatMessageRow` is what gives every layout the feature at once — desktop
 * dockview, mobile pane workspace, mobile chat room, remote dialog, standalone
 * and cloud all funnel through ChatPane → ChatMessageList → ChatMessageRow. A
 * per-layout button would have to be added six times and would be missed at
 * least once (see PANE-GROUP-CONTENT-SEND-NOW-DRIFT).
 *
 * ★ The memo-signature test below is the non-obvious one. `buildChatMessageRowSignature`
 * decides whether a row re-renders, and the queued flip changes ONLY
 * `meta.queued` — same id, same content, same sentAt. Before `meta.queued` was
 * folded into the signature the badge could never appear at all: the hook
 * flipped the flag, a new message object was produced, and the memo compared
 * two identical signatures and suppressed the render.
 */
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMessageRow, buildChatMessageRowSignature } from '../../src/components/ChatMessageList/chatMessageBubbles'
import { withPendingLocalMessage } from '../../src/components/dashboard/conversation-message-snapshot'

const SENT_AT = 1_700_000_000_000

function pendingBubble(queued: boolean) {
    const [msg] = withPendingLocalMessage([], { content: 'urgent: stop', sentAt: SENT_AT, queued }, SENT_AT + 10)
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

describe('SEND-NOW bubble affordance', () => {
    it('★ renders the queued badge and the Send now button on a QUEUED pending bubble', () => {
        const html = render(pendingBubble(true), { onSendNow: vi.fn() })

        expect(html).toContain('urgent: stop')
        expect(html).toContain('Waiting to send')
        expect(html).toContain('Send now')
        // The lost turn is disclosed on the control itself, before the press.
        expect(html).toContain('turn in progress will be lost')
    })

    it('renders NEITHER on a pending bubble that was submitted, not queued', () => {
        const html = render(pendingBubble(false), { onSendNow: vi.fn() })

        expect(html).toContain('urgent: stop')
        expect(html).not.toContain('Waiting to send')
        expect(html).not.toContain('Send now')
    })

    it('renders the badge but NO button for a read-only host that passes no handler', () => {
        // packages/web-cloud/src/pages/SessionShare.tsx renders ChatMessageRow
        // directly with no command surface; it must still compile and render.
        const html = render(pendingBubble(true))

        expect(html).toContain('Waiting to send')
        expect(html).not.toContain('Send now')
    })

    it('disables the button while a send-now is in flight', () => {
        const html = render(pendingBubble(true), { onSendNow: vi.fn(), isSendingNow: true })

        expect(html).toContain('disabled')
        expect(html).toContain('Sending…')
    })

    it('leaves an ordinary assistant message untouched', () => {
        const html = render({ id: 'a1', role: 'assistant', kind: 'standard', content: 'done' })

        expect(html).not.toContain('Waiting to send')
        expect(html).not.toContain('Send now')
    })

    it('★ the memo signature CHANGES on the queued flip (else the badge never appears)', () => {
        // Same content, same sentAt, same id — only meta.queued differs. This is
        // exactly the transition the hook performs.
        const before = buildChatMessageRowSignature(pendingBubble(false) as any)
        const after = buildChatMessageRowSignature(pendingBubble(true) as any)

        expect(before).not.toBe(after)
    })
})
