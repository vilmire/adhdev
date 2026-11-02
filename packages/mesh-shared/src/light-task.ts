/**
 * Same-machine light task — shared vocabulary and wire shapes (design
 * docs/design/2026-11-01-same-machine-light-task.md).
 *
 * A light task is a `code_change` queue row that runs in a per-task scratch checkout
 * (light workspace) on the coordinator's machine, based on the coordinator checkout's
 * commit. Dependency-free leaf: daemon-core, mcp-server and web-core all import this.
 */

/** Enqueue refusals (thrown as `<code>: <message>`). */
export const LIGHT_REJECT = {
    REQUIRES_LOCAL_BASE: 'light_requires_local_base',
    NOT_CONFIGURED: 'light_workspace_not_configured',
    REQUIRES_OWNED_PATHS: 'light_requires_owned_paths',
    MODE_CONFLICT: 'light_mode_conflict',
} as const
export type LightRejectCode = typeof LIGHT_REJECT[keyof typeof LIGHT_REJECT]

/** Pending-row hold reasons set by the light dispatcher. */
export const LIGHT_HOLD = {
    PREPARE_FAILED: 'light_workspace_prepare_failed',
    LIMIT: 'light_workspace_limit',
    DISK_LOW: 'light_workspace_disk_low',
    CAP: 'max_light_parallel_tasks_reached',
} as const

/** Reasons a finished light result is not landable (`landing: 'blocked'`). */
export const LIGHT_BLOCK_REASONS = [
    'light_uncommitted_changes',
    'light_dependency_change',
    'light_lineage_unproven',
    'shared_checkout_mutated',
] as const
export type LightBlockReason = typeof LIGHT_BLOCK_REASONS[number]

/** Non-blocking observations recorded on the result. */
export const LIGHT_WARNINGS = ['shared_checkout_changed_during_task', 'light_base_dirty_overlap'] as const
export type LightWarning = typeof LIGHT_WARNINGS[number]

export const LIGHT_LAND_MODES = ['refine', 'apply_to_checkout'] as const
export type LightLandMode = typeof LIGHT_LAND_MODES[number]

export type LightLandingState = 'ready' | 'conflict' | 'blocked' | 'landed' | 'discarded'

export interface LightApplyCheckSide {
    /** Commit the result was checked against. */
    against: string
    status: 'clean' | 'conflict' | 'base_unavailable'
    conflictPaths?: string[]
}

/** merge-tree apply-check of the root (`.`) and each submodule, vs the base HEAD and `origin/<base>`. */
export interface LightApplyCheck {
    head: LightApplyCheckSide
    remote?: LightApplyCheckSide
}

/** Worker-reported test run (`report_completion.testsRun`). Self-reported, never trusted as evidence. */
export interface LightTestRun {
    command: string
    exit: number
    passed?: number
    failed?: number
    note?: string
}

export const LIGHT_TESTS_RUN_MAX = 20

export interface LightTaskResult {
    workspaceId: string
    /** root branch (`mesh/light/<taskId8>`) */
    branch: string
    /** submodule path -> branch */
    submoduleBranches?: Record<string, string>
    rootBaseSha: string
    rootHeadSha?: string
    submoduleHeads?: Record<string, { base: string; head: string }>
    touchedPaths: string[]
    ownedPathsMismatch?: string[]
    applyCheck?: LightApplyCheck
    patchArtifactIds: string[]
    testsRun?: LightTestRun[]
    landing: LightLandingState
    blockedReason?: LightBlockReason
    blockedDetail?: string
    warnings?: LightWarning[]
    landedAt?: string
    landedVia?: LightLandMode
    /** The verified source packet (`MeshSourceCandidate`) for this result; tests carry no log hashes. */
    sourceCandidate?: import('./task-source-phase').MeshSourceCandidate
    capturedAt: string
}

export interface LightLandRequest {
    taskIds: string[]
    mode?: LightLandMode
    dryRun?: boolean
    /** Required when a result touched paths outside its `owned_paths`. */
    acceptPathsOutsideOwned?: boolean
    /** Land the leading non-conflicting tasks when a later one conflicts. */
    partial?: boolean
    approvedPublishShas?: string[]
}

/**
 * True when a session record/state (or a bare settings object) belongs to a light-task worker, i.e.
 * it was launched with `settings.lightWorkspaceId`. A light session is bound to ONE task's scratch
 * workspace and, by the central claim rule, can never claim any other row — so it is never "the
 * node's worker" for duplicate-launch guards, auto-launch gating or concurrency counts.
 */
export function isLightWorkerSession(session: unknown): boolean {
    const s = session as any
    if (!s || typeof s !== 'object') return false
    const has = (o: any): boolean => !!o && typeof o === 'object' && typeof o.lightWorkspaceId === 'string' && o.lightWorkspaceId.trim() !== ''
    return has(s.settings) || has(s.launchRecord?.settings) || has(s)
}
