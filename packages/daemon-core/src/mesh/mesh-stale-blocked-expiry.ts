// Retires queue rows that stayed `blocked` (terminal: the worker reported it
// could not finish) for days with nobody acting on them. Without this they
// accumulate until the 30-day terminal retention prune. Host daemon only —
// the housekeeping tick calls it for hosted meshes.

import { getMachineId } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import { readText } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { cancelTask } from './mesh-work-queue.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

export const STALE_BLOCKED_TASK_MS = 3 * 24 * 60 * 60 * 1000;
/** Per-mesh minimum spacing between sweeps. */
export const STALE_BLOCKED_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** Max rows cancelled per sweep (the rest are picked up by later sweeps). */
export const STALE_BLOCKED_SWEEP_CAP = 50;
export const STALE_BLOCKED_REASON = 'stale_blocked_expired: blocked for 3 days with no follow-up';

/** ADHDEV_STALE_BLOCKED_TASK_MS: 0 disables; unset/invalid = default. */
export function resolveStaleBlockedTaskMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.ADHDEV_STALE_BLOCKED_TASK_MS;
    if (raw === undefined || raw.trim() === '') return STALE_BLOCKED_TASK_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : STALE_BLOCKED_TASK_MS;
}

export interface StaleBlockedSweepState {
    lastStaleBlockedSweepAt?: Record<string, number>;
}

/** A live follow-up: a non-terminal row that depends on, or is a child of, this one. */
function hasLiveFollowUp(row: MeshWorkQueueEntry, all: readonly MeshWorkQueueEntry[]): boolean {
    return all.some(o => (o.status === 'pending' || o.status === 'assigned')
        && (o.parentTaskId === row.id || (Array.isArray(o.dependsOn) && o.dependsOn.includes(row.id))));
}

/** Returns the ids cancelled. Never throws. */
export function sweepStaleBlockedTasks(meshId: string, state: StaleBlockedSweepState, nowMs: number = Date.now()): string[] {
    const ttl = resolveStaleBlockedTaskMs();
    if (ttl <= 0) return [];
    const last = (state.lastStaleBlockedSweepAt ??= {});
    if (last[meshId] !== undefined && nowMs - last[meshId] < STALE_BLOCKED_SWEEP_INTERVAL_MS) return [];
    last[meshId] = nowMs;
    const cancelled: string[] = [];
    try {
        const store = MeshRuntimeStore.getInstance();
        const blocked = store.getQueueEntries(meshId, ['blocked']);
        if (blocked.length === 0) return [];
        const live = store.getQueueEntries(meshId, ['pending', 'assigned']);
        for (const row of blocked) {
            if (cancelled.length >= STALE_BLOCKED_SWEEP_CAP) break;
            const updatedMs = Date.parse(row.updatedAt);
            if (!Number.isFinite(updatedMs) || nowMs - updatedMs < ttl) continue;
            if (hasLiveFollowUp(row, live)) continue;
            try {
                if (cancelTask(meshId, row.id, { reason: STALE_BLOCKED_REASON })) cancelled.push(row.id);
            } catch (e: any) {
                LOG.warn('MeshQueue', `Stale-blocked cancel failed for task ${row.id} (mesh ${meshId}): ${e?.message || e}`);
            }
        }
    } catch (e: any) {
        LOG.warn('MeshQueue', `Stale-blocked sweep failed for mesh ${meshId}: ${e?.message || e}`);
    }
    if (cancelled.length > 0) {
        const shown = cancelled.slice(0, 5).map(id => id.slice(0, 8)).join(', ');
        const coordinatorMessage = `[System] Retired ${cancelled.length} task${cancelled.length === 1 ? '' : 's'} that stayed blocked for over 3 days: ${shown}${cancelled.length > 5 ? '…' : ''}`;
        try {
            const target = readText(getMachineId());
            notifyMeshCoordinator({
                event: 'mesh:dispatch_blocked',
                meshId,
                nodeLabel: meshId,
                eventId: `stale_blocked_expired:${meshId}:${nowMs}`,
                metadataEvent: { source: 'mesh_stale_blocked_expiry', reason: 'stale_blocked_expired', count: cancelled.length, coordinatorMessage },
                coordinatorMessage,
                queuedAt: nowMs,
                ...(target ? { targetCoordinatorDaemonId: target } : {}),
            });
        } catch (e: any) {
            LOG.warn('MeshQueue', `Failed to surface stale-blocked retirement (mesh ${meshId}): ${e?.message || e}`);
        }
    }
    return cancelled;
}
