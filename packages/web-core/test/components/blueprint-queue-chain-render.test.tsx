// @vitest-environment jsdom
/**
 * ★ W24 — queue `depends_on` chains, as the owner sees them. Renders
 * MeshBlueprintList the way MeshBlueprintView wires it (real i18n via the
 * shared setup, real theme, jsdom + act) with NO persistent graphs — exactly
 * the `mesh_enqueue_task` + `depends_on` default path, which creates no
 * mesh_task_graphs rows.
 *
 *  - R1 a waiting task's row says "waiting on: <short id · title>"
 *  - R2 more than two deps collapse to "+N more"
 *  - R3 clicking a named dep opens THAT task, not the row's own task
 *  - R4 "By mission" shows a chain header instead of "No mission"; the
 *       header opens the chain's anchor task
 *  - R5 a task with no unmet deps renders no waiting-on line
 */
import { act } from 'react'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/MeshGraph/MeshMiniDag', () => ({
    default: () => null,
}))

import MeshBlueprintList from '../../src/components/MeshGraph/MeshBlueprintList'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

const meshTheme = getMeshGraphTheme('dark')

const A = 'aaaaaaaa-1111-4000-8000-000000000001'
const B = 'bbbbbbbb-2222-4000-8000-000000000002'
const C = 'cccccccc-3333-4000-8000-000000000003'
const D = 'dddddddd-4444-4000-8000-000000000004'
const E = 'eeeeeeee-5555-4000-8000-000000000005'

const task = (over: Record<string, unknown> & { id: string }) => ({
    meshId: 'mesh-1',
    message: `message for ${over.id}`,
    status: 'pending',
    createdAt: '2026-09-25T10:00:00Z',
    updatedAt: '2026-09-25T10:00:00Z',
    ...over,
}) as any

function mountList(props: Partial<React.ComponentProps<typeof MeshBlueprintList>>): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
        root.render(
            <MeshBlueprintList
                tasks={[]}
                status={{ meshId: 'mesh-1', meshName: 'Mesh', repoIdentity: 'repo', refreshedAt: '2026-09-25T10:00:00Z', nodes: [] } as any}
                graphs={[]}
                meshTheme={meshTheme}
                onTaskOpen={() => { }}
                onGateOpen={() => { }}
                {...props}
            />,
        )
    })
    return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

const chainTasks = () => [
    task({ id: A, status: 'assigned', message: '## Build the parser\n\nbody' }),
    task({ id: B, status: 'pending', dependsOn: [A], message: 'Wire the parser into the CLI' }),
]

describe('Blueprint — queue depends_on chain (no graph rows)', () => {
    it('R1: a waiting task names its dependency by short id and title; tooltip carries the full id', () => {
        const { container, unmount } = mountList({ tasks: chainTasks() })
        const lines = container.querySelectorAll('[data-testid="blueprint-waiting-on"]')
        expect(lines.length).toBe(1)
        const line = lines[0] as HTMLElement
        expect(line.textContent).toContain('waiting on:')
        expect(line.textContent).toContain('aaaaaaaa · Build the parser')
        expect(line.getAttribute('title')).toContain(A)
        unmount()
    })

    it('R2: more than two unmet deps collapse to "+N more"', () => {
        const { container, unmount } = mountList({
            tasks: [
                task({ id: A, status: 'assigned' }),
                task({ id: B, status: 'assigned' }),
                task({ id: C, status: 'assigned' }),
                task({ id: E, dependsOn: [A, B, C] }),
            ],
        })
        const line = container.querySelector('[data-testid="blueprint-waiting-on"]') as HTMLElement
        expect(line.textContent).toContain('+1 more')
        unmount()
    })

    it('R3: clicking a named dep opens THAT task (and not the row it sits on)', () => {
        const onTaskOpen = vi.fn()
        const { container, unmount } = mountList({ tasks: chainTasks(), onTaskOpen })
        const dep = container.querySelector('[data-testid="blueprint-waiting-on-dep"]') as HTMLButtonElement
        expect(dep).toBeTruthy()
        act(() => { dep.click() })
        expect(onTaskOpen).toHaveBeenCalledTimes(1)
        expect(onTaskOpen.mock.calls[0][0].id).toBe(A)
        unmount()
    })

    it('R4: "By mission" groups the chain under a chain header that opens the anchor task', () => {
        const onTaskOpen = vi.fn()
        const { container, unmount } = mountList({ tasks: chainTasks(), onTaskOpen })
        const chip = [...container.querySelectorAll('button')].find(button => button.textContent === 'By mission') as HTMLButtonElement
        act(() => { chip.click() })
        const header = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('⛓')) as HTMLButtonElement
        expect(header?.textContent).toContain('Chain: Build the parser')
        expect(container.textContent).not.toContain('No mission')
        act(() => { header.click() })
        expect(onTaskOpen.mock.calls.at(-1)?.[0].id).toBe(A)
        unmount()
    })

    it('R5: a task with no unmet deps renders no waiting-on line; a missing dep is text, not a link', () => {
        const { container, unmount } = mountList({
            tasks: [task({ id: A, status: 'assigned' }), task({ id: B, dependsOn: [D] })],
        })
        const lines = container.querySelectorAll('[data-testid="blueprint-waiting-on"]')
        expect(lines.length).toBe(1)
        expect(lines[0].textContent).toContain('dddddddd')
        expect(container.querySelector('[data-testid="blueprint-waiting-on-dep"]')).toBeNull()
        unmount()
    })
})
