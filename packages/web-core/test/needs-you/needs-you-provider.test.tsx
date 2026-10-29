// @vitest-environment jsdom
/**
 * NeedsYouProvider wire behaviour: one list call per connected daemon (asking for answered rows,
 * live checks and mission structure), the answer command states `via: 'dashboard'`, an undo sends
 * `undo: true`, a daemon that does not know the command contributes nothing, and the cloud
 * `{ result }` wrapper is read.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/compat', () => ({
    useDaemons: () => ({
        ides: [{ id: 'dA', type: 'adhdev-daemon' }, { id: 'dB', type: 'adhdev-daemon' }, { id: 'ide1', type: 'cursor' }],
        connectionStates: { dA: 'connected', dB: 'connected' },
        initialLoaded: true,
    }),
}))

import { NeedsYouProvider, useNeedsYou, type NeedsYouState } from '../../src/context/NeedsYouContext'
import { TransportProvider } from '../../src/context/TransportContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let latest: NeedsYouState | null = null
function Probe() { latest = useNeedsYou(); return null }

describe('NeedsYouProvider', () => {
    afterEach(() => { latest = null })

    it('lists per daemon, merges, answers with via=dashboard and undoes', async () => {
        const calls: Array<{ id: string; type: string; payload: any }> = []
        const sendCommand = vi.fn(async (id: string, type: string, payload?: any) => {
            calls.push({ id, type, payload })
            if (type === 'mission_decisions_list') {
                if (id === 'dB') throw new Error('unknown command')
                return { success: true, result: { success: true, ownerDecisions: [{ meshId: 'm1', missionId: 'ms1', missionTitle: 'T', itemId: 'mi_1', question: 'Q?', options: [{ id: 'a', label: 'A' }], allowFreeText: true, urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: 'x' }] } }
            }
            return { success: true, action: 'answered', delivery: 'queued' }
        })
        const host = document.createElement('div')
        const root = createRoot(host)
        await act(async () => {
            root.render(<TransportProvider value={{ sendCommand }}><NeedsYouProvider><Probe /></NeedsYouProvider></TransportProvider>)
        })
        await act(async () => { await Promise.resolve() })
        const lists = calls.filter(c => c.type === 'mission_decisions_list')
        expect(lists.map(c => c.id).sort()).toEqual(['dA', 'dB'])
        expect(lists[0].payload).toEqual({ includeAnswered: true, includeLiveChecks: true, includeMissions: true })
        expect(latest!.loaded).toBe(true)
        expect(latest!.count).toBe(1)

        let outcome: any
        await act(async () => { outcome = await latest!.answer({ daemonId: 'dA', meshId: 'm1', missionId: 'ms1', itemId: 'mi_1', optionId: 'a' }) })
        const answerCall = calls.find(c => c.type === 'mission_decision_answer')!
        expect(answerCall.payload).toEqual({ meshId: 'm1', missionId: 'ms1', itemId: 'mi_1', optionId: 'a', via: 'dashboard' })
        expect(outcome).toMatchObject({ ok: true, delivery: 'queued' })
        // an answer refreshes the list
        expect(calls.filter(c => c.type === 'mission_decisions_list').length).toBeGreaterThan(2)

        await act(async () => { await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'mi_1', undo: true }) })
        expect(calls.filter(c => c.type === 'mission_decision_answer').pop()!.payload).toMatchObject({ undo: true, via: 'dashboard' })
        act(() => root.unmount())
    })

    it('reports a refused answer as a failed outcome', async () => {
        const sendCommand = vi.fn(async (_id: string, type: string) => type === 'mission_decisions_list'
            ? { success: true, ownerDecisions: [] }
            : { success: false, code: 'decision_not_open', error: 'nope' })
        const root = createRoot(document.createElement('div'))
        await act(async () => { root.render(<TransportProvider value={{ sendCommand }}><NeedsYouProvider><Probe /></NeedsYouProvider></TransportProvider>) })
        let outcome: any
        await act(async () => { outcome = await latest!.answer({ daemonId: 'dA', meshId: 'm1', itemId: 'x', optionId: 'a' }) })
        expect(outcome).toEqual({ ok: false, code: 'decision_not_open' })
        expect(latest!.outcomes.x).toEqual({ ok: false, code: 'decision_not_open' })
        act(() => root.unmount())
    })
})
