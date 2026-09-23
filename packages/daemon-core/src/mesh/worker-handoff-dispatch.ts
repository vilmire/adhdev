/**
 * Dispatch-body materialization — the one place a task's authored message
 * becomes the text a worker actually receives.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §5 (decision C — handoff
 * enclosure) and docs/design/2026-09-23-wiring-unification.md §7b F1 (worker
 * protocol footer).
 *
 * Separated from `worker-handoff-notes.ts` (which owns storage, relevance and
 * rendering) and from `mesh-queue-assignment.ts` (which owns claim/dispatch)
 * because it is the one place the two meet: it needs a task and a mesh NODE to
 * answer "what is this task about", and it needs the note store to answer "who
 * else touched that". Keeping it here rather than inline in the assignment path
 * also keeps that file under the file-size gate's frozen baseline.
 *
 * ─── Why the footer is unconditional ────────────────────────────────────
 *
 * Measured 2026-09-23 on the live preview ledger: 635 worker attempts in 14
 * days, 3 `report_completion` calls. The worker MCP was delivered to every
 * provider and never used because nothing ever told the worker it existed —
 * this function returned `task.message` verbatim whenever the gate was off or
 * no handoff note was relevant, and the coordinator prompt never mentioned the
 * worker tools. The footer is therefore appended to EVERY dispatched body; the
 * worker-MCP gate governs only the handoff-note enclosure.
 */

import {
    appendWorkerProtocolFooter,
    hasWorkerProtocolFooter,
} from '@adhdev/mesh-shared';

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { isWorkerMcpEnabled } from './worker-mcp-isolation.js';
import { composeTaskDispatchBody } from './worker-handoff-notes.js';
import { isTaskReadonly } from './mesh-work-queue.js';

function readNonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The minimum a caller must know about a task to materialize its body. A
 * `MeshWorkQueueEntry` satisfies this structurally; direct-dispatch callers that
 * have not materialized a queue row yet pass the same fields by hand.
 */
export interface DispatchableTask {
    id: string;
    message: string;
    taskMode?: string;
    difficulty?: string;
    readonly?: boolean;
    missionId?: string;
    /** Files the task is expected to touch, when known — drives handoff-note relevance. */
    touchedFiles?: unknown;
}

/**
 * The body to actually send for this task:
 *
 *   1. `task.message` — the coordinator's authored text, verbatim;
 *   2. the handoff-note block, when the worker-MCP gate is on and any earlier
 *      work is relevant (see worker-handoff-notes.ts);
 *   3. the worker protocol footer — ALWAYS, carrying the task's id, mode,
 *      difficulty and read-only axis so the worker learns the protocol from
 *      the task itself.
 *
 * ★Idempotent. A body that already carries the footer marker is returned
 * unchanged: the footer is never stacked, and no second handoff block is
 * appended after it. `task.message` is never persisted with the footer
 * (callers record the authored text and dispatch this result), so that branch
 * is a defence against a requeue/redispatch that re-materializes an
 * already-materialized body, not an expected path.
 *
 * ★The enclosure and footer are applied to the DISPATCHED body only; the
 * caller must not write the result back onto the queue row. Persisting it
 * would put another agent's prose into records meant to hold the
 * coordinator's own text, and every redrive would re-enclose the notes.
 *
 * ★Never throws. Enclosure is additive — a lookup failure degrades to the plain
 * message (still footered) rather than sinking a dispatch that is otherwise
 * sound.
 */
export function resolveDispatchMessage(
    task: DispatchableTask,
    meshId: string,
    node: unknown,
): string {
    if (hasWorkerProtocolFooter(task.message)) {
        LOG.debug('WorkerProtocol', `Task ${task.id} body already carries the worker protocol footer — not re-materializing`);
        return task.message;
    }

    let body = task.message;
    let enclosedHandoffNotes = 0;

    if (isWorkerMcpEnabled()) {
        try {
            const touchedFiles = task.touchedFiles;
            const branch = readNonEmpty((node as { worktreeBranch?: unknown } | null)?.worktreeBranch);
            const composed = composeTaskDispatchBody(task.message, {
                meshId,
                taskId: task.id,
                ...(Array.isArray(touchedFiles) ? { touchedFiles: touchedFiles as string[] } : {}),
                ...(task.missionId ? { missionId: task.missionId } : {}),
                ...(branch ? { branch } : {}),
                // Injected rather than imported by the note module: resolving a
                // note's mission means reading a QUEUE row, and the note module
                // must not depend on the queue (it is read by the queue).
                lookupMissionId: (candidateTaskId: string) => {
                    try {
                        return MeshRuntimeStore.getInstance().findQueueEntryById(meshId, candidateTaskId)?.missionId;
                    } catch { return undefined; }
                },
            });
            if (composed.enclosedNotes > 0) {
                LOG.info('HandoffNotes',
                    `Enclosed ${composed.enclosedNotes} handoff note(s) with task ${task.id}`
                    + (composed.omittedNotes ? ` (${composed.omittedNotes} omitted to fit)` : ''));
            }
            body = composed.body;
            enclosedHandoffNotes = composed.enclosedNotes;
        } catch (e: any) {
            LOG.warn('HandoffNotes', `Failed to compose dispatch body for ${task.id}: ${e?.message || e}`);
            body = task.message;
            enclosedHandoffNotes = 0;
        }
    }

    return appendWorkerProtocolFooter(body, {
        taskId: task.id,
        ...(readNonEmpty(task.taskMode) ? { taskMode: task.taskMode!.trim() } : {}),
        ...(readNonEmpty(task.difficulty) ? { difficulty: task.difficulty!.trim() } : {}),
        ...(isTaskReadonly(task) ? { readonly: true } : {}),
        ...(enclosedHandoffNotes > 0 ? { enclosedHandoffNotes } : {}),
    });
}
