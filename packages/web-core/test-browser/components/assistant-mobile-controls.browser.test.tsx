import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import { initI18n } from '../../src/i18n/config'
import DashboardMobileChatRoom from '../../src/components/dashboard/DashboardMobileChatRoom'
import InteractivePromptModal from '../../src/components/interactive-prompt/InteractivePromptModal'
import PaneGroupContent from '../../src/components/dashboard/PaneGroupContent'
import { TransportProvider } from '../../src/context/TransportContext'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { DashboardConversationCommands } from '../../src/hooks/useDashboardConversationCommands'

// All state is public-neutral and local to the browser. No daemon or live transcript transport.
vi.mock('../../src/components/dashboard/session-chat-hooks', () => ({
    useSessionChatController: () => null,
    useWarmSessionChatControllers: () => {},
    useWarmSessionChatSnapshotVersion: () => 0,
}))
vi.mock('../../src/components/dashboard/session-chat-controller', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/components/dashboard/session-chat-controller')>()),
    useSessionChatController: (conversation: ActiveConversation) => ({
        liveMessages: conversation.messages, hasLiveSnapshot: true, historyMessages: [],
        hasMoreHistory: false, historyError: null, loadHistoryPage: async () => {},
    }),
}))
vi.mock('../../src/components/dashboard/CliTerminalPane', () => ({ default: () => <div>Terminal fixture</div> }))
const promptState = vi.hoisted(() => ({ promptSession: null as any, hasActivePrompt: false }))
vi.mock('../../src/hooks/useInteractivePrompt', () => ({
    useInteractivePrompt: () => ({ ...promptState, isSubmitting: false, responseError: null,
        submit: async () => {}, cancel: () => {}, reopen: () => {} }),
}))

function rect(element: Element) {
    const { x, y, width, height, right, bottom } = element.getBoundingClientRect()
    return { x, y, width, height, right, bottom }
}
function overlaps(a: Element, b: Element) {
    const r = rect(a), s = rect(b)
    return r.x < s.right && s.x < r.right && r.y < s.bottom && s.y < r.bottom
}

it('keeps assistant policy, staged approval and transcript folding distinct at iPhone and desktop widths', async () => {
    localStorage.setItem('lang', 'en')
    localStorage.removeItem('adhdev_assistant_activity_visible')
    initI18n()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    const sendCommand = vi.fn(async (_daemon: string, command: string) => {
        if (command === 'assistant_execution_state') return { success: true, executionEnabled: true,
            executionAvailable: true, restriction: 'enforced', choices: [], limitations: 'Local PTY permissions only.' }
        if (command === 'assistant_staged_resolve') return { success: true, memory: [{ id: 'synthetic-write', createdAt: '2026-10-01T00:00:00Z', origin: 'owner',
            op: { action: 'add', target: 'memory', content: 'Use concise project notes.' } }], skills: [], notes: [] }
        if (command === 'assistant_threads') return { success: true, threads: [], followedRemoteProjects: [] }
        throw new Error(`Unexpected synthetic command: ${command}`)
    })
    const conversation = { routeId: 'synthetic-machine', daemonId: 'synthetic-machine',
        sessionId: 'synthetic-assistant', tabKey: 'synthetic-tab', assistant: true, transport: 'pty',
        mode: 'chat', agentName: 'Codex', agentType: 'codex-cli', status: 'idle', title: 'Assistant',
        displayPrimary: 'Assistant', displaySecondary: 'Codex', workspaceName: 'Public example', machineName: 'Synthetic machine with an exceptionally long public neutral label',
        connectionState: 'connected', messages: [
            ...Array.from({ length: 124 }, (_, i) => ({ id: `step-${i}`, role: 'tool', kind: 'tool',
                content: `Synthetic tool step ${i}`, timestamp: 1000 + i, toolName: 'Read' })),
            { id: 'answer', role: 'assistant', content: 'The public example is ready for review.', timestamp: 2000 },
        ],
    } as ActiveConversation
    const commands = { handleSendChat: vi.fn(async () => true), handleModalButton: vi.fn(),
        handleFocusAgent: vi.fn(), handleRelaunch: vi.fn() } as unknown as DashboardConversationCommands
    const host = document.createElement('div')
    host.style.cssText = 'height:100dvh;display:flex;flex-direction:column'
    document.body.append(host)
    const root = createRoot(host)
    async function render(mobile: boolean, terminal = false) {
        const activeConv = { ...conversation }
        await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><TransportProvider value={{ sendCommand }}>
            {mobile ? <DashboardMobileChatRoom selectedConversation={activeConv} isStandalone={false} onStopCli={vi.fn()} actionLogs={[]}
                commands={commands} onBack={() => {}} onOpenNativeConversation={() => {}}
                onOpenMachine={() => {}} onOpenHistory={() => {}} onOpenRemote={() => {}}
                cliViewMode={terminal ? "terminal" : "chat"} onSetCliViewMode={() => {}} />
                : <><PaneGroupContent activeConv={activeConv} clearToken={0} isCliTerminal={false}
                    terminalRef={{ current: null }} commands={commands} actionLogs={[]} />
                    <InteractivePromptModal promptSession={promptState.promptSession} isSubmitting={false}
                        error={null} onSubmit={async () => {}} onCancel={() => {}} /></>}
        </TransportProvider></MemoryRouter>))
    }
    try {
        for (const width of [375, 390, 1280]) {
            await page.viewport(width, 844)
            await render(width < 768)
            const buttons = [...host.querySelectorAll('button')]
            const execution = buttons.filter(b => b.textContent === 'Assistant actions: on')
            const fold = buttons.find(b => b.textContent?.includes('Tool steps'))!
            const pending = host.querySelector('[data-assistant-staged-count] button')!
            expect(execution).toHaveLength(1)
            expect(pending.textContent).toContain('1 pending')
            expect(pending.getAttribute('aria-label')).toContain('approval')
            if (width < 768) {
                const header = host.firstElementChild!
                expect(header.contains(execution[0])).toBe(false)
                expect(header.contains(pending)).toBe(false)
                expect(header.contains(fold)).toBe(false)
                const activityBar = host.querySelector('.assistant-chat-activity-bar')!
                expect(activityBar.contains(execution[0])).toBe(true)
                expect(activityBar.contains(pending)).toBe(true)
                expect(activityBar.contains(fold)).toBe(true)
                const cluster = activityBar.querySelector('.assistant-session-controls')!
                expect(cluster.contains(execution[0])).toBe(true)
                expect(cluster.contains(pending)).toBe(true)
                expect(header.children).toHaveLength(1)
                const meta = header.querySelector('.mobile-room-header-meta') as HTMLElement
                expect(meta).not.toBeNull()
                expect(getComputedStyle(meta).textOverflow).toBe('ellipsis')
                expect(meta.getBoundingClientRect().right).toBeLessThanOrEqual(width)
                expect(meta.scrollWidth).toBeGreaterThan(meta.clientWidth)
                const stop = header.querySelector('button[title="Stop CLI process"]')!
                expect(stop).not.toBeNull()
                expect(rect(stop).height).toBeGreaterThanOrEqual(36)
                expect(rect(header.querySelector('button[aria-label="Back"]')!).height).toBeGreaterThanOrEqual(36)
                const title = header.querySelector('.truncate')!
                expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth)
                expect(overlaps(title, execution[0])).toBe(false)
                expect(overlaps(title, pending)).toBe(false)
            }
            expect(fold.textContent).toContain('124')
            expect(fold.getAttribute('aria-pressed')).toBe('false')
            const mobile = width < 768
            const assertTarget = (el: Element, touch = mobile) => {
                const r = rect(el)
                expect(r.x).toBeGreaterThanOrEqual(0)
                expect(r.right).toBeLessThanOrEqual(width)
                expect(r.y).toBeGreaterThanOrEqual(0)
                expect(r.bottom).toBeLessThanOrEqual(844)
                if (touch) { expect(r.width).toBeGreaterThanOrEqual(30); expect(r.height).toBeGreaterThanOrEqual(30) }
                expect(el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))).toBe(true)
            }
            const assertNoOverlap = () => {
                const targets = [execution[0], pending, fold]
                targets.forEach(el => assertTarget(el))
                for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
                    expect(overlaps(targets[i], targets[j])).toBe(false)
                }
                const input = host.querySelector('textarea')!
                targets.forEach(el => expect(overlaps(el, input)).toBe(false))
                const frame = host.querySelector('.chat-scroll-frame')!
                for (const bubble of host.querySelectorAll('.chat-bubble, .chat-msg-tool')) {
                    const b = rect(bubble), f = rect(frame)
                    if (b.y >= f.y && b.bottom <= f.bottom) {
                        targets.forEach(el => expect(overlaps(el, bubble)).toBe(false))
                    }
                }
                if (mobile) {
                    const frameY = rect(host.querySelector('.chat-scroll-frame')!).y
                    expect(rect(fold).bottom).toBeLessThanOrEqual(frameY)
                    expect(rect(execution[0]).bottom).toBeLessThanOrEqual(frameY)
                    expect(rect(pending).bottom).toBeLessThanOrEqual(frameY)
                }
            }
            assertNoOverlap()
            console.log(JSON.stringify({ width, execution: rect(execution[0]), fold: rect(fold), pending: rect(pending),
                scrollFrame: rect(host.querySelector('.chat-scroll-frame')!), input: rect(host.querySelector('textarea')!) }))
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-after-${width}.png` }) })

            // Folding only changes transcript visibility, never policy or staged writes.
            await act(async () => fold.click())
            expect(fold.getAttribute('aria-pressed')).toBe('true')
            expect(host.textContent).toContain('Synthetic tool step')
            assertNoOverlap()
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-expanded-${width}.png` }) })
            await act(async () => fold.click())
            expect(host.textContent).not.toContain('Synthetic tool step')
            expect(execution[0].textContent).toBe('Assistant actions: on')
            expect(pending.textContent).toContain('1 pending')

            await act(async () => execution[0].click())
            const executionPanel = host.querySelector('.assistant-execution-panel')!
            expect(executionPanel.getAttribute('aria-label')).toBe('Assistant permissions')
            // This fixture has no live provider permission. Opening the controls
            // must not invent a selectable response or authorize an empty choice.
            expect(executionPanel.textContent).toContain('No live permission requests are available to choose here.')
            expect(executionPanel.querySelectorAll('input[type="radio"]')).toHaveLength(0)
            expect(executionPanel.querySelector('select')).toBeNull()
            const sendResponse = [...executionPanel.querySelectorAll('button')].find(b => b.textContent === 'Send response to assistant')
            expect(sendResponse).toBeUndefined()
            expect(executionPanel.textContent).not.toMatch(/PTY|enforced|prompt_only|ratification/)
            // The current panel scrolls on small screens. Every control must be
            // reachable inside it and retain the same size and hit-test checks.
            for (const el of executionPanel.querySelectorAll('button, label:has(input[type="radio"])')) {
                await act(async () => el.scrollIntoView({ block: 'nearest' }))
                assertTarget(el, false)
                expect(rect(el).y).toBeGreaterThanOrEqual(rect(executionPanel).y)
                expect(rect(el).bottom).toBeLessThanOrEqual(rect(executionPanel).bottom)
            }
            if (mobile) expect(rect(executionPanel).bottom).toBeLessThanOrEqual(rect(host.querySelector('.chat-scroll-frame')!).y)
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-policy-${width}.png` }) })
            await act(async () => execution[0].click())
            await act(async () => pending.click())
            const stagedPanel = host.querySelector('.assistant-staged-panel')!
            expect(stagedPanel.textContent).toContain('Use concise project notes.')
            for (const el of stagedPanel.querySelectorAll('button')) assertTarget(el, false)
            if (mobile) expect(rect(stagedPanel).bottom).toBeLessThanOrEqual(rect(host.querySelector('.chat-scroll-frame')!).y)
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-staged-${width}.png` }) })
            await act(async () => pending.click())

            conversation.status = 'generating'
            await render(mobile)
            const input = host.querySelector('textarea')!
            expect(input.getAttribute('placeholder')).toContain('generating')
            expect(host.querySelector('.chat-typing-wrapper')).not.toBeNull()
            assertNoOverlap()
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-generating-${width}.png` }) })

            conversation.status = 'waiting_approval'
            conversation.modalButtons = ['Approve', 'Reject']
            conversation.modalMessage = 'Allow a synthetic public example edit?'
            await render(mobile)
            const approval = [...host.querySelectorAll('button')].find(b => b.textContent === 'Approve')!
            assertTarget(approval, false)
            expect(overlaps(approval, host.querySelector('.assistant-chat-activity-bar')!)).toBe(false)
            await act(async () => approval.click())
            expect(commands.handleModalButton).toHaveBeenCalled()
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-approval-${width}.png` }) })

            promptState.hasActivePrompt = true
            promptState.promptSession = { title: 'Public example question', providerType: 'codex-cli',
                sessionId: 'synthetic-assistant', daemonId: 'synthetic-machine', prompt: {
                    promptId: 'synthetic-question', origin: 'cli', providerType: 'codex-cli', createdAt: 0,
                    questions: [{ questionId: 'format', question: 'Choose a public example format', multiSelect: false,
                        options: [{ label: 'Short', description: 'A concise example.' }, { label: 'Detailed' }] }],
                } }
            await render(mobile)
            const dialog = document.querySelector('[role="dialog"]')!
            expect(dialog.textContent).toContain('Choose a public example format')
            const options = [...dialog.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
            expect(options).toHaveLength(2)
            expect(options[0].textContent).toContain('Short')
            expect(options[1].textContent).toContain('Detailed')
            expect(options.every(option => option.getAttribute('aria-checked') === 'false')).toBe(true)
            const option = options[0]
            assertTarget(option, false)
            await act(async () => (option as HTMLButtonElement).click())
            expect(option.getAttribute('aria-checked')).toBe('true')
            expect(options[1].getAttribute('aria-checked')).toBe('false')
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
            const submit = [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Submit')!
            expect(submit.disabled).toBe(false)
            assertTarget(submit, false)
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-question-${width}.png` }) })
            promptState.hasActivePrompt = false
            promptState.promptSession = null
            conversation.status = 'idle'
            conversation.modalButtons = []
            conversation.modalMessage = undefined
            if (mobile) {
                await render(true, true)
                expect([...host.querySelectorAll('button')].filter(b => b.textContent === 'Assistant actions: on')).toHaveLength(1)
                expect(host.querySelector('[data-assistant-staged-count]')).not.toBeNull()
                await act(async () => { await page.screenshot({ path: `/tmp/assistant-mobile-controls-terminal-${width}.png` }) })
            }
            expect(commands.handleSendChat).not.toHaveBeenCalled()
            expect(sendCommand.mock.calls.every(([, command]) => ['assistant_execution_state', 'assistant_staged_resolve', 'assistant_threads'].includes(command))).toBe(true)
        }
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})
