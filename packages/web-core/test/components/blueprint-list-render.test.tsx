/**
 * ★ Blueprint list — production-shaped render.
 *
 * Renders MeshBlueprintList exactly the way MeshBlueprintView calls it (same
 * prop shape, real i18n via the shared test setup, real theme object) and
 * asserts what the OWNER sees, not internal state:
 *
 *  - a generating task renders inside the Running section with its live label
 *  - terminal queue rows are NOT in the default view (Running+Blocked only)
 *  - a task behind a failed dependency renders as a Blocked row
 *  - the plan affordance appears only for rows with dependency edges
 *
 * MeshMiniDag is stubbed at the module seam (same convention as the
 *  MeshGraphView stub in mesh-observability-surface.test.ts): @xyflow/react
 * draws nothing under SSR anyway, and no plan is expanded at first render.
 */
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/MeshGraph/MeshMiniDag', () => ({
    default: () => null,
}))

import MeshBlueprintList from '../../src/components/MeshGraph/MeshBlueprintList'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

const meshTheme = getMeshGraphTheme('dark')

const task = (over: Record<string, unknown> & { id: string }) => ({
    meshId: 'mesh-1',
    message: `message for ${over.id}`,
    status: 'pending',
    createdAt: '2026-09-16T10:00:00Z',
    updatedAt: '2026-09-16T10:00:00Z',
    ...over,
}) as any

function renderList(over: Partial<React.ComponentProps<typeof MeshBlueprintList>> = {}): string {
    return renderToString(
        <MeshBlueprintList
            tasks={[]}
            status={{ meshId: 'mesh-1', meshName: 'Mesh', repoIdentity: 'repo', refreshedAt: '2026-09-16T10:00:00Z', nodes: [] } as any}
            meshTheme={meshTheme}
            onTaskOpen={() => { }}
            {...over}
        />,
    )
}

describe('MeshBlueprintList — default view', () => {
    it('renders a generating task in the Running section with the live label', () => {
        const html = renderList({
            tasks: [task({ id: 't-gen', status: 'assigned', assignedSessionId: 's1', assignedNodeId: 'node-1', message: 'Refactor CLI provider' })],
            status: {
                meshId: 'mesh-1', meshName: 'Mesh', repoIdentity: 'repo', refreshedAt: '2026-09-16T10:00:00Z',
                nodes: [{ nodeId: 'node-1', activeSessionDetails: [{ sessionId: 's1', state: 'generating' }] }],
            } as any,
        })
        expect(html).toContain('Running')
        expect(html).toContain('generating')
        expect(html).toContain('Refactor CLI provider')
    })

    it('keeps terminal queue rows OUT of the default view; the status bar still counts them', () => {
        const html = renderList({
            tasks: [
                task({ id: 't-live', status: 'assigned', message: 'live work row' }),
                task({ id: 't-done', status: 'completed', message: 'finished work row' }),
            ],
        })
        expect(html).toContain('live work row')
        expect(html).not.toContain('finished work row')
        // Recent count on the bar names what History would reveal.
        expect(html).toContain('Recent 1')
    })

    it('renders a task behind a failed dependency as a Blocked row', () => {
        const html = renderList({
            tasks: [
                task({ id: 't-root', status: 'failed', message: 'root work row' }),
                task({ id: 't-held', status: 'pending', dependsOn: ['t-root'], dependencyFailures: [{ taskId: 't-root', status: 'failed' }], message: 'held work row' }),
            ],
        })
        expect(html).toContain('Blocked')
        expect(html).toContain('held work row')
    })

    it('offers the plan disclosure only when the task has dependency edges', () => {
        const withEdges = renderList({
            tasks: [
                task({ id: 't1', status: 'assigned', message: 'chain head row' }),
                task({ id: 't2', status: 'pending', dependsOn: ['t1'], message: 'chain tail row' }),
            ],
        })
        const withoutEdges = renderList({ tasks: [task({ id: 't1', status: 'assigned', message: 'loose row' })] })
        expect(withEdges).toContain('aria-expanded')
        expect(withoutEdges).not.toContain('aria-expanded')
    })
})


describe('MeshBlueprintList — light and review-in-task chips', () => {
    const live = (over: Record<string, unknown>) => task({ id: 't-x', status: 'assigned', message: 'chip row', ...over })
    const attr = (html: string, testId: string) => new RegExp(`title="([^"]*)"[^>]*data-testid="${testId}"`).exec(html)?.[1] ?? ''

    it('light badge explains itself', () => {
        const html = renderList({ tasks: [live({ light: true })] })
        expect(html).toContain('data-testid="blueprint-light-badge"')
        expect(attr(html, 'blueprint-light-badge')).toContain('isolated temporary workspace')
    })

    it('landing chip tooltip says what to do next, and why when blocked', () => {
        const ready = renderList({ tasks: [live({ light: true, lightResult: { landing: 'ready' } })] })
        expect(ready).toContain('ready to land')
        expect(attr(ready, 'blueprint-light-landing')).toContain('land it')
        const blocked = renderList({ tasks: [live({ light: true, lightResult: { landing: 'blocked', blockedReason: 'light_dependency_change' } })] })
        expect(attr(blocked, 'blueprint-light-landing')).toContain('dependency files')
        const conflict = renderList({ tasks: [live({ light: true, lightResult: { landing: 'conflict' } })] })
        expect(attr(conflict, 'blueprint-light-landing')).toContain('resolve the conflict')
        // unknown wire values render no chip and no raw enum
        const unknown = renderList({ tasks: [live({ light: true, lightResult: { landing: 'whatever' } })] })
        expect(unknown).not.toContain('blueprint-light-landing')
    })

    it('stage chip shows phase, round and verdict with a hint tooltip; blocked reason is explained', () => {
        const done = renderList({ tasks: [live({ stageState: { phase: 'done', round: 2, lastVerdict: 'changes_requested' } })] })
        expect(done).toContain('review done')
        expect(done).toContain('round 2')
        expect(done).toContain('changes requested')
        expect(attr(done, 'blueprint-stage-chip')).toContain('review finished')
        const blocked = renderList({ tasks: [live({ stageState: { phase: 'revising', round: 3, blockedReason: 'review_unresolved' } })] })
        expect(attr(blocked, 'blueprint-stage-chip')).toContain('still unresolved')
        // a raw enum never leaks into the tooltip when the reason is unknown
        const weird = renderList({ tasks: [live({ stageState: { phase: 'revising', round: 1, blockedReason: 'future_reason' } })] })
        expect(attr(weird, 'blueprint-stage-chip')).not.toContain('future_reason')
    })
})
