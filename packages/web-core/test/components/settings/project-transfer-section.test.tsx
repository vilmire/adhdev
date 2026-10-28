// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectTransferSection, type ProjectTransferMachine } from '../../../src/components/settings/ProjectTransferSection'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

const MACHINES: ProjectTransferMachine[] = [
    { id: 'daemon_mach_a', name: 'MacA', online: true, workspaces: [{ id: 'ws-a', path: '/a/proj', label: 'projA' }] },
    { id: 'daemon_mach_b', name: 'WinB', online: true, workspaces: [{ id: 'ws-b', path: 'C:/b/proj', label: 'projB' }] },
]
const DIGEST = 'f'.repeat(64)

describe('ProjectTransferSection', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove() })

    it('shows a hint with fewer than two machines', async () => {
        await act(async () => { root.render(<ProjectTransferSection machines={[MACHINES[0]!]} sendCommand={vi.fn()} />); await flush() })
        expect(container.querySelector('[data-testid="project-transfer-no-machines"]')).not.toBeNull()
    })

    it('previews a selection and sends the SAME selection digest to BOTH machines when approving', async () => {
        const calls: Array<[string, string, any]> = []
        const send = vi.fn(async (id: string, cmd: string, args: any) => {
            calls.push([id, cmd, args])
            if (cmd === 'project_transfer_capabilities') return { success: true, supported: true, reasons: [] }
            if (cmd === 'project_transfer_browse') return { success: true, entries: [{ name: 'src', kind: 'dir' }, { name: 'a.txt', kind: 'file', size: 5 }, { name: '.env', kind: 'file', size: 3, excluded: 'secret:name:.env' }] }
            if (cmd === 'project_transfer_list') return { success: true, transfers: [] }
            if (cmd === 'project_transfer_create') return { success: true, transfer: { id: 't1', role: 'source', peerDaemonId: id, state: 'previewed', finalName: args.finalName, selectionDigest: DIGEST, fileCount: 1, totalBytes: 5, bytesDone: 0, previewExpiresAt: 1, entries: [{ path: 'a.txt', kind: 'file', size: 5 }], excluded: [{ path: '.env', reason: 'secret:name:.env' }], localApproved: false, peerApproved: false } }
            if (cmd === 'project_transfer_approve') return { success: true }
            return { success: false }
        })
        await act(async () => { root.render(<ProjectTransferSection machines={MACHINES} sendCommand={send} pollMs={60_000} />); await flush() })
        const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
        await act(async () => { setValue(q('project-transfer-from-machine') as HTMLSelectElement, 'daemon_mach_a'); await flush() })
        await act(async () => { setValue(q('project-transfer-from-project') as HTMLSelectElement, 'ws-a'); await flush() })
        await act(async () => { setValue(q('project-transfer-to-machine') as HTMLSelectElement, 'daemon_mach_b'); await flush() })
        await act(async () => { setValue(q('project-transfer-to-project') as HTMLSelectElement, 'ws-b'); await flush() })
        await act(async () => { setValue(q('project-transfer-folder') as HTMLInputElement, 'incoming'); await flush() })
        // excluded entries cannot be ticked
        const envBox = q('project-transfer-entry-.env').querySelector('input') as HTMLInputElement
        expect(envBox.disabled).toBe(true)
        await act(async () => { (q('project-transfer-entry-a.txt').querySelector('input') as HTMLInputElement).click(); await flush() })
        await act(async () => { q('project-transfer-preview').click(); await flush() })
        expect(calls.find((c) => c[1] === 'project_transfer_create')![2]).toMatchObject({ workspaceId: 'ws-a', selected: ['a.txt'], targetDaemonId: 'daemon_mach_b', targetWorkspaceId: 'ws-b', finalName: 'incoming' })
        expect(q('project-transfer-excluded').textContent).toContain('.env')
        await act(async () => { q('project-transfer-approve-both').click(); await flush() })
        const approvals = calls.filter((c) => c[1] === 'project_transfer_approve')
        expect(approvals.map((c) => c[0]).sort()).toEqual(['daemon_mach_a', 'daemon_mach_b'])
        for (const a of approvals) expect(a[2]).toEqual({ transferId: 't1', selectionDigest: DIGEST })
    })

    it('does not offer preview when a machine reports it cannot transfer', async () => {
        const send = vi.fn(async (_id: string, cmd: string) => cmd === 'project_transfer_capabilities' ? { success: true, supported: false, reasons: ['NATIVE_HELPER_UNAVAILABLE'] } : { success: true, entries: [], transfers: [] })
        await act(async () => { root.render(<ProjectTransferSection machines={MACHINES} sendCommand={send} pollMs={60_000} />); await flush() })
        const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
        await act(async () => { setValue(q('project-transfer-from-machine') as HTMLSelectElement, 'daemon_mach_a'); await flush() })
        expect(container.textContent).toContain('NATIVE_HELPER_UNAVAILABLE')
        expect((q('project-transfer-preview') as HTMLButtonElement).disabled).toBe(true)
    })
})

describe('projectTransfer i18n', () => {
  it('every locale defines the same keys as en', () => {
    const flat = (o: any, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]))
    const want = flat((en as any).settings.projectTransfer).sort()
    for (const [name, loc] of Object.entries({ ko, ja, 'zh-CN': zhCN, es }) as Array<[string, any]>) {
      expect(flat(loc.settings.projectTransfer).sort(), name).toEqual(want)
    }
  })
})
