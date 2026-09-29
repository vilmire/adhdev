/**
 * keyed-topic-fold — THE fold for both keyed lanes (`daemon.metadata` and
 * `mesh.status`; data-path audit 2026-09-29 P1-4: one engine, one fold).
 *
 * The daemon sends a snapshot first and then keyed deltas (only what changed —
 * see daemon-core's topic-registry `deliverKeyed` and mesh-shared's
 * keyed-doc-delta). Consumers never handle a delta: SubscriptionManager folds
 * each one into the held snapshot here and delivers the materialized snapshot.
 *
 * Returns `null` when a delta cannot be applied — no held snapshot, or a seq
 * gap — so the caller re-subscribes (the daemon answers with a fresh snapshot).
 */
import type {
    DaemonMetadataUpdate,
    DaemonMetadataWireUpdate,
    MeshStatusSnapshotUpdate,
    MeshStatusWireUpdate,
} from '@adhdev/daemon-core'
import { DAEMON_METADATA_DOC_SPEC, foldKeyedDoc, MESH_STATUS_DOC_SPEC, type KeyedDocDelta, type KeyedDocSpec } from '@adhdev/mesh-shared'

interface KeyedLane<S extends { seq: number }, W extends { seq: number; mode?: string }> {
    spec: KeyedDocSpec
    /** The held snapshot's document (undefined = nothing to fold into). */
    docOf(held: S): Record<string, unknown> | undefined
    deltaOf(update: W): KeyedDocDelta
    /** The materialized snapshot frame for a folded document. */
    snapshotOf(doc: Record<string, unknown>, update: W, held: S): S
}

function materializeKeyed<S extends { seq: number }, W extends { seq: number; mode?: string }>(
    lane: KeyedLane<S, W>,
    held: S | undefined,
    update: W,
): S | null {
    if (update.mode !== 'delta') return { ...update, mode: 'snapshot' } as unknown as S
    const doc = held ? lane.docOf(held) : undefined
    if (!held || !doc) return null
    if (typeof held.seq === 'number' && update.seq !== held.seq + 1) return null
    return lane.snapshotOf(foldKeyedDoc(doc, lane.deltaOf(update), lane.spec), update, held)
}

type DaemonMetadataDeltaFrame = Extract<DaemonMetadataWireUpdate, { mode: 'delta' }>

const FRAME_ENVELOPE_KEYS = ['topic', 'key', 'mode', 'seq', 'timestamp', 'wireVersion'] as const

const DAEMON_METADATA_LANE: KeyedLane<DaemonMetadataUpdate, DaemonMetadataWireUpdate> = {
    spec: DAEMON_METADATA_DOC_SPEC,
    docOf: (held) => {
        if (held.status === undefined) return undefined
        // The document is the body: the frame envelope is not part of it.
        const body: Record<string, unknown> = { ...held }
        for (const key of FRAME_ENVELOPE_KEYS) delete body[key]
        return body
    },
    deltaOf: (update) => (update as DaemonMetadataDeltaFrame).delta,
    snapshotOf: (doc, update, held) => {
        const folded = doc as unknown as Omit<DaemonMetadataUpdate, 'topic' | 'key' | 'mode' | 'seq' | 'timestamp'>
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
    },
}

const MESH_STATUS_LANE: KeyedLane<MeshStatusSnapshotUpdate, MeshStatusWireUpdate> = {
    spec: MESH_STATUS_DOC_SPEC,
    docOf: (held) => held.status || undefined,
    deltaOf: (update) => (update as Extract<MeshStatusWireUpdate, { mode: 'delta' }>).delta,
    snapshotOf: (doc, update, held) => ({
        topic: 'mesh.status',
        key: update.key,
        mode: 'snapshot',
        meshId: update.meshId || held.meshId,
        status: doc,
        seq: update.seq,
        timestamp: update.timestamp,
    }),
}

export function materializeDaemonMetadataUpdate(held: DaemonMetadataUpdate | undefined, update: DaemonMetadataWireUpdate): DaemonMetadataUpdate | null {
    return materializeKeyed(DAEMON_METADATA_LANE, held, update)
}

export function materializeMeshStatusUpdate(held: MeshStatusSnapshotUpdate | undefined, update: MeshStatusWireUpdate): MeshStatusSnapshotUpdate | null {
    return materializeKeyed(MESH_STATUS_LANE, held, update)
}
