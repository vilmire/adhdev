import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { isStageChild } from './stage-state.js';

/** §11: a coordinator may not requeue/cancel a review child directly — the pipeline owns it. */
export function assertNotStageChild(meshId: string, taskId: string): void {
    const row = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
    if (isStageChild(row)) throw new Error(`stage_child_managed: task '${taskId}' is a review stage of '${row!.parentTaskId}'; use mesh_task_stage_decide on the parent`);
}
