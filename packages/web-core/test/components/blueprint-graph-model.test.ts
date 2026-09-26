/**
 * Blueprint GRAPH view model (blueprintGraphModel + blueprintGraphLayout) —
 * the pure rules behind MeshBlueprintGraph:
 *
 *  - one node vocabulary for queue depends_on chains AND persistent graphs
 *    (a materialized worker node and its queue row are ONE node)
 *  - dead-dependency propagation (direct + transitive) and the red edges
 *  - gate tones (awaiting / claimed / expired / released / abandoned) +
 *    deadline countdown
 *  - lanes: mission → graph → chain → ad-hoc; active-only; collapse; fold
 *  - the structure key: stable across status-only polls
 *  - ELK lane layout: left → right, lanes stacked without overlap
 */
import { describe, expect, it } from 'vitest'
import {
    applyBlueprintGraphView,
    blueprintGraphLaneKey,
    blueprintGraphStructureKey,
    buildBlueprintGraphModel,
    firstLineTitle,
    gateDeadlineReading,
    snapshotHasStructure,
    taskHeldUntilMs,
    taskNodeTimeReading,
    type BlueprintGraphGateNode,
    type BlueprintGraphTaskNode,
} from '../../src/components/MeshGraph/blueprintGraphModel'
import { layoutBlueprintGraph, narrowPaneViewport, BLUEPRINT_GRAPH_NARROW_MIN_ZOOM, BLUEPRINT_GRAPH_SIZES } from '../../src/components/MeshGraph/blueprintGraphLayout'
import { resolveBlueprintViewMode } from '../../src/components/MeshGraph/blueprintViewMode'

let clock = 0
function task(id: string, status: string, over: Record<string, unknown> = {}): any {
    clock += 1
    const at = new Date(Date.parse('2026-09-26T10:00:00Z') + clock * 60_000).toISOString()
    return { id, meshId: 'm', message: `Task ${id}\nbody of ${id}`, status, createdAt: at, updatedAt: at, ...over }
}

function gateGraph(over: Record<string, unknown> = {}, gateOver: Record<string, unknown> = {}): any {
    return {
        graphId: 'G1',
        batchId: 'B1',
        status: 'waiting_gate',
        enqueueSurface: 'mesh_enqueue_batch',
        schemaVersion: 1,
        createdAt: '2026-09-26T09:00:00Z',
        onDependencyFailure: 'block',
        counts: { tasks: 2, gates: 1, workspaces: 0, edges: 2 },
        nodeStates: {},
        nodes: [
            { nodeId: 'n-build', ref: 'build', kind: 'worker_task', state: 'completed', taskId: 't-build', materializationVersion: 1 },
            { nodeId: 'n-review', ref: 'review', kind: 'coordinator_gate', state: 'awaiting_coordinator', materializationVersion: 1 },
            { nodeId: 'n-ship', ref: 'ship', kind: 'worker_task', state: 'blocked', taskId: 't-ship', blockedByGateId: 'gate-1', materializationVersion: 1 },
        ],
        edges: [
            { from: 'build', to: 'review', kind: 'requires', omitOnSkip: false, active: true },
            { from: 'review', to: 'ship', kind: 'gate', omitOnSkip: false, active: true },
        ],
        gates: [
            { gateId: 'gate-1', nodeId: 'n-review', state: 'awaiting_coordinator', action: 'approval', onTimeout: 'hold', leaseGeneration: 0, deadlineAt: '2026-09-27T10:00:00Z', ...gateOver },
        ],
        workspaces: [],
        ...over,
    }
}

const byId = <T extends { id: string }>(items: T[]) => new Map(items.map(item => [item.id, item]))

describe('buildBlueprintGraphModel — queue depends_on chains', () => {
    it('projects a 3-task chain as task nodes + solid depends edges in one chain lane', () => {
        const model = buildBlueprintGraphModel([
            task('a', 'pending', { notBefore: '2099-01-01T00:00:00Z' }),
            task('b', 'pending', { dependsOn: ['a'] }),
            task('c', 'pending', { dependsOn: ['b'] }),
        ], [])
        expect(model.nodes.map(node => node.id)).toEqual(['task:a', 'task:b', 'task:c'])
        expect(model.edges.map(edge => [edge.source, edge.target, edge.kind, edge.state])).toEqual([
            ['task:a', 'task:b', 'depends', 'waiting'],
            ['task:b', 'task:c', 'depends', 'waiting'],
        ])
        expect(model.groups).toHaveLength(1)
        expect(model.groups[0]).toMatchObject({ key: 'chain:a', kind: 'chain', anchorTaskId: 'a', title: 'Task a', live: true })
        expect(model.hasStructure).toBe(true)
        const a = model.nodes[0] as BlueprintGraphTaskNode
        expect(a.title).toBe('Task a')
        expect(a.fullTitle).toContain('body of a')
    })

    it('animates only edges into a running (assigned) task and marks satisfied deps', () => {
        const model = buildBlueprintGraphModel([
            task('a', 'completed'),
            task('b', 'assigned', { dependsOn: ['a'], assignedProviderType: 'claude-cli', assignedNodeId: 'node-1' }),
            task('c', 'pending', { dependsOn: ['b'] }),
        ], [])
        const edges = byId(model.edges)
        expect(edges.get('e:task:a->task:b')).toMatchObject({ state: 'satisfied', animated: true })
        expect(edges.get('e:task:b->task:c')).toMatchObject({ state: 'waiting', animated: false })
        const b = model.nodes.find(node => node.id === 'task:b') as BlueprintGraphTaskNode
        expect(b).toMatchObject({ tone: 'running', provider: 'claude-cli', assignedNodeId: 'node-1' })
    })
})

describe('buildBlueprintGraphModel — dead dependencies', () => {
    it('marks direct and transitive dependents of a cancelled root dead, and every edge into them red', () => {
        const model = buildBlueprintGraphModel([
            task('root', 'cancelled'),
            task('child', 'pending', { dependsOn: ['root'] }),
            task('grandchild', 'pending', { dependsOn: ['child'] }),
            task('sibling', 'pending'),
        ], [])
        const nodes = byId(model.nodes) as Map<string, BlueprintGraphTaskNode>
        expect(nodes.get('task:child')).toMatchObject({ tone: 'dead', deadReason: 'direct' })
        expect(nodes.get('task:grandchild')).toMatchObject({ tone: 'dead', deadReason: 'transitive' })
        expect(nodes.get('task:sibling')?.tone).toBe('pending')
        expect(model.edges.map(edge => edge.state)).toEqual(['dead', 'dead'])
        const lane = model.groups.find(group => group.key === 'chain:root')!
        expect(lane.counts).toMatchObject({ dead: 2, cancelled: 1 })
        // A stuck lane still needs a human — it is live, not finished.
        expect(lane.live).toBe(true)
    })

    it('a failed dependency kills its dependent; a completed one does not', () => {
        const model = buildBlueprintGraphModel([
            task('ok', 'completed'),
            task('bad', 'failed'),
            task('x', 'pending', { dependsOn: ['ok', 'bad'] }),
        ], [])
        const x = model.nodes.find(node => node.id === 'task:x') as BlueprintGraphTaskNode
        expect(x.tone).toBe('dead')
        // Both edges into a node that can never start read red.
        expect(model.edges.every(edge => edge.state === 'dead')).toBe(true)
    })

    it('honours the daemon dependencyFailures projection even without an in-snapshot edge', () => {
        const model = buildBlueprintGraphModel([
            task('x', 'pending', { dependsOn: ['gone'], dependencyFailures: [{ taskId: 'gone', status: 'failed' }] }),
        ], [])
        const x = model.nodes[0] as BlueprintGraphTaskNode
        expect(x).toMatchObject({ tone: 'dead', deadReason: 'direct', missingDeps: ['gone'] })
    })

    it('does not mark a running or finished task dead', () => {
        const model = buildBlueprintGraphModel([
            task('bad', 'failed'),
            task('run', 'assigned', { dependsOn: ['bad'] }),
        ], [])
        expect((model.nodes.find(node => node.id === 'task:run') as BlueprintGraphTaskNode).tone).toBe('running')
    })
})

describe('buildBlueprintGraphModel — persistent graphs + gates', () => {
    it('merges materialized worker nodes with their queue rows and draws each edge once', () => {
        const graph = gateGraph()
        // The graph edge build→ship ALSO rides the queue as dependsOn — one edge, not two.
        graph.edges.push({ from: 'build', to: 'ship', kind: 'requires', omitOnSkip: false, active: true })
        const model = buildBlueprintGraphModel([
            task('t-build', 'completed'),
            task('t-ship', 'pending', { dependsOn: ['t-build'] }),
        ], [graph])
        expect(model.nodes.map(node => node.id).sort()).toEqual(['gate:G1:n-review', 'task:t-build', 'task:t-ship'])
        const edges = model.edges.map(edge => `${edge.source}>${edge.target}:${edge.kind}`).sort()
        expect(edges).toEqual([
            'gate:G1:n-review>task:t-ship:gate',
            'task:t-build>gate:G1:n-review:gate',
            'task:t-build>task:t-ship:depends',
        ])
        const ship = model.nodes.find(node => node.id === 'task:t-ship') as BlueprintGraphTaskNode
        expect(ship).toMatchObject({ graphId: 'G1', graphNodeId: 'n-ship', ref: 'ship', tone: 'pending' })
        expect(model.groups).toHaveLength(1)
        expect(model.groups[0]).toMatchObject({ key: 'graph:G1', kind: 'graph', live: true })
        expect(model.groups[0].counts.gatesBlocking).toBe(1)
    })

    it('an unmaterialized worker node becomes a plan placeholder', () => {
        const graph = gateGraph()
        graph.nodes[2] = { nodeId: 'n-ship', ref: 'ship', kind: 'worker_task', state: 'declared', materializationVersion: 0 }
        const model = buildBlueprintGraphModel([task('t-build', 'completed')], [graph])
        const plan = model.nodes.find(node => node.id === 'plan:G1:n-ship') as BlueprintGraphTaskNode
        expect(plan).toMatchObject({ kind: 'task', tone: 'plan', title: 'ship' })
        expect(plan.taskId).toBeUndefined()
    })

    it.each([
        ['declared', 'declared', false],
        ['awaiting_coordinator', 'awaiting', true],
        ['claimed', 'claimed', true],
        ['expired', 'expired', true],
        ['released', 'released', false],
        ['cancelled', 'abandoned', false],
    ])('gate state %s → tone %s (blocking=%s)', (state, tone, blocking) => {
        const model = buildBlueprintGraphModel([], [gateGraph({}, { state })])
        const gate = model.nodes.find(node => node.kind === 'gate') as BlueprintGraphGateNode
        expect(gate).toMatchObject({ tone, blocking, ref: 'review' })
    })

    it('an abandoned gate (or a failed release) makes everything behind it dead', () => {
        for (const gateOver of [{ state: 'cancelled' }, { state: 'released', releaseOutcome: 'failed' }]) {
            const model = buildBlueprintGraphModel([task('t-build', 'completed'), task('t-ship', 'pending')], [gateGraph({}, gateOver)])
            const ship = model.nodes.find(node => node.id === 'task:t-ship') as BlueprintGraphTaskNode
            expect(ship.tone).toBe('dead')
            expect(model.edges.find(edge => edge.target === 'task:t-ship')?.state).toBe('dead')
        }
        const passed = buildBlueprintGraphModel([task('t-build', 'completed'), task('t-ship', 'pending')], [gateGraph({}, { state: 'released', releaseOutcome: 'passed' })])
        expect(passed.edges.find(edge => edge.target === 'task:t-ship')?.state).toBe('satisfied')
    })

    it('gate deadline countdown: remaining, overdue, and none once the gate is terminal', () => {
        const now = Date.parse('2026-09-27T08:00:00Z')
        const model = buildBlueprintGraphModel([], [gateGraph()])
        const gate = model.nodes.find(node => node.kind === 'gate') as BlueprintGraphGateNode
        expect(gateDeadlineReading(gate, now)).toEqual({ overdue: false, ms: 2 * 3_600_000 })
        expect(gateDeadlineReading(gate, now + 3 * 3_600_000)).toEqual({ overdue: true, ms: 3_600_000 })
        expect(gateDeadlineReading({ ...gate, tone: 'released' }, now)).toBeUndefined()
        expect(gateDeadlineReading({ ...gate, gate: undefined }, now)).toBeUndefined()
    })
})

describe('buildBlueprintGraphModel — lanes', () => {
    it('groups by mission across BOTH systems, else graph, else chain, else ad-hoc', () => {
        const model = buildBlueprintGraphModel([
            task('m1', 'pending', { missionId: 'M' }),
            task('m2', 'pending', { dependsOn: ['m1'] }), // inherits M via its chain
            task('t-build', 'completed'),
            task('t-ship', 'pending'),
            task('solo', 'pending'),
            task('c1', 'completed'),
            task('c2', 'pending', { dependsOn: ['c1'] }),
        ], [gateGraph({ missionId: 'M' })], null, { M: 'Mission Alpha' })
        const groupOf = (id: string) => model.nodes.find(node => node.id === id)!.groupKey
        expect(groupOf('task:m1')).toBe('mission:M')
        expect(groupOf('task:m2')).toBe('mission:M')
        expect(groupOf('task:t-ship')).toBe('mission:M')
        expect(groupOf('gate:G1:n-review')).toBe('mission:M')
        expect(groupOf('task:c2')).toBe('chain:c1')
        expect(groupOf('task:solo')).toBe('adhoc')
        expect(model.groups.find(group => group.key === 'mission:M')?.title).toBe('Mission Alpha')
        // Ad-hoc sorts after other live lanes.
        expect(model.groups.at(-1)?.key).toBe('adhoc')
    })

    it('snapshotHasStructure / default view mode: graph only once there is something to draw', () => {
        expect(snapshotHasStructure([{ dependsOn: [] }, {}], [])).toBe(false)
        expect(snapshotHasStructure([{ dependsOn: ['x'] }], [])).toBe(true)
        expect(snapshotHasStructure([], [{ edges: [], gates: [{} as any] }])).toBe(true)
        expect(resolveBlueprintViewMode(null, false)).toBe('list')
        expect(resolveBlueprintViewMode(null, true)).toBe('graph')
        expect(resolveBlueprintViewMode('list', true)).toBe('list')
    })

    it('firstLineTitle trims to one line with an ellipsis', () => {
        expect(firstLineTitle('\n  hello world  \nsecond')).toBe('hello world')
        expect(firstLineTitle('x'.repeat(80), 10)).toBe(`${'x'.repeat(10)}…`)
    })

    it('time readings: running since dispatch, finished at update, queued since creation', () => {
        const now = Date.parse('2026-09-26T12:00:00Z')
        expect(taskNodeTimeReading({ tone: 'running', dispatchedAt: '2026-09-26T11:30:00Z', createdAt: '2026-09-26T10:00:00Z' }, now))
            .toEqual({ kind: 'running', at: '2026-09-26T11:30:00Z', elapsedMs: 30 * 60_000 })
        expect(taskNodeTimeReading({ tone: 'completed', updatedAt: '2026-09-26T11:00:00Z' }, now)?.kind).toBe('finished')
        expect(taskNodeTimeReading({ tone: 'dead', createdAt: '2026-09-26T11:59:00Z' }, now)).toMatchObject({ kind: 'queued', elapsedMs: 60_000 })
        expect(taskNodeTimeReading({ tone: 'pending', createdAt: 'nope' }, now)).toBeUndefined()
    })
})

describe('applyBlueprintGraphView — active-only, collapse, fold', () => {
    const snapshot = () => [
        // live mission lane with 3 completed predecessors (fold threshold)
        task('d1', 'completed', { missionId: 'LIVE' }),
        task('d2', 'completed', { missionId: 'LIVE', dependsOn: ['d1'] }),
        task('d3', 'completed', { missionId: 'LIVE', dependsOn: ['d2'] }),
        task('next', 'pending', { missionId: 'LIVE', dependsOn: ['d3', 'd1'] }),
        // fully finished lane
        task('old1', 'completed', { missionId: 'DONE' }),
        task('old2', 'completed', { missionId: 'DONE', dependsOn: ['old1'] }),
    ]

    it('active-only hides fully finished lanes and counts them', () => {
        const model = buildBlueprintGraphModel(snapshot(), [])
        const view = applyBlueprintGraphView(model, { activeOnly: true })
        expect(view.lanes.map(lane => lane.group.key)).toEqual(['mission:LIVE'])
        expect(view.hiddenLaneCount).toBe(1)
    })

    it('without active-only, a finished lane is visible but starts collapsed (no nodes)', () => {
        const view = applyBlueprintGraphView(buildBlueprintGraphModel(snapshot(), []), { activeOnly: false })
        const done = view.lanes.find(lane => lane.group.key === 'mission:DONE')!
        expect(done).toMatchObject({ collapsed: true, nodeIds: [] })
        const expanded = applyBlueprintGraphView(buildBlueprintGraphModel(snapshot(), []), { activeOnly: false, collapsed: { 'mission:DONE': false } })
        expect(expanded.lanes.find(lane => lane.group.key === 'mission:DONE')!.nodeIds).toEqual(['task:old1', 'task:old2'])
    })

    it('folds ≥3 completed tasks of a live lane into one chip and rewires + dedupes their edges', () => {
        const view = applyBlueprintGraphView(buildBlueprintGraphModel(snapshot(), []), { activeOnly: true })
        const lane = view.lanes[0]
        expect(lane).toMatchObject({ folded: true, canFold: true })
        expect(lane.nodeIds).toEqual(['fold:mission:LIVE', 'task:next'])
        const fold = view.nodes.find(node => node.kind === 'fold')!
        expect(fold).toMatchObject({ count: 3 })
        // d3→next and d1→next collapse into ONE fold→next edge; d1→d2, d2→d3 vanish.
        expect(view.edges.map(edge => `${edge.source}>${edge.target}`)).toEqual(['fold:mission:LIVE>task:next'])
        const unfolded = applyBlueprintGraphView(buildBlueprintGraphModel(snapshot(), []), { activeOnly: true, folded: { 'mission:LIVE': false } })
        expect(unfolded.nodes.filter(node => node.kind === 'task')).toHaveLength(4)
        expect(unfolded.edges).toHaveLength(4)
    })
})

describe('blueprintGraphStructureKey — re-layout only on structure change', () => {
    const base = () => [
        task('a', 'pending', { missionId: 'M' }),
        task('b', 'pending', { missionId: 'M', dependsOn: ['a'] }),
        task('c', 'pending', { missionId: 'M', dependsOn: ['b'] }),
    ]
    const keyOf = (tasks: any[], graphs: any[] = []) => {
        const view = applyBlueprintGraphView(buildBlueprintGraphModel(tasks, graphs), { activeOnly: true })
        return { structure: blueprintGraphStructureKey(view), lanes: blueprintGraphLaneKey(view) }
    }

    it('is identical across status-only updates (pending → assigned → failed, gate state, provider, times)', () => {
        const first = base()
        const second = base().map((t, index) => ({
            ...first[index],
            ...(t.id === 'a' ? { status: 'assigned', assignedProviderType: 'codex-cli', updatedAt: '2026-09-26T13:00:00Z' } : {}),
        }))
        const third = base().map((t, index) => ({ ...first[index], ...(t.id === 'a' ? { status: 'failed' } : {}) }))
        expect(keyOf(second)).toEqual(keyOf(first))
        // a failing turns b and c dead — colours change, geometry does not.
        expect(keyOf(third)).toEqual(keyOf(first))
        expect(keyOf([], [gateGraph()])).toEqual(keyOf([], [gateGraph({}, { state: 'claimed' })]))
    })

    it('lane order does not follow activity: a status poll touching an older lane never reorders lanes', () => {
        const older = task('old', 'pending', { missionId: 'OLD' })
        const newer = task('new', 'pending', { missionId: 'NEW' })
        const before = applyBlueprintGraphView(buildBlueprintGraphModel([older, newer], []), { activeOnly: true })
        const after = applyBlueprintGraphView(buildBlueprintGraphModel([
            { ...older, status: 'assigned', updatedAt: '2099-01-01T00:00:00Z' }, newer,
        ], []), { activeOnly: true })
        expect(before.lanes.map(lane => lane.group.key)).toEqual(['mission:NEW', 'mission:OLD'])
        expect(after.lanes.map(lane => lane.group.key)).toEqual(['mission:NEW', 'mission:OLD'])
        expect(blueprintGraphStructureKey(after)).toBe(blueprintGraphStructureKey(before))
    })

    it('changes when a node or an edge appears, and the lane key changes only when lanes do', () => {
        const first = base()
        const withNode = [...first, { ...task('d', 'pending', { missionId: 'M' }) }]
        const withEdge = first.map(t => (t.id === 'c' ? { ...t, dependsOn: ['b', 'a'] } : t))
        expect(keyOf(withNode).structure).not.toEqual(keyOf(first).structure)
        expect(keyOf(withEdge).structure).not.toEqual(keyOf(first).structure)
        // Same lanes → no refit; a new lane → refit.
        expect(keyOf(withNode).lanes).toEqual(keyOf(first).lanes)
        expect(keyOf([...first, task('z', 'pending', { missionId: 'OTHER' })]).lanes).not.toEqual(keyOf(first).lanes)
    })
})

describe('layoutBlueprintGraph (real ELK)', () => {
    it('lays chains out left → right and stacks lanes without overlap', async () => {
        const model = buildBlueprintGraphModel([
            task('a', 'pending', { missionId: 'M1' }),
            task('b', 'pending', { missionId: 'M1', dependsOn: ['a'] }),
            task('c', 'pending', { missionId: 'M1', dependsOn: ['b'] }),
            task('s1', 'pending'),
            task('s2', 'pending'),
        ], [gateGraph()])
        const view = applyBlueprintGraphView(model, { activeOnly: false })
        const layout = await layoutBlueprintGraph(view)
        for (const node of view.nodes) expect(layout.positions.has(node.id), node.id).toBe(true)
        const x = (id: string) => layout.positions.get(id)!.x
        expect(x('task:a')).toBeLessThan(x('task:b'))
        expect(x('task:b')).toBeLessThan(x('task:c'))
        expect(x('gate:G1:n-review')).toBeLessThan(x('task:t-ship'))
        // Lanes stack top → bottom, each node inside its own lane's rect.
        const rects = layout.lanes
        for (let i = 1; i < rects.length; i += 1) expect(rects[i].y).toBeGreaterThanOrEqual(rects[i - 1].y + rects[i - 1].height)
        for (const lane of view.lanes) {
            const rect = rects.find(r => r.key === lane.group.key)!
            for (const id of lane.nodeIds) {
                const pos = layout.positions.get(id)!
                const kind = view.nodes.find(node => node.id === id)!.kind
                expect(pos.y).toBeGreaterThanOrEqual(rect.y)
                expect(pos.y + BLUEPRINT_GRAPH_SIZES[kind].height).toBeLessThanOrEqual(rect.y + rect.height)
                expect(pos.x + BLUEPRINT_GRAPH_SIZES[kind].width).toBeLessThanOrEqual(rect.x + rect.width)
            }
        }
    })

    it('handles ~200 tasks (chains + a gate graph) — model, fold and layout stay fast', async () => {
        const tasks: any[] = []
        for (let chain = 0; chain < 40; chain += 1) {
            for (let step = 0; step < 5; step += 1) {
                const id = `c${chain}-s${step}`
                tasks.push(task(id, step < 2 ? 'completed' : step === 2 ? 'assigned' : 'pending', {
                    missionId: `M${chain % 8}`,
                    ...(step > 0 ? { dependsOn: [`c${chain}-s${step - 1}`] } : {}),
                }))
            }
        }
        const started = performance.now()
        const model = buildBlueprintGraphModel(tasks, [gateGraph()])
        const view = applyBlueprintGraphView(model, { activeOnly: true })
        const modelMs = performance.now() - started
        const layout = await layoutBlueprintGraph(view)
        expect(model.nodes.length).toBe(203)
        expect(layout.positions.size).toBe(view.nodes.length)
        expect(modelMs).toBeLessThan(250)
    })
})

describe('not_before holds', () => {
    it('a pending task with a FUTURE not_before is held; past holds, stuck and running tasks are not', () => {
        const now = Date.parse('2026-09-26T12:00:00Z')
        const model = buildBlueprintGraphModel([
            task('future', 'pending', { notBefore: '2099-01-01T00:00:00.000Z' }),
            task('past', 'pending', { notBefore: '2026-09-26T11:00:00.000Z' }),
            task('bad', 'failed'),
            task('stuck', 'pending', { notBefore: '2099-01-01T00:00:00.000Z', dependsOn: ['bad'] }),
            task('run', 'assigned', { notBefore: '2099-01-01T00:00:00.000Z' }),
        ], [])
        const held = (id: string) => taskHeldUntilMs(model.nodes.find(node => node.id === `task:${id}`) as BlueprintGraphTaskNode, now)
        expect(held('future')).toBe(Date.parse('2099-01-01T00:00:00.000Z'))
        expect(held('past')).toBeUndefined()
        expect(held('stuck')).toBeUndefined()
        expect(held('run')).toBeUndefined()
        // Tone stays neutral: a held task is still 'pending' in the model.
        expect((model.nodes.find(node => node.id === 'task:future') as BlueprintGraphTaskNode).tone).toBe('pending')
    })
})

describe('narrowPaneViewport — phone fit on width', () => {
    const lanes = [{ x: 0, y: 0, width: 800 }, { x: 0, y: 200, width: 1000 }]
    it('zooms so the widest lane fits the pane width, anchored top-left', () => {
        const viewport = narrowPaneViewport(390, lanes)!
        expect(viewport.zoom).toBeCloseTo((390 - 16) / 1000, 5)
        expect(viewport.zoom * 1000 + viewport.x).toBeLessThanOrEqual(390)
        expect(viewport).toMatchObject({ x: 8, y: 8 })
    })
    it('never zooms below the legibility floor, never above 1, and is off on wide panes', () => {
        expect(narrowPaneViewport(375, [{ x: 0, y: 0, width: 5000 }])!.zoom).toBe(BLUEPRINT_GRAPH_NARROW_MIN_ZOOM)
        expect(narrowPaneViewport(600, [{ x: 0, y: 0, width: 300 }])!.zoom).toBe(1)
        expect(narrowPaneViewport(640, lanes)).toBeNull()
        expect(narrowPaneViewport(1440, lanes)).toBeNull()
        expect(narrowPaneViewport(0, lanes)).toBeNull()
    })
})
