import * as fs from 'node:fs'
import * as path from 'node:path'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/MeshGraph/MeshGraphView', () => ({
  default: () => null,
}))

import MeshObservabilitySurface, { describeProviders, resolveGitLogRequest, resolveSelectedGraphNodeForDetail, summarizeNodeDrift, summarizeSelectedHead } from '../../src/components/MeshGraph/MeshObservabilitySurface'
import { MESH_GRAPH_LAYOUT, buildMeshGraphLayout, estimateMeshGraphNodeHeight, getMeshGraphNodeCardWidth } from '../../src/components/MeshGraph/meshGraphLayout'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'
import { canonicalizeRepoMeshStatus } from '../../src/utils/repo-mesh-status'

function renderSurface(status: any): string {
  return renderToString(
    React.createElement(
      StaticRouter,
      { location: '/' },
      React.createElement(MeshObservabilitySurface, { status: status as any }),
    ),
  )
}

describe('MeshObservabilitySurface', () => {
  it('renders even when preview/cloud mesh_status payload omits queue and ledger summaries', () => {
    const status = {
      meshId: 'mesh_preview',
      meshName: 'Preview Mesh',
      repoIdentity: 'repo',
      refreshedAt: '2026-05-17T00:00:00.000Z',
      nodes: [],
      queue: { tasks: [] },
      ledger: { entries: [] },
    }

    expect(() => renderSurface(status)).not.toThrow()
    const html = renderSurface(status)
    expect(html).toContain('mesh converged')
    expect(html).toContain('0 recent failures')
  })

  it('keeps mobile graph status badges as an in-graph floating overlay instead of a layout-blocking header', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/MeshGraph/MeshObservabilitySurface.tsx'),
      'utf8',
    )

    expect(source).toContain('relative min-h-0 flex-1 rounded-[28px]')
    expect(source).toContain('absolute inset-x-4 top-4 z-30')
    expect(source).toContain('max-h-[42dvh]')
    expect(source).toContain('overflow-y-auto')
    expect(source).toContain('sm:static sm:mb-3')
    expect(source).toContain('sm:overflow-visible')
  })

  it('renders upstream unverified when a node only has stale remote-tracking refs', () => {
    const status = {
      meshId: 'mesh_freshness',
      meshName: 'Freshness Mesh',
      repoIdentity: 'repo',
      refreshedAt: '2026-05-17T00:00:00.000Z',
      nodes: [
        {
          nodeId: 'node-main',
          machineLabel: 'Coordinator',
          workspace: '/repo/main',
          health: 'online',
          providers: ['hermes-cli'],
          activeSessions: [],
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'stale',
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            conflictFiles: [],
            stashCount: 0,
          },
        },
      ],
      queue: { tasks: [] },
      ledger: { entries: [] },
    }

    const graph = buildMeshGraph(status as any)
    expect(graph.nodes.some(node => node.upstreamStatus === 'stale')).toBe(true)

    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/MeshGraph/MeshGraphView.tsx'),
      'utf8',
    )
    expect(source).toContain("upstream unverified")
    expect(source).toContain("getMeshGraphCalloutText(node)")
    expect(source).toContain("needs follow-up")
  })

  it('replaces a silent converged headline with explicit peer snapshot warnings when peer git visibility is incomplete', () => {
    const status = {
      meshId: 'mesh_incomplete_peer_snapshot',
      meshName: 'Incomplete Peer Snapshot Mesh',
      repoIdentity: 'repo',
      refreshedAt: '2026-05-17T00:00:00.000Z',
      nodes: [
        {
          nodeId: 'node-main',
          machineLabel: 'M4',
          workspace: '/repo/main',
          health: 'online',
          machineStatus: 'online',
          providers: ['hermes-cli'],
          activeSessions: [],
          connection: { state: 'self', reported: true, source: 'reported' },
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            lastCheckedAt: Date.parse('2026-05-17T00:00:00.000Z'),
            submodules: [
              {
                path: 'oss',
                commit: '1234567',
                repoPath: '/repo/main/oss',
                dirty: false,
                outOfSync: false,
                lastCheckedAt: Date.parse('2026-05-17T00:00:00.000Z'),
              },
            ],
          },
        },
        {
          nodeId: 'node-peer',
          machineLabel: 'M1',
          workspace: '/repo/m1',
          health: 'online',
          machineStatus: 'online',
          providers: ['claude-cli'],
          activeSessions: [],
          connection: { state: 'connected', transport: 'relay', reported: true, source: 'reported' },
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            lastCheckedAt: Date.parse('2026-05-16T23:59:30.000Z'),
            submodules: [],
          },
        },
      ],
      queue: { tasks: [] },
      ledger: { entries: [] },
    }

    const html = renderSurface(status)
    expect(html).toContain('mesh visibility incomplete')
    expect(html).toContain('1 incomplete peer snapshot')
    expect(html).toContain('1 missing submodule visibility')
    expect(html).toContain('1 node(s) are missing peer submodule visibility reported elsewhere in the mesh')
    expect(html).not.toContain('mesh converged')
  })

  it('renders bootstrap inventory fallback graph nodes with direct-truth warnings', () => {
    const status = {
      meshId: 'mesh_fallback',
      meshName: 'Fallback Mesh',
      repoIdentity: 'repo',
      defaultBranch: 'main',
      refreshedAt: '2026-05-17T00:00:00.000Z',
      sourceOfTruth: {
        currentStatus: 'bootstrap_inventory_fallback',
        directPeerTruth: { required: true, satisfied: false },
        fallback: {
          source: 'server_bootstrap_inventory',
          warning: 'Selected coordinator could not confirm direct mesh truth yet. Showing setup inventory graph until direct mesh_status probes succeed.',
        },
      },
      nodes: [
        {
          nodeId: 'node-bootstrap',
          machineLabel: 'Bootstrap Host',
          workspace: '/repo/bootstrap',
          health: 'unknown',
          machineStatus: 'online',
          providers: [],
          activeSessions: [],
          connection: { state: 'unknown', transport: 'unknown', source: 'server_bootstrap_inventory', reported: false },
        },
      ],
      queue: { tasks: [] },
      ledger: { entries: [] },
    }

    const graph = buildMeshGraph(status as any)
    expect(graph.nodes.find(node => node.id === 'node-bootstrap')).toMatchObject({
      label: 'Bootstrap Host',
      snapshotCompleteness: 'missing_git',
    })
    expect(graph.stats.totalNodes).toBe(1)
    expect(graph.warnings).toContain('Selected coordinator could not confirm direct mesh truth yet. Showing setup inventory graph until direct mesh_status probes succeed.')

    const html = renderSurface(status)
    expect(html).toContain('mesh visibility incomplete')
    expect(html).toContain('1 no git snapshot')
    expect(html).toContain('Selected coordinator could not confirm direct mesh truth yet. Showing setup inventory graph until direct mesh_status probes succeed.')
  })

  it('uses live git evidence in detail helpers even when mesh_peer_status still marks gitProbePending', () => {
    const node: any = {
      nodeId: 'node_303',
      machineLabel: 'node_303',
      workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      health: 'online',
      providers: [],
      providerPriority: ['hermes-cli', 'antigravity-cli'],
      activeSessions: [],
      launchReady: true,
      gitProbePending: true,
      connection: {
        state: 'connected',
        transport: 'direct',
        reported: true,
        source: 'mesh_peer_status',
      },
      git: {
        isGitRepo: true,
        workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
        repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
        branch: 'main',
        upstream: 'origin/main',
        upstreamStatus: 'fresh',
        headCommit: '083fe011',
        ahead: 0,
        behind: 1,
        staged: 0,
        modified: 0,
        untracked: 0,
        deleted: 0,
        renamed: 0,
        hasConflicts: false,
      },
    }

    expect(summarizeNodeDrift(node)).toBe('main · ↑0/↓1')
    expect(summarizeNodeDrift(node)).not.toBe('Git probe pending')
    expect(summarizeSelectedHead(node, [])).toBe('083fe01')
    expect(summarizeSelectedHead(node, [])).not.toBe('Pending live git probe')
    expect(describeProviders(node)).toBe('installed providers not reported; priority hermes-cli, antigravity-cli')
  })

  it('keeps selected detail on the same canonical graph node used for rendering', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/MeshGraph/MeshObservabilitySurface.tsx'),
      'utf8',
    )
    expect(source).toContain('const canonicalGraph = useMemo(() => buildMeshGraph(canonicalStatus), [canonicalStatus])')
    expect(source).toContain('const selectedGraphNode = resolveSelectedGraphNodeForDetail(canonicalGraph, selectedNodeId)')
    expect(source).toContain('role="dialog"')
    expect(source).toContain('onClick={closeGraphDetail}')
    expect(source).not.toContain('resolveLatestGraphNodeForDetail')
    expect(source).not.toContain('false && hasDetailPane')

    const graph = buildMeshGraph({
      meshId: 'mesh_same_source',
      meshName: 'Same Source Mesh',
      repoIdentity: 'repo',
      defaultBranch: 'main',
      refreshedAt: '2026-05-22T00:00:00.000Z',
      nodes: [
        {
          nodeId: 'node_same',
          machineLabel: 'node_same',
          workspace: '/remote/repo',
          health: 'unknown',
          providers: [],
          activeSessions: [],
          gitProbePending: true,
        },
      ],
      queue: { tasks: [] },
      ledger: { entries: [] },
    } as any)

    const renderedGraphNode = graph.nodes.find(node => node.id === 'node_same')!
    const resolved = resolveSelectedGraphNodeForDetail(graph as any, 'node_same')

    expect(resolved).toBe(renderedGraphNode)
    expect(resolved).toMatchObject({
      branch: null,
      snapshotCompleteness: 'pending_git',
    })
  })

  it('canonicalizes duplicate stale and live rows to one live node before graph/detail render', () => {
    const status: any = {
      meshId: 'mesh_duplicate',
      meshName: 'Duplicate Mesh',
      repoIdentity: 'repo',
      defaultBranch: 'main',
      refreshedAt: '2026-05-22T00:00:00.000Z',
      nodes: [
        {
          nodeId: 'node_same',
          machineLabel: 'node_same',
          workspace: '/repo',
          health: 'unknown',
          providers: [],
          activeSessions: [],
          gitProbePending: true,
          connection: { state: 'unknown', source: 'not_reported' },
        },
        {
          nodeId: 'node_same',
          machineLabel: 'node_same',
          workspace: '/repo',
          health: 'online',
          providers: ['hermes-cli'],
          activeSessions: ['sess_1'],
          git: {
            isGitRepo: true,
            workspace: '/repo',
            repoRoot: '/repo',
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            headCommit: 'abcdef1234567890',
            ahead: 1,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            lastCheckedAt: Date.parse('2026-05-22T00:00:00.000Z'),
          },
          connection: { state: 'connected', transport: 'direct', source: 'mesh_status', reported: true },
        },
      ],
      queue: { tasks: [] },
      ledger: { entries: [] },
    }

    const canonical = canonicalizeRepoMeshStatus(status)
    const graph = buildMeshGraph(canonical as any)
    const detailNode = resolveSelectedGraphNodeForDetail(graph as any, 'node_same')

    expect(canonical.nodes).toHaveLength(1)
    expect(canonical.nodes[0].git?.branch).toBe('main')
    expect(canonical.nodes[0].gitProbePending).toBeUndefined()
    expect(graph.nodes.filter(node => node.id === 'node_same')).toHaveLength(1)
    expect(detailNode?.branch).toBe('main')
  })

  it('routes git_log to the selected node daemon and skips detached graph-only workspaces', () => {
    expect(resolveGitLogRequest({
      coordinatorDaemonId: 'daemon-coordinator',
      selectedNodeStatus: {
        nodeId: 'node-peer',
        machineLabel: 'Peer',
        workspace: '/remote/repo',
        daemonId: 'daemon-peer',
        health: 'online',
        providers: [],
        activeSessions: [],
      } as any,
      selectedSessionEntry: null,
      selectedGraphNode: {
        id: 'node-peer',
        workspace: '/remote/repo',
      } as any,
    })).toEqual({ daemonId: 'daemon-peer', workspace: '/remote/repo' })

    expect(resolveGitLogRequest({
      coordinatorDaemonId: 'daemon-coordinator',
      selectedNodeStatus: null,
      selectedSessionEntry: null,
      selectedGraphNode: {
        id: 'node_main::submodule::oss',
        workspace: '/remote/repo/oss',
      } as any,
    })).toBeNull()
  })

  it('keeps deterministic layout boxes separated for long labels and stacked submodules', () => {
    const graph = buildMeshGraph({
      meshId: 'mesh_spacing',
      meshName: 'Spacing Mesh',
      repoIdentity: 'repo-with-very-long-identity-for-layout-pressure',
      defaultBranch: 'main',
      refreshedAt: '2026-05-22T00:00:00.000Z',
      nodes: [
        {
          nodeId: 'node_coordinator',
          machineLabel: 'Coordinator with a long visible label',
          workspace: '/repo/main-with-a-long-workspace-label',
          health: 'online',
          providers: ['hermes-cli'],
          activeSessions: ['sess-1', 'sess-2'],
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            submodules: [
              { path: 'oss/packages/web-core-with-long-path', commit: '1234567890abcdef', repoPath: '/repo/main/oss', dirty: false, outOfSync: true },
              { path: 'vendor/extremely-long-submodule-name', commit: 'abcdef1234567890', repoPath: '/repo/main/vendor', dirty: true, outOfSync: false },
            ],
          },
        },
        {
          nodeId: 'node_peer',
          machineLabel: 'Peer node with long label',
          workspace: '/repo/peer',
          health: 'dirty',
          providers: ['claude-cli'],
          activeSessions: ['sess-peer'],
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            ahead: 1,
            behind: 1,
            staged: 0,
            modified: 2,
            untracked: 1,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            submodules: [
              { path: 'oss/packages/web-core-with-long-path', commit: '1234567890abcdef', repoPath: '/repo/peer/oss', dirty: false, outOfSync: false },
            ],
          },
        },
        {
          nodeId: 'node_feature',
          machineLabel: 'Feature worktree',
          workspace: '/repo/feature',
          health: 'online',
          providers: ['codex-cli'],
          activeSessions: [],
          git: {
            isGitRepo: true,
            branch: 'fix/mesh-graph-layout-spacing-with-long-branch-label',
            upstream: 'origin/fix/mesh-graph-layout-spacing-with-long-branch-label',
            upstreamStatus: 'fresh',
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
          },
        },
      ],
      queue: { tasks: [] },
      ledger: { entries: [] },
    } as any)

    const layout = buildMeshGraphLayout(graph as any)
    const boxes = new Map(layout.nodes.map(node => [node.id, {
      left: node.position.x,
      top: node.position.y,
      right: node.position.x + getMeshGraphNodeCardWidth(node.graphNode),
      bottom: node.position.y + estimateMeshGraphNodeHeight(node.graphNode),
    }]))
    const overlaps = (a: NonNullable<ReturnType<typeof boxes.get>>, b: NonNullable<ReturnType<typeof boxes.get>>) => (
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    )

    expect(layout.columnGap).toBeGreaterThanOrEqual(MESH_GRAPH_LAYOUT.columnGap)
    expect(layout.columnGap).toBeGreaterThan(500)

    const layoutNodes = [...boxes.entries()]
    for (let i = 0; i < layoutNodes.length; i += 1) {
      for (let j = i + 1; j < layoutNodes.length; j += 1) {
        expect(overlaps(layoutNodes[i][1], layoutNodes[j][1]), `${layoutNodes[i][0]} overlaps ${layoutNodes[j][0]}`).toBe(false)
      }
    }

    const parent = boxes.get('node_coordinator')!
    const parentChildren = [
      boxes.get('node_coordinator::submodule::oss/packages/web-core-with-long-path')!,
      boxes.get('node_coordinator::submodule::vendor/extremely-long-submodule-name')!,
    ].sort((a, b) => a.top - b.top)
    const child = parentChildren[0]
    const secondChild = parentChildren[1]
    const peer = boxes.get('node_peer')!

    expect(child.top - parent.bottom).toBeGreaterThanOrEqual(MESH_GRAPH_LAYOUT.parentToSubmoduleGap)
    expect(secondChild.top - child.bottom).toBeGreaterThanOrEqual(MESH_GRAPH_LAYOUT.submoduleStackGap)
    expect(peer.top - secondChild.bottom).toBeGreaterThanOrEqual(MESH_GRAPH_LAYOUT.worktreeStackGap)
  })

})
