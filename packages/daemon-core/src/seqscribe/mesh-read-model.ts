/**
 * Phase 2 Stage 4A — materialized read model over `mesh.<id>.events`.
 *
 * Stage 2 made every ledger append also write a PROJECTED copy into a seqscribe
 * topic; Stage 3 proved the two stores agree. This stage lets a small,
 * explicitly enumerated set of read sites answer from the replicated store
 * instead of the local ledger — and it is the first time seqscribe data is
 * load-bearing for daemon behaviour rather than diagnostics.
 *
 * ── Why this is an ALLOW-LIST cutover, not a ledger swap ───────────────────
 * ★ The obvious reading of "primary" — point `readLedgerEntries` at seqscribe
 * and be done — is wrong, and would be a data-loss bug rather than a refactor.
 * The replicated record is a PROJECTION (mesh-event-projection.ts): it carries
 * identifiers, enums, booleans and counters, and deliberately DROPS every
 * free-text field, because the topic is `access: 'metadata'` and a cloud relay
 * may hold it. So the two stores are not interchangeable:
 *
 *   · a consumer that reads `payload.finalSummary`, `payload.text`,
 *     `payload.error` or a full InteractivePrompt CANNOT be served from here.
 *     The field is not merely missing — it was never replicated, by design.
 *   · a consumer that reads only `kind`, `taskId`, `nodeId`, `sessionId`,
 *     `timestamp` and allow-listed scalar payload keys CAN be, losslessly.
 *
 * Only the second class is switchable, so the cutover names its consumers one
 * by one (see `mesh-read-model-consumers.ts` for the roster and the per-site
 * losslessness argument). Everything else keeps reading the ledger, which
 * remains the system of record for the full entry through Stage 4A and beyond.
 *
 * ── Why materialize at all, instead of reading the topic per query ─────────
 * `onEntry` is a STREAM, not a query interface — there is no "give me entries
 * of kind X since T". `scanEntries` (v3.5 P21) does read ranges, but it is a
 * bounded LINEAR scan in canonical order, with no index on kind/taskId/session:
 * answering one suppression question would still walk the window. These
 * consumers sit on hot paths — the suppression gate runs per inbound mesh event
 * — so the log is consumed ONCE into an in-memory index, incrementally, and
 * queries hit the index. Parity, which asks a whole-window question every 15
 * minutes rather than a keyed question per event, uses the scan instead.
 *
 * ── Ordering: timestamp first, canonical order as the tie-break ───────────
 * ★ The sort is `(timestamp ASC, canonical order ASC)`, and the ORDER of those
 * two keys is dictated by the ledger rather than by what seqscribe would prefer.
 *
 * The ledger reads `ORDER BY timestamp ASC, rowid ASC`
 * (mesh-runtime-store.ts `readLedgerEntriesOrdered`): wall-clock is the PRIMARY
 * key and append position only breaks ties. Since Stage 4A's whole claim is
 * that a switched consumer returns exactly what it returned before, the replica
 * has to reproduce that, not improve on it. A pure canonical-order sort — which
 * this file originally used — diverges the moment a caller supplies a timestamp
 * that disagrees with append order, and `MeshLedgerEntry.timestamp` is
 * caller-supplied, so that is a real input rather than a hypothetical one.
 *
 * The tie-break is where canonical order earns its place, and it matters:
 * `mesh-events-stale.ts` notes that two entries may share the same millisecond,
 * so the two ordinal consumers ("did a dispatch land AFTER this terminal?")
 * need a deterministic order within an identical timestamp. The ledger uses
 * `rowid` (local append position); the replica uses seqscribe's total order
 * (`orderOf`/`orderCompare`: hlc.l, hlc.c, writer, seq), which agrees with
 * append position for this node's own writes and, unlike a rowid, stays
 * meaningful once records arrive from a remote writer.
 *
 * ── At-least-once means dedupe is mandatory ───────────────────────────────
 * `onEntry` redelivers on restart and after a failed callback (SPEC §9), so
 * the index is keyed by the ledger entry id and a repeat delivery replaces
 * rather than appends. Without that, a redelivery would double every entry and
 * the "count dispatches" consumer would silently inflate.
 */

import { orderCompare, orderOf, type LogEntry, type Order } from 'seqscribe';
import { daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { MESH_EVENT_ENTRY_KIND, type ProjectedMeshEvent } from './mesh-event-projection.js';
import { PARITY_CONSUMER } from './mesh-parity.js';
import { meshEventsTopic, meshIdFromEventsTopic } from './topics.js';
import type { SeqscribeNodeHandle } from './node.js';

/**
 * Durable consumer name for the read model's tail.
 *
 * ★ DISTINCT from `PARITY_CONSUMER` (mesh-parity.ts), and the distinction is
 * required rather than stylistic: a consumer name owns a cursor, and two
 * features sharing one would each advance it past the other's unread entries.
 * Parity no longer registers a consumer at all (it scans — see mesh-parity.ts),
 * so `PARITY_CONSUMER` survives only as a GC prefix; the rule still stands for
 * any future consumer.
 *
 * ★ STABLE ACROSS REBUILDS. A rebuild rewinds this cursor via `resetConsumer`
 * rather than minting a new name, so this constant is the only read-model
 * consumer name that ever exists. Renaming it strands the old cursor (holding
 * the topic's archive floor open) and replays the whole retained log once —
 * safe, since the index dedupes by id, but it costs a rebuild for nothing.
 */
export const READ_MODEL_CONSUMER = 'stage4a-mesh-read-model';

/**
 * A record in the materialized index: the projected event plus the canonical
 * order it arrived at.
 */
export interface MeshReadModelRecord {
    event: ProjectedMeshEvent;
    /** seqscribe total order — the sort key. Never payload.timestamp. */
    order: Order;
    /** The writer that produced the record, for own-vs-remote filtering. */
    writer: string;
}

/** Query shape, mirroring `ReadLedgerOptions` so a switched call site reads
 *  identically against either store. */
export interface MeshReadModelQuery {
    /** Filter to these ledger kinds. Empty/absent = every kind. */
    kind?: readonly string[];
    /** ISO timestamp; entries at or after it. Compared on payload timestamp,
     *  matching the ledger's own `since` semantics exactly. */
    since?: string;
    /** Filter to a node id, matched via `daemonIdsEquivalent` — never `===`.
     *  See the canon-identity defect class in CLAUDE.md. */
    node?: string;
    /** Keep only the last N entries. ★ APPLIED LAST, after every other filter. */
    tail?: number;
}

/** Per-mesh materialized state. */
interface MeshIndex {
    /** id → record. The dedupe key for at-least-once redelivery. */
    byId: Map<string, MeshReadModelRecord>;
    /** kind → ids, so a kind-filtered read never scans the whole index. */
    byKind: Map<string, Set<string>>;
    /** taskId → ids. */
    byTaskId: Map<string, Set<string>>;
    /** sessionId → ids (raw form; equivalence matching still applies on read). */
    bySessionId: Map<string, Set<string>>;
    /** nodeId → ids (raw form; equivalence matching still applies on read). */
    byNodeId: Map<string, Set<string>>;
    /** Sorted view cache, invalidated on write. */
    sorted: MeshReadModelRecord[] | null;
    /** Unsubscribe handle for the durable consumer. */
    unsub: (() => void) | null;
    /** The consumer name this index registered under — see `rebuildMeshReadModel`. */
    consumerName: string;
    /** Records ingested since this mesh's consumer registered. */
    ingested: number;
    /** Deliveries that were duplicates of an id already indexed. */
    redelivered: number;
    /** Deliveries dropped as unparseable. */
    malformed: number;
}

const indexes = new Map<string, MeshIndex>();

/** The node the read model consumes from. Null until wired. */
let activeNode: SeqscribeNodeHandle | null = null;

const warnedOnce = new Set<string>();
function warnOnce(message: string): void {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    LOG.warn('Seqscribe', message);
}

function emptyIndex(consumerName: string): MeshIndex {
    return {
        byId: new Map(),
        byKind: new Map(),
        byTaskId: new Map(),
        bySessionId: new Map(),
        byNodeId: new Map(),
        sorted: null,
        unsub: null,
        consumerName,
        ingested: 0,
        redelivered: 0,
        malformed: 0,
    };
}

/**
 * Coverage reported by the most recent rebuild, per mesh.
 *
 * ★ A rebuild MUST replay the whole retained log, and merely re-registering the
 * same consumer name would not: a consumer name owns a durable cursor, and
 * re-registering under the same name resumes from where the cursor sits —
 * which, for a caught-up index, is the end. The rebuilt index would come back
 * EMPTY, and since the readiness gate requires the consumer to be caught up
 * (which a cursor already at the end also satisfies) it would then happily
 * serve reads from an empty replica. That is the worst available failure: not a
 * fallback, but confident wrong answers.
 *
 * ★ HOW THIS IS SOLVED: `node.resetConsumer(topic, name, { from })`
 * (seqscribe proposals-v3.5 P17) rewinds the durable cursor in place, so the
 * rebuild reuses the STABLE name and replays. This replaced an earlier
 * workaround that appended a generation suffix (`…#2`, `…#3`) to force a fresh
 * cursor — correct in effect, but it leaked one abandoned cursor row per
 * rebuild, and an abandoned cursor gates §7.6 archiving for that topic
 * indefinitely. `pruneConsumers` (P18) now GCs whatever those older builds
 * already left behind; see `pruneStaleReadModelConsumers`.
 *
 * `resetConsumer` is INACTIVE-ONLY (it throws on a registered consumer), so the
 * rebuild path must unsubscribe before resetting — see `rebuildMeshReadModel`.
 *
 * `archivedRows` is the reset's coverage metadata: non-zero means
 * "earliest-retained" is the §7.6 archive floor rather than genesis, i.e. rows
 * below the cut exist and are NOT replayed. Recorded per mesh so the rebuild's
 * actual coverage is reportable rather than assumed.
 */
const lastRebuildCoverage = new Map<string, { archivedRows: number; replayFromRowid: number }>();

/**
 * Monotonic rebuild counter per mesh.
 *
 * ★ This is what the generation suffix USED to be, minus the durable cost. The
 * suffix existed to force a replay AND, incidentally, gave the readiness gate a
 * changing consumer name it could notice. Now that the name is stable, the gate
 * needs some other way to see that a rebuild rewound the cursor underneath a
 * catch-up watch it had already resolved — otherwise it would keep serving from
 * an index that is replaying from the floor. This epoch is that signal: it is
 * process-local, costs nothing durable, and the gate keys its latch on it.
 */
const rebuildEpoch = new Map<string, number>();

/** How many times this mesh's read model has been rebuilt in this process. */
export function meshReadModelRebuildEpoch(meshId: string): number {
    return rebuildEpoch.get(meshId) ?? 0;
}

function addToBucket(map: Map<string, Set<string>>, key: string | null, id: string): void {
    if (!key) return;
    let bucket = map.get(key);
    if (!bucket) {
        bucket = new Set();
        map.set(key, bucket);
    }
    bucket.add(id);
}

function removeFromBucket(map: Map<string, Set<string>>, key: string | null, id: string): void {
    if (!key) return;
    const bucket = map.get(key);
    if (!bucket) return;
    bucket.delete(id);
    if (bucket.size === 0) map.delete(key);
}

/**
 * Parse a delivered entry into a projected event.
 *
 * Structural rather than trusting: a record on this topic may have been written
 * by a REMOTE daemon running a different build, so a missing or wrong-typed
 * field is a normal condition to reject, not an invariant violation.
 */
function readProjected(payload: unknown): ProjectedMeshEvent | null {
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Partial<ProjectedMeshEvent>;
    if (typeof record.id !== 'string' || record.id.length === 0) return null;
    if (typeof record.ledgerKind !== 'string' || record.ledgerKind.length === 0) return null;
    return {
        id: record.id,
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
        ledgerKind: record.ledgerKind,
        nodeId: typeof record.nodeId === 'string' ? record.nodeId : null,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
        providerType: typeof record.providerType === 'string' ? record.providerType : null,
        taskId: typeof record.taskId === 'string' ? record.taskId : null,
        payload:
            record.payload && typeof record.payload === 'object'
                ? (record.payload as Record<string, string | number | boolean>)
                : {},
    };
}

/** Index one delivered entry, replacing any previous record with the same id. */
function ingest(index: MeshIndex, entry: LogEntry): void {
    if (entry.kind !== MESH_EVENT_ENTRY_KIND) return;
    const event = readProjected(entry.payload);
    if (!event) {
        index.malformed++;
        return;
    }

    const existing = index.byId.get(event.id);
    if (existing) {
        // At-least-once redelivery, or a genuine rewrite. Unhook the old
        // bucket memberships before re-adding: the base fields could differ
        // (a rewrite), and a stale bucket entry would make the id answer a
        // query it no longer matches.
        index.redelivered++;
        removeFromBucket(index.byKind, existing.event.ledgerKind, event.id);
        removeFromBucket(index.byTaskId, existing.event.taskId, event.id);
        removeFromBucket(index.bySessionId, existing.event.sessionId, event.id);
        removeFromBucket(index.byNodeId, existing.event.nodeId, event.id);
    } else {
        index.ingested++;
    }

    index.byId.set(event.id, { event, order: orderOf(entry), writer: entry.writer });
    addToBucket(index.byKind, event.ledgerKind, event.id);
    addToBucket(index.byTaskId, event.taskId, event.id);
    addToBucket(index.bySessionId, event.sessionId, event.id);
    addToBucket(index.byNodeId, event.nodeId, event.id);
    index.sorted = null;
}

/**
 * Attach the read model to a node. Called from boot after the seqscribe node
 * opens; `null` detaches (shutdown, or a node that failed to open).
 *
 * Detaching unsubscribes every per-mesh consumer and drops the indexes, so a
 * re-attach rebuilds from the durable cursor rather than serving stale rows.
 */
export function configureMeshReadModel(node: SeqscribeNodeHandle | null): void {
    for (const index of indexes.values()) {
        try {
            index.unsub?.();
        } catch {
            /* already gone */
        }
    }
    indexes.clear();
    activeNode = node;
}

/**
 * Ensure a mesh's index exists and its durable consumer is registered.
 *
 * Returns null when the topic is not defined on this node — which is the normal
 * state for a mesh that has produced no events yet, and the reason the
 * readiness gate treats "no topic" as not-ready rather than as an error.
 */
function ensureIndex(meshId: string): MeshIndex | null {
    const node = activeNode;
    if (!node) return null;

    const existing = indexes.get(meshId);
    if (existing) return existing;

    const topic = meshEventsTopic(meshId);
    if (!node.topics.some((d) => d.topic === topic)) return null;

    // ★ The STABLE name, always. A rebuild rewinds this cursor via
    // `resetConsumer` rather than registering a new name — see
    // `lastRebuildCoverage` and `rebuildMeshReadModel`.
    const index = emptyIndex(READ_MODEL_CONSUMER);
    try {
        index.unsub = node.node.onEntry(topic, index.consumerName, (entry) => {
            ingest(index, entry);
        });
    } catch (error) {
        // A consumer that cannot register means this mesh can never be ready;
        // the readiness gate will keep it on the legacy read path.
        warnOnce(
            `read model consumer failed to register topic=${topic}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return null;
    }

    indexes.set(meshId, index);
    return index;
}

/**
 * Register a mesh's consumer without querying it.
 *
 * ★ Worth calling early, because a consumer only receives entries appended
 * AFTER it registers plus whatever its durable cursor still points at — and the
 * readiness gate requires `lagRows === 0`, which cannot be evaluated for a
 * consumer that has never registered (it has no cursor row). Priming on the
 * first primary-mode read of a mesh means the first read is never ready and
 * falls back, which is correct but wastes a window.
 */
export function primeMeshReadModel(meshId: string): void {
    ensureIndex(meshId);
}

/** Parse a ledger timestamp for sorting. Unparseable sorts first, matching
 *  SQLite's ordering of a malformed text timestamp against ISO strings. */
function timestampKey(record: MeshReadModelRecord): number {
    const at = new Date(record.event.timestamp).getTime();
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function sortedRecords(index: MeshIndex): MeshReadModelRecord[] {
    if (index.sorted) return index.sorted;
    // ★ (timestamp ASC, canonical order ASC) — mirroring the ledger's
    // `ORDER BY timestamp ASC, rowid ASC`. See the header: the key order is the
    // ledger's, because equivalence is the claim; canonical order replaces
    // rowid as the tie-break because it survives remote writers.
    const all = [...index.byId.values()].sort((a, b) => {
        const at = timestampKey(a);
        const bt = timestampKey(b);
        if (at !== bt) return at - bt;
        return orderCompare(a.order, b.order);
    });
    index.sorted = all;
    return all;
}

/**
 * Query the materialized index.
 *
 * Filter order mirrors `readLedgerEntries` exactly — since, then kind, then
 * node, and ★ tail LAST — because a switched consumer must not change meaning.
 * Applying `tail` before a kind filter is the LEDGER-KIND-TAIL-BLINDSPOT bug
 * documented at length in mesh-ledger.ts: it reads the last N of every kind and
 * then filters, so a still-relevant row is crowded out by unrelated traffic.
 * Reproducing that ordering here is not imitation of a quirk — it is the
 * difference between the two stores answering the same question.
 *
 * Returns records in ascending canonical order, matching the ledger's ascending
 * append order.
 */
export function queryMeshReadModel(
    meshId: string,
    query: MeshReadModelQuery = {},
): ProjectedMeshEvent[] {
    const index = indexes.get(meshId);
    if (!index) return [];

    let candidateIds: Set<string> | null = null;

    // Kind filter first, via the index, so a kind-filtered read never scans the
    // full set — this is the hot path for the suppression consumers.
    if (query.kind?.length) {
        candidateIds = new Set();
        for (const kind of query.kind) {
            const bucket = index.byKind.get(kind);
            if (!bucket) continue;
            for (const id of bucket) candidateIds.add(id);
        }
        if (candidateIds.size === 0) return [];
    }

    const source = sortedRecords(index);
    let records = candidateIds
        ? source.filter((r) => candidateIds.has(r.event.id))
        : source.slice();

    if (query.since) {
        const sinceMs = new Date(query.since).getTime();
        if (Number.isFinite(sinceMs)) {
            records = records.filter((r) => {
                const at = new Date(r.event.timestamp).getTime();
                return Number.isFinite(at) && at >= sinceMs;
            });
        }
    }

    if (query.node && query.node.trim()) {
        const node = query.node.trim();
        records = records.filter(
            (r) => !!r.event.nodeId && daemonIdsEquivalent(r.event.nodeId, node),
        );
    }

    // ★ LAST — after every other filter. See the note above.
    if (query.tail && query.tail > 0 && records.length > query.tail) {
        records = records.slice(-query.tail);
    }

    return records.map((r) => r.event);
}

/** Records whose sessionId is equivalent to `sessionId`, in canonical order. */
export function queryMeshReadModelBySession(
    meshId: string,
    sessionId: string,
    kinds?: readonly string[],
): ProjectedMeshEvent[] {
    return queryMeshReadModel(meshId, kinds?.length ? { kind: kinds } : {}).filter(
        (e) => !!e.sessionId && sessionIdsEquivalent(e.sessionId, sessionId),
    );
}

/** Diagnostic counters for a mesh's index. Integers only. */
export interface MeshReadModelStats {
    indexed: number;
    ingested: number;
    redelivered: number;
    malformed: number;
}

export function meshReadModelStats(meshId: string): MeshReadModelStats | null {
    const index = indexes.get(meshId);
    if (!index) return null;
    return {
        indexed: index.byId.size,
        ingested: index.ingested,
        redelivered: index.redelivered,
        malformed: index.malformed,
    };
}

/** Meshes with a live index, for diagnostics. */
export function meshReadModelMeshIds(): string[] {
    return [...indexes.keys()];
}

/**
 * Drop a mesh's index and replay its durable consumer from the retained floor.
 *
 * The recovery path for a cursor anomaly — `consumer_abandoned`, or a lag that
 * will not close. Rebuilding is safe at any time: the index is derived state,
 * and until it is ready again the readiness gate routes reads to the ledger.
 *
 * ★ ORDER IS LOAD-BEARING: unsubscribe → reset → re-register. `resetConsumer`
 * throws `ERR_MISUSE` on an ACTIVE consumer (the reset would otherwise race the
 * hub's own cursor writes), so the live consumer must be gone before the rewind.
 * Getting this backwards throws rather than corrupting, but the rebuild would
 * then silently not happen.
 *
 * Returns the reset's coverage metadata, or null when there was nothing to
 * reset (no node, or the topic is not defined on this node yet).
 */
export function rebuildMeshReadModel(meshId: string): MeshReadModelRebuildCoverage | null {
    const index = indexes.get(meshId);
    if (index) {
        try {
            index.unsub?.();
        } catch {
            /* already gone */
        }
        indexes.delete(meshId);
    }

    const node = activeNode;
    if (!node) return null;
    const topic = meshEventsTopic(meshId);
    if (!node.topics.some((d) => d.topic === topic)) return null;

    // Bumped before the reset so a failed reset still invalidates the gate's
    // catch-up latch — the index is gone either way.
    rebuildEpoch.set(meshId, (rebuildEpoch.get(meshId) ?? 0) + 1);

    let coverage: MeshReadModelRebuildCoverage | null = null;
    try {
        // P17: rewind the STABLE cursor to the retained floor so the
        // re-registration below replays instead of resuming at head.
        const reset = node.node.resetConsumer(topic, READ_MODEL_CONSUMER, {
            from: 'earliest-retained',
        });
        coverage = {
            consumerName: READ_MODEL_CONSUMER,
            existed: reset.existed,
            replayFromRowid: reset.replayFromRowid,
            archivedRows: reset.archivedRows,
        };
        lastRebuildCoverage.set(meshId, {
            archivedRows: reset.archivedRows,
            replayFromRowid: reset.replayFromRowid,
        });
        if (reset.archivedRows > 0) {
            // Not an error: the §7.6 archive floor is the honest replay bound.
            // Worth a line because the rebuilt index is complete only ABOVE the
            // cut — completeness below it is the snapshot basis's job.
            LOG.info(
                'Seqscribe',
                `read model rebuild mesh=${meshId} replays from the archive floor ` +
                    `(rowid=${reset.replayFromRowid}, ${reset.archivedRows} archived rows not replayed)`,
            );
        }
    } catch (error) {
        // A failed reset means the re-registration below would RESUME at head
        // and produce a confidently empty index. Leave the index unregistered
        // instead: the readiness gate then keeps this mesh on the ledger.
        warnOnce(
            `read model rebuild could not reset cursor topic=${topic}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return null;
    }

    // ★ Re-register PROMPTLY: a reset materializes the cursor row, which gates
    // §7.6 archiving from this moment until the consumer drains.
    ensureIndex(meshId);
    return coverage;
}

/** What a rebuild's `resetConsumer` actually installed — see `rebuildMeshReadModel`. */
export interface MeshReadModelRebuildCoverage {
    /** The stable durable name the replay was installed on. */
    consumerName: string;
    /** True when a durable cursor row already existed before the reset. */
    existed: boolean;
    /** The installed cursor (0 = the whole retained hot log). */
    replayFromRowid: number;
    /** Cold-archived rows BELOW the replay floor — non-zero ⇒ not genesis. */
    archivedRows: number;
}

/** Coverage reported by this mesh's most recent rebuild, for diagnostics. */
export function meshReadModelRebuildCoverage(
    meshId: string,
): { archivedRows: number; replayFromRowid: number } | null {
    return lastRebuildCoverage.get(meshId) ?? null;
}

/**
 * GC durable cursors left behind by older builds and by parity sweeps.
 *
 * ★ Two families accumulate on `mesh.<id>.events`, and both gate §7.6
 * archiving for as long as they exist:
 *
 *   · `stage4a-mesh-read-model#N` — the pre-P17 rebuild workaround. Every
 *     rebuild in an older daemon minted a new generation name; those rows
 *     survive the process that made them. Nothing registers them any more, so
 *     every one of them is garbage.
 *   · `stage3-mesh-parity:<nonce>` — parity's per-sweep nonce consumers.
 *     Unsubscribing drops the callback but never the row, so a sweep every 15
 *     minutes leaves ~96 rows per mesh per day.
 *
 * `pruneConsumers` is inactive-only, so the live `stage4a-mesh-read-model`
 * consumer and any parity nonce mid-sweep are never eligible — the prefix
 * filters below are belt-and-braces on top of that guard. Called once at boot.
 *
 * Never throws: this is housekeeping, and a daemon that cannot GC cursors is
 * still a correct daemon.
 */
export function pruneStaleReadModelConsumers(meshId: string): string[] {
    const node = activeNode;
    if (!node) return [];
    const topic = meshEventsTopic(meshId);
    if (!node.topics.some((d) => d.topic === topic)) return [];
    return pruneTopicConsumers(node, topic, meshId);
}

/**
 * Boot-time GC across every mesh events topic this node already has defined.
 *
 * ★ Driven by the node's OWN topic list rather than by a mesh roster, because
 * `seqscribe/**` may not import `mesh/**` (check:boundaries) — and the topic
 * list is the better source anyway: a cursor can only exist on a topic that was
 * defined, so this covers exactly the meshes that could have leaked one.
 *
 * Topics defined later (a mesh created after boot) accumulate nothing to GC in
 * this process, since the leak sources are gone — the read model no longer
 * mints generation names and parity no longer registers a consumer at all.
 */
export function pruneStaleConsumersAtBoot(): number {
    const node = activeNode;
    if (!node) return 0;
    let total = 0;
    for (const definition of node.topics) {
        const meshId = meshIdFromEventsTopic(definition.topic);
        if (meshId === null) continue;
        total += pruneTopicConsumers(node, definition.topic, meshId).length;
    }
    return total;
}

function pruneTopicConsumers(
    node: SeqscribeNodeHandle,
    topic: string,
    meshId: string,
): string[] {
    const pruned: string[] = [];
    try {
        // ★ The generation prefix is `…#`, NOT the bare constant: the bare
        // constant is a prefix of itself, and pruning the live consumer's own
        // row would rewind the read model to a full replay on next boot.
        pruned.push(...node.node.pruneConsumers(topic, { prefix: `${READ_MODEL_CONSUMER}#` }));
        pruned.push(...node.node.pruneConsumers(topic, { prefix: `${PARITY_CONSUMER}:` }));
    } catch (error) {
        warnOnce(
            `consumer prune failed topic=${topic}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return pruned;
    }

    if (pruned.length > 0) {
        LOG.info(
            'Seqscribe',
            `pruned ${pruned.length} stale durable consumer(s) mesh=${meshId} — archive gate released`,
        );
    }
    return pruned;
}

/** The consumer name a mesh's index is currently registered under. */
export function meshReadModelConsumerName(meshId: string): string | null {
    return indexes.get(meshId)?.consumerName ?? null;
}

/** Reset all module state. TESTS ONLY. */
export function __resetMeshReadModelForTests(): void {
    for (const index of indexes.values()) {
        try {
            index.unsub?.();
        } catch {
            /* already gone */
        }
    }
    indexes.clear();
    lastRebuildCoverage.clear();
    rebuildEpoch.clear();
    activeNode = null;
    warnedOnce.clear();
}

/** The wired node, for the readiness gate. Internal to the seqscribe layer. */
export function meshReadModelNode(): SeqscribeNodeHandle | null {
    return activeNode;
}

/** True when this mesh has a registered consumer and a live index. */
export function hasMeshReadModelIndex(meshId: string): boolean {
    return indexes.has(meshId);
}
