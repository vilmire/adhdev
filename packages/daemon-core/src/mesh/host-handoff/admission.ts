/** Inline/cloud snapshots cannot override this machine's durable project cut. */
import { existsSync } from 'node:fs';
import { getMeshConfigPath, readMeshConfigFromDisk } from '../../config/mesh-config-store.js';
import { MeshRuntimeStore } from '../mesh-runtime-store.js';
import { resolveMeshHostStatus } from '../mesh-host-ownership.js';

const transitions = new Set<string>();
/** Refuse concurrent launch/stop instead of leaving a queued late effect after
 * the caller has timed out or aborted. Other projects have independent slots. */
export async function withCoordinatorTransition<T>(meshId: string, operation: () => Promise<T>): Promise<T> {
    if (transitions.has(meshId)) throw Object.assign(new Error('coordinator_transition_busy'), { code: 'coordinator_transition_busy' });
    transitions.add(meshId);
    try { return await operation(); } finally { transitions.delete(meshId); }
}

export function durableHandoffAdmissionFailure(meshId: string): { success: false; code: string; error: string } | null {
    try {
        const config = readMeshConfigFromDisk();
        if (!config && existsSync(getMeshConfigPath())) throw new Error('project authority unavailable');
        const project = config?.meshes.find(m => m.id === meshId);
        if (project && !resolveMeshHostStatus(project).canOwnCoordinator) throw new Error('persisted project authority is fenced or transferred');
        // Retains the cut even if meshes.json is lost or a stale inline project
        // is supplied. Missing storage never implies permission to duplicate.
        const fence = MeshRuntimeStore.getInstance().db.prepare('SELECT 1 FROM mesh_host_write_fences WHERE mesh_id=?').get(meshId);
        if (fence) throw new Error('durable project write fence is held');
        return null;
    } catch {
        return { success: false, code: 'mesh_host_handoff_fenced', error: 'Persisted project host authority is unavailable, fenced or transferred.' };
    }
}
