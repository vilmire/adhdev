import { classifySessionStatus } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { maintenanceAutoLaunches } from '../mesh/mesh-queue-autolaunch.js';
import { maintenanceQueueLaunches } from '../mesh/mesh-queue-trigger.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { readState, registerNewWorkHoldDaemonComponents } from './new-work-hold-storage.js';
import { LOG } from '../logging/logger.js';
import {
    NewWorkHoldPhase,
    NewWorkHoldQueueRowSummary,
    NewWorkHoldDrainSummary,
    PersistedHoldState,
    registeredDaemonComponents,
    resolveNow,
    readOptionalString,
    normalizeMeshIds,
    emptyDrainSummary,
    writeState,
} from './new-work-hold-storage.js';

export function collectNewWorkHoldDrainSummary(options?: {
    meshId?: string | null;
    meshIds?: string[];
    active?: boolean;
    now?: number;
    components?: Partial<DaemonComponents> | null;
}): NewWorkHoldDrainSummary {
    const now = resolveNow(options?.now);
    const scopeMeshIds = normalizeMeshIds(options?.meshIds, options?.meshId);
    const hasMeshFilter = scopeMeshIds.length > 0;
    const meshSet = new Set(scopeMeshIds);

    const activeClaims: NewWorkHoldQueueRowSummary[] = [];
    const heldPendingQueue: NewWorkHoldQueueRowSummary[] = [];
    const openAttempts: Array<{ attempt_id: string; mesh_id: string; state: string }> = [];
    const assignedTaskIds = new Set<string>();
    const openAttemptIds = new Set<string>();
    const activeSessionIds = new Set<string>();

    try {
        const db = ((MeshRuntimeStore as unknown as { instance?: { db?: unknown } }).instance?.db ?? MeshRuntimeStore.getInstance().db) as any;
        if (db) {
            const rows = db.prepare("SELECT id,mesh_id,status,assigned_node_id,assigned_session_id,updated_at FROM mesh_queue WHERE status IN ('assigned','pending') ORDER BY id").all() as NewWorkHoldQueueRowSummary[];
            for (const row of rows) {
                if (hasMeshFilter && (!row.mesh_id || !meshSet.has(row.mesh_id))) continue;
                if (row.status === 'assigned') {
                    activeClaims.push(row);
                    assignedTaskIds.add(row.id);
                    if (row.assigned_session_id) activeSessionIds.add(row.assigned_session_id);
                } else if (row.status === 'pending') {
                    heldPendingQueue.push(row);
                }
            }
            try {
                const attempts = db.prepare('SELECT attempt_id,mesh_id,session_id,state,terminal_outcome FROM turn_attempts WHERE terminal_outcome IS NULL ORDER BY attempt_id').all() as Array<Record<string, unknown>>;
                for (const att of attempts) {
                    const mId = readOptionalString(att.mesh_id);
                    if (hasMeshFilter && (!mId || !meshSet.has(mId))) continue;
                    const aId = readOptionalString(att.attempt_id);
                    const state = readOptionalString(att.state) ?? 'active';
                    if (aId) {
                        openAttempts.push({ attempt_id: aId, mesh_id: mId ?? '', state });
                        openAttemptIds.add(aId);
                    }
                    const sId = readOptionalString(att.session_id);
                    if (sId) activeSessionIds.add(sId);
                }
            } catch { /* turn_attempts table may not exist in minimal unit fixtures */ }
        }
    } catch { /* store might not be initialized */ }

    let activeLaunches: unknown[] = [];
    try {
        const bg = maintenanceQueueLaunches().filter((x: any) => x.count > 0 && (!hasMeshFilter || meshSet.has(x.meshId)));
        const locks = maintenanceAutoLaunches();
        const lockNodes = hasMeshFilter ? locks.nodes.filter((k) => scopeMeshIds.some((m) => k.startsWith(`${m}::`))) : locks.nodes;
        const lockTasks = hasMeshFilter ? locks.tasks.filter((k) => scopeMeshIds.some((m) => k.startsWith(`${m}::`))) : locks.tasks;
        activeLaunches = [...bg, ...lockNodes, ...lockTasks];
    } catch { /* best-effort launch lock read */ }

    const activeSubmits: Array<{ sessionId: string; pending: boolean }> = [];
    const components = options?.components ?? registeredDaemonComponents;
    if (components?.cliManager?.adapters) {
        for (const [sessionId, adapter] of components.cliManager.adapters.entries()) {
            try {
                const instance = components.instanceManager?.getInstance?.(sessionId);
                const settings = instance?.getState?.()?.settings as Record<string, unknown> | undefined;
                if (hasMeshFilter) {
                    const sessionMeshId = readOptionalString(settings?.meshNodeFor) ?? readOptionalString(settings?.meshCoordinatorFor);
                    if (!sessionMeshId || !meshSet.has(sessionMeshId)) continue;
                }
                if (typeof adapter?.hasInFlightSubmit === 'function' && adapter.hasInFlightSubmit() === true) {
                    activeSubmits.push({ sessionId, pending: true });
                    activeSessionIds.add(sessionId);
                }
                const rawStatus = adapter?.getStatus?.({ allowParse: false })?.status ?? instance?.getState?.()?.status;
                const statusClass = classifySessionStatus(rawStatus);
                const activeTaskId = readOptionalString(settings?.meshActiveTaskId);
                if (activeTaskId) assignedTaskIds.add(activeTaskId);
                if (
                    statusClass === 'working'
                    || statusClass === 'blocked'
                    || rawStatus === 'generating'
                    || rawStatus === 'waiting_approval'
                    || Boolean(activeTaskId)
                ) {
                    activeSessionIds.add(sessionId);
                }
            } catch { /* best-effort adapter inspection */ }
        }
    }

    const inFlightCount = Math.max(
        activeClaims.length + openAttempts.length + activeLaunches.length + activeSubmits.length,
        assignedTaskIds.size + openAttemptIds.size + activeLaunches.length,
    );
    const drained = inFlightCount === 0 && activeSessionIds.size === 0;
    const draining = !drained;
    return {
        inFlightCount: draining ? Math.max(1, inFlightCount) : 0,
        activeClaims,
        heldPendingQueue,
        openAttempts,
        activeLaunches,
        activeSubmits,
        drained,
        draining,
        sealed: Boolean(options?.active) && drained,
        assignedQueueTasks: assignedTaskIds.size,
        openTurnAttempts: openAttemptIds.size,
        activeSessionTurns: activeSessionIds.size,
        inFlightAutoLaunches: activeLaunches.length,
        pendingQueueTasks: heldPendingQueue.length,
        assignedTaskIds: [...assignedTaskIds].sort(),
        openAttemptIds: [...openAttemptIds].sort(),
        activeSessionIds: [...activeSessionIds].sort(),
        checkedAt: now,
    };
}

export function reconcileHoldLifecycle(
    configDir: string | undefined,
    inputState: PersistedHoldState,
    now: number,
    options?: { components?: Partial<DaemonComponents> | null; autoExtend?: boolean; persist?: boolean },
): { state: PersistedHoldState; drain: NewWorkHoldDrainSummary } {
    const persist = options?.persist === true;
    const state: PersistedHoldState = structuredClone(inputState);
    if (!state.active) return { state, drain: emptyDrainSummary(now, false) };

    const baseRevision = state.revision;
    let dirty = false;

    const drain = collectNewWorkHoldDrainSummary({
        meshIds: state.scope === 'mesh' ? state.meshIds : undefined,
        active: state.active,
        now,
        components: options?.components,
    });
    const allowAutoExtend = options?.autoExtend !== false && state.autoExtend !== false;
    const remainingBudget = Math.max(0, state.maxTotalExtensionMs - state.autoExtendedMs);
    if (
        allowAutoExtend &&
        drain.draining &&
        typeof state.expiresAt === 'number' &&
        typeof state.ttlMs === 'number' &&
        state.ttlMs > 0 &&
        state.expiresAt - now <= Math.max(1000, Math.floor(state.ttlMs / 3)) &&
        state.autoExtendCount < state.maxAutoExtendCount &&
        remainingBudget > 0
    ) {
        const grantMs = Math.min(state.ttlMs, remainingBudget);
        state.expiresAt = now + grantMs;
        state.autoExtendCount += 1;
        state.autoExtendedMs += grantMs;
        state.updatedAt = now;
        if (persist && (state.autoExtendCount >= state.maxAutoExtendCount || state.autoExtendedMs >= state.maxTotalExtensionMs)) {
            LOG.warn('NewWorkHold', `Hold ${state.holdId} reached its auto-extension cap; the fence will open at ${state.expiresAt}. Extend manually to keep draining.`);
        }
        dirty = true;
    }

    if (typeof state.expiresAt === 'number' && now >= state.expiresAt) {
        const capReached = state.autoExtendCount >= state.maxAutoExtendCount || state.autoExtendedMs >= state.maxTotalExtensionMs;
        if (persist && capReached) LOG.warn('NewWorkHold', `Hold ${state.holdId} expired at its auto-extension cap; assigned work may still be running (${drain.inFlightCount} in flight).`);
        state.lastExpiredHoldId = state.holdId;
        state.active = false;
        state.status = 'expired';
        state.phase = 'inactive';
        state.sealed = false;
        state.expiredAt = state.expiresAt;
        state.releasedAt = now;
        state.releasedReason = capReached ? 'ttl_expired_auto_extend_cap_reached' : 'ttl_expired';
        state.updatedAt = now;
        state.revision += 1;
        dirty = true;
    }

    if (state.active) {
        const nextPhase: NewWorkHoldPhase = drain.drained ? 'sealed' : 'draining';
        const nextSealed = nextPhase === 'sealed';
        if (state.phase !== nextPhase || state.status !== nextPhase || state.sealed !== nextSealed) {
            state.phase = nextPhase;
            state.status = nextPhase;
            state.sealed = nextSealed;
            state.sealedAt = nextSealed ? (state.sealedAt ?? now) : null;
            state.updatedAt = now;
            dirty = true;
        }
    }

    if (dirty && state.revision === baseRevision) state.revision += 1;
    if (dirty && persist) {
        const writeRes = writeState(configDir, state, { expectedRevision: baseRevision, now });
        if (writeRes.conflict && writeRes.currentDiskState) {
            return { state: writeRes.currentDiskState, drain: { ...drain, sealed: writeRes.currentDiskState.active && drain.drained } };
        }
    }
    return { state, drain: { ...drain, sealed: state.active && drain.drained } };
}

export function holdAppliesToMesh(state: PersistedHoldState, meshId?: string | null): boolean {
    if (!state.active) return false;
    if (state.scope === 'daemon') return true;
    const target = readOptionalString(meshId);
    return Boolean(target && state.meshIds.includes(target));
}

/** Daemon-owned renewal: independent of owner status polling. Disposed with S8 loops. */
export function startNewWorkHoldLifecycle(components: Partial<DaemonComponents>): () => void {
    registerNewWorkHoldDaemonComponents(components);
    const tick = () => {
        try {
            const now = resolveNow();
            const state = readState(undefined, now);
            if (state.active) reconcileHoldLifecycle(undefined, state, now, { components, autoExtend: true, persist: true });
        } catch (error) { LOG.warn('NewWorkHold', `Lifecycle tick failed: ${String(error)}`); }
    };
    tick();
    const timer = setInterval(tick, 250);
    timer.unref?.();
    return () => { clearInterval(timer); registerNewWorkHoldDaemonComponents(null); };
}
