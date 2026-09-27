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

/**
 * Display label: the localized user event, or — for internal kinds shown only
 * in "all activity" mode — the raw kind made readable.
 */
export function ledgerKindDisplayLabel(kind: string, t: (key: string) => string): string {
    const event = classifyLedgerKind(kind)
    return event ? t(MESH_USER_EVENT_LABEL_KEYS[event]) : kind.replace(/[_-]+/g, ' ')
}

/** Keep only user-facing events unless `showAll`. Order is preserved. */
export function filterLedgerEntriesForDisplay<T extends { kind: string }>(entries: T[], showAll: boolean): T[] {
    return showAll ? entries : entries.filter(entry => classifyLedgerKind(entry.kind) !== null)
}
