/**
 * Authoritative "this session already ended" lookup for the operator stop/cleanup path.
 *
 * A coordinator that asks to stop a specific session and gets `matchedCount: 0` cannot tell
 * "the session already ended" from "the daemon knows nothing about it". The ended-session
 * evidence is the `session_stopped` mesh record the daemon writes when a session terminates
 * (PTY exit tombstone) or is intentionally stopped by operator cleanup — the same fact that is
 * logged as `[SessionLifecycle] Session ENDED`. Read-only.
 */
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { readLocalRecords } from './mesh-local-records.js';

export interface EndedSessionEvidence {
    /** ISO timestamp of the recorded end. */
    endedAt: string;
    /** Recorded reason (e.g. `operator_cleanup`, `pty_exit`) when known. */
    reason?: string;
    source: 'mesh_ledger';
}

export type SessionEndState =
    | { sessionId: string; state: 'already_ended'; endedAt?: string; reason?: string; source: 'mesh_ledger' | 'host_record' }
    | { sessionId: string; state: 'unknown'; detail: string };

/** Most recent recorded end for each requested session id; ids with no record are absent from the map. */
export function findEndedSessionEvidence(meshId: string, sessionIds: string[]): Map<string, EndedSessionEvidence> {
    const found = new Map<string, EndedSessionEvidence>();
    if (!meshId || sessionIds.length === 0) return found;
    let entries: ReturnType<typeof readLocalRecords> = [];
    try {
        entries = readLocalRecords(meshId, { kind: ['session_stopped'], turnTerminals: false });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const entrySessionId = typeof entry.sessionId === 'string' ? entry.sessionId : '';
        if (!entrySessionId) continue;
        for (const wanted of sessionIds) {
            if (!sessionIdsEquivalent(entrySessionId, wanted)) continue;
            const prior = found.get(wanted);
            if (prior && prior.endedAt > entry.timestamp) continue;
            const payload = (entry.payload ?? {}) as Record<string, unknown>;
            const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : undefined;
            found.set(wanted, { endedAt: entry.timestamp, ...(reason ? { reason } : {}), source: 'mesh_ledger' });
        }
    }
    return found;
}

export const ALREADY_ENDED_STOP_PROOF_NOTE =
    'already_ended is an authoritative stop proof: the daemon recorded this session as ended, so no stop is needed and the slot is free to replace. '
    + 'unknown means the daemon has no record of that session id (it is NOT proof of a stop).';
