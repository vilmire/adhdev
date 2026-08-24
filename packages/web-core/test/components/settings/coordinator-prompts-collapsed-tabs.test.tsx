// @vitest-environment jsdom
//
// Structure guard for the CoordinatorPromptsSection UX restructure (2026-08-24):
// the section used to render every provider's override/append textareas stacked
// vertically, making the settings page extremely long. It is now:
//   1. collapsed by default — a single summary row with per-provider
//      "customized" badges and an expand button, zero textareas mounted-visible;
//   2. expanded — a provider tab bar (SettingsTabs) with exactly one provider's
//      editor pair visible at a time (inactive panels stay mounted but hidden,
//      so drafts survive tab switches);
//   3. save/draft state unchanged — this suite drives the same
//      list_coordinator_prompts RPC the component always used.
//
// INJECTION CHECK: reverting the component to the flat vertical list turns the
// "collapsed by default" and "one visible panel" assertions red.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// React requires this flag for act() outside a preconfigured test renderer.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/context/TransportContext', () => {
    // Must be referentially stable across renders: the component's load()
    // callback depends on sendCommand, so a per-render function identity would
    // re-fire the mount effect forever.
    const transport = {
        sendCommand: async (_daemonId: string, type: string) => {
            if (type === 'list_coordinator_prompts') {
                return {
                    success: true,
                    dir: '/home/user/.adhdev/coordinator-prompts',
                    entries: {
                        'claude-cli': { override: 'CUSTOM_OVERRIDE_TEXT', append: '' },
                    },
                }
            }
            return { success: true }
        },
    }
    return { useTransport: () => transport }
})

import CoordinatorPromptsSection from '../../../src/components/settings/CoordinatorPromptsSection'

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

const KNOWN = ['default', 'claude-cli', 'codex-cli']

async function renderSection() {
    await act(async () => {
        root.render(<CoordinatorPromptsSection daemonId="daemon_1" knownCliTypes={KNOWN} />)
    })
    // Flush the load() promise chain from the mount effect.
    await act(async () => { await Promise.resolve() })
}

/** SettingsTabs hides inactive panels with the `hidden` class. */
function visibleTextareas(): HTMLTextAreaElement[] {
    return Array.from(container.querySelectorAll('textarea'))
        .filter(t => t.closest('div.hidden') === null)
}

describe('CoordinatorPromptsSection — collapsed by default + provider tabs', () => {
    it('renders collapsed by default: no editors, expand button, customized badge', async () => {
        await renderSection()

        // No textareas visible in the collapsed state.
        expect(container.querySelectorAll('textarea').length).toBe(0)
        // Expand affordance present (en catalog booted by test/setup.ts).
        expect(container.textContent).toContain('Edit prompts')
        // The provider with saved content is badged in the summary row.
        expect(container.textContent).toContain('claude-cli')
        // Providers without saved content are NOT listed in the summary.
        expect(container.textContent).not.toContain('codex-cli')
    })

    it('expanding shows a tab per provider with exactly one editor pair visible', async () => {
        await renderSection()

        const expandBtn = Array.from(container.querySelectorAll('button'))
            .find(b => b.textContent?.includes('Edit prompts'))
        expect(expandBtn).toBeTruthy()
        await act(async () => { expandBtn!.click() })

        // One tab per known provider (saved-only extras would be appended too).
        const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
        expect(tabs.map(t => t.textContent)).toEqual(
            expect.arrayContaining(KNOWN),
        )
        expect(tabs.length).toBe(KNOWN.length)

        // Fixed vertical footprint: only the active provider's override+append
        // textareas are visible; the rest stay mounted but hidden.
        expect(container.querySelectorAll('textarea').length).toBe(KNOWN.length * 2)
        expect(visibleTextareas().length).toBe(2)

        // Customized dot on the claude-cli tab only.
        const claudeTab = tabs.find(t => t.textContent?.includes('claude-cli'))!
        expect(claudeTab.querySelector('[title="Customized"]')).toBeTruthy()
        const codexTab = tabs.find(t => t.textContent?.includes('codex-cli'))!
        expect(codexTab.querySelector('[title="Customized"]')).toBeNull()
    })

    it('switching tabs swaps the visible editor pair and collapse returns to summary', async () => {
        await renderSection()
        await act(async () => {
            Array.from(container.querySelectorAll('button'))
                .find(b => b.textContent?.includes('Edit prompts'))!
                .click()
        })

        // Activate the claude-cli tab and check its saved override is the
        // visible one.
        const claudeTab = Array.from(container.querySelectorAll('[role="tab"]'))
            .find(t => t.textContent?.includes('claude-cli')) as HTMLButtonElement
        await act(async () => { claudeTab.click() })

        const visible = visibleTextareas()
        expect(visible.length).toBe(2)
        expect(visible[0].value).toBe('CUSTOM_OVERRIDE_TEXT')

        // Collapse goes back to the summary row with no visible editors.
        const collapseBtn = Array.from(container.querySelectorAll('button'))
            .find(b => b.textContent?.includes('Collapse'))
        expect(collapseBtn).toBeTruthy()
        await act(async () => { collapseBtn!.click() })
        expect(container.querySelectorAll('textarea').length).toBe(0)
        expect(container.textContent).toContain('Edit prompts')
    })
})
