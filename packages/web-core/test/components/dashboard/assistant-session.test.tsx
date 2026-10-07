// @vitest-environment jsdom
//
// Assistant layer (design 2026-10-07-assistant-layer.md §4.6–§4.7): the
// assistant is an ordinary session chat, marked with its own icon + "Assistant"
// label, pinned first in session lists, and — while none exists — the dashboard
// header offers "Start assistant", which sends `launch_assistant` through the
// normal command transport.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { SessionEntry, StatusReportPayload } from '@adhdev/daemon-core'

import DashboardHeader from '../../../src/components/dashboard/DashboardHeader'
import { BaseDaemonProvider } from '../../../src/context/BaseDaemonContext'
import { TransportProvider } from '../../../src/context/TransportContext'
import { buildConversations } from '../../../src/components/dashboard/buildConversations'
import { compareConversationRecency } from '../../../src/components/dashboard/conversation-sort'
import { sortMobileInboxItems } from '../../../src/components/dashboard/dashboard-mobile-chat-mode-helpers'
import {
    ASSISTANT_LAUNCH_CHOICE_STORAGE_KEY,
    isAssistantConversation,
    listAssistantLaunchMachines,
    pickAssistantLaunchTarget,
    readAssistantLaunchChoice,
    shouldOfferStartAssistant,
    writeAssistantLaunchChoice,
} from '../../../src/components/dashboard/assistant-session'
import { useStartAssistant } from '../../../src/hooks/useStartAssistant'
import { statusPayloadToEntries } from '../../../src/utils/status-transform'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { MobileConversationListItem } from '../../../src/components/dashboard/DashboardMobileChatShared'
import type { DaemonData } from '../../../src/types'

function conversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1',
        daemonId: 'machine-1',
        sessionId: 'session-1',
        transport: 'pty',
        mode: 'chat',
        agentName: 'Claude Code',
        agentType: 'claude-cli',
        status: 'idle',
        title: 'adhdev',
        messages: [],
        workspaceName: 'adhdev',
        workspacePath: '/work/adhdev',
        displayPrimary: 'adhdev',
        displaySecondary: 'Claude Code',
        streamSource: 'native',
        tabKey: 'tab-1',
        machineName: 'mbp',
        connectionState: 'connected',
        ...overrides,
    }
}

const assistant = (overrides: Partial<ActiveConversation> = {}) => conversation({
    tabKey: 'tab-a', sessionId: 'session-a', displayPrimary: 'Assistant', assistant: true, settings: { assistant: true },
    ...overrides,
})

function machine(id: string, providers: Array<Record<string, unknown>>, status = 'online'): DaemonData {
    return { id, type: 'adhdev-daemon', status, availableProviders: providers } as unknown as DaemonData
}
const cliProvider = (type: string, extra: Record<string, unknown> = {}) => ({ type, name: type, category: 'cli', displayName: type, icon: '', enabled: true, ...extra })

describe('assistant detection and pinning', () => {
    it('detects the assistant from the lane flag or the settings fallback', () => {
        expect(isAssistantConversation(conversation({ assistant: true }))).toBe(true)
        expect(isAssistantConversation(conversation({ settings: { assistant: true } }))).toBe(true)
        expect(isAssistantConversation(conversation({ settings: { managedByAssistant: true, meshCoordinatorFor: 'm' } }))).toBe(false)
        expect(isAssistantConversation(conversation())).toBe(false)
    })

    it('pins the assistant first regardless of recency', () => {
        const fresh = conversation({ tabKey: 'tab-new', lastMessageAt: 9_000 })
        const old = assistant({ lastMessageAt: 1 })
        const sorted = [fresh, old].sort((l, r) => compareConversationRecency(l, r))
        expect(sorted.map(c => c.tabKey)).toEqual(['tab-a', 'tab-new'])
    })

    it('pins the assistant first in the mobile inbox', () => {
        const item = (conv: ActiveConversation, timestamp: number) => ({ conversation: conv, timestamp } as MobileConversationListItem)
        const sorted = sortMobileInboxItems([item(conversation({ tabKey: 'tab-new' }), 9_000), item(assistant(), 1)])
        expect(sorted.map(i => i.conversation.tabKey)).toEqual(['tab-a', 'tab-new'])
    })
})

describe('daemon.metadata → conversation', () => {
    function session(overrides: Partial<SessionEntry> & Record<string, unknown>): SessionEntry {
        return {
            id: 'asst-1', parentId: null, providerType: 'claude-cli', providerName: 'Claude Code', kind: 'agent',
            transport: 'pty', status: 'idle', title: 'Claude Code', workspace: '/home/u/.adhdev/assistant',
            activeChat: null, capabilities: [], mode: 'chat', ...overrides,
        } as SessionEntry
    }
    const payload = (sessions: SessionEntry[]) => ({
        instanceId: 'daemon-1', version: '1', daemonMode: true,
        machine: { hostname: 'mbp', platform: 'darwin', arch: 'arm64', cpus: 8, totalMem: 16, freeMem: 8, loadavg: [0, 0, 0], uptime: 1, release: '15' },
        timestamp: 1, detectedIdes: [], sessions,
    }) as unknown as StatusReportPayload

    it('carries the assistant flag onto the CLI entry and labels the conversation "Assistant"', () => {
        const entries = statusPayloadToEntries(payload([
            session({ assistant: true, settings: { assistant: true } }),
            session({ id: 'plain-1', workspace: '/work/adhdev' }),
        ]), { daemonId: 'daemon-1' })
        const cli = entries.filter(e => e.transport === 'pty')
        expect(cli.find(e => e.sessionId === 'asst-1')?.assistant).toBe(true)
        expect(cli.find(e => e.sessionId === 'plain-1')).not.toHaveProperty('assistant')

        const conversations = buildConversations(cli, entries)
        const asst = conversations.find(c => c.sessionId === 'asst-1')!
        expect(asst.assistant).toBe(true)
        expect(asst.displayPrimary).toBe('Assistant')
        const plain = conversations.find(c => c.sessionId === 'plain-1')!
        expect(plain.assistant).toBeUndefined()
        expect(plain.displayPrimary).toBe('adhdev')
    })
})

const ok = (toolRestriction: 'enforced' | 'prompt_only' = 'prompt_only') => ({ assistant: { supported: true, toolRestriction } })
const refused = (reason: string) => ({ assistant: { supported: false, toolRestriction: 'prompt_only', code: 'assistant_mcp_setup_unsupported', reason } })

describe('Start assistant target and visibility', () => {
    it('defaults to claude-cli when eligible, else the first eligible CLI; an ineligible CLI is never the default', () => {
        expect(pickAssistantLaunchTarget([machine('m1', [cliProvider('codex-cli', ok()), cliProvider('claude-cli', ok('enforced'))])]))
            .toEqual({ machineId: 'm1', cliType: 'claude-cli' })
        expect(pickAssistantLaunchTarget([machine('m1', [cliProvider('claude-cli', refused('no')), cliProvider('antigravity-cli', refused('global')), cliProvider('kimi', ok())])]))
            .toEqual({ machineId: 'm1', cliType: 'kimi' })
        expect(pickAssistantLaunchTarget([machine('m1', [cliProvider('antigravity-cli', refused('global'))])])).toBeNull()
        // An older daemon without the field: the CLI is assumed eligible (the daemon still decides).
        expect(pickAssistantLaunchTarget([machine('m1', [cliProvider('aider-cli')])]))
            .toEqual({ machineId: 'm1', cliType: 'aider-cli' })
    })

    it('honours a remembered choice while it is still eligible on a listed machine', () => {
        const machines = [
            machine('m1', [cliProvider('claude-cli', ok('enforced')), cliProvider('codex-cli', ok())]),
            machine('m2', [cliProvider('claude-cli', ok('enforced')), cliProvider('kimi', ok()), cliProvider('antigravity-cli', refused('global'))]),
        ]
        expect(pickAssistantLaunchTarget(machines, { machineId: 'm2', cliType: 'kimi' })).toEqual({ machineId: 'm2', cliType: 'kimi' })
        expect(pickAssistantLaunchTarget(machines, { cliType: 'kimi' })).toEqual({ machineId: 'm2', cliType: 'kimi' })
        expect(pickAssistantLaunchTarget(machines, { machineId: 'm2', cliType: 'antigravity-cli' })).toEqual({ machineId: 'm1', cliType: 'claude-cli' })
        expect(pickAssistantLaunchTarget(machines, { machineId: 'gone', cliType: 'codex-cli' })).toEqual({ machineId: 'm1', cliType: 'claude-cli' })
    })

    it('lists eligible CLIs first (claude-cli leading) and keeps ineligible ones with their reason', () => {
        const [m] = listAssistantLaunchMachines([machine('m1', [
            cliProvider('antigravity-cli', refused('reads a global config')),
            cliProvider('codex-cli', ok()),
            cliProvider('claude-cli', ok('enforced')),
        ])])
        expect(m.clis.every(c => Array.isArray(c.modelOptions) && Array.isArray(c.thinkingLevelOptions))).toBe(true)
        expect(m.clis.map(c => [c.cliType, c.supported, c.promptOnly, c.reason])).toEqual([
            ['claude-cli', true, false, undefined],
            ['codex-cli', true, true, undefined],
            ['antigravity-cli', false, true, 'reads a global config'],
        ])
    })

    it('skips offline machines and machines without an enabled CLI', () => {
        expect(pickAssistantLaunchTarget([
            machine('off', [cliProvider('claude-cli')], 'offline'),
            machine('none', [cliProvider('claude-cli', { enabled: false })]),
            machine('ok', [cliProvider('codex-cli')]),
        ])).toEqual({ machineId: 'ok', cliType: 'codex-cli' })
        expect(pickAssistantLaunchTarget([])).toBeNull()
    })

    it('remembers the choice in storage and survives a throwing storage', () => {
        const store = new Map<string, string>()
        const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
        writeAssistantLaunchChoice({ machineId: 'm1', cliType: 'codex-cli' }, storage)
        expect(store.get(ASSISTANT_LAUNCH_CHOICE_STORAGE_KEY)).toBe(JSON.stringify({ machineId: 'm1', cliType: 'codex-cli' }))
        expect(readAssistantLaunchChoice(storage)).toEqual({ machineId: 'm1', cliType: 'codex-cli' })
        writeAssistantLaunchChoice({ machineId: 'm1', cliType: 'claude-cli', model: 'opus', thinkingLevel: 'max' }, storage)
        expect(readAssistantLaunchChoice(storage)).toEqual({ machineId: 'm1', cliType: 'claude-cli', model: 'opus', thinkingLevel: 'max' })
        const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
        expect(readAssistantLaunchChoice(throwing)).toBeNull()
        expect(() => writeAssistantLaunchChoice({ machineId: 'm1', cliType: 'x' }, throwing)).not.toThrow()
        store.set(ASSISTANT_LAUNCH_CHOICE_STORAGE_KEY, '{not json')
        expect(readAssistantLaunchChoice(storage)).toBeNull()
    })

    it('is offered only while no assistant session exists and a machine can host one', () => {
        const target = { machineId: 'm1', cliType: 'claude-cli' }
        expect(shouldOfferStartAssistant([conversation()], target)).toBe(true)
        expect(shouldOfferStartAssistant([conversation(), assistant()], target)).toBe(false)
        expect(shouldOfferStartAssistant([conversation()], null)).toBe(false)
    })
})

describe('assistant in the dashboard header', () => {
    let container: HTMLDivElement
    let root: Root
    const sendCommand = vi.fn(async () => ({ success: true }))

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        vi.unstubAllGlobals()
        act(() => root.unmount())
        container.remove()
    })

    function render(node: React.ReactNode) {
        act(() => root.render(
            <MemoryRouter>
                <TransportProvider value={{ sendCommand }}>
                    <BaseDaemonProvider>{node}</BaseDaemonProvider>
                </TransportProvider>
            </MemoryRouter>,
        ))
    }

    function renderHeader(activeConv: ActiveConversation, extra: Record<string, unknown> = {}) {
        render(
            <DashboardHeader
                activeConv={activeConv}
                wsStatus="connected"
                isConnected
                conversations={[activeConv]}
                onOpenHistory={() => {}}
                inboxOpen={false}
                onInboxOpenChange={() => {}}
                hiddenOpen={false}
                onHiddenOpenChange={() => {}}
                notifications={[]}
                notificationUnreadCount={0}
                onOpenNotification={() => {}}
                onMarkNotificationRead={() => {}}
                onMarkNotificationUnread={() => {}}
                onDeleteNotification={() => {}}
                {...extra}
            />,
        )
    }

    const startButton = () => container.querySelector<HTMLButtonElement>('[data-testid="dashboard-start-assistant"]')

    it('marks the assistant with its own icon and label, not the coordinator marker', () => {
        renderHeader(assistant())
        const icon = container.querySelector('.header-title-mobile-role.is-assistant')
        expect(icon).not.toBeNull()
        expect(icon?.getAttribute('aria-label')).toBe('Assistant')
        expect(container.querySelector('.mesh-role-icon.is-coordinator')).toBeNull()
    })

    it('shows "Start assistant" only when the handler is provided, and clicking it starts', () => {
        renderHeader(conversation())
        expect(startButton()).toBeNull()
        const onStartAssistant = vi.fn()
        renderHeader(conversation(), { onStartAssistant })
        expect(startButton()?.textContent).toContain('Start assistant')
        act(() => startButton()!.click())
        expect(onStartAssistant).toHaveBeenCalledTimes(1)
    })

    it('split button: the menu lists each machine\'s CLIs, ineligible ones disabled with the reason, prompt-only ones noted', () => {
        const onStartAssistant = vi.fn()
        const onStartAssistantWith = vi.fn()
        const machines = listAssistantLaunchMachines([
            machine('m1', [cliProvider('claude-cli', ok('enforced')), cliProvider('codex-cli', ok()), cliProvider('antigravity-cli', refused('reads ~/.gemini globally'))]),
            machine('m2', [cliProvider('kimi', ok())]),
        ])
        renderHeader(conversation(), {
            onStartAssistant, onStartAssistantWith,
            startAssistantMachines: machines,
            startAssistantDefault: { machineId: 'm1', cliType: 'claude-cli' },
        })
        expect(document.querySelector('[data-testid="dashboard-start-assistant-options"]')).toBeNull()
        act(() => container.querySelector<HTMLButtonElement>('[data-testid="dashboard-start-assistant-menu"]')!.click())
        const menu = document.querySelector('[data-testid="dashboard-start-assistant-options"]')!
        expect(menu).not.toBeNull()
        const item = (machineId: string, cliType: string) => menu.querySelector<HTMLButtonElement>(`[data-assistant-machine="${machineId}"][data-assistant-cli="${cliType}"]`)!
        // Machine headings appear because two machines are online.
        expect(menu.textContent).toContain('Machine-m1')
        expect(item('m1', 'claude-cli').getAttribute('aria-checked')).toBe('true')
        expect(item('m1', 'claude-cli').querySelector('[data-testid="assistant-cli-no-tool-lock"]')).toBeNull()
        expect(item('m1', 'codex-cli').querySelector('[data-testid="assistant-cli-no-tool-lock"]')?.textContent).toBe('no tool lock')
        const agy = item('m1', 'antigravity-cli')
        expect(agy.disabled).toBe(true)
        expect(agy.querySelector('[data-testid="assistant-cli-unavailable-reason"]')?.textContent).toBe('reads ~/.gemini globally')
        // Picking a CLI selects it; Start launches the selection.
        act(() => item('m2', 'kimi').click())
        expect(onStartAssistantWith).not.toHaveBeenCalled()
        expect(item('m2', 'kimi').getAttribute('aria-checked')).toBe('true')
        expect(item('m1', 'claude-cli').getAttribute('aria-checked')).toBe('false')
        act(() => menu.querySelector<HTMLButtonElement>('[data-testid="assistant-launch-start"]')!.click())
        expect(onStartAssistantWith).toHaveBeenCalledWith({ machineId: 'm2', cliType: 'kimi' })
        expect(onStartAssistant).not.toHaveBeenCalled()
        expect(document.querySelector('[data-testid="dashboard-start-assistant-options"]')).toBeNull()
    })

    it('model / thinking selects follow the selected CLI: advertised lists only, no thinking select without levels', () => {
        const onStartAssistantWith = vi.fn()
        const machines = listAssistantLaunchMachines([machine('m1', [
            cliProvider('claude-cli', { ...ok('enforced'), modelOptions: ['opus', 'sonnet'], thinkingLevelOptions: ['low', 'high', 'max'] }),
            cliProvider('antigravity-cli', { ...ok(), modelOptions: ['Gemini 3.7 Flash (High)'] }),
        ])])
        renderHeader(conversation(), {
            onStartAssistant: vi.fn(), onStartAssistantWith,
            startAssistantMachines: machines,
            startAssistantDefault: { machineId: 'm1', cliType: 'claude-cli', model: 'sonnet', thinkingLevel: 'max' },
        })
        act(() => container.querySelector<HTMLButtonElement>('[data-testid="dashboard-start-assistant-menu"]')!.click())
        const menu = document.querySelector('[data-testid="dashboard-start-assistant-options"]')!
        const model = () => menu.querySelector<HTMLSelectElement>('[data-testid="assistant-launch-model"]')
        const thinking = () => menu.querySelector<HTMLSelectElement>('[data-testid="assistant-launch-thinking"]')
        // Opens on the default target, with its remembered model / level.
        expect(model()!.value).toBe('sonnet')
        expect(Array.from(model()!.options).map(o => o.value)).toEqual(['', 'opus', 'sonnet'])
        expect(thinking()!.value).toBe('max')
        expect(Array.from(thinking()!.options).map(o => o.value)).toEqual(['', 'low', 'high', 'max'])
        const choose = (select: HTMLSelectElement, value: string) => act(() => {
            select.value = value
            select.dispatchEvent(new Event('change', { bubbles: true }))
        })
        choose(model()!, 'opus')
        choose(thinking()!, '')
        // A CLI without thinking levels: model select only, model reset to its default.
        act(() => menu.querySelector<HTMLButtonElement>('[data-assistant-cli="antigravity-cli"]')!.click())
        expect(model()!.value).toBe('')
        expect(thinking()).toBeNull()
        choose(model()!, 'Gemini 3.7 Flash (High)')
        act(() => menu.querySelector<HTMLButtonElement>('[data-testid="assistant-launch-start"]')!.click())
        expect(onStartAssistantWith).toHaveBeenLastCalledWith({ machineId: 'm1', cliType: 'antigravity-cli', model: 'Gemini 3.7 Flash (High)' })
        // Edits are per-open: reopening starts from the default target (and its remembered model / level) again.
        act(() => container.querySelector<HTMLButtonElement>('[data-testid="dashboard-start-assistant-menu"]')!.click())
        const reopened = document.querySelector('[data-testid="dashboard-start-assistant-options"]')!
        act(() => reopened.querySelector<HTMLButtonElement>('[data-testid="assistant-launch-start"]')!.click())
        expect(onStartAssistantWith).toHaveBeenLastCalledWith({ machineId: 'm1', cliType: 'claude-cli', model: 'sonnet', thinkingLevel: 'max' })
    })

    it('useStartAssistant sends model / thinkingLevel, persists them, and drops values the CLI no longer advertises', async () => {
        const store = new Map<string, string>()
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
        const send = vi.fn(async () => ({ success: true, sessionId: 'asst-1' }))
        let state: ReturnType<typeof useStartAssistant> | null = null
        let entries = [machine('m1', [cliProvider('claude-cli', { ...ok('enforced'), modelOptions: ['opus', 'sonnet'], thinkingLevelOptions: ['low', 'high'] })])]
        function Probe() {
            state = useStartAssistant({ machineEntries: entries, conversations: [], sendDaemonCommand: send })
            return null
        }
        render(<Probe />)
        await act(async () => { await state!.start({ machineId: 'm1', cliType: 'claude-cli', model: 'opus', thinkingLevel: 'high' }) })
        expect(send).toHaveBeenLastCalledWith('m1', 'launch_assistant', { cliType: 'claude-cli', model: 'opus', thinkingLevel: 'high' })
        expect(JSON.parse(store.get(ASSISTANT_LAUNCH_CHOICE_STORAGE_KEY)!)).toEqual({ machineId: 'm1', cliType: 'claude-cli', model: 'opus', thinkingLevel: 'high' })
        expect(state!.defaultTarget).toEqual({ machineId: 'm1', cliType: 'claude-cli', model: 'opus', thinkingLevel: 'high' })
        await act(async () => { await state!.start() })
        expect(send).toHaveBeenLastCalledWith('m1', 'launch_assistant', { cliType: 'claude-cli', model: 'opus', thinkingLevel: 'high' })
        // Remount against a manifest that dropped 'opus' and the thinking levels: the stale values fall back to defaults.
        entries = [machine('m1', [cliProvider('claude-cli', { ...ok('enforced'), modelOptions: ['sonnet'] })])]
        state = null
        act(() => root.unmount())
        root = createRoot(container)
        render(<Probe />)
        expect(state!.defaultTarget).toEqual({ machineId: 'm1', cliType: 'claude-cli' })
        await act(async () => { await state!.start() })
        expect(send).toHaveBeenLastCalledWith('m1', 'launch_assistant', { cliType: 'claude-cli' })
    })

    it('useStartAssistant sends a dropdown choice as cliType and remembers it as the next default', async () => {
        // test/setup.ts stubs a no-op localStorage; give this case a real one.
        const store = new Map<string, string>()
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
        const send = vi.fn(async () => ({ success: true, sessionId: 'asst-1' }))
        let state: ReturnType<typeof useStartAssistant> | null = null
        const entries = [machine('m1', [cliProvider('claude-cli', ok('enforced')), cliProvider('codex-cli', ok())])]
        function Probe() {
            state = useStartAssistant({ machineEntries: entries, conversations: [], sendDaemonCommand: send })
            return null
        }
        render(<Probe />)
        expect(state!.defaultTarget).toEqual({ machineId: 'm1', cliType: 'claude-cli' })
        await act(async () => { await state!.start({ machineId: 'm1', cliType: 'codex-cli' }) })
        expect(send).toHaveBeenCalledWith('m1', 'launch_assistant', { cliType: 'codex-cli' })
        expect(state!.defaultTarget).toEqual({ machineId: 'm1', cliType: 'codex-cli' })
        expect(readAssistantLaunchChoice()).toEqual({ machineId: 'm1', cliType: 'codex-cli' })
        await act(async () => { await state!.start() })
        expect(send).toHaveBeenLastCalledWith('m1', 'launch_assistant', { cliType: 'codex-cli' })
        // A fresh mount reads the remembered choice back as the default.
        state = null
        act(() => root.unmount())
        root = createRoot(container)
        render(<Probe />)
        expect(state!.defaultTarget).toEqual({ machineId: 'm1', cliType: 'codex-cli' })
    })

    it('useStartAssistant sends launch_assistant with the picked CLI through the command transport', async () => {
        const send = vi.fn(async () => ({ success: true, sessionId: 'asst-1' }))
        let state: ReturnType<typeof useStartAssistant> | null = null
        function Probe({ conversations }: { conversations: ActiveConversation[] }) {
            state = useStartAssistant({ machineEntries: [machine('m1', [cliProvider('claude-cli')])], conversations, sendDaemonCommand: send })
            return null
        }
        render(<Probe conversations={[conversation()]} />)
        expect(state!.visible).toBe(true)
        await act(async () => { await state!.start() })
        expect(send).toHaveBeenCalledWith('m1', 'launch_assistant', { cliType: 'claude-cli' })
        expect(state!.error).toBeNull()

        render(<Probe conversations={[conversation(), assistant()]} />)
        expect(state!.visible).toBe(false)
    })

    it('useStartAssistant surfaces a daemon refusal', async () => {
        const send = vi.fn(async () => ({ success: false, code: 'assistant_mcp_unsupported', error: 'assistant_mcp_unsupported' }))
        let state: ReturnType<typeof useStartAssistant> | null = null
        function Probe() {
            state = useStartAssistant({ machineEntries: [machine('m1', [cliProvider('claude-cli')])], conversations: [], sendDaemonCommand: send })
            return null
        }
        render(<Probe />)
        await act(async () => { await state!.start() })
        expect(state!.error).toBe('assistant_mcp_unsupported')
    })
})
