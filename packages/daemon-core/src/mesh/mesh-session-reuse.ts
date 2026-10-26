import { sessionIsStopping } from './mesh-session-stop-fence.js';
/** Explicit reuse before any spawn budget/model-slot admission, including review tasks. */
import { readText, sessionIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { sessionHasActiveAssignment } from './mesh-scheduling-fitness.js';
import { isSafeIdleTaskSession } from './mesh-session-lifetime.js';

type Claim = (components: DaemonComponents, meshId: string, nodeId: string, sessionId: string, provider: string,
    routing?: any, trace?: any, trigger?: string) => boolean;
export function reuseIdleTaskSession(components: DaemonComponents, meshId: string, task: MeshWorkQueueEntry, claim: Claim): 'claimed' | 'none' {
    const candidates: Array<{ nodeId: string; sessionId: string; provider: string }> = [];
    for (const inst of components.instanceManager?.getByCategory('cli') ?? []) {
        const s = inst.getState();
        const settings = s.settings ?? {};
        if (settings.meshNodeFor !== meshId || !isSafeIdleTaskSession(s, settings)) continue;
        candidates.push({ nodeId: readText(settings.meshNodeId), sessionId: readText(s.instanceId), provider: readText(s.type) });
    }
    for (const remote of MeshRuntimeStore.getInstance().getRemoteIdleSessions?.(meshId) ?? []) {
        // Fresh agent:ready is the existing remote claim authority. Keep its extra
        // prompt/role evidence when present; actual eligibility is still the atomic claim's.
        if (!isSafeIdleTaskSession({ status: 'idle', ...remote.metadata, settings: remote.metadata?.settings ?? remote.metadata }, remote.metadata)) continue;
        candidates.push({ nodeId: remote.nodeId, sessionId: remote.sessionId, provider: remote.providerType });
    }
    for (const c of candidates) {
        if (!c.nodeId || !c.sessionId || !c.provider) continue;
        if (task.targetNodeId && !meshNodeIdMatches({ nodeId: c.nodeId }, task.targetNodeId)) continue;
        if (task.targetSessionId && !sessionIdsEquivalent(c.sessionId, task.targetSessionId)) continue;
        if (sessionIsStopping(MeshRuntimeStore.getInstance().db, c.sessionId)) continue;
        if (sessionHasActiveAssignment(meshId, c.sessionId)) continue;
        // All branch/tag, provider/model, review independence, slot capacity and
        // checkpoint admission remains in the ordinary atomic claim path.
        if (claim(components, meshId, c.nodeId, c.sessionId, c.provider, undefined, undefined, 'auto_launch_reuse')) return 'claimed';
    }
    return 'none';
}
