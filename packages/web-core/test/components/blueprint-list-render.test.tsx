/**
 * ★ Blueprint list — production-shaped render.
 *
 * Renders MeshBlueprintList exactly the way MeshBlueprintView calls it (same
 * prop shape, real i18n via the shared test setup, real theme object) and
 * asserts what the OWNER sees, not internal state:
 *
 *  - a generating task renders inside the Running section with its live label
 *  - terminal queue rows are NOT in the default view (Running+Blocked only)
 *  - a blocking gate renders as a Blocked row
 *  - the plan affordance appears only for rows whose graph has edges
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
            graphs={[]}
            meshTheme={meshTheme}
            onTaskOpen={() => { }}
            onGateOpen={() => { }}
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

    it('renders a blocking gate as a Blocked row', () => {
        const html = renderList({
            graphs: [{
                graphId: 'g1', status: 'waiting_gate', edges: [], createdAt: '2026-09-16T09:00:00Z',
                nodes: [{ nodeId: 'review_land', ref: 'review_land', kind: 'coordinator_gate', state: 'awaiting_coordinator', materializationVersion: 1 }],
                gates: [{ gateId: 'g', nodeId: 'review_land', state: 'awaiting_coordinator', action: 'approval', onTimeout: 'hold', leaseGeneration: 0, instructions: 'Review and land the branch' }],
            } as any],
        })
        expect(html).toContain('Blocked')
        expect(html).toContain('review_land')
        expect(html).toContain('Needs you')
    })

    it('offers the plan disclosure only when the graph HAS edges', () => {
        const graphTask = task({ id: 't1', status: 'assigned', message: 'graph member row' })
        const withEdges = renderList({
            tasks: [graphTask],
            graphs: [{
                graphId: 'g-edges', status: 'running', createdAt: '2026-09-16T09:00:00Z',
                nodes: [
                    { nodeId: 'n1', ref: 'n1', kind: 'worker_task', state: 'materialized', taskId: 't1', materializationVersion: 1 },
                    { nodeId: 'n2', ref: 'n2', kind: 'worker_task', state: 'declared', materializationVersion: 1 },
                ],
                gates: [],
                edges: [{ from: 'n1', to: 'n2', active: true }],
            } as any],
        })
        const withoutEdges = renderList({
            tasks: [graphTask],
            graphs: [{
                graphId: 'g-bare', status: 'running', createdAt: '2026-09-16T09:00:00Z',
                nodes: [{ nodeId: 'n1', ref: 'n1', kind: 'worker_task', state: 'materialized', taskId: 't1', materializationVersion: 1 }],
                gates: [],
                edges: [],
            } as any],
        })
        expect(withEdges).toContain('aria-expanded')
        expect(withoutEdges).not.toContain('aria-expanded')
    })
})
