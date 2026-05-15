/**
 * Mesh Visualization — Transform RepoMeshStatus into a graph structure
 * for SVG/Canvas rendering without external dependencies.
 */

import type { RepoMeshStatus, RepoMeshNodeStatus, RepoMeshNodeHealth } from '@adhdev/daemon-core';
import type { GitRepoStatus } from '@adhdev/daemon-core';

// ─── Graph Types ─────────────────────────────────

export type MeshGraphNodeType = 'defaultBranchNode' | 'worktreeNode' | 'orphanNode';
export type MeshGraphEdgeType = 'parentBranch' | 'worktreeLink' | 'sessionLink';

export interface MeshGraphNode {
  id: string;
  type: MeshGraphNodeType;
  label: string;
  workspace: string;
  branch: string | null;
  health: RepoMeshNodeHealth;
  ahead: number;
  behind: number;
  dirty: boolean;
  dirtyFiles: number;
  hasConflicts: boolean;
  activeSessionCount: number;
  activeSessions: string[];
  providers: string[];
  isOrphan: boolean;
  orphanReasons: string[];
  /** Next-step hint from convergence analysis */
  nextStepHint?: string;
  /** Original node status for drill-down */
  source: RepoMeshNodeStatus;
}

export interface MeshGraphEdge {
  id: string;
  source: string;
  target: string;
  type: MeshGraphEdgeType;
  label?: string;
}

export interface MeshGraph {
  meshId: string;
  meshName: string;
  repoIdentity: string;
  refreshedAt: string;
  nodes: MeshGraphNode[];
  edges: MeshGraphEdge[];
  /** Summary statistics */
  stats: {
    totalNodes: number;
    onlineNodes: number;
    dirtyNodes: number;
    orphanNodes: number;
    errorNodes: number;
    offlineNodes: number;
    totalActiveSessions: number;
  };
  /** Global orphan / stale warnings */
  warnings: string[];
}

// ─── Helpers ─────────────────────────────────────

function isDirty(git?: GitRepoStatus): boolean {
  if (!git) return false;
  return (git.staged + git.modified + git.untracked + git.deleted + git.renamed) > 0;
}

function dirtyFileCount(git?: GitRepoStatus): number {
  if (!git) return 0;
  return git.staged + git.modified + git.untracked + git.deleted + git.renamed;
}

function detectOrphanReasons(node: RepoMeshNodeStatus, defaultBranch?: string | null): string[] {
  const reasons: string[] = [];
  const git = node.git;

  if (!git) {
    reasons.push('No git status available');
    return reasons;
  }

  if (!git.isGitRepo) {
    reasons.push('Not a git repository');
    return reasons;
  }

  // Detached HEAD
  if (git.branch === null && git.headCommit) {
    reasons.push('Detached HEAD');
  }

  // No upstream tracking
  if (git.branch && !git.upstream) {
    // Local-only branch — orphan if not default
    if (defaultBranch && git.branch !== defaultBranch) {
      reasons.push(`No upstream: ${git.branch}`);
    }
  }

  // Worktree branch with no upstream
  if (git.branch && git.upstream === null && defaultBranch && git.branch !== defaultBranch) {
    if (!reasons.includes(`No upstream: ${git.branch}`)) {
      reasons.push(`No upstream: ${git.branch}`);
    }
  }

  // Stale assigned tasks would be detected at queue level, not per node git status
  // We surface node-level errors as orphan indicators
  if (node.error) {
    reasons.push(`Error: ${node.error}`);
  }

  return reasons;
}

function nodeHealthPriority(health: RepoMeshNodeHealth): number {
  switch (health) {
    case 'online': return 0;
    case 'dirty': return 1;
    case 'degraded': return 2;
    case 'wrong_branch': return 3;
    case 'offline': return 4;
    case 'unknown': return 5;
    default: return 5;
  }
}

function pickDominantHealth(healths: RepoMeshNodeHealth[]): RepoMeshNodeHealth {
  if (healths.length === 0) return 'unknown';
  return healths.reduce((best, h) =>
    nodeHealthPriority(h) > nodeHealthPriority(best) ? h : best
  );
}

// ─── Graph Builder ─────────────────────────────────

/**
 * Build a visualization graph from RepoMeshStatus.
 *
 * Nodes:
 *   - defaultBranchNode: the mesh's default branch (aggregated from nodes on that branch)
 *   - worktreeNode: a node on a feature / worktree branch
 *   - orphanNode: a node with orphanReasons (upstream missing, detached HEAD, etc.)
 *
 * Edges:
 *   - parentBranch: default branch → worktree branch (when branch name differs)
 *   - worktreeLink: links nodes that share the same branch (clustering hint)
 *   - sessionLink: node → session (lightweight, optional; not rendered as primary edge)
 */
export function buildMeshGraph(status: RepoMeshStatus): MeshGraph {
  const nodes: MeshGraphNode[] = [];
  const edges: MeshGraphEdge[] = [];
  const warnings: string[] = [];

  // Track branch → nodes for edge creation
  const branchToNodeIds = new Map<string, string[]>();

  for (const nodeStatus of status.nodes) {
    const git = nodeStatus.git;
    const branch = git?.branch || null;
    const orphanReasons = detectOrphanReasons(nodeStatus, null);
    const dirty = isDirty(git);
    const dfc = dirtyFileCount(git);

    // Determine node type
    let type: MeshGraphNodeType = 'worktreeNode';
    if (orphanReasons.length > 0) {
      type = 'orphanNode';
    }

    const graphNode: MeshGraphNode = {
      id: nodeStatus.nodeId,
      type,
      label: nodeStatus.machineLabel || nodeStatus.nodeId.slice(0, 8),
      workspace: nodeStatus.workspace,
      branch,
      health: nodeStatus.health,
      ahead: git?.ahead ?? 0,
      behind: git?.behind ?? 0,
      dirty,
      dirtyFiles: dfc,
      hasConflicts: git?.hasConflicts ?? false,
      activeSessionCount: nodeStatus.activeSessions?.length ?? 0,
      activeSessions: nodeStatus.activeSessions ?? [],
      providers: nodeStatus.providers ?? [],
      isOrphan: orphanReasons.length > 0,
      orphanReasons,
      source: nodeStatus,
    };

    nodes.push(graphNode);

    if (branch) {
      const list = branchToNodeIds.get(branch) ?? [];
      list.push(graphNode.id);
      branchToNodeIds.set(branch, list);
    }
  }

  // Create synthetic default branch node if we can infer one
  // Heuristic: most common branch among nodes with upstream
  const branchUpstreamCounts = new Map<string, number>();
  for (const n of status.nodes) {
    const b = n.git?.branch;
    const upstream = n.git?.upstream;
    if (b && upstream) {
      branchUpstreamCounts.set(b, (branchUpstreamCounts.get(b) ?? 0) + 1);
    }
  }
  let inferredDefaultBranch: string | null = null;
  let bestCount = 0;
  for (const [b, count] of branchUpstreamCounts) {
    if (count > bestCount) {
      bestCount = count;
      inferredDefaultBranch = b;
    }
  }

  // If we have a clear default branch, create a synthetic node for it
  const defaultBranchNodeId = inferredDefaultBranch
    ? `__branch_${inferredDefaultBranch}`
    : null;

  if (defaultBranchNodeId && inferredDefaultBranch) {
    const branchNodes = branchToNodeIds.get(inferredDefaultBranch) ?? [];
    const branchHealths = branchNodes.map(id =>
      nodes.find(n => n.id === id)!.health
    );

    const defaultNode: MeshGraphNode = {
      id: defaultBranchNodeId,
      type: 'defaultBranchNode',
      label: inferredDefaultBranch,
      workspace: '',
      branch: inferredDefaultBranch,
      health: pickDominantHealth(branchHealths),
      ahead: 0,
      behind: 0,
      dirty: false,
      dirtyFiles: 0,
      hasConflicts: false,
      activeSessionCount: 0,
      activeSessions: [],
      providers: [],
      isOrphan: false,
      orphanReasons: [],
      nextStepHint: branchNodes.length > 0 ? `${branchNodes.length} node(s) on default branch` : undefined,
      source: {
        nodeId: defaultBranchNodeId,
        machineLabel: inferredDefaultBranch,
        workspace: '',
        health: 'online',
        providers: [],
        activeSessions: [],
      },
    };
    nodes.push(defaultNode);

    // Edge: default branch → each worktree branch that is NOT the default
    const seenBranches = new Set<string>();
    for (const n of nodes) {
      if (n.type === 'defaultBranchNode') continue;
      if (!n.branch) continue;
      if (n.branch === inferredDefaultBranch) {
        // Link worktree nodes on default branch directly to default branch node
        edges.push({
          id: `${defaultBranchNodeId}--${n.id}`,
          source: defaultBranchNodeId,
          target: n.id,
          type: 'parentBranch',
          label: 'default',
        });
        continue;
      }
      if (seenBranches.has(n.branch)) continue;
      seenBranches.add(n.branch);
      edges.push({
        id: `${defaultBranchNodeId}--branch_${n.branch}`,
        source: defaultBranchNodeId,
        target: n.branch,
        type: 'parentBranch',
        label: n.branch,
      });
    }
  }

  // worktreeLink edges: connect nodes sharing the same branch
  for (const [branch, ids] of branchToNodeIds) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      edges.push({
        id: `wt_${ids[0]}--${ids[i]}`,
        source: ids[0],
        target: ids[i],
        type: 'worktreeLink',
        label: branch,
      });
    }
  }

  // Collect warnings
  const orphanCount = nodes.filter(n => n.isOrphan).length;
  if (orphanCount > 0) {
    warnings.push(`${orphanCount} orphan node(s) detected`);
  }
  const conflictCount = nodes.filter(n => n.hasConflicts).length;
  if (conflictCount > 0) {
    warnings.push(`${conflictCount} node(s) with merge conflicts`);
  }
  const offlineCount = nodes.filter(n => n.health === 'offline').length;
  if (offlineCount > 0) {
    warnings.push(`${offlineCount} node(s) offline`);
  }

  // Stats
  const stats = {
    totalNodes: status.nodes.length,
    onlineNodes: status.nodes.filter(n => n.health === 'online').length,
    dirtyNodes: nodes.filter(n => n.dirty).length,
    orphanNodes: orphanCount,
    errorNodes: status.nodes.filter(n => !!n.error).length,
    offlineNodes: offlineCount,
    totalActiveSessions: status.nodes.reduce((sum, n) => sum + (n.activeSessions?.length ?? 0), 0),
  };

  return {
    meshId: status.meshId,
    meshName: status.meshName,
    repoIdentity: status.repoIdentity,
    refreshedAt: status.refreshedAt,
    nodes,
    edges,
    stats,
    warnings,
  };
}
