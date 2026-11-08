// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectTransferSection, type ProjectTransferMachine } from '../../../src/components/settings/ProjectTransferSection'
import { TransferDecisionBody } from '../../../src/components/needs-you/TransferDecisionBody'
import { TransportProvider } from '../../../src/context/TransportContext'
import { transferTitleKey } from '../../../src/components/settings/projectTransferApi'
import { parseNeedsYouList } from '../../../src/components/needs-you/needs-you-model'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const MACHINES: ProjectTransferMachine[] = [
    { id: 'daemon_mach_a', name: 'MacA', online: true, workspaces: [{ id: 'ws-a', path: '/a/proj', label: 'projA' }] },
    { id: 'daemon_mach_b', name: 'WinB', online: true, workspaces: [{ id: 'ws-b', path: 'C:/b/proj', label: 'projB' }] },
]
const DIGEST = 'f'.repeat(64)
const base = { id: 'tx1', role: 'source', peerDaemonId: 'daemon_mach_b', finalName: 'incoming', sourceWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', selectionDigest: DIGEST, previewExpiresAt: 1, totalBytes: 1000, bytesDone: 1000, fileCount: 1, entries: [], excluded: [], localApproved: true, peerApproved: true }

describe('transfer row title follows the state', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove() })
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const render = async (transfer: any, extra: Record<string, any> = {}) => {
        const send = vi.fn(async (_id: string, cmd: string) => {
            if (cmd === 'project_transfer_capabilities') return { success: true, supported: true, reasons: [], ...extra }
            if (cmd === 'project_transfer_list') return { success: true, transfers: [transfer] }
            return { success: true, entries: [] }
        })
        await act(async () => { root.render(<ProjectTransferSection machines={MACHINES} sendCommand={send} pollMs={60_000} />); await flush() })
        return send
    }

    const cases: Array<[string, 'source' | 'target', string]> = [
        ['completed', 'source', 'Sent'], ['completed', 'target', 'Received'],
        ['failed', 'source', 'Send failed'], ['failed', 'target', 'Receive failed'],
        ['cancelled', 'source', 'Cancelled'], ['expired', 'target', 'Expired'],
    ]
    for (const [state, role, title] of cases) {
        it(`${state} (${role}) reads "${title}" and drops the duplicate state word`, async () => {
            await render({ ...base, role, state, ...(state === 'failed' ? { errorCode: 'DIRECT_UNAVAILABLE' } : {}), path: 'relay' })
            const t = q('project-transfer-title-tx1')!.textContent!
            expect(t.startsWith(title)).toBe(true)
            expect(t).not.toMatch(/Sending|Receiving/)
            expect(q('project-transfer-state-tx1')).toBeNull()
            expect(q('project-transfer-path-tx1')).not.toBeNull() // the relay chip stays
            if (state === 'failed') {
                const err = q('project-transfer-error-tx1')!
                expect(err.textContent).toBe('No direct connection — turn on relay.') // short plain sentence
                expect(err.textContent).not.toContain('DIRECT_UNAVAILABLE') // the raw code is tooltip-only
                expect(err.getAttribute('title')).toContain('DIRECT_UNAVAILABLE')
            }
        })
    }

    it('active states keep Sending / Receiving plus the state word', async () => {
        await render({ ...base, state: 'transferring', bytesDone: 10 })
        expect(q('project-transfer-title-tx1')!.textContent).toMatch(/^Sending/)
        expect(q('project-transfer-state-tx1')!.textContent).toBe('Transferring')
        expect(transferTitleKey('target', 'paused')).toBe('roleTarget')
    })

    it('the DIRECT_UNAVAILABLE text stays true whether or not a relay was available', () => {
        for (const loc of [en, ko, ja, zhCN, es] as any[]) {
            const text: string = loc.settings.projectTransfer.errors.DIRECT_UNAVAILABLE
            expect(text).not.toMatch(/for both|양쪽|両方|ambas|两台设备没有同时/)
        }
        expect((en as any).settings.projectTransfer.errors.DIRECT_UNAVAILABLE).toContain("a relay wasn't used for this transfer")
    })

    it('has the new strings in all five locales (terminal titles, agent, overwrite, decision card)', () => {
        const need = ['roleTitle.sourceDone', 'roleTitle.targetDone', 'roleTitle.sourceFailed', 'roleTitle.targetFailed', 'roleTitle.cancelled', 'roleTitle.expired', 'agent.toggle', 'agent.coordinator', 'agent.assistant', 'overwrite.revert', 'overwrite.replacedTitle', 'mode.existingPath', 'errors.TARGET_CHANGED']
        for (const loc of [en, ko, ja, zhCN, es] as any[]) {
            for (const k of need) expect(k.split('.').reduce((o: any, p) => o?.[p], loc.settings.projectTransfer), k).toBeTruthy()
            for (const k of ['approve', 'reject', 'summary', 'replacedTitle']) expect(loc.needsYou.transfer[k], k).toBeTruthy()
        }
        expect((ko as any).settings.projectTransfer.roleTitle.sourceDone).toBe('전송 완료')
        expect((ko as any).settings.projectTransfer.roleTitle.targetFailed).toBe('수신 실패')
        expect((ko as any).settings.projectTransfer.roleTitle.expired).toBe('만료됨')
    })

    it('shows who requested a transfer (coordinator / assistant)', async () => {
        await render({ ...base, state: 'previewed', localApproved: false, requestedBy: { role: 'coordinator', sessionId: 's1' } })
        expect(q('project-transfer-requested-by-tx1')!.textContent).toBe('Requested by coordinator')
    })

    it('a completed overwrite on the target machine shows Revert, which calls project_transfer_revert there', async () => {
        const target = { ...base, role: 'target', state: 'completed', peerDaemonId: 'daemon_mach_a', targetMode: 'existing_path', overwrite: { targetDir: '', digest: DIGEST, newCount: 1, replacedCount: 1, replaced: [{ path: 'a.txt', size: 3 }], revertible: true, reverted: false } }
        const calls: Array<[string, string, any]> = []
        const send = vi.fn(async (id: string, cmd: string, args: any) => {
            calls.push([id, cmd, args])
            if (cmd === 'project_transfer_capabilities') return { success: true, supported: true, reasons: [] }
            if (cmd === 'project_transfer_list') return { success: true, transfers: id === 'daemon_mach_b' ? [target] : [{ ...target, role: 'source', peerDaemonId: 'daemon_mach_b', overwrite: { ...target.overwrite, revertible: false } }] }
            if (cmd === 'project_transfer_revert') return { success: true, restored: 1, conflicts: [] }
            return { success: true, entries: [] }
        })
        await act(async () => { root.render(<ProjectTransferSection machines={MACHINES} sendCommand={send} pollMs={60_000} />); await flush() })
        await act(async () => { q('project-transfer-revert-tx1')!.click(); await flush() })
        expect(calls.find((c) => c[1] === 'project_transfer_revert')).toEqual(['daemon_mach_b', 'project_transfer_revert', { transferId: 'tx1' }])
    })
})

describe('owner decision card for an agent transfer', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove() })
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const decision: any = { daemonId: 'daemon_mach_a', meshId: 'm', missionId: 'x', missionTitle: 't', itemId: 'i1', transferId: 'a'.repeat(32), question: 'q', options: [{ id: 'o1', label: 'Approve' }, { id: 'o2', label: 'Reject' }], allowFreeText: false, urgency: 'normal', onDue: 'remind', source: 'daemon', createdAt: '' }
    const view = { ...base, id: 'a'.repeat(32), state: 'previewed', localApproved: false, requestedBy: { role: 'assistant' }, fileCount: 2, totalBytes: 2048, targetMode: 'existing_path', overwrite: { targetDir: '', digest: 'd'.repeat(64), newCount: 1, replacedCount: 1, replaced: [{ path: 'src/secret-plan.md', size: 10 }] } }

    it('shows the replaced list and Approve sends the owner approval to BOTH machines before answering', async () => {
        const calls: Array<[string, string, any]> = []
        const send = async (id: string, cmd: string, args: any) => {
            calls.push([id, cmd, args])
            if (cmd === 'project_transfer_status') return { success: true, transfer: view }
            return { success: true }
        }
        const answers: any[] = []
        await act(async () => { root.render(<TransportProvider value={{ sendCommand: send }}><TransferDecisionBody decision={decision} onAnswer={(a) => answers.push(a)} /></TransportProvider>); await flush() })
        expect(q('transfer-decision-replaced')!.textContent).toContain('src/secret-plan.md')
        expect(q('transfer-decision-requested-by')!.textContent).toBe('Requested by assistant')
        await act(async () => { q('transfer-decision-approve')!.click(); await flush() })
        const approvals = calls.filter((c) => c[1] === 'project_transfer_approve')
        expect(approvals.map((c) => c[0])).toEqual(['daemon_mach_a', 'daemon_mach_b'])
        for (const a of approvals) expect(a[2]).toEqual({ transferId: 'a'.repeat(32), selectionDigest: DIGEST, replaceDigest: 'd'.repeat(64) })
        expect(answers).toEqual([{ optionId: 'o1' }])
    })

    it('does not answer when an approval fails, and Reject cancels both machines', async () => {
        let fail = true
        const calls: Array<[string, string]> = []
        const send = async (id: string, cmd: string) => {
            calls.push([id, cmd])
            if (cmd === 'project_transfer_status') return { success: true, transfer: view }
            if (cmd === 'project_transfer_approve') return fail ? { success: false, code: 'TARGET_CHANGED' } : { success: true }
            return { success: true }
        }
        const answers: any[] = []
        await act(async () => { root.render(<TransportProvider value={{ sendCommand: send }}><TransferDecisionBody decision={decision} onAnswer={(a) => answers.push(a)} /></TransportProvider>); await flush() })
        await act(async () => { q('transfer-decision-approve')!.click(); await flush() })
        expect(answers).toEqual([])
        expect(container.textContent).toContain('TARGET_CHANGED')
        fail = false
        await act(async () => { q('transfer-decision-reject')!.click(); await flush() })
        expect(calls.filter((c) => c[1] === 'project_transfer_cancel').map((c) => c[0])).toEqual(['daemon_mach_a', 'daemon_mach_b'])
        expect(answers).toEqual([{ optionId: 'o2' }])
    })

    it('parses transferId from the decision list', () => {
        const snap = parseNeedsYouList({ success: true, ownerDecisions: [{ meshId: 'm', itemId: 'i', question: 'q', options: [], transferId: 'b'.repeat(32) }] }, 'daemon_mach_a')
        expect(snap.decisions[0]!.transferId).toBe('b'.repeat(32))
    })
})
