/**
 * Phase 2 Stage 4A — the read-path cutover, one consumer at a time.
 *
 * This is the ROSTER: the complete, enumerated set of read sites allowed to
 * answer from the seqscribe replica instead of the mesh ledger, with the
 * losslessness argument for each. Nothing outside this file cuts over.
 *
 * ── Why this file is on the mesh side ──────────────────────────────────────
 * `check:boundaries` forbids `seqscribe/** → mesh/**`, which keeps the
 * replication layer from growing a dependency on the mesh runtime. The same
 * split the parity loop uses applies here: `seqscribe/mesh-read-model.ts` owns
 * the index and the query, this file owns the routing decision and the ledger
 * fallback, and it lives here because the fallback IS a ledger read.
 *
 * ── The rule every entry on this roster satisfies ──────────────────────────
 * ★ A consumer may cut over only if every field it reads survives the Stage 2
 * projection (mesh-event-projection.ts). The replica is not a copy of the
 * ledger — it is an allow-listed envelope of identifiers, enums, booleans and
 * counters, with all free text deliberately dropped. So the test is not "does
 * this read look cheap" but "is this read LOSSLESS against the projection".
 *
 * Concretely, a switched consumer may read: `id`, `timestamp`, `ledgerKind`
 * (the ledger's `kind`), `nodeId`, `sessionId`, `providerType`, `taskId`, and
 * the scalar payload keys in `PROJECTED_PAYLOAD_KEYS`. A consumer that touches
 * `payload.finalSummary`, `payload.text`, `payload.error`, a full
 * `InteractivePrompt`, `workerResult`, or `evidence` MUST NOT be here — those
 * fields were never replicated, so it would not read stale data, it would read
 * `undefined` and silently change behaviour.
 *
 * ★ This is why `findRecentTerminalLedgerEvidence` (mesh-events-stale.ts) is
 * NOT on the roster even though it sits directly beside a consumer that is: it
 * returns `payload` to callers that run `isWeakCompletionEvidence` over it,
 * which inspects exactly the free-text completion evidence the projection
 * drops. Its ordinal neighbour `hasDispatchAfterTerminal` — which reads only
 * `id`, `kind` and `sessionId` — is switchable. Adjacency in the same file is
 * not an argument; the field set is.
 *
 * ── Ordering ───────────────────────────────────────────────────────────────
 * Two of these consumers ask ordinal questions ("did a dispatch land after this
 * terminal entry"), so the replica has to order entries the way the ledger does:
 * `(timestamp ASC, canonical order ASC)`, mirroring the ledger's own
 * `ORDER BY timestamp ASC, rowid ASC`. Wall-clock is the primary key on BOTH
 * sides — the caller supplies the timestamp, so sorting purely by append order
 * would diverge — and seqscribe's total order stands in for `rowid` as the
 * tie-break. See the mesh-read-model.ts header for the full reasoning.
 */

import { daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import {
    queryMeshReadModel,
    type MeshReadModelQuery,
} from '../seqscribe/mesh-read-model.js';
import { isMeshReadModelReady } from '../seqscribe/mesh-read-readiness.js';
import type { ProjectedMeshEvent } from '../seqscribe/mesh-event-projection.js';
import {
    readLedgerEntries,
    readLedgerEntriesByKind,
    type MeshLedgerEntry,
    type MeshLedgerKind,
} from './mesh-ledger.js';

/**
 * The subset of a ledger entry that survives projection.
 *
 * ★ Switched consumers are typed against THIS, not `MeshLedgerEntry`. That is
 * the enforcement mechanism, not documentation: a future edit that reaches for
 * `entry.payload.finalSummary` inside a switched consumer fails to compile,
 * rather than compiling and silently reading `undefined` from the replica while
 * working correctly against the ledger. A comment asking reviewers to check
 * would not survive; a type does.
 */
export interface ProjectedLedgerView {
    id: string;
    timestamp: string;
    kind: string;
    nodeId?: string | undefined;
    sessionId?: string | undefined;
    providerType?: string | undefined;
    taskId?: string | undefined;
    /** Allow-listed scalars only. Never free text. */
    payload: Record<string, string | number | boolean>;
}

/** Ledger entry → the projected view, for the fallback path. */
function fromLedger(entry: MeshLedgerEntry): ProjectedLedgerView {
    const payload: Record<string, string | number | boolean> = {};
    const source = entry.payload;
    if (source) {
        for (const [key, value] of Object.entries(source)) {
            if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            ) {
                payload[key] = value;
            }
        }
    }
    return {
        id: entry.id,
        timestamp: entry.timestamp,
        kind: entry.kind,
        nodeId: entry.nodeId,
        sessionId: entry.sessionId,
        providerType: entry.providerType,
        taskId: entry.taskId,
        payload,
    };
}

/** Replica record → the projected view. */
function fromReplica(event: ProjectedMeshEvent): ProjectedLedgerView {
    return {
        id: event.id,
        timestamp: event.timestamp,
        kind: event.ledgerKind,
        nodeId: event.nodeId ?? undefined,
        sessionId: event.sessionId ?? undefined,
        providerType: event.providerType ?? undefined,
        taskId: event.taskId ?? undefined,
        payload: event.payload,
    };
}

/**
 * The single routing point: read the replica when this mesh is ready, else the
 * ledger. Every roster entry goes through here.
 *
 * ★ One source per call, never a merge. Merging two stores in one response
 * would make an entry's presence depend on which store happened to hold it,
 * which is unreviewable and would mask exactly the divergence parity exists to
 * detect. A read is answered wholly by one store.
 */
function readProjectedEntries(
    meshId: string,
    query: MeshReadModelQuery,
): ProjectedLedgerView[] {
    if (isMeshReadModelReady(meshId)) {
        return queryMeshReadModel(meshId, query).map(fromReplica);
    }
    // Ledger fallback — byte-for-byte the call the site made before Stage 4A.
    const opts: Parameters<typeof readLedgerEntries>[1] = {};
    if (query.kind?.length) opts.kind = query.kind as MeshLedgerKind[];
    if (query.since) opts.since = query.since;
    if (query.node) opts.node = query.node;
    if (query.tail) opts.tail = query.tail;
    return readLedgerEntries(meshId, opts).map(fromLedger);
}

/**
 * Kind-filtered existence/lookup read — the replica-aware
 * `readLedgerEntriesByKind`.
 *
 * Preserves the LEDGER-KIND-TAIL-BLINDSPOT discipline: the kind filter is
 * applied BEFORE any cap, on both paths, so an old-but-relevant row can never
 * be crowded out of the window by unrelated traffic.
 */
export function readProjectedEntriesByKind(
    meshId: string,
    kinds: MeshLedgerKind[],
    cap?: number,
): ProjectedLedgerView[] {
    if (isMeshReadModelReady(meshId)) {
        const events = queryMeshReadModel(meshId, { kind: kinds }).map(fromReplica);
        return cap && cap > 0 && events.length > cap ? events.slice(-cap) : events;
    }
    return readLedgerEntriesByKind(meshId, kinds, cap).map(fromLedger);
}

// ───────────────────────────────────────────────────────────────────────────
// ROSTER ENTRY 1 — mesh-task-stats.ts:76
//
// Reads a bounded tail and counts `task_dispatched` per task plus the last
// `task_completed`/`task_failed`, keyed by `payload.taskId`, recording only
// `entry.timestamp` and `entry.kind`.
//
// Lossless: taskId is BOTH a base field and an allow-listed payload key;
// timestamp and kind are base fields. No free text is touched.
// ───────────────────────────────────────────────────────────────────────────

/** The tail read behind `computeMeshTaskStats`. */
export function readTaskStatsEntries(meshId: string, tail: number): ProjectedLedgerView[] {
    return readProjectedEntries(meshId, { tail });
}

// ───────────────────────────────────────────────────────────────────────────
// ROSTER ENTRY 2 — mesh-reconcile-coordinator-drain.ts:531 (isApprovalNudgeResolved)
//
// Asks whether a terminal entry for a node/session landed at or after a nudge
// was queued. Reads `kind`, `timestamp`, `nodeId`, `sessionId` — all base
// fields — and compares ids with the equivalence helpers, never `===`.
//
// ★ Switched to a KIND-FILTERED read. The original called bare
// `readLedgerEntries(meshId)` with no options, i.e. the full set, then filtered
// by kind in the caller. Filtering by kind at the source is equivalent for this
// predicate (it only ever inspects the two terminal kinds) and avoids
// materializing every entry on a hot reconcile tick.
// ───────────────────────────────────────────────────────────────────────────

/** Terminal entries for the approval-nudge staleness check. */
export function readApprovalResolutionEntries(meshId: string): ProjectedLedgerView[] {
    return readProjectedEntriesByKind(meshId, ['task_completed', 'task_failed']);
}

// ───────────────────────────────────────────────────────────────────────────
// ROSTER ENTRY 3 — mesh-event-suppression.ts:446
//                  (hasMatchingTaskDispatchedLedgerEntry)
//
// Existence check: is there a `task_dispatched` naming BOTH this taskId and
// this sessionId? Reads `sessionId` (base) and `payload.taskId` (allow-listed).
//
// ★ Correctness note: this feeds the CAUSAL-COMPLETION-GATE, where a false
// NEGATIVE suppresses a genuine completion. That is why the readiness gate
// requires `lagRows === 0` — a lagging index would report "no dispatch" for a
// dispatch that exists, which is precisely this consumer's dangerous direction.
// ───────────────────────────────────────────────────────────────────────────

export function hasMatchingTaskDispatchedEntry(
    meshId: string,
    taskId: string,
    sessionId: string,
): boolean {
    const entries = readProjectedEntriesByKind(meshId, ['task_dispatched']);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (!sessionIdsEquivalent(entry.sessionId, sessionId)) continue;
        const entryTaskId = entry.taskId ?? entry.payload.taskId;
        if (typeof entryTaskId === 'string' && entryTaskId.trim() === taskId) return true;
    }
    return false;
}

// ───────────────────────────────────────────────────────────────────────────
// ROSTER ENTRY 4 — mesh-events-stale.ts:184 (hasDispatchAfterTerminal)
//
// Ordinal question: does a `task_dispatched` for this session appear AFTER the
// entry with `terminalId`? Reads `id`, `kind`, `sessionId` only.
//
// ★ This is the consumer that makes the replica's tie-break load-bearing. The
// original walks positionally rather than by timestamp "because both entries may
// share the same millisecond" — and that tie is what the tie-break settles. The
// replica sorts `(timestamp, canonical order)`, so it agrees with the ledger's
// `(timestamp, rowid)` on the primary key and resolves the tie with seqscribe's
// total order (hlc, writer, seq), which never ties and — unlike a local rowid —
// stays meaningful for records from a remote writer.
// ───────────────────────────────────────────────────────────────────────────

export function hasDispatchAfterTerminalEntry(
    meshId: string,
    sessionId: string,
    terminalId: string,
    terminalKinds: MeshLedgerKind[],
): boolean {
    const entries = readProjectedEntriesByKind(meshId, ['task_dispatched', ...terminalKinds]);
    let pastTerminal = false;
    for (const entry of entries) {
        if (!pastTerminal) {
            if (entry.id === terminalId) pastTerminal = true;
            continue;
        }
        if (entry.kind === 'task_dispatched' && sessionIdsEquivalent(entry.sessionId, sessionId)) {
            return true;
        }
    }
    return false;
}

// ───────────────────────────────────────────────────────────────────────────
// ROSTER ENTRY 5 — mesh-event-suppression.ts:98 (hasRecentIntentionalCleanupStop)
//                  [Stage 4B, 2026-08-28]
//
// Asks whether an operator-initiated cleanup stopped this session/node inside a
// 30-minute window, so an ordinary `agent:stopped` is not reported as a failure.
// Reads `sessionId`/`nodeId`/`timestamp` (base fields) plus the four payload keys
// `isIntentionalCleanupStopEntry` inspects.
//
// ★ Lossless only BECAUSE the Stage 4B projection additions landed with it.
// Before that change three of those four keys (`source`, `intentional`,
// `intentionalStopReason`) were absent from `PROJECTED_PAYLOAD_KEYS`, so the
// predicate would have read `undefined` from the replica and returned false for
// every entry — the exact silent behaviour change this roster exists to prevent,
// and in the dangerous direction: a false negative here un-suppresses a
// deliberate operator cleanup and reports it to the fleet as a failure. The two
// changes are one unit; neither is correct alone.
//
// `reason` was already allow-listed (a closed enum set), so it needed no change.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Recent entries of the three kinds `isIntentionalCleanupStopEntry` accepts.
 *
 * Preserves the caller's `since` windowing rather than a tail: the original read
 * is explicitly `{kind, since}` with no tail, because a bare tail lets unrelated
 * mesh traffic evict a genuine cleanup-stop before the walk reaches the cutoff
 * (LEDGER-KIND-TAIL-BLINDSPOT). Both paths below apply the same two predicates.
 */
export function readIntentionalCleanupStopEntries(
    meshId: string,
    since: string,
): ProjectedLedgerView[] {
    return readProjectedEntries(meshId, {
        kind: ['session_stopped', 'task_failed', 'task_stalled'],
        since,
    });
}

// ───────────────────────────────────────────────────────────────────────────
// ROSTER ENTRY 6 — parity diagnostics
//
// The parity loop already reads the ledger directly (mesh-parity-loop.ts) and
// MUST keep doing so: comparing the replica against itself would be a
// tautology. What cuts over here is the diagnostic view — "what does the
// replica believe about this mesh" — used to triage a mismatch.
// ───────────────────────────────────────────────────────────────────────────

export interface MeshReplicaDiagnostics {
    meshId: string;
    /** Whether reads are currently served from the replica. */
    servingFromReplica: boolean;
    /** Entries the replica holds for this mesh. */
    replicaEntries: number;
    /** Per-kind counts — enums only, never payload values. */
    byKind: Record<string, number>;
}

/**
 * Diagnostic snapshot of the replica for one mesh.
 *
 * Content boundary: counts and ledger-kind enums only. Never an entry payload —
 * this is an operator surface, and the same rule the parity logger follows
 * (identifiers and field NAMES, never values) applies.
 */
export function meshReplicaDiagnostics(meshId: string): MeshReplicaDiagnostics {
    const servingFromReplica = isMeshReadModelReady(meshId);
    const events = servingFromReplica ? queryMeshReadModel(meshId) : [];
    const byKind: Record<string, number> = {};
    for (const event of events) {
        byKind[event.ledgerKind] = (byKind[event.ledgerKind] ?? 0) + 1;
    }
    return {
        meshId,
        servingFromReplica,
        replicaEntries: events.length,
        byKind,
    };
}

/** Re-exported so switched call sites use one equivalence helper, not two. */
export { daemonIdsEquivalent, sessionIdsEquivalent };
