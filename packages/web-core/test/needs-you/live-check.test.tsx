// @vitest-environment jsdom
/**
 * rc.37: live-check verdict card ("Works" / "Doesn't work" + note), machine-filtered deep link,
 * post-deploy version-change prompt, and the "scope not recorded" chip on closed missions.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TodoDrawer from '../../src/components/needs-you/TodoDrawer'
import LiveCheckPrompt from '../../src/components/dashboard/LiveCheckPrompt'
import MissionStructureLine from '../../src/components/MeshGraph/MissionStructureLine'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'
import { NeedsYouStateProvider, type NeedsYouState } from '../../src/context/NeedsYouContext'
import {
    EMPTY_NEEDS_YOU_SNAPSHOT,
    buildNeedsYouEntries,
    countLiveChecksByMachine,
    filterNeedsYou,
    hasMissionScopeStatement,
    missionScopeNotRecorded,
    needsYouCount,
    parseNeedsYouList,
    parseNeedsYouQuery,
    type NeedsYouLiveCheck,
    type NeedsYouSnapshot,
} from '../../src/components/needs-you/needs-you-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const check = (over: Partial<NeedsYouLiveCheck> = {}): NeedsYouLiveCheck => ({
    daemonId: 'd1', meshId: 'm1', missionId: 'ms1', missionTitle: 'Deploy', itemId: 'mi_lc1', text: 'Open the dashboard on the phone',
    machine: 'Build-Box', createdAt: '2026-10-31T00:00:00.000Z', ...over,
})

function makeState(snap: Partial<NeedsYouSnapshot>, resolveLiveCheck = vi.fn(async () => ({ ok: true as const }))): NeedsYouState & { resolveLiveCheck: ReturnType<typeof vi.fn> } {
    const snapshot: NeedsYouSnapshot = { ...EMPTY_NEEDS_YOU_SNAPSHOT, ...snap }
    const entries = buildNeedsYouEntries(snapshot, [])
    return {
        snapshot, approvals: [], entries, count: needsYouCount(entries), loaded: true, outcomes: {}, busyIds: new Set(),
        refresh: async () => {}, answer: async () => ({ ok: true }), resolveLiveCheck,
    } as any
}

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
const click = (el: Element | null) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

describe('live check card', () => {
    it('Works / Doesn\'t work call resolveLiveCheck with the verdict and the optional note', async () => {
        const state = makeState({ liveChecks: [check()] })
        act(() => { root.render(<MemoryRouter initialEntries={['/dashboard?todo=1']}><NeedsYouStateProvider value={state}><TodoDrawer /></NeedsYouStateProvider></MemoryRouter>) })
        const note = q('[data-testid="needs-you-live-check-note"]') as HTMLInputElement
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
            setter.call(note, 'looked fine')
            note.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => { click(q('[data-testid="needs-you-live-check-works"]')) })
        expect(state.resolveLiveCheck).toHaveBeenLastCalledWith({ daemonId: 'd1', meshId: 'm1', itemId: 'mi_lc1', verdict: 'works', note: 'looked fine' })
        await act(async () => { click(q('[data-testid="needs-you-live-check-fails"]')) })
        expect(state.resolveLiveCheck).toHaveBeenLastCalledWith(expect.objectContaining({ verdict: 'doesnt_work' }))
    })

    it('a failed live check stays visible with a Failed badge', () => {
        const state = makeState({ liveChecks: [check({ state: 'failed' })] })
        act(() => { root.render(<MemoryRouter initialEntries={['/dashboard?todo=1']}><NeedsYouStateProvider value={state}><TodoDrawer /></NeedsYouStateProvider></MemoryRouter>) })
        expect(q('[data-live-check-state="failed"]')).toBeTruthy()
        expect(q('[data-testid="needs-you-live-check-failed"]')?.textContent).toBe('Failed')
    })

    it('?machine= deep link shows only that machine\'s live checks', () => {
        const state = makeState({ liveChecks: [check(), check({ itemId: 'mi_lc2', machine: 'office-pc', text: 'other machine' })] })
        act(() => { root.render(<MemoryRouter initialEntries={['/dashboard?todo=1&machine=build-box']}><NeedsYouStateProvider value={state}><TodoDrawer /></NeedsYouStateProvider></MemoryRouter>) })
        const cards = document.body.querySelectorAll('[data-testid="needs-you-live-check"]')
        expect(cards).toHaveLength(1)
        expect(cards[0].textContent).toContain('Build-Box')
        click(q('[data-testid="needs-you-machine-filter"]'))
        expect(document.body.querySelectorAll('[data-testid="needs-you-live-check"]')).toHaveLength(2)
    })
})

describe('model helpers', () => {
    it('parses live-check state and mission outcome from the daemon list', () => {
        const snap = parseNeedsYouList({ result: { success: true, ownerDecisions: [], liveChecks: [{ meshId: 'm1', itemId: 'mi_1', state: 'failed', machine: 'A' }, { meshId: 'm1', itemId: 'mi_2' }],
            missions: [{ meshId: 'm1', missionId: 'ms', outcome: 'not_needed', outcomeReason: 'scope: checked x', openItems: { remaining: 0, live_check: 0, decision: 0, evidence: 0 } }] } }, 'd1')
        expect(snap.liveChecks.map(c => c.state)).toEqual(['failed', undefined])
        expect(snap.missions[0]).toMatchObject({ outcome: 'not_needed', outcomeReason: 'scope: checked x' })
    })
    it('machine filter / deep link / counting are case-insensitive and live-check only', () => {
        expect(parseNeedsYouQuery('?todo=1&machine=build-box')).toEqual({ machine: 'build-box' })
        const entries = buildNeedsYouEntries({ decisions: [], liveChecks: [check(), check({ itemId: 'x', machine: 'Other' })] }, [])
        expect(filterNeedsYou(entries, { kind: 'all', meshId: 'all', machine: 'BUILD-BOX' })).toHaveLength(1)
        expect(countLiveChecksByMachine([{ machine: 'Build-Box' }, { machine: 'build-box ' }, {}]).get('build-box')).toBe(2)
    })
    it('scope statement: explicit `scope:` marker only', () => {
        expect(hasMissionScopeStatement('scope: checked X; not checked Y')).toBe(true)
        expect(hasMissionScopeStatement('Done. Scope: checked main only')).toBe(true)
        expect(hasMissionScopeStatement('not needed anymore')).toBe(false)
        expect(hasMissionScopeStatement('')).toBe(false)
        expect(hasMissionScopeStatement(undefined)).toBe(false)
        expect(missionScopeNotRecorded({ outcome: 'not_needed', outcomeReason: 'obsolete' })).toBe(true)
        expect(missionScopeNotRecorded({ outcome: 'not_needed', outcomeReason: 'scope: checked grep; not checked live' })).toBe(false)
        expect(missionScopeNotRecorded({})).toBe(false) // still open: no chip
    })
})

describe('scope chip on closed missions', () => {
    const structure = (over: Record<string, unknown>) => ({ daemonId: 'd1', meshId: 'm1', missionId: 'ms1', openItems: { remaining: 0, live_check: 0, decision: 0, evidence: 0 }, ...over })
    const render = (missions: any[]) => act(() => {
        root.render(<NeedsYouStateProvider value={makeState({ missions })}><MissionStructureLine meshTheme={getMeshGraphTheme(false) as any} mission={{ id: 'ms1', meshId: 'm1' }} /></NeedsYouStateProvider>)
    })
    it('shows the muted chip for a closed mission with no scope statement, never for open or scoped ones', () => {
        render([structure({ outcome: 'not_needed', outcomeReason: 'obsolete' })])
        expect(q('[data-testid="mission-scope-not-recorded"]')?.textContent).toBe('scope not recorded')
        render([structure({ outcome: 'not_needed', outcomeReason: 'scope: checked grep; not checked live' })])
        expect(q('[data-testid="mission-scope-not-recorded"]')).toBeNull()
        render([structure({ summary: 'in flight' })])
        expect(q('[data-testid="mission-scope-not-recorded"]')).toBeNull()
    })
})

describe('post-deploy live-check prompt', () => {
    const daemon = (version: string) => ({ id: 'dm1', type: 'adhdev-daemon', version, hostname: 'build-box' }) as any
    const mountPrompt = (ides: any[], state: NeedsYouState) => act(() => {
        root.render(<MemoryRouter initialEntries={['/dashboard']}><NeedsYouStateProvider value={state}><LiveCheckPrompt daemons={ides} /></NeedsYouStateProvider></MemoryRouter>)
    })
    it('first sighting is a baseline; a version change with waiting checks shows a dismissible prompt', () => {
        const state = makeState({ liveChecks: [check(), check({ itemId: 'mi_lc2' })] })
        mountPrompt([daemon('1.0.82-rc.36')], state)
        expect(q('[data-testid="live-check-prompt"]')).toBeNull()
        mountPrompt([daemon('1.0.82-rc.37')], state)
        expect(q('[data-testid="live-check-prompt"]')?.textContent).toContain('2 live checks waiting on build-box')
        click(q('[aria-label="Dismiss"]'))
        expect(q('[data-testid="live-check-prompt"]')).toBeNull()
    })
    it('no prompt when the changed machine has no live checks', () => {
        const state = makeState({ liveChecks: [check({ machine: 'office-pc' })] })
        mountPrompt([daemon('1.0.82-rc.36')], state)
        mountPrompt([daemon('1.0.82-rc.37')], state)
        expect(q('[data-testid="live-check-prompt"]')).toBeNull()
    })
})
