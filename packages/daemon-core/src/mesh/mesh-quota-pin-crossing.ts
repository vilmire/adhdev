/**
 * Owner decision A (2026-11-03, mission 56d8abb5): a task pinned to a provider (`provider=<type>` in
 * requiredTags) keeps passing the quota RESERVE line when it is claimed — the pin is the owner's explicit
 * choice. What changes is that the coordinator is told ONCE per crossing, so pinned work no longer eats
 * into a provider's reserve without anyone knowing.
 *
 * "Crossing" = the claim gate moving from clear (or never evaluated) to pin-overridden for one
 * (mesh, node, session, provider, task). Repeated claim ticks while the block persists stay silent; the
 * entry is forgotten when the gate clears, so a later re-entry notifies again.
 *
 * Only reserve blocks reach here (quotaBlockPinOverridable). A confirmed exhaustion is never passed by a
 * pin, so it never produces this notice — it produces a block.
 */
import { LOG } from '../logging/logger.js';
import { getMachineId } from '../config/config.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import type { ProviderQuotaGateBlock } from './mesh-quota-routing.js';

const notified = new Set<string>();
const NOTIFIED_MAX = 500;

function key(meshId: string, nodeId: string, sessionId: string, providerType: string, taskId: string): string {
    return `${meshId}:${nodeId}:${sessionId}:${providerType}:${taskId}`;
}

export function resetPinCrossingForTests(): void { notified.clear(); }

/** Notify the coordinator the first time a pinned claim passes the reserve. Returns true when a notice was queued. */
export function notePinnedClaimCrossedReserve(args: {
    meshId: string; nodeId: string; sessionId: string; providerType: string; taskId: string; block: ProviderQuotaGateBlock;
}): boolean {
    const k = key(args.meshId, args.nodeId, args.sessionId, args.providerType, args.taskId);
    if (notified.has(k)) return false;
    if (notified.size >= NOTIFIED_MAX) {
        const oldest = notified.values().next().value;
        if (oldest !== undefined) notified.delete(oldest);
    }
    notified.add(k);
    const { block } = args;
    const message = `[System] Pinned task ${args.taskId} was claimed by ${args.providerType} on node ${args.nodeId} even though that provider is below the quota reserve `
        + `(${block.remainingPercent.toFixed(1)}% ${block.window} left, reserve ${block.thresholdPercent}%). A provider pin passes the reserve by design; `
        + `this is the one notice for this crossing. If you would rather keep the reserve, cancel or requeue the task without the pin.`;
    try {
        const daemonId = String(getMachineId() || '').trim();
        return notifyMeshCoordinator({
            event: 'mesh:quota_reserve_crossed',
            meshId: args.meshId,
            nodeLabel: args.nodeId,
            nodeId: args.nodeId,
            metadataEvent: {
                source: 'quota_pin_reserve_crossing', taskId: args.taskId, providerType: args.providerType,
                window: block.window, remainingPercent: block.remainingPercent, thresholdPercent: block.thresholdPercent,
            },
            coordinatorMessage: message,
            queuedAt: Date.now(),
            ...(daemonId ? { targetCoordinatorDaemonId: daemonId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to notify coordinator of pinned quota-reserve crossing for task ${args.taskId}: ${e?.message || e}`);
        return false;
    }
}

/** The gate cleared for this (session, provider): the next crossing is a new one. */
export function forgetPinCrossings(meshId: string, nodeId: string, sessionId: string, providerType: string): void {
    const prefix = `${meshId}:${nodeId}:${sessionId}:${providerType}:`;
    for (const k of notified) if (k.startsWith(prefix)) notified.delete(k);
}
