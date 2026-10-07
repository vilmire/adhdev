import type { MeshSessionCleanupMode, MeshTaskStatus, NodeCapabilitySlot } from '@adhdev/mesh-shared'

export type { NodeCapabilitySlot }

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
        /** Node capability slots (node capability slots design, 2026-07-09) — the ordered
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
    /** Stored policy OVERRIDES — only the keys the owner set (daemon sparse storage). */
    policy?: Record<string, any>
    /** What every policy key resolves to (daemon resolveMeshPolicy). Absent from older daemons. */
    effectivePolicy?: Record<string, any>
    nodes: MeshNode[]
    createdAt: string
    updatedAt: string
    [key: string]: any
}

export interface MeshQueueEntry {
    id: string
    meshId?: string
    message: string
    /** The ONE task-status vocabulary (mesh-shared MESH_TASK_STATUSES) — no `| string` escape hatch. */
    status: MeshTaskStatus
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

/** Derived from mesh-shared MESH_SESSION_CLEANUP_MODES (same list the daemon and the MCP schema use). */
export type RepoMeshSessionCleanupMode = MeshSessionCleanupMode

/** Labels/descriptions are i18n keys (mesh.sessionCleanup.*). */
export const SESSION_CLEANUP_MODE_OPTIONS: Array<{ value: RepoMeshSessionCleanupMode; labelKey: string; descriptionKey: string }> = [
    { value: 'preserve', labelKey: 'mesh.sessionCleanup.preserve', descriptionKey: 'mesh.sessionCleanup.preserveHint' },
    { value: 'stop', labelKey: 'mesh.sessionCleanup.stop', descriptionKey: 'mesh.sessionCleanup.stopHint' },
    { value: 'delete_stopped', labelKey: 'mesh.sessionCleanup.deleteStopped', descriptionKey: 'mesh.sessionCleanup.deleteStoppedHint' },
    { value: 'stop_and_delete', labelKey: 'mesh.sessionCleanup.stopAndDelete', descriptionKey: 'mesh.sessionCleanup.stopAndDeleteHint' },
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

/** `summaryKey` is the one visible line; `descriptionKey` is the full explanation (ⓘ). */
export const DISTRIBUTION_OPTIONS: Array<{ value: MeshDistribution; labelKey: string; summaryKey: string; descriptionKey: string }> = [
    { value: 'smart', labelKey: 'mesh.detail.distributionSmart', summaryKey: 'mesh.detail.distributionSmartSummary', descriptionKey: 'mesh.detail.distributionSmartDescription' },
    { value: 'in_order', labelKey: 'mesh.detail.distributionInOrder', summaryKey: 'mesh.detail.distributionInOrderSummary', descriptionKey: 'mesh.detail.distributionInOrderDescription' },
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

// Mirror of daemon-core repo-mesh-types MESH_MAX_PARALLEL_TASKS_MIN/MAX. The
// daemon clamps to this range in resolveMaxParallelTasks; the UI clamps to the
// same bounds so the input can never propose a value the daemon would silently
// clamp away. Keep in sync with repo-mesh-types.ts.
export const MESH_MAX_PARALLEL_TASKS_MIN = 1
export const MESH_MAX_PARALLEL_TASKS_MAX = 64

/**
 * The EFFECTIVE mesh policy — what each key resolves to on the daemon. The daemon
 * ships it as `effectivePolicy` next to the stored overrides (`policy`), so the
 * dashboard keeps no copy of the defaults (a copy drifted: it said maxParallelTasks 2
 * while the daemon resolved 64). An older daemon sends no `effectivePolicy`; its
 * `policy` is then a full stored copy, which is the best available answer.
 */
export function readMeshPolicy(mesh: MeshEntry | null): Record<string, any> {
    return { ...(mesh?.effectivePolicy || mesh?.policy || {}) }
}

/** True when the owner explicitly SET this policy key (it is in the stored overrides). */
export function isMeshPolicyKeySet(mesh: MeshEntry | null, key: string): boolean {
    const overrides = mesh?.policy
    return !!overrides && typeof overrides === 'object' && Object.prototype.hasOwnProperty.call(overrides, key)
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
    addNodeDaemonPicker: boolean
    nodeInstruction: boolean
}
