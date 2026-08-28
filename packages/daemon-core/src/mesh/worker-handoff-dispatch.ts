/**
 * Handoff-note enclosure at dispatch — the queue-assignment seam.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §5 (decision C).
 *
 * Separated from `worker-handoff-notes.ts` (which owns storage, relevance and
 * rendering) and from `mesh-queue-assignment.ts` (which owns claim/dispatch)
 * because it is the one place the two meet: it needs a queue ENTRY and a mesh
 * NODE to answer "what is this task about", and it needs the note store to
 * answer "who else touched that". Keeping it here rather than inline in the
 * assignment path also keeps that file under the file-size gate's frozen
 * baseline, which the gate asks for by decomposition rather than by raising
 * the limit.
 */

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { isWorkerMcpEnabled } from './worker-mcp-isolation.js';
import { composeTaskDispatchBody } from './worker-handoff-notes.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';

function readNonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The body to actually send for this task.
 *
 * ★Returns `task.message` verbatim when the gate is off or nothing is relevant,
 * so the ordinary dispatch is byte-identical to the pre-feature behavior.
 *
 * ★The enclosure is applied to the DISPATCHED body only; the caller must not
 * write it back onto the queue row. Persisting it would put another agent's
 * prose into records meant to hold the coordinator's own text, and every
 * redrive would re-enclose (and re-stack) the notes.
 *
 * ★Never throws. Enclosure is additive — a lookup failure degrades to the plain
 * message rather than sinking a dispatch that is otherwise sound.
 */
export function resolveDispatchMessage(
    task: MeshWorkQueueEntry,
    meshId: string,
    node: unknown,
): string {
    if (!isWorkerMcpEnabled()) return task.message;
    try {
        const touchedFiles = (task as { touchedFiles?: unknown }).touchedFiles;
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
        return composed.body;
    } catch (e: any) {
        LOG.warn('HandoffNotes', `Failed to compose dispatch body for ${task.id}: ${e?.message || e}`);
        return task.message;
    }
}
