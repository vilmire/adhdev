import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DaemonMetadataUpdate } from '@adhdev/daemon-core'
import { getDashboardMeshMetadataSignature } from '../../src/components/dashboard/DashboardMeshGraphDialog'

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
    expect(dialogSource).toContain('useTransport()')
    expect(dialogSource).toContain('subscriptionManager.subscribe(')
    expect(dialogSource).toContain("topic: 'daemon.metadata'")
    expect(dialogSource).toContain('getDashboardMeshMetadataSignature(update, meshId)')
    expect(dialogSource).toContain('scheduleEventDrivenRefresh()')
    expect(dialogSource).toContain('unsubscribe()')
    expect(dialogSource).toContain('meshOverrides?.loadMeshStatus')
    expect(dialogSource).toContain("sendDaemonCommand(daemonId, 'mesh_status', { meshId, refresh })")
    expect(dialogSource).toContain('meshOverrides.loadMeshStatus(daemonId, meshId, {')
    expect(dialogSource).toContain('retryProfile: refresh ? \'settled\' : \'interactive\'')
    expect(dialogSource).not.toContain('buildMeshGraph')
    expect(dialogSource).toContain('setLoading(showInitialLoader)')
    expect(dialogSource).toContain('dashboardMeshGraphStatusCache')
    expect(dialogSource).toContain('dashboardMeshGraphStatusCache.get(cacheKey)')
    expect(dialogSource).toContain('dashboardMeshGraphStatusCache.set(cacheKey, status)')
    expect(dialogSource).toContain('loadGraph(false)')
    expect(dialogSource).toContain('MESH_GRAPH_BACKGROUND_REFRESH_MS')
    expect(dialogSource).toContain('loadGraph(true, { background: true })')
    expect(dialogSource).toContain('Live events + 4s fallback')
    expect(dialogSource).not.toContain('if (!refresh && meshOverrides?.loadMeshStatus)')
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

  it('invalidates only for metadata changes on sessions that belong to the active mesh', () => {
    const baseUpdate = {
      topic: 'daemon.metadata',
      key: 'daemon:metadata:daemon-1',
      daemonId: 'daemon-1',
      seq: 1,
      timestamp: 1000,
      status: {
        instanceId: 'daemon-1',
        machine: { id: 'machine-1', hostname: 'host', platform: 'darwin', arch: 'arm64' },
        timestamp: 1000,
        sessions: [
          {
            id: 'coordinator',
            providerType: 'codex',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'Coordinator',
            parentId: null,
            activeChat: { status: 'idle' },
            settings: { meshCoordinatorFor: 'mesh_a' },
            coordinator: { meshId: 'mesh_a', role: 'coordinator' },
            meshQueueStats: { pending: 0, assigned: 1, completed: 0, failed: 0 },
          },
          {
            id: 'worker',
            providerType: 'codex',
            kind: 'agent',
            transport: 'pty',
            status: 'generating',
            title: 'Worker',
            parentId: null,
            activeChat: { status: 'generating' },
            settings: { meshNodeFor: 'mesh_a', meshNodeId: 'node-1' },
          },
          {
            id: 'unrelated',
            providerType: 'codex',
            kind: 'agent',
            transport: 'pty',
            status: 'generating',
            title: 'Unrelated',
            parentId: null,
            activeChat: { status: 'generating' },
            settings: { meshNodeFor: 'mesh_b', meshNodeId: 'node-9' },
          },
        ],
      },
    } as DaemonMetadataUpdate

    const initial = getDashboardMeshMetadataSignature(baseUpdate, 'mesh_a')
    const unrelatedChanged = getDashboardMeshMetadataSignature({
      ...baseUpdate,
      status: {
        ...baseUpdate.status,
        sessions: baseUpdate.status.sessions.map((session: any) => session.id === 'unrelated'
          ? { ...session, status: 'idle', activeChat: { status: 'idle' } }
          : session),
      },
    } as DaemonMetadataUpdate, 'mesh_a')
    const workerCompleted = getDashboardMeshMetadataSignature({
      ...baseUpdate,
      status: {
        ...baseUpdate.status,
        sessions: baseUpdate.status.sessions.map((session: any) => session.id === 'worker'
          ? { ...session, status: 'idle', activeChat: { status: 'idle' } }
          : session),
      },
    } as DaemonMetadataUpdate, 'mesh_a')
    const queueChanged = getDashboardMeshMetadataSignature({
      ...baseUpdate,
      status: {
        ...baseUpdate.status,
        sessions: baseUpdate.status.sessions.map((session: any) => session.id === 'coordinator'
          ? { ...session, meshQueueStats: { pending: 0, assigned: 0, completed: 1, failed: 0 } }
          : session),
      },
    } as DaemonMetadataUpdate, 'mesh_a')

    expect(initial).toBeTruthy()
    expect(unrelatedChanged).toEqual(initial)
    expect(workerCompleted).not.toEqual(initial)
    expect(queueChanged).not.toEqual(initial)
    expect(getDashboardMeshMetadataSignature(baseUpdate, 'mesh_missing')).toBeNull()
  })

    it('keeps the dialog responsive on the shared mobile/desktop observability path', () => {
        const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
        const surfaceSource = readSource('components/MeshGraph/MeshObservabilitySurface.tsx')
        const graphViewSource = readSource('components/MeshGraph/MeshGraphView.tsx')

        expect(dialogSource).toContain('meshTheme.dialogBodyClass')
        expect(surfaceSource).toContain('Click a node only when you want drill-down details. The graph itself now carries the convergence state.')
        expect(graphViewSource).toContain('drag or scroll to pan')
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
