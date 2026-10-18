// @vitest-environment jsdom
/**
 * Machine "Launch defaults" card: per-role read (a broken saved default is
 * still shown with the daemon's reason), set with the read's document revision
 * as CAS, clear, re-read after every write, and hidden on an older daemon.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LaunchDefaultsCard from '../../src/pages/machine/LaunchDefaultsCard'
import {
    buildLaunchDefaultsSetArgs,
    parseLaunchDefaultsRead,
    parseLaunchDefaultsSetResult,
} from '../../src/pages/machine/launchDefaults'
import type { ProviderInfo } from '../../src/pages/machine/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const providers = [
    { type: 'claude-cli', name: 'claude-cli', displayName: 'Claude Code', category: 'cli', icon: '' },
    { type: 'codex-cli', name: 'codex-cli', displayName: 'Codex', category: 'cli', icon: '' },
    { type: 'cursor', name: 'cursor', displayName: 'Cursor', category: 'ide', icon: '' },
] as ProviderInfo[]

function getAnswer(revision = 1) {
    return {
        success: true, result: 'get', documentRevision: revision,
        roles: {
            assistant: {
                stored: { provider: 'claude-cli', model: 'opus', revision: 1, setBy: 'owner', setAt: 1 },
                effective: { ok: true, selection: { provider: 'claude-cli', model: 'opus' }, applied: {}, documentRevision: revision, warnings: [], toolRestriction: 'enforced' },
            },
            coordinator: {
                stored: null,
                effective: { ok: false, code: 'launch_default_required', role: 'coordinator', field: 'provider', reason: 'role_default_unset', hint: 'x' },
            },
        },
    }
}

describe('launch defaults model', () => {
    it('reads per-role views, including the cloud wrapper and a broken saved default', () => {
        const read = parseLaunchDefaultsRead({ success: true, result: getAnswer() })
        expect(read).toEqual({ kind: 'ok', state: { documentRevision: 1, roles: {
            assistant: { stored: { provider: 'claude-cli', model: 'opus' }, effective: { ok: true, selection: { provider: 'claude-cli', model: 'opus' } } },
            coordinator: { stored: null, effective: { ok: false, code: 'launch_default_required', reason: 'role_default_unset' } },
        } } })
        const broken = parseLaunchDefaultsRead({ success: true, result: 'get', documentRevision: 2, roles: { assistant: {
            stored: { provider: 'gone-cli', revision: 2, setBy: 'owner', setAt: 1 },
            effective: { ok: false, code: 'launch_default_unavailable', reason: 'provider_unknown' } } } })
        expect(broken).toMatchObject({ kind: 'ok', state: { roles: { assistant: { stored: { provider: 'gone-cli' },
            effective: { ok: false, code: 'launch_default_unavailable', reason: 'provider_unknown' } } } } })
    })

    it('separates a daemon refusal from an older daemon without the verb', () => {
        expect(parseLaunchDefaultsRead({ success: false, code: 'launch_default_unavailable', reason: 'launch_defaults_json_invalid' }))
            .toEqual({ kind: 'error', code: 'launch_default_unavailable' })
        expect(parseLaunchDefaultsRead({ success: false, error: 'Unknown command: launch_defaults_get' })).toEqual({ kind: 'unsupported' })
        expect(parseLaunchDefaultsRead(null)).toEqual({ kind: 'unsupported' })
    })

    it('builds whole-triple set / clear args and reads the set answer', () => {
        expect(buildLaunchDefaultsSetArgs('assistant', 3, { provider: 'codex-cli', model: ' gpt ', thinkingLevel: '' }))
            .toEqual({ action: 'set', role: 'assistant', expectedRevision: 3, provider: 'codex-cli', model: 'gpt' })
        expect(buildLaunchDefaultsSetArgs('coordinator', 3, null)).toEqual({ action: 'clear', role: 'coordinator', expectedRevision: 3 })
        expect(parseLaunchDefaultsSetResult({ success: true, result: { success: true, result: 'applied', durable: true } })).toEqual({ ok: true })
        expect(parseLaunchDefaultsSetResult({ success: false, code: 'store_busy', reason: 'write_lock_held: /x.lock' }))
            .toEqual({ ok: false, code: 'store_busy: write_lock_held: /x.lock' })
        expect(parseLaunchDefaultsSetResult({ success: true, result: 'staged' })).toEqual({ ok: false, code: 'failed' })
    })
})

describe('LaunchDefaultsCard', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    type Send = (id: string, type: string, data?: Record<string, unknown>) => Promise<unknown>
    async function mount(send: Send) {
        await act(async () => {
            root.render(<LaunchDefaultsCard machineId="daemon-1" providers={providers} sendDaemonCommand={send} />)
        })
    }
    const role = (r: string) => container.querySelector(`[data-launch-default-role="${r}"]`)!
    async function click(el: Element | null) {
        expect(el).toBeTruthy()
        await act(async () => { (el as HTMLElement).click() })
    }
    async function choose(el: Element | null, value: string) {
        expect(el).toBeTruthy()
        await act(async () => {
            const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
            Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
            el!.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
        })
    }

    it('offers the CLI\'s advertised models and thinking levels as dropdowns (2026-10-18)', async () => {
        const withOptions = [
            { type: 'claude-cli', name: 'claude-cli', displayName: 'Claude Code', category: 'cli', icon: '', modelOptions: ['sonnet', 'opus'], thinkingLevelOptions: ['low', 'high'] },
            { type: 'codex-cli', name: 'codex-cli', displayName: 'Codex', category: 'cli', icon: '', modelOptions: ['gpt-5'], thinkingLevelOptions: ['high', 'xhigh'] },
            { type: 'grok-cli', name: 'grok-cli', displayName: 'Grok', category: 'cli', icon: '' },
        ] as ProviderInfo[]
        const send = vi.fn(async (_id: string, type: string) =>
            type === 'launch_defaults_get' ? getAnswer() : { success: true, result: 'applied', durable: true })
        await act(async () => { root.render(<LaunchDefaultsCard machineId="daemon-1" providers={withOptions} sendDaemonCommand={send} />) })
        const field = (r: string, f: string) => role(r).querySelector(`[data-launch-default-field="${f}"]`)!
        const values = (el: Element) => [...el.querySelectorAll('option')].map(o => (o as HTMLOptionElement).value)
        // The saved assistant model is shown inside the dropdown with the advertised ones.
        expect(field('assistant', 'model').tagName).toBe('SELECT')
        expect(values(field('assistant', 'model'))).toEqual(['', 'sonnet', 'opus', '__custom__'])
        expect((field('assistant', 'model') as HTMLSelectElement).value).toBe('opus')
        expect(values(field('assistant', 'thinkingLevel'))).toEqual(['', 'low', 'high'])
        // Switching CLI drops a model the new CLI does not offer.
        await choose(role('assistant').querySelector('[data-launch-default-field="provider"]'), 'codex-cli')
        expect(values(field('assistant', 'model'))).toEqual(['', 'gpt-5', '__custom__'])
        expect((field('assistant', 'model') as HTMLSelectElement).value).toBe('')
        // A CLI that advertises nothing keeps a text box.
        await choose(role('assistant').querySelector('[data-launch-default-field="provider"]'), 'grok-cli')
        expect(field('assistant', 'model').tagName).toBe('INPUT')
    })

    it('renders nothing on a daemon without the verb', async () => {
        await mount(vi.fn(async () => ({ success: false, error: 'Unknown command' })))
        expect(container.innerHTML).toBe('')
    })

    it('shows each role on its own and saves a role with the read revision, then re-reads', async () => {
        const send = vi.fn(async (_id: string, type: string) =>
            type === 'launch_defaults_get' ? getAnswer() : { success: true, result: 'applied', durable: true })
        await mount(send)
        expect(send).toHaveBeenCalledWith('daemon-1', 'launch_defaults_get', {})
        expect(role('assistant').querySelector('[data-launch-default-status="ok"]')?.textContent).toContain('claude-cli · opus')
        expect(role('coordinator').querySelector('[data-launch-default-status="unset"]')).toBeTruthy()
        // Only CLI providers are offered.
        const options = [...role('coordinator').querySelectorAll('select option')].map(o => (o as HTMLOptionElement).value)
        expect(options).toEqual(['', 'claude-cli', 'codex-cli'])
        expect((role('coordinator').querySelector('[data-launch-default-action="clear"]') as HTMLButtonElement).disabled).toBe(true)

        await choose(role('coordinator').querySelector('select'), 'codex-cli')
        await choose(role('coordinator').querySelector('[data-launch-default-field="thinkingLevel"]'), 'high')
        await click(role('coordinator').querySelector('[data-launch-default-action="save"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'launch_defaults_set',
            { action: 'set', role: 'coordinator', expectedRevision: 1, provider: 'codex-cli', thinkingLevel: 'high' })
        expect(send.mock.calls.filter(c => c[1] === 'launch_defaults_get')).toHaveLength(2)
        expect(role('coordinator').querySelector('[data-launch-default-outcome="ok"]')).toBeTruthy()
    })

    it('explains an owner-only refusal (password-less standalone) instead of showing the raw code', async () => {
        const send = vi.fn(async (_id: string, type: string) =>
            type === 'launch_defaults_get'
                ? getAnswer()
                : { success: false, code: 'COMMAND_SOURCE_REJECTED', error: "Command 'launch_defaults_set' is not accepted from source 'ipc'" })
        await mount(send)
        await choose(role('coordinator').querySelector('select'), 'codex-cli')
        await click(role('coordinator').querySelector('[data-launch-default-action="save"]'))
        const outcome = role('coordinator').querySelector('[data-launch-default-outcome="COMMAND_SOURCE_REJECTED"]')
        expect(outcome).toBeTruthy()
        expect(outcome!.textContent).not.toContain('COMMAND_SOURCE_REJECTED')
        expect(outcome!.textContent).toMatch(/owner|ownerRequired/i)
    })

    it('keeps a saved default that no longer works visible, with its reason, and can clear it', async () => {
        const answer = { success: true, result: 'get', documentRevision: 4, roles: {
            assistant: { stored: { provider: 'gone-cli', revision: 4, setBy: 'owner', setAt: 1 },
                effective: { ok: false, code: 'launch_default_unavailable', reason: 'provider_unknown' } },
            coordinator: getAnswer().roles.coordinator,
        } }
        const send = vi.fn(async (_id: string, type: string) =>
            type === 'launch_defaults_get' ? answer : { success: false, code: 'revision_conflict', actualRevision: 5 })
        await mount(send)
        const status = role('assistant').querySelector('[data-launch-default-status="launch_default_unavailable"]')
        expect(status?.textContent).toContain('provider_unknown')
        expect((role('assistant').querySelector('select') as HTMLSelectElement).value).toBe('gone-cli')
        await click(role('assistant').querySelector('[data-launch-default-action="clear"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'launch_defaults_set', { action: 'clear', role: 'assistant', expectedRevision: 4 })
        expect(role('assistant').querySelector('[data-launch-default-outcome="revision_conflict"]')?.textContent).toContain('revision_conflict')
    })
})
