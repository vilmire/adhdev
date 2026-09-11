// ---------------------------------------------------------------------------
// mesh-notification-status-line — one-line mesh snapshot appended to terminal
// coordinator notifications
// ---------------------------------------------------------------------------
// A coordinator that receives a terminal notification ("worker X completed")
// almost always follows it with a mesh_status / mesh_view_queue call just to
// re-establish "what else is in flight". That round-trip is pure overhead: the
// daemon already holds every number involved, synchronously, at the moment it
// injects the notification. This module renders those numbers as a single
// appended line so the common case needs no extra MCP call.
//
// ── Three constraints, each load-bearing ────────────────────────────────────
//
// 1. SNAPSHOT AT INJECT TIME, NEVER AT EMIT TIME. Emit (mesh-event-forwarding)
//    and inject (mesh-reconcile-coordinator-drain) are decoupled: when the
//    coordinator is busy, an event is HELD at drained=0 and injected only on a
//    later idle edge — measured as long as 1h42m in one live incident. A line
//    rendered at emit time would arrive stamped with numbers that are hours
//    stale, which is worse than no line at all (it actively misinforms). The
//    call site is therefore inside injectPendingIntoCoordinator, immediately
//    before the send_message, mirroring the existing lazy buildMeshSystemMessage
//    precedent there.
//
// 2. NO FREE TEXT. MeshActiveWorkRecord.taskTitle is NOT an identifier — it is
//    summarizeMessage() output, i.e. the first ~96 chars of the task message the
//    user or coordinator authored. Embedding it here would push arbitrary user
//    prose into every notification. We emit taskId prefixes (hex handles),
//    status enum names, and integer counts only.
//
// 3. TERMINAL EVENTS ONLY, HARD 200-CHAR BOUND. Silent lifecycle events
//    (agent:ready / generating_started) carry no coordinator-visible turn and are
//    filtered upstream. The 200-char bound keeps the appended line inside the
//    submit-delay plateau: resolveSubmitDelayMs caps linesBonus and lengthBonus
//    at 800ms each, and a notification carrying a worker summary is already deep
//    into that saturation, so a bounded suffix leaves the delay unchanged.
// ---------------------------------------------------------------------------

import { LOG } from '../logging/logger.js';
import { buildMeshActiveWork, type MeshActiveWorkRecord, type MeshActiveWorkStatus } from './mesh-active-work.js';
import { getQueue, getActiveDirectDispatches } from './mesh-work-queue.js';
import { readLedgerEntriesByKind } from './mesh-ledger.js';

/** Hard upper bound on the rendered line, including the `[Mesh] ` prefix. */
export const MESH_STATUS_LINE_MAX_CHARS = 200;

/** Length of the taskId prefix surfaced per active record. */
const TASK_ID_PREFIX_CHARS = 7;

/**
 * Ledger kinds buildMeshActiveWork actually reads. Kind-filtered rather than a
 * bare `tail: N`: a tail window slices across ALL kinds, so unrelated mesh churn
 * can evict a still-active task's dispatch row and the summary silently reports
 * less work than is really in flight (LEDGER-KIND-TAIL-BLINDSPOT — same class the
 * idle-reminder gate documents). Mirrors mesh-idle-reminder.ts's list exactly.
 */
const ACTIVE_WORK_LEDGER_KINDS = [
    'task_dispatched',
    'task_completed',
    'task_failed',
    'task_stalled',
    'task_approval_needed',
    'task_question_pending',
] as const;

/**
 * Status order for the rendered breakdown. Deliberately fixed rather than derived
 * from object key order so the line is byte-stable across runs for a given input
 * (tests assert on it, and a coordinator reading two consecutive notifications
 * should be able to diff them by eye). Ordered most- to least-actionable.
 */
const STATUS_RENDER_ORDER: readonly MeshActiveWorkStatus[] = [
    'generating',
    'awaiting_approval',
    'awaiting_choice',
    'pending',
    'assigned',
    'finalizing',
    'failed',
    'idle',
];

export interface MeshStatusLineInputs {
    activeWork: MeshActiveWorkRecord[];
    statusCounts: Record<MeshActiveWorkStatus, number>;
    totalActiveCount: number;
}

/**
 * Render the one-line snapshot from an already-built active-work view. Pure and
 * synchronous — split out from the collecting wrapper so tests can drive exact
 * record sets without touching SQLite.
 *
 * Shape:
 *   [Mesh] active 4: 2 generating, 1 awaiting_approval, 1 pending (a3f21c8, 7b0e441, ...)
 *
 * Returns null when there is nothing worth appending (no active work), so the
 * caller appends nothing rather than a noise line.
 */
export function renderMeshStatusLine(inputs: MeshStatusLineInputs): string | null {
    const total = inputs.totalActiveCount;
    if (!Number.isFinite(total) || total <= 0) return null;

    const parts: string[] = [];
    for (const status of STATUS_RENDER_ORDER) {
        const count = inputs.statusCounts?.[status] ?? 0;
        if (count > 0) parts.push(`${count} ${status}`);
    }

    const head = parts.length > 0
        ? `[Mesh] active ${total}: ${parts.join(', ')}`
        : `[Mesh] active ${total}`;

    // taskId prefixes are appended only while they fit whole. We never emit a
    // truncated id — a half-id is not a usable handle and would read as a
    // different task. Once one does not fit, we stop and mark the elision.
    const ids: string[] = [];
    for (const record of inputs.activeWork) {
        const id = typeof record?.taskId === 'string' ? record.taskId.trim() : '';
        if (!id) continue;
        ids.push(id.slice(0, TASK_ID_PREFIX_CHARS));
    }
    if (ids.length === 0) return clampToBound(head);

    let line = head;
    const shown: string[] = [];
    for (let i = 0; i < ids.length; i++) {
        const isLast = i === ids.length - 1;
        // Cost of committing to this id: the id itself plus, when ids remain
        // after it, the ", ..." elision marker that will follow.
        const candidate = [...shown, ids[i]];
        const suffix = ` (${candidate.join(', ')}${isLast ? '' : ', ...'})`;
        if ((head + suffix).length > MESH_STATUS_LINE_MAX_CHARS) break;
        shown.push(ids[i]);
        line = head + suffix;
    }
    // Nothing fit — keep the counts, drop the id list entirely.
    if (shown.length === 0) return clampToBound(head);
    return clampToBound(line);
}

/**
 * Final defence on the bound. renderMeshStatusLine builds within the bound by
 * construction, but the head alone (many distinct statuses on a huge mesh) is not
 * structurally bounded, so clamp it rather than let an unbounded string reach the
 * PTY. Truncation marker keeps it obvious the line was cut.
 */
function clampToBound(line: string): string {
    if (line.length <= MESH_STATUS_LINE_MAX_CHARS) return line;
    return `${line.slice(0, MESH_STATUS_LINE_MAX_CHARS - 1)}…`;
}

/**
 * Collect the mesh's current active work and render the snapshot line. All three
 * reads (queue / direct dispatches / ledger) are synchronous in-process calls, so
 * this adds no await to the inject path.
 *
 * Best-effort by contract: ANY failure returns null and the notification is
 * injected unchanged. A status line is a convenience; it must never be able to
 * prevent a worker completion from reaching its coordinator.
 */
export function buildMeshStatusLineForNotification(meshId: string, now?: number): string | null {
    if (!meshId) return null;
    try {
        const built = buildMeshActiveWork({
            meshId,
            queue: getQueue(meshId),
            directDispatches: getActiveDirectDispatches(meshId),
            ledgerEntries: readLedgerEntriesByKind(meshId, [...ACTIVE_WORK_LEDGER_KINDS]),
            now: now ?? Date.now(),
        });
        return renderMeshStatusLine({
            activeWork: built.activeWork,
            statusCounts: built.summary.statusCounts,
            totalActiveCount: built.summary.totalActiveCount,
        });
    } catch (e: any) {
        LOG.debug('MeshReconcile', `Mesh status line build failed for mesh ${meshId}: ${e?.message || e}`);
        return null;
    }
}
