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

    it('shows upstream unverified instead of a misleading +0 / -0 drift label when remote-tracking refs were not refreshed', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain("return isUpstreamVerified(node) ? `+${node.ahead} / -${node.behind}` : 'upstream unverified'")
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
