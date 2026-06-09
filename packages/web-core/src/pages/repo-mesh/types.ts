import type { MeshCoordinatorMetadata } from '../../utils/mesh-coordinator-setup'

export interface AvailableCliAgent {
    id: string
    name: string
    meshCoordinator?: MeshCoordinatorMetadata
}

export interface MeshNode {
    id: string
    workspace: string
    repoRoot?: string
    providerPriority?: string[]
    policy?: {
        providerPriority?: string[]
        readOnly?: boolean
    }
    isLocalWorktree?: boolean
    worktreeBranch?: string
    clonedFromNodeId?: string
    [key: string]: any
}

export interface MeshEntry {
    id: string
    name: string
    repoIdentity: string
    repoRemoteUrl?: string
    defaultBranch?: string
    policy?: Record<string, any>
    nodes: MeshNode[]
    createdAt: string
    updatedAt: string
    [key: string]: any
}

export interface MeshQueueEntry {
    id: string
    meshId?: string
    message: string
    status: 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled' | string
    targetNodeId?: string
    targetSessionId?: string
    assignedNodeId?: string
    assignedSessionId?: string
    nodeId?: string
    sessionId?: string
    updatedAt?: string
    staleAssigned?: boolean
    staleReason?: string
}

export interface MeshQueueSummary {
    active: number
    historical: number
    activeCounts: { pending: number; assigned: number }
    historicalCounts: { completed: number; failed: number }
    counts: { pending: number; assigned: number; completed: number; failed: number }
    staleAssignedCount: number
    recent: MeshQueueEntry[]
}

export type ProviderPriorityDrafts = Record<string, string[]>

export type RepoMeshSessionCleanupMode = 'preserve' | 'stop' | 'delete_stopped' | 'stop_and_delete'

export const SESSION_CLEANUP_MODE_OPTIONS: Array<{ value: RepoMeshSessionCleanupMode; label: string; description: string }> = [
    { value: 'preserve', label: 'Preserve history and runtimes', description: 'Keep completed chat history and leave live runtimes alone.' },
    { value: 'stop', label: 'Stop live runtimes only', description: 'Release running session processes, but keep chat records/transcripts.' },
    { value: 'delete_stopped', label: 'Delete stopped sessions only', description: 'Clean completed/stopped chat clutter without killing live runtimes.' },
    { value: 'stop_and_delete', label: 'Stop and delete sessions', description: 'Stop matching runtimes, then remove their session records/transcripts.' },
]

export const DEFAULT_MESH_POLICY: Record<string, any> = {
    requirePreTaskCheckpoint: false,
    requirePostTaskCheckpoint: true,
    requireApprovalForPush: true,
    allowAutoPublishSubmoduleMainCommits: false,
    requireApprovalForDestructiveGit: true,
    dirtyWorkspaceBehavior: 'warn',
    maxParallelTasks: 2,
    sessionCleanupOnNodeRemove: 'preserve',
}

export function readMeshPolicy(mesh: MeshEntry | null): Record<string, any> {
    return { ...DEFAULT_MESH_POLICY, ...(mesh?.policy || {}) }
}

// Feature flags shape used by MeshListView
export interface MeshListViewFeatures {
    createDaemonPicker: boolean
}

// Feature flags shape used by MeshNodeList
export interface MeshNodeListFeatures {
    addNodeDaemonPicker: boolean
    nodeInstruction: boolean
}

// Feature flags shape used by MeshDetailView
export interface MeshDetailViewFeatures {
    coordinatorPrompt: boolean
    meshHostDaemonSection: boolean
    queueSection: boolean
    hermesMcpConfig: boolean
    addNodeDaemonPicker: boolean
    nodeInstruction: boolean
}
