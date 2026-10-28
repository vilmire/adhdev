import { sessionIsStopping } from './mesh-session-stop-fence.js';
/** Explicit reuse before any spawn budget/model-slot admission, including review tasks. */
import { readText, sessionIdsEquivalent, meshNodeIdMatches, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { sessionHasActiveAssignment } from './mesh-scheduling-fitness.js';
import { isSafeIdleTaskSession } from './mesh-session-lifetime.js';

// Only positive running evidence can skip a projection. A periodic full view
// handles missed FSM edges; fresh idle evidence is eligible immediately.
const busyProjectionCheckedAt = new WeakMap<object, number>();
const BUSY_PROJECTION_RECHECK_MS = 20_000;

type Claim = (components: DaemonComponents, meshId: string, nodeId: string, sessionId: string, provider: string,
    routing?: any, trace?: any, trigger?: string) => boolean;
export function reuseIdleTaskSession(components: DaemonComponents, meshId: string, task: MeshWorkQueueEntry, nodes: readonly MeshNodeIdentified[], claim: Claim): 'claimed' | 'none' {
    const candidates: Array<{ nodeId: string; sessionId: string; provider: string }> = [];
    for (const inst of components.instanceManager?.getByCategory('cli') ?? []) {
        const live = (inst as { settings?: Record<string, unknown> }).settings;
        if (live && typeof live === 'object') {
            if (readText(live.meshNodeFor) !== meshId) continue;
            const role = readText(live.meshRole || live.role).toLowerCase();
            const launch = live.launchRecord as { spawnedForTaskId?: unknown; launchedBy?: unknown; roleLaunch?: { role?: string } } | undefined;
            if (live.meshCoordinatorFor || live.assistant || live.isAssistant || live.spawnedForTaskId === null
                || role === 'coordinator' || role === 'assistant' || readText(live.launchedBy).toLowerCase() === 'assistant'
                || launch?.spawnedForTaskId === null || launch?.launchedBy === 'assistant'
                || ['coordinator', 'assistant'].includes(launch?.roleLaunch?.role ?? '')) continue;
            const nodeId = readText(live.meshNodeId);
            if (!nodeId || !nodes.some(node => meshNodeIdMatches(node, nodeId))) continue;
            if (task.targetNodeId && !meshNodeIdMatches({ nodeId }, task.targetNodeId)) continue;
            try {
                const hot = inst.getHotChatSessionState?.();
                if (readText((hot as { status?: unknown })?.status) === 'generating'
                    && (inst as { lastStatus?: unknown }).lastStatus === 'generating') {
                    const now = Date.now();
                    const checkedAt = busyProjectionCheckedAt.get(inst);
                    if (checkedAt === undefined) busyProjectionCheckedAt.set(inst, now);
                    if (checkedAt === undefined || (now >= checkedAt && now - checkedAt < BUSY_PROJECTION_RECHECK_MS)) continue;
                }
            } catch { /* unknown hot state must use the full safety verdict */ }
        }
        const s = inst.getState();
        busyProjectionCheckedAt.set(inst, Date.now());
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
        // An idle announcement is not mesh membership. Use the same merged
        // config/cache view as the ordinary drain before attempting reuse.
        if (!nodes.some(node => meshNodeIdMatches(node, c.nodeId))) continue;
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
