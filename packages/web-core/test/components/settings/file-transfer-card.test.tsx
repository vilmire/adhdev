// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileTransferCard, REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND } from '../../../src/components/settings/FileTransferCard'
import type { ProjectTransferMachine } from '../../../src/components/settings/ProjectTransferSection'
import { transferReasonText, HISTORY_COLLAPSED_COUNT } from '../../../src/components/settings/transferReasons'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const MACHINES: ProjectTransferMachine[] = [
    { id: 'daemon_mach_a', name: 'MacA', online: true, workspaces: [{ id: 'ws-a', path: '/a', label: 'projA' }] },
    { id: 'daemon_mach_b', name: 'WinB', online: true, workspaces: [{ id: 'ws-b', path: 'C:/b', label: 'projB' }] },
    { id: 'daemon_mach_c', name: 'Laptop', online: false, workspaces: [] },
]
const DIGEST = 'f'.repeat(64)
const tx = (n: number, over: Record<string, unknown> = {}) => ({ id: `tx${n}`, role: 'source', peerDaemonId: 'daemon_mach_b', state: 'completed', finalName: `f${n}`, sourceWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', selectionDigest: DIGEST, previewExpiresAt: 1000 - n, totalBytes: 10, bytesDone: 10, fileCount: 1, entries: [], excluded: [], localApproved: true, peerApproved: true, ...over })

describe('FileTransferCard', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = '' })
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const sw = (label: string) => container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!

    const makeSend = (transfers: any[] = [], caps: Record<string, any> = {}) => {
        const calls: Array<[string, string, any]> = []
        const send = vi.fn(async (id: string, cmd: string, args: any) => {
            calls.push([id, cmd, args])
            if (cmd === REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND) return args.action === 'get' ? { success: true, allowRemoteProjectAttach: id === 'daemon_mach_b' } : { success: true, allowRemoteProjectAttach: args.enabled }
            if (cmd === 'project_transfer_capabilities') return { success: true, supported: true, reasons: [], relayAllowed: true, agentAutoApprove: true, ...caps }
            if (cmd === 'project_transfer_set_relay') return { success: true, relayAllowed: args.allowRelay }
            if (cmd === 'project_transfer_set_agent_auto_approve') return { success: true, agentAutoApprove: args.allow }
            if (cmd === 'project_transfer_list') return { success: true, transfers }
            return { success: true, entries: [] }
        })
        return { send, calls }
    }
    const render = async (send: any) => { await act(async () => { root.render(<FileTransferCard machines={MACHINES} sendCommand={send} pollMs={60_000} />); await flush() }) }

    it('is one compact table: machines as rows, three plain-language switches, no internal names', async () => {
        const { send } = makeSend()
        await render(send)
        const text = container.textContent!
        for (const col of ['Remote project attach', 'Relay if no direct connection', 'Agents may send new folders without asking']) expect(text).toContain(col)
        expect(text).not.toContain('allowRemoteProjectAttach')
        expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
        // loaded values: attach only on B; relay on; agents on (new default)
        expect(sw('Remote project attach — MacA').getAttribute('aria-checked')).toBe('false')
        expect(sw('Remote project attach — WinB').getAttribute('aria-checked')).toBe('true')
        expect(sw('Relay if no direct connection — MacA').getAttribute('aria-checked')).toBe('true')
        expect(sw('Agents may send new folders without asking — MacA').getAttribute('aria-checked')).toBe('true')
        // an offline machine's switches are disabled
        expect(sw('Remote project attach — Laptop').getAttribute('aria-disabled')).toBe('true')
        // the manual form is NOT on the page; the history is not interrogating either
        expect(q('project-transfer-from-machine')).toBeNull()
    })

    it('each switch sends its own command to that machine, and rolls back with one plain error when saving fails', async () => {
        const { send, calls } = makeSend()
        await render(send)
        await act(async () => { sw('Remote project attach — MacA').click(); await flush() })
        await act(async () => { sw('Relay if no direct connection — MacA').click(); await flush() })
        await act(async () => { sw('Agents may send new folders without asking — WinB').click(); await flush() })
        expect(calls.find((c) => c[1] === REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND && c[2].action === 'set')).toEqual(['daemon_mach_a', REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND, { action: 'set', enabled: true }])
        expect(calls.find((c) => c[1] === 'project_transfer_set_relay')).toEqual(['daemon_mach_a', 'project_transfer_set_relay', { allowRelay: false }])
        expect(calls.find((c) => c[1] === 'project_transfer_set_agent_auto_approve')).toEqual(['daemon_mach_b', 'project_transfer_set_agent_auto_approve', { allow: false }])
        expect(sw('Remote project attach — MacA').getAttribute('aria-checked')).toBe('true')
        expect(sw('Relay if no direct connection — MacA').getAttribute('aria-checked')).toBe('false')
        expect(sw('Agents may send new folders without asking — WinB').getAttribute('aria-checked')).toBe('false')

        const failing = vi.fn(async (_id: string, cmd: string) => cmd === 'project_transfer_set_relay' ? { success: false, code: 'OWNER_INGRESS_REQUIRED' } : cmd === 'project_transfer_capabilities' ? { success: true, supported: true, relayAllowed: true, agentAutoApprove: false } : { success: true, transfers: [] })
        await act(async () => { root.render(<FileTransferCard machines={MACHINES} sendCommand={failing} pollMs={60_000} />); await flush() })
        await act(async () => { sw('Relay if no direct connection — WinB').click(); await flush() })
        expect(sw('Relay if no direct connection — WinB').getAttribute('aria-checked')).toBe('true')
        expect(container.textContent).toContain('Could not save the setting.')
        expect(container.textContent).not.toContain('OWNER_INGRESS_REQUIRED')
    })

    it('"Send files" opens the manual form in a dialog; it is not in the page before', async () => {
        const { send } = makeSend()
        await render(send)
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        await act(async () => { q('send-files-open')!.click(); await flush() })
        const dlg = document.querySelector('[role="dialog"]')!
        expect(dlg).not.toBeNull()
        expect(dlg.querySelector('[data-testid="project-transfer-from-machine"]')).not.toBeNull()
        expect(dlg.querySelector('[data-testid="project-transfer-relay"]')).toBeNull() // relay/agent policy lives in the table only
        expect(dlg.querySelector('[data-testid="project-transfer-list"]')).toBeNull() // history stays on the card
    })

    it('shows only the latest 3 transfers, with "Show all" and "Show less"', async () => {
        const { send } = makeSend([1, 2, 3, 4, 5].map((n) => tx(n)))
        await render(send)
        const rows = () => container.querySelectorAll('[data-testid^="project-transfer-row-"]')
        expect(rows()).toHaveLength(HISTORY_COLLAPSED_COUNT)
        const btn = q('project-transfer-show-all')!
        expect(btn.textContent).toBe('Show all (5)')
        await act(async () => { btn.click(); await flush() })
        expect(rows()).toHaveLength(5)
        expect(q('project-transfer-show-all')!.textContent).toBe('Show less')
        await act(async () => { q('project-transfer-show-all')!.click(); await flush() })
        expect(rows()).toHaveLength(3)
    })

    it('does not offer "Show all" for 3 or fewer transfers', async () => {
        const { send } = makeSend([tx(1), tx(2)])
        await render(send)
        expect(q('project-transfer-show-all')).toBeNull()
    })

    it('history rows show plain sentences; the raw code is only in the details tooltip', async () => {
        const { send } = makeSend([tx(1, { state: 'failed', errorCode: 'PREVIEW_EXPIRED' }), tx(2, { state: 'failed', errorCode: 'DIRECT_UNAVAILABLE' }), tx(3, { state: 'cancelled', errorCode: 'CANCELLED' })])
        await render(send)
        expect(q('project-transfer-error-tx1')!.textContent).toBe('Preview expired — send again.')
        expect(q('project-transfer-error-tx2')!.textContent).toBe('No direct connection — turn on relay.')
        expect(q('project-transfer-error-tx1')!.getAttribute('title')).toBe('Details: PREVIEW_EXPIRED')
        expect(container.textContent).not.toMatch(/PREVIEW_EXPIRED|DIRECT_UNAVAILABLE|CANCELLED/)
        expect(q('project-transfer-error-tx3')).toBeNull() // the title already says "Cancelled"
    })
})

describe('transferReasonText', () => {
    const get = (k: string): unknown => k.split('.').reduce((o: any, p) => o?.[p], en)
    const i18n = { exists: (k: string) => typeof get(k) === 'string' }
    const t = (k: string) => String(get(k))
    it('maps known codes to short sentences, falls back to the long text only when asked, else empty', () => {
        expect(transferReasonText(t, i18n, 'PREVIEW_EXPIRED')).toBe('Preview expired — send again.')
        expect(transferReasonText(t, i18n, 'NOT_A_CODE')).toBe('')
        expect(transferReasonText(t, i18n, 'TARGET_PATH_UNSAFE')).toBe('')
        expect(transferReasonText(t, i18n, 'TARGET_PATH_UNSAFE', { allowLong: true })).toContain('cannot be replaced safely')
    })
})

describe('settings.fileTransfer i18n', () => {
    it('every locale defines exactly the same keys as en, all non-empty, none leaking internal names', () => {
        const flat = (o: any, p = ''): Array<[string, unknown]> => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v] as [string, unknown]]))
        const want = flat((en as any).settings.fileTransfer).map(([k]) => k).sort()
        for (const [name, loc] of Object.entries({ en, ko, ja, 'zh-CN': zhCN, es }) as Array<[string, any]>) {
            const entries = flat(loc.settings.fileTransfer)
            expect(entries.map(([k]) => k).sort(), name).toEqual(want)
            for (const [k, v] of entries) {
                expect(String(v).trim().length, `${name}.${k}`).toBeGreaterThan(0)
                expect(String(v), `${name}.${k}`).not.toMatch(/allowRemoteProjectAttach/)
            }
        }
    })
})
