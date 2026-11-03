/** Inline/cloud snapshots cannot override this machine's durable project cut. */
import { existsSync } from 'node:fs';
import { getMeshConfigPath, readMeshConfigFromDisk } from '../../config/mesh-config-store.js';
import { MeshRuntimeStore } from '../mesh-runtime-store.js';

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
        if (project && (project.meshHost?.handoffFence !== undefined || project.meshHost?.handedOffTo !== undefined)) throw new Error('persisted project authority is fenced or transferred');
        // Retains the cut even if meshes.json is lost or a stale inline project
        // is supplied. Missing storage never implies permission to duplicate.
        const fence = MeshRuntimeStore.getInstance().db.prepare('SELECT 1 FROM mesh_host_write_fences WHERE mesh_id=?').get(meshId);
        if (fence) throw new Error('durable project write fence is held');
        const pending = MeshRuntimeStore.getInstance().db.prepare("SELECT epoch,phase FROM mesh_host_handoff WHERE mesh_id=? AND role='source' ORDER BY epoch DESC LIMIT 1").get(meshId) as { epoch: number; phase: string } | undefined;
        if (pending && ['frozen', 'exporting', 'exported', 'awaiting_ack', 'acked', 'activating', 'uncertain', 'committed'].includes(pending.phase)
            && (!project || (project.meshHost?.hostEpoch ?? 0) <= pending.epoch)) throw new Error('durable source authority intent is held');
        return null;
    } catch {
        return { success: false, code: 'mesh_host_handoff_fenced', error: 'Persisted project host authority is unavailable, fenced or transferred.' };
    }
}
