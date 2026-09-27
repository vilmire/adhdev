// @vitest-environment jsdom
//
// The mesh graph dialog (MeshObservabilitySurface → @xyflow/react + elkjs) used
// to be imported statically by DashboardMainView / MeshDetailView, which put
// ~1.5 MB of graph code on the eager critical path of every cloud route
// (/terms and /login included). It now sits behind LazyDashboardMeshGraphDialog:
// the heavy module is fetched the first time a dialog actually renders.
import fs from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const heavy = vi.hoisted(() => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    return { factoryCalls: 0, gate, release: () => release() }
})

vi.mock('../../../src/components/dashboard/DashboardMeshGraphDialog', async () => {
    heavy.factoryCalls += 1
    await heavy.gate
    return {
        default: ({ activeConv, onClose }: { activeConv: { tabKey: string }; onClose: () => void }) => (
            <div data-testid="real-mesh-graph-dialog" data-tab={activeConv.tabKey}>
                <button type="button" onClick={onClose}>close</button>
            </div>
        ),
    }
})

const src = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, '../../../src', rel), 'utf8')

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

describe('LazyDashboardMeshGraphDialog', () => {
    it('does not load the heavy dialog module until it renders, shows a fallback, then the real dialog', async () => {
        const { default: LazyDashboardMeshGraphDialog } = await import('../../../src/components/dashboard/LazyDashboardMeshGraphDialog')
        // Importing the lazy wrapper must not pull the graph stack.
        expect(heavy.factoryCalls).toBe(0)

        const onClose = vi.fn()
        await act(async () => {
            root.render(
                <LazyDashboardMeshGraphDialog
                    activeConv={{ tabKey: 'coord-tab' } as never}
                    sendDaemonCommand={vi.fn() as never}
                    onClose={onClose}
                />,
            )
        })

        expect(heavy.factoryCalls).toBe(1)
        // Chunk still in flight: the Suspense fallback is up, the real dialog is not.
        expect(document.querySelector('[data-testid="mesh-graph-dialog-loading"]')).not.toBeNull()
        expect(document.querySelector('[data-testid="real-mesh-graph-dialog"]')).toBeNull()

        await act(async () => {
            heavy.release()
            await heavy.gate
            await new Promise(resolve => setTimeout(resolve, 0))
        })

        const real = document.querySelector('[data-testid="real-mesh-graph-dialog"]')
        expect(real).not.toBeNull()
        expect(real?.getAttribute('data-tab')).toBe('coord-tab')
        expect(document.querySelector('[data-testid="mesh-graph-dialog-loading"]')).toBeNull()
        act(() => { (real?.querySelector('button') as HTMLButtonElement).click() })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it("elkjs's bundled engine still lays out when loaded through a dynamic import with no Worker available", async () => {
        // The graph chunk is now fetched via import(); elk.bundled.js must keep
        // using its in-thread FakeWorker (no workerUrl) rather than new Worker().
        expect(typeof (globalThis as { Worker?: unknown }).Worker).toBe('undefined')
        const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
        const layout = await new ELK().layout({
            id: 'root',
            layoutOptions: { 'elk.algorithm': 'layered' },
            children: [{ id: 'a', width: 40, height: 20 }, { id: 'b', width: 40, height: 20 }],
            edges: [{ id: 'ab', sources: ['a'], targets: ['b'] }],
        })
        expect(layout.children?.map(child => child.id)).toEqual(['a', 'b'])
        expect(layout.children?.every(child => typeof child.x === 'number' && typeof child.y === 'number')).toBe(true)
    })
})

describe('mesh graph stays off the eager import graph', () => {
    it('both mount sites import the lazy wrapper, never the heavy dialog module', () => {
        for (const file of ['components/dashboard/DashboardMainView.tsx', 'pages/repo-mesh/MeshDetailView.tsx']) {
            const source = src(file)
            expect(source).toMatch(/import DashboardMeshGraphDialog from '[./]*(components\/dashboard\/)?LazyDashboardMeshGraphDialog'/)
            expect(source).not.toMatch(/from '[./]*(components\/dashboard\/)?DashboardMeshGraphDialog'/)
        }
    })

    it('the web-core barrel does not re-export values from the MeshGraph index (xyflow + elkjs)', () => {
        const barrel = src('index.ts')
        const valueExportsFromMeshGraphIndex = barrel
            .split('\n')
            .filter(line => /^export \{/.test(line) && /from '\.\/components\/MeshGraph'$/.test(line.trim()))
        expect(valueExportsFromMeshGraphIndex).toEqual([])
        expect(barrel).not.toMatch(/export \{[^}]*\bMeshGraphView\b[^}]*\} from/)
        expect(barrel).not.toMatch(/export \{[^}]*\bMeshObservabilitySurface\b[^}]*\} from/)
    })

    it('@xyflow CSS ships with the graph modules, not the global stylesheet', () => {
        expect(src('index.css')).not.toContain('@xyflow/react/dist/style.css')
        const graphCss = src('components/MeshGraph/meshGraph.css')
        const importAt = graphCss.indexOf('@import "@xyflow/react/dist/style.css";')
        expect(importAt).toBeGreaterThanOrEqual(0)
        // The reduced-motion override must come AFTER the xyflow rule it overrides.
        expect(graphCss.indexOf('.react-flow__edge.animated path')).toBeGreaterThan(importAt)
        for (const file of ['MeshGraphView.tsx', 'MeshMiniDag.tsx', 'MeshBlueprintGraph.tsx']) {
            expect(src(`components/MeshGraph/${file}`)).toContain("import './meshGraph.css'")
        }
    })
})
