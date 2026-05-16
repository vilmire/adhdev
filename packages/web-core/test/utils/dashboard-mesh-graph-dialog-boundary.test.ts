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

    expect(dialogSource).toContain("sendDaemonCommand(daemonId, 'mesh_status', { meshId })")
    expect(dialogSource).toContain('buildMeshGraph(status)')
    expect(dialogSource).not.toContain('mockMeshGraph')
    expect(dialogSource).not.toContain('mockNodes')
  })

  it('keeps the dialog responsive on mobile by collapsing the detail pane into a bounded sheet', () => {
    const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
    const panelSource = readSource('components/MeshGraph/MeshGraphPanel.tsx')

    expect(dialogSource).toContain('Tap a node to inspect workspace, session, and git details.')
    expect(dialogSource).toContain('max-h-[38vh] overflow-y-auto')
    expect(dialogSource).toContain('className="hidden w-full shrink-0 border-t border-white/10 px-4 py-4 md:block')
    expect(panelSource).toContain('w-full max-w-full rounded-xl border border-border-subtle bg-bg-panel p-4 flex flex-col gap-2 shadow-lg md:w-64')
  })

  it('keeps submodule details on the shared mobile/desktop dialog path instead of forking a separate mobile graph payload', () => {
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')
    const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
    const panelSource = readSource('components/MeshGraph/MeshGraphPanel.tsx')

    expect(modeSource).toContain('onOpenMeshGraph={onOpenMeshGraph}')
    expect(mainViewSource).toContain('setMeshGraphConversation(conversation)')
    expect(mainViewSource).toContain('activeConv={meshGraphConversation}')
    expect(dialogSource).toContain("sendDaemonCommand(daemonId, 'mesh_status', { meshId })")
    expect(dialogSource).toContain('const nextGraph = buildMeshGraph(status)')
    expect(panelSource).toContain('Field label="Submodule path" value={node.submodulePath ?? null}')
    expect(panelSource).toContain('Field label="Submodule commit" value={node.submoduleCommit ?? null}')
  })
})
