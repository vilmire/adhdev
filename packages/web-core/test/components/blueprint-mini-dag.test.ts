/**
 * ★ Mini plan DAG (MeshMiniDag) — model, layout, and the honesty contracts
 * ported from the retired full canvas.
 *
 * Properties pinned:
 *  - the queue builder extracts exactly the task's connected component, and
 *    returns null for a task no edge touches — the twin of the list's
 *    plan-affordance rule
 *  - layout advances x by dependency depth, stacks same-depth nodes in y,
 *    and terminates on a dependency cycle
 *  - (source-shape, carried over from blueprint-legend-matches-canvas) the
 *    legend derives from the DRAWN edges, every pulse is motion-safe gated,
 *    and no edge is ever animated — the never-settling canvas class.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    buildQueueMiniDag,
    layoutMiniDag,
    MINI_DAG_LAYOUT,
} from '../../src/components/MeshGraph/miniDagViewModel'
import { buildTaskDag } from '../../src/components/MeshGraph/taskDagViewModel'

const queueTask = (id: string, status: string, dependsOn?: string[]) => ({
    id, meshId: 'm', message: `task ${id}`, status, dependsOn,
    createdAt: '2026-09-16T10:00:00Z', updatedAt: '2026-09-16T10:00:00Z',
}) as any

describe('buildQueueMiniDag', () => {
    const dag = buildTaskDag([
        queueTask('a', 'completed'),
        queueTask('b', 'pending', ['a']),
        queueTask('c', 'pending', ['b']),
        queueTask('island', 'pending'),
    ])

    it('extracts exactly the connected component around the task', () => {
        const model = buildQueueMiniDag('b', dag)!
        expect(model.nodes.map(node => node.id).sort()).toEqual(['a', 'b', 'c'])
        expect(model.edges).toHaveLength(2)
    })

    it('returns null for a task no edge touches — a lone card is not a plan', () => {
        expect(buildQueueMiniDag('island', dag)).toBeNull()
        expect(buildQueueMiniDag('not-there', dag)).toBeNull()
    })
})

describe('layoutMiniDag', () => {
    const step = MINI_DAG_LAYOUT.nodeWidth + MINI_DAG_LAYOUT.gapX

    it('advances x by dependency depth and stacks same-depth nodes in y', () => {
        const positions = layoutMiniDag({
            nodes: [
                { id: 'root1', kind: 'task', label: '', state: 'pending' },
                { id: 'root2', kind: 'task', label: '', state: 'pending' },
                { id: 'child', kind: 'task', label: '', state: 'pending' },
            ],
            edges: [
                { id: 'e1', source: 'root1', target: 'child', state: 'waiting' },
                { id: 'e2', source: 'root2', target: 'child', state: 'waiting' },
            ],
        })
        expect(positions.get('root1')!.x).toBe(0)
        expect(positions.get('root2')!.x).toBe(0)
        expect(positions.get('child')!.x).toBe(step)
        // Two roots share a column, so they must not share a y.
        expect(positions.get('root1')!.y).not.toBe(positions.get('root2')!.y)
    })

    it('a chain deepens one column per hop', () => {
        const positions = layoutMiniDag({
            nodes: ['a', 'b', 'c'].map(id => ({ id, taskId: id, label: '', state: 'pending' })),
            edges: [
                { id: 'e1', source: 'a', target: 'b', state: 'waiting' },
                { id: 'e2', source: 'b', target: 'c', state: 'waiting' },
            ],
        })
        expect(positions.get('a')!.x).toBe(0)
        expect(positions.get('b')!.x).toBe(step)
        expect(positions.get('c')!.x).toBe(step * 2)
    })

    it('terminates on a dependency cycle instead of recursing forever', () => {
        const positions = layoutMiniDag({
            nodes: ['a', 'b'].map(id => ({ id, taskId: id, label: '', state: 'pending' })),
            edges: [
                { id: 'e1', source: 'a', target: 'b', state: 'waiting' },
                { id: 'e2', source: 'b', target: 'a', state: 'waiting' },
            ],
        })
        expect(positions.size).toBe(2)
    })
})

/* ── Source-shape contracts ported from the retired canvas ──────────────────
 * (blueprint-legend-matches-canvas.test.ts asserted these on MeshTaskDagView;
 * the mini DAG is the surviving edge-drawing surface and inherits them.) */
const VIEW = path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshMiniDag.tsx')
const source = fs.readFileSync(VIEW, 'utf8')

describe('mini-DAG edge legend', () => {
    it('is derived from the rendered edges, not hardcoded', () => {
        expect(source).toMatch(/const legendStates = useMemo/)
        expect(source).toMatch(/for \(const edge of model\.edges\) present\.add\(edge\.state\)/)
    })

    it('hides itself entirely when the canvas draws no edges', () => {
        expect(source).toMatch(/\{legendStates\.length > 0 && \(/)
        expect(source).toMatch(/\{legendStates\.map\(state => \(/)
    })
})

describe('never-ending canvas animations respect reduced motion', () => {
    it('gates every pulsing dot behind motion-safe', () => {
        const pulseSites = [...source.matchAll(/animate-pulse/g)].length
        const gatedSites = [...source.matchAll(/motion-safe:animate-pulse/g)].length
        expect(pulseSites).toBeGreaterThan(0)
        expect(gatedSites).toBe(pulseSites)
    })

    it('never animates an edge — the canvas must settle for capture and a11y', () => {
        expect(source).toContain('animated: false')
        expect(source).not.toMatch(/animated:\s*true/)
        // The @xyflow dashdraw override survives in the mesh graph stylesheet
        // (loaded with the lazy graph chunk, after the @xyflow CSS it overrides).
        const css = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/MeshGraph/meshGraph.css'), 'utf8')
        expect(css).toMatch(/\.react-flow__edge\.animated path\s*\{\s*animation: none/)
    })
})
