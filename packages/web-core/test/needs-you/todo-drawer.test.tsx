// @vitest-environment jsdom
/**
 * "To do" drawer (owner decisions 2026-10-29): the surface is a header button with a count badge
 * that opens a right-side drawer (bottom sheet on narrow screens) on any route, driven by the URL.
 * Covers the button + badge, open/close (button, Esc, outside click, drag handle), deep links
 * (`?todo=1&decision=…` and the legacy `/needs-you` redirect), the merged held-approval inbox and
 * the mobile sheet variant.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NeedsYouRedirect from '../../src/pages/NeedsYou'
import TodoButton from '../../src/components/needs-you/TodoButton'
import { TodoDrawerHost } from '../../src/components/needs-you/TodoDrawer'
import { NeedsYouStateProvider, type NeedsYouState } from '../../src/context/NeedsYouContext'
import {
    EMPTY_NEEDS_YOU_SNAPSHOT,
    buildNeedsYouEntries,
    needsYouCount,
    type NeedsYouDecision,
} from '../../src/components/needs-you/needs-you-model'
import type { AssistantStagedItem } from '../../src/components/dashboard/assistant-staged'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dec = (over: Partial<NeedsYouDecision> = {}): NeedsYouDecision => ({
    daemonId: 'd1', meshId: 'm1', missionId: 'ms1', missionTitle: 'Ship budget', itemId: 'mi_1', question: 'Budget default?',
    options: [{ id: 'a', label: 'Temp value' }, { id: 'b', label: 'Final value' }], recommended: 'a', allowFreeText: true,
    urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: '2026-10-29T00:00:00.000Z', ...over,
})
const staged: AssistantStagedItem = {
    id: 'driver-activation-1', kind: 'memory', action: 'add', target: '', origin: 'driver', createdAt: '2026-10-29T00:00:00.000Z', text: 'remember the milk',
}

function makeState(decisions: NeedsYouDecision[], stagedItems: AssistantStagedItem[] = []): NeedsYouState & { answer: ReturnType<typeof vi.fn> } {
    const snapshot = { ...EMPTY_NEEDS_YOU_SNAPSHOT, decisions }
    const entries = buildNeedsYouEntries(snapshot, [], stagedItems)
    return {
        snapshot, approvals: [], entries, count: needsYouCount(entries), loaded: true, outcomes: {}, busyIds: new Set(),
        staged: { items: stagedItems, memoryStatus: null, outcomes: {}, busyIds: new Set(), refresh: async () => {}, resolve: async () => {} },
        refresh: async () => {}, answer: vi.fn(async () => ({ ok: true as const })),
    }
}

function Probe() { const l = useLocation(); return <span data-testid="loc">{l.pathname}{l.search}</span> }

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

function mount(state: NeedsYouState, url: string, withHeaderButton = true) {
    act(() => {
        root.render(
            <MemoryRouter initialEntries={[url]}>
                <NeedsYouStateProvider value={state}>
                    {withHeaderButton && <TodoButton />}
                    <Routes>
                        <Route path="/needs-you" element={<NeedsYouRedirect />} />
                        <Route path="*" element={<Probe />} />
                    </Routes>
                    <TodoDrawerHost />
                </NeedsYouStateProvider>
            </MemoryRouter>,
        )
    })
}
const q = (sel: string) => document.body.querySelector(sel)
const click = (el: Element | null) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
const loc = () => q('[data-testid="loc"]')?.textContent

describe('To do button + drawer', () => {
    it('shows the count badge (decisions + approvals, live checks excluded) and opens/closes the drawer', () => {
        mount(makeState([dec(), dec({ itemId: 'mi_2', question: 'Second?' })]), '/mesh')
        expect(q('[data-testid="todo-button-badge"]')?.textContent).toBe('2')
        expect(q('[data-testid="todo-drawer"]')).toBeNull()
        click(q('[data-testid="todo-button"]'))
        expect(loc()).toBe('/mesh?todo=1')
        const dialog = q('[data-testid="todo-drawer"]')!
        expect(dialog.getAttribute('role')).toBe('dialog')
        expect(dialog.getAttribute('aria-modal')).toBe('true')
        const labelledBy = dialog.getAttribute('aria-labelledby')!
        expect(document.getElementById(labelledBy)?.textContent).toContain('To do')
        expect(q('[data-testid="todo-drawer-count"]')?.textContent).toBe('2')
        expect(document.body.querySelectorAll('[data-testid="needs-you-decision-card"]')).toHaveLength(2)
        click(q('[data-testid="todo-drawer-close"]'))
        expect(q('[data-testid="todo-drawer"]')).toBeNull()
        expect(loc()).toBe('/mesh')
    })

    it('Esc and an outside click close it', () => {
        mount(makeState([dec()]), '/dashboard?todo=1')
        expect(q('[data-testid="todo-drawer"]')).toBeTruthy()
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
        expect(q('[data-testid="todo-drawer"]')).toBeNull()
        click(q('[data-testid="todo-button"]'))
        expect(q('[data-testid="todo-drawer"]')).toBeTruthy()
        click(q('[data-testid="todo-drawer-backdrop"]'))
        expect(q('[data-testid="todo-drawer"]')).toBeNull()
    })

    it('moves focus into the dialog and keeps Tab inside it', () => {
        mount(makeState([dec()]), '/dashboard?todo=1')
        expect(document.activeElement).toBe(q('[data-testid="todo-drawer-close"]'))
        const dialog = q('[data-testid="todo-drawer"]') as HTMLElement
        const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select')]
        focusable[focusable.length - 1]!.focus()
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
        expect(document.activeElement).toBe(focusable[0])
    })

    it('a floating opener appears only where no header button is mounted', () => {
        mount(makeState([dec()]), '/mesh', false)
        expect(q('[data-testid="todo-floating-button"]')).toBeTruthy()
        click(q('[data-testid="todo-button"]'))
        expect(q('[data-testid="todo-drawer"]')).toBeTruthy()
        expect(q('[data-testid="todo-floating-button"]')).toBeNull()
    })

    it('the deep link ?todo=1&mesh&decision&choose opens the drawer on that card with the option preselected', () => {
        const state = makeState([dec({ itemId: 'target' }), dec({ itemId: 'other', question: 'Other?' })])
        mount(state, '/dashboard?todo=1&mesh=m1&decision=target&choose=b')
        const card = q('[data-decision-id="target"]')!
        expect(card.getAttribute('class')).toContain('ring-accent-primary')
        expect(card.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Final value')
        click([...card.querySelectorAll('button')].find(b => b.textContent?.startsWith('Confirm')) ?? null)
        expect(state.answer).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'target', optionId: 'b' }))
    })

    it('a decision param alone opens the drawer (chat auto-link / push shape)', () => {
        mount(makeState([dec({ itemId: 'target' })]), '/dashboard?mesh=m1&decision=target')
        expect(q('[data-testid="todo-drawer"]')).toBeTruthy()
    })

    it('/needs-you redirects to the dashboard with the drawer open and the query kept', () => {
        mount(makeState([dec({ itemId: 'target' })]), '/needs-you?mesh=m1&decision=target&choose=a')
        expect(loc()).toBe('/dashboard?mesh=m1&decision=target&choose=a&todo=1')
        expect(q('[data-decision-id="target"] button[aria-pressed="true"]')?.textContent).toContain('Temp value')
    })

    it('/needs-you?mesh= (no decision) redirects to the drawer filtered to that project', () => {
        mount(makeState([dec()]), '/needs-you?mesh=m1')
        expect(loc()).toBe('/dashboard?mesh=m1&todo=1')
        expect(q('[data-testid="todo-drawer"]')).toBeTruthy()
    })

    it('holds the approvals the old header inbox showed (driver activations / held writes), with the ones counted', () => {
        mount(makeState([], [staged]), '/dashboard?todo=1')
        expect(q('[data-testid="todo-button-badge"]')?.textContent).toBe('1')
        const section = q('[data-testid="needs-you-staged"]')!
        expect(section.querySelector('[data-staged-item="driver-activation-1"]')?.textContent).toContain('remember the milk')
        expect(section.querySelector('[data-staged-action="apply"]')).toBeTruthy()
    })

    it('a driver activation held for approval shows in the drawer with no assistant session open (was the header inbox badge)', () => {
        const driver: AssistantStagedItem = {
            id: 'driver-activation-9', kind: 'driver_activation', action: 'activate', target: 'browser-playwright', detail: 'Browser (Playwright MCP)',
            origin: 'driver', createdAt: '2026-10-18T12:00:00.000Z',
            driverActivation: {
                name: 'Browser (Playwright MCP)', publisher: 'ADHDev', providerVersion: '1.0.0', treeDigest: 'sha256:' + 'b'.repeat(64), trust: 'user-custom',
                runtime: { kind: 'mcp-stdio', command: 'node', args: ['./bin/browser-server.js'] }, riskClass: 'low', reasons: [],
                declaredAccess: { network: ['*'], filesystem: ['workspace'], desktopControl: false },
            },
        }
        mount(makeState([], [driver]), '/dashboard?todo=1')
        const row = q('[data-staged-item="driver-activation-9"]')!
        expect(row.textContent).toContain('Browser (Playwright MCP)')
        expect(row.textContent).toContain('ADHDev')
        expect(row.querySelector('[data-staged-action="apply"]')).toBeTruthy()
    })
})

describe('To do drawer — layout variants', () => {
    function stubMedia(narrow: boolean) {
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: narrow && query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
        }))
    }
    it('desktop: a right-side drawer without a drag handle', () => {
        stubMedia(false)
        mount(makeState([dec()]), '/dashboard?todo=1')
        expect(q('[data-testid="todo-drawer-root"]')?.getAttribute('data-variant')).toBe('side')
        expect(q('[data-testid="todo-drawer-handle"]')).toBeNull()
        expect(q('[data-testid="todo-drawer"]')?.className).toContain('right-0')
    })
    it('narrow: a full-height bottom sheet with a drag handle, safe-area insets and a 44px close', () => {
        stubMedia(true)
        mount(makeState([dec()]), '/dashboard?todo=1')
        expect(q('[data-testid="todo-drawer-root"]')?.getAttribute('data-variant')).toBe('sheet')
        const sheet = q('[data-testid="todo-drawer"]') as HTMLElement
        expect(sheet.className).toContain('rounded-t-2xl')
        expect(sheet.style.height).toBe('100dvh')
        expect(sheet.className).toContain('pb-[env(safe-area-inset-bottom')
        expect(q('[data-testid="todo-drawer-handle"]')).toBeTruthy()
        expect(q('[data-testid="todo-drawer-close"]')?.className).toContain('min-h-[44px]')
        // option buttons wrap and are thumb-sized
        const option = [...sheet.querySelectorAll('button')].find(b => b.textContent?.includes('Final value'))!
        expect(option.className).toContain('min-h-[44px]')
        expect(option.className).toContain('whitespace-normal')
    })
    it('narrow: dragging the handle down past the threshold closes the sheet', () => {
        stubMedia(true)
        mount(makeState([dec()]), '/dashboard?todo=1')
        const handle = q('[data-testid="todo-drawer-handle"]')!
        const ev = (type: string, y: number) => { const e = new Event(type, { bubbles: true }) as Event & { clientY: number; pointerId: number }; e.clientY = y; e.pointerId = 1; return e }
        act(() => { handle.dispatchEvent(ev('pointerdown', 100)) })
        act(() => { handle.dispatchEvent(ev('pointermove', 160)) })
        expect(q('[data-testid="todo-drawer"]')).toBeTruthy()
        act(() => { handle.dispatchEvent(ev('pointerup', 260)) })
        expect(q('[data-testid="todo-drawer"]')).toBeNull()
    })
})
