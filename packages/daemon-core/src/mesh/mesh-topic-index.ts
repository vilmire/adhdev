// ---------------------------------------------------------------------------
// mesh-topic-index — the durable SQL index of `mesh.<id>.events` (C3, C-W3)
// ---------------------------------------------------------------------------
// Replaces the in-memory read model (`seqscribe/mesh-read-model.ts`), its
// readiness gate (`seqscribe/mesh-read-readiness.ts`) and the parity loop.
//
//   · FED BY ONE DURABLE CURSOR (`mesh.index`, registered per mesh by
//     `seqscribe/mesh-turn-consumer.ts`). Every entry of every writer lands in
//     `mesh_topic_index` (DDL: `turn-ledger/schema.ts`) keyed by
//     `(writer, seq, mesh_id)`, so a redelivered or replayed entry is an
//     `INSERT OR IGNORE` no-op and the cursor RESUMES after a restart — there
//     is no warmup and no "caught up" latch.
//   · AUTHORITATIVE FROM THE FIRST WRITE. There is no second store to compare
//     it with: the topic is the only event log (C2), so the parity loop and the
//     read cut-over gate have nothing left to decide.
//   · EVERY READ PICKS A WRITER FILTER (C3 "read-site writer filter"):
//       - `fleet` — every writer (a worker reading its siblings' activity);
//       - `own`   — `writer = <this daemon's writer id>` applied in SQL BEFORE
//         `LIMIT`, the same kind-before-tail rule P2 established. The old read
//         model had no writer filter at all, so `tail:1000` spanned ~5 h of
//         other daemons' `direct_fast_forward{noop}` rows on the replica
//         against ~2 days on the ledger.
//     Task lifecycle reads (`own`) are answered from the turn tables — the
//     coordinator owns every attempt it dispatched (`readOwnTaskLifecycle`).
//
// CONTENT BOUNDARY: the index only ever stores what the topic carries, which
// is content-free by construction (the `mesh.record` allow-list projection and
// the closed-vocabulary `MeshTopicEntry` shapes). Nothing here widens that.
// ---------------------------------------------------------------------------

import type { Database as DatabaseHandle, Statement } from 'better-sqlite3';
import type { TurnStore } from './turn-ledger/store.js';

/** Durable cursor name of the index on every mesh events topic. */
export const MESH_INDEX_CONSUMER = 'mesh.index';

/** Append kind of a `mesh.record` entry (and of every pre-C projected ledger copy). */
export const MESH_RECORD_APPEND_KIND = 'adhdev.mesh.ledger';

/** One raw topic entry as the cursor hands it over (structural: no seqscribe import). */
export interface MeshIndexEntryInput {
    meshId: string;
    writer: string;
    seq: number;
    /** The append kind (`adhdev.mesh.ledger` or `turn.evidence|committed|notify`). */
    kind: string;
    payload: unknown;
}

/** A row read back from the index — the shape the retired `ProjectedLedgerView` had, plus coordinates. */
export interface MeshIndexView {
    writer: string;
    seq: number;
    /** The ledger entry id (`mesh.record`) or the turn entry's `eventId`. */
    id: string;
    /** ISO timestamp derived from `at_ms`. */
    timestamp: string;
    atMs: number;
    /** `payload.ledgerKind` for a record; the entry `k` (`turn.committed` …) for a turn entry. */
    kind: string;
    nodeId?: string | undefined;
    sessionId?: string | undefined;
    providerType?: string | undefined;
    taskId?: string | undefined;
    /** Allow-listed scalars only (the projection already refused everything else). */
    payload: Record<string, string | number | boolean>;
}

export type MeshIndexWriterFilter =
    | { scope: 'fleet' }
    | { scope: 'own'; writer: string };

export interface MeshIndexQuery {
    writer: MeshIndexWriterFilter;
    /** Ledger kinds (or turn entry kinds) — applied in SQL before any tail. */
    kinds?: readonly string[];
    sessionId?: string;
    taskId?: string;
    nodeId?: string;
    /** Inclusive lower bound, epoch ms. */
    sinceMs?: number;
    /** Most recent N rows (after every filter), returned in ascending order. */
    tail?: number;
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function scalarPayload(value: unknown): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
    }
    return out;
}

interface ParsedEntry {
    eventId: string;
    ledgerKind: string;
    taskId: string | null;
    sessionId: string | null;
    nodeId: string | null;
    atMs: number;
    payload: Record<string, unknown>;
}

/**
 * Parse one topic entry into index columns. `mesh.record` (and every pre-C
 * projected copy) carries `{id, timestamp, ledgerKind, nodeId, sessionId,
 * providerType, taskId, payload}` (+ `v/k/eventId/at` since C-W2); a turn
 * entry is a `MeshTopicEntry`. Returns null for anything else — the cursor
 * still advances past it (indexing is best-effort per entry, never a stall).
 */
export function parseMeshIndexEntry(input: MeshIndexEntryInput): ParsedEntry | null {
    const p = input.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const payload = p as Record<string, unknown>;
    if (input.kind === MESH_RECORD_APPEND_KIND) {
        const id = str(payload.eventId) ?? str(payload.id);
        const ledgerKind = str(payload.ledgerKind);
        if (!id || !ledgerKind) return null;
        const at = typeof payload.at === 'number' && Number.isFinite(payload.at) && payload.at > 0
            ? payload.at
            : Date.parse(typeof payload.timestamp === 'string' ? payload.timestamp : '');
        return {
            eventId: id,
            ledgerKind,
            taskId: str(payload.taskId) ?? null,
            sessionId: str(payload.sessionId) ?? null,
            nodeId: str(payload.nodeId) ?? null,
            atMs: Number.isFinite(at) ? at : 0,
            payload,
        };
    }
    if (input.kind.startsWith('turn.')) {
        const eventId = str(payload.eventId);
        if (!eventId) return null;
        const at = typeof payload.at === 'number' && Number.isFinite(payload.at) ? payload.at : 0;
        return {
            eventId,
            ledgerKind: input.kind,
            taskId: str(payload.taskId) ?? null,
            sessionId: str(payload.sessionId) ?? str(payload.targetSessionId) ?? null,
            nodeId: null,
            atMs: at,
            payload,
        };
    }
    return null;
}

interface IndexRowRaw {
    writer: string; seq: number; mesh_id: string; event_id: string; kind: string; ledger_kind: string | null;
    task_id: string | null; session_id: string | null; node_id: string | null; at_ms: number; payload_json: string;
}

function viewFromRow(row: IndexRowRaw): MeshIndexView {
    let parsed: Record<string, unknown> = {};
    try {
        const value = JSON.parse(row.payload_json);
        if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch { /* malformed row → empty payload */ }
    const record = row.kind === MESH_RECORD_APPEND_KIND;
    // A record's scalars live under `payload`; a turn entry IS its scalars.
    const scalars = record ? scalarPayload(parsed.payload) : scalarPayload(parsed);
    return {
        writer: row.writer,
        seq: row.seq,
        id: row.event_id,
        timestamp: new Date(row.at_ms).toISOString(),
        atMs: row.at_ms,
        kind: row.ledger_kind ?? row.kind,
        nodeId: row.node_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        providerType: record ? str(parsed.providerType) : undefined,
        taskId: row.task_id ?? undefined,
        payload: scalars,
    };
}

/** The index bound to one `mesh-runtime.db` handle. */
export class MeshTopicIndex {
    private readonly stmts = new Map<string, Statement>();

    constructor(readonly db: DatabaseHandle) {}

    private stmt(sql: string): Statement {
        let s = this.stmts.get(sql);
        if (!s) {
            s = this.db.prepare(sql);
            this.stmts.set(sql, s);
        }
        return s;
    }

    /** Index one entry. Idempotent on `(writer, seq, mesh_id)`: true only when a row was inserted. */
    ingest(input: MeshIndexEntryInput): boolean {
        const parsed = parseMeshIndexEntry(input);
        if (!parsed) return false;
        const info = this.stmt(`INSERT OR IGNORE INTO mesh_topic_index
                (writer, seq, mesh_id, event_id, kind, ledger_kind, task_id, session_id, node_id, at_ms, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            input.writer, input.seq, input.meshId, parsed.eventId, input.kind, parsed.ledgerKind,
            parsed.taskId, parsed.sessionId, parsed.nodeId, parsed.atMs, JSON.stringify(parsed.payload),
        );
        return info.changes > 0;
    }

    /**
     * Filtered read. Every filter — writer first — is applied in SQL before
     * the tail, so unrelated traffic can never crowd a relevant row out of the
     * window (LEDGER-KIND-TAIL-BLINDSPOT, and the C3 own-writer rule).
     */
    query(meshId: string, q: MeshIndexQuery): MeshIndexView[] {
        const where: string[] = ['mesh_id = ?'];
        const args: unknown[] = [meshId];
        if (q.writer.scope === 'own') { where.push('writer = ?'); args.push(q.writer.writer); }
        if (q.kinds && q.kinds.length > 0) {
            where.push(`ledger_kind IN (${q.kinds.map(() => '?').join(', ')})`);
            args.push(...q.kinds);
        }
        if (q.sessionId) { where.push('session_id = ?'); args.push(q.sessionId); }
        if (q.taskId) { where.push('task_id = ?'); args.push(q.taskId); }
        if (q.nodeId) { where.push('node_id = ?'); args.push(q.nodeId); }
        if (q.sinceMs !== undefined) { where.push('at_ms >= ?'); args.push(q.sinceMs); }
        const tail = q.tail && q.tail > 0 ? Math.floor(q.tail) : null;
        const sql = tail
            ? `SELECT * FROM mesh_topic_index WHERE ${where.join(' AND ')} ORDER BY at_ms DESC, writer DESC, seq DESC LIMIT ${tail}`
            : `SELECT * FROM mesh_topic_index WHERE ${where.join(' AND ')} ORDER BY at_ms, writer, seq`;
        const rows = (this.db.prepare(sql).all(...args) as IndexRowRaw[]).map(viewFromRow);
        return tail ? rows.reverse() : rows;
    }

    /** Row counts per writer for one mesh (diagnostics; identifiers + counts only). */
    counts(meshId: string): { rows: number; byWriter: Record<string, number> } {
        const rows = this.stmt('SELECT writer, COUNT(*) AS n FROM mesh_topic_index WHERE mesh_id = ? GROUP BY writer').all(meshId) as Array<{ writer: string; n: number }>;
        const byWriter: Record<string, number> = {};
        let total = 0;
        for (const r of rows) { byWriter[r.writer] = r.n; total += r.n; }
        return { rows: total, byWriter };
    }
}

// ─── own task lifecycle (C3: own reads come from the turn tables) ──────────

/**
 * Task lifecycle views for one mesh, answered from what THIS daemon owns:
 * `task_dispatched` records it wrote (own writer on the index) plus one
 * terminal view per committed attempt (`turn_attempts` — the terminal truth;
 * terminal kinds are evidence, no longer ledger records, after C).
 *
 * The shape is the retired `ProjectedLedgerView`, so `mesh-task-stats.ts`
 * keeps reading `kind` / `timestamp` / `payload.taskId` unchanged.
 */
export function readOwnTaskLifecycle(
    index: MeshTopicIndex,
    turnStore: Pick<TurnStore, 'db'>,
    meshId: string,
    opts: { ownWriter: string | null; tail?: number },
): MeshIndexView[] {
    const tail = opts.tail && opts.tail > 0 ? Math.floor(opts.tail) : 1000;
    const dispatched = opts.ownWriter
        ? index.query(meshId, { writer: { scope: 'own', writer: opts.ownWriter }, kinds: ['task_dispatched'], tail })
        : [];
    const terminals = (turnStore.db.prepare(`SELECT attempt_id, task_id, session_id, node_id, provider_type, terminal_outcome, terminal_at
            FROM turn_attempts WHERE mesh_id = ? AND task_id IS NOT NULL AND terminal_outcome IN ('completed', 'failed')
            ORDER BY terminal_at DESC LIMIT ?`).all(meshId, tail) as Array<{
        attempt_id: string; task_id: string; session_id: string; node_id: string | null; provider_type: string | null;
        terminal_outcome: string; terminal_at: number | null;
    }>).map((row): MeshIndexView => {
        const atMs = row.terminal_at ?? 0;
        return {
            writer: opts.ownWriter ?? '',
            seq: 0,
            id: `${row.attempt_id}#committed`,
            timestamp: new Date(atMs).toISOString(),
            atMs,
            kind: row.terminal_outcome === 'completed' ? 'task_completed' : 'task_failed',
            sessionId: row.session_id,
            nodeId: row.node_id ?? undefined,
            providerType: row.provider_type ?? undefined,
            taskId: row.task_id,
            payload: { taskId: row.task_id, outcome: row.terminal_outcome },
        };
    });
    return [...dispatched, ...terminals].sort((a, b) => a.atMs - b.atMs);
}

// ─── fleet task activity (C3: worker-peer-context reads `fleet`) ───────────

/** The ledger kind a committed turn projects to for lifecycle readers. */
function committedKind(outcome: unknown): 'task_completed' | 'task_failed' | null {
    if (outcome === 'completed') return 'task_completed';
    if (outcome === 'failed' || outcome === 'cancelled') return 'task_failed';
    return null;
}

/**
 * Lifecycle views of every writer's tasks (a worker reading its siblings —
 * it owns none of their attempts, so this is `fleet`). `mesh.record` rows of
 * the requested kinds, plus each `turn.committed` projected onto
 * `task_completed` / `task_failed` (terminal kinds are turn entries after C,
 * not ledger records). Filter-before-tail in SQL; ascending order.
 */
export function readFleetTaskActivity(index: MeshTopicIndex, meshId: string, kinds: readonly string[], tail: number): MeshIndexView[] {
    const wantTerminal = kinds.includes('task_completed') || kinds.includes('task_failed');
    const rows = index.query(meshId, {
        writer: { scope: 'fleet' },
        kinds: wantTerminal ? [...kinds, 'turn.committed'] : kinds,
        tail,
    });
    const out: MeshIndexView[] = [];
    for (const row of rows) {
        if (row.kind !== 'turn.committed') { out.push(row); continue; }
        const kind = committedKind(row.payload.outcome);
        if (kind && kinds.includes(kind)) out.push({ ...row, kind });
    }
    return out;
}

/**
 * Ordinal question over the fleet index (C-W4's dispatch-ledger reads, the
 * successor of `hasDispatchAfterTerminalEntry`): does a `task_dispatched` for
 * this session land AFTER the entry `terminalId`? Positional in the index's
 * total order `(at_ms, writer, seq)`, which never ties.
 */
export function hasDispatchAfterTerminal(index: MeshTopicIndex, meshId: string, sessionId: string, terminalId: string, terminalKinds: readonly string[]): boolean {
    const rows = index.query(meshId, { writer: { scope: 'fleet' }, kinds: ['task_dispatched', ...terminalKinds, 'turn.committed'] });
    let pastTerminal = false;
    for (const row of rows) {
        if (!pastTerminal) {
            if (row.id === terminalId) pastTerminal = true;
            continue;
        }
        if (row.kind === 'task_dispatched' && row.sessionId === sessionId) return true;
    }
    return false;
}

let processIndex: MeshTopicIndex | null = null;

/** The index over this process's `mesh-runtime.db` handle (readers without components in scope). */
export function meshTopicIndexFor(db: DatabaseHandle): MeshTopicIndex {
    if (!processIndex || processIndex.db !== db) processIndex = new MeshTopicIndex(db);
    return processIndex;
}
