/**
 * Test seeding for `mesh_local_records` (C-W9a).
 *
 * `seedLocalRecord` writes one record through the production write API —
 * `meshRecord(meshId, kind, scalars, { local: true })` — and hands back the
 * row in the reader shape, which is what the retired `appendLedgerEntry`
 * returned. Tests that only need "a record of kind X exists" use this; tests
 * that pin the write path itself call `meshRecord` directly.
 */
import { meshRecord, meshRecordAsEntry } from '../../src/mesh/mesh-record.js';
import type { MeshLedgerEntry, MeshLedgerKind } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

export interface SeedLocalRecordInput {
    kind: MeshLedgerKind;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
    /** Epoch ms the record carries (defaults to now). */
    at?: number;
    /** ISO alternative to `at` (the retired append accepted an overriding `timestamp`). */
    timestamp?: string;
    id?: string;
}

export function seedLocalRecord(meshId: string, input: SeedLocalRecordInput): MeshLedgerEntry {
    const { kind, payload = {}, timestamp, ...rest } = input;
    const scalars = { ...rest, ...(timestamp && rest.at === undefined ? { at: Date.parse(timestamp) } : {}), payload };
    const result = meshRecord(meshId, kind, scalars, { local: true });
    return meshRecordAsEntry(meshId, kind, scalars, result);
}

/**
 * Insert one row at the store layer with a CALLER-CONTROLLED timestamp (the
 * shape the retired `MeshRuntimeStore.appendLedgerEntry` took) — for tests that
 * must express "recorded N ms ago".
 */
export function insertLocalRecordRow(row: {
    id: string;
    meshId: string;
    timestamp: string;
    kind: string;
    nodeId?: string | null;
    sessionId?: string | null;
    providerType?: string | null;
    taskId?: string | null;
    payload?: Record<string, unknown>;
}): boolean {
    return MeshRuntimeStore.getInstance().localRecordStore().insert({
        eventId: row.id,
        meshId: row.meshId,
        kind: row.kind,
        nodeId: row.nodeId ?? null,
        sessionId: row.sessionId ?? null,
        providerType: row.providerType ?? null,
        taskId: row.taskId ?? (typeof row.payload?.taskId === 'string' ? row.payload.taskId : null),
        atMs: Date.parse(row.timestamp),
        payload: row.payload ?? {},
    });
}
