// @vitest-environment jsdom
//
// Phase E (session launch provenance): the new-session dialog tells the daemon
// WHERE the model / thinking values came from — a pick in the dialog ('user')
// or the one-shot restore of the last launch ('remembered') — and shows what
// "provider default" resolves to. The model chip formats the daemon's record.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardNewSessionDialog from '../../../src/components/dashboard/DashboardNewSessionDialog'
import ChatControlsSection, { formatSessionLaunchChip, readSessionLaunchSurface } from '../../../src/components/dashboard/ChatControlsSection'
import { expandCompactDaemons } from '../../../src/context/BaseDaemonContext'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DaemonData } from '../../../src/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE_KEY = 'adhdev.remember.new-session-workspace'

let container: HTMLDivElement
let root: Root
let store: Map<string, string>

beforeEach(() => {
    store = new Map()
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
            setItem: (key: string, value: string) => { store.set(key, value) },
            removeItem: (key: string) => { store.delete(key) },
        },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

function machine(providerType = 'claude'): DaemonData {
    return {
        id: 'machine-1',
        machineId: 'machine-1',
        type: 'adhdev-daemon',
        status: 'online',
        nickname: 'Machine 1',
        platform: 'darwin',
        availableProviders: [{
            type: providerType,
            name: 'Claude',
            displayName: 'Claude',
            icon: 'claude',
            category: 'cli',
            installed: true,
            enabled: true,
            machineStatus: 'detected',
            modelOptions: ['opus', 'sonnet'],
            thinkingLevelOptions: ['low', 'high'],
        } as any],
        detectedIdes: [],
        workspaces: [],
        recentLaunches: [],
    } as DaemonData
}

function render(onLaunchProvider: ReturnType<typeof vi.fn>, providerType = 'claude', extra: Record<string, any> = {}) {
    act(() => {
        root.render(React.createElement(DashboardNewSessionDialog, {
            machines: [machine(providerType)],
            ides: [],
            onClose: () => {},
            onBrowseDirectory: async () => ({ path: '/', directories: [] }),
            onSaveWorkspace: async () => ({ ok: true }),
            onLaunchIde: async () => ({ ok: true }),
            onLaunchProvider: onLaunchProvider as any,
            onListMeshes: async () => [],
            onLaunchMeshCoordinator: async () => ({ ok: true }),
            onListSavedSessions: async () => [],
            ...extra,
        }))
    })
}

function launchButton(): HTMLButtonElement {
    const btn = [...document.body.querySelectorAll('button')].find((b) => ['Start fresh', 'Start mesh coordinator'].includes(b.textContent?.trim() || ''))
    if (!btn) throw new Error('launch button not found')
    return btn as HTMLButtonElement
}

function modelSelect(): HTMLSelectElement {
    // The model select is the one listing the provider's modelOptions.
    const select = [...document.body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'opus'))
    if (!select) throw new Error('model select not found')
    return select as HTMLSelectElement
}

function pick(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    act(() => {
        setter.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
    })
}

async function launch(): Promise<void> {
    await act(async () => { launchButton().click() })
}

describe('DashboardNewSessionDialog — launch provenance (Phase E)', () => {
    it('coordinator launch ignores and removes browser role choices, leaving selection to the daemon', async () => {
        const key = 'adhdev.remember.new-session-mesh'
        store.set(key, JSON.stringify({ meshId: 'm', cliType: 'unavailable-cli', model: 'stale-model', thinkingLevel: 'high' }))
        const onLaunchMeshCoordinator = vi.fn(async () => ({ ok: true }))
        render(vi.fn(), 'claude', { initialLaunchMode: 'mesh', initialMeshWorkspacePath: '/repo',
            onListMeshes: async () => [{ id: 'm', name: 'M', workspace: '/repo' }], onLaunchMeshCoordinator })
        await act(async () => { await Promise.resolve() })
        const saved = [...document.body.querySelectorAll('button[role="radio"]')].find(b => b.textContent?.includes('Saved coordinator default'))!
        expect(saved.getAttribute('aria-checked')).toBe('true')
        await launch()
        expect(onLaunchMeshCoordinator).toHaveBeenCalledWith('machine-1', 'm', '', expect.objectContaining({ initialModel: null, initialThinkingLevel: null }))
        const remembered = JSON.parse(store.get(key)!)
        expect(remembered).not.toHaveProperty('cliType')
        expect(remembered).not.toHaveProperty('model')
        expect(remembered).not.toHaveProperty('thinkingLevel')
    })

    it('opts in a new Codex session without changing defaults or other providers', async () => {
        const onLaunchProvider = vi.fn(async () => ({ ok: true }))
        render(onLaunchProvider, 'codex-cli')
        const label = [...document.body.querySelectorAll('label')].find(node => node.textContent?.includes('Managed Codex questions'))!
        expect(label.textContent).toContain('No terminal or existing-session migration')
        expect(label.textContent).toContain('permission grants are currently unsupported')
        const checkbox = label.querySelector<HTMLInputElement>('input')!
        expect(checkbox.checked).toBe(false)
        act(() => checkbox.click())
        await launch()
        expect(onLaunchProvider.mock.calls[0][3]).toMatchObject({ settings: { codexTransport: 'app-server' }, resumeSessionId: null })
    })

    it('a model picked in the dialog is sent as modelSource user', async () => {
        const onLaunchProvider = vi.fn(async () => ({ ok: true }))
        render(onLaunchProvider)
        pick(modelSelect(), 'sonnet')
        await launch()
        const opts = onLaunchProvider.mock.calls[0][3] as any
        expect(opts).toMatchObject({ initialModel: 'sonnet', modelSource: 'user' })
        expect(opts).not.toHaveProperty('thinkingLevelSource')
    })

    it('a model restored from the last launch is sent as modelSource remembered', async () => {
        store.set(WORKSPACE_KEY, JSON.stringify({ kind: 'cli', target: 'claude', workspaceChoice: '__home__', model: 'sonnet', thinkingLevel: 'high' }))
        const onLaunchProvider = vi.fn(async () => ({ ok: true }))
        render(onLaunchProvider)
        await launch()
        expect(onLaunchProvider.mock.calls[0][3]).toMatchObject({
            initialModel: 'sonnet',
            modelSource: 'remembered',
            initialThinkingLevel: 'high',
            thinkingLevelSource: 'remembered',
        })
    })

    it('re-picking a restored value turns it into a user pick', async () => {
        store.set(WORKSPACE_KEY, JSON.stringify({ kind: 'cli', target: 'claude', workspaceChoice: '__home__', model: 'sonnet' }))
        const onLaunchProvider = vi.fn(async () => ({ ok: true }))
        render(onLaunchProvider)
        pick(modelSelect(), 'opus')
        await launch()
        expect(onLaunchProvider.mock.calls[0][3]).toMatchObject({ initialModel: 'opus', modelSource: 'user' })
    })

    it('no model → no source, and the dialog shows what the default resolves to', async () => {
        const onLaunchProvider = vi.fn(async () => ({ ok: true }))
        render(onLaunchProvider)
        expect(document.body.querySelector('[data-testid="new-session-default-model"]')?.textContent).toContain('opus')
        await launch()
        const opts = onLaunchProvider.mock.calls[0][3] as any
        expect(opts.initialModel).toBeNull()
        expect(opts).not.toHaveProperty('modelSource')
    })
})

describe('session launch chip', () => {
    const launch = {
        sessionId: 's-1',
        providerType: 'claude-cli',
        launchedBy: 'dashboard',
        launchedAt: 1,
        model: { requested: 'sonnet', source: 'user', launchValue: 'sonnet', history: [{ at: 1, value: 'sonnet', via: 'launch' }] },
        thinkingLevel: { source: 'unspecified', history: [] },
    }

    it('"sonnet · chosen" for a user pick', () => {
        expect(formatSessionLaunchChip(readSessionLaunchSurface({ launch }))?.text).toBe('sonnet · chosen')
    })

    it('"opus · default" for a provider default', () => {
        const record = { ...launch, model: { source: 'provider_default', resolvedDefault: 'opus', history: [{ at: 1, value: 'opus', via: 'launch' }] } }
        expect(formatSessionLaunchChip(readSessionLaunchSurface({ launch: record }))?.text).toBe('opus · default')
    })

    it('"sonnet → opus (changed)" after a runtime change', () => {
        const record = { ...launch, model: { ...launch.model, current: 'opus', history: [...launch.model.history, { at: 2, value: 'opus', via: 'change_model' }] } }
        expect(formatSessionLaunchChip(readSessionLaunchSurface({ launch: record }))?.text).toBe('sonnet → opus (changed)')
    })

    it('warns when the provider silently ran another model than requested', () => {
        const record = { ...launch, model: { requested: 'Claude Opus 4.6 (Thinking)', source: 'user', launchValue: 'claude-opus-4-6-thinking', observed: 'Gemini 4 Argon (Medium)', observedAt: 5, fallback: true, history: [{ at: 1, value: 'claude-opus-4-6-thinking', via: 'launch' }, { at: 5, value: 'Gemini 4 Argon (Medium)', via: 'observed' }] } }
        const chip = formatSessionLaunchChip(readSessionLaunchSurface({ launch: record }))
        expect(chip?.warning).toBe(true)
        expect(chip?.text).toBe('Requested model Claude Opus 4.6 (Thinking) was not available - running Gemini 4 Argon (Medium) instead')
    })

    it('falls back to the server-projected model / modelSource before P2P', () => {
        expect(formatSessionLaunchChip(readSessionLaunchSurface({ model: 'opus', modelSource: 'mesh_slot' }))?.text).toBe('opus · mesh slot')
        expect(formatSessionLaunchChip(readSessionLaunchSurface({ model: 'opus', modelSource: 'bogus' }))?.text).toBe('opus')
        expect(formatSessionLaunchChip(readSessionLaunchSurface({}))).toBeNull()
    })
})

describe('model chip rendering and dashboard expansion', () => {
    const launch = {
        sessionId: 'cli-1',
        providerType: 'claude-cli',
        launchedBy: 'mesh',
        launchedAt: 1,
        model: { requested: 'opus', source: 'task_override', launchValue: 'opus', history: [{ at: 1, value: 'opus', via: 'launch' }] },
        thinkingLevel: { source: 'unspecified', history: [] },
    }

    it('ChatControlsSection renders the chip even with no bar controls, but not for a terminal session', () => {
        const props = { routeId: 'd', providerType: 'claude-cli', displayLabel: 'Claude', isActive: true, launchSurface: readSessionLaunchSurface({ launch }) }
        expect(renderToStaticMarkup(React.createElement(ChatControlsSection, props))).toContain('opus · task')
        expect(renderToStaticMarkup(React.createElement(ChatControlsSection, { ...props, isCliTerminal: true }))).toBe('')
        expect(renderToStaticMarkup(React.createElement(ChatControlsSection, { ...props, launchSurface: {} }))).toBe('')
    })

    it('expandCompactDaemons carries launch / model / modelSource onto CLI entries', () => {
        const { entries } = expandCompactDaemons([{
            id: 'd-1',
            sessions: [{ id: 'cli-1', providerType: 'claude-cli', kind: 'agent', transport: 'pty', status: 'idle', launch, model: 'opus', modelSource: 'task_override', thinkingLevel: 'high' } as any],
        }])
        const cli = entries.find((e) => e.id === 'd-1:cli:cli-1') as any
        expect(cli).toMatchObject({ launch, model: 'opus', modelSource: 'task_override', thinkingLevel: 'high' })
        expect(formatSessionLaunchChip(readSessionLaunchSurface(cli))?.text).toBe('opus · task')
    })

    it('a server-only entry (no P2P record) still shows model + source', () => {
        const { entries } = expandCompactDaemons([{
            id: 'd-1',
            sessions: [{ id: 'cli-2', providerType: 'claude-cli', kind: 'agent', transport: 'pty', status: 'idle', model: 'opus', modelSource: 'provider_default' } as any],
        }])
        const cli = entries.find((e) => e.id === 'd-1:cli:cli-2') as any
        expect(cli).not.toHaveProperty('launch')
        expect(formatSessionLaunchChip(readSessionLaunchSurface(cli))?.text).toBe('opus · default')
    })
})
