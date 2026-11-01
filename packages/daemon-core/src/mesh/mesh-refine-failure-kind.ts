// ---------------------------------------------------------------------------
// mesh-refine-failure-kind — present Refinery job failures as their own kind
// ---------------------------------------------------------------------------
// A failed Refinery (merge) job is stored as a `task_failed` row with no task
// (`payload.source === 'refine_mesh_node_async_job'`). Every refine reader
// (status, zombie sweep, terminal guard) keys on that stored shape, so the
// STORED kind stays. What readers of the task history see is different: a
// refine gate failure is not a task failure, and counting it as one inflated
// the failure view (50 of 168 rows in one RCA window). At the presentation
// edge (`ledger_query` / mesh_task_history) those rows are therefore shown as
// `refine_job_failed`, and a `task_failed` filter no longer returns them.

import type { MeshLedgerEntry } from './mesh-ledger.js';
import { isRefineJobRecord } from './mesh-local-records.js';

export const REFINE_JOB_FAILED_KIND = 'refine_job_failed';

export function isRefineJobFailure(entry: Pick<MeshLedgerEntry, 'kind' | 'payload'>): boolean {
    return entry.kind === 'task_failed' && isRefineJobRecord(entry);
}

/** Kinds to read from the store for a requested kind filter (`refine_job_failed` is read as `task_failed`). */
export function storedKindsForRequest(kinds: readonly string[] | undefined): string[] | undefined {
    if (!kinds || kinds.length === 0) return undefined;
    return [...new Set(kinds.map((k) => (k === REFINE_JOB_FAILED_KIND ? 'task_failed' : k)))];
}

/**
 * Apply the presentation split to rows read for `requested` kinds: refine job
 * failures become `refine_job_failed`, and are dropped unless the request was
 * unfiltered or named that kind; a `refine_job_failed`-only request also drops
 * the genuine task failures it had to read alongside.
 */
export function presentRefineFailureKinds(entries: MeshLedgerEntry[], requested: readonly string[] | undefined): MeshLedgerEntry[] {
    const wantsRefine = !requested || requested.length === 0 || requested.includes(REFINE_JOB_FAILED_KIND);
    const wantsTask = !requested || requested.length === 0 || requested.includes('task_failed');
    const out: MeshLedgerEntry[] = [];
    for (const entry of entries) {
        if (isRefineJobFailure(entry)) {
            if (wantsRefine) out.push({ ...entry, kind: REFINE_JOB_FAILED_KIND as MeshLedgerEntry['kind'] });
        } else if (entry.kind !== 'task_failed' || wantsTask) {
            out.push(entry);
        }
    }
    return out;
}
