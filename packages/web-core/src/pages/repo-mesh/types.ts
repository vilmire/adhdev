import type { MeshCoordinatorMetadata } from '../../utils/mesh-coordinator-setup'
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared'

export type { NodeCapabilitySlot }

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
        /** Soft scheduling priority (higher = preferred) for distribution strategies. */
        schedulingPriority?: number
        /** Node capability slots (ORCHESTRATION_NODE_SLOTS.md) — the ordered
         *  "Preferred AI tools" profile (provider/model/thinking/difficulty/capability/maxParallel). */
        slots?: NodeCapabilitySlot[]
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

export type RepoMeshSessionCleanupMode = 'preserve' | 'stop' | 'delete_stopped' | 'stop_and_delete'

export const SESSION_CLEANUP_MODE_OPTIONS: Array<{ value: RepoMeshSessionCleanupMode; label: string; description: string }> = [
    { value: 'preserve', label: 'Preserve history and runtimes', description: 'Keep completed chat history and leave live runtimes alone.' },
    { value: 'stop', label: 'Stop live runtimes only', description: 'Release running session processes, but keep chat records/transcripts.' },
    { value: 'delete_stopped', label: 'Delete stopped sessions only', description: 'Clean completed/stopped chat clutter without killing live runtimes.' },
    { value: 'stop_and_delete', label: 'Stop and delete sessions', description: 'Stop matching runtimes, then remove their session records/transcripts.' },
]

/** Mesh-wide tie-break strategy for distributing untargeted queue work. Mirrors
 *  RepoMeshSchedulingStrategy in daemon-core. 'first_eligible' is the strict
 *  no-change default. 'least_loaded'/'round_robin' are deprecated aliases the
 *  daemon normalizes to 'fitness'; 'priority_only' is an escape-hatch-only value
 *  the UI never writes. */
export type MeshSchedulingStrategy = 'first_eligible' | 'least_loaded' | 'round_robin' | 'priority_only' | 'fitness'

/**
 * User-facing distribution mode — the 2-mode façade over the raw strategy union.
 * The toggle writes the mapped raw strategy (distributionToStrategy) into the
 * policy; reading maps the raw strategy back (strategyToDistribution).
 */
export type MeshDistribution = 'smart' | 'in_order'

export const DISTRIBUTION_OPTIONS: Array<{ value: MeshDistribution; labelKey: string; descriptionKey: string }> = [
    { value: 'smart', labelKey: 'repoMesh.detail.distributionSmart', descriptionKey: 'repoMesh.detail.distributionSmartDescription' },
    { value: 'in_order', labelKey: 'repoMesh.detail.distributionInOrder', descriptionKey: 'repoMesh.detail.distributionInOrderDescription' },
]

/** Map a distribution mode to the raw scheduling strategy persisted in policy. */
export function distributionToStrategy(distribution: MeshDistribution): MeshSchedulingStrategy {
    return distribution === 'smart' ? 'fitness' : 'first_eligible'
}

/**
 * Map a raw scheduling strategy back to the 2-mode façade for the toggle. The
 * deprecated least_loaded/round_robin aliases show as 'smart' (the daemon
 * normalizes them to fitness). priority_only shows as 'smart' only when a node
 * priority is actually configured (it is otherwise behaviorally identical to
 * first_eligible).
 */
export function strategyToDistribution(
    strategy: MeshSchedulingStrategy | string | undefined,
    opts?: { priorityConfigured?: boolean },
): MeshDistribution {
    const s = (strategy || 'first_eligible') as MeshSchedulingStrategy
    if (s === 'fitness' || s === 'least_loaded' || s === 'round_robin') return 'smart'
    if (s === 'priority_only') return opts?.priorityConfigured ? 'smart' : 'in_order'
    return 'in_order'
}

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

// Mirror of daemon-core repo-mesh-types MESH_MAX_PARALLEL_TASKS_MIN/MAX. The
// daemon clamps to this range in resolveMaxParallelTasks; the UI clamps to the
// same bounds so the input can never propose a value the daemon would silently
// clamp away. Keep in sync with repo-mesh-types.ts.
export const MESH_MAX_PARALLEL_TASKS_MIN = 1
export const MESH_MAX_PARALLEL_TASKS_MAX = 64

export function readMeshPolicy(mesh: MeshEntry | null): Record<string, any> {
    return { ...DEFAULT_MESH_POLICY, ...(mesh?.policy || {}) }
}

// Feature flags shape used by MeshListView
export interface MeshListViewFeatures {
    createDaemonPicker: boolean
    /** When set, cap mesh creation at this count and show an upgrade nudge. */
    maxMeshes?: number
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
    hermesMcpConfig: boolean
    addNodeDaemonPicker: boolean
    nodeInstruction: boolean
}
