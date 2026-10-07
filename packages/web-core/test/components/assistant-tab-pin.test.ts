// @vitest-environment jsdom
//
// The assistant tab is pinned first in the dashboard dock and pane tabs — also
// when its assistant flag arrives after the tab. In the cloud the session first
// lands from the server-WS routing meta (no `assistant` / `settings`), so the
// dock adds its panel at the end of the group; the P2P daemon.metadata lane
// brings the flag a moment later. Once pinned, the person's drag order stands.
import { describe, expect, it } from 'vitest'
import { createDockview, type DockviewApi } from 'dockview-core'
import { pinAssistantPanels, syncDockviewPanels } from '../../src/components/dashboard/dockviewWorkspaceLayout'
import { createAssistantTabPinState, takeAssistantTabsToPin } from '../../src/components/dashboard/assistant-session'
import { mergeTabOrder } from '../../src/hooks/usePaneGroupTabs'
import type { ActiveConversation } from '../../src/components/dashboard/types'

const conv = (tabKey: string, extra: Partial<ActiveConversation> = {}) =>
    ({ tabKey, title: tabKey, agentName: tabKey, displayPrimary: tabKey, ...extra }) as ActiveConversation
const flagged = (tabKey: string) => conv(tabKey, { settings: { assistant: true } })

function dock(): DockviewApi {
    const g = globalThis as { ResizeObserver?: unknown }
    if (typeof g.ResizeObserver === 'undefined') {
        g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    }
    const element = document.createElement('div')
    document.body.appendChild(element)
    return createDockview(element, {
        createComponent: () => {
            const el = document.createElement('div')
            return { element: el, init: () => {} }
        },
    })
}

const tabOrder = (api: DockviewApi) => api.groups[0].panels.map(panel => panel.id)

describe('assistant tab pin (dock)', () => {
    it('moves a late-flagged assistant panel to the first tab once, then leaves a drag alone', () => {
        const api = dock()
        const pins = createAssistantTabPinState()
        syncDockviewPanels(api, [conv('coord-1'), conv('coord-2')], null, pins)
        api.getPanel('coord-2')!.api.setActive()
        // The assistant session arrives without its flag (routing meta only): appended at the end.
        syncDockviewPanels(api, [conv('coord-1'), conv('coord-2'), conv('asst')], null, pins)
        expect(tabOrder(api)).toEqual(['coord-1', 'coord-2', 'asst'])
        // The flag arrives: pinned first, the active tab unchanged.
        syncDockviewPanels(api, [conv('coord-1'), conv('coord-2'), flagged('asst')], null, pins)
        expect(tabOrder(api)).toEqual(['asst', 'coord-1', 'coord-2'])
        expect(api.activePanel?.id).toBe('coord-2')
        // The person drags it elsewhere: later syncs keep that order.
        api.getPanel('asst')!.api.moveTo({ group: api.groups[0], position: 'center', index: 2, skipSetActive: true })
        syncDockviewPanels(api, [conv('coord-1'), conv('coord-2'), flagged('asst')], null, pins)
        syncDockviewPanels(api, [conv('coord-1'), conv('coord-2'), flagged('asst'), conv('coord-3')], null, pins)
        expect(tabOrder(api)).toEqual(['coord-1', 'coord-2', 'asst', 'coord-3'])
    })

    it('keeps an active assistant panel active when pinning it', () => {
        const api = dock()
        const pins = createAssistantTabPinState()
        syncDockviewPanels(api, [conv('coord-1'), conv('asst')], null, pins)
        api.getPanel('asst')!.api.setActive()
        syncDockviewPanels(api, [conv('coord-1'), flagged('asst')], null, pins)
        expect(tabOrder(api)).toEqual(['asst', 'coord-1'])
        expect(api.activePanel?.id).toBe('asst')
    })

    it('leaves a panel restored from a stored layout where the person put it', () => {
        const api = dock()
        const pins = createAssistantTabPinState()
        // Panels already in the dock (stored layout) were not opened by this surface.
        api.addPanel({ id: 'coord-1', component: 'conversation', title: 'coord-1' })
        api.addPanel({ id: 'asst', component: 'conversation', title: 'asst', position: { referencePanel: 'coord-1', direction: 'within' } })
        syncDockviewPanels(api, [conv('coord-1'), flagged('asst')], null, pins)
        expect(tabOrder(api)).toEqual(['coord-1', 'asst'])
        pinAssistantPanels(api, [conv('coord-1'), flagged('asst')], pins)
        expect(tabOrder(api)).toEqual(['coord-1', 'asst'])
    })
})

describe('assistant tab pin (pane tabs)', () => {
    it('pins a newly appearing assistant first, also when the flag comes late, and only once', () => {
        const pins = createAssistantTabPinState()
        let order = mergeTabOrder([], [conv('a'), conv('b')], pins)
        expect(order).toEqual(['a', 'b'])
        order = mergeTabOrder(order, [conv('a'), conv('b'), conv('asst')], pins)
        expect(order).toEqual(['a', 'b', 'asst'])
        order = mergeTabOrder(order, [conv('a'), conv('b'), flagged('asst')], pins)
        expect(order).toEqual(['asst', 'a', 'b'])
        // A drag after the pin stands.
        order = ['a', 'asst', 'b']
        expect(mergeTabOrder(order, [conv('a'), flagged('asst'), conv('b')], pins)).toEqual(['a', 'asst', 'b'])
    })

    it('keeps a stored order that already holds the assistant', () => {
        const pins = createAssistantTabPinState()
        expect(mergeTabOrder(['a', 'asst'], [conv('a'), flagged('asst'), conv('c')], pins)).toEqual(['a', 'asst', 'c'])
        expect(takeAssistantTabsToPin([flagged('asst')], pins)).toEqual([])
    })
})
