/**
 * mission-git-state — types and the pure aggregation for "did this mission's
 * referenced commits/branches land on the default branch?"
 * (docs/design/2026-11-01-mission-git-refs.md §3).
 *
 * The facts come from the daemon opening git objects itself (never from
 * commit-message text, branch-name similarity or worker prose). `landed` means
 * ONLY "the referenced changes are on the base"; it never implies live
 * acceptance, mission completion or that remaining items are done, and it is
 * never used to change a mission's status.
 *
 * Dependency-free leaf: plain data in, plain data out.
 */

/** Per-ref verdict. `unknown` is never folded into `not_contained` nor promoted to `contained_*`. */
export const MISSION_REF_GIT_STATUSES = ['contained_ancestor', 'contained_patch_equivalent', 'not_contained', 'unknown'] as const
export type MissionRefGitStatus = typeof MISSION_REF_GIT_STATUSES[number]

/** How a contained verdict was reached. */
export const MISSION_REF_GIT_METHODS = ['ancestry', 'cherry', 'residual_patch'] as const
export type MissionRefGitMethod = typeof MISSION_REF_GIT_METHODS[number]

/** Mission-level projection. */
export const MISSION_GIT_STATES = ['no_refs', 'landed', 'partial', 'not_landed', 'unknown'] as const
export type MissionGitStateValue = typeof MISSION_GIT_STATES[number]

export function isMissionRefContained(status: MissionRefGitStatus): boolean {
    return status === 'contained_ancestor' || status === 'contained_patch_equivalent'
}

/** Why a ref is `unknown` (detail.unknownReason). Free-form strings are tolerated on read. */
export type MissionRefUnknownReason =
    | 'object_missing'
    | 'shallow'
    | 'undeterminable'
    | 'base_missing'
    | 'branch_not_found'
    | 'base_branch_ref'
    | 'gitlink_undeterminable'
    | 'merge_tree_failed'
    | 'node_offline'
    | 'no_repo'
    | 'budget'
    | 'not_a_git_ref'

export interface MissionRefGitDetail {
    reasonCode?: string
    unknownReason?: MissionRefUnknownReason | string
    /** `modified_since_landing_possible`: main later touched the same lines — shown as a hint, not a verdict. */
    note?: string
    nodeId?: string
    residualPatchId?: string
    ahead?: number
    behind?: number
}

/** One stored per-ref evaluation (a row of `mesh_mission_ref_evals`). */
export interface MissionRefGitEval {
    itemId: string
    /** `kind:repo:value` (normalized, lower-case SHA). */
    refKey: string
    kind: 'commit' | 'branch'
    value: string
    repo?: string
    /** Branch refs: the SHA the name resolved to at first evaluation (re-evaluation keeps using it). */
    pinnedSha?: string
    baseRef: string
    baseSha?: string
    status: MissionRefGitStatus
    method?: MissionRefGitMethod
    detail?: MissionRefGitDetail
    evaluatedAt: string
}

export interface MissionGitState {
    missionId: string
    state: MissionGitStateValue
    /** `partial` only: some refs were `unknown` (not just `not_contained`). */
    partialUnknown: boolean
    counts: { total: number; contained: number; notContained: number; unknown: number }
    /** Base the newest evaluation compared against. */
    baseRef?: string
    baseSha?: string
    /** Oldest `evaluatedAt` among the refs (the freshness floor). */
    evaluatedAt?: string
    /** True when no row exists yet / the rows are older than the TTL — a refresh was (or can be) triggered. */
    stale: boolean
    refs: MissionRefGitEval[]
}

/**
 * Aggregate per-ref statuses (design §3.3):
 *  - none → `no_refs`; all contained → `landed`; some contained → `partial`
 *    (`partialUnknown` when any of the rest is `unknown`);
 *  - none contained: all `not_contained` → `not_landed`, otherwise `unknown`.
 */
export function aggregateMissionGitState(statuses: readonly MissionRefGitStatus[]): {
    state: MissionGitStateValue
    partialUnknown: boolean
    counts: MissionGitState['counts']
} {
    const total = statuses.length
    const contained = statuses.filter(isMissionRefContained).length
    const notContained = statuses.filter(s => s === 'not_contained').length
    const unknown = statuses.filter(s => s === 'unknown').length
    const counts = { total, contained, notContained, unknown }
    if (total === 0) return { state: 'no_refs', partialUnknown: false, counts }
    if (contained === total) return { state: 'landed', partialUnknown: false, counts }
    if (contained > 0) return { state: 'partial', partialUnknown: unknown > 0, counts }
    if (notContained === total) return { state: 'not_landed', partialUnknown: false, counts }
    return { state: 'unknown', partialUnknown: false, counts }
}
