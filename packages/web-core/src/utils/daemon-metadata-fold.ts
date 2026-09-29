/**
 * daemon-metadata-fold — materialize the `daemon.metadata` lane.
 *
 * The daemon sends a snapshot first and then keyed deltas (only what changed —
 * see daemon-core's topic-registry and mesh-shared's keyed-status-delta).
 * Consumers never handle a delta: SubscriptionManager folds each one into the
 * held snapshot here and delivers the materialized {@link DaemonMetadataUpdate}.
 *
 * Returns `null` when a delta cannot be applied — no held snapshot, or a seq
 * gap — so the caller re-subscribes (the daemon answers with a fresh snapshot).
 */
import type { DaemonMetadataDelta, DaemonMetadataUpdate, DaemonMetadataWireUpdate } from '@adhdev/daemon-core'
import { foldKeyedStatus, type KeyedStatusBody, type KeyedStatusDelta } from '@adhdev/mesh-shared'

function isDelta(update: DaemonMetadataWireUpdate): update is DaemonMetadataDelta {
    return (update as { mode?: unknown }).mode === 'delta'
}

export function materializeDaemonMetadataUpdate(
    held: DaemonMetadataUpdate | undefined,
    update: DaemonMetadataWireUpdate,
): DaemonMetadataUpdate | null {
    if (!isDelta(update)) return { ...update, mode: 'snapshot' }
    if (!held || held.status === undefined) return null
    if (typeof held.seq === 'number' && update.seq !== held.seq + 1) return null
    const { topic: _t, key: _k, mode: _m, seq: _s, timestamp: _ts, ...heldBody } = held
    const {
        topic: _dt, key: _dk, mode: _dm, seq: _ds, timestamp: _dts, daemonId: _dd,
        ...delta
    } = update
    const folded = foldKeyedStatus(heldBody as unknown as KeyedStatusBody, delta as KeyedStatusDelta) as unknown as Omit<DaemonMetadataUpdate, 'topic' | 'key' | 'mode' | 'seq' | 'timestamp'>
    return {
        ...folded,
        topic: 'daemon.metadata',
        key: update.key,
        mode: 'snapshot',
        daemonId: update.daemonId || held.daemonId,
        // The daemon's clock for "this state was current at": entry freshness
        // ordering (ides-reconcile) compares remote timestamps.
        status: { ...folded.status, timestamp: update.timestamp },
        seq: update.seq,
        timestamp: update.timestamp,
    }
}
