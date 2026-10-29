// @vitest-environment jsdom
/**
 * Mission deep link: the Overview scrolls to and highlights the focused mission's card, opening the
 * "completed / abandoned" fold when the mission lives there.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MeshOverviewCards from '../../src/components/MeshGraph/MeshOverviewCards'
import { MISSION_FOCUS_HIGHLIGHT_MS } from '../../src/components/MeshGraph/useMissionFocus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mission = (id: string, status: string) => ({ id, title: `Title ${id}`, status, goal: 'g', createdAt: 'x', updatedAt: 'x', tasks: { total: 0, completed: 0, lastActivityAt: null } })
const status: any = {
    meshId: 'm1', nodes: [], queue: { summary: null, tasks: [] }, ledger: { summary: {}, entries: [] },
    missions: [mission('ms_live', 'active'), mission('ms_done', 'completed')],
}

;(window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })

describe('mission deep link focus', () => {
    afterEach(() => { vi.useRealTimers() })

    it('opens the history fold, scrolls to the card and highlights it briefly', async () => {
        vi.useFakeTimers()
        const scroll = vi.fn()
        ;(Element.prototype as any).scrollIntoView = scroll
        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = createRoot(host)
        await act(async () => { root.render(<MeshOverviewCards status={status} focusMissionId="ms_done" />) })
        await act(async () => { await Promise.resolve() })
        const row = host.querySelector('[data-mission-row="ms_done"]') as HTMLElement
        expect(row).toBeTruthy()
        expect(row.dataset.missionHighlighted).toBe('true')
        expect(scroll).toHaveBeenCalledTimes(1)
        // unrelated mission is not highlighted
        expect((host.querySelector('[data-mission-row="ms_live"]') as HTMLElement).dataset.missionHighlighted).toBeUndefined()
        await act(async () => { vi.advanceTimersByTime(MISSION_FOCUS_HIGHLIGHT_MS + 50) })
        expect((host.querySelector('[data-mission-row="ms_done"]') as HTMLElement).dataset.missionHighlighted).toBeUndefined()
        act(() => root.unmount())
        host.remove()
    })

    it('leaves the history fold closed without a focus request', async () => {
        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = createRoot(host)
        await act(async () => { root.render(<MeshOverviewCards status={status} />) })
        expect(host.querySelector('[data-mission-row="ms_done"]')).toBeNull()
        expect(host.querySelector('[data-mission-row="ms_live"]')).toBeTruthy()
        act(() => root.unmount())
        host.remove()
    })
})
