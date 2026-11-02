// @vitest-environment jsdom
/**
 * Overlay lifetime and per-machine bookkeeping of the owner-decision inbox: undo drops the overlay, an overlay
 * has a hard expiry, a machine that leaves the set forgets its list, timing logs are opt-in and carry no raw
 * error text, and a failed free-text answer puts its text back in the card.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const daemons = vi.hoisted(() => ({ ids: ['dA', 'dB'] as string[] }))
vi.mock('../../src/compat', () => ({
    useDaemons: () => ({
        ides: daemons.ids.map(id => ({ id, type: 'adhdev-daemon' })),
        connectionStates: Object.fromEntries(daemons.ids.map(id => [id, 'connected'])),
        initialLoaded: true,
    }),
}))

import { NeedsYouProvider, useNeedsYou, type NeedsYouState } from '../../src/context/NeedsYouContext'
import { TransportProvider } from '../../src/context/TransportContext'
import DecisionCard from '../../src/components/needs-you/DecisionCard'
import { PENDING_ACTION_TTL_MS, applyPendingOwnerActions, EMPTY_NEEDS_YOU_SNAPSHOT, type NeedsYouDecision } from '../../src/components/needs-you/needs-you-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let latest: NeedsYouState | null = null
function Probe() { latest = useNeedsYou(); return null }
const row = (itemId: string) => ({
    meshId: 'm1', missionId: 'ms1', missionTitle: 'T', itemId, question: `Q ${itemId}?`, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    allowFreeText: true, urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: 'x',
})
const listOk = (rows: unknown[]) => ({ success: true, result: { success: true, ownerDecisions: rows } })
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('NeedsYouProvider lifecycle', () => {
    let root: Root
    beforeEach(() => {
        root = createRoot(document.createElement('div')); latest = null; daemons.ids = ['dA', 'dB']
        // The shared test setup stubs localStorage as read-only; give this file a working one.
        const store = new Map<string, string>()
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    })
    afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

    const mount = async (send: (id: string, type: string, payload?: any) => Promise<any>) => {
        const sendCommand = vi.fn(send)
        const tree = () => <TransportProvider value={{ sendCommand }}><NeedsYouProvider><Probe /></NeedsYouProvider></TransportProvider>
        await act(async () => { root.render(tree()) })
        await flush()
        return { rerender: async () => { await act(async () => { root.render(tree()) }); await flush() } }
    }

    it('undo drops the overlay of that item so the decision is not left hidden', async () => {
        let listCalls = 0
        let failLists = false
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') {
                listCalls += 1
                if (failLists && id === 'dA') throw new Error('p2p down')
                return id === 'dA' ? listOk([row('mi_1')]) : listOk([])
            }
            return { success: true, action: 'answered' }
        })
        // the confirmed overlay stays until a later list; the owning machine's lists fail from now on
        failLists = true
        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a' }) })
        expect(latest!.snapshot.decisions).toHaveLength(0)
        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', undo: true }) })
        await flush()
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_1'])
        expect(listCalls).toBeGreaterThan(0)
    })

    it('an unconfirmed press whose command never returns reverts to the open card after the hard expiry', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') return id === 'dA' ? listOk([row('mi_1')]) : listOk([])
            return new Promise(() => {})
        })
        act(() => { void latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a' }) })
        expect(latest!.snapshot.decisions).toHaveLength(0)
        await act(async () => { vi.advanceTimersByTime(PENDING_ACTION_TTL_MS + 50) })
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_1'])
    })

    it('a confirmed overlay on a machine whose list keeps failing also expires (it cannot pin the card forever)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        let failLists = false
        await mount(async (id, type) => {
            if (type === 'mission_decisions_list') {
                if (failLists && id === 'dA') throw new Error('p2p down')
                return id === 'dA' ? listOk([row('mi_1')]) : listOk([])
            }
            return { success: true, action: 'answered' }
        })
        failLists = true
        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a' }) })
        await flush()
        expect(latest!.snapshot.decisions).toHaveLength(0)
        expect(latest!.staleDaemonIds).toContain('dA')
        await act(async () => { vi.advanceTimersByTime(PENDING_ACTION_TTL_MS + 50) })
        // Not silently "answered" any more: the machine's last list (open) shows again, flagged stale.
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_1'])
        expect(latest!.staleDaemonIds).toContain('dA')
    })

    it('applyPendingOwnerActions ignores an expired overlay', () => {
        const base = { ...EMPTY_NEEDS_YOU_SNAPSHOT, decisions: [{ daemonId: 'dA', meshId: 'm1', missionId: 'ms1', missionTitle: 'T', itemId: 'mi_1', question: 'Q', options: [], allowFreeText: true, urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: 'x' } as NeedsYouDecision] }
        const action = { kind: 'answer' as const, daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a', at: 'x', expiresAt: 1000 }
        expect(applyPendingOwnerActions(base, [action], 999).decisions).toHaveLength(0)
        expect(applyPendingOwnerActions(base, [action], 1001).decisions).toHaveLength(1)
    })

    it('a machine that leaves and comes back counts as not loaded instead of showing its old list as fresh', async () => {
        let hold = false
        let release!: (v: unknown) => void
        const { rerender } = await mount(async (id, type) => {
            if (type !== 'mission_decisions_list') return { success: true }
            if (id === 'dB' && hold) return new Promise(r => { release = r })
            return id === 'dB' ? listOk([row('mi_b')]) : listOk([])
        })
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_b'])
        daemons.ids = ['dA']
        await rerender()
        expect(latest!.snapshot.decisions).toHaveLength(0)
        hold = true
        daemons.ids = ['dA', 'dB']
        await rerender()
        // dB is back but has not answered yet: no old data, and it is counted as still loading
        expect(latest!.snapshot.decisions).toHaveLength(0)
        expect(latest!.loadingCount).toBe(1)
        await act(async () => { release(listOk([row('mi_b')])); await Promise.resolve() })
        await flush()
        expect(latest!.snapshot.decisions.map(d => d.itemId)).toEqual(['mi_b'])
        expect(latest!.loadingCount).toBe(0)
    })

    it('timing logs are off by default, opt-in via localStorage["needs-you-debug"], and never carry raw error text', async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
        const send = async (id: string, type: string) => {
            if (type === 'mission_decisions_list') return id === 'dA' ? listOk([row('mi_1')]) : listOk([])
            throw new Error('secret-ish transport detail 12345')
        }
        await mount(send)
        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a' }) })
        expect(debug).not.toHaveBeenCalled()

        localStorage.setItem('needs-you-debug', '1')
        act(() => root.unmount()); root = createRoot(document.createElement('div'))
        await mount(send)
        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', optionId: 'a' }) })
        expect(debug).toHaveBeenCalled()
        const logged = JSON.stringify(debug.mock.calls)
        expect(logged).not.toContain('secret-ish')
        expect(logged).toContain('"failure":"transport"')
    })
})

describe('DecisionCard free text after a failed answer', () => {
    it('puts the typed text back in the field', async () => {
        const host = document.createElement('div'); document.body.appendChild(host)
        const root = createRoot(host)
        const decision = { daemonId: 'dA', meshId: 'm1', missionId: 'ms1', missionTitle: 'T', itemId: 'mi_1', question: 'Q?', options: [], allowFreeText: true, urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: 'x' } as NeedsYouDecision
        act(() => { root.render(<DecisionCard decision={decision} nowMs={0} outcome={{ ok: false, code: 'p2p closed', text: 'my careful answer' }} onAnswer={() => {}} />) })
        const input = host.querySelector('input') as HTMLInputElement
        expect(input.value).toBe('my careful answer')
        act(() => root.unmount()); host.remove()
    })
})
