// @vitest-environment jsdom
/**
 * Notice chips open on tap (touch screens never see a tooltip), and several
 * notices from one delivery fold into one line (2026-10-18 assistant review).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { ChatMessageRow } from '../../src/components/ChatMessageList/chatMessageBubbles'
import { buildMissedReportsLine, buildStallSignal } from '../../../daemon-core/src/assistant/assistant-relay-format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose props for render helpers
type Loose = ComponentType<any>
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

function render(content: string) {
    act(() => root.render(createElement(ChatMessageRow as Loose, {
        message: { role: 'user', content }, receivedAt: 1, agentName: 'Claude', userName: 'You', isCliMode: true,
        isTextExpanded: false, onToggleTextExpanded: () => {},
    })))
}
const toggles = () => [...container.querySelectorAll<HTMLButtonElement>('.chat-notice-chip-toggle')]

describe('notice chips', () => {
    it('a single notice shows its full original text when tapped', () => {
        render(buildStallSignal('api', { pending: 1, activeMissions: 2 }))
        expect(container.querySelector('.chat-notice-detail')).toBeNull()
        act(() => toggles()[0]!.click())
        expect(container.querySelector('.chat-notice-detail')?.textContent).toContain('Check project_status and project_read')
    })

    it('a run of notices folds into one line and opens into each notice', () => {
        render([buildStallSignal('a', { pending: 1, activeMissions: 2 }), buildStallSignal('b', { pending: 0, activeMissions: 1 }), buildMissedReportsLine([{ slug: 'a', count: 3 }])].join('\n\n'))
        expect(toggles()).toHaveLength(1)
        expect(container.textContent).toContain('3 notices')
        act(() => toggles()[0]!.click())
        expect(toggles()).toHaveLength(3)
        expect(container.textContent).toContain('Hide 3 notices')
    })
})
