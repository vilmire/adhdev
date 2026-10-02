// @vitest-environment jsdom
/**
 * Mesh events reach a PTY-hosted coordinator as typed input, so the coordinator's
 * transcript records them as USER turns ("[System] Node 'node_…' has completed its
 * task …"). Rendered as user bubbles they read as the owner talking, and a worker's
 * full completion report filled the chat column (2026-10-02 landing capture).
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMessageRow, isMeshInjectedSystemText } from '../../src/components/ChatMessageList/chatMessageBubbles'

function render(content: string) {
    return renderToStaticMarkup(
        React.createElement(ChatMessageRow, {
            message: { role: 'user', content, kind: 'standard' },
            receivedAt: 1_700_000_000_000,
            agentName: 'Claude Code',
            userName: 'You',
            isCliMode: true,
            isTextExpanded: false,
            onToggleTextExpanded: () => {},
        } as any),
    )
}

const REPORT = "[System] Node 'node_d5a62b448dd14cf0af78453d740d6095' has completed its task and is now idle (session_id=9ccc65a6; provider=claude-cli). " + 'Summary: '.padEnd(400, 'x')

describe('mesh-injected [System] user turns', () => {
    it('render as a compact system row, not a user bubble', () => {
        const html = render(REPORT)
        expect(html).toContain('chat-msg-system')
        expect(html).not.toContain('chat-bubble-user')
        expect(html).not.toContain('>You<')
        // Long reports start collapsed (the system-row preview cap), with the toggle.
        expect(html).toContain('is now idle (sessio…<button')
        expect(html).toContain('chat-msg-system-expand')
    })

    it('leave the owner\'s own messages as user bubbles', () => {
        const html = render('How are the two workers doing?')
        expect(html).toContain('chat-bubble-user')
        expect(html).not.toContain('chat-msg-system')
    })

    it('only match the tag at the start of the message', () => {
        expect(isMeshInjectedSystemText('[System] progress on task t1')).toBe(true)
        expect(isMeshInjectedSystemText('please explain what [System] means')).toBe(false)
        expect(isMeshInjectedSystemText('[System]no-space')).toBe(false)
    })
})
