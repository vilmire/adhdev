import { describe, expect, it } from 'vitest';
import { betterSqlite3Handle, createSeqscribe, type LogEntry, type SeqscribeNodeExt } from 'seqscribe';
import type { TurnEvidence } from '@adhdev/mesh-shared';
// Vendor harness (docs/harness.md): seeded labeled substreams, virtual time, a
// fault-injecting Channel pair. Type-only imports of the vendor src, so these
// load standalone next to the `seqscribe` dist the daemon uses.
import { SeededRng } from '../../../../vendor/seqscribe/harness/rng.js';
import { Scheduler } from '../../../../vendor/seqscribe/harness/scheduler.js';
import { VirtualLink } from '../../../../vendor/seqscribe/harness/bus.js';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';
import { meshEventsPolicy, meshEventsTopic } from '../../src/seqscribe/topics.js';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';
import type { TurnLedger, TurnPublisherPort } from '../../src/mesh/turn-ledger/ledger.js';
import { LIVE_IDLE, SUMMARY, fakePublisher, ledgerOn, memDb, recordingHost } from './ledger-harness.js';

// C8 race harness (wiring-unification §5 C8; harness spec scratchpad
// phase-C8-test-harness-spec.md). Seeded, enumerated, no property library:
// every failing seed prints its full evidence sequence for promotion into a
// hand-written regression case.
//
//   Part A (ledger over in-memory SQLite, 500 seeds; ADHDEV_TURN_RACE_SEEDS
//   overrides): N ∈ {1,3,8} attempts × M ∈ {1,2} coordinators, per-attempt
//   scripts with reclaims, late g−1 completions, report-then-scrape, duplicates
//   and bounded reorder, interleaved; hold expiry swept on a moving clock.
//     (1) ≤1 committed row per attempt; the graph/queue effect ran once with the
//         committed outcome;
//     (2) each committed mesh attempt → exactly one terminal-class notify row;
//     (3) generation never decreases; a recorded verdict never changes the
//         attempt; R27a only adopts while g had not started;
//     (4) no active hold on a terminal attempt; every open non-plain attempt
//         holds an active hard_ceiling.
//   Part B (two seqscribe nodes over a lossy/duplicating/partitioned
//   VirtualLink, every 25th seed): a worker ledger forwards evidence, the owner
//   ingests it through an `onEntry` cursor (the C-W3 turn.ingest shape).
//     (5) topic replay from earliest-retained adds 0 turn_events rows;
//     (6) transport duplicates + a manual re-append of a published entry
//         collapse to one effect;
//     (7) after quiescence no row is `pending` on either node and both nodes'
//         vectors() agree.
//   Invariant (8), content boundary, is turn-ledger-content-boundary.test.ts.

const SEEDS = Number(process.env.ADHDEV_TURN_RACE_SEEDS ?? 500);
const T_BASE = 1_750_000_000_000;

interface Scripted { attemptId: string; taskId: string; events: TurnEvidence[] }

function genScript(rng: SeededRng, idx: number, coordinator: string): Scripted {
    const attemptId = `a${idx}`;
    const taskId = `t${idx}`;
    let n = 0;
    let gen = 0;
    let session = `s${idx}g0`;
    const ev = <T extends object>(kind: string, body: T, extra: Partial<TurnEvidence> = {}): TurnEvidence => ({
        eventId: `${attemptId}-e${n++}`, at: T_BASE + n, source: 'fsm_edge', sessionId: session, observedBy: 'dw',
        attemptRef: { attemptId, generation: gen }, taskId, kind, ...body, ...extra,
    }) as TurnEvidence;
    const events: TurnEvidence[] = [
        ev('dispatch_accepted', { scope: 'mesh_queue', messageId: `m${idx}`, meshId: 'm1', coordinator: { daemonId: coordinator, coordinatorRunId: 'r', sessionId: `coord-${coordinator}` } }, { source: 'dispatch', observedBy: 'dc' }),
    ];
    const late: TurnEvidence[] = [];
    const reclaims = rng.int(3);
    for (let r = 0; r <= reclaims; r++) {
        if (rng.next() < 0.9) events.push(ev('delivered', { messageId: `m${idx}g${gen}`, outcome: 'delivered', via: 'p2p' }, { source: 'input_service' }));
        if (rng.next() < 0.85) events.push(ev('turn_started', { retro: rng.next() < 0.2 }));
        for (let k = rng.int(3); k > 0; k--) {
            const pick = rng.int(4);
            if (pick === 0) events.push(ev('transcript_activity', { newestActivityAt: T_BASE + n }));
            else if (pick === 1) { events.push(ev('suspension', { modal: rng.next() < 0.5 ? 'approval' : 'choice' })); events.push(ev('suspension_resolved', { resolution: 'approved', via: 'modal_button' })); }
            else if (pick === 2) events.push(ev('liveness', { result: rng.next() < 0.7 ? 'alive' : 'unknown' }, { source: 'coordinator_probe' }));
            else events.push(ev('no_progress', { stalledMs: 200_000, observedStatus: 'generating', finalAssistantPresent: false }));
        }
        if (r < reclaims) {
            events.push(ev('process_exit', { exitCode: 137 }, { source: 'pty_exit' }));
            if (rng.next() < 0.5) {
                const kind = rng.next() < 0.5 ? 'turn_end' : 'worker_report';
                late.push(kind === 'turn_end'
                    ? ev('turn_end', { strength: 'genuine', summary: SUMMARY })
                    : ev('worker_report', { outcome: 'completed', summary: SUMMARY, hasHandoffNotes: false }, { source: 'worker_tool' }));
            }
            gen += 1;
            session = `s${idx}g${gen}`;
            continue;
        }
        const end = rng.int(7);
        if (end === 0) events.push(ev('turn_end', { strength: 'genuine', summary: SUMMARY }));
        else if (end === 1) events.push(ev('turn_end', { strength: 'weak' }));
        else if (end === 2) {
            events.push(ev('worker_report', { outcome: rng.next() < 0.8 ? 'completed' : 'blocked', summary: SUMMARY, hasHandoffNotes: false }, { source: 'worker_tool' }));
            events.push(ev('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }, { source: 'mcp_probe' }));
        } else if (end === 3) events.push(ev('transcript_final', { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }, { source: 'coordinator_probe' }));
        else if (end === 4) events.push(ev('session_error', { reason: 'provider_error' }));
        else if (end === 5) events.push(ev('cancel', { reason: 'operator_cancel' }, { source: 'operator' }));
        else events.push(ev('turn_end', { strength: 'genuine', hollow: true }));
    }
    // Late g−1 completions land somewhere after their reclaim.
    for (const l of late) {
        const reclaimAt = events.findIndex((e) => e.kind === 'process_exit' && e.attemptRef?.generation === l.attemptRef?.generation);
        const at = reclaimAt + 1 + rng.int(Math.max(1, events.length - reclaimAt));
        events.splice(Math.min(at, events.length), 0, l);
    }
    // Duplicates (same eventId — transport/replay) and a bounded reorder window.
    const out: TurnEvidence[] = [];
    for (const e of events) {
        out.push(e);
        if (rng.next() < 0.3) out.push(e);
    }
    for (let i = 1; i < out.length; i++) {
        if (i > 1 && rng.next() < 0.25) [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
    }
    return { attemptId, taskId, events: out };
}

function interleave(rng: SeededRng, scripts: Scripted[]): TurnEvidence[] {
    const cursors = scripts.map(() => 0);
    const out: TurnEvidence[] = [];
    for (;;) {
        const live = scripts.map((s, i) => (cursors[i]! < s.events.length ? i : -1)).filter((i) => i >= 0);
        if (live.length === 0) return out;
        const pick = live[rng.int(live.length)]!;
        out.push(scripts[pick]!.events[cursors[pick]!++]!);
    }
}

interface Violation { seed: number; message: string; sequence?: unknown }

function runLedgerSeed(seed: number): Violation[] {
    const root = new SeededRng(seed);
    const N = [1, 3, 8][root.substream('workerCount').int(3)]!;
    const M = 1 + root.substream('coordinators').int(2);
    const scriptRng = root.substream('attemptScript');
    const scripts = Array.from({ length: N }, (_, i) => genScript(scriptRng, i, `dc${i % M}`));
    const sequence = interleave(root.substream('interleave'), scripts);
    const db = memDb();
    const host = recordingHost();
    let now = T_BASE;
    const ledger = ledgerOn(db, { host, publisher: fakePublisher(), now: () => now });
    const violations: Violation[] = [];
    const fail = (message: string) => violations.push({ seed, message, sequence: sequence.map((e) => `${e.eventId}:${e.kind}@g${e.attemptRef?.generation}`) });
    const lastGen = new Map<string, number>();
    const tick = root.substream('tick');

    const check = (attemptId: string) => {
        const committed = db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE attempt_id = ? AND kind = 'committed'`).get(attemptId) as { n: number };
        if (committed.n > 1) fail(`(1) ${attemptId} has ${committed.n} committed rows`);
        const a = ledger.getAttempt(attemptId);
        if (!a) return;
        if ((lastGen.get(attemptId) ?? 0) > a.generation) fail(`(3) ${attemptId} generation went ${lastGen.get(attemptId)} → ${a.generation}`);
        lastGen.set(attemptId, a.generation);
        const holds = ledger.store.activeHolds(attemptId);
        if (a.terminal && holds.length > 0) fail(`(4) terminal ${attemptId} holds ${holds.map((h) => h.reason)}`);
        if (!a.terminal && a.scope !== 'plain' && !holds.some((h) => h.reason === 'hard_ceiling')) fail(`(4) open ${attemptId} has no hard_ceiling`);
    };

    for (const evidence of sequence) {
        const attemptId = evidence.attemptRef!.attemptId;
        const before = ledger.getAttempt(attemptId);
        const result = ledger.observe(evidence);
        if (result.verdict === 'recorded' && JSON.stringify(ledger.getAttempt(attemptId)) !== JSON.stringify(before)) fail(`(3) recorded verdict ${result.rule} mutated ${attemptId}`);
        if (result.rule === 'R27a' && before && !['accepted', 'delivered'].includes(before.state)) fail(`(3) R27a adopted while g was ${before.state}`);
        check(attemptId);
        if (tick.next() < 0.3) {
            now += tick.int(30_000);
            ledger.sweepExpiredHolds();
        }
    }
    // Quiescence: run the clock past every ceiling; the scheduler sweep terminates everything.
    for (let round = 0; round < 12; round++) {
        now += DEFAULT_TURN_POLICY.hardCeilingMs;
        if (ledger.sweepExpiredHolds().length === 0) break;
    }
    for (const s of scripts) {
        check(s.attemptId);
        const a = ledger.getAttempt(s.attemptId);
        if (!a?.terminal) { fail(`(4) ${s.attemptId} still open after quiescence (${a?.state})`); continue; }
        const committed = db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE attempt_id = ? AND kind = 'committed'`).get(s.attemptId) as { n: number };
        if (committed.n !== 1) fail(`(1) ${s.attemptId} terminal with ${committed.n} committed rows`);
        const graph = host.calls.filter((c) => c.startsWith(`graph:${s.taskId}:`));
        if (graph.length !== 1 || graph[0] !== `graph:${s.taskId}:${a.terminal.outcome}`) fail(`(1) queue/graph effect ${JSON.stringify(graph)} vs ${a.terminal.outcome}`);
        const terminalNotices = db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE attempt_id = ? AND kind = 'notify' AND json_extract(payload_json, '$.notify') IN ('completed','failed','cancelled','stopped')`).get(s.attemptId) as { n: number };
        if (terminalNotices.n !== 1) fail(`(2) ${s.attemptId} has ${terminalNotices.n} terminal notices`);
    }
    return violations;
}

describe('turn race — ledger properties (C8 1–4)', () => {
    it(`holds every invariant over ${SEEDS} seeds`, () => {
        const violations: Violation[] = [];
        for (let seed = 1; seed <= SEEDS && violations.length === 0; seed++) violations.push(...runLedgerSeed(seed));
        if (violations.length > 0) console.error(JSON.stringify(violations[0], null, 2));
        expect(violations.map((v) => `seed ${v.seed}: ${v.message}`)).toEqual([]);
    });
});

// ─── Part B: two nodes over a VirtualLink ────────────────────────────────

const MESH = 'm1';
const TOPIC = meshEventsTopic(MESH);

function nodeFor(sched: Scheduler, rng: SeededRng, writerId: string): SeqscribeNodeExt {
    const Database = loadBetterSqlite3();
    const node = createSeqscribe({
        writerId,
        storage: betterSqlite3Handle(new Database(':memory:')),
        clock: sched.clock(),
        timers: sched.timers(),
        rng: rng.fn(),
        constants: { ANTI_ENTROPY_MS: 2_000, CONTROL_RETRY_MS: 250, CHANNEL_STALL_MS: 4_000, GROUP_COMMIT_MS: 20 },
    }) as SeqscribeNodeExt;
    node.defineTopic(TOPIC, meshEventsPolicy());
    return node;
}

function nodePublisher(node: SeqscribeNodeExt): TurnPublisherPort {
    return {
        async publish(_meshId, entry, opts) {
            const [, writer, seq] = await node.log(TOPIC).append(entry.k, entry as never, opts?.ref ? { ref: [opts.ref.topic, opts.ref.writer, opts.ref.seq] } : undefined);
            return { writer, seq };
        },
    };
}

/** The C-W3 turn.ingest shape: foreign turn.evidence owned by this daemon → observe. */
function ingest(node: SeqscribeNodeExt, ledger: TurnLedger, self: string): () => void {
    return node.onEntry(TOPIC, 'turn.ingest', (entry: LogEntry) => {
        if (entry.kind !== 'turn.evidence' || entry.writer === node.writerId) return;
        const payload = entry.payload as { ownerDaemonId?: string; evidence?: TurnEvidence };
        if (payload.ownerDaemonId !== self || !payload.evidence) return;
        ledger.observe(payload.evidence, { src: { writer: entry.writer, seq: entry.seq } });
    });
}

async function runPairSeed(seed: number): Promise<string[]> {
    const root = new SeededRng(seed);
    const sched = new Scheduler(0);
    const coordNode = nodeFor(sched, root.substream('nodeA'), 'wA');
    const workerNode = nodeFor(sched, root.substream('nodeB'), 'wB');
    const link = new VirtualLink(sched, root.substream('link'), { lossP: 0.1, dupP: 0.2 });
    const grants = { [TOPIC]: 'full' as const };
    const dial = (gen: number) => {
        const l = gen === 0 ? link : new VirtualLink(sched, root.substream(`link${gen}`), { lossP: 0.1, dupP: 0.2 });
        const h = coordNode.attach(l.a, { peerId: 'wB', peerClass: 'content', grants });
        workerNode.attach(l.b, { peerId: 'wA', peerClass: 'content', grants });
        h.onStateChange((s) => { if (s === 'closed') sched.schedule(sched.now() + 250, () => dial(gen + 1)); });
    };
    dial(0);

    const dbA = memDb();
    const dbB = memDb();
    const ledgerA = ledgerOn(dbA, { selfDaemonId: 'dc', publisher: nodePublisher(coordNode), now: () => T_BASE + sched.now(), autoFlush: true });
    const ledgerB = ledgerOn(dbB, { selfDaemonId: 'dw', publisher: nodePublisher(workerNode), now: () => T_BASE + sched.now(), autoFlush: true });
    let unsub = ingest(coordNode, ledgerA, 'dc');

    const script = genScript(root.substream('script'), 0, 'dc');
    const owner = { daemonId: 'dc', meshId: MESH };
    const rng = root.substream('schedule');
    let at = 100;
    for (const evidence of script.events) {
        at += 1 + rng.int(400);
        sched.schedule(at, () => {
            if (evidence.kind === 'dispatch_accepted' || evidence.observedBy === 'dc') ledgerA.observe(evidence);
            else ledgerB.observe(evidence, { owner });
        });
    }
    // Partition mid-run, heal later.
    sched.schedule(at / 2, () => link.cut(true));
    sched.schedule(at / 2 + 3_000, () => link.cut(false));
    await sched.run({ untilMs: at + 60_000 });
    // Quiesce the owner's holds so the attempt terminates, then let replication settle.
    for (let round = 0; round < 6; round++) {
        ledgerA.sweepExpiredHolds(T_BASE + sched.now() + DEFAULT_TURN_POLICY.hardCeilingMs * (round + 1));
        await sched.run({ untilMs: sched.now() + 10_000 });
    }
    // Appends resolve on the (virtual) group-commit timer: flush WHILE time runs.
    await Promise.all([ledgerA.flushPublish(), ledgerB.flushPublish(), sched.run({ untilMs: sched.now() + 30_000 })]);
    await sched.run({ untilMs: sched.now() + 30_000 });

    const problems: string[] = [];
    const rows = () => (dbA.prepare('SELECT COUNT(*) AS n FROM turn_events').get() as { n: number }).n;
    const pending = (db: typeof dbA) => (db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE publish_state = 'pending'`).get() as { n: number }).n;
    if (pending(dbA) !== 0 || pending(dbB) !== 0) problems.push(`(7) pending rows A=${pending(dbA)} B=${pending(dbB)}`);
    if (JSON.stringify(coordNode.vectors()) !== JSON.stringify(workerNode.vectors())) problems.push('(7) vectors disagree after quiescence');
    const committed = (dbA.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE kind = 'committed'`).get() as { n: number }).n;
    if (committed !== 1) problems.push(`(1) ${committed} committed rows on the owner (expected exactly one)`);
    // Non-vacuity: the owner reduced evidence that arrived over the topic.
    const ingested = (dbA.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE src_writer = 'wB'`).get() as { n: number }).n;
    if (ingested === 0) problems.push('(5) nothing was ingested from the worker writer');
    const onA = coordNode.scanEntries(TOPIC, { limit: 10_000 }).entries;
    if (!onA.some((e) => e.writer === 'wB') || !onA.some((e) => e.writer === 'wA')) problems.push('(7) the topic does not hold both writers');
    // Every row marked published really is on the topic (published = appended, not just flagged).
    for (const [db, writer] of [[dbA, 'wA'], [dbB, 'wB']] as const) {
        const published = (db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE publish_state = 'published'`).get() as { n: number }).n;
        const appended = onA.filter((e) => e.writer === writer).length;
        if (published !== appended) problems.push(`(7) ${writer}: ${published} rows marked published vs ${appended} entries on the topic`);
    }

    // (5) topic replay from earliest-retained adds nothing.
    const before = rows();
    unsub();
    coordNode.resetConsumer(TOPIC, 'turn.ingest', { from: 'earliest-retained' });
    unsub = ingest(coordNode, ledgerA, 'dc');
    await sched.run({ untilMs: sched.now() + 5_000 });
    if (rows() !== before) problems.push(`(5) replay added ${rows() - before} turn_events rows`);

    // (6) a manual re-append of an already-published forwarded entry collapses on eventId.
    const forwarded = dbB.prepare(`SELECT payload_json FROM turn_events WHERE verdict = 'forwarded' LIMIT 1`).get() as { payload_json: string } | undefined;
    if (forwarded) {
        const entry = JSON.parse(forwarded.payload_json).entry;
        await Promise.all([workerNode.log(TOPIC).append('turn.evidence', entry), sched.run({ untilMs: sched.now() + 5_000 })]);
        await sched.run({ untilMs: sched.now() + 10_000 });
        if (rows() !== before) problems.push(`(6) republished entry added ${rows() - before} rows`);
    }
    unsub();
    await coordNode.close();
    await workerNode.close();
    return problems.map((p) => `seed ${seed}: ${p}`);
}

describe('turn race — two nodes over a faulty link (C8 5–7)', () => {
    it(`converges with exactly-once effects over ${Math.max(1, Math.floor(SEEDS / 25))} seeds`, async () => {
        const problems: string[] = [];
        for (let seed = 1; seed <= SEEDS; seed += 25) problems.push(...(await runPairSeed(seed)));
        expect(problems).toEqual([]);
    }, 120_000);
});
