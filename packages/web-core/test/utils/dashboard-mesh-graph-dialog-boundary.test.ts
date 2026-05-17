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

  it('drives the dialog from live mesh_status data and transforms it through buildMeshGraph', () => {
    const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')

    expect(dialogSource).toContain('useDashboardMeshOverrides()')
    expect(dialogSource).toContain('meshOverrides?.loadMeshStatus')
    expect(dialogSource).toContain("sendDaemonCommand(daemonId, 'mesh_status', { meshId })")
    expect(dialogSource).toContain('const nextGraph = buildMeshGraph(status)')
    expect(dialogSource).toContain('<MeshObservabilitySurface')
    expect(dialogSource).toContain('daemonId={daemonId}')
    expect(dialogSource).toContain('sendDaemonCommand={sendDaemonCommand}')
    expect(dialogSource).not.toContain('mockMeshGraph')
    expect(dialogSource).not.toContain('mockNodes')
  })

    it('keeps the dialog responsive on the shared mobile/desktop observability path', () => {
        const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
        const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')
        const graphViewSource = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(dialogSource).toContain('overflow-y-auto bg-[linear-gradient')
        expect(surfaceSource).toContain('Click a node only when you want drill-down details. The graph itself now carries the convergence state.')
        expect(graphViewSource).toContain('Focused on the main path first · drag or scroll to pan')
        expect(surfaceSource).toContain('max-h-[24vh] overflow-y-auto')
        expect(surfaceSource).toContain('max-h-[22vh] overflow-y-auto')
    })

  it('keeps node drill-down panels on the same dark contrast system as the observability shell', () => {
    const panelSource = readSource('components/MeshGraph/MeshGraphPanel.tsx')

    expect(panelSource).toContain('bg-white/[0.04]')
    expect(panelSource).toContain('text-slate-100')
    expect(panelSource).toContain('text-slate-200')
    expect(panelSource).toContain('Field label="HEAD" value={headSummary}')
    expect(panelSource).not.toContain('bg-bg-panel')
    expect(panelSource).not.toContain('text-text-primary')
    expect(panelSource).not.toContain('text-text-secondary')
    expect(panelSource).not.toContain('text-text-muted')
  })

  it('adds direct session/chat affordances and on-demand git history to the observability detail flow', () => {
    const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')

    expect(surfaceSource).toContain("sendDaemonCommand(daemonId, 'git_log', { workspace: selectedGitWorkspace, limit: 5 })")
    expect(surfaceSource).toContain('Open chat')
    expect(surfaceSource).toContain('View session')
    expect(surfaceSource).toContain('View node')
    expect(surfaceSource).toContain('Recent commits')
    expect(surfaceSource).toContain('Git context')
    expect(surfaceSource).toContain('Select the submodule node in the graph for its own HEAD and recent history.')
  })

  it('keeps submodule details and queue/session drill-down on the shared graph surface', () => {
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')
    const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')
    const panelSource = readSource('components/MeshGraph/MeshGraphPanel.tsx')

    expect(modeSource).toContain('onOpenMeshGraph={onOpenMeshGraph}')
    expect(mainViewSource).toContain('setMeshGraphConversation(conversation)')
    expect(mainViewSource).toContain('activeConv={meshGraphConversation}')
    expect(surfaceSource).toContain('Selected detail')
    expect(surfaceSource).toContain('selectedNodeStatus.git?.submodules')
    expect(panelSource).toContain('Field label="Submodule path" value={node.submodulePath ?? null}')
    expect(panelSource).toContain('Field label="Submodule commit" value={node.submoduleCommit ?? null}')
  })
})
