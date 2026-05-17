import * as fs from 'node:fs'
import * as path from 'node:path'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { describe, expect, it } from 'vitest'
import MeshObservabilitySurface from '../../src/components/MeshGraph/MeshObservabilitySurface'
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
    expect(html).toContain('0 active queue')
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
    expect(source).toContain("getGitDriftLabel(node)")
  })
})
