/**
 * Spec Debug snapshot normalization.
 *
 * The daemon's `get_spec_debug` returns the session adapter's
 * `getDebugSnapshot()`. Every CLI adapter is a SpecCliAdapter (the legacy
 * engine was deleted, oss 48e5ed1a), so the snapshot is always the "panel
 * shape" — `spec_id`, `current_state`, `stateHistory`, `sections`, `screen`,
 * `specPath`, `current_modal`, … This module defaults the fields the panel
 * reads; anything that is not that shape is not a snapshot (null).
 */

/** Structural mirror of SpecDebugPanel's SpecSnapshot (kept in sync locally to
 *  avoid a circular import with the component). */
export interface NormalizedSpecSnapshot {
    cliType: string
    spec_id: string
    specPath?: string
    current_state: { id: string; label: string; title: string | null } | null
    current_modal: { title: string | null; buttons: { index: number; label: string }[] } | null
    activeInteractivePrompt: unknown
    exited: boolean
    screen: string
    sections: Record<string, string> | undefined
    stateHistory: Array<Record<string, unknown>>
    idleHoldPending: boolean
    lastBusyAt: number
    cursorPosition?: { row: number; col: number } | null
    completionIdleDebounce?: { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null
    fsm?: unknown
    name?: string
    status?: string
    workingDir?: string
    spawnedAtMs?: number
    providerSessionId?: string | null
    messages?: Array<{ role: string; content: string; receivedAt?: number }>
    committedMessages?: Array<{ role: string; content: string; receivedAt?: number }>
}

function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : ''
}

/**
 * True when the raw snapshot carries state-machine rule fields — i.e. it came
 * from the spec-driven adapter. A snapshot with a `spec_id`, a `current_state`
 * key, or a `stateHistory` array is spec-shaped; anything else is not a snapshot.
 */
export function isSpecShapedSnapshot(raw: unknown): boolean {
    const r = asRecord(raw)
    if (typeof r.spec_id === 'string' && r.spec_id.length > 0) return true
    if ('current_state' in r) return true
    if (Array.isArray(r.stateHistory)) return true
    return false
}

/** Normalize a raw adapter snapshot into the panel's snapshot (null = not a snapshot). */
export function normalizeSpecSnapshot(raw: unknown): NormalizedSpecSnapshot | null {
    if (raw == null || typeof raw !== 'object' || !isSpecShapedSnapshot(raw)) return null
    const r = raw as Record<string, unknown>
    return {
        cliType: str(r.cliType),
        spec_id: str(r.spec_id),
        specPath: typeof r.specPath === 'string' ? r.specPath : undefined,
        current_state: (r.current_state as NormalizedSpecSnapshot['current_state']) ?? null,
        current_modal: (r.current_modal as NormalizedSpecSnapshot['current_modal']) ?? null,
        activeInteractivePrompt: r.activeInteractivePrompt,
        exited: r.exited === true,
        screen: str(r.screen),
        sections: (r.sections as Record<string, string> | undefined) ?? undefined,
        stateHistory: Array.isArray(r.stateHistory) ? (r.stateHistory as Array<Record<string, unknown>>) : [],
        idleHoldPending: r.idleHoldPending === true,
        lastBusyAt: typeof r.lastBusyAt === 'number' ? r.lastBusyAt : 0,
        cursorPosition: (r.cursorPosition as NormalizedSpecSnapshot['cursorPosition']) ?? null,
        completionIdleDebounce: (r.completionIdleDebounce as NormalizedSpecSnapshot['completionIdleDebounce']) ?? null,
        fsm: r.fsm ?? null,
        name: typeof r.name === 'string' ? r.name : undefined,
        status: typeof r.status === 'string' ? r.status : undefined,
        workingDir: typeof r.workingDir === 'string' ? r.workingDir : undefined,
        spawnedAtMs: typeof r.spawnedAtMs === 'number' ? r.spawnedAtMs : undefined,
        providerSessionId: (r.providerSessionId as string | null | undefined) ?? null,
        messages: (r.messages as NormalizedSpecSnapshot['messages']) ?? undefined,
        committedMessages: (r.committedMessages as NormalizedSpecSnapshot['messages']) ?? undefined,
    }
}
