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
    expect(dialogSource).not.toContain('mockMeshGraph')
    expect(dialogSource).not.toContain('mockNodes')
  })

  it('keeps the dialog responsive on the shared mobile/desktop observability path', () => {
    const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
    const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')

    expect(dialogSource).toContain('overflow-y-auto bg-[linear-gradient')
    expect(surfaceSource).toContain('Tap a node to inspect workspace, session, and git details.')
    expect(surfaceSource).toContain('max-h-[24vh] overflow-y-auto')
    expect(surfaceSource).toContain('max-h-[22vh] overflow-y-auto')
  })

  it('keeps node drill-down panels on the same dark contrast system as the observability shell', () => {
    const panelSource = readSource('components/MeshGraph/MeshGraphPanel.tsx')

    expect(panelSource).toContain('bg-white/[0.04]')
    expect(panelSource).toContain('text-slate-100')
    expect(panelSource).toContain('text-slate-200')
    expect(panelSource).not.toContain('bg-bg-panel')
    expect(panelSource).not.toContain('text-text-primary')
    expect(panelSource).not.toContain('text-text-secondary')
    expect(panelSource).not.toContain('text-text-muted')
  })

  it('keeps submodule details and queue/session drill-down on the shared graph surface', () => {
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')
    const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')
    const panelSource = readSource('components/MeshGraph/MeshGraphPanel.tsx')

    expect(modeSource).toContain('onOpenMeshGraph={onOpenMeshGraph}')
    expect(mainViewSource).toContain('setMeshGraphConversation(conversation)')
    expect(mainViewSource).toContain('activeConv={meshGraphConversation}')
    expect(surfaceSource).toContain('Queue rows and session rows are also selectable for drill-down.')
    expect(surfaceSource).toContain('selectedNodeStatus.git?.submodules')
    expect(panelSource).toContain('Field label="Submodule path" value={node.submodulePath ?? null}')
    expect(panelSource).toContain('Field label="Submodule commit" value={node.submoduleCommit ?? null}')
  })
})
