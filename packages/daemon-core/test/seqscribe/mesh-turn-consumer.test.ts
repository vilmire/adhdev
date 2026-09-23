import { describe, expect, it } from 'vitest';
import { betterSqlite3Handle, createSeqscribe, type SeqscribeNodeExt } from 'seqscribe';
import type { OutboundMessage, SubmitOutcome, TurnEvidence } from '@adhdev/mesh-shared';
// Vendor harness (docs/harness.md): seeded labeled substreams, virtual time, a
// fault-injecting Channel pair — the C8 spec's two-node pair.
import { SeededRng } from '../../../../vendor/seqscribe/harness/rng.js';
import { Scheduler } from '../../../../vendor/seqscribe/harness/scheduler.js';
import { VirtualLink } from '../../../../vendor/seqscribe/harness/bus.js';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';
import { meshEventsPolicy, meshEventsTopic } from '../../src/seqscribe/topics.js';
import {
    armMeshTurnConsumer,
    MESH_INDEX_CONSUMER,
    TURN_DELIVER_CONSUMER,
    TURN_INGEST_CONSUMER,
    type MeshTurnConsumer,
} from '../../src/seqscribe/mesh-turn-consumer.js';
import { announceTopicActivated } from '../../src/seqscribe/mesh-publisher.js';
import {
    createDeliverEdgeWaiter,
    createTurnDeliverCounters,
    createTurnDeliverHandler,
    createTurnIngestHandler,
    type DeliverEdgeWaiter,
} from '../../src/mesh/turn-ledger/deliver.js';
import type { CoordinatorSessionView } from '../../src/mesh/turn-ledger/routing.js';
import { MeshTopicIndex } from '../../src/mesh/mesh-topic-index.js';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';
import type { TurnLedger, TurnPublisherPort } from '../../src/mesh/turn-ledger/ledger.js';
import { dispatch, evd, ledgerOn, memDb } from '../turn-ledger/ledger-harness.js';

// seqscribe/mesh-turn-consumer — the three durable cursors per mesh (C2/C3)
// over REAL seqscribe nodes in virtual time: registration on known AND
// runtime-defined topics, deferral that holds the deliver cursor, escalation
// at the ceiling, shutdown that keeps the cursor, the retired-cursor prune,
// and the two-node C8 pair (lossy / duplicating / partitioned link) pinning
// exactly-once delivery, idempotent replay, and the measured hop chains.

const MESH = 'm1';
const TOPIC = meshEventsTopic(MESH);
const T_BASE = 1_750_000_000_000;
const SENTINEL = 'SENTINEL-mesh-turn-consumer-summary';

function nodeFor(sched: Scheduler, rng: SeededRng, writerId: string, defineMesh = true): SeqscribeNodeExt {
    const Database = loadBetterSqlite3();
    const node = createSeqscribe({
        writerId,
        storage: betterSqlite3Handle(new Database(':memory:')),
        clock: sched.clock(),
        timers: sched.timers(),
        rng: rng.fn(),
        constants: { ANTI_ENTROPY_MS: 2_000, CONTROL_RETRY_MS: 250, CHANNEL_STALL_MS: 4_000, GROUP_COMMIT_MS: 20 },
    }) as SeqscribeNodeExt;
    if (defineMesh) node.defineTopic(TOPIC, meshEventsPolicy());
    return node;
}

function handleOf(node: SeqscribeNodeExt, writerId: string, topics: string[] = [TOPIC]) {
    return { node, writerId, topics: topics.map((topic) => ({ topic, policy: meshEventsPolicy() })) } as any;
}

type Trace = string[];

function tracingPublisher(node: SeqscribeNodeExt, trace: Trace, at: string): TurnPublisherPort {
    return {
        async publish(_meshId, entry, opts) {
            trace.push(`append@${at}:${entry.k}`);
            const [, writer, seq] = await node.log(TOPIC).append(entry.k, entry as never, opts?.ref ? { ref: [opts.ref.topic, opts.ref.writer, opts.ref.seq] } : undefined);
            return { writer, seq };
        },
    };
}

function tracingPort(trace: Trace, at: string): { submit(m: OutboundMessage): Promise<SubmitOutcome>; calls: OutboundMessage[] } {
    const port = {
        calls: [] as OutboundMessage[],
        async submit(msg: OutboundMessage): Promise<SubmitOutcome> {
            trace.push(`submit@${at}`);
            port.calls.push(msg);
            return { kind: 'delivered' };
        },
    };
    return port;
}

/** Record the reduce+txn hop when the ledger writes the notify row (the commit's derived rows). */
function traceTxn(ledger: TurnLedger, trace: Trace, at: string): void {
    const insert = ledger.store.insertEvent.bind(ledger.store);
    ledger.store.insertEvent = (row) => {
        const inserted = insert(row);
        if (inserted && row.kind === 'notify') trace.push(`txn@${at}`);
        return inserted;
    };
}

function traceObserve(ledger: TurnLedger, trace: Trace, at: string): void {
    const observe = ledger.observe.bind(ledger);
    (ledger as { observe: TurnLedger['observe'] }).observe = (evidence, opts) => {
        if (evidence.kind === 'turn_end') trace.push(`observe@${at}`);
        return observe(evidence, opts);
    };
}

interface Daemon {
    id: string;
    writer: string;
    node: SeqscribeNodeExt;
    db: ReturnType<typeof memDb>;
    ledger: TurnLedger;
    index: MeshTopicIndex;
    port: ReturnType<typeof tracingPort>;
    coordinators: CoordinatorSessionView[];
    waiter: DeliverEdgeWaiter;
    consumer: MeshTurnConsumer | null;
    arm(): MeshTurnConsumer;
}

function daemon(sched: Scheduler, rng: SeededRng, id: string, writer: string, trace: Trace): Daemon {
    const node = nodeFor(sched, rng, writer);
    const db = memDb();
    const ledger = ledgerOn(db, { selfDaemonId: id, publisher: tracingPublisher(node, trace, id), now: () => T_BASE + sched.now(), autoFlush: true });
    traceObserve(ledger, trace, id);
    traceTxn(ledger, trace, id);
    const d: Daemon = {
        id, writer, node, db, ledger,
        index: new MeshTopicIndex(db),
        port: tracingPort(trace, id),
        coordinators: [],
        waiter: createDeliverEdgeWaiter({ now: () => T_BASE + sched.now(), timers: sched.timers() as any }),
        consumer: null,
        arm() {
            const counters = createTurnDeliverCounters();
            const ingest = createTurnIngestHandler({ ledger, selfDaemonIds: () => [id], counters });
            const deliver = createTurnDeliverHandler({
                ledger, selfDaemonIds: () => [id], port: d.port, coordinators: () => d.coordinators.map((c) => ({ ...c })),
                waiter: d.waiter, now: () => T_BASE + sched.now(), counters,
            });
            d.consumer = armMeshTurnConsumer(handleOf(node, writer), {
                ingest: (entry) => {
                    if (entry.kind === 'turn.evidence' && !entry.own) trace.push(`ingest@${id}:turn.evidence`);
                    ingest(entry);
                },
                deliver: async (entry, signal) => {
                    if (entry.kind === 'turn.notify' && entry.own) trace.push(`deliver@${id}:turn.notify`);
                    await deliver(entry, signal);
                },
                index: (entry) => { d.index.ingest(entry); },
            });
            d.consumer.ensureKnownMeshes();
            return d.consumer;
        },
    };
    return d;
}

function cursor(node: SeqscribeNodeExt, name: string): number {
    return node.listConsumers(TOPIC).find((c) => c.consumer === name)?.lastRowid ?? -1;
}

function turnEventRows(db: ReturnType<typeof memDb>): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM turn_events').get() as { n: number }).n;
}

function indexRows(db: ReturnType<typeof memDb>): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM mesh_topic_index').get() as { n: number }).n;
}

/** Owner-local attempt through commit (co-located worker): the local hop chain. */
function localTurn(d: Daemon, session = 's1'): void {
    d.ledger.observe(dispatch({ session }));
    d.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service', sessionId: session }));
    d.ledger.observe(evd('turn_started', { retro: false }, { sessionId: session, observedBy: d.id }));
    d.ledger.observe(evd('turn_end', { strength: 'genuine' }, { sessionId: session, observedBy: d.id }), { envelope: { finalSummary: SENTINEL } });
}

describe('mesh-turn-consumer — one node', () => {
    it('local chain = observe → txn → append turn.notify → deliver → submit (5 hops); the index sees every entry', async () => {
        const sched = new Scheduler(0);
        const trace: Trace = [];
        const d = daemon(sched, new SeededRng(1), 'dc', 'wA', trace);
        d.coordinators.push({ sessionId: 'coord', idle: true, modalParked: false });
        d.arm();
        localTurn(d);
        await sched.run({ untilMs: 5_000 });
        const hops = trace.filter((h) => !h.startsWith('append@dc:turn.committed'));
        expect(hops).toEqual(['observe@dc', 'txn@dc', 'append@dc:turn.notify', 'deliver@dc:turn.notify', 'submit@dc']);
        expect(d.port.calls).toHaveLength(1);
        expect(d.port.calls[0]!.input.textFallback).toContain(SENTINEL);
        // Every appended entry indexed (committed + notify); none carries the sentinel.
        expect(indexRows(d.db)).toBe(2);
        const onTopic = d.node.scanEntries(TOPIC, { limit: 100 }).entries;
        for (const e of onTopic) expect(JSON.stringify(e.payload)).not.toContain(SENTINEL);
        const indexed = d.db.prepare('SELECT payload_json FROM mesh_topic_index').all() as Array<{ payload_json: string }>;
        for (const r of indexed) expect(r.payload_json).not.toContain(SENTINEL);
        d.consumer!.dispose();
        await d.node.close();
    });

    it('a busy coordinator HOLDS the deliver cursor (lastRowid unchanged) while index/ingest advance; the idle edge delivers', async () => {
        const sched = new Scheduler(0);
        const d = daemon(sched, new SeededRng(2), 'dc', 'wA', []);
        d.coordinators.push({ sessionId: 'coord', idle: false, modalParked: false });
        d.arm();
        localTurn(d);
        await sched.run({ untilMs: 3_000 });
        expect(d.port.calls).toHaveLength(0);
        const heldAt = cursor(d.node, TURN_DELIVER_CONSUMER);
        expect(cursor(d.node, MESH_INDEX_CONSUMER)).toBeGreaterThan(heldAt);
        expect(cursor(d.node, TURN_INGEST_CONSUMER)).toBeGreaterThan(heldAt);
        await sched.run({ untilMs: 10_000 });
        expect(cursor(d.node, TURN_DELIVER_CONSUMER)).toBe(heldAt);
        // The coordinator goes idle: a bus edge wakes the waiter.
        d.coordinators[0]!.idle = true;
        d.waiter.wake();
        await sched.run({ untilMs: 12_000 });
        expect(d.port.calls).toHaveLength(1);
        expect(cursor(d.node, TURN_DELIVER_CONSUMER)).toBeGreaterThan(heldAt);
        d.consumer!.dispose();
        await d.node.close();
    });

    it('a modal-parked coordinator escalates at entry.at + deliveryCeilingMs with no hold row', async () => {
        const sched = new Scheduler(0);
        const d = daemon(sched, new SeededRng(3), 'dc', 'wA', []);
        d.coordinators.push({ sessionId: 'coord', idle: false, modalParked: true });
        d.arm();
        localTurn(d);
        await sched.run({ untilMs: DEFAULT_TURN_POLICY.deliveryCeilingMs - 5_000 });
        expect(d.port.calls).toHaveLength(0);
        await sched.run({ untilMs: DEFAULT_TURN_POLICY.deliveryCeilingMs + 10_000 });
        expect(d.port.calls).toHaveLength(1);
        expect(d.port.calls[0]!.policy).toEqual({ mode: 'queue' });
        // The deferral is a bound computed from the ENTRY — no hold row ever backs it.
        expect((d.db.prepare(`SELECT COUNT(*) AS n FROM turn_holds WHERE status = 'active'`).get() as { n: number }).n).toBe(0);
        d.consumer!.dispose();
        await d.node.close();
    });

    it('dispose rejects the wait and keeps the cursor; the next process delivers exactly once', async () => {
        const sched = new Scheduler(0);
        const d = daemon(sched, new SeededRng(4), 'dc', 'wA', []);
        d.coordinators.push({ sessionId: 'coord', idle: false, modalParked: false });
        d.arm();
        localTurn(d);
        await sched.run({ untilMs: 3_000 });
        const heldAt = cursor(d.node, TURN_DELIVER_CONSUMER);
        d.consumer!.dispose();
        await sched.run({ untilMs: 6_000 });
        expect(cursor(d.node, TURN_DELIVER_CONSUMER)).toBe(heldAt);
        // "Restart": a fresh consumer on the same node + ledger, coordinator idle.
        d.coordinators[0]!.idle = true;
        d.arm();
        await sched.run({ untilMs: 9_000 });
        expect(d.port.calls).toHaveLength(1);
        d.consumer!.dispose();
        await d.node.close();
    });

    it('registers on a topic defined AFTER arming (mesh create/adopt), and prunes retired cursors at arm time', async () => {
        const sched = new Scheduler(0);
        const node = nodeFor(sched, new SeededRng(5), 'wA', false);
        const handle = handleOf(node, 'wA', []);
        const consumer = armMeshTurnConsumer(handle, { ingest: () => {}, deliver: async () => {}, index: () => {} });
        expect(consumer.meshIds()).toEqual([]);
        node.defineTopic(TOPIC, meshEventsPolicy());
        handle.topics.push({ topic: TOPIC, policy: meshEventsPolicy() });
        announceTopicActivated(handle, TOPIC);
        expect(consumer.meshIds()).toEqual([MESH]);
        const names = node.listConsumers(TOPIC).map((c) => c.consumer).sort();
        expect(names).toEqual([MESH_INDEX_CONSUMER, TURN_DELIVER_CONSUMER, TURN_INGEST_CONSUMER].sort());
        consumer.dispose();

        // Retired cursors left by older builds are pruned (inactive-only) at the next arm.
        const off = node.onEntry(TOPIC, 'stage4a-mesh-read-model#3', () => {});
        off();
        const off2 = node.onEntry(TOPIC, 'stage5a-mesh-terminal-redrive', () => {});
        off2();
        const again = armMeshTurnConsumer(handle, { ingest: () => {}, deliver: async () => {}, index: () => {} });
        expect(again.counters().retiredCursorsPruned).toBe(2);
        expect(node.listConsumers(TOPIC).some((c) => c.consumer.startsWith('stage'))).toBe(false);
        again.dispose();
        await node.close();
    });
});

// ─── two nodes (C8 pair) ─────────────────────────────────────────────────

async function runPair(seed: number): Promise<{ problems: string[]; trace: Trace }> {
    const root = new SeededRng(seed);
    const sched = new Scheduler(0);
    const trace: Trace = [];
    const coord = daemon(sched, root.substream('C'), 'dc', 'wA', trace);
    const worker = daemon(sched, root.substream('W'), 'dw', 'wB', trace);
    const grants = { [TOPIC]: 'full' as const };
    const dial = (gen: number) => {
        const l = new VirtualLink(sched, root.substream(`link${gen}`), { lossP: 0.1, dupP: 0.2 });
        const h = coord.node.attach(l.a, { peerId: 'wB', peerClass: 'content', grants });
        worker.node.attach(l.b, { peerId: 'wA', peerClass: 'content', grants });
        h.onStateChange((s) => { if (s === 'closed') sched.schedule(sched.now() + 250, () => dial(gen + 1)); });
        return l;
    };
    const link = dial(0);
    coord.coordinators.push({ sessionId: 'coord', idle: true, modalParked: false });
    coord.arm();
    worker.arm();

    // The coordinator's daemon dispatches (owns the attempt); the worker's
    // daemon observes the turn and FORWARDS evidence over the topic.
    coord.ledger.observe(dispatch({ session: 's1' }));
    coord.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'p2p' }, { source: 'input_service' }));
    const owner = { daemonId: 'dc', meshId: MESH };
    sched.schedule(300, () => { worker.ledger.observe(evd('turn_started', { retro: false }, { observedBy: 'dw' }), { owner }); });
    sched.schedule(900, () => link.cut(true));
    sched.schedule(2_000, () => { worker.ledger.observe(evd('turn_end', { strength: 'genuine' }, { observedBy: 'dw' }) as TurnEvidence, { owner }); });
    sched.schedule(4_500, () => link.cut(false));
    await sched.run({ untilMs: 60_000 });
    await Promise.all([coord.ledger.flushPublish(), worker.ledger.flushPublish(), sched.run({ untilMs: 90_000 })]);
    await sched.run({ untilMs: 120_000 });

    const problems: string[] = [];
    const committed = (coord.db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE kind = 'committed'`).get() as { n: number }).n;
    if (committed !== 1) problems.push(`${committed} committed rows on the owner`);
    if (coord.port.calls.length !== 1) problems.push(`${coord.port.calls.length} submits on the coordinator (expected 1)`);
    if (worker.port.calls.length !== 0) problems.push('the worker daemon submitted a notice');
    const claims = (coord.db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE event_id LIKE 'delivered:%'`).get() as { n: number }).n;
    if (claims !== 1) problems.push(`${claims} delivered claims`);
    if (indexRows(coord.db) !== indexRows(worker.db)) problems.push(`index rows differ C=${indexRows(coord.db)} W=${indexRows(worker.db)}`);

    // (5) replay every cursor from earliest-retained on the owner: 0 new rows / submits / index rows.
    const before = { rows: turnEventRows(coord.db), submits: coord.port.calls.length, index: indexRows(coord.db) };
    coord.consumer!.dispose();
    for (const name of [TURN_INGEST_CONSUMER, TURN_DELIVER_CONSUMER, MESH_INDEX_CONSUMER]) {
        coord.node.resetConsumer(TOPIC, name, { from: 'earliest-retained' });
    }
    coord.arm();
    await sched.run({ untilMs: sched.now() + 10_000 });
    if (turnEventRows(coord.db) !== before.rows) problems.push(`replay added ${turnEventRows(coord.db) - before.rows} turn_events rows`);
    if (coord.port.calls.length !== before.submits) problems.push(`replay added ${coord.port.calls.length - before.submits} submits`);
    if (indexRows(coord.db) !== before.index) problems.push(`replay added ${indexRows(coord.db) - before.index} index rows`);

    coord.consumer!.dispose();
    worker.consumer!.dispose();
    await coord.node.close();
    await worker.node.close();
    return { problems: problems.map((p) => `seed ${seed}: ${p}`), trace };
}

describe('mesh-turn-consumer — two nodes over a faulty link (C8)', () => {
    it('remote chain = W observe → W append turn.evidence → replication → C ingest+txn → C append turn.notify → C deliver → submit (7 hops)', async () => {
        const { problems, trace } = await runPair(7);
        expect(problems).toEqual([]);
        // The turn_end's causal chain, in order (turn_started's forward is not a notify hop).
        const endAt = trace.indexOf('observe@dw');
        const chain = trace.slice(endAt).filter((h) => [
            'observe@dw', 'append@dw:turn.evidence', 'ingest@dc:turn.evidence', 'txn@dc', 'append@dc:turn.notify', 'deliver@dc:turn.notify', 'submit@dc',
        ].includes(h));
        // Collapse duplicates of the SAME hop (a duplicated transport delivery re-enters ingest; it is idempotent).
        const hops = chain.filter((h, i) => h !== chain[i - 1]);
        const firstIngest = hops.indexOf('ingest@dc:turn.evidence');
        const pinned = [hops[0], hops[1], hops[firstIngest], ...hops.slice(hops.indexOf('txn@dc'), hops.indexOf('submit@dc') + 1)];
        expect(pinned).toEqual(['observe@dw', 'append@dw:turn.evidence', 'ingest@dc:turn.evidence', 'txn@dc', 'append@dc:turn.notify', 'deliver@dc:turn.notify', 'submit@dc']);
    }, 60_000);

    it('exactly-once delivery and idempotent replay across seeds (lossy / duplicating / partitioned)', async () => {
        const seeds = Number(process.env.ADHDEV_TURN_RACE_SEEDS ?? 500);
        const problems: string[] = [];
        for (let seed = 11; seed <= 11 + Math.max(1, Math.floor(seeds / 50)) * 7; seed += 7) problems.push(...(await runPair(seed)).problems);
        expect(problems).toEqual([]);
    }, 120_000);
});
