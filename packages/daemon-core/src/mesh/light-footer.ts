/** LIGHT-TASK: the footer input for a dispatched light row (workspace path, base SHAs, owned paths). */
import type { WorkerProtocolFooterInput } from '@adhdev/mesh-shared';
import { getLightWorkspace } from './mesh-light-workspace-store.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

export function resolveLightFooterInput(task: Pick<MeshWorkQueueEntry, 'light' | 'lightWorkspaceId' | 'ownedPaths'>): WorkerProtocolFooterInput['light'] | undefined {
    if (!task.light || !task.lightWorkspaceId) return undefined;
    try {
        const row = getLightWorkspace(MeshRuntimeStore.getInstance().db, task.lightWorkspaceId);
        if (!row) return undefined;
        const ossBase = row.submoduleBases['oss'];
        return {
            workspace: row.path,
            baseSha: row.rootBaseSha,
            ...(ossBase ? { ossBaseSha: ossBase } : {}),
            ownedPaths: (task.ownedPaths?.paths ?? []).map(p => (p.subtree ? `${p.path.replace(/\/+$/, '')}/**` : p.path)),
        };
    } catch { return undefined; }
}
