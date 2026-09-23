/**
 * mesh-publisher — the ONE writer of `mesh.<id>.events` (wiring-unification
 * C2 + C7-1; replaces the Phase 2 `mesh-dual-write.ts` shadow leg).
 *
 * ── What changed from the dual-write shadow ─────────────────────────────────
 * The shadow was a fire-and-forget COPY of a ledger that stayed the system of
 * record, so dropping a record under load was the lesser evil. After C the
 * topic is the only event log (C2/C3), so:
 *
 *   · NO SHED. `MAX_INFLIGHT` 512 load-shed is gone. A publish that finds every
 *     slot taken AWAITS one (`createAwaitedSlots`, inflight-gate.ts). The turn
 *     ledger's durable `turn_events` row stays `publish_state='pending'` until
 *     the append resolves; a crash between the ledger txn and the append is
 *     closed by the boot/tick republish of `pending` rows (ledger.ts).
 *   · NO MODE FLAG. `ADHDEV_SEQSCRIBE_MESH` (`off|shadow|primary`) is removed —
 *     there is no second path to fall back to.
 *   · NO BACKFILL. `backfillMeshEventShadow` (the parity loop's cross-process
 *     repair for mcp-server appends) is deleted; mcp-server writes move to
 *     daemon IPC (C-W6), so every record is published by the process that
 *     holds the node.
 *   · APPEND REJECTION IS AN ERROR. A rejected append (sealed writer,
 *     ERR_STORAGE, closed node) is logged at ERROR, counted, and rethrown to
 *     the caller, whose durable row stays pending for republish.
 *   · TOPICS ARE DEFINED AT BOOT. `activateMeshTopicsAtBoot` throws when a
 *     known mesh's events topic cannot be defined — an unopenable topic is a
 *     mesh boot failure, not a silent skip.
 *
 * ── Entry shapes ────────────────────────────────────────────────────────────
 * Turn entries (`turn.evidence` / `turn.committed` / `turn.notify`) are
 * appended with `kind = entry.k` and payload = the `MeshTopicEntry`, validated
 * by the mesh-shared `isMeshTopicEntry` guard first (content-free by
 * construction: ids, enums, booleans, counters). Text is never inline — it is
 * appended to the content-class `mesh.<id>.handoff` topic and linked with the
 * append `ref` option (`EntryId = [topic, writer, seq]`, C10-1).
 *
 * `mesh.record` entries (every non-turn ledger kind, via `meshRecord`) keep the
 * append kind `adhdev.mesh.ledger` (C3 correction 1: the event type rides in
 * `payload.ledgerKind`) and carry the existing allow-list projection
 * (`projectMeshLedgerEntry`) PLUS the v2 envelope fields (`v`, `k`, `eventId`,
 * `at`), so today's readers of the projection keep parsing it while the C-W3
 * index reads the v2 fields.
 *
 * ── Layering ────────────────────────────────────────────────────────────────
 * `seqscribe/**` may not value-import `mesh/**` (check:boundaries), so the turn
 * ledger (mesh/turn-ledger) calls THIS module, never the reverse.
 */

import type { EntryId, JsonValue } from 'seqscribe';
import { isMeshTopicEntry, type MeshTopicEntry, type SummaryRef } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { createAwaitedSlots } from './inflight-gate.js';
import type { SeqscribeNodeHandle } from './node.js';
import {
    MESH_EVENT_ENTRY_KIND,
    maxEntryBytes,
    projectMeshLedgerEntry,
    toJsonValue,
} from './mesh-event-projection.js';
import { estimateEntryBytes, sanitizeJson } from 'seqscribe';
import {
    meshEventsPolicy,
    meshEventsTopic,
    meshHandoffPolicy,
    meshHandoffTopic,
} from './topics.js';

/**
 * Concurrent appends the publisher keeps in flight. Past it, publishes wait
 * (never drop). Same order of magnitude as the old shed cap: a busy mesh
 * writes a handful per second, so this only binds when the topic stalls.
 */
export const MESH_PUBLISH_SLOTS = 64;

/**
 * Memory guard for `mesh.record` (no durable row behind it): past this many
 * records waiting for a slot, a record is refused with an ERROR and counted —
 * the one bounded refusal left, and it is loud. Turn entries are never refused:
 * their durable row is the queue.
 */
export const MESH_RECORD_MAX_WAITING = 10_000;

/** Counters exposed to stats (local-only diagnostics). */
export interface MeshPublisherCounters {
    /** Turn entries appended. */
    published: number;
    /** Turn-entry appends that rejected (row stays pending → republish). */
    publishFailed: number;
    /** `mesh.record` entries appended. */
    recordsWritten: number;
    /** `mesh.record` appends that rejected or threw. */
    recordsFailed: number;
    /** `mesh.record` refused by the waiter memory guard (ERROR-logged). */
    recordsRefused: number;
    /** Entries refused by the content-boundary guard (a producer bug). */
    invalidEntries: number;
    /** Entries over the seqscribe entry-size ceiling (a projection bug). */
    oversized: number;
    /** Topics that could not be defined. */
    topicErrors: number;
    /** Handoff (content) appends. */
    handoffWritten: number;
}

const counters: MeshPublisherCounters = {
    published: 0,
    publishFailed: 0,
    recordsWritten: 0,
    recordsFailed: 0,
    recordsRefused: 0,
    invalidEntries: 0,
    oversized: 0,
    topicErrors: 0,
    handoffWritten: 0,
};

/** Topics defined (true) or known-undefinable (false) on the current node. */
const definedTopics = new Map<string, boolean>();
/** Mesh ids learned before or after arming; replayed at configure time. */
const discoveredMeshIds = new Set<string>();
let activeNode: SeqscribeNodeHandle | null = null;
const slots = createAwaitedSlots(MESH_PUBLISH_SLOTS);
/** Every append promise still outstanding — `flushMeshPublisher` awaits them. */
const outstanding = new Set<Promise<unknown>>();

const warnedOnce = new Set<string>();
function warnOnce(message: string): void {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    LOG.warn('Seqscribe', message);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Thrown by `activateMeshTopicsAtBoot` — a mesh whose topic cannot be defined cannot run (C7-1). */
export class MeshTopicActivationError extends Error {
    constructor(readonly failedTopics: readonly string[]) {
        super(`mesh topic activation failed for ${failedTopics.join(', ')} — the events topic is the only mesh event path (design C7-1)`);
        this.name = 'MeshTopicActivationError';
    }
}

// ─── runtime topic activation (P14/P15 step 1 → transport step 2) ──────────
//
// Moved verbatim from mesh-dual-write.ts: the registry hangs off the NODE
// HANDLE (not this module) so it is per-node and survives the daemon-core
// module being loaded twice (bundle + tsx source). See that history in git.

type TopicActivatedListener = (topic: string) => void;
const TOPIC_LISTENERS = Symbol.for('adhdev.seqscribe.topicActivatedListeners');
type ListenerHost = { [TOPIC_LISTENERS]?: Set<TopicActivatedListener> };

function listenersFor(node: SeqscribeNodeHandle): Set<TopicActivatedListener> {
    const host = node as unknown as ListenerHost;
    let set = host[TOPIC_LISTENERS];
    if (!set) {
        set = new Set<TopicActivatedListener>();
        Object.defineProperty(node, TOPIC_LISTENERS, { value: set, enumerable: false, writable: false, configurable: true });
    }
    return set;
}

/**
 * Subscribe to runtime topic activation on one node. The transport calls this
 * once and re-derives its grant map + `updateGrants` on every live peer when it
 * fires. Fires only for topics defined after boot.
 */
export function onTopicActivated(node: SeqscribeNodeHandle, listener: TopicActivatedListener): () => void {
    const set = listenersFor(node);
    set.add(listener);
    return () => { set.delete(listener); };
}

/** Announce a runtime-defined topic to one node's subscribers. Never throws. */
export function announceTopicActivated(node: SeqscribeNodeHandle, topic: string): void {
    for (const listener of listenersFor(node)) {
        try {
            listener(topic);
        } catch (error) {
            warnOnce(`topic activation listener failed (further failures logged once) topic=${topic}: ${errorMessage(error)}`);
        }
    }
}

function defineOnce(node: SeqscribeNodeHandle, topic: string, policy: ReturnType<typeof meshEventsPolicy>): boolean {
    const known = definedTopics.get(topic);
    if (known !== undefined) return known;
    // Adopt a topic defined at node open (tests, boot paths that know meshes).
    if (node.topics.some((d) => d.topic === topic)) {
        definedTopics.set(topic, true);
        return true;
    }
    try {
        node.node.defineTopic(topic, policy);
        // `handle.topics` must stay truthful BEFORE the announcement: the
        // listener re-derives its FULL grant map from it (P15 replaces).
        node.topics.push({ topic, policy });
        definedTopics.set(topic, true);
        LOG.info('Seqscribe', `mesh topic defined topic=${topic}`);
        announceTopicActivated(node, topic);
        return true;
    } catch (error) {
        definedTopics.set(topic, false);
        counters.topicErrors++;
        LOG.error('Seqscribe', `mesh topic could not be defined topic=${topic}: ${errorMessage(error)}`);
        return false;
    }
}

function ensureEventsTopic(node: SeqscribeNodeHandle, meshId: string): string | null {
    const topic = meshEventsTopic(meshId);
    return defineOnce(node, topic, meshEventsPolicy()) ? topic : null;
}

/** Content-class companion; an authority-less node cannot define it by design (C7-3 is C-W6). */
function ensureHandoffTopic(node: SeqscribeNodeHandle, meshId: string): string | null {
    if (!node.authorityEnabled) return null;
    const topic = meshHandoffTopic(meshId);
    return defineOnce(node, topic, meshHandoffPolicy()) ? topic : null;
}

function activateNow(meshIds: Iterable<string>): { activated: number; failed: string[] } {
    const node = activeNode;
    if (!node) return { activated: 0, failed: [] };
    let activated = 0;
    const failed: string[] = [];
    for (const meshId of meshIds) {
        const eventsTopic = meshEventsTopic(meshId);
        const handoffTopic = meshHandoffTopic(meshId);
        const eventsKnown = definedTopics.get(eventsTopic) === true;
        const handoffKnown = definedTopics.get(handoffTopic) === true;
        if (!ensureEventsTopic(node, meshId)) failed.push(eventsTopic);
        ensureHandoffTopic(node, meshId);
        if ((!eventsKnown && definedTopics.get(eventsTopic) === true) || (!handoffKnown && definedTopics.get(handoffTopic) === true)) {
            activated++;
        }
    }
    return { activated, failed };
}

function normalizeMeshIds(meshIds: readonly string[]): string[] {
    const out: string[] = [];
    for (const meshId of meshIds) {
        if (typeof meshId !== 'string') continue;
        const normalized = meshId.trim();
        if (!normalized) continue;
        discoveredMeshIds.add(normalized);
        out.push(normalized);
    }
    return out;
}

/**
 * Define the events/handoff pair for meshes this daemon learns about at RUNTIME
 * (a P2P command revealing `meshId`), without waiting for a local write — a
 * consume-only node otherwise never defines the topic and `mutualFull` stays
 * false. Never throws (a command path must not fail on it); a failure is an
 * ERROR log + counter. Returns the number of mesh scopes newly activated.
 */
export function activateKnownMeshTopics(meshIds: readonly string[]): number {
    return activateNow(normalizeMeshIds(meshIds)).activated;
}

/**
 * Boot-time activation: every known mesh's events topic MUST be definable.
 * Throws `MeshTopicActivationError` naming the topics that failed.
 */
export function activateMeshTopicsAtBoot(meshIds: readonly string[]): number {
    const { activated, failed } = activateNow(normalizeMeshIds(meshIds));
    if (failed.length > 0) throw new MeshTopicActivationError(failed);
    return activated;
}

/** Wire the publisher to a node (boot) or detach it (`null`, shutdown). */
export function configureMeshPublisher(node: SeqscribeNodeHandle | null): void {
    activeNode = node;
    definedTopics.clear();
    slots.reset();
    if (node) {
        LOG.info('Seqscribe', `mesh publisher armed writer=${node.writerId}`);
        if (discoveredMeshIds.size > 0) activateNow(discoveredMeshIds);
    }
}

export function isMeshPublisherArmed(): boolean {
    return activeNode !== null;
}

/** The armed node's writer id (the `src_writer` of this daemon's own entries). */
export function meshPublisherWriterId(): string | null {
    return activeNode?.writerId ?? null;
}

// ─── appends ─────────────────────────────────────────────────────────────

function track<T>(promise: Promise<T>): Promise<T> {
    outstanding.add(promise);
    const done = () => { outstanding.delete(promise); };
    promise.then(done, done);
    return promise;
}

async function appendWithSlot(
    node: SeqscribeNodeHandle,
    topic: string,
    kind: string,
    payload: JsonValue,
    ref?: EntryId,
): Promise<EntryId> {
    const release = await slots.acquire();
    try {
        return await node.node.log(topic).append(kind, payload, ref ? { ref } : undefined);
    } finally {
        release();
    }
}

function assertSize(topic: string, kind: string, payload: JsonValue): void {
    const estimated = estimateEntryBytes({ topic, kind, payload });
    const ceiling = maxEntryBytes();
    if (estimated > ceiling) {
        counters.oversized++;
        throw new Error(`entry over the seqscribe size ceiling (${estimated}B > ${ceiling}B, kind=${kind}) — a projection bug`);
    }
}

/** Convert a `SummaryRef` to the vendor `EntryId` the append `ref` option takes. */
export function summaryRefToEntryId(ref: SummaryRef): EntryId {
    return [ref.topic, ref.writer, ref.seq];
}

/**
 * ALLOW-LIST projection of a turn entry: rebuild it field by field from the
 * declared keys of its `k`. The mesh-shared guard validates the declared
 * fields but does not refuse UNDECLARED keys, so this rebuild — never a spread
 * — is what guarantees nothing a producer added (a summary, an error string)
 * reaches the metadata-class topic. Returns null for a `mesh.record` or an
 * invalid entry.
 */
export function projectTurnTopicEntry(entry: MeshTopicEntry): MeshTopicEntry | null {
    if (!isMeshTopicEntry(entry)) return null;
    const head = { v: entry.v, eventId: entry.eventId, at: entry.at };
    const opt = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value } as Record<K, V>);
    switch (entry.k) {
        case 'turn.evidence':
            return {
                ...head, k: entry.k, attemptId: entry.attemptId, generation: entry.generation, ownerDaemonId: entry.ownerDaemonId,
                ...opt('taskId', entry.taskId), sessionId: entry.sessionId, ev: entry.ev, ...opt('strength', entry.strength),
                ...opt('flags', entry.flags), ...opt('evidence', entry.evidence),
            };
        case 'turn.committed':
            return {
                ...head, k: entry.k, attemptId: entry.attemptId, generation: entry.generation, ...opt('taskId', entry.taskId),
                outcome: entry.outcome, strength: entry.strength, reason: entry.reason,
            };
        case 'turn.notify':
            return {
                ...head, k: entry.k, ...opt('attemptId', entry.attemptId), notify: entry.notify, targetDaemonId: entry.targetDaemonId,
                ...opt('targetSessionId', entry.targetSessionId), ...opt('taskId', entry.taskId),
            };
        default:
            return null;
    }
}

/**
 * Append one turn entry to `mesh.<meshId>.events`. AWAITS a publish slot (never
 * drops) and resolves with the appended `[topic, writer, seq]`. Rejects when
 * the publisher is unarmed, the entry fails the content guard, the topic cannot
 * be defined, or the append rejects — the caller keeps its durable row pending
 * and republishes.
 */
export function publishMeshTopicEntry(meshId: string, entry: MeshTopicEntry, opts: { ref?: SummaryRef } = {}): Promise<EntryId> {
    const node = activeNode;
    if (!node) return Promise.reject(new Error('mesh publisher not armed (no seqscribe node)'));
    const projected = projectTurnTopicEntry(entry);
    if (!projected) {
        counters.invalidEntries++;
        LOG.error('Seqscribe', `mesh publisher refused an entry that fails the content guard k=${(entry as { k?: unknown })?.k}`);
        return Promise.reject(new Error('mesh topic entry failed the content-boundary guard'));
    }
    if (Object.keys(projected).length !== Object.keys(entry).length) {
        counters.invalidEntries++;
        warnOnce(`mesh publisher dropped undeclared field(s) from a ${entry.k} entry (allow-list projection; further occurrences logged once)`);
    }
    const topic = ensureEventsTopic(node, meshId);
    if (!topic) return Promise.reject(new Error(`mesh events topic unavailable for mesh ${meshId}`));
    const payload = sanitizeJson(projected) as JsonValue;
    try {
        assertSize(topic, entry.k, payload);
    } catch (error) {
        LOG.error('Seqscribe', `mesh publisher: ${errorMessage(error)}`);
        return Promise.reject(error);
    }
    const ref = opts.ref ? summaryRefToEntryId(opts.ref) : undefined;
    return track(appendWithSlot(node, topic, entry.k, payload, ref).then(
        (id) => { counters.published++; return id; },
        (error: unknown) => {
            counters.publishFailed++;
            LOG.error('Seqscribe', `mesh publish rejected topic=${topic} k=${entry.k} eventId=${entry.eventId}: ${errorMessage(error)} — row stays pending for republish`);
            throw error;
        },
    ));
}

/**
 * Append text-bearing content to the content-class `mesh.<meshId>.handoff`
 * topic and return the `SummaryRef` a turn entry links by `ref`. Rejects when
 * the node has no authority (standalone without C7-3's local authority).
 */
export function appendMeshHandoff(meshId: string, kind: string, payload: JsonValue): Promise<SummaryRef> {
    const node = activeNode;
    if (!node) return Promise.reject(new Error('mesh publisher not armed (no seqscribe node)'));
    const topic = ensureHandoffTopic(node, meshId);
    if (!topic) return Promise.reject(new Error(`mesh handoff topic unavailable for mesh ${meshId} (authority ${node.authorityEnabled ? 'on' : 'off'})`));
    const safe = sanitizeJson(payload) as JsonValue;
    try {
        assertSize(topic, kind, safe);
    } catch (error) {
        return Promise.reject(error);
    }
    return track(appendWithSlot(node, topic, kind, safe).then((id) => {
        counters.handoffWritten++;
        return { topic: id[0], writer: id[1], seq: id[2] };
    }));
}

/** Ledger-entry shape `meshRecord` accepts (structural: seqscribe may not import mesh). */
export interface MeshRecordEntry {
    id: string;
    timestamp: string;
    kind: string;
    nodeId?: string | undefined;
    sessionId?: string | undefined;
    providerType?: string | undefined;
    taskId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
}

/** The `mesh.record` payload: the allow-list projection + the v2 envelope. */
export function projectMeshRecord(entry: MeshRecordEntry): JsonValue {
    const projected = projectMeshLedgerEntry(entry);
    const at = Date.parse(projected.timestamp);
    return {
        ...(toJsonValue(projected) as Record<string, JsonValue>),
        v: 2,
        k: 'mesh.record',
        eventId: projected.id,
        at: Number.isFinite(at) ? at : 0,
    } as JsonValue;
}

/**
 * Publish one non-turn mesh record (`meshRecord`). Synchronous and
 * non-throwing (called from ledger-append hot paths); the append itself waits
 * for a slot. Returns false when unarmed, oversized, or refused by the waiter
 * memory guard (ERROR-logged, counted — never silent).
 */
export function publishMeshRecord(meshId: string, entry: MeshRecordEntry): boolean {
    try {
        const node = activeNode;
        if (!node) return false;
        const topic = ensureEventsTopic(node, meshId);
        if (!topic) return false;
        const payload = projectMeshRecord(entry);
        assertSize(topic, MESH_EVENT_ENTRY_KIND, payload);
        if (slots.waiting() >= MESH_RECORD_MAX_WAITING) {
            counters.recordsRefused++;
            LOG.error('Seqscribe', `mesh.record refused: ${slots.waiting()} publishes waiting for a slot (topic stalled?) ledgerKind=${entry.kind} mesh=${meshId}`);
            return false;
        }
        void track(appendWithSlot(node, topic, MESH_EVENT_ENTRY_KIND, payload).then(
            () => { counters.recordsWritten++; },
            (error: unknown) => {
                counters.recordsFailed++;
                LOG.error('Seqscribe', `mesh.record append rejected topic=${topic} ledgerKind=${entry.kind}: ${errorMessage(error)}`);
            },
        ));
        return true;
    } catch (error) {
        counters.recordsFailed++;
        LOG.error('Seqscribe', `mesh.record publish failed ledgerKind=${entry.kind}: ${errorMessage(error)}`);
        return false;
    }
}

/** Await every append currently outstanding (tests, shutdown). */
export async function flushMeshPublisher(): Promise<void> {
    while (outstanding.size > 0) {
        await Promise.allSettled([...outstanding]);
    }
}

export function meshPublisherCounters(): MeshPublisherCounters {
    return { ...counters };
}

export function meshPublisherInflight(): { inflight: number; waiting: number } {
    return { inflight: slots.inflight(), waiting: slots.waiting() };
}

// ─── legacy read-side aliases (deleted with C-W3's read-model/readiness) ──
//
// `mesh-read-readiness.ts` and `local-stats.ts` (C-W3 deletion/rewrite
// targets) still ask these questions. They are answered HONESTLY for the new
// world rather than kept as the old flag:
//   · the write leg is "active" iff a node is armed;
//   · the read cut-over is OFF: with the backfill deleted, the replica no
//     longer receives mcp-server appends until C-W6 routes them over IPC, so
//     every switched read stays on the ledger until C-W3 replaces the read
//     model with `mesh_topic_index`. Fail-closed on the read path, as before.

/** @deprecated C-W3 removes the read model; true iff the publisher has a node. */
export function isMeshDualWriteActive(): boolean {
    return activeNode !== null;
}

let forcedReadPrimary = false;

/**
 * @deprecated C7-2 retires the read cut-over gate: false in production (reads
 * stay on the complete ledger — see the section note). Only the readiness
 * gate's own tests flip it, until C-W3 deletes mesh-read-readiness.
 */
export function isMeshReadPrimary(): boolean {
    return forcedReadPrimary && activeNode !== null;
}

/** TESTS ONLY — exercise the (deprecated) readiness gate while it still exists. */
export function __forceMeshReadPrimaryForTests(on: boolean): void {
    forcedReadPrimary = on;
}

/** @deprecated shape kept for local-stats' `dualWrite` bucket until C-W3 rewrites it. */
export function meshDualWriteCounters(): { written: number; failed: number; dropped: number; backfilled: number; oversized: number; topicErrors: number } {
    return {
        written: counters.recordsWritten + counters.published,
        failed: counters.recordsFailed + counters.publishFailed,
        dropped: counters.recordsRefused,
        backfilled: 0,
        oversized: counters.oversized,
        topicErrors: counters.topicErrors,
    };
}

// `tests/seqscribe-convergence.test.mjs` switched to the publisher names
// (C-W2 REQUESTED EDIT, done); `recordMeshEventShadow` had no other caller and
// is removed. The three below stay: `tests/seqscribe-read-primary.test.mjs`
// and `tests/seqscribe-read-stage4b.test.mjs` still drive the write leg
// through these old names deliberately — they exercise the Stage 4A/4B read
// model, which C-W3 removes together with these tests, so the rename is left
// for that deletion rather than done piecemeal here.
/** @deprecated use configureMeshPublisher. */
export function configureMeshDualWrite(node: SeqscribeNodeHandle | null, _env?: NodeJS.ProcessEnv): void {
    configureMeshPublisher(node);
}
/** @deprecated use meshPublisherInflight. */
export function meshDualWriteInflight(): number {
    return slots.inflight() + slots.waiting();
}
/** @deprecated use __resetMeshPublisherForTests. */
export function __resetMeshDualWriteForTests(): void {
    __resetMeshPublisherForTests();
}

/** Reset all module state. TESTS ONLY (listeners live on node handles; see onTopicActivated). */
export function __resetMeshPublisherForTests(): void {
    activeNode = null;
    definedTopics.clear();
    discoveredMeshIds.clear();
    slots.reset();
    outstanding.clear();
    warnedOnce.clear();
    forcedReadPrimary = false;
    for (const key of Object.keys(counters) as Array<keyof MeshPublisherCounters>) counters[key] = 0;
}
