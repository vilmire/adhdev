// Test seeding for the daemon's local records (C-W9a: the event ledger retired).
// `seedLocalRecord` writes one record through the daemon's production write API —
// `meshRecord(meshId, kind, scalars, { local: true })` — in the test process (the
// SAME `@adhdev/daemon-core` instance the IPC handlers answering the tools run on),
// and returns the row in the reader shape the retired `appendLedgerEntry` returned.
import { meshRecord, type MeshLedgerEntry } from '@adhdev/daemon-core';

export function seedLocalRecord(meshId: string, input: {
    kind: string;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
    timestamp?: string;
}): MeshLedgerEntry {
    const { kind, payload = {}, timestamp, ...rest } = input;
    const at = timestamp ? Date.parse(timestamp) : Date.now();
    const result = meshRecord(meshId, kind, { ...rest, payload, at }, { local: true });
    return {
        id: result.eventId,
        meshId,
        timestamp: result.timestamp,
        kind: kind as MeshLedgerEntry['kind'],
        ...rest,
        payload,
    } as MeshLedgerEntry;
}
