/**
 * mission-brief — the goal/constraints/done-criteria/handoff a coordinator
 * attaches to a mission at `mesh_mission_upsert` time, and the deterministic
 * rendering of that brief into a dispatched task's worker-protocol footer
 * (wiring-unification Phase H2, `docs/design/2026-09-23-wiring-unification.md`
 * §7c).
 *
 * `mesh_mission_upsert` today carries only a free-text `goal` string — no
 * structured constraints, done-criteria or handoff notes, and nothing from a
 * mission ever reaches a dispatched worker's task body. This module is the
 * pure, dependency-free core: a normalized `MissionBrief` shape with length
 * caps (mirrors `report_completion.summary`'s "prefer specifics" discipline —
 * a brief is meant to be read by a worker mid-task, not skimmed by a human),
 * and a deterministic Markdown renderer capped at 1,200 chars so a mission
 * with many/long fields cannot blow a dispatched task's token budget.
 *
 * This module does NOT decide where the rendered block is inserted (that is
 * `worker-protocol.ts`'s `renderWorkerProtocolFooter`, which places it above
 * the marker line — see that file), and does NOT touch storage (H2's proposal
 * keeps `mesh_missions` as the row source; this is the shape callers upsert
 * into/read out of that row's `goal`/new `brief` columns).
 */

/** Per-field caps. Generous enough for real content, small enough that four
 *  arrays of them cannot silently balloon a rendered block past the render cap. */
const GOAL_MAX = 500
const LIST_ITEM_MAX = 200
const LIST_MAX_ITEMS = 12

/** Total rendered-block cap (design doc H2 "bounded payload" discipline, mirrored from `listMeshMissionsForTool`). */
export const MISSION_BRIEF_RENDER_MAX_CHARS = 1200

export interface MissionBrief {
    /** What this mission is trying to accomplish. Required — an empty brief is not meaningful. */
    goal: string
    /** Hard constraints a worker must respect (e.g. "do not touch daemon-core", "no npm install"). */
    constraints?: string[]
    /** How to know the mission is actually done. */
    doneCriteria?: string[]
    /** Standing notes for whoever picks up mission work next. */
    handoffNotes?: string[]
    /** Paths this mission's tasks collectively own (H1 integration point — surfaced, not enforced here). */
    ownedPaths?: string[]
}

export interface NormalizeMissionBriefResult {
    /** `null` when the input had no usable `goal` — callers should treat this as "no brief", not an empty one. */
    readonly brief: MissionBrief | null
    /** What was trimmed/dropped, for a caller that wants to warn (never thrown). */
    readonly truncated: ReadonlyArray<{ field: string; reason: 'field_too_long' | 'list_too_long' | 'item_too_long' }>
}

function truncateString(value: string, max: number): string {
    if (value.length <= max) return value
    return `${value.slice(0, max - 1).trimEnd()}…`
}

function normalizeStringList(
    value: unknown,
    field: string,
    truncated: Array<{ field: string; reason: 'field_too_long' | 'list_too_long' | 'item_too_long' }>,
): string[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) return undefined
    const items: string[] = []
    let itemTruncated = false
    for (const raw of value) {
        if (typeof raw !== 'string') continue
        const trimmed = raw.trim()
        if (!trimmed) continue
        if (trimmed.length > LIST_ITEM_MAX) itemTruncated = true
        items.push(truncateString(trimmed, LIST_ITEM_MAX))
    }
    if (itemTruncated) truncated.push({ field, reason: 'item_too_long' })
    if (items.length > LIST_MAX_ITEMS) {
        truncated.push({ field, reason: 'list_too_long' })
        return items.slice(0, LIST_MAX_ITEMS)
    }
    return items.length > 0 ? items : undefined
}

/**
 * Normalize a caller-supplied brief. Never throws. Returns `brief: null` when
 * there is no non-empty `goal` — the caller (e.g. `mesh_mission_upsert`'s
 * handler) decides whether that means "reject" or "no brief attached", this
 * module only normalizes shape.
 */
export function normalizeMissionBrief(input: unknown): NormalizeMissionBriefResult {
    const truncated: Array<{ field: string; reason: 'field_too_long' | 'list_too_long' | 'item_too_long' }> = []
    if (!input || typeof input !== 'object') {
        return { brief: null, truncated }
    }
    const raw = input as Record<string, unknown>

    const rawGoal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
    if (!rawGoal) {
        return { brief: null, truncated }
    }
    if (rawGoal.length > GOAL_MAX) truncated.push({ field: 'goal', reason: 'field_too_long' })
    const goal = truncateString(rawGoal, GOAL_MAX)

    const constraints = normalizeStringList(raw.constraints, 'constraints', truncated)
    const doneCriteria = normalizeStringList(raw.doneCriteria ?? raw.done_criteria, 'doneCriteria', truncated)
    const handoffNotes = normalizeStringList(raw.handoffNotes ?? raw.handoff_notes, 'handoffNotes', truncated)
    const ownedPaths = normalizeStringList(raw.ownedPaths ?? raw.owned_paths, 'ownedPaths', truncated)

    const brief: MissionBrief = { goal }
    if (constraints) brief.constraints = constraints
    if (doneCriteria) brief.doneCriteria = doneCriteria
    if (handoffNotes) brief.handoffNotes = handoffNotes
    if (ownedPaths) brief.ownedPaths = ownedPaths

    return { brief, truncated }
}

function renderList(heading: string, items: readonly string[] | undefined): string[] {
    if (!items || items.length === 0) return []
    return [`${heading}:`, ...items.map(item => `- ${item}`)]
}

/**
 * Deterministic Markdown rendering of a brief, capped at
 * `MISSION_BRIEF_RENDER_MAX_CHARS`. Same field order every call (goal,
 * constraints, done criteria, owned paths, handoff notes) so a snapshot test
 * or a worker reading two renders of the same brief sees no drift. If the
 * assembled text exceeds the cap, trailing sections are dropped whole (never
 * mid-line) until it fits, and a final `(brief truncated)` marker is appended
 * — a worker should never receive a block cut off mid-sentence.
 */
export function renderMissionBriefBlock(brief: MissionBrief): string {
    const sections: string[] = [`Mission goal: ${brief.goal}`]
    sections.push(...renderList('Constraints', brief.constraints))
    sections.push(...renderList('Done when', brief.doneCriteria))
    sections.push(...renderList('Owned paths', brief.ownedPaths))
    sections.push(...renderList('Handoff notes', brief.handoffNotes))

    const full = sections.join('\n')
    if (full.length <= MISSION_BRIEF_RENDER_MAX_CHARS) return full

    // Drop whole lines from the end until it fits, then append the marker
    // (itself budgeted into the cap so the final string never exceeds it).
    const marker = '\n(brief truncated)'
    const budget = MISSION_BRIEF_RENDER_MAX_CHARS - marker.length
    const lines = full.split('\n')
    let acc = ''
    for (const line of lines) {
        const next = acc ? `${acc}\n${line}` : line
        if (next.length > budget) break
        acc = next
    }
    if (!acc) acc = truncateString(lines[0] ?? '', Math.max(budget, 0))
    return `${acc}${marker}`
}
