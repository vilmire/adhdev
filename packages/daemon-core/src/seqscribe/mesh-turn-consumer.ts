/**
 * mesh-turn-consumer — the durable cursors on `mesh.<id>.events` (wiring-
 * unification C2 / C3, C-W3). Generalized from the Stage 5a
 * `mesh-terminal-redrive-consumer.ts` it replaces.
 *
 * Three cursors per mesh, each registered through `ConsumerHub.onEntry`
 * (at-least-once, serial per consumer, local rowid order; the cursor advances
 * only after the callback resolves; a throw retries with backoff
 * 100 ms·2ⁿ ≤ 30 s — vendor/consume.ts):
 *
 *   `turn.ingest`   — NEVER DEFERS. Foreign-writer `turn.evidence` owned by
 *                     this daemon → `ledger.observe()`; `turn.committed` for a
 *                     locally held attempt ref → release; a foreign
 *                     `turn.notify` addressed here → re-issued as an own notice.
 *                     Idempotent on the entry `eventId` (the ledger's PK).
 *   `turn.deliver`  — own-writer `turn.notify` addressed to this daemon →
 *                     `SessionInputPort.submit`. MAY DEFER: the handler awaits
 *                     a bus edge (never throws for a deferral — a throw would
 *                     back off to 30 s). Head-of-line is per mesh per daemon,
 *                     which is today's per-mesh delivery order (C10-5).
 *   `mesh.index`    — every entry of every writer → `mesh_topic_index`.
 *
 * ★ POLICY IS INJECTED. `check:boundaries` forbids `seqscribe/** → mesh/**`
 * value imports, so the three handlers arrive from the boot stage (which may
 * import both). This file owns only the cursor mechanics: which topics, which
 * names, when to register, and how a callback's outcome maps onto the cursor.
 *
 * ★ REGISTERS ON TOPIC DEFINITION, not only at boot (C-W3 audit): the redrive
 * consumer was registered solely by `ensureTerminalRedriveConsumersAtBoot`, so a
 * mesh created after boot had no consumer until restart. Here every mesh events
 * topic already on the node is registered at arm time AND every topic the
 * publisher defines later (`onTopicActivated` — mesh create / adopt / a P2P
 * command revealing a mesh) is registered as it appears.
 *
 * ★ SHUTDOWN REJECTS THE WAIT, the cursor stays: `dispose()` aborts every
 * in-flight deliver wait and unsubscribes; the vendor does not advance a cursor
 * whose consumer was unsubscribed while its callback ran, so the entry is
 * delivered by the next process.
 */

import type { LogEntry } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import { onTopicActivated } from './mesh-publisher.js';
import { meshIdFromEventsTopic } from './topics.js';

export const TURN_INGEST_CONSUMER = 'turn.ingest';
export const TURN_DELIVER_CONSUMER = 'turn.deliver';
/** Same string as `mesh/mesh-topic-index.ts` MESH_INDEX_CONSUMER (duplicated: seqscribe may not import mesh). */
export const MESH_INDEX_CONSUMER = 'mesh.index';

/**
 * Durable cursor prefixes of retired consumers, pruned at arm time so they
 * stop holding the topic's archive floor open (C3 correction 4):
 * the in-memory read model (`stage4a-mesh-read-model` + `#<gen>`), the parity
 * sweep nonces (`stage3-mesh-parity:`) and the Stage 5a terminal redrive.
 */
export const RETIRED_MESH_CONSUMER_PREFIXES = [
    'stage4a-mesh-read-model',
    'stage3-mesh-parity',
    'stage5a-mesh-terminal-redrive',
] as const;

/** One entry as a handler receives it. `own` = written by this node's writer. */
export interface MeshTopicCursorEntry {
    meshId: string;
    topic: string;
    writer: string;
    seq: number;
    /** Append kind (`turn.evidence|committed|notify` or `adhdev.mesh.ledger`). */
    kind: string;
    payload: unknown;
    /** The append `ref` (a `mesh.<id>.handoff` entry id), when the producer linked one. */
    ref?: { topic: string; writer: string; seq: number };
    own: boolean;
}

export interface MeshTurnConsumerHandlers {
    /** `turn.ingest` — must not defer. A throw backs off and retries the entry. */
    ingest(entry: MeshTopicCursorEntry): void | Promise<void>;
    /**
     * `turn.deliver` — may await (deferral). `signal` aborts on dispose; the
     * handler must reject then (so the cursor holds), never resolve.
     */
    deliver(entry: MeshTopicCursorEntry, signal: AbortSignal): Promise<void>;
    /** `mesh.index` — synchronous row insert. A throw backs off and retries. */
    index(entry: MeshTopicCursorEntry): void;
}

export interface MeshTurnConsumerCounters {
    /** Meshes with all three cursors registered. */
    meshes: number;
    ingestEntries: number;
    ingestFailures: number;
    deliverEntries: number;
    deliverFailures: number;
    indexEntries: number;
    indexFailures: number;
    /** Retired cursor rows pruned at arm time. */
    retiredCursorsPruned: number;
    registerFailures: number;
}

export interface MeshTurnConsumer {
    /** Register the three cursors on one mesh's events topic. Idempotent; false when the topic is not defined. */
    ensureMesh(meshId: string): boolean;
    /** Register on every mesh events topic already defined on the node. Returns the count registered. */
    ensureKnownMeshes(): number;
    meshIds(): string[];
    counters(): MeshTurnConsumerCounters;
    /** Unsubscribe everything and reject in-flight deliver waits. Cursors persist. */
    dispose(): void;
}

export interface ArmMeshTurnConsumerOptions {
    /** Skip the retired-cursor prune (tests that inspect cursors). */
    skipRetiredPrune?: boolean;
    /** Which cursors to arm (default all three). */
    cursors?: ReadonlyArray<'ingest' | 'deliver' | 'index'>;
}

type NodeHandle = Pick<SeqscribeNodeHandle, 'node' | 'writerId' | 'topics'>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toCursorEntry(meshId: string, topic: string, entry: LogEntry, ownWriter: string): MeshTopicCursorEntry {
    const ref = Array.isArray(entry.ref) && entry.ref.length === 3
        ? { topic: String(entry.ref[0]), writer: String(entry.ref[1]), seq: Number(entry.ref[2]) }
        : undefined;
    return {
        meshId,
        topic,
        writer: entry.writer,
        seq: entry.seq,
        kind: entry.kind,
        payload: entry.payload,
        ...(ref ? { ref } : {}),
        own: entry.writer === ownWriter,
    };
}

/**
 * Prune retired durable cursors on every mesh events topic of the node.
 * Inactive-only by the vendor contract (`pruneConsumers`), best-effort.
 */
export function pruneRetiredMeshConsumers(node: NodeHandle): number {
    let total = 0;
    for (const definition of node.topics) {
        const meshId = meshIdFromEventsTopic(definition.topic);
        if (meshId === null) continue;
        for (const prefix of RETIRED_MESH_CONSUMER_PREFIXES) {
            try {
                total += node.node.pruneConsumers(definition.topic, { prefix }).length;
            } catch (error) {
                LOG.warn('MeshTurnConsumer', `retired cursor prune failed topic=${definition.topic} prefix=${prefix}: ${errorMessage(error)}`);
            }
        }
    }
    if (total > 0) LOG.info('MeshTurnConsumer', `pruned ${total} retired durable cursor(s) (read model / parity / redrive) — archive floor released`);
    return total;
}

/**
 * Arm the three per-mesh cursors on `node` with injected handlers. One armed
 * consumer per node; `dispose()` before arming another.
 */
export function armMeshTurnConsumer(
    node: NodeHandle,
    handlers: MeshTurnConsumerHandlers,
    opts: ArmMeshTurnConsumerOptions = {},
): MeshTurnConsumer {
    const cursors = new Set(opts.cursors ?? ['ingest', 'deliver', 'index']);
    const registrations = new Map<string, Array<() => void>>();
    const abort = new AbortController();
    let disposed = false;
    const counters: MeshTurnConsumerCounters = {
        meshes: 0, ingestEntries: 0, ingestFailures: 0, deliverEntries: 0, deliverFailures: 0,
        indexEntries: 0, indexFailures: 0, retiredCursorsPruned: 0, registerFailures: 0,
    };
    const ownWriter = node.writerId;

    if (!opts.skipRetiredPrune) counters.retiredCursorsPruned = pruneRetiredMeshConsumers(node);

    function ensureMesh(meshId: string): boolean {
        if (disposed) return false;
        const topic = node.topics.find((d) => meshIdFromEventsTopic(d.topic) === meshId)?.topic;
        if (!topic) return false;
        if (registrations.has(topic)) return true;
        const unsubs: Array<() => void> = [];
        try {
            if (cursors.has('index')) {
                unsubs.push(node.node.onEntry(topic, MESH_INDEX_CONSUMER, (entry) => {
                    counters.indexEntries++;
                    try {
                        handlers.index(toCursorEntry(meshId, topic, entry, ownWriter));
                    } catch (error) {
                        counters.indexFailures++;
                        throw error;
                    }
                }));
            }
            if (cursors.has('ingest')) {
                unsubs.push(node.node.onEntry(topic, TURN_INGEST_CONSUMER, async (entry) => {
                    counters.ingestEntries++;
                    try {
                        await handlers.ingest(toCursorEntry(meshId, topic, entry, ownWriter));
                    } catch (error) {
                        counters.ingestFailures++;
                        throw error;
                    }
                }));
            }
            if (cursors.has('deliver')) {
                unsubs.push(node.node.onEntry(topic, TURN_DELIVER_CONSUMER, async (entry) => {
                    counters.deliverEntries++;
                    try {
                        // ★ Awaited: a rejection holds the cursor (backoff retry).
                        // A deferral is an await INSIDE the handler, never a throw.
                        await handlers.deliver(toCursorEntry(meshId, topic, entry, ownWriter), abort.signal);
                    } catch (error) {
                        counters.deliverFailures++;
                        throw error;
                    }
                }));
            }
        } catch (error) {
            counters.registerFailures++;
            for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
            LOG.warn('MeshTurnConsumer', `cursor registration failed topic=${topic}: ${errorMessage(error)}`);
            return false;
        }
        registrations.set(topic, unsubs);
        counters.meshes = registrations.size;
        return true;
    }

    function ensureKnownMeshes(): number {
        let registered = 0;
        for (const definition of node.topics) {
            const meshId = meshIdFromEventsTopic(definition.topic);
            if (meshId === null) continue;
            if (ensureMesh(meshId)) registered++;
        }
        return registered;
    }

    // Topics the publisher defines AFTER arming (mesh create/adopt at runtime).
    const offActivated = onTopicActivated(node as SeqscribeNodeHandle, (topic) => {
        const meshId = meshIdFromEventsTopic(topic);
        if (meshId === null) return;
        if (ensureMesh(meshId)) LOG.info('MeshTurnConsumer', `turn cursors registered on runtime-defined topic=${topic}`);
    });

    return {
        ensureMesh,
        ensureKnownMeshes,
        meshIds: () => [...registrations.keys()].map((t) => meshIdFromEventsTopic(t) ?? t).sort(),
        counters: () => ({ ...counters }),
        dispose() {
            if (disposed) return;
            disposed = true;
            abort.abort(new Error('mesh turn consumer disposed'));
            try { offActivated(); } catch { /* noop */ }
            for (const unsubs of registrations.values()) {
                for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
            }
            registrations.clear();
            counters.meshes = 0;
        },
    };
}
