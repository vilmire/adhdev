/**
 * MeshGraph types — shared between view, panel, and consumers.
 */

export interface MeshGraphNode {
  id: string
  type: 'defaultBranchNode' | 'worktreeNode' | 'orphanNode'
  label: string
  workspace: string
  branch: string | null
  health: string
  ahead: number
  behind: number
  dirty: boolean
  dirtyFiles: number
  hasConflicts: boolean
  activeSessionCount: number
  activeSessions: string[]
  providers: string[]
  isOrphan: boolean
  orphanReasons: string[]
  nextStepHint?: string
}

export interface MeshGraphEdge {
  id: string
  source: string
  target: string
  type: 'parentBranch' | 'worktreeLink' | 'sessionLink'
  label?: string
}

export interface MeshGraphData {
  meshId: string
  meshName: string
  repoIdentity: string
  refreshedAt: string
  nodes: MeshGraphNode[]
  edges: MeshGraphEdge[]
  stats: {
    totalNodes: number
    onlineNodes: number
    dirtyNodes: number
    orphanNodes: number
    errorNodes: number
    offlineNodes: number
    totalActiveSessions: number
  }
  warnings: string[]
}
