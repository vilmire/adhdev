import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('mesh graph view interaction boundaries', () => {
    it('keeps node dragging disabled while allowing drag/scroll panning, pinch zoom, and explicit viewport focus control', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('nodesDraggable={false}')
        expect(source).toContain('panOnDrag')
        expect(source).toContain('panOnScroll')
        expect(source).toContain('zoomOnScroll={false}')
        expect(source).toContain('zoomOnPinch')
        expect(source).toContain('zoomOnDoubleClick={false}')
        expect(source).toContain('selectionOnDrag={false}')
        expect(source).toContain('useNodesInitialized()')
        expect(source).toContain('useReactFlow<FlowNode, FlowEdge>()')
        expect(source).toContain('void reactFlow.fitView({')
        expect(source).toContain('onNodeClick={(_, node) => onNodeClick?.(node.data.graphNode)}')
    })

    it('uses React Flow controls for zoom, fit, and the graph minimap without custom viewport guards', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')
        const viewportSource = readSource('utils/mesh-graph-viewport.ts')
        const themeSource = readSource('components/MeshGraph/meshGraphTheme.ts')

        expect(source).toContain('Controls,')
        expect(source).toContain('position="bottom-left" showZoom showFitView showInteractive={false}')
        expect(source).toContain('MiniMap,')
        expect(source).toContain('<MiniMap')
        expect(source).toContain('nodeColor={minimapNodeColor}')
        expect(source).toContain('nodeClassName={minimapNodeClassName}')
        expect(source).toContain('mesh-minimap-node--${graphNode.type}')
        expect(source).not.toContain('shouldShowMeshGraphMiniMap')
        expect(viewportSource).not.toContain('shouldShowMeshGraphMiniMap')
        expect(themeSource).not.toContain('graphMiniMapClass')
    })

    it('keeps an explicit responsive viewport height so React Flow cannot collapse to 0px on narrow screens', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('meshTheme.graphShellClass')
        // Dynamic height class based on node count — base case 460px min, grows for dense graphs
        expect(source).toContain('h-[460px] min-h-[460px] sm:h-[560px] xl:h-[680px]')
        expect(source).toContain('className="h-full w-full"')
    })

    it('renders submodule links as dedicated graph edges instead of leaving submodule status hidden in node data only', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('edgeTypes={edgeTypes}')
        expect(source).toContain('meshEdge: MeshGraphEdgeLine')
        expect(source).toContain("graphEdge.type === 'worktreeLink' || graphEdge.type === 'submoduleLink'")
        expect(source).toContain('<BaseEdge')
        expect(source).toContain('<EdgeLabelRenderer>')
        expect(source).toContain("case 'submoduleLink':")
        expect(source).toContain("return '#c084fc'")
    })

    it('surfaces non-converged drift inside node cards instead of falling back to a quiet +0 / -0 style summary', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')
        const viewModelSource = readSource('components/MeshGraph/meshGraphViewModel.ts')

        expect(source).toContain('getMeshGraphAttentionBadge(node)')
        expect(viewModelSource).toContain('formatMeshGraphAheadBehind(node)')
        expect(source).toContain("needs follow-up")
    })

    it('keeps graph node cards on the shared mesh-theme helper instead of hardcoding page-theme tokens', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('getMeshGraphTheme(theme)')
        expect(source).toContain('meshTheme.graphShellClass')
        expect(source).toContain('meshTheme.graphStatChipClass')
        expect(source).toContain('colorMode={meshTheme.flowColorMode}')
        expect(source).not.toContain('bg-bg-panel')
        expect(source).not.toContain('text-text-primary')
        expect(source).not.toContain('text-text-secondary')
        expect(source).not.toContain('text-text-muted')
    })

    it('activates compact mode when node count exceeds the dense-graph threshold', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('COMPACT_NODE_THRESHOLD')
        expect(source).toContain('data.nodes.length >= COMPACT_NODE_THRESHOLD')
        expect(source).toContain('MeshGraphCompactContext')
        expect(source).toContain('MeshGraphCompactContext.Provider value={compact}')
    })

    it('distinguishes active-session nodes and stale/offline nodes visually at the card level', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('isNodeActive(node)')
        expect(source).toContain('isNodeStale(node)')
        expect(source).toContain('animate-pulse')
        expect(source).toContain('opacity-60')
    })

    it('renders all node session rows instead of slicing extra workers behind a summary', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('const visibleSessions = node.sessionDetails')
        expect(source).toContain('const visibleCardSessions = node.sessionDetails')
        expect(source).toContain('overflow-y-auto')
        expect(source).not.toContain('node.sessionDetails.slice(0, 3)')
        expect(source).not.toContain('node.sessionDetails.slice(0, compact ? 1 : 2)')
        expect(source).not.toContain('more attached chat(s)')
    })

    it('scales viewport height for dense graphs with 10+ and 16+ nodes', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('getGraphHeightClass(data.nodes.length)')
        expect(source).toContain('h-[580px]')
        expect(source).toContain('h-[720px]')
    })

    it('bounds long card and edge label text so rendered labels cannot escape the measured node geometry', () => {
        const source = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(source).toContain('MESH_GRAPH_EDGE_LABEL.maxWidth')
        expect(source).toContain('title={labelTitle}')
        expect(source).toContain('<span className="block truncate">{args.label}</span>')
        expect(source).toContain('title={node.branch}')
        expect(source).toContain('style={summaryTextStyle}')
        expect(source).toContain('style={calloutTextStyle}')
        expect(source).toContain("overflowWrap: 'anywhere'")
        expect(source).toContain('WebkitLineClamp: 3')
        expect(source).toContain('WebkitLineClamp: 4')
    })
})
