/**
 * Stopped-work notices for queue `depends_on` chains.
 *
 * Policy: a queue task whose dependency ends `failed`/`cancelled` waits
 * (`block`, the default — retrying the dependency recovers it; user work is
 * never cancelled silently) unless the mesh policy is
 * `on_dependency_failure: cancel`. Either way the coordinator is told once:
 *   - `mesh:queue_dependency_blocked`   — block: which task ended and why, which
 *                                         tasks (transitively) wait on it, what to do;
 *   - `mesh:queue_dependency_cancelled` — cancel: what the cascade cancelled.
 *
 * The housekeeping sweep ({@link sweepQueueDependencyStalls}) re-derives the
 * blocked notice for every dead dependency that still has waiters. It uses the
 * SAME eventId as the terminal-time notice (root task + its output version), so
 * a root that was already announced never pages twice, while a root that ended
 * through a path that skipped the notice is still announced.
 *
 * Delivery is `notifyMeshCoordinator`, which serves a PTY-hosted and an
 * MCP-only coordinator from the same notice row.
 *
 * ★ Content boundary: the text and metadata carry ONLY ids, enums, reason CODES
 * and counts — never a task message, failure prose or blocked reason text.
 * `reasonCodeOf` reduces any reason string to its leading code.
 */
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

/** A queue task a notice names: ids only (+ the dependency it waits through). */
export interface MeshQueueStopTaskRef {
    taskId: string;
    /** The dependency id this task waits on inside the chain (transitive chains). */
    via?: string;
}

export interface MeshQueueStopRoot {
    taskId: string;
    outcome: 'failed' | 'cancelled';
    reasonCode: string;
}

/** `block` policy (the default): tasks now wait on a failed/cancelled task. */
interface MeshQueueDependencyBlockedNotice {
    kind: 'queue_dependency_blocked';
    meshId: string;
    /** Root task's output version — a retry that fails again is a new event. */
    generation: number;
    root: MeshQueueStopRoot;
    waiting: MeshQueueStopTaskRef[];
    /** Where the notice was derived (terminal-time vs the housekeeping sweep). */
    source: 'mesh_queue_dependency' | 'mesh_queue_stall_sweep';
}

/** `cancel` policy: the failure cancelled its dependents. */
interface MeshQueueDependencyCancelledNotice {
    kind: 'queue_dependency_cancelled';
    meshId: string;
    generation: number;
    root: MeshQueueStopRoot;
    cancelled: MeshQueueStopTaskRef[];
}

export type MeshQueueDependencyNotice = MeshQueueDependencyBlockedNotice | MeshQueueDependencyCancelledNotice;

/** How many tasks a notice lists by name before summarising the rest as a count. */
export const QUEUE_DEPENDENCY_NOTICE_LIST_CAP = 10;

/**
 * The leading machine code of a reason string: `max_retries_exceeded: requeued
 * 2 time(s)…` → `max_retries_exceeded`, `dependency_failed:abc` →
 * `dependency_failed`. Anything that does not start with a code-shaped token
 * collapses to `unspecified`, so free text can never leak through.
 */
export function reasonCodeOf(reason: string | undefined | null): string {
    if (typeof reason !== 'string') return 'unspecified';
    // Codes are lower snake_case; anything else (operator/agent text) is not a code.
    const m = /^[a-z][a-z0-9_]{0,63}/.exec(reason.trim());
    if (!m) return 'unspecified';
    // A code is one token; `workspace 'x' is failed…` starts with a word, not a code.
    const next = reason.trim().charAt(m[0].length);
    if (next !== '' && next !== ':') return 'unspecified';
    return m[0].toLowerCase();
}

/**
 * The reason CODE for a terminal queue task. An operator cancel carries the
 * operator's own words in `cancelReason`, so a cancel collapses to
 * `operator_cancel` unless a machine reason says otherwise.
 */
export function queueRootReasonCode(entry: Pick<MeshWorkQueueEntry, 'status' | 'cancelReason'>, machineReason?: string): string {
    if (machineReason) {
        const code = reasonCodeOf(machineReason);
        if (code !== 'unspecified') return code;
    }
    const fromRow = reasonCodeOf(entry.cancelReason);
    if (entry.status === 'cancelled') return fromRow === 'dependency_failed' ? fromRow : 'operator_cancel';
    return fromRow === 'unspecified' ? 'task_failed' : fromRow;
}

/** Every PENDING task that waits (transitively, via depends_on) on `rootId`. */
export function collectWaitingQueueDependents(store: MeshRuntimeStore, meshId: string, rootId: string): MeshQueueStopTaskRef[] {
    const pending = store.getQueueEntries(meshId, ['pending']);
    const out: MeshQueueStopTaskRef[] = [];
    const seen = new Set<string>([rootId]);
    let frontier = [rootId];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const current of frontier) {
            for (const entry of pending) {
                if (seen.has(entry.id) || !Array.isArray(entry.dependsOn) || !entry.dependsOn.includes(current)) continue;
                seen.add(entry.id);
                next.push(entry.id);
                out.push({ taskId: entry.id, ...(current !== rootId ? { via: current } : {}) });
            }
        }
        frontier = next;
    }
    return out;
}

function rootGeneration(store: MeshRuntimeStore, rootId: string): number {
    try {
        return store.getLatestTaskOutput(rootId)?.version ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Build the one notice for a task that just ended failed/cancelled. Returns
 * null when nothing waits / nothing was cancelled.
 */
export function buildQueueDependencyNotice(
    meshId: string,
    rootId: string,
    policy: 'block' | 'cancel',
    cancelled: readonly MeshWorkQueueEntry[],
    machineReason?: string,
): MeshQueueDependencyNotice | null {
    const store = MeshRuntimeStore.getInstance();
    const root = store.findQueueEntryById(meshId, rootId);
    if (!root || (root.status !== 'failed' && root.status !== 'cancelled')) return null;
    const rootRef: MeshQueueStopRoot = {
        taskId: root.id,
        outcome: root.status,
        reasonCode: queueRootReasonCode(root, machineReason),
    };
    const generation = rootGeneration(store, rootId);
    if (policy === 'cancel') {
        const listed = cancelled.map(c => {
            const via = (c.cancelReason ?? '').startsWith('dependency_failed:') ? c.cancelReason!.slice('dependency_failed:'.length) : undefined;
            return { taskId: c.id, ...(via && via !== rootId ? { via } : {}) };
        });
        if (listed.length === 0) return null;
        return { kind: 'queue_dependency_cancelled', meshId, generation, root: rootRef, cancelled: listed };
    }
    const waiting = collectWaitingQueueDependents(store, meshId, rootId);
    if (waiting.length === 0) return null;
    return { kind: 'queue_dependency_blocked', meshId, generation, root: rootRef, waiting, source: 'mesh_queue_dependency' };
}

/**
 * Page the coordinator for a task that just ended failed/cancelled. Returns true
 * when a notice was queued. Best-effort for the caller: it never throws.
 */
export function notifyQueueDependencyStopped(
    meshId: string,
    rootId: string,
    policy: 'block' | 'cancel',
    cancelled: readonly MeshWorkQueueEntry[],
    machineReason?: string,
): boolean {
    const notice = buildQueueDependencyNotice(meshId, rootId, policy, cancelled, machineReason);
    return notice ? deliverQueueDependencyNotice(notice) : false;
}

/**
 * Housekeeping catch-all: every pending task whose depends_on names a
 * `failed`/`cancelled` task gets the blocked notice for that root. Deduped
 * against the terminal-time notice by eventId (root + output version).
 */
export function sweepQueueDependencyStalls(meshId: string, opts?: { nowMs?: number }): { stalledRoots: number; noticesQueued: number } {
    const store = MeshRuntimeStore.getInstance();
    const pending = store.getQueueEntries(meshId, ['pending']);
    const deadRoots = new Map<string, MeshWorkQueueEntry>();
    for (const entry of pending) {
        for (const dep of entry.dependsOn ?? []) {
            if (deadRoots.has(dep)) continue;
            const row = store.findQueueEntryById(meshId, dep);
            if (row && (row.status === 'failed' || row.status === 'cancelled')) deadRoots.set(dep, row);
        }
    }
    let noticesQueued = 0;
    for (const [rootId, root] of deadRoots) {
        const waiting = collectWaitingQueueDependents(store, meshId, rootId);
        if (waiting.length === 0) continue;
        const notice: MeshQueueDependencyBlockedNotice = {
            kind: 'queue_dependency_blocked',
            meshId,
            generation: rootGeneration(store, rootId),
            root: { taskId: rootId, outcome: root.status as 'failed' | 'cancelled', reasonCode: queueRootReasonCode(root) },
            waiting,
            source: 'mesh_queue_stall_sweep',
        };
        if (deliverQueueDependencyNotice(notice, opts?.nowMs)) noticesQueued += 1;
    }
    return { stalledRoots: deadRoots.size, noticesQueued };
}

function deliverQueueDependencyNotice(notice: MeshQueueDependencyNotice, queuedAt?: number): boolean {
    const rendered = renderQueueDependencyNotice(notice);
    return notifyMeshCoordinator({
        event: rendered.event,
        meshId: notice.meshId,
        nodeLabel: rendered.nodeLabel,
        eventId: rendered.eventId,
        metadataEvent: rendered.metadataEvent,
        coordinatorMessage: rendered.coordinatorMessage,
        ...(queuedAt !== undefined ? { queuedAt } : {}),
    });
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface RenderedQueueDependencyNotice {
    event: string;
    eventId: string;
    nodeLabel: string;
    coordinatorMessage: string;
    metadataEvent: Record<string, unknown>;
}

function shortTask(taskId: string): string {
    return taskId.slice(0, 8);
}

function describeQueueTask(t: MeshQueueStopTaskRef): string {
    return `${shortTask(t.taskId)} (task_id ${t.taskId}${t.via ? `, via ${shortTask(t.via)}` : ''})`;
}

function listCapped<T>(items: T[], render: (t: T) => string): string {
    const shown = items.slice(0, QUEUE_DEPENDENCY_NOTICE_LIST_CAP).map(render);
    const rest = items.length - shown.length;
    return shown.join(', ') + (rest > 0 ? `, +${rest} more (mesh_view_queue)` : '');
}

function queueIdList(tasks: MeshQueueStopTaskRef[]): string {
    return tasks.slice(0, QUEUE_DEPENDENCY_NOTICE_LIST_CAP).map(t => `'${t.taskId}'`).join(', ')
        + (tasks.length > QUEUE_DEPENDENCY_NOTICE_LIST_CAP ? ` (+${tasks.length - QUEUE_DEPENDENCY_NOTICE_LIST_CAP} more — mesh_view_queue)` : '');
}

/** Notice → the exact coordinator-facing text + a content-free metadata record. */
export function renderQueueDependencyNotice(n: MeshQueueDependencyNotice): RenderedQueueDependencyNotice {
    const root = n.root;
    const rootLabel = `${shortTask(root.taskId)} (task_id ${root.taskId})`;
    const requeue = `mesh_queue_requeue(task_id='${root.taskId}', force=true)`;
    if (n.kind === 'queue_dependency_cancelled') {
        const coordinatorMessage =
            `Queue task ${rootLabel} ${root.outcome === 'failed' ? 'failed' : 'was cancelled'} (reason: ${root.reasonCode}). `
            + `Under on_dependency_failure=cancel, ${n.cancelled.length} dependent task(s) were cancelled: ${listCapped(n.cancelled, describeQueueTask)}. `
            + 'Cancelled tasks do not revive — if the work is still wanted, fix the cause and enqueue replacements (mesh_enqueue_task with depends_on).';
        return {
            event: 'mesh:queue_dependency_cancelled',
            eventId: `queue:queue_dependency_cancelled:${root.taskId}:${n.generation}`,
            nodeLabel: shortTask(root.taskId),
            coordinatorMessage,
            metadataEvent: {
                source: 'mesh_queue_dependency',
                taskId: root.taskId,
                rootOutcome: root.outcome,
                reasonCode: root.reasonCode,
                generation: n.generation,
                cancelledTaskIds: n.cancelled.map(t => t.taskId),
                policy: 'cancel',
            },
        };
    }
    const operatorCancel = root.outcome === 'cancelled' && root.reasonCode === 'operator_cancel';
    const waiting = n.waiting;
    const head = operatorCancel
        ? `${waiting.length} task(s) still wait on the task you cancelled, ${rootLabel} (reason: operator_cancel): `
        : `Queue task ${rootLabel} ${root.outcome === 'failed' ? 'failed' : 'was cancelled'} (reason: ${root.reasonCode}) and ${waiting.length} task(s) still wait on it: `;
    const next = operatorCancel
        ? `Next: cancel them too with mesh_queue_cancel(task_id=…) for ${queueIdList(waiting)}; or, if the cancel was a mistake, ${requeue} and they run once it completes.`
        : `Next: retry it with ${requeue} (add message=<corrected instruction> to change the approach) — the waiting tasks then run automatically; or drop them with mesh_queue_cancel(task_id=…) for ${queueIdList(waiting)}.`;
    const coordinatorMessage = `${head}${listCapped(waiting, describeQueueTask)}. `
        + 'Policy is on_dependency_failure=block (the default), so nothing was cancelled and they will not run on their own. '
        + next;
    return {
        event: 'mesh:queue_dependency_blocked',
        // One id for the terminal-time notice AND the sweep: the root's output
        // version is the generation, so a root announced once never pages twice.
        eventId: `queue:queue_dependency_blocked:${root.taskId}:${n.generation}`,
        nodeLabel: shortTask(root.taskId),
        coordinatorMessage,
        metadataEvent: {
            source: n.source,
            taskId: root.taskId,
            rootOutcome: root.outcome,
            reasonCode: root.reasonCode,
            generation: n.generation,
            waitingTaskIds: waiting.map(t => t.taskId),
            policy: 'block',
        },
    };
}
