// rc35 UI follow-ups (mission aee6cb58): the assistant chips, the hidden-tab
// rows and the CLI Mode control meet the 44px touch-target floor on phone
// viewports with the PRODUCTION index.css in real Chromium, the hidden-tab row
// is one >=52px full-width hit area, and the audit helper warns for a control
// that falls short. Synthetic data only; no daemon.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../src/index.css'
import { initI18n } from '../../src/i18n/config'
import AssistantChipGroup from '../../src/components/AssistantChipGroup'
import DashboardHiddenConversationsList from '../../src/components/dashboard/DashboardHiddenConversationsList'
import CliViewModeToggle from '../../src/components/dashboard/CliViewModeToggle'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import { MIN_TOUCH_TARGET_PX, measureTouchTarget, warnIfBelowTouchTarget } from '../../src/utils/touch-target'

function conv(id: string, title: string, status: 'idle' | 'generating' = 'idle'): ActiveConversation {
    return {
        mode: 'chat', agentName: 'Codex', agentType: 'codex-cli', transport: 'pty', status,
        title, routeId: 'daemon-a', daemonId: 'daemon-a', sessionId: id, tabKey: `daemon-a:${id}`,
        messages: [], workspaceName: 'fixture', displayPrimary: title, displaySecondary: 'Codex · fixture',
        streamSource: 'native', connectionState: 'connected',
    } as ActiveConversation
}

function hitsItself(el: Element) {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return hit != null && (hit === el || el.contains(hit))
}

describe.each([375, 390])('touch targets at %ipx', (width) => {
    let host: HTMLDivElement
    let root: Root

    beforeEach(async () => {
        localStorage.setItem('lang', 'en')
        initI18n()
        ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
        await page.viewport(width, 844)
        host = document.createElement('div')
        host.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:24px'
        document.body.append(host)
        root = createRoot(host)
        await act(async () => root.render(
            <>
                <AssistantChipGroup
                    className="assistant-starters"
                    chipClassName="btn btn-quiet assistant-starter"
                    testId="assistant-starters"
                    chips={['What is running?', 'What is blocked?', 'What needs me?'].map(label => ({ id: label, label }))}
                    onChoose={() => new Promise(() => undefined)}
                />
                <AssistantChipGroup
                    className="chat-reply-choices self-start"
                    chipClassName="chat-reply-choice"
                    testId="chat-reply-choices"
                    chips={['Bring DesktopA online', 'Stop'].map(label => ({ id: label, label }))}
                    onChoose={vi.fn()}
                />
                <div className="mobile-room-header-row"><div className="mobile-room-header-actions flex items-center gap-1">
                    <CliViewModeToggle mode="chat" onChange={vi.fn()} />
                </div></div>
                <DashboardHiddenConversationsList
                    variant="mobile"
                    conversations={[conv('h1', 'Hidden one', 'generating'), conv('h2', 'Hidden two')]}
                    onOpenConversation={vi.fn()}
                />
            </>,
        ))
    })

    afterEach(async () => {
        await act(async () => root.unmount())
        host.remove()
    })

    it('every chip, the Mode control and every hidden-tab row reach 44×44 and hit-test to themselves', () => {
        const targets = [
            ...host.querySelectorAll('[data-chip-id]'),
            host.querySelector('.cli-view-mode-toggle')!,
            ...host.querySelectorAll('[data-testid="hidden-conversation-open"]'),
        ]
        expect(targets.length).toBe(8)
        for (const el of targets) {
            const m = measureTouchTarget(el)
            expect(m.ok, `${el.textContent || el.getAttribute('aria-label')}: ${m.width}×${m.height}`).toBe(true)
            expect(hitsItself(el)).toBe(true)
        }
    })

    it('hidden-tab rows are one full-width button of at least 52px with the spinner on the left', () => {
        for (const row of host.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]')) {
            const button = row.querySelector<HTMLElement>('[data-testid="hidden-conversation-open"]')!
            const rowRect = row.getBoundingClientRect()
            const rect = button.getBoundingClientRect()
            expect(rect.height).toBeGreaterThanOrEqual(52)
            expect(Math.abs(rect.width - rowRect.width)).toBeLessThanOrEqual(2)
            expect(Math.abs(rect.height - rowRect.height)).toBeLessThanOrEqual(2)
        }
        const generating = host.querySelector('[data-session-id="h1"] [data-testid="hidden-conversation-leading"]')!
        const title = host.querySelector('[data-session-id="h1"] .dashboard-header-inbox-item-title')!
        expect(generating.children.length).toBe(1)
        expect(generating.getBoundingClientRect().right).toBeLessThanOrEqual(title.getBoundingClientRect().left)
    })

    it('a pending starter chip keeps its Cancel reachable at 44px', async () => {
        const chip = host.querySelector<HTMLButtonElement>('[data-testid="assistant-starters"] [data-chip-id]')!
        await act(async () => chip.click())
        const cancel = host.querySelector('[data-testid="assistant-starters"] [data-testid="assistant-chip-cancel"]')!
        expect(measureTouchTarget(cancel).ok).toBe(true)
        expect(hitsItself(cancel)).toBe(true)
    })

    it('warns for a control below the floor', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const small = document.createElement('button')
        small.style.cssText = 'width:30px;height:30px;padding:0'
        host.append(small)
        expect(MIN_TOUCH_TARGET_PX).toBe(44)
        expect(warnIfBelowTouchTarget(small, 'probe')).toBe(false)
        expect(warn).toHaveBeenCalledTimes(1)
        warn.mockRestore()
    })
})
