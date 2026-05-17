import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('mesh graph view interaction boundaries', () => {
    it('keeps node dragging disabled while allowing drag/scroll panning and explicit viewport focus control', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('nodesDraggable={false}')
        expect(source).toContain('panOnDrag')
        expect(source).toContain('panOnScroll')
        expect(source).toContain('zoomOnScroll={false}')
        expect(source).toContain('zoomOnPinch={false}')
        expect(source).toContain('zoomOnDoubleClick={false}')
        expect(source).toContain('selectionOnDrag={false}')
        expect(source).toContain('useNodesInitialized()')
        expect(source).toContain('useReactFlow<FlowNode, FlowEdge>()')
        expect(source).toContain('void reactFlow.fitView({')
        expect(source).toContain('onNodeClick={(_, node) => onNodeClick?.(node.data.graphNode)}')
    })

    it('renders submodule links as dedicated graph edges instead of leaving submodule status hidden in node data only', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain("edge.type === 'worktreeLink' || edge.type === 'submoduleLink' ? 'smoothstep' : 'bezier'")
        expect(source).toContain("case 'submoduleLink':")
        expect(source).toContain("return '#c084fc'")
    })

    it('keeps graph node cards on the observability dark surface instead of mixing in page-theme text/background tokens', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('bg-slate-950/78')
        expect(source).toContain('text-slate-100')
        expect(source).toContain('text-slate-200')
        expect(source).toContain('bg-slate-950/60')
        expect(source).not.toContain('bg-bg-panel')
        expect(source).not.toContain('text-text-primary')
        expect(source).not.toContain('text-text-secondary')
        expect(source).not.toContain('text-text-muted')
    })
})
