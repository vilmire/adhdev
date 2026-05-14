import { describe, it, expect } from 'vitest'
import { buildMeshGraph } from '../../src/mesh/mesh-visualization.js'
import type { RepoMeshStatus } from '../../src/repo-mesh-types.js'

describe('buildMeshGraph', () => {
  const baseStatus: RepoMeshStatus = {
    meshId: 'mesh-1',
    meshName: 'test-mesh',
    repoIdentity: 'github.com/test/repo',
    refreshedAt: new Date().toISOString(),
    nodes: [
      {
        nodeId: 'node-main',
        machineLabel: 'main-machine',
        workspace: '/workspace/main',
        health: 'online',
        git: {
          isGitRepo: true,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          isDirty: false,
          staged: 0,
          modified: 0,
          untracked: 0,
          deleted: 0,
          renamed: 0,
          stashCount: 0,
          hasConflicts: false,
        } as any,
        activeSessions: [],
        providers: [],
      },
      {
        nodeId: 'node-feat',
        machineLabel: 'feat-machine',
        workspace: '/workspace/feat',
        health: 'dirty',
        git: {
          isGitRepo: true,
          branch: 'feat/auth',
          upstream: 'origin/feat/auth',
          ahead: 2,
          behind: 1,
          isDirty: true,
          staged: 1,
          modified: 1,
          untracked: 0,
          deleted: 0,
          renamed: 0,
          stashCount: 0,
          hasConflicts: false,
        } as any,
        activeSessions: ['sess-1'],
        providers: ['claude-cli'],
      },
      {
        nodeId: 'node-orphan',
        machineLabel: 'orphan-machine',
        workspace: '/workspace/orphan',
        health: 'degraded',
        git: {
          isGitRepo: true,
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          isDirty: false,
          staged: 0,
          modified: 0,
          untracked: 0,
          deleted: 0,
          renamed: 0,
          stashCount: 0,
          hasConflicts: false,
          error: 'detached HEAD',
        } as any,
        activeSessions: [],
        providers: [],
        error: 'detached HEAD',
      },
    ],
  }

  it('creates nodes for all mesh nodes', () => {
    const graph = buildMeshGraph(baseStatus)
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3)
    expect(graph.edges.length).toBeGreaterThanOrEqual(2)
  })

  it('marks worktree node with ahead/behind', () => {
    const graph = buildMeshGraph(baseStatus)
    const featNode = graph.nodes.find(n => n.id === 'node-feat')
    expect(featNode?.type).toBe('worktreeNode')
    expect(featNode?.ahead).toBe(2)
    expect(featNode?.behind).toBe(1)
    expect(featNode?.dirty).toBe(true)
    expect(featNode?.dirtyFiles).toBe(2)
    expect(featNode?.activeSessionCount).toBe(1)
  })

  it('detects orphan node (detached HEAD)', () => {
    const graph = buildMeshGraph(baseStatus)
    const orphanNode = graph.nodes.find(n => n.id === 'node-orphan')
    expect(orphanNode?.type).toBe('orphanNode')
    expect(orphanNode?.isOrphan).toBe(true)
    expect(orphanNode?.health).toBe('degraded')
  })

  it('creates parentBranch edges', () => {
    const graph = buildMeshGraph(baseStatus)
    const parentEdges = graph.edges.filter(e => e.type === 'parentBranch')
    expect(parentEdges.length).toBeGreaterThanOrEqual(1)
  })

  it('computes stats', () => {
    const graph = buildMeshGraph(baseStatus)
    expect(graph.stats.totalNodes).toBe(3)
    expect(graph.stats.orphanNodes).toBe(1)
    expect(graph.stats.totalActiveSessions).toBe(1)
    expect(graph.stats.dirtyNodes).toBe(1)
  })

  it('populates warnings for orphan nodes', () => {
    const graph = buildMeshGraph(baseStatus)
    expect(graph.warnings.length).toBeGreaterThanOrEqual(1)
    const orphanWarning = graph.warnings.find(w => w.includes('orphan'))
    expect(orphanWarning).toBeDefined()
  })
})
