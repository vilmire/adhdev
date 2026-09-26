// @vitest-environment jsdom
/**
 * Blueprint GRAPH view — production-shaped render (jsdom + react-dom/client).
 *
 * MeshBlueprintView is mounted exactly as the observability surface mounts it
 * (tasks + status + daemonId + sendDaemonCommand; graphs arrive through the
 * real mesh_graph_overview fetch). @xyflow/react is replaced by a thin DOM
 * stand-in that renders the registered nodeTypes and forwards clicks through
 * onNodeClick — the same seam MeshGraphView/MeshMiniDag tests stub — and the
 * ELK layout is a deterministic spy so re-layout counts are observable.
 */
import { act } from 'react'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ fitView: vi.fn(), setViewport: vi.fn(), layoutCalls: 0, paneWidth: 1200 }))

vi.mock('@xyflow/react', () => ({
    ReactFlow: ({ nodes, edges, nodeTypes, onNodeClick, children }: any) => (
        <div data-testid="rf">
            {nodes.map((node: any) => {
                const Component = nodeTypes[node.type]
                return (
                    <div key={node.id} data-node-id={node.id} onClick={event => onNodeClick?.(event, node)}>
                        <Component id={node.id} data={node.data} type={node.type} />
                    </div>
                )
            })}
            {edges.map((edge: any) => (
                <i
                    key={edge.id}
                    data-edge-id={edge.id}
                    data-animated={String(Boolean(edge.animated))}
                    data-stroke={edge.style?.stroke}
                    data-dash={edge.style?.strokeDasharray ?? ''}
                />
            ))}
            {children}
        </div>
    ),
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Controls: () => null,
    Background: () => null,
    MiniMap: () => null,
    BackgroundVariant: { Lines: 'lines', Dots: 'dots' },
    useReactFlow: () => ({ fitView: hoisted.fitView, setViewport: hoisted.setViewport }),
    useStore: (selector: (state: { width: number }) => unknown) => selector({ width: hoisted.paneWidth }),
    useNodesInitialized: () => true,
}))

vi.mock('../../src/components/MeshGraph/blueprintGraphLayout', async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/components/MeshGraph/blueprintGraphLayout')>()
    return {
        ...actual,
        layoutBlueprintGraph: async (view: any) => {
            hoisted.layoutCalls += 1
            const positions = new Map<string, { x: number; y: number }>()
            const lanes = view.lanes.map((lane: any, laneIndex: number) => {
                lane.nodeIds.forEach((id: string, index: number) => positions.set(id, { x: index * 300, y: laneIndex * 200 + 40 }))
                return { key: lane.group.key, x: 0, y: laneIndex * 200, width: 900, height: 180 }
            })
            return { positions, lanes }
        },
    }
})

import MeshBlueprintView from '../../src/components/MeshGraph/MeshBlueprintView'
import MeshBlueprintGraph from '../../src/components/MeshGraph/MeshBlueprintGraph'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'
import { BLUEPRINT_VIEW_MODE_STORAGE_KEY } from '../../src/components/MeshGraph/blueprintViewMode'

/* ── fixtures ─────────────────────────────────────────────────────────── */

const task = (id: string, status: string, over: Record<string, unknown> = {}): any => ({
    id, meshId: 'mesh-1', message: `Title ${id}\nFull body text for ${id}`, status,
    createdAt: '2026-09-26T10:00:00Z', updatedAt: '2026-09-26T10:05:00Z', ...over,
})

const gateGraph = (): any => ({
    graphId: 'G1', batchId: 'B1', status: 'waiting_gate', enqueueSurface: 'mesh_enqueue_batch', schemaVersion: 1,
    createdAt: '2026-09-26T09:00:00Z', onDependencyFailure: 'block', counts: { tasks: 1, gates: 1, workspaces: 0, edges: 1 },
    nodeStates: {}, workspaces: [],
    nodes: [
        { nodeId: 'n-review', ref: 'review', kind: 'coordinator_gate', state: 'awaiting_coordinator', materializationVersion: 1 },
        { nodeId: 'n-ship', ref: 'ship', kind: 'worker_task', state: 'blocked', taskId: 'ship', blockedByGateId: 'gate-1', materializationVersion: 1 },
    ],
    edges: [{ from: 'review', to: 'ship', kind: 'gate', omitOnSkip: false, active: true }],
    gates: [{ gateId: 'gate-1', nodeId: 'n-review', state: 'awaiting_coordinator', action: 'approval', onTimeout: 'hold', leaseGeneration: 0, deadlineAt: '2099-01-01T00:00:00Z' }],
})

const status = (): any => ({ meshId: 'mesh-1', meshName: 'Mesh', repoIdentity: 'repo', refreshedAt: '2026-09-26T10:00:00Z', nodes: [], missions: [] })

function commandMock(graphs: any[]) {
    return vi.fn(async (_daemonId: string, type: string) => {
        if (type === 'mesh_graph_overview') return { success: true, graphs, totalGraphCount: graphs.length }
        if (type === 'mesh_route_preview') return { success: true, preview: { nodes: [] } }
        return { success: true }
    })
}

/* In-memory per-viewer storage (the shared test setup stubs a no-op one). */
let store: Record<string, string> = {}
const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // jsdom has no matchMedia; useTheme reads prefers-color-scheme through it.
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any
    store = {}
    hoisted.fitView.mockClear()
    hoisted.setViewport.mockClear()
    hoisted.layoutCalls = 0
    hoisted.paneWidth = 1200
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => (key === 'lang' ? 'en' : store[key] ?? null),
            setItem: (key: string, value: string) => { store[key] = value },
            removeItem: (key: string) => { delete store[key] },
        },
    })
})
afterEach(() => {
    if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage)
    document.body.innerHTML = ''
})

/* Settles fetch promises, the async layout and the fit's requestAnimationFrame. */
async function flush() {
    for (let i = 0; i < 4; i += 1) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    }
}

async function mountView(props: { tasks: any[]; graphs?: any[] }) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const sendDaemonCommand = commandMock(props.graphs ?? [])
    await act(async () => {
        root.render(<MeshBlueprintView tasks={props.tasks} status={status()} daemonId="daemon-1" sendDaemonCommand={sendDaemonCommand} />)
    })
    await flush()
    return { container, root, sendDaemonCommand, unmount: () => act(() => root.unmount()) }
}

const click = async (element: Element) => {
    await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
}

/* ── the view switch ──────────────────────────────────────────────────── */

describe('Blueprint List / Graph switch', () => {
    it('defaults to Graph when the snapshot has a dependency, List when it is a flat pile', async () => {
        const chained = await mountView({ tasks: [task('a', 'pending'), task('b', 'pending', { dependsOn: ['a'] })] })
        expect(chained.container.querySelector('[data-testid="bp-graph"]')).not.toBeNull()
        expect(chained.container.querySelector('[data-testid="blueprint-view-graph"]')?.getAttribute('aria-checked')).toBe('true')
        chained.unmount()

        const flat = await mountView({ tasks: [task('a', 'pending'), task('b', 'pending')] })
        expect(flat.container.querySelector('[data-testid="bp-graph"]')).toBeNull()
        expect(flat.container.querySelector('[data-testid="blueprint-view-list"]')?.getAttribute('aria-checked')).toBe('true')
        flat.unmount()
    })

    it('a graph-only gate (no queue deps) is structure too → Graph', async () => {
        const view = await mountView({ tasks: [task('ship', 'pending')], graphs: [gateGraph()] })
        expect(view.container.querySelector('[data-testid="bp-graph"]')).not.toBeNull()
        view.unmount()
    })

    it('persists the viewer choice and restores it on the next mount', async () => {
        const first = await mountView({ tasks: [task('a', 'pending'), task('b', 'pending', { dependsOn: ['a'] })] })
        await click(first.container.querySelector('[data-testid="blueprint-view-list"]')!)
        expect(first.container.querySelector('[data-testid="bp-graph"]')).toBeNull()
        expect(store[BLUEPRINT_VIEW_MODE_STORAGE_KEY]).toBe('list')
        first.unmount()

        const second = await mountView({ tasks: [task('a', 'pending'), task('b', 'pending', { dependsOn: ['a'] })] })
        expect(second.container.querySelector('[data-testid="bp-graph"]')).toBeNull()
        await click(second.container.querySelector('[data-testid="blueprint-view-graph"]')!)
        expect(second.container.querySelector('[data-testid="bp-graph"]')).not.toBeNull()
        expect(store[BLUEPRINT_VIEW_MODE_STORAGE_KEY]).toBe('graph')
        second.unmount()
    })

    it('survives storage that throws (private window) and still switches', async () => {
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (key: string) => { if (key === 'lang') return 'en'; throw new Error('SecurityError') },
                setItem: () => { throw new Error('QuotaExceeded') },
                removeItem: () => {},
            },
        })
        const view = await mountView({ tasks: [task('a', 'pending'), task('b', 'pending', { dependsOn: ['a'] })] })
        expect(view.container.querySelector('[data-testid="bp-graph"]')).not.toBeNull()
        await click(view.container.querySelector('[data-testid="blueprint-view-list"]')!)
        expect(view.container.querySelector('[data-testid="bp-graph"]')).toBeNull()
        view.unmount()
    })
})

/* ── click-through + gate actions ─────────────────────────────────────── */

describe('Blueprint graph — interaction', () => {
    it('clicking a task node opens the same task detail the list rows open', async () => {
        const view = await mountView({ tasks: [task('a', 'pending'), task('b', 'pending', { dependsOn: ['a'] })] })
        const node = view.container.querySelector('[data-node-id="task:b"]')!
        expect(node.textContent).toContain('Title b')
        expect(document.body.textContent).not.toContain('Full body text for b')
        await click(node.querySelector('[data-testid="bp-graph-task"]')!)
        expect(document.body.textContent).toContain('Full body text for b')
        view.unmount()
    })

    it('clicking a gate opens its panel with Release / Abandon / Extend 24h wired to the daemon commands', async () => {
        const view = await mountView({ tasks: [task('ship', 'pending')], graphs: [gateGraph()] })
        const gate = view.container.querySelector('[data-node-id="gate:G1:n-review"] [data-testid="bp-graph-gate"]')!
        expect(gate.getAttribute('data-tone')).toBe('awaiting')
        await click(gate)
        const panel = view.container.querySelector('[data-testid="bp-graph-gate-panel"]')!
        expect(panel.textContent).toContain('Release')
        expect(panel.textContent).toContain('Abandon')
        expect(panel.textContent).toContain('Extend 24h')

        await click([...panel.querySelectorAll('button')].find(button => button.textContent === 'Release')!)
        await click([...panel.querySelectorAll('button')].find(button => button.textContent === 'Submit release')!)
        expect(view.sendDaemonCommand).toHaveBeenCalledWith('daemon-1', 'mesh_graph_gate_release', {
            mesh_id: 'mesh-1', gate_id: 'gate-1', outcome: 'passed',
        })
        // …and the graph list is refetched afterwards (no optimistic UI).
        const overviewCalls = view.sendDaemonCommand.mock.calls.filter(call => call[1] === 'mesh_graph_overview').length
        expect(overviewCalls).toBeGreaterThanOrEqual(2)
        view.unmount()
    })
})

/* ── edges, layout and viewport discipline (graph component directly) ── */

describe('Blueprint graph — edges and re-layout discipline', () => {
    const meshTheme = getMeshGraphTheme('dark')
    async function mountGraph(tasks: any[], graphs: any[] = []) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const render = async (nextTasks: any[], nextGraphs: any[] = graphs) => {
            await act(async () => {
                root.render(<MeshBlueprintGraph tasks={nextTasks} status={status()} graphs={nextGraphs} meshTheme={meshTheme} onTaskOpen={() => {}} onGateOpen={() => {}} />)
            })
            await flush()
        }
        await render(tasks)
        return { container, render, unmount: () => act(() => root.unmount()) }
    }

    it('draws dead edges red, gate edges dashed, and animates only edges into running tasks', async () => {
        const graph = await mountGraph([
            task('root', 'cancelled', { missionId: 'M' }),
            task('child', 'pending', { missionId: 'M', dependsOn: ['root'] }),
            task('done', 'completed', { missionId: 'M' }),
            task('run', 'assigned', { missionId: 'M', dependsOn: ['done'] }),
            task('ship', 'pending'),
        ], [gateGraph()])
        const edge = (id: string) => graph.container.querySelector(`[data-edge-id="${id}"]`)!
        expect(edge('e:task:root->task:child').getAttribute('data-stroke')).toBe('#f87171')
        expect(edge('e:task:done->task:run').getAttribute('data-animated')).toBe('true')
        expect(edge('e:task:root->task:child').getAttribute('data-animated')).toBe('false')
        expect(edge('e:gate:G1:n-review->task:ship').getAttribute('data-dash')).toBe('7 5')
        expect(edge('e:task:done->task:run').getAttribute('data-dash')).toBe('')
        expect(graph.container.querySelector('[data-node-id="task:child"] [data-testid="bp-graph-task"]')?.getAttribute('data-tone')).toBe('dead')
        expect(graph.container.querySelector('[data-testid="bp-graph-legend"]')?.textContent).toContain('can never start')
        graph.unmount()
    })

    it('a status-only poll neither re-runs the layout nor refits; a new lane does both', async () => {
        const base = [task('a', 'pending', { missionId: 'M' }), task('b', 'pending', { missionId: 'M', dependsOn: ['a'] })]
        const graph = await mountGraph(base)
        expect(hoisted.layoutCalls).toBe(1)
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
        const fitsAfterMount = hoisted.fitView.mock.calls.length
        expect(fitsAfterMount).toBeGreaterThanOrEqual(1)

        await graph.render(base.map(t => (t.id === 'a' ? { ...t, status: 'assigned', updatedAt: '2026-09-26T11:00:00Z' } : { ...t })))
        expect(graph.container.querySelector('[data-node-id="task:a"] [data-testid="bp-graph-task"]')?.getAttribute('data-tone')).toBe('running')
        expect(hoisted.layoutCalls).toBe(1)
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
        expect(hoisted.fitView).toHaveBeenCalledTimes(fitsAfterMount)

        await graph.render([...base, task('z', 'pending', { missionId: 'OTHER' })])
        expect(hoisted.layoutCalls).toBe(2)
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
        expect(hoisted.fitView.mock.calls.length).toBeGreaterThan(fitsAfterMount)
        graph.unmount()
    })

    it('on a phone-width pane the first fit is a width-fit viewport, not a zoom-1 fitView', async () => {
        hoisted.paneWidth = 375
        const graph = await mountGraph([task('a', 'pending', { missionId: 'M' }), task('b', 'pending', { missionId: 'M', dependsOn: ['a'] })])
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
        expect(hoisted.fitView).not.toHaveBeenCalled()
        expect(hoisted.setViewport).toHaveBeenCalled()
        const [viewport] = hoisted.setViewport.mock.calls[0]
        // The stub layout makes the lane 900 wide → (375 - 16) / 900.
        expect(viewport.zoom).toBeCloseTo(359 / 900, 5)
        graph.unmount()
    })

    it('a future not_before shows "held until" instead of plain pending', async () => {
        const graph = await mountGraph([
            task('held', 'pending', { notBefore: '2099-01-01T00:00:00.000Z', dependsOn: [] }),
            task('next', 'pending', { dependsOn: ['held'] }),
        ])
        const card = graph.container.querySelector('[data-node-id="task:held"] [data-testid="bp-graph-task"]')!
        expect(card.getAttribute('data-tone')).toBe('pending')
        expect(card.textContent).toContain('held')
        expect(card.querySelector('[data-testid="bp-graph-held-until"]')?.textContent).toMatch(/^until .*2099/)
        const plain = graph.container.querySelector('[data-node-id="task:next"] [data-testid="bp-graph-task"]')!
        expect(plain.textContent).toContain('pending')
        expect(plain.querySelector('[data-testid="bp-graph-held-until"]')).toBeNull()
        graph.unmount()
    })

    it('Active only hides finished lanes; turning it off shows them collapsed', async () => {
        const graph = await mountGraph([
            task('live', 'pending', { missionId: 'LIVE' }),
            task('old', 'completed', { missionId: 'DONE' }),
        ])
        expect(graph.container.querySelectorAll('[data-testid="bp-graph-lane"]')).toHaveLength(1)
        expect(graph.container.textContent).toContain('1 finished lane hidden')
        await click([...graph.container.querySelectorAll('button')].find(button => button.textContent?.includes('Active only'))!)
        expect(graph.container.querySelectorAll('[data-testid="bp-graph-lane"]')).toHaveLength(2)
        expect(graph.container.querySelector('[data-node-id="task:old"]')).toBeNull()
        graph.unmount()
    })
})
