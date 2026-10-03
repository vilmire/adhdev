/**
 * meshLedgerEvents — maps the mesh's internal activity-record kinds onto the
 * handful of events a user actually cares about.
 *
 * The daemon records ~40 kinds (dispatch bookkeeping, replication, held-event
 * requeues, claim refusals…). Showing them raw ("task claimed", "ledger
 * reconciled") is noise for an operator. Six user events cover what matters;
 * every other kind is internal and hidden unless the user asks for "all".
 */

export type MeshUserEvent =
    | 'taskStarted'
    | 'taskFinished'
    | 'taskFailed'
    | 'needsInput'
    | 'sessionStarted'
    | 'nodeChanged'

const KIND_TO_EVENT: Record<string, MeshUserEvent> = {
    task_dispatched: 'taskStarted',
    task_claimed: 'taskStarted',
    task_completed: 'taskFinished',
    task_failed: 'taskFailed',
    task_stalled: 'taskFailed',
    dispatch_failed: 'taskFailed',
    p2p_dispatch_failed: 'taskFailed',
    task_approval_needed: 'needsInput',
    task_question_pending: 'needsInput',
    session_launched: 'sessionStarted',
    session_auto_launch: 'sessionStarted',
    node_joined: 'nodeChanged',
    node_removed: 'nodeChanged',
    node_cloned: 'nodeChanged',
}

/** The user event a record kind maps to, or null for internal bookkeeping. */
export function classifyLedgerKind(kind: string | null | undefined): MeshUserEvent | null {
    if (!kind) return null
    return KIND_TO_EVENT[kind.trim().toLowerCase()] ?? null
}

export const MESH_USER_EVENT_LABEL_KEYS: Record<MeshUserEvent, string> = {
    taskStarted: 'mesh.activity.taskStarted',
    taskFinished: 'mesh.activity.taskFinished',
    taskFailed: 'mesh.activity.taskFailed',
    needsInput: 'mesh.activity.needsInput',
    sessionStarted: 'mesh.activity.sessionStarted',
    nodeChanged: 'mesh.activity.nodeChanged',
}

/** Kinds whose own label says more than their event's ("Machine joined or left"
 *  for a worktree a coordinator just created was misleading). */
const KIND_LABEL_KEYS: Record<string, string> = {
    node_cloned: 'mesh.activity.worktreeCreated',
    node_joined: 'mesh.activity.nodeJoined',
    node_removed: 'mesh.activity.nodeRemoved',
}

/**
 * Display label: the localized user event, or — for internal kinds shown only
 * in "all activity" mode — the raw kind made readable.
 */
export function ledgerKindDisplayLabel(kind: string, t: (key: string) => string, payload?: Record<string, unknown>): string {
    const specific = KIND_LABEL_KEYS[kind.trim().toLowerCase()]
    if (specific) return t(specific)
    const event = classifyLedgerEntry({ kind, payload })
    if (event) return t(MESH_USER_EVENT_LABEL_KEYS[event])
    const readable = kind.replace(/[_-]+/g, ' ')
    const phase = payload?.phase
    return typeof phase === 'string' && phase ? `${readable} · ${phase}` : readable
}

type LedgerDisplayEntry = { kind: string; nodeId?: string | null; taskId?: string | null; sessionId?: string | null; payload?: Record<string, unknown> }

/**
 * Entry-level classification. `session_auto_launch` records every phase of an
 * auto-launch attempt (skipped / failed / completed as well as started); only
 * a start is "Agent started" — the others are bookkeeping.
 */
export function classifyLedgerEntry(entry: Pick<LedgerDisplayEntry, 'kind' | 'payload'>): MeshUserEvent | null {
    const event = classifyLedgerKind(entry.kind)
    if (event === 'sessionStarted' && entry.kind.trim().toLowerCase() === 'session_auto_launch') {
        const phase = entry.payload?.phase
        if (typeof phase === 'string' && phase !== 'started') return null
    }
    return event
}

/**
 * Node label for an activity row. A removed worktree node is gone from mesh
 * status, so `resolveNodeLabel` can only echo its raw id; the removal/clone
 * record itself carries the branch or workspace, which names it far better.
 */
export function ledgerEntryNodeLabel(
    entry: Pick<LedgerDisplayEntry, 'nodeId' | 'payload'>,
    resolveNodeLabel: (nodeId: string | undefined | null) => string,
): string {
    const nodeId = entry.nodeId
    if (!nodeId) return ''
    const resolved = resolveNodeLabel(nodeId)
    if (resolved && resolved !== nodeId) return resolved
    const p = entry.payload ?? {}
    for (const key of ['worktreeBranch', 'mergedBranch', 'branch'] as const) {
        const v = p[key]
        if (typeof v === 'string' && v.trim()) return v.trim()
    }
    const workspace = p.workspace
    if (typeof workspace === 'string' && workspace.trim()) {
        const base = workspace.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        if (base) return base
    }
    return resolved || nodeId
}

/**
 * Keep only user-facing events unless `showAll`. Order is preserved. Several
 * internal kinds map to one event (task_dispatched + task_claimed → "Task
 * started", session_auto_launch + session_launched → "Agent started"), so the
 * same moment produced 2–3 identical rows; adjacent rows with the same event
 * for the same node/task/session collapse to one.
 */
export function filterLedgerEntriesForDisplay<T extends LedgerDisplayEntry>(entries: T[], showAll: boolean): T[] {
    if (showAll) return entries
    const out: T[] = []
    let prevKey: string | null = null
    for (const entry of entries) {
        const event = classifyLedgerEntry(entry)
        if (!event) continue
        const key = `${event}\u0000${entry.nodeId ?? ''}\u0000${entry.taskId ?? ''}\u0000${event === 'sessionStarted' ? '' : entry.sessionId ?? ''}`
        if (key === prevKey) continue
        prevKey = key
        out.push(entry)
    }
    return out
}
