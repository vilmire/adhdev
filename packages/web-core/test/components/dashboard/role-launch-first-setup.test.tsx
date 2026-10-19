// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TransportProvider } from '../../../src/context/TransportContext'
import { useStartAssistant } from '../../../src/hooks/useStartAssistant'
import AssistantLaunchSetupDialog from '../../../src/components/dashboard/AssistantLaunchSetupDialog'
import DashboardNewSessionDialog from '../../../src/components/dashboard/DashboardNewSessionDialog'
import type { DaemonData } from '../../../src/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const machine = {
    id: 'machine-1', type: 'adhdev-daemon', status: 'online',
    availableProviders: [{ type: 'claude-cli', name: 'Claude', displayName: 'Claude', category: 'cli', icon: '',
        enabled: true, installed: true, machineStatus: 'detected', modelOptions: ['opus'],
        thinkingLevelOptions: ['medium'], assistant: { supported: true, mcpSupported: true, toolRestriction: 'enforced' } }],
    detectedIdes: [], workspaces: [], recentLaunches: [],
} as unknown as DaemonData

let root: Root
let container: HTMLDivElement
beforeEach(() => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

function absentStore(cloud: boolean) {
    let revision = 0
    const saved: Record<string, any> = {}
    const send = vi.fn(async (_id: string, type: string, args: Record<string, any> = {}) => {
        const wrap = (answer: any) => cloud ? { success: true, result: answer } : answer
        if (type === 'launch_defaults_get') {
            if (args.project && revision === 0) return wrap({ success: false, code: 'launch_default_required', documentRevision: 0 })
            return wrap({ success: true, result: 'get', documentRevision: revision,
                roles: Object.fromEntries(['assistant', 'coordinator'].map(role => [role, {
                    stored: saved[role] || null,
                    effective: saved[role] ? { ok: true, selection: saved[role] }
                        : { ok: false, code: 'launch_default_required', reason: revision ? 'role_default_unset' : 'launch_defaults_read_failed' },
                }])) })
        }
        if (type === 'launch_defaults_set') {
            expect(args.expectedRevision).toBe(revision)
            expect(args.action).toBe('set')
            saved[args.role] = { provider: args.provider, model: args.model, thinkingLevel: args.thinkingLevel }
            revision++
            return wrap({ success: true, result: 'applied', durable: true })
        }
        if (type === 'launch_assistant') {
            expect(saved.assistant).toBeTruthy()
            return wrap({ success: true, sessionId: 'assistant-1' })
        }
        return wrap({ success: true, meshes: [] })
    })
    return { send, saved }
}
async function click(element: Element | null | undefined) {
    expect(element).toBeTruthy()
    await act(async () => { (element as HTMLButtonElement).click() })
}
async function choose(field: string, value: string) {
    const element = document.querySelector(`[data-launch-default-field="${field}"]`) as HTMLSelectElement
    expect(element).toBeTruthy()
    await act(async () => {
        element.value = value
        element.dispatchEvent(new Event('change', { bubbles: true }))
    })
}
async function saveDefault() {
    await choose('provider', 'claude-cli')
    await choose('model', 'opus')
    await choose('thinkingLevel', 'medium')
    await click(document.querySelector('[data-launch-default-action="save"]'))
}

for (const cloud of [false, true]) describe(cloud ? 'cloud upgrade without defaults' : 'standalone upgrade without defaults', () => {
    it('opens assistant setup before launching, saves revision zero, and starts the saved selection', async () => {
        const { send, saved } = absentStore(cloud)
        function Probe() {
            const state = useStartAssistant({ machineEntries: [machine], conversations: [], sendDaemonCommand: send })
            return <>
                <button data-testid="start" onClick={() => void state.start()}>Start</button>
                {state.setupMachineId && <AssistantLaunchSetupDialog machine={machine} sendDaemonCommand={send}
                    onClose={() => state.closeSetup?.()}
                    onStart={target => { state.closeSetup?.(); void state.start(target) }} />}
            </>
        }
        await act(async () => { root.render(<Probe />) })
        await click(container.querySelector('[data-testid="start"]'))
        expect(send.mock.calls.some(call => call[1] === 'launch_assistant')).toBe(false)
        expect(document.querySelector('[data-launch-default-role="assistant"]')).toBeTruthy()
        expect(document.querySelector('[data-launch-default-role="coordinator"]')).toBeNull()
        const start = [...document.querySelectorAll('button')].find(button => button.textContent === 'Start assistant')!
        expect(start.disabled).toBe(true)
        await saveDefault()
        expect(saved.assistant).toEqual({ provider: 'claude-cli', model: 'opus', thinkingLevel: 'medium' })
        expect(start.disabled).toBe(false)
        await click(start)
        expect(send).toHaveBeenLastCalledWith('machine-1', 'launch_assistant', {
            cliType: 'claude-cli', model: 'opus', thinkingLevel: 'medium',
        })
        expect(document.querySelector('[role="dialog"]')).toBeNull()
    })

    it('saves coordinator defaults inside its launch dialog and refreshes the effective default', async () => {
        const { send, saved } = absentStore(cloud)
        const launch = vi.fn(async () => {
            expect(saved.coordinator).toEqual({ provider: 'claude-cli', model: 'opus', thinkingLevel: 'medium' })
            return { ok: true }
        })
        await act(async () => {
            root.render(<TransportProvider value={{ sendCommand: send }}>
                <DashboardNewSessionDialog machines={[machine]} ides={[]} onClose={() => {}}
                    initialLaunchMode="mesh" initialMeshWorkspacePath="/repo"
                    onBrowseDirectory={async () => ({ path: '/', directories: [] })}
                    onSaveWorkspace={async () => ({ ok: true })} onLaunchIde={async () => ({ ok: true })}
                    onLaunchProvider={async () => ({ ok: true })} onListSavedSessions={async () => []}
                    onListMeshes={async () => [{ id: 'mesh-1', name: 'Project', workspace: '/repo' }]}
                    onLaunchMeshCoordinator={launch} />
            </TransportProvider>)
        })
        expect(document.querySelector('[data-launch-default-role="coordinator"]')).toBeTruthy()
        expect(document.querySelector('[data-launch-default-role="assistant"]')).toBeNull()
        await saveDefault()
        const defaultOption = [...document.querySelectorAll('[role="radio"]')].find(button => button.textContent?.includes('Saved coordinator default'))!
        expect(defaultOption.textContent).toContain('claude-cli · opus · medium')
        await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Start mesh coordinator'))
        expect(launch).toHaveBeenCalledWith('machine-1', 'mesh-1', '', expect.objectContaining({ initialModel: null, initialThinkingLevel: null }))
    })
})
