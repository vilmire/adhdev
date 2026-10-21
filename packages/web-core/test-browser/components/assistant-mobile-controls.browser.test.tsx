import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import { initI18n } from '../../src/i18n/config'
import DashboardMobileChatRoom from '../../src/components/dashboard/DashboardMobileChatRoom'
import InteractivePromptModal from '../../src/components/interactive-prompt/InteractivePromptModal'
import PaneGroupContent from '../../src/components/dashboard/PaneGroupContent'
import { BaseDaemonProvider, useBaseDaemonActions } from '../../src/context/BaseDaemonContext'
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

function SeedRemoteDaemons() {
    const { injectEntries } = useBaseDaemonActions()
    useEffect(() => {
        const approval = {
            source: 'provider_modal',
            type: 'tool_permission',
            evidence: 'live',
            lifecycle: 'pending',
            resolvedAt: null,
            modalKey: 'modal-one',
            attemptId: 'attempt-one',
            generation: 7,
            actionable: true,
            sessionId: 'worker-1',
            meshId: 'mesh-coord-1',
            buttons: ['Allow once'],
        }
        injectEntries([
            { id: 'remote-host-1', type: 'adhdev-daemon', status: 'online', hostname: 'Remote Mac', timestamp: 1 } as any,
            { id: 'synthetic-machine', type: 'adhdev-daemon', status: 'online', hostname: 'Local Mac', timestamp: 1 } as any,
            {
                id: 'synthetic-machine:cli:worker-1',
                daemonId: 'synthetic-machine',
                machineId: 'synthetic-machine',
                sessionId: 'worker-1',
                transport: 'pty',
                hostname: 'Local Mac',
                status: 'waiting_approval',
                timestamp: 1,
                activeChat: {
                    title: 'Worker task',
                    status: 'waiting_approval',
                    providerApproval: approval,
                    activeModal: { message: 'Run scoped verification?', buttons: ['Allow once'] },
                },
            } as any,
        ])
    }, [injectEntries])
    return null
}

it('expands mobile touch hit targets to 44px via pseudo-elements while preserving compact visual bounds at 390x844', async () => {
    localStorage.setItem('lang', 'en')
    localStorage.removeItem('adhdev_assistant_activity_visible')
    initI18n()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

    const sendCommand = vi.fn(async (targetDaemon: string, command: string) => {
        if (command === 'assistant_execution_state') {
            return {
                success: true,
                executionEnabled: true,
                executionAvailable: true,
                restriction: 'enforced',
                choices: [
                    {
                        meshId: 'mesh-coord-1',
                        targetSessionId: 'worker-1',
                        action: 'approve',
                        button: 'Allow once',
                        modalIdentity: 'exact-modal',
                        label: 'Worker 1',
                        message: 'Run scoped verification?',
                    },
                ],
            }
        }
        if (command === 'assistant_staged_resolve') {
            return {
                success: true,
                memory: [
                    {
                        id: 'staged-1',
                        createdAt: '2026-10-01T00:00:00Z',
                        origin: 'owner',
                        op: { action: 'add', target: 'memory', content: 'Keep touch targets 44px.' },
                    },
                ],
                skills: [],
                notes: [],
            }
        }
        if (command === 'assistant_threads') {
            return {
                success: true,
                threads: [
                    {
                        meshId: 'mesh-followed-1',
                        project: 'AlphaRepo',
                        openedAt: 1000,
                        lastSendAt: 2000,
                        hosting: 'remote_followed',
                        hostDaemonId: 'remote-host-1',
                        hostLabel: 'Remote Mac',
                        canonicalKey: 'remote-host-1::mesh-followed-1',
                    },
                ],
                followedRemoteProjects: [],
            }
        }
        if (command === 'assistant_remote_project_catalog') {
            return {
                success: true,
                hostDaemonId: targetDaemon,
                projects: [
                    {
                        hostDaemonId: targetDaemon,
                        meshId: 'mesh-catalog-2',
                        name: 'BetaRepo',
                        sanitizedRepoIdentity: 'github.com/acme/beta-repo',
                        coordinatorState: 'idle',
                        capabilities: { status: true, read: true, poll: true, report: true, send: true },
                        observedAt: '2026-10-20T00:00:00.000Z',
                    },
                ],
            }
        }
        return { success: true }
    })

    const conversation = {
        routeId: 'synthetic-machine',
        daemonId: 'synthetic-machine',
        sessionId: 'synthetic-assistant',
        tabKey: 'synthetic-tab',
        assistant: true,
        transport: 'pty',
        mode: 'chat',
        agentName: 'Codex',
        agentType: 'codex-cli',
        status: 'idle',
        title: 'Assistant',
        displayPrimary: 'Assistant',
        displaySecondary: 'Codex',
        workspaceName: 'Public example',
        machineName: 'Local Mac',
        connectionState: 'connected',
        coordinator: { meshId: 'mesh-coord-1' },
        messages: [
            { id: 'step-1', role: 'tool', kind: 'tool', content: 'Tool step 1', timestamp: 1000, toolName: 'Read' },
            { id: 'answer', role: 'assistant', content: 'Ready.', timestamp: 2000 },
        ],
    } as ActiveConversation

    const commands = {
        handleSendChat: vi.fn(async () => true),
        handleModalButton: vi.fn(),
        handleFocusAgent: vi.fn(),
        handleRelaunch: vi.fn(),
    } as unknown as DashboardConversationCommands

    const host = document.createElement('div')
    host.style.cssText = 'height:100dvh;display:flex;flex-direction:column'
    document.body.append(host)
    const root = createRoot(host)

    function assertHitExpansion(
        el: Element,
        expectedVisual: { width?: number; height: number },
        pad: { top: number; bottom: number; left: number; right: number },
        minHit: { width: number; height: number } = { width: 44, height: 44 },
    ) {
        const r = rect(el)
        if (expectedVisual.width !== undefined) {
            expect(Math.round(r.width)).toBe(expectedVisual.width)
        } else {
            expect(r.width).toBeGreaterThanOrEqual(44)
        }
        expect(Math.round(r.height)).toBe(expectedVisual.height)
        expect(Math.round(r.width + pad.left + pad.right)).toBeGreaterThanOrEqual(minHit.width)
        expect(Math.round(r.height + pad.top + pad.bottom)).toBeGreaterThanOrEqual(minHit.height)

        const cx = r.x + r.width / 2
        const cy = r.y + r.height / 2
        // Points strictly outside the visual bounding box must still hit `el` via ::after.
        const topProbe = document.elementFromPoint(cx, r.y - Math.max(1, pad.top - 1))
        const bottomProbe = document.elementFromPoint(cx, r.bottom + Math.max(1, pad.bottom - 1))
        const leftProbe = document.elementFromPoint(r.x - Math.max(1, pad.left - 1), cy)
        const rightProbe = document.elementFromPoint(r.right + Math.max(1, pad.right - 1), cy)

        expect(topProbe && el.contains(topProbe)).toBe(true)
        expect(bottomProbe && el.contains(bottomProbe)).toBe(true)
        expect(leftProbe && el.contains(leftProbe)).toBe(true)
        expect(rightProbe && el.contains(rightProbe)).toBe(true)
    }

    function assertAdjacentPairNoOverlap(leftEl: Element, rightEl: Element) {
        const l = rect(leftEl)
        const r = rect(rightEl)
        const cy = (Math.max(l.y, r.y) + Math.min(l.bottom, r.bottom)) / 2
        const leftEdgeProbe = document.elementFromPoint(l.right + 1, cy)
        const rightEdgeProbe = document.elementFromPoint(r.x - 1, cy)
        expect(leftEdgeProbe && leftEl.contains(leftEdgeProbe)).toBe(true)
        expect(leftEdgeProbe && rightEl.contains(leftEdgeProbe)).toBe(false)
        expect(rightEdgeProbe && rightEl.contains(rightEdgeProbe)).toBe(true)
        expect(rightEdgeProbe && leftEl.contains(rightEdgeProbe)).toBe(false)
    }

    try {
        await page.viewport(390, 844)
        await act(async () => {
            root.render(
                <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                    <BaseDaemonProvider connectionOverrides={{ connectionStates: { 'synthetic-machine': 'connected' } }}>
                        <SeedRemoteDaemons />
                        <TransportProvider value={{ sendCommand }}>
                            <DashboardMobileChatRoom
                                selectedConversation={conversation}
                                isStandalone={false}
                                onStopCli={vi.fn()}
                                onOpenMeshGraph={vi.fn()}
                                actionLogs={[]}
                                commands={commands}
                                onBack={() => {}}
                                onOpenNativeConversation={() => {}}
                                onOpenMachine={() => {}}
                                onOpenHistory={() => {}}
                                onOpenRemote={() => {}}
                                cliViewMode="chat"
                                onSetCliViewMode={() => {}}
                            />
                        </TransportProvider>
                    </BaseDaemonProvider>
                </MemoryRouter>,
            )
        })
        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
        })

        // 1. Mobile room header buttons (visual 36x36; 4px gap-1 between action buttons split to 2px each)
        const backBtn = host.querySelector('button.mobile-room-back')!
        const viewModeBtn = host.querySelector('.mobile-room-header-actions button[title="Switch to Terminal view"]')!
        const stopCliBtn = host.querySelector('.mobile-room-header-actions button[title="Stop CLI process"]')!
        const meshGraphBtn = host.querySelector('.mobile-room-header-actions button[data-testid="conversation-mesh-graph-button"]')!
        const actionsMenuBtn = host.querySelector('.mobile-room-header-actions button[data-testid="conversation-actions-menu"]')!

        assertHitExpansion(backBtn, { width: 36, height: 36 }, { top: 4, bottom: 4, left: 4, right: 4 })
        assertHitExpansion(viewModeBtn, { width: 36, height: 36 }, { top: 4, bottom: 4, left: 4, right: 2 }, { width: 42, height: 44 })
        assertHitExpansion(stopCliBtn, { width: 36, height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 }, { width: 40, height: 44 })
        assertHitExpansion(meshGraphBtn, { width: 36, height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 }, { width: 40, height: 44 })
        assertHitExpansion(actionsMenuBtn, { width: 36, height: 36 }, { top: 4, bottom: 4, left: 2, right: 4 }, { width: 42, height: 44 })

        assertAdjacentPairNoOverlap(viewModeBtn, stopCliBtn)
        assertAdjacentPairNoOverlap(stopCliBtn, meshGraphBtn)
        assertAdjacentPairNoOverlap(meshGraphBtn, actionsMenuBtn)

        // 2. Activity bar pills (visual min-height 30px -> hit height +14px >= 44px; 4px gap-1 split to 2px each)
        const foldBtn = [...host.querySelectorAll<HTMLButtonElement>('.assistant-chat-activity-bar > button.chat-activity-toggle')][0]!
        const execToggleBtn = host.querySelector<HTMLButtonElement>('button.assistant-execution-toggle')!
        const watchedBadgeBtn = host.querySelector<HTMLButtonElement>('button.assistant-watched-badge')!
        const stagedBadgeBtn = host.querySelector<HTMLButtonElement>('button.assistant-staged-badge')!

        for (const pill of [foldBtn, execToggleBtn, watchedBadgeBtn, stagedBadgeBtn]) {
            expect(getComputedStyle(pill).minHeight).toBe('30px')
            assertHitExpansion(pill, { height: Math.round(rect(pill).height) }, { top: 7, bottom: 7, left: 2, right: 2 })
        }
        assertAdjacentPairNoOverlap(execToggleBtn, watchedBadgeBtn)
        assertAdjacentPairNoOverlap(watchedBadgeBtn, stagedBadgeBtn)

        // 3. Assistant execution dialog buttons (Close 32x36 -> 44x44; Turn off / Refresh / Send response height 36 -> 44)
        await act(async () => execToggleBtn.click())
        // With the dialog open, the 3 session-control pills sit on their own full-width row without wrapping text (exact 30px visual height).
        expect(Math.round(rect(execToggleBtn).height)).toBe(30)
        expect(Math.round(rect(watchedBadgeBtn).height)).toBe(30)
        expect(Math.round(rect(stagedBadgeBtn).height)).toBe(30)
        const execDialog = host.querySelector('.assistant-execution-panel')!
        const execCloseBtn = execDialog.querySelector<HTMLButtonElement>('button.btn-icon[aria-label="Close"]')!
        const execActionBtns = [...execDialog.querySelectorAll<HTMLButtonElement>('button.assistant-panel-action')]
        const turnOffBtn = execActionBtns[0]!
        const refreshPermBtn = execActionBtns[1]!
        const sendDirectionBtn = [...execDialog.querySelectorAll<HTMLButtonElement>('button.btn-primary')].find(
            b => b.textContent === 'Send response to assistant',
        )!

        assertHitExpansion(execCloseBtn, { width: 32, height: 36 }, { top: 4, bottom: 4, left: 6, right: 6 })
        assertHitExpansion(turnOffBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        assertHitExpansion(refreshPermBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        assertAdjacentPairNoOverlap(turnOffBtn, refreshPermBtn)
        await act(async () => sendDirectionBtn.scrollIntoView({ block: 'center' }))
        assertHitExpansion(sendDirectionBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        await act(async () => execCloseBtn.click())

        // 4. Assistant watched projects dialog buttons (Close 32x36 -> 44x44; Stop following / Remove access / Allow and follow height 36 -> 44)
        await act(async () => watchedBadgeBtn.click())
        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
        })
        const watchedDialog = host.querySelector('.assistant-watched-panel')!
        const watchedCloseBtn = watchedDialog.querySelector<HTMLButtonElement>('button.btn-icon[aria-label="Close"]')!
        const followedItemBtns = [...watchedDialog.querySelectorAll<HTMLButtonElement>('ul:not([data-testid]) li button')]
        const stopFollowingBtn = followedItemBtns[0]!
        const removeAccessBtn = followedItemBtns[1]!
        const allowAndFollowBtn = watchedDialog.querySelector<HTMLButtonElement>('button[data-testid="allow-and-follow-mesh-catalog-2"]')!

        assertHitExpansion(watchedCloseBtn, { width: 32, height: 36 }, { top: 4, bottom: 4, left: 6, right: 6 })
        assertHitExpansion(stopFollowingBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        assertHitExpansion(removeAccessBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        assertAdjacentPairNoOverlap(stopFollowingBtn, removeAccessBtn)
        await act(async () => allowAndFollowBtn.scrollIntoView({ block: 'center' }))
        assertHitExpansion(allowAndFollowBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        await act(async () => watchedCloseBtn.click())

        // 5. Assistant staged writes dialog buttons (Close 20x24 -> 44x44; Approve / Reject height 36 -> 44)
        await act(async () => stagedBadgeBtn.click())
        const stagedDialog = host.querySelector('.assistant-staged-panel')!
        const stagedCloseBtn = stagedDialog.querySelector<HTMLButtonElement>('button.btn-ghost[aria-label="Close"]')!
        const approveBtn = stagedDialog.querySelector<HTMLButtonElement>('button[data-staged-action="apply"]')!
        const rejectBtn = stagedDialog.querySelector<HTMLButtonElement>('button[data-staged-action="discard"]')!

        assertHitExpansion(stagedCloseBtn, { width: 20, height: 24 }, { top: 8, bottom: 12, left: 12, right: 12 })
        assertHitExpansion(approveBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        assertHitExpansion(rejectBtn, { height: 36 }, { top: 4, bottom: 4, left: 2, right: 2 })
        assertAdjacentPairNoOverlap(approveBtn, rejectBtn)
        await act(async () => stagedCloseBtn.click())

        // 6. Standalone .btn-icon (32x32 -> 44x44) and .btn-quiet (height 32 -> 44) at 390x844 vs 1280x844 desktop
        const toolbarProbe = document.createElement('div')
        toolbarProbe.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:50;display:flex;gap:16px;align-items:center'
        toolbarProbe.innerHTML = '<button type="button" class="btn btn-icon" aria-label="Standalone icon">I</button><button type="button" class="btn btn-quiet">Quiet action</button>'
        host.append(toolbarProbe)
        const standaloneIconBtn = toolbarProbe.querySelector<HTMLButtonElement>('.btn-icon')!
        const standaloneQuietBtn = toolbarProbe.querySelector<HTMLButtonElement>('.btn-quiet')!

        assertHitExpansion(standaloneIconBtn, { width: 32, height: 32 }, { top: 6, bottom: 6, left: 6, right: 6 })
        assertHitExpansion(standaloneQuietBtn, { height: 32 }, { top: 6, bottom: 6, left: 2, right: 2 })

        // At desktop width (1280x844, fine pointer), ::after expansion is inactive
        await page.viewport(1280, 844)
        const iconDesktopRect = rect(standaloneIconBtn)
        expect(Math.round(iconDesktopRect.width)).toBe(32)
        expect(Math.round(iconDesktopRect.height)).toBe(32)
        const outsideDesktop = document.elementFromPoint(iconDesktopRect.x + 16, iconDesktopRect.y - 4)
        expect(outsideDesktop && standaloneIconBtn.contains(outsideDesktop)).toBe(false)
        toolbarProbe.remove()
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})
