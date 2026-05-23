import { describe, expect, it } from 'vitest'
import type { MeshGraphData, MeshGraphNode } from '../../src/components/MeshGraph/types'
import {
  formatMeshGraphAheadBehind,
  getMeshGraphAttentionBadge,
  getMeshGraphViewportFocusNodeIds,
  shouldShowMeshGraphCallout,
} from '../../src/components/MeshGraph/meshGraphViewModel'

function graphNode(overrides: Partial<MeshGraphNode>): MeshGraphNode {
  return {
    id: overrides.id || 'node-1',
    type: overrides.type || 'worktreeNode',
    label: overrides.label || 'Node 1',
    workspace: overrides.workspace || '/repo',
    branch: overrides.branch ?? 'main',
    upstream: overrides.upstream ?? 'origin/main',
    upstreamStatus: overrides.upstreamStatus ?? 'fresh',
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
    snapshotCompleteness: overrides.snapshotCompleteness ?? 'complete',
    snapshotWarnings: overrides.snapshotWarnings ?? [],
    branchConvergence: overrides.branchConvergence ?? null,
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
      followUpNodes: nodes.filter(node => node.type !== 'submoduleNode' && node.branchConvergence?.needsConvergence).length,
      blockedReviewNodes: nodes.filter(node => node.branchConvergence?.status === 'blocked_review').length,
      mergeReadyNodes: nodes.filter(node => node.branchConvergence?.status === 'pushed_feature_branch_needs_merge').length,
      cleanupCandidateNodes: nodes.filter(node => node.branchConvergence?.status === 'cleanup_candidate').length,
      notMergeableNodes: nodes.filter(node => node.branchConvergence?.status === 'not_mergeable').length,
      incompleteSnapshotNodes: nodes.filter(node => node.snapshotWarnings.length > 0).length,
      missingGitSnapshotNodes: nodes.filter(node => node.snapshotCompleteness === 'missing_git').length,
      missingSubmoduleSnapshotNodes: nodes.filter(node => node.snapshotCompleteness === 'missing_submodule_report').length,
      staleGitSnapshotNodes: nodes.filter(node => node.snapshotCompleteness === 'stale').length,
      totalActiveSessions: nodes.reduce((sum, node) => sum + node.activeSessionCount, 0),
    },
    warnings: [],
    snapshotWarnings: [],
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
      upstream: null,
      upstreamStatus: null,
      nextStepHint: 'oss is in sync with the parent checkout',
      submodulePath: 'oss',
      machineLabel: 'M1',
    }))).toBe(false)

    expect(shouldShowMeshGraphCallout(graphNode({
      id: 'sub-bad',
      type: 'submoduleNode',
      branch: null,
      upstream: null,
      upstreamStatus: null,
      outOfSync: true,
      health: 'degraded',
      nextStepHint: 'oss is out of sync with the parent checkout',
      submodulePath: 'oss',
      machineLabel: 'M1',
    }))).toBe(true)
  })

  it('turns behind/ahead drift and blocked convergence into graph-visible attention badges', () => {
    const node = graphNode({
      id: 'node-behind',
      branch: 'main',
      ahead: 0,
      behind: 3,
      branchConvergence: {
        status: 'blocked_review',
        needsConvergence: true,
        reason: 'default_branch_not_even_with_upstream',
        nextStep: 'Bring main even with origin/main before declaring convergence complete.',
        branch: 'main',
        defaultBranch: 'main',
        upstream: 'origin/main',
        upstreamStatus: 'fresh',
        ahead: 0,
        behind: 3,
        dirty: false,
        hasConflicts: false,
      },
    })

    expect(formatMeshGraphAheadBehind(node)).toBe('behind 3')
    expect(getMeshGraphAttentionBadge(node)).toEqual({ label: 'behind 3', tone: 'danger' })
    expect(shouldShowMeshGraphCallout(node)).toBe(true)
  })

})
