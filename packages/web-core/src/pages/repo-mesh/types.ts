import type { MeshCoordinatorMetadata } from '../../utils/mesh-coordinator-setup'

export interface AvailableCliAgent {
    id: string
    name: string
    meshCoordinator?: MeshCoordinatorMetadata
}

/** Per-(node, provider) parallelism declaration. Mirrors RepoMeshProviderRole. */
export interface MeshProviderRole {
    providerType: string
    maxParallel?: number
}

export interface MeshNode {
    id: string
    workspace: string
    repoRoot?: string
    providerPriority?: string[]
    policy?: {
        providerPriority?: string[]
        readOnly?: boolean
        /** Soft scheduling priority (higher = preferred) for distribution strategies. */
        schedulingPriority?: number
        /** Per-(node, provider) role + maxParallel declarations. */
        providerRoles?: MeshProviderRole[]
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
    /** M1: ids of tasks this task waits on. */
    dependsOn?: string[]
    /** M1: unmet dependency ids computed at view time. */
    waitingOn?: string[]
    /** M1: system hold reason, e.g. "dependency_failed:<taskId>". */
    blockedReason?: string
    missionId?: string
    /** M7: when the task was dispatched (assigned) — used for duration display. */
    dispatchTimestamp?: string
    requeueCount?: number
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

/** Mesh-wide tie-break strategy for distributing untargeted queue work. Mirrors
 *  RepoMeshSchedulingStrategy in daemon-core. 'first_eligible' is the strict
 *  no-change default. */
export type MeshSchedulingStrategy = 'first_eligible' | 'least_loaded' | 'round_robin' | 'priority_only'

export const SCHEDULING_STRATEGY_OPTIONS: Array<{ value: MeshSchedulingStrategy; label: string; description: string }> = [
    { value: 'first_eligible', label: 'First available (default)', description: 'Send work to the first eligible node in order. No load-spreading — preserves the original behavior.' },
    { value: 'least_loaded', label: 'Spread evenly (least-loaded)', description: 'Prefer the eligible node with the fewest active tasks so work spreads instead of piling on one node.' },
    { value: 'round_robin', label: 'Round-robin', description: 'Among the least-loaded nodes, rotate the winner each pass for fair distribution.' },
    { value: 'priority_only', label: 'Priority order', description: "Always send to the highest-priority eligible node (see each node's scheduling priority), ignoring load." },
]

export const DEFAULT_MESH_POLICY: Record<string, any> = {
    requirePreTaskCheckpoint: false,
    requirePostTaskCheckpoint: true,
    requireApprovalForPush: true,
    allowAutoPublishSubmoduleMainCommits: false,
    requireApprovalForDestructiveGit: true,
    dirtyWorkspaceBehavior: 'warn',
    maxParallelTasks: 2,
    schedulingStrategy: 'first_eligible',
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
    reviewInbox: boolean
}
