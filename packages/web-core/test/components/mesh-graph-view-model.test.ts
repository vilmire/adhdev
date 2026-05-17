import { describe, expect, it } from 'vitest'
import type { MeshGraphData, MeshGraphNode } from '../../src/components/MeshGraph/types'
import {
  getMeshGraphViewportFocusNodeIds,
  shouldShowMeshGraphCallout,
  shouldShowMeshGraphMiniMap,
} from '../../src/components/MeshGraph/meshGraphViewModel'

function graphNode(overrides: Partial<MeshGraphNode>): MeshGraphNode {
  return {
    id: overrides.id || 'node-1',
    type: overrides.type || 'worktreeNode',
    label: overrides.label || 'Node 1',
    workspace: overrides.workspace || '/repo',
    branch: overrides.branch ?? 'main',
    machineLabel: overrides.machineLabel ?? 'Mac Studio',
    health: overrides.health || 'online',
    ahead: overrides.ahead ?? 0,
    behind: overrides.behind ?? 0,
    dirty: overrides.dirty ?? false,
    dirtyFiles: overrides.dirtyFiles ?? 0,
    hasConflicts: overrides.hasConflicts ?? false,
    activeSessionCount: overrides.activeSessionCount ?? 0,
    activeSessions: overrides.activeSessions ?? [],
    providers: overrides.providers ?? [],
    isOrphan: overrides.isOrphan ?? false,
    orphanReasons: overrides.orphanReasons ?? [],
    nextStepHint: overrides.nextStepHint,
    error: overrides.error,
    parentNodeId: overrides.parentNodeId ?? null,
    submodulePath: overrides.submodulePath ?? null,
    submoduleCommit: overrides.submoduleCommit ?? null,
    outOfSync: overrides.outOfSync ?? false,
    source: overrides.source || {
      nodeId: overrides.id || 'node-1',
      machineLabel: overrides.machineLabel ?? 'Mac Studio',
      workspace: overrides.workspace || '/repo',
      health: overrides.health || 'online',
      providers: overrides.providers ?? [],
      activeSessions: overrides.activeSessions ?? [],
    },
  }
}

function graphData(nodes: MeshGraphNode[]): MeshGraphData {
  return {
    meshId: 'mesh-1',
    meshName: 'Mesh 1',
    repoIdentity: 'repo',
    refreshedAt: '2026-05-17T00:00:00.000Z',
    nodes,
    edges: [],
    stats: {
      totalNodes: nodes.length,
      onlineNodes: nodes.filter(node => node.health === 'online').length,
      dirtyNodes: nodes.filter(node => node.dirty).length,
      orphanNodes: nodes.filter(node => node.isOrphan).length,
      errorNodes: nodes.filter(node => node.health === 'degraded').length,
      offlineNodes: nodes.filter(node => node.health === 'offline').length,
      totalActiveSessions: nodes.reduce((sum, node) => sum + node.activeSessionCount, 0),
    },
    warnings: [],
  }
}

describe('meshGraphViewModel', () => {
  it('focuses the initial viewport on the default branch path instead of submodule sprawl', () => {
    const data = graphData([
      graphNode({ id: '__branch_main', type: 'defaultBranchNode', label: 'main', machineLabel: 'default branch' }),
      graphNode({ id: 'node-main-a', label: 'M1', branch: 'main' }),
      graphNode({ id: 'node-main-b', label: 'M2', branch: 'main' }),
      graphNode({ id: 'node-feature', label: 'Feat', branch: 'feat/mesh-ui' }),
      graphNode({
        id: 'node-main-a::submodule::oss',
        type: 'submoduleNode',
        label: 'oss',
        branch: null,
        parentNodeId: 'node-main-a',
        submodulePath: 'oss',
        machineLabel: 'M1',
      }),
    ])

    expect(getMeshGraphViewportFocusNodeIds(data)).toEqual(['__branch_main', 'node-main-a', 'node-main-b'])
  })

  it('keeps healthy synced submodule hints out of graph cards while preserving actionable callouts', () => {
    expect(shouldShowMeshGraphCallout(graphNode({
      id: 'sub-ok',
      type: 'submoduleNode',
      branch: null,
      nextStepHint: 'oss is in sync with the parent checkout',
      submodulePath: 'oss',
      machineLabel: 'M1',
    }))).toBe(false)

    expect(shouldShowMeshGraphCallout(graphNode({
      id: 'sub-bad',
      type: 'submoduleNode',
      branch: null,
      outOfSync: true,
      health: 'degraded',
      nextStepHint: 'oss is out of sync with the parent checkout',
      submodulePath: 'oss',
      machineLabel: 'M1',
    }))).toBe(true)
  })

  it('only shows the minimap once the graph is large enough to need a secondary locator', () => {
    expect(shouldShowMeshGraphMiniMap(graphData(Array.from({ length: 6 }, (_, index) => graphNode({ id: `node-${index}` }))))).toBe(false)
    expect(shouldShowMeshGraphMiniMap(graphData(Array.from({ length: 7 }, (_, index) => graphNode({ id: `node-${index}` }))))).toBe(true)
  })
})
