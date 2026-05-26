import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard mesh graph dialog wiring', () => {
  it('mounts the dedicated mesh graph dialog from DashboardMainView instead of leaving the graph inline', () => {
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')

    expect(mainViewSource).toContain('meshGraphConversation && (')
    expect(mainViewSource).toContain('<DashboardMeshGraphDialog')
    expect(mainViewSource).toContain('activeConv={meshGraphConversation}')
    expect(mainViewSource).toContain('sendDaemonCommand={sendDaemonCommand}')
    expect(mainViewSource).toContain('onClose={() => setMeshGraphConversation(null)}')
  })

  it('drives the dialog from cached aggregate mesh_status data and lets the surface derive the graph', () => {
    const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')

    expect(dialogSource).toContain('useDashboardMeshOverrides()')
    expect(dialogSource).toContain('meshOverrides?.loadMeshStatus')
    expect(dialogSource).toContain("sendDaemonCommand(daemonId, 'mesh_status', { meshId, refresh })")
    expect(dialogSource).toContain('meshOverrides.loadMeshStatus(daemonId, meshId, {')
    expect(dialogSource).toContain('retryProfile: refresh ? \'settled\' : \'interactive\'')
    expect(dialogSource).not.toContain('buildMeshGraph')
    expect(dialogSource).toContain('setLoading(!hasUsableGraphRef.current)')
    expect(dialogSource).toContain('loadGraph(false)')
    expect(dialogSource).toContain('void loadGraph(true)')
    expect(dialogSource).toContain('<MeshObservabilitySurface')
    expect(dialogSource).toContain('status={meshStatus}')
    expect(dialogSource).not.toContain('graph={')
    expect(dialogSource).toContain('daemonId={daemonId}')
    expect(dialogSource).toContain('sendDaemonCommand={sendDaemonCommand}')
    expect(dialogSource).not.toContain('hasPendingDashboardMeshRefresh')
    expect(dialogSource).not.toContain('nextDashboardMeshRefreshDelayMs')
    expect(dialogSource).not.toContain('pendingRefreshTimerRef')
    expect(dialogSource).not.toContain('mockMeshGraph')
    expect(dialogSource).not.toContain('mockNodes')
  })

    it('keeps the dialog responsive on the shared mobile/desktop observability path', () => {
        const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
        const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')
        const graphViewSource = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(dialogSource).toContain('meshTheme.dialogBodyClass')
        expect(surfaceSource).toContain('Click a node only when you want drill-down details. The graph itself now carries the convergence state.')
        expect(graphViewSource).toContain('Focused on the main path first · drag or scroll to pan')
        expect(surfaceSource).toContain('role="dialog"')
        expect(surfaceSource).toContain('onClick={closeGraphDetail}')
        expect(surfaceSource).toContain('absolute inset-x-3 bottom-3 top-20')
        expect(surfaceSource).not.toContain('max-h-[24vh] overflow-y-auto')
        expect(surfaceSource).not.toContain('max-h-[22vh] overflow-y-auto')
    })

  it('keeps node drill-down on live status rows instead of reusing the orphan graph panel copy', () => {
    const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')

    expect(surfaceSource).toContain('Key warning')
    expect(surfaceSource).toContain('Follow-up')
    expect(surfaceSource).not.toContain("import MeshGraphPanel from './MeshGraphPanel'")
    expect(surfaceSource).not.toContain('<MeshGraphPanel')
  })

  it('keeps node drill-down panels on the shared mesh-theme helper', () => {
    const panelSource = readSource('components/MeshGraph/MeshGraphPanel.tsx')

    expect(panelSource).toContain('getMeshGraphTheme(theme)')
    expect(panelSource).toContain('meshTheme.panelShellClass')
    expect(panelSource).toContain('meshTheme.panelFieldRowClass')
    expect(panelSource).toContain('Field label="HEAD" value={headSummary} rowClass={meshTheme.panelFieldRowClass}')
    expect(panelSource).not.toContain('bg-bg-panel')
    expect(panelSource).not.toContain('text-text-primary')
    expect(panelSource).not.toContain('text-text-secondary')
    expect(panelSource).not.toContain('text-text-muted')
  })

  it('adds direct session/chat affordances and on-demand git history to the observability detail flow', () => {
    const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')

    expect(surfaceSource).toContain("sendDaemonCommand(targetDaemonId, 'git_log', { workspace, limit: 5 })")
    expect(surfaceSource).toContain('<Row label="HEAD"')
    expect(surfaceSource).toContain('<Row label="Sessions"')
    expect(surfaceSource).toContain('Close')
    expect(surfaceSource).not.toContain('Open chat')
    expect(surfaceSource).not.toContain('View session')
    expect(surfaceSource).not.toContain('Recent commits')
  })

  it('keeps mobile and desktop entry points on the shared graph popup surface', () => {
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')
    const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')

    expect(modeSource).toContain('onOpenMeshGraph={onOpenMeshGraph}')
    expect(mainViewSource).toContain('setMeshGraphConversation(conversation)')
    expect(mainViewSource).toContain('activeConv={meshGraphConversation}')
    expect(surfaceSource).toContain('Selected node')
    expect(surfaceSource).toContain('resolveSelectedGraphNodeForDetail(canonicalGraph, selectedNodeId)')
    expect(surfaceSource).toContain('<Row label="Dirty/ahead/behind"')
    expect(surfaceSource).toContain('<Row label="Source"')
    expect(surfaceSource).toContain('<Row label="Transport"')
    expect(surfaceSource).not.toContain('<MeshGraphPanel')
  })
})
