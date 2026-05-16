import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('mesh graph view interaction boundaries', () => {
    it('keeps node dragging disabled while allowing viewport drag panning and preserving click-to-inspect behavior', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('nodesDraggable={false}')
        expect(source).toContain('panOnDrag')
        expect(source).toContain('panOnScroll={false}')
        expect(source).toContain('zoomOnScroll={false}')
        expect(source).toContain('zoomOnPinch={false}')
        expect(source).toContain('zoomOnDoubleClick={false}')
        expect(source).toContain('selectionOnDrag={false}')
        expect(source).toContain('onNodeClick={(_, node) => onNodeClick?.(node.data.graphNode)}')
    })

    it('renders submodule links as dedicated graph edges instead of leaving submodule status hidden in node data only', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain("edge.type === 'worktreeLink' || edge.type === 'submoduleLink' ? 'smoothstep' : 'bezier'")
        expect(source).toContain("case 'submoduleLink':")
        expect(source).toContain("return '#c084fc'")
    })
})
