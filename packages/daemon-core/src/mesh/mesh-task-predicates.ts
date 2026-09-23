// ---------------------------------------------------------------------------
// mesh-task-predicates — pure task predicates / view projections (C-W9a)
// ---------------------------------------------------------------------------
// Moved verbatim out of mesh-work-queue.ts so the mcp-server can use them
// without value-importing the DB-backed queue module (C8: the mcp-server
// reaches the queue only through the daemon's IPC commands). No behavior
// change; mesh-work-queue.ts re-exports every name for its importers.
// ---------------------------------------------------------------------------

import { isMeshTaskPriority, type MeshTaskMode, type MeshTaskPriority, type MeshTaskStatus } from '@adhdev/mesh-shared';
import { deriveDependencyFailures, type MeshDependencyFailure } from './mesh-graph-derived-failure.js';
import type { MeshTaskInputEnvelope, MeshWorkQueueEntry } from './mesh-work-queue.js';

/** G5: hard cap on tasks per atomic graph enqueue — a runaway backstop, not a tuning knob. */
export const MESH_TASK_GRAPH_MAX_TASKS = 50;

/** Content-free description of a persisted input envelope, for view/status surfaces. */
export interface MeshTaskInputSummary {
    partCount: number;
    /** Distinct part types in order of first appearance (e.g. ['text', 'image']). */
    partTypes: string[];
}

/**
 * MESH-IMAGE-DISPATCH: project a queue entry for a VIEW surface (mesh_status,
 * mesh_view_queue, the dashboard queue) — the persisted envelope, which may
 * carry base64 image data, is replaced by a small {@link MeshTaskInputSummary}.
 * Only the dispatch path (mesh-queue-assignment) needs the real envelope; every
 * status/view producer must go through this so an attachment never rides along
 * a status payload. Entries without an envelope are returned unchanged.
 */
export function summarizeQueueEntryInputForView<T extends { input?: MeshTaskInputEnvelope }>(
    entry: T,
): Omit<T, 'input'> & { inputSummary?: MeshTaskInputSummary } {
    if (!entry.input) return entry;
    const { input, ...rest } = entry;
    const partTypes: string[] = [];
    for (const part of input.parts) {
        const type = typeof part?.type === 'string' ? part.type : 'unknown';
        if (!partTypes.includes(type)) partTypes.push(type);
    }
    return { ...rest, inputSummary: { partCount: input.parts.length, partTypes } };
}

/**
 * QUEUE-NODE-SERIALIZATION: single source of truth for "is this task read-only?".
 *
 * Read-only classification used to be inlined as `task.taskMode === 'live_debug_readonly'`
 * at every enforcement site (node-conflict claim gate, auto-launch isolation, the
 * write/readonly cap counters, the write guardrail). That spread-out comparison is the
 * exact recurring-defect class — one site drifting from the others silently makes the same
 * task read-only at some gates and write at others, i.e. partial serialization. All sites
 * MUST call this predicate so the classification is decided in exactly one place.
 *
 * Two orthogonal inputs feed the same boolean axis (kept backward-compatible):
 *   • `readonly === true` — the explicit boolean axis (new API surface).
 *   • `taskMode === 'live_debug_readonly'` — the original enum value, preserved as an
 *     OR-fallback so existing live_debug_readonly tasks keep behaving identically.
 *
 * Accepts any task-like shape (full {@link MeshWorkQueueEntry} or a bare
 * `{ readonly?, taskMode? }`) so the daemon-core and mcp-server boundaries can share it.
 */
export function isTaskReadonly(task: { readonly?: boolean; taskMode?: MeshTaskMode | string } | null | undefined): boolean {
    if (!task) return false;
    return task.readonly === true || task.taskMode === 'live_debug_readonly';
}

/**
 * M1: THE single dependency-gate predicate. A task is claimable from a
 * dependency standpoint iff it carries no system block (`blockedReason`) AND
 * every id in `dependsOn` has reached 'completed'.
 *
 * DEPENDSON-GATE-SYMMETRY: every scheduler surface that decides whether a
 * pending task may run MUST route through this one predicate — the queue claim
 * (claimNextQueueTask), the auto-launch candidate filter
 * (maybeAutoLaunchOneQueueSession), and the cloud eager P2P push
 * (enqueue-and-push). If any surface computes dependency readiness on its own,
 * the gate goes asymmetric and a task blocked from the pull path can still be
 * eager-pushed straight to an idle session, silently bypassing its
 * prerequisites. The semantics here (all deps completed && !blocked) are the
 * invariant — do not fork them.
 */
export function taskDependenciesSatisfied(
    entry: Pick<MeshWorkQueueEntry, 'dependsOn' | 'blockedReason'>,
    statusById: Map<string, MeshTaskStatus | string>,
): boolean {
    if (entry.blockedReason) return false;
    const deps = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
    return deps.every(depId => statusById.get(depId) === 'completed');
}

/**
 * M1-4: view-time dependency state for a task — unmet dependency ids and
 * whether the task is currently claimable from a dependency standpoint.
 * Not stored (truth stays in task statuses). The `dependenciesSatisfied` field
 * is derived from {@link taskDependenciesSatisfied} so the view and the
 * scheduler gates can never disagree.
 */
export function describeTaskDependencyState(
    entry: Pick<MeshWorkQueueEntry, 'dependsOn' | 'blockedReason'>,
    statusById: Map<string, MeshTaskStatus | string>,
    depMetaById?: ReadonlyMap<string, Pick<MeshWorkQueueEntry, 'blockedReason' | 'cancelReason' | 'status'>>,
): { waitingOn: string[]; dependenciesSatisfied: boolean; dependencyFailures: MeshDependencyFailure[] } {
    const deps = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
    const waitingOn = deps.filter(depId => statusById.get(depId) !== 'completed');
    return {
        waitingOn,
        dependenciesSatisfied: taskDependenciesSatisfied(entry, statusById),
        dependencyFailures: deriveDependencyFailures(entry.dependsOn, statusById, depMetaById),
    };
}

/**
 * G6: numeric rank of a task priority (higher = pulled first). Absent/unknown → 'normal' (1).
 * Shared by the claim-candidate ordering and any surface that must sort by task priority.
 */
export function meshTaskPriorityRank(priority: unknown): number {
    switch (priority) {
        case 'high': return 2;
        case 'low': return 0;
        default: return 1; // 'normal' and any absent/unknown value
    }
}

/** G6: coerce an arbitrary input to a valid MeshTaskPriority, or undefined when not one of the three. */
export function normalizeMeshTaskPriority(value: unknown): MeshTaskPriority | undefined {
    return isMeshTaskPriority(value) ? value : undefined;
}

/**
 * G7: resolve a not_before input to a stored ISO string (or undefined when absent/invalid).
 * Accepts an ISO/date string, an absolute epoch-ms number, or a small relative-ms offset from
 * `nowMs`. Disambiguation for numbers: a value below {@link NOT_BEFORE_RELATIVE_THRESHOLD_MS}
 * (~1 year in ms) is treated as a relative offset added to now; a larger value is an absolute
 * epoch-ms timestamp. A past/negative result is normalized to now (immediately claimable).
 */
export const NOT_BEFORE_RELATIVE_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;
export function resolveNotBefore(value: unknown, nowMs: number = Date.now()): string | undefined {
    if (value === undefined || value === null) return undefined;
    let absMs: number;
    if (typeof value === 'number' && Number.isFinite(value)) {
        absMs = value < NOT_BEFORE_RELATIVE_THRESHOLD_MS ? nowMs + value : value;
    } else if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value.trim());
        if (Number.isNaN(parsed)) return undefined;
        absMs = parsed;
    } else {
        return undefined;
    }
    if (absMs <= nowMs) return new Date(nowMs).toISOString();
    return new Date(absMs).toISOString();
}

/** G7: is a task claimable now, or is it still held back by its notBefore gate? */
export function meshTaskNotBeforeReady(
    task: { notBefore?: string } | null | undefined,
    nowMs: number = Date.now(),
): boolean {
    const nb = task?.notBefore;
    if (!nb) return true;
    const parsed = Date.parse(nb);
    if (Number.isNaN(parsed)) return true; // unparseable → do not block (fail-open)
    return parsed <= nowMs;
}
