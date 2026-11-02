// @vitest-environment jsdom
/**
 * Owner-decision presses feel instant: the card/badge update in the same tick as the press (before the
 * daemon answers), a failure reverts with the error, only the owning daemon is re-fetched, and a slow,
 * hanging or failing machine never holds up (or empties) the others' items.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/compat', () => ({
    useDaemons: () => ({
        ides: [{ id: 'dA', type: 'adhdev-daemon' }, { id: 'dB', type: 'adhdev-daemon' }],
        connectionStates: { dA: 'connected', dB: 'connected' },
        initialLoaded: true,
    }),
}))

import { LIST_TIMEOUT_MS, NeedsYouProvider, useNeedsYou, type NeedsYouState } from '../../src/context/NeedsYouContext'
import { TransportProvider } from '../../src/context/TransportContext'
import { TransferDecisionBody } from '../../src/components/needs-you/TransferDecisionBody'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let latest: NeedsYouState | null = null
function Probe() { latest = useNeedsYou(); return null }

const decisionRow = (itemId: string, meshId = 'm1') => ({
    meshId, missionId: 'ms1', missionTitle: 'T', itemId, question: `Q ${itemId}?`, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    allowFreeText: true, urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: 'x',
})
const checkRow = (itemId: string) => ({ meshId: 'm1', missionId: 'ms1', missionTitle: 'T', itemId, text: 'check it', createdAt: 'x' })

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('NeedsYouProvider — optimistic presses and per-daemon lists', () => {
    let root: Root
    let calls: Array<{ id: string; type: string; payload: any }>
    beforeEach(() => { root = createRoot(document.createElement('div')); calls = []; latest = null })
    afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

    const mount = async (send: (id: string, type: string, payload?: any) => Promise<any>) => {
        const sendCommand = vi.fn(async (id: string, type: string, payload?: any) => { calls.push({ id, type, payload }); return send(id, type, payload) })
        await act(async () => { root.render(<TransportProvider value={{ sendCommand }}><NeedsYouProvider><Probe /></NeedsYouProvider></TransportProvider>) })
        await flush()
    }
    const listOk = (rows: any[], extra: Record<string, unknown> = {}) => ({ success: true, result: { success: true, ownerDecisions: rows, ...extra } })

    it('shows the answer and drops the badge before the command resolves', async () => {
        const gate = deferred<any>()
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') return id === 'dA' ? listOk([decisionRow('mi_1')]) : listOk([])
            return gate.promise
        })
        expect(latest!.count).toBe(1)
        expect(latest!.snapshot.decisions).toHaveLength(1)

        let pendingOutcome!: Promise<any>
        act(() => { pendingOutcome = latest!.answer({ daemonId: 'dA', meshId: 'm1', missionId: 'ms1', itemId: 'mi_1', optionId: 'a' }) })
        // command still unresolved — the UI already moved on
        expect(latest!.snapshot.decisions).toHaveLength(0)
        expect(latest!.count).toBe(0)
        expect(latest!.snapshot.answered).toHaveLength(1)
        expect(latest!.snapshot.answered[0]).toMatchObject({ itemId: 'mi_1', sending: true, answer: { optionId: 'a' } })
        expect(latest!.busyIds.has('mi_1')).toBe(true)

        await act(async () => { gate.resolve({ success: true, action: 'answered' }); await pendingOutcome })
        expect(latest!.snapshot.answered[0]?.sending).not.toBe(true)
        expect(latest!.busyIds.has('mi_1')).toBe(false)
    })

    it('reverts to the open card, restores the badge and reports the error when the command fails', async () => {
        const gate = deferred<any>()
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') return id === 'dA' ? listOk([decisionRow('mi_1')]) : listOk([])
            return gate.promise
        })
        let p!: Promise<any>
        act(() => { p = latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a' }) })
        expect(latest!.count).toBe(0)
        await act(async () => { gate.resolve({ success: false, code: 'decision_not_open' }); await p })
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_1'])
        expect(latest!.snapshot.answered).toHaveLength(0)
        expect(latest!.count).toBe(1)
        expect(latest!.outcomes.mi_1).toEqual({ ok: false, code: 'decision_not_open' })
    })

    it('reverts when the command throws (transport error)', async () => {
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') return id === 'dA' ? listOk([decisionRow('mi_1')]) : listOk([])
            throw new Error('p2p closed')
        })
        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', text: 'hello' }) })
        expect(latest!.count).toBe(1)
        expect(latest!.outcomes.mi_1).toEqual({ ok: false, code: 'p2p closed', text: 'hello' })
    })

    it('keeps the overlay after success until the owning daemon lists the answer, and re-fetches only that daemon', async () => {
        const relist = deferred<any>()
        let answered = false
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') {
                if (id === 'dB') return listOk([])
                if (!answered) return listOk([decisionRow('mi_1')])
                return relist.promise
            }
            answered = true
            return { success: true, action: 'answered' }
        })
        calls.length = 0
        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a' }) })
        // the returned promise did not wait for the refresh; the stale open decision is NOT back
        expect(latest!.snapshot.decisions).toHaveLength(0)
        expect(latest!.count).toBe(0)
        expect(calls.filter(c => c.type === 'mission_decisions_list').map(c => c.id)).toEqual(['dA'])
        // the daemon's own list arrives with the recorded answer: the overlay hands over to real data
        await act(async () => {
            relist.resolve(listOk([], { recentlyAnswered: [{ meshId: 'm1', missionId: 'ms1', itemId: 'mi_1', question: 'Q', revision: 1, answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: '2026-11-02T00:00:00.000Z' }, options: [] }] }))
            await Promise.resolve()
        })
        await flush()
        expect(latest!.snapshot.answered).toHaveLength(1)
        expect(latest!.snapshot.answered[0].sending).toBeUndefined()
        expect(latest!.snapshot.answered[0].answer.at).toBe('2026-11-02T00:00:00.000Z')
    })

    it('live-check verdict: "Works" disappears at once and returns on failure', async () => {
        const gate = deferred<any>()
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') return id === 'dA' ? { success: true, liveChecks: [checkRow('lc_1')] } : listOk([])
            return gate.promise
        })
        expect(latest!.snapshot.liveChecks).toHaveLength(1)
        let p!: Promise<any>
        act(() => { p = latest!.resolveLiveCheck({ daemonId: 'dA', meshId: 'm1', itemId: 'lc_1', verdict: 'works' }) })
        expect(latest!.snapshot.liveChecks).toHaveLength(0)
        await act(async () => { gate.resolve({ success: false, code: 'nope' }); await p })
        expect(latest!.snapshot.liveChecks).toHaveLength(1)
        expect(latest!.outcomes.lc_1).toEqual({ ok: false, code: 'nope' })
    })

    it('one hanging machine does not block the others: its items render as they arrive, then it times out as stale', async () => {
        vi.useFakeTimers()
        const never = new Promise<any>(() => {})
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') return id === 'dA' ? listOk([decisionRow('mi_1')]) : never
            return { success: true }
        })
        expect(latest!.loaded).toBe(true)
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_1'])
        expect(latest!.loadingCount).toBe(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(LIST_TIMEOUT_MS + 50) })
        expect(latest!.loadingCount).toBe(0)
        expect(latest!.staleDaemonIds).toEqual(['dB'])
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_1'])
    })

    it('a failed re-fetch keeps that machine\'s previous items (stale) instead of emptying them', async () => {
        let fail = false
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') {
                if (id === 'dB') return listOk([decisionRow('mi_b', 'm2')])
                if (fail) throw new Error('relay down')
                return listOk([decisionRow('mi_a')])
            }
            return { success: true }
        })
        expect(latest!.snapshot.decisions.map(d => d.itemId).sort()).toEqual(['mi_a', 'mi_b'])
        fail = true
        await act(async () => { await latest!.refresh() })
        expect(latest!.snapshot.decisions.map(d => d.itemId).sort()).toEqual(['mi_a', 'mi_b'])
        expect(latest!.staleDaemonIds).toEqual(['dA'])
        fail = false
        await act(async () => { await latest!.refresh() })
        expect(latest!.staleDaemonIds).toEqual([])
    })
})

describe('TransferDecisionBody — approval stays pessimistic but shows progress at once', () => {
    it('answers only after both approvals succeed; "Approving…" is visible immediately', async () => {
        const container = document.createElement('div'); document.body.appendChild(container)
        const root = createRoot(container)
        const gate = deferred<any>()
        const view = {
            id: 'a'.repeat(32), state: 'previewed', role: 'source', peerDaemonId: 'dB', selectionDigest: 'sd', localApproved: false,
            fileCount: 1, totalBytes: 10, excluded: [], requestedBy: { role: 'assistant' },
        }
        const decision: any = { daemonId: 'dA', meshId: 'm', missionId: 'x', missionTitle: 't', itemId: 'i1', transferId: 'a'.repeat(32), question: 'q', options: [{ id: 'o1', label: 'Approve' }, { id: 'o2', label: 'Reject' }], allowFreeText: false, urgency: 'normal', onDue: 'remind', source: 'daemon', createdAt: '' }
        const send = async (_id: string, cmd: string) => {
            if (cmd === 'project_transfer_status') return { success: true, transfer: view }
            if (cmd === 'project_transfer_approve') return gate.promise
            return { success: true }
        }
        const answers: any[] = []
        await act(async () => { root.render(<TransportProvider value={{ sendCommand: send }}><TransferDecisionBody decision={decision} onAnswer={a => answers.push(a)} /></TransportProvider>); await Promise.resolve(); await Promise.resolve() })
        const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
        act(() => { q('transfer-decision-approve')!.click() })
        expect(q('transfer-decision-progress')).toBeTruthy()
        expect((q('transfer-decision-approve') as HTMLButtonElement).disabled).toBe(true)
        expect(answers).toEqual([])
        await act(async () => { gate.resolve({ success: true }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
        expect(answers).toEqual([{ optionId: 'o1' }])
        act(() => root.unmount()); container.remove()
    })
})
