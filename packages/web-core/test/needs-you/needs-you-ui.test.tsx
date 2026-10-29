// @vitest-environment jsdom
/**
 * "Needs you" page + cards (design 2026-10-28 §6.2, §6.4): sort/filter rendering, card
 * answer and the Undo / "may already be in progress" controls, answer-all preview + result,
 * deep-link preselect with one confirm tap, delivery state, the nav-less provider wire call
 * (`via: 'dashboard'`) and the Overview mission line.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NeedsYou from '../../src/pages/NeedsYou'
import { NeedsYouStateProvider, type NeedsYouState } from '../../src/context/NeedsYouContext'
import {
    EMPTY_NEEDS_YOU_SNAPSHOT,
    buildNeedsYouEntries,
    needsYouCount,
    type NeedsYouAnswered,
    type NeedsYouDecision,
    type NeedsYouSnapshot,
} from '../../src/components/needs-you/needs-you-model'
import MissionStructureLine, { useMissionTitle } from '../../src/components/MeshGraph/MissionStructureLine'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dec = (over: Partial<NeedsYouDecision> = {}): NeedsYouDecision => ({
    daemonId: 'd1', meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship budget', itemId: 'mi_1', question: 'Budget default?',
    options: [{ id: 'a', label: 'Temp value' }, { id: 'b', label: 'Final value' }], recommended: 'a', allowFreeText: true,
    urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: '2026-10-29T00:00:00.000Z', ...over,
})

function makeState(snap: Partial<NeedsYouSnapshot>, answer = vi.fn(async () => ({ ok: true as const }))): NeedsYouState & { answer: ReturnType<typeof vi.fn> } {
    const snapshot: NeedsYouSnapshot = { ...EMPTY_NEEDS_YOU_SNAPSHOT, ...snap }
    const entries = buildNeedsYouEntries(snapshot, [])
    return {
        snapshot, approvals: [], entries, count: needsYouCount(entries), loaded: true, outcomes: {}, busyIds: new Set(),
        refresh: async () => {}, answer,
    }
}

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

function mount(state: NeedsYouState, url = '/needs-you', extra: ReactNode = null) {
    act(() => {
        root.render(
            <MemoryRouter initialEntries={[url]}>
                <NeedsYouStateProvider value={state}><NeedsYou />{extra}</NeedsYouStateProvider>
            </MemoryRouter>,
        )
    })
}
const click = (el: Element | null) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
const buttonByText = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text)) ?? null

describe('NeedsYou page', () => {
    it('renders most urgent first and filters by kind / project', () => {
        const state = makeState({
            decisions: [dec({ itemId: 'late', question: 'Later one?' }), dec({ itemId: 'urgent', question: 'Urgent one?', urgency: 'blocking', meshId: 'm2' })],
            liveChecks: [{ daemonId: 'd1', meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship budget', itemId: 'lc1', text: 'verify on win32', createdAt: 'x' }],
            meshNames: { m1: 'alpha', m2: 'beta' },
        })
        mount(state)
        const order = [...host.querySelectorAll('[data-testid="needs-you-decision-card"], [data-testid="needs-you-live-check"]')].map(e => e.textContent ?? '')
        expect(order[0]).toContain('Urgent one?')
        expect(order[1]).toContain('Later one?')
        expect(order[2]).toContain('verify on win32')
        click(buttonByText('Live checks'))
        expect(host.querySelectorAll('[data-testid="needs-you-decision-card"]')).toHaveLength(0)
        expect(host.querySelectorAll('[data-testid="needs-you-live-check"]')).toHaveLength(1)
        click(buttonByText('All'))
        const select = host.querySelector('select') as HTMLSelectElement
        act(() => { select.value = 'm2'; select.dispatchEvent(new Event('change', { bubbles: true })) })
        expect(host.querySelectorAll('[data-testid="needs-you-decision-card"]')).toHaveLength(1)
    })

    it('card: option click answers; free text answers; recommended is labelled', () => {
        const state = makeState({ decisions: [dec()] })
        mount(state)
        expect(host.textContent).toContain('Recommended')
        click(buttonByText('Final value'))
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ daemonId: 'd1', meshId: 'm1', itemId: 'mi_1', optionId: 'b' }))
        const input = host.querySelector('input.input') as HTMLInputElement
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
            setter.call(input, 'something else')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        click(buttonByText('Send'))
        expect(state.answer).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: 'mi_1', text: 'something else' }))
    })

    it('answered card: shows answer + delivery state, Undo sends undo, >10 min shows "may already be in progress"', () => {
        const old: NeedsYouAnswered = {
            daemonId: 'd1', meshId: 'm1', missionId: 'ms1', itemId: 'mi_9', question: 'Old question?',
            answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: new Date(Date.now() - 30 * 60_000).toISOString() },
            revision: 1, deliveryState: 'queued', autoApplied: false, options: [{ id: 'a', label: 'Temp value' }, { id: 'b', label: 'Final value' }], allowFreeText: false,
        }
        const fresh: NeedsYouAnswered = { ...old, itemId: 'mi_10', question: 'Fresh?', deliveryState: 'sent', answer: { ...old.answer, at: new Date().toISOString() } }
        const state = makeState({ answered: [old, fresh] })
        mount(state)
        const cards = [...host.querySelectorAll('[data-testid="needs-you-answered-card"]')]
        expect(cards).toHaveLength(2)
        expect(cards[0].textContent).toContain('Answered: Temp value')
        expect(cards[0].querySelector('[data-testid="needs-you-delivery"]')?.textContent).toBe('Queued for the coordinator')
        expect(cards[0].querySelector('[data-testid="needs-you-in-progress"]')).toBeTruthy()
        expect(cards[1].querySelector('[data-testid="needs-you-in-progress"]')).toBeNull()
        click([...cards[0].querySelectorAll('button')].find(b => b.textContent === 'Undo') ?? null)
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'mi_9', undo: true }))
        click([...cards[0].querySelectorAll('button')].find(b => b.textContent === 'Change') ?? null)
        click([...cards[0].querySelectorAll('button')].find(b => b.textContent === 'Final value') ?? null)
        expect(state.answer).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: 'mi_9', optionId: 'b' }))
    })

    it('answer all with recommended: preview first (one line per decision), then applies and lists results', async () => {
        const state = makeState({ decisions: [dec({ itemId: 'x1', question: 'First?' }), dec({ itemId: 'x2', question: 'Second?', recommended: 'b' }), dec({ itemId: 'x3', question: 'No rec?', recommended: undefined })] })
        mount(state)
        click(buttonByText('Answer all with recommended (2)'))
        const preview = host.querySelector('[data-testid="needs-you-answer-all-preview"]')!
        expect(preview.querySelectorAll('li')).toHaveLength(2)
        expect(preview.textContent).toContain('First?')
        expect(preview.textContent).toContain('Final value')
        expect(state.answer).not.toHaveBeenCalled()
        await act(async () => { click(buttonByText('Apply')) })
        await act(async () => { await Promise.resolve() })
        expect(state.answer).toHaveBeenCalledTimes(2)
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'x1', optionId: 'a' }))
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'x2', optionId: 'b' }))
        const result = host.querySelector('[data-testid="needs-you-answer-all-result"]')!
        expect(result.textContent).toContain('Answered 2 of 2')
    })

    it('deep link preselects the option; one Confirm tap answers it', () => {
        const state = makeState({ decisions: [dec({ itemId: 'target' }), dec({ itemId: 'other', question: 'Other?' })] })
        mount(state, '/needs-you?mesh=m1&decision=target&choose=b')
        const card = host.querySelector('[data-decision-id="target"]')!
        expect(card.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Final value')
        expect(state.answer).not.toHaveBeenCalled()
        click([...card.querySelectorAll('button')].find(b => b.textContent?.startsWith('Confirm')) ?? null)
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'target', optionId: 'b' }))
    })

    it('"later" hides a card for this view only', () => {
        const state = makeState({ decisions: [dec()] })
        mount(state)
        click(buttonByText('Later'))
        expect(host.querySelectorAll('[data-testid="needs-you-decision-card"]')).toHaveLength(0)
        click(buttonByText('set aside'))
        expect(host.querySelectorAll('[data-testid="needs-you-decision-card"]')).toHaveLength(1)
    })

    it('swipe right answers with the recommended option (undo toast); swipe left sets it aside', () => {
        const state = makeState({ decisions: [dec()] })
        mount(state)
        const card = host.querySelector('[data-testid="needs-you-decision-card"]')!
        const firePointer = (type: string, x: number) => act(() => {
            const e = new Event(type, { bubbles: true }) as any
            Object.assign(e, { pointerType: 'touch', clientX: x, clientY: 0 })
            card.dispatchEvent(e)
        })
        firePointer('pointerdown', 10); firePointer('pointermove', 120); firePointer('pointerup', 120)
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'mi_1', optionId: 'a' }))
        firePointer('pointerdown', 200); firePointer('pointermove', 60); firePointer('pointerup', 60)
        expect(host.querySelectorAll('[data-testid="needs-you-decision-card"]')).toHaveLength(0)
    })

    it('close confirmation shows Correct / Reopen as options (no free text)', () => {
        const state = makeState({ decisions: [dec({
            itemId: 'conf', question: "The coordinator closed this as 'owner abandoned' — correct?", source: 'daemon',
            options: [{ id: 'a', label: 'Correct' }, { id: 'b', label: 'Reopen' }], recommended: undefined, carryOver: true, missionTitle: 'Carry-over — open items from closed missions',
        })] })
        mount(state)
        const card = host.querySelector('[data-decision-id="conf"]')!
        expect(card.querySelector('input.input')).toBeNull()
        click([...card.querySelectorAll('button')].find(b => b.textContent === 'Reopen') ?? null)
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'conf', optionId: 'b' }))
        // carry-over mission title is shown through the locale string
        expect(card.textContent).toContain('Carry-over — open items from closed missions')
    })
})

function LocationProbe() {
    const l = useLocation()
    return <span data-testid="loc">{l.pathname}{l.search}</span>
}

describe('NeedsYou — QA fixes', () => {
    const MID = '09094c4a-1111-2222-3333-444455556666'
    it('close confirmation renders localized, without the mission id; the answered row too', () => {
        const options = [{ id: 'a', label: 'Correct' }, { id: 'b', label: 'Reopen' }]
        const state = makeState({
            decisions: [dec({
                itemId: 'conf', question: "The coordinator closed this as 'owner abandoned' — correct?", source: 'daemon', options, recommended: undefined,
                context: `Mission "Ship budget" (${MID}) — reason: dropped`,
            })],
            answered: [{
                daemonId: 'd1', meshId: 'm1', missionId: 'ms1', itemId: 'conf2', question: "The coordinator closed this as 'owner abandoned' — correct?", options,
                answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: new Date().toISOString() }, revision: 1, autoApplied: false, allowFreeText: false,
            }],
        })
        mount(state)
        const card = host.querySelector('[data-decision-id="conf"]')!
        expect(card.textContent).toContain('Closed as "owner abandoned" — correct?')
        expect(card.textContent).toContain('Mission "Ship budget" — reason: dropped')
        expect(card.textContent).not.toContain(MID)
        expect(card.textContent).not.toContain("The coordinator closed this")
        const answered = host.querySelector('[data-testid="needs-you-answered-card"]')!
        expect(answered.textContent).toContain('Closed as "owner abandoned" — correct?')
        expect(answered.textContent).toContain('Answered: Correct')
    })

    it('a tapped answer shows an in-place toast with Undo that sends undo', async () => {
        const state = makeState({ decisions: [dec()] })
        mount(state)
        await act(async () => { click(buttonByText('Final value')) })
        await act(async () => { await Promise.resolve() })
        const toast = host.querySelector('[data-testid="needs-you-toast"]')!
        expect(toast.textContent).toContain('Recorded: Final value')
        click([...toast.querySelectorAll('button')].find(b => b.textContent === 'Undo') ?? null)
        expect(state.answer).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: 'mi_1', undo: true }))
    })

    it('answering the deep-linked card clears decision/choose from the URL and keeps mesh', async () => {
        const state = makeState({ decisions: [dec({ itemId: 'target' }), dec({ itemId: 'other', question: 'Other?' })] })
        mount(state, '/needs-you?mesh=m1&decision=target&choose=b', <LocationProbe />)
        expect(host.querySelector('[data-testid="loc"]')?.textContent).toBe('/needs-you?mesh=m1&decision=target&choose=b')
        const card = host.querySelector('[data-decision-id="target"]')!
        await act(async () => { click([...card.querySelectorAll('button')].find(b => b.textContent?.startsWith('Confirm')) ?? null) })
        await act(async () => { await Promise.resolve() })
        expect(host.querySelector('[data-testid="loc"]')?.textContent).toBe('/needs-you?mesh=m1')
    })

    it('the header count covers every shown item, live checks included', () => {
        const state = makeState({
            decisions: [dec()],
            liveChecks: [{ daemonId: 'd1', meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship budget', itemId: 'lc1', text: 'verify on win32', createdAt: 'x' }],
        })
        mount(state)
        const header = host.querySelector('h1')?.parentElement?.textContent ?? ''
        expect(header).toMatch(/Waiting/)
        expect(header).toMatch(/\b2\b/)
        expect(header).not.toMatch(/\b1\b/)
        expect(host.querySelectorAll('[data-testid="needs-you-decision-card"], [data-testid="needs-you-live-check"]')).toHaveLength(2)
    })
})

describe('Overview mission line', () => {
    function Probe({ mission }: { mission: { id: string; meshId: string; title: string } }) {
        const title = useMissionTitle(mission)
        return <div><span data-testid="title">{title}</span><MissionStructureLine meshTheme={getMeshGraphTheme('dark' as any)} mission={mission} /></div>
    }
    it('shows summary, open counts and a decision badge linking to /needs-you?mesh=…; carry-over title comes from the flag', () => {
        const state = makeState({
            decisions: [dec({ missionId: 'ms1' })],
            missions: [{ daemonId: 'd1', meshId: 'm1', missionId: 'ms1', summary: 'Budget work', openItems: { remaining: 3, live_check: 1, decision: 1, evidence: 0 }, carryOver: true }],
        })
        act(() => {
            root.render(
                <MemoryRouter><NeedsYouStateProvider value={state}>
                    <Probe mission={{ id: 'ms1', meshId: 'm1', title: 'Some stored english title' }} />
                </NeedsYouStateProvider></MemoryRouter>,
            )
        })
        expect(host.querySelector('[data-testid="title"]')?.textContent).toBe('Carry-over — open items from closed missions')
        const line = host.querySelector('[data-testid="mission-structure-line"]')!
        expect(line.textContent).toContain('Budget work')
        expect(line.textContent).toContain('4 open items')
        expect(line.querySelector('[data-testid="mission-decision-badge"]')?.textContent).toBe('1 decisions waiting')
    })
})
