// @vitest-environment jsdom
//
// Remembered-choice preselect tests for DashboardNewSessionDialog.
//
// The dialog stores the last successfully launched selection in localStorage
// (utils/remembered-choice.ts, scopes `adhdev.remember.new-session-*`) and, on
// the next open, preselects those values ONLY when they still exist in the
// current option lists (fail-open — stale values silently fall back to the
// defaults). Values are written on a successful launch, never before.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardNewSessionDialog from '../../../src/components/dashboard/DashboardNewSessionDialog'
import type { DaemonData } from '../../../src/types'

const DIALOG_KEY = 'adhdev.remember.new-session-dialog'
const WORKSPACE_KEY = 'adhdev.remember.new-session-workspace'

let container: HTMLDivElement
let root: Root
let store: Map<string, string>

// The global test setup replaces `globalThis.localStorage` with a fixed stub
// (language pin), and jsdom keeps its own Storage on `window`. The component
// reads `window.localStorage`, so install a controllable in-memory Storage
// there to make seeding and asserting deterministic.
function installLocalStorage(): Map<string, string> {
    const backing = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
            setItem: (key: string, value: string) => { backing.set(key, value) },
            removeItem: (key: string) => { backing.delete(key) },
        },
    })
    return backing
}

beforeEach(() => {
    store = installLocalStorage()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

function createMachine(index: number): DaemonData {
    return {
        id: `machine-${index}`,
        machineId: `machine-${index}`,
        type: 'adhdev-daemon',
        status: 'online',
        nickname: `Machine ${index}`,
        availableProviders: [
            {
                type: 'claude',
                name: 'Claude',
                displayName: 'Claude',
                icon: 'claude',
                category: 'cli',
                installed: true,
                enabled: true,
                machineStatus: 'detected',
            },
            {
                type: 'codex',
                name: 'Codex',
                displayName: 'Codex',
                icon: 'codex',
                category: 'cli',
                installed: true,
                enabled: true,
                machineStatus: 'detected',
            },
        ],
        detectedIdes: [],
        workspaces: [],
        recentLaunches: [],
    } as DaemonData
}

function renderDialog(machines: DaemonData[], overrides: {
    onClose?: () => void
    onLaunchProvider?: Parameters<typeof DashboardNewSessionDialog>[0]['onLaunchProvider']
} = {}) {
    act(() => {
        root.render(
            React.createElement(DashboardNewSessionDialog, {
                machines,
                ides: [],
                onClose: overrides.onClose || (() => {}),
                onBrowseDirectory: async () => ({ path: '/', directories: [] }),
                onSaveWorkspace: async () => ({ ok: true }),
                onLaunchIde: async () => ({ ok: true }),
                onLaunchProvider: overrides.onLaunchProvider || (async () => ({ ok: true })),
                onListMeshes: async () => [],
                onLaunchMeshCoordinator: async () => ({ ok: true }),
                onListSavedSessions: async () => [],
            }),
        )
    })
}

// The dialog renders through ModalPortal into document.body.
function allButtons(): HTMLButtonElement[] {
    return [...document.body.querySelectorAll('button')]
}

function findTargetButton(label: string): HTMLButtonElement {
    const btn = allButtons().find(button => button.textContent?.trim() === label)
    if (!btn) throw new Error(`target button "${label}" not found`)
    return btn
}

function findMachineChip(name: string): HTMLButtonElement {
    const btn = document.body.querySelector(`button[aria-label="Select machine ${name}"]`)
    if (!btn) throw new Error(`machine chip "${name}" not found`)
    return btn as HTMLButtonElement
}

describe('DashboardNewSessionDialog remembered choices', () => {
    it('preselects the remembered machine and provider target when they still exist', () => {
        store.set(DIALOG_KEY, JSON.stringify({ machineId: 'machine-2', mode: 'workspace' }))
        store.set(WORKSPACE_KEY, JSON.stringify({ kind: 'cli', target: 'codex', workspaceChoice: '__home__' }))

        renderDialog([createMachine(1), createMachine(2)])

        expect(findMachineChip('Machine 2').getAttribute('aria-pressed')).toBe('true')
        expect(findMachineChip('Machine 1').getAttribute('aria-pressed')).toBe('false')
        // Selected target carries the accent border; unselected the subtle one.
        expect(findTargetButton('Codex').className).toContain('border-accent')
        expect(findTargetButton('Claude').className).not.toContain('border-accent')
    })

    it('silently falls back to the defaults when the remembered values no longer exist', () => {
        store.set(DIALOG_KEY, JSON.stringify({ machineId: 'machine-gone', mode: 'workspace' }))
        store.set(WORKSPACE_KEY, JSON.stringify({ kind: 'cli', target: 'ghost-cli', workspaceChoice: 'ws-gone' }))

        renderDialog([createMachine(1), createMachine(2)])

        // Default machine (first sorted) and default provider (first in list).
        expect(findMachineChip('Machine 1').getAttribute('aria-pressed')).toBe('true')
        expect(findTargetButton('Claude').className).toContain('border-accent')
        expect(findTargetButton('Codex').className).not.toContain('border-accent')
    })

    it('writes the committed choices to localStorage only after a successful launch', async () => {
        const onClose = vi.fn()
        const onLaunchProvider = vi.fn(async () => ({ ok: true }))
        renderDialog([createMachine(1)], { onClose, onLaunchProvider })

        // Nothing is remembered before launch.
        expect(store.has(DIALOG_KEY)).toBe(false)
        expect(store.has(WORKSPACE_KEY)).toBe(false)

        const launchButton = findTargetButton('Start fresh')
        expect(launchButton.disabled).toBe(false)
        await act(async () => {
            launchButton.click()
        })

        expect(onLaunchProvider).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
        expect(JSON.parse(store.get(DIALOG_KEY) || 'null')).toEqual({ machineId: 'machine-1', mode: 'workspace' })
        expect(JSON.parse(store.get(WORKSPACE_KEY) || 'null')).toEqual({
            workspaceChoice: '__home__',
            kind: 'cli',
            target: 'claude',
        })
    })

    it('does not remember anything when the launch fails', async () => {
        const onLaunchProvider = vi.fn(async () => ({ ok: false, error: 'boom' }))
        renderDialog([createMachine(1)], { onLaunchProvider })

        await act(async () => {
            findTargetButton('Start fresh').click()
        })

        expect(onLaunchProvider).toHaveBeenCalledTimes(1)
        expect(store.has(DIALOG_KEY)).toBe(false)
        expect(store.has(WORKSPACE_KEY)).toBe(false)
    })
})
