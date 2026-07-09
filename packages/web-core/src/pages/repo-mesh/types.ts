import type { MeshCoordinatorMetadata } from '../../utils/mesh-coordinator-setup'
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared'

export type { NodeCapabilitySlot }

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

/**
 * @deprecated The raw 4-union is retained as an escape hatch (a hand-edited
 * meshes.json / .adhdev/mesh.json may still write any of the four and it is honored),
 * but the UI no longer exposes it — see DISTRIBUTION_OPTIONS for the 2-mode façade.
 */
export const SCHEDULING_STRATEGY_OPTIONS: Array<{ value: MeshSchedulingStrategy; label: string; description: string }> = [
    { value: 'first_eligible', label: 'First available (default)', description: 'Send work to the first eligible node in order. No load-spreading — preserves the original behavior.' },
    { value: 'least_loaded', label: 'Spread evenly (least-loaded)', description: 'Prefer the eligible node with the fewest active tasks so work spreads instead of piling on one node.' },
    { value: 'round_robin', label: 'Round-robin', description: 'Among the least-loaded nodes, rotate the winner each pass for fair distribution.' },
    { value: 'priority_only', label: 'Priority order', description: "Always send to the highest-priority eligible node (see each node's scheduling priority), ignoring load." },
]

/**
 * User-facing distribution mode — the 2-mode façade over the raw 4-union. Mirrors
 * RepoMeshDistribution in daemon-core. The toggle writes the mapped raw strategy
 * (distributionToStrategy) into the policy; reading maps the raw strategy back
 * (strategyToDistribution).
 */
export type MeshDistribution = 'spread' | 'in_order'

export const DISTRIBUTION_OPTIONS: Array<{ value: MeshDistribution; label: string; description: string }> = [
    { value: 'spread', label: 'Spread', description: 'Distribute work evenly across eligible nodes (prefers the least-loaded, rotating ties fairly). Set a per-node priority below to bias the order.' },
    { value: 'in_order', label: 'In order', description: 'Assign to nodes in the order they were added — the first eligible node takes the work. No load-spreading.' },
]

/** Map a distribution mode to the raw scheduling strategy persisted in policy. */
export function distributionToStrategy(distribution: MeshDistribution): MeshSchedulingStrategy {
    return distribution === 'spread' ? 'least_loaded' : 'first_eligible'
}

/**
 * Map a raw scheduling strategy back to the 2-mode façade for the toggle. priority_only
 * shows as 'spread' only when a node priority is actually configured (it is otherwise
 * behaviorally identical to first_eligible). Mirrors daemon-core strategyToDistribution.
 */
export function strategyToDistribution(
    strategy: MeshSchedulingStrategy | string | undefined,
    opts?: { priorityConfigured?: boolean },
): MeshDistribution {
    const s = (strategy || 'first_eligible') as MeshSchedulingStrategy
    if (s === 'first_eligible') return 'in_order'
    if (s === 'priority_only') return opts?.priorityConfigured ? 'spread' : 'in_order'
    if (s === 'least_loaded' || s === 'round_robin') return 'spread'
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
