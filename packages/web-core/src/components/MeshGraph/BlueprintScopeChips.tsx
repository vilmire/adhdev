/**
 * Blueprint list scope — which sections are visible. Running/Blocked toggle
 * their sections, History reveals the terminal strip (Recent 10 + load-more),
 * By mission regroups the visible rows under mission headers.
 *
 * The toggles live on BlueprintStatusBar (`Active N | Blocked N | Recent N |
 * Missions N`); the separate chip row that duplicated them was removed.
 *
 * Default view = Running + Blocked only — the list opens on the live plan,
 * with history one tap away, not one scroll-wall away.
 */

export interface BlueprintScope {
    running: boolean
    blocked: boolean
    /** Terminal rows (Recent + History sections). */
    history: boolean
    /** Regroup visible rows under mission headers. */
    byMission: boolean
}

export const DEFAULT_BLUEPRINT_SCOPE: BlueprintScope = {
    running: true,
    blocked: true,
    history: false,
    byMission: false,
}
