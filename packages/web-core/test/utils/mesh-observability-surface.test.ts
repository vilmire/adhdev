import * as fs from 'node:fs'
import * as path from 'node:path'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/MeshGraph/MeshGraphView', () => ({
  default: () => null,
}))

import MeshObservabilitySurface, { describeProviders, resolveGitLogRequest, resolveLatestGraphNodeForDetail, summarizeNodeDrift, summarizeSelectedHead } from '../../src/components/MeshGraph/MeshObservabilitySurface'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'

function renderSurface(status: any): string {
  const graph = buildMeshGraph(status)
  return renderToString(
    React.createElement(
      StaticRouter,
      { location: '/' },
      React.createElement(MeshObservabilitySurface, { graph: graph as any, status: status as any }),
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

  it('hydrates selected detail graph fields from latest node status when stale graph warnings remain', () => {
    const graphNode: any = {
      id: 'node_303',
      type: 'machine',
      label: 'node_303',
      workspace: '/remote/repo',
      branch: null,
      upstream: null,
      upstreamStatus: null,
      machineLabel: 'node_303',
      health: 'unknown',
      ahead: 0,
      behind: 0,
      dirtyFiles: 0,
      activeSessions: 0,
      providers: [],
      snapshotCompleteness: 'pending_git',
      snapshotWarnings: ['waiting for a live peer git snapshot'],
      branchConvergence: null,
      source: 'mesh_status',
    }
    const statusNode: any = {
      nodeId: 'node_303',
      machineLabel: 'node_303',
      workspace: '/remote/repo',
      health: 'online',
      providers: [],
      activeSessions: [],
      git: {
        isGitRepo: true,
        workspace: '/remote/repo',
        repoRoot: '/remote/repo',
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
      },
    }

    const resolved = resolveLatestGraphNodeForDetail(graphNode, statusNode)
    expect(resolved).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      health: 'online',
      snapshotCompleteness: 'complete',
      snapshotWarnings: [],
    })
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
})
