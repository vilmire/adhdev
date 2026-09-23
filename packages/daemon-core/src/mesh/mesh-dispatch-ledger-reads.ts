// ---------------------------------------------------------------------------
// mesh-dispatch-ledger-reads — read-only lookups over the legacy event ledger
// ---------------------------------------------------------------------------
// Moved verbatim out of mesh-events-stale.ts when that module (the un-reduced
// terminal WRITER — reconcileDirectDispatchCompletionFromTranscript and the
// no-progress reconciliation builder) was deleted in wiring-unification C4
// (C-W4). These three are pure READS of the legacy event-ledger table still consumed by
// the routing / scheduling-fitness busy checks and the C-W3 forwarding and
// suppression modules; they retire with the ledger table (C3), when every
// caller reads `turn_attempts` (`ledger.openAttemptForSession` / `isTerminal`).
// ---------------------------------------------------------------------------

import { readLedgerEntriesByKind } from './mesh-ledger.js';
import type { MeshLedgerKind } from './mesh-ledger.js';
import { readNonEmptyString, isWeakCompletionEvidence } from './mesh-events-utils.js';
import { meshNodeIdMatches, sessionIdsEquivalent, type MeshNodeIdentified } from '@adhdev/mesh-shared';

const TERMINAL_LEDGER_KINDS: MeshLedgerKind[] = ['task_completed', 'task_failed', 'task_stalled'];

export function findRecentTerminalLedgerEvidence(args: {
    meshId: string;
    sessionId?: string;
    nodeId?: string;
    /**
     * NO-PROGRESS-STALE-EVIDENCE (D1) fallback bound: when set, a terminal entry OLDER than
     * this epoch-ms cutoff is not accepted as evidence. Session-scoped lookup alone matches
     * ANY terminal on the session, so a prior task's terminal (observed: 24 minutes old) can
     * masquerade as evidence for the task running NOW. Callers that cannot supply a taskId
     * pass a conservative cutoff so at least stale-by-time evidence is rejected. Unset →
     * unbounded, the historical behaviour every other caller relies on.
     */
    notBeforeMs?: number;
}): { id: string; kind: MeshLedgerKind; payload: Record<string, unknown>; timestamp: string } | null {
    if (!args.sessionId && !args.nodeId) return null;
    const notBefore = typeof args.notBeforeMs === 'number' && Number.isFinite(args.notBeforeMs)
        ? args.notBeforeMs
        : null;
    // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered, no bare tail — a bare tail:200 window can be
    // crowded out by unrelated mesh traffic before reaching the terminal entry this function
    // is looking for.
    const entries = readLedgerEntriesByKind(args.meshId, TERMINAL_LEDGER_KINDS);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (notBefore !== null) {
            // Reject terminals older than the caller's cutoff. An unparseable timestamp is
            // treated as too old — a bounded caller asked for recency it cannot verify.
            const entryTime = new Date(entry.timestamp).getTime();
            if (!Number.isFinite(entryTime) || entryTime < notBefore) continue;
        }
        if (args.sessionId && sessionIdsEquivalent(entry.sessionId, args.sessionId)) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
        // Normalized node-id match (P4): a ledger entry may store its node id as `nodeId`
        // (runtime form) or `node_id` (DB column form leaked onto the object). A raw `===`
        // against args.nodeId drops the entry when the entry's stored form differs from the
        // form the caller passes, so a valid terminal completion goes unfound. meshNodeIdMatches
        // normalizes the entry across all 3 forms before comparing. (The entry's typed shape
        // omits the open index signature MeshNodeIdentified declares, hence the cast.)
        if (!args.sessionId && args.nodeId && meshNodeIdMatches(entry as unknown as MeshNodeIdentified, args.nodeId)) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
    }
    return null;
}

export function hasUnterminalDirectDispatchLedgerEntry(meshId: string, sessionId: string): boolean {
    // Some dispatch paths can persist task_dispatched before the direct-dispatch DB row is
    // available. Recover routing from ledger order so coordinator self-targets still emit
    // task_completed and pendingCoordinatorEvents.
    //
    // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered (task_dispatched + terminal kinds — the walk
    // needs both to know which comes first for this session), no bare tail. A bare tail:200
    // window can be crowded out by unrelated mesh traffic before reaching either.
    const entries = readLedgerEntriesByKind(meshId, ['task_dispatched', ...TERMINAL_LEDGER_KINDS]);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!sessionIdsEquivalent(entry.sessionId, sessionId)) continue;
        if (entry.kind === 'task_completed' || entry.kind === 'task_failed' || entry.kind === 'task_stalled') {
            return false;
        }
        if (entry.kind === 'task_dispatched' && entry.payload?.source === 'direct') {
            return true;
        }
    }
    return false;
}

export function findTerminalLedgerEvidenceForTask(args: {
    meshId: string;
    taskId?: string;
    sessionId?: string;
    nodeId?: string;
    tail?: number;
}): { id: string; kind: Extract<MeshLedgerKind, 'task_completed' | 'task_failed' | 'task_stalled'>; payload: Record<string, unknown>; timestamp: string } | null {
    const taskId = readNonEmptyString(args.taskId);
    if (!taskId) return null;
    // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered, no bare tail — a bare tail window can be
    // crowded out by unrelated mesh traffic before reaching this task's terminal entry.
    // `args.tail`, when supplied, is now applied AFTER the kind filter (most-recent-N-of-kind)
    // rather than as a raw tail over all kinds.
    const entries = readLedgerEntriesByKind(args.meshId, TERMINAL_LEDGER_KINDS, args.tail);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const terminalTaskId = readNonEmptyString(entry.payload?.taskId);
        if (terminalTaskId !== taskId) continue;
        if (entry.kind === 'task_completed' && isWeakCompletionEvidence(entry.payload)) continue;
        if (args.sessionId && entry.sessionId && !sessionIdsEquivalent(entry.sessionId, args.sessionId)) continue;
        if (!args.sessionId && args.nodeId && entry.nodeId && !meshNodeIdMatches(entry as unknown as MeshNodeIdentified, args.nodeId)) continue;
        // readLedgerEntriesByKind(..., TERMINAL_LEDGER_KINDS) guarantees entry.kind is one of
        // the three terminal kinds; TS can't narrow through the helper, hence the cast.
        return {
            id: entry.id,
            kind: entry.kind as Extract<MeshLedgerKind, 'task_completed' | 'task_failed' | 'task_stalled'>,
            payload: entry.payload || {},
            timestamp: entry.timestamp,
        };
    }
    return null;
}
