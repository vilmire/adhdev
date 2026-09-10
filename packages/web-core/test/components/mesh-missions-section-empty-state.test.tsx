// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MeshMissionsSection } from '../../src/pages/repo-mesh/MeshMissionsSection'
import type { RepoMeshStatus } from '@adhdev/daemon-core'

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

/**
 * ★ G5-7 THE VANISHED-EMPTY-STATE REGRESSION.
 *
 * `if (missions.length === 0) return null` unmounted the entire Section —
 * title, description, filter chips, and the dedicated
 * `mesh.missions.empty` message — whenever a mesh had zero missions.
 * That i18n key existed and was reachable via the filtered-to-zero branch,
 * but never via the zero-total-missions branch, because the early return
 * intercepted first. A mesh with no missions yet looked like the Missions
 * feature didn't exist at all, instead of showing it does and is just empty.
 */
describe('MeshMissionsSection — G5-7 renders its Section shell + empty message with zero missions', () => {
    function render(status: RepoMeshStatus | null) {
        act(() => {
            root.render(
                <MeshMissionsSection
                    status={status}
                    daemonId="daemon_1"
                    meshId="mesh_1"
                    sendCommand={vi.fn(async () => ({ success: true }))}
                />,
            )
        })
    }

    it('renders the Section (not null) when the mesh has zero missions', () => {
        render({ missions: [] } as any)
        expect(container.textContent).not.toBe('')
        expect(container.querySelector('[class*="border"]')).not.toBeNull()
    })

    it('shows the dedicated empty-missions message, not a blank component', () => {
        render({ missions: [] } as any)
        expect(container.textContent).toContain('No active missions')
    })

    it('still renders normally when missions are present', () => {
        render({
            missions: [{ id: 'm1', title: 'Ship the thing', status: 'active', goalPreview: 'do it', tasks: { total: 2 } }],
        } as any)
        expect(container.textContent).toContain('Ship the thing')
    })
})
