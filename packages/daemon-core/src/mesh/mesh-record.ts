/**
 * meshRecord — the write API for every NON-turn mesh event (wiring-unification
 * C3: "every other kind is `mesh.record` topic-only").
 *
 * Replaces `recordMeshEventShadow` (the dual-write shadow leg) and is the
 * target of every `appendLedgerEntry` call site once the integration pass
 * retires the legacy event ledger + JSONL (C-W3/W4/W6 migrate the callers; C-W2
 * ships the API and re-points appendLedgerEntry's replication leg here).
 *
 * Content boundary: the record is projected through the existing allow-list
 * (`seqscribe/mesh-event-projection.ts` — ids, enums, booleans, counters,
 * ≤200-char scalars under PROJECTED_PAYLOAD_KEYS) before it reaches the
 * metadata-class `mesh.<id>.events` topic. Free text in `payload` is dropped
 * by construction; text that must travel goes to `mesh.<id>.handoff`.
 *
 * Turn outcomes are NOT records: they are `turn_events` rows written by the
 * turn ledger (`ledger.observe`) and published as `turn.*` entries.
 */

import { randomUUID } from 'crypto';
import { publishMeshRecord, type MeshRecordEntry } from '../seqscribe/mesh-publisher.js';

/** Scalars a record may carry (anything else in `payload` is dropped by the projection). */
export interface MeshRecordScalars {
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
    /** Stable id (dedupe key for consumers); a fresh UUID when omitted. */
    id?: string;
    /** Epoch ms; now when omitted. */
    at?: number;
}

export interface MeshRecordResult {
    eventId: string;
    /** False when no seqscribe node is armed in this process or the record was refused (ERROR-logged). */
    published: boolean;
}

/** Record one non-turn mesh event on `mesh.<meshId>.events` (`mesh.record`). Never throws. */
export function meshRecord(meshId: string, kind: string, scalars: MeshRecordScalars = {}): MeshRecordResult {
    const eventId = scalars.id ?? randomUUID();
    const entry: MeshRecordEntry = {
        id: eventId,
        timestamp: new Date(scalars.at ?? Date.now()).toISOString(),
        kind,
        ...(scalars.nodeId ? { nodeId: scalars.nodeId } : {}),
        ...(scalars.sessionId ? { sessionId: scalars.sessionId } : {}),
        ...(scalars.providerType ? { providerType: scalars.providerType } : {}),
        ...(scalars.taskId ? { taskId: scalars.taskId } : {}),
        ...(scalars.payload ? { payload: scalars.payload } : {}),
    };
    return { eventId, published: publishMeshRecord(meshId, entry) };
}

/** Publish an already-built ledger entry under its own id (appendLedgerEntry's replication leg). */
export function meshRecordEntry(meshId: string, entry: MeshRecordEntry): boolean {
    return publishMeshRecord(meshId, entry);
}
