// Review-in-task §9.2: stage transitions and review-child outcomes must not wake the coordinator — only the
// parent's terminal does. The deliver consumer (turn-ledger/deliver.ts) asks this leaf, right before submit,
// whether a turn notice belongs to a stage-internal row. The lookup is injected so the turn ledger keeps no
// dependency on the queue store.

import type { NotifyKind } from '@adhdev/mesh-shared';

export type StageRowKind = 'child' | 'held_parent' | null;
type Lookup = (meshId: string, taskId: string) => StageRowKind;

let lookup: Lookup | null = null;
export function setStageNoticeLookup(fn: Lookup | null): void { lookup = fn; }

const CHILD_SILENT: ReadonlySet<NotifyKind> = new Set(['completed', 'failed', 'blocked', 'cancelled', 'stopped', 'late_completion', 'progress', 'no_progress', 'candidate']);
const PARENT_SILENT: ReadonlySet<NotifyKind> = new Set(['completed', 'late_completion', 'candidate']);

/** True → claim the notice as suppressed (`stage_internal`) instead of submitting it. */
export function isStageInternalNotice(meshId: string, taskId: string | null | undefined, notify: NotifyKind): boolean {
    if (!lookup || !taskId) return false;
    let kind: StageRowKind;
    try { kind = lookup(meshId, taskId); } catch { return false; }
    if (kind === 'child') return CHILD_SILENT.has(notify);
    if (kind === 'held_parent') return PARENT_SILENT.has(notify);
    return false;
}
