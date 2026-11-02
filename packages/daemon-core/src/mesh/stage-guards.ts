import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { isStageChild } from './stage-state.js';

const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled']);

/**
 * A review child the pipeline still owns: its parent exists and has not ended. A child whose
 * parent is gone or already terminal is an orphan nothing will ever settle, so the coordinator
 * may cancel or requeue it like any task.
 */
export function isManagedStageChild(meshId: string, row: Parameters<typeof isStageChild>[0]): boolean {
    if (!isStageChild(row)) return false;
    const parent = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, row!.parentTaskId!);
    return !!parent && !TERMINAL.has(parent.status);
}

/** §11: a coordinator may not requeue/cancel a review child directly — the pipeline owns it. */
export function assertNotStageChild(meshId: string, taskId: string): void {
    const row = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
    if (isManagedStageChild(meshId, row)) throw new Error(`stage_child_managed: task '${taskId}' is a review stage of '${row!.parentTaskId}'; use mesh_task_stage_decide on the parent`);
}
