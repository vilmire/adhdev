import { describe, expect, it } from 'vitest';
import type { OutboundMessage, SubmitOutcome, SummaryRef } from '@adhdev/mesh-shared';
import {
    createCoordinatorNotifier,
    createTurnDeliverCounters,
    createTurnDeliverHandler,
    createTurnIngestHandler,
    deliverNoticeBacklog,
    listControlNotices,
    listRecentDeliveredNotices,
    readCoordinatorNotices,
    retractCoordinatorNotices,
    type DeliverCursorEntry,
    type DeliverEdgeWaiter,
    type TurnDeliverDeps,
} from '../../src/mesh/turn-ledger/deliver.js';
import type { CoordinatorSessionView } from '../../src/mesh/turn-ledger/routing.js';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import { T0, dispatch, evd, fakePublisher, ledgerOn, memDb, rowsOf } from './ledger-harness.js';

// turn-ledger/deliver — the C2 notice path (C-W3): producer → ingest →
// deliver (suppression, render, route, deferral, escalation) → exactly-once
// `delivered:<writer>:<seq>` claims; the MCP-only inbox read + ack; backlog.

const SENTINEL = 'SENTINEL-9f3c-final-summary-never-on-the-topic';

type FakePort = { submit(msg: OutboundMessage): Promise<SubmitOutcome>; calls: OutboundMessage[]; next: SubmitOutcome[] };

function fakePort(): FakePort {
    const port: FakePort = {
        calls: [],
        next: [],
        async submit(msg) {
            port.calls.push(msg);
            return port.next.shift() ?? { kind: 'delivered' };
        },
    };
    return port;
}

/** A waiter the test drives by hand: `wait` parks until `wake()` or the clock passes `untilMs`. */
function manualWaiter(clock: { now: number }): DeliverEdgeWaiter & { parked: number; tick(ms: number): void } {
    const pending = new Set<{ until: number; resolve: (v: 'edge' | 'timeout') => void }>();
    const w = {
        parked: 0,
        wait(_meshId: string, untilMs: number, signal: AbortSignal) {
            return new Promise<'edge' | 'timeout'>((resolve, reject) => {
                if (clock.now >= untilMs) { resolve('timeout'); return; }
                const rec = { until: untilMs, resolve };
                pending.add(rec);
                w.parked = pending.size;
                signal.addEventListener('abort', () => { pending.delete(rec); reject(new Error('aborted')); }, { once: true });
            });
        },
        wake() {
            for (const rec of [...pending]) { pending.delete(rec); rec.resolve('edge'); }
            w.parked = pending.size;
        },
        tick(ms: number) {
            clock.now += ms;
            for (const rec of [...pending]) {
                if (clock.now >= rec.until) { pending.delete(rec); rec.resolve('timeout'); }
            }
            w.parked = pending.size;
        },
    };
    return w;
}

const flush = () => new Promise((r) => setImmediate(r));

interface Fixture {
    ledger: TurnLedger;
    db: ReturnType<typeof memDb>;
    publisher: ReturnType<typeof fakePublisher>;
    port: FakePort;
    clock: { now: number };
    waiter: ReturnType<typeof manualWaiter>;
    coordinators: CoordinatorSessionView[];
    deps: TurnDeliverDeps;
    entries(): DeliverCursorEntry[];
}

function claims(db: ReturnType<typeof memDb>): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE event_id LIKE 'delivered:%'`).get() as { n: number }).n;
}

function fixture(self = 'dc'): Fixture {
    const db = memDb();
    const publisher = fakePublisher(`w-${self}`);
    const clock = { now: T0 };
    const ledger = ledgerOn(db, { publisher, now: () => clock.now, selfDaemonId: self });
    const port = fakePort();
    const waiter = manualWaiter(clock);
    const coordinators: CoordinatorSessionView[] = [{ sessionId: 'coord', idle: true, modalParked: false }];
    const deps: TurnDeliverDeps = {
        ledger,
        selfDaemonIds: () => ['dc'],
        port,
        coordinators: () => coordinators.map((c) => ({ ...c })),
        waiter,
        now: () => clock.now,
        counters: createTurnDeliverCounters(),
    };
    return {
        ledger, db, publisher, port, clock, waiter, coordinators, deps,
        entries: () => publisher.entries.map((e) => ({ meshId: e.meshId, writer: e.writer, seq: e.seq, kind: e.entry.k, payload: e.entry, ...(e.ref ? { ref: e.ref } : {}), own: true })),
    };
}

/** Drive a mesh_direct attempt to a genuine commit with a LOCAL summary in the envelope. */
async function commitWithLocalSummary(f: Fixture): Promise<void> {
    f.ledger.observe(dispatch());
    f.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
    f.ledger.observe(evd('turn_started', { retro: false }));
    f.ledger.observe(evd('turn_end', { strength: 'genuine' }), { envelope: { finalSummary: SENTINEL, notice: { nodeLabel: "Node 'n1'" } } });
    await f.ledger.flushPublish();
}

function notifyEntry(f: Fixture): DeliverCursorEntry {
    const entry = f.entries().find((e) => e.kind === 'turn.notify');
    expect(entry).toBeDefined();
    return entry!;
}

describe('turn.deliver — local commit → one submit, exactly once', () => {
    it('renders the local summary at deliver time, submits once, and claims delivered:<writer>:<seq>', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        const deliver = createTurnDeliverHandler(f.deps);
        const entry = notifyEntry(f);
        const result = await deliver(entry, new AbortController().signal);
        expect(result).toMatchObject({ outcome: 'delivered', sessionId: 'coord', escalated: false });
        expect(f.port.calls).toHaveLength(1);
        const msg = f.port.calls[0]!;
        expect(msg).toMatchObject({ messageId: `notify:${entry.writer}:${entry.seq}`, origin: 'mesh', policy: { mode: 'queue' }, sessionId: 'coord' });
        expect(msg.input.textFallback).toContain("Node 'n1' has completed its task");
        expect(msg.input.textFallback).toContain(SENTINEL);
        expect(f.ledger.store.hasEvent(`delivered:${entry.writer}:${entry.seq}`)).toBe(true);
        // Content boundary: the text rendered at deliver time never rode an events-topic entry.
        for (const e of f.publisher.entries) expect(JSON.stringify(e.entry)).not.toContain(SENTINEL);
    });

    it('a direct dispatch that failed instead of being reclaimed renders the resend notice with its cause (one submit)', async () => {
        const f = fixture();
        f.ledger.observe(dispatch());
        const failed = f.ledger.observe(evd('dispatch_failed', { workerAbsent: true, reason: 'worker_absent' }, { source: 'dispatch' }));
        expect(failed.attempt?.terminal?.reason).toBe('dispatch_failed');
        await f.ledger.flushPublish();
        expect(f.entries().filter((e) => e.kind === 'turn.notify')).toHaveLength(1);
        await createTurnDeliverHandler(f.deps)(notifyEntry(f), new AbortController().signal);
        expect(f.port.calls).toHaveLength(1);
        const text = f.port.calls[0]!.input.textFallback;
        expect(text).toContain('direct dispatch of task t1 failed (dispatch_failed)');
        expect(text).toContain('never redelivered automatically');
    });

    it('a redelivered entry (crash after claim / cursor retry) never submits twice', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        const deliver = createTurnDeliverHandler(f.deps);
        const entry = notifyEntry(f);
        await deliver(entry, new AbortController().signal);
        // At-least-once cursor: the same (writer, seq) again, and again from a fresh handler (restart).
        expect(await deliver(entry, new AbortController().signal)).toEqual({ outcome: 'skipped', why: 'already_delivered' });
        expect(await createTurnDeliverHandler(f.deps)(entry, new AbortController().signal)).toEqual({ outcome: 'skipped', why: 'already_delivered' });
        expect(f.port.calls).toHaveLength(1);
        expect(claims(f.db)).toBe(1);
    });

    it('a throwing port backs off (rejects) and leaves no claim, so the retry delivers', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        const entry = notifyEntry(f);
        const failing = { submit: async () => { throw new Error('pty write failed'); } };
        await expect(createTurnDeliverHandler({ ...f.deps, port: failing })(entry, new AbortController().signal)).rejects.toThrow(/pty write failed/);
        expect(f.ledger.store.hasEvent(`delivered:${entry.writer}:${entry.seq}`)).toBe(false);
        expect(await createTurnDeliverHandler(f.deps)(entry, new AbortController().signal)).toMatchObject({ outcome: 'delivered' });
        expect(f.port.calls).toHaveLength(1);
    });

    it('skips foreign-writer entries and notices addressed to another daemon', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        const deliver = createTurnDeliverHandler(f.deps);
        const entry = notifyEntry(f);
        expect(await deliver({ ...entry, own: false }, new AbortController().signal)).toEqual({ outcome: 'skipped', why: 'foreign' });
        expect(await deliver({ ...entry, payload: { ...(entry.payload as object), targetDaemonId: 'other' } }, new AbortController().signal))
            .toEqual({ outcome: 'skipped', why: 'not_addressed' });
        expect(f.port.calls).toHaveLength(0);
    });
});

describe('turn.deliver — deferral on edges, escalation at the ceiling', () => {
    it('a busy coordinator defers (the callback awaits, never throws) and delivers on the idle edge', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        f.coordinators[0]!.idle = false;
        const deliver = createTurnDeliverHandler(f.deps);
        const entry = notifyEntry(f);
        let settled: unknown = null;
        const pending = deliver(entry, new AbortController().signal).then((r) => { settled = r; });
        await flush();
        expect(settled).toBeNull();
        expect(f.waiter.parked).toBe(1);
        expect(f.port.calls).toHaveLength(0);
        // The idle edge (bus status → wake).
        f.coordinators[0]!.idle = true;
        f.waiter.wake();
        await pending;
        expect(settled).toMatchObject({ outcome: 'delivered', escalated: false });
        expect(f.port.calls).toHaveLength(1);
        expect(f.deps.counters!.deferred).toBe(1);
    });

    it('a modal-parked coordinator waits for modal{null}; at the ceiling it escalates to a queue-mode submit', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        f.coordinators[0]!.modalParked = true;
        const deliver = createTurnDeliverHandler(f.deps);
        const entry = notifyEntry(f);
        let settled: any = null;
        const pending = deliver(entry, new AbortController().signal).then((r) => { settled = r; });
        await flush();
        expect(settled).toBeNull();
        // Past entry.at + deliveryCeilingMs (bounded from the ENTRY, not from the wait start).
        f.waiter.tick(DEFAULT_TURN_POLICY.deliveryCeilingMs + 1);
        await pending;
        expect(settled).toMatchObject({ outcome: 'delivered', escalated: true, sessionId: 'coord' });
        expect(f.port.calls[0]!.policy).toEqual({ mode: 'queue' });
        expect(f.deps.counters!.escalated).toBe(1);
    });

    it('strict route: waits for the addressed session to register, escalates to a sibling at the ceiling', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        // The addressed coordinator ('coord') is restarting; a sibling is idle.
        f.coordinators.splice(0, 1, { sessionId: 'sibling', idle: true, modalParked: false });
        const deliver = createTurnDeliverHandler(f.deps);
        const entry = notifyEntry(f);
        let settled: any = null;
        const pending = deliver(entry, new AbortController().signal).then((r) => { settled = r; });
        await flush();
        expect(settled).toBeNull();
        f.waiter.tick(DEFAULT_TURN_POLICY.deliveryCeilingMs + 1);
        await pending;
        expect(settled).toMatchObject({ outcome: 'delivered', sessionId: 'sibling', escalated: true });
    });

    it('the addressed session registering before the ceiling takes it (no escalation)', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        f.coordinators.splice(0, 1, { sessionId: 'sibling', idle: true, modalParked: false });
        const deliver = createTurnDeliverHandler(f.deps);
        const pending = deliver(notifyEntry(f), new AbortController().signal);
        await flush();
        f.coordinators.push({ sessionId: 'coord', idle: true, modalParked: false });
        f.waiter.wake();
        expect(await pending).toMatchObject({ outcome: 'delivered', sessionId: 'coord', escalated: false });
    });

    it('no coordinator session here at all: the cursor passes (MCP inbox / backlog own it)', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        f.coordinators.length = 0;
        expect(await createTurnDeliverHandler(f.deps)(notifyEntry(f), new AbortController().signal)).toEqual({ outcome: 'no_coordinator' });
        expect(f.port.calls).toHaveLength(0);
        expect(readCoordinatorNotices(f.deps, 'm1', { ack: false })).toHaveLength(1);
    });

    it('shutdown rejects a deferred wait and the entry stays undelivered', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        f.coordinators[0]!.idle = false;
        const abort = new AbortController();
        const pending = createTurnDeliverHandler(f.deps)(notifyEntry(f), abort.signal);
        await flush();
        abort.abort(new Error('disposed'));
        await expect(pending).rejects.toThrow();
        expect(claims(f.db)).toBe(0);
    });

    it('an MCP read that acks while the cursor waits ends the wait without a submit', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        f.coordinators[0]!.idle = false;
        const pending = createTurnDeliverHandler(f.deps)(notifyEntry(f), new AbortController().signal);
        await flush();
        const read = readCoordinatorNotices({ ...f.deps }, 'm1');
        expect(read).toHaveLength(1);
        expect(read[0]!.coordinatorMessage).toContain(SENTINEL);
        expect(await pending).toEqual({ outcome: 'acked_elsewhere' });
        expect(f.port.calls).toHaveLength(0);
        expect(readCoordinatorNotices(f.deps, 'm1')).toEqual([]);
    });
});

describe('suppression at deliver time', () => {
    it('an approval notice whose attempt left `suspended` is claimed without a submit', async () => {
        const f = fixture();
        f.ledger.observe(dispatch());
        f.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        f.ledger.observe(evd('turn_started', { retro: false }));
        f.ledger.observe(evd('suspension', { modal: 'approval' }, { source: 'approval_gate' }));
        f.ledger.observe(evd('suspension_resolved', { resolution: 'approved', via: 'auto_approve' }, { source: 'modal_button' }));
        await f.ledger.flushPublish();
        const approval = f.entries().find((e) => (e.payload as { notify?: string }).notify === 'approval')!;
        expect(await createTurnDeliverHandler(f.deps)(approval, new AbortController().signal)).toEqual({ outcome: 'suppressed', why: 'stale_suspension' });
        expect(f.port.calls).toHaveLength(0);
        expect(f.ledger.store.hasEvent(`delivered:${approval.writer}:${approval.seq}`)).toBe(true);
    });
});

describe('producer notices (mesh_event)', () => {
    it('a local notice keeps its text local, renders at deliver time, and dedupes inside the window', async () => {
        const f = fixture();
        const notifier = createCoordinatorNotifier({ ledger: f.ledger, selfDaemonIds: () => ['dc'], now: () => f.clock.now });
        const notice = { meshId: 'm1', event: 'mesh:dispatch_blocked', nodeLabel: 'n1', coordinatorMessage: `[System] blocked ${SENTINEL}`, metadataEvent: { taskId: 't9' } };
        expect(notifier.notify(notice).queued).toBe(true);
        expect(notifier.notify(notice).queued).toBe(false);
        await f.ledger.flushPublish();
        const entry = f.entries().find((e) => e.kind === 'turn.notify')!;
        expect(JSON.stringify(entry.payload)).not.toContain(SENTINEL);
        const result = await createTurnDeliverHandler(f.deps)(entry, new AbortController().signal);
        expect(result).toMatchObject({ outcome: 'delivered' });
        expect(f.port.calls[0]!.input.textFallback).toContain(SENTINEL);
    });

    it('composer-residue re-home: a typed notice is listed with its rendered body; releasing its claim makes it undelivered again', async () => {
        const f = fixture();
        const notifier = createCoordinatorNotifier({ ledger: f.ledger, selfDaemonIds: () => ['dc'], now: () => f.clock.now });
        const body = `[System] blocked ${SENTINEL} — a long enough body for the residue matcher`;
        notifier.notify({ meshId: 'm1', event: 'mesh:dispatch_blocked', nodeLabel: 'n1', coordinatorMessage: body, metadataEvent: { taskId: 't9' } });
        await f.ledger.flushPublish();
        const entry = f.entries().find((e) => e.kind === 'turn.notify')!;
        expect(await createTurnDeliverHandler(f.deps)(entry, new AbortController().signal)).toMatchObject({ outcome: 'delivered' });
        expect(f.ledger.store.listUndeliveredNotifies('m1')).toHaveLength(0);

        const listed = listRecentDeliveredNotices(f.deps, 0);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ meshId: 'm1', event: 'mesh:dispatch_blocked', taskId: 't9', text: body });
        expect(listed[0]!.claimEventId).toBe(`delivered:${entry.writer}:${entry.seq}`);

        expect(f.ledger.store.releaseDeliveryClaim(listed[0]!.claimEventId)).toBe(true);
        expect(f.ledger.store.listUndeliveredNotifies('m1')).toHaveLength(1);
        expect(listRecentDeliveredNotices(f.deps, 0)).toHaveLength(0);
        // Only a delivery claim can be released — never a notify/evidence row.
        expect(f.ledger.store.releaseDeliveryClaim(f.ledger.store.listUndeliveredNotifies('m1')[0]!.eventId)).toBe(false);
    });

    it('a suppressed / MCP-read claim is not a typed delivery (never a residue candidate)', async () => {
        const f = fixture();
        const notifier = createCoordinatorNotifier({ ledger: f.ledger, selfDaemonIds: () => ['dc'], now: () => f.clock.now });
        notifier.notify({ meshId: 'm1', event: 'mesh:dispatch_blocked', coordinatorMessage: 'x'.repeat(80), metadataEvent: { taskId: 't9' } });
        await f.ledger.flushPublish();
        expect(readCoordinatorNotices(f.deps, 'm1')).toHaveLength(1);
        expect(listRecentDeliveredNotices(f.deps, 0)).toHaveLength(0);
    });

    it('a notice for another daemon rides the handoff topic by ref', async () => {
        const f = fixture();
        const handoffs: Array<{ kind: string; payload: Record<string, unknown> }> = [];
        const ref: SummaryRef = { topic: 'mesh.m1.handoff', writer: 'w-dc', seq: 42 };
        const notifier = createCoordinatorNotifier({
            ledger: f.ledger,
            selfDaemonIds: () => ['dc'],
            appendHandoff: async (_m, kind, payload) => { handoffs.push({ kind, payload }); return ref; },
        });
        notifier.notify({ meshId: 'm1', event: 'refine:completed', nodeLabel: 'n2', coordinatorMessage: SENTINEL, targetCoordinatorDaemonId: 'dother' });
        await flush();
        await f.ledger.flushPublish();
        expect(handoffs[0]!.payload.coordinatorMessage).toBe(SENTINEL);
        const published = f.publisher.entries.find((e) => e.entry.k === 'turn.notify')!;
        expect(published.entry).toMatchObject({ notify: 'mesh_event', targetDaemonId: 'dother' });
        expect(published.ref).toEqual(ref);
        expect(JSON.stringify(published.entry)).not.toContain(SENTINEL);
    });

    it('retract claims an obsolete dispatch-blocked notice; control notices are skipped by the cursor', async () => {
        const f = fixture();
        const notifier = createCoordinatorNotifier({ ledger: f.ledger, selfDaemonIds: () => ['dc'], now: () => f.clock.now });
        notifier.notify({ meshId: 'm1', event: 'mesh:dispatch_blocked', coordinatorMessage: 'blocked', metadataEvent: { taskId: 't9' } });
        notifier.notify({ meshId: 'm1', event: 'coordinator_catchup', nodeId: 'base', workspace: '/repo', metadataEvent: { baseBranch: 'main' } });
        await f.ledger.flushPublish();
        expect(retractCoordinatorNotices(f.deps, 'm1', (event, meta) => event === 'mesh:dispatch_blocked' && meta.taskId === 't9')).toBe(1);
        const catchup = f.entries().find((e) => (e.payload as { eventId: string }).eventId && f.ledger.store.getEvent((e.payload as { eventId: string }).eventId)?.payload.event === 'coordinator_catchup')!;
        const deliver = createTurnDeliverHandler({ ...f.deps, isControlEvent: (e) => e === 'coordinator_catchup' });
        expect(await deliver(catchup, new AbortController().signal)).toEqual({ outcome: 'skipped', why: 'control' });
        const control = listControlNotices(f.deps, 'm1', 'coordinator_catchup');
        expect(control.notices).toHaveLength(1);
        expect(control.notices[0]).toMatchObject({ nodeId: 'base', workspace: '/repo', metadataEvent: { baseBranch: 'main' } });
        expect(control.take(control.notices[0]!)).toBe(true);
        expect(listControlNotices(f.deps, 'm1', 'coordinator_catchup').notices).toHaveLength(0);
        expect(f.port.calls).toHaveLength(0);
    });
});

describe('turn.ingest', () => {
    it('observes foreign evidence owned here once (idempotent by eventId) and re-issues a foreign notice addressed here', async () => {
        // Worker daemon W forwards evidence for an attempt owned by coordinator daemon C.
        const worker = fixture('dw');
        const owner = fixture('dc');
        owner.ledger.observe(dispatch());
        owner.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'p2p' }, { source: 'input_service' }));
        const started = evd('turn_started', { retro: false });
        expect(worker.ledger.observe(started, { owner: { daemonId: 'dc', meshId: 'm1' } }).verdict).toBe('forwarded');
        await worker.ledger.flushPublish();
        const forwarded = worker.publisher.entries.map((e) => ({ meshId: e.meshId, writer: 'w-dw', seq: e.seq, kind: e.entry.k, payload: e.entry, own: false }));
        const counters = createTurnDeliverCounters();
        const ingest = createTurnIngestHandler({ ledger: owner.ledger, selfDaemonIds: () => ['dc'], counters });
        for (const e of forwarded) ingest(e);
        for (const e of forwarded) ingest(e); // at-least-once redelivery
        expect(owner.ledger.getAttempt('a1')?.state).toBe('generating');
        expect(counters.ingested).toBe(1);
        expect(rowsOf(owner.db, 'turn_started')).toHaveLength(1);

        // A foreign turn.notify addressed to 'dc' becomes one own notice.
        const foreignNotify: DeliverCursorEntry = {
            meshId: 'm1', writer: 'w-other', seq: 9, kind: 'turn.notify', own: false,
            payload: { v: 2, eventId: 'mesh_event:x', at: T0, k: 'turn.notify', notify: 'mesh_event', targetDaemonId: 'dc' },
            ref: { topic: 'mesh.m1.handoff', writer: 'w-other', seq: 3 },
        };
        ingest(foreignNotify);
        ingest(foreignNotify);
        expect(counters.relayed).toBe(1);
        const relay = owner.ledger.store.getEvent('mesh_event:x#relay');
        expect(relay?.payload).toMatchObject({ event: 'relayed', ref: { seq: 3 } });
    });
});

describe('backlog + MCP inbox', () => {
    it('backlog delivers to an idle coordinator only, never bypassing the cursor deferral', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        f.coordinators[0]!.idle = false;
        expect(await deliverNoticeBacklog(f.deps, 'm1', new AbortController().signal)).toBe(0);
        expect(f.port.calls).toHaveLength(0);
        f.coordinators[0]!.idle = true;
        expect(await deliverNoticeBacklog(f.deps, 'm1', new AbortController().signal)).toBe(1);
        expect(f.port.calls).toHaveLength(1);
        expect(await deliverNoticeBacklog(f.deps, 'm1', new AbortController().signal)).toBe(0);
    });

    it('the MCP inbox peek (ack:false) does not claim; the read (ack) claims once', async () => {
        const f = fixture();
        await commitWithLocalSummary(f);
        expect(readCoordinatorNotices(f.deps, 'm1', { ack: false })).toHaveLength(1);
        expect(readCoordinatorNotices(f.deps, 'm1', { ack: false })).toHaveLength(1);
        const read = readCoordinatorNotices(f.deps, 'm1');
        expect(read).toHaveLength(1);
        expect(read[0]).toMatchObject({ notify: 'completed', meshId: 'm1', taskId: 't1' });
        expect(readCoordinatorNotices(f.deps, 'm1')).toEqual([]);
        // The cursor then passes without submitting.
        expect(await createTurnDeliverHandler(f.deps)(notifyEntry(f), new AbortController().signal)).toEqual({ outcome: 'skipped', why: 'already_delivered' });
    });
});

describe('report gate — a hold-expiry commit renders the text of the end that opened the hold (R13r)', () => {
    it('await_report expires with no report: the notice carries the idle end\'s local summary, committed weak', async () => {
        const f = fixture();
        f.ledger.observe(dispatch());
        f.ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        f.ledger.observe(evd('turn_started', { retro: false }));
        const held = f.ledger.observe(evd('turn_end', { strength: 'genuine', reportExpected: true }), { envelope: { finalSummary: SENTINEL, notice: { nodeLabel: "Node 'n1'" } } });
        expect(held.rule).toBe('R9r');
        await f.ledger.flushPublish();
        expect(f.entries().some((e) => e.kind === 'turn.notify')).toBe(false);
        const hold = f.ledger.store.activeHolds('a1').find((h) => h.reason === 'await_report')!;
        f.clock.now = hold.until!;
        const expired = f.ledger.observe({
            eventId: `hold_expired:${hold.holdId}:${hold.until}`, at: hold.until!, source: 'scheduler', sessionId: 's1',
            attemptRef: { attemptId: 'a1', generation: 0 }, observedBy: 'dc', kind: 'hold_expired', holdId: hold.holdId, reason: 'await_report',
        });
        expect(expired.rule).toBe('R13r');
        expect(f.ledger.getAttempt('a1')!.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' });
        await f.ledger.flushPublish();
        const deliver = createTurnDeliverHandler(f.deps);
        const result = await deliver(notifyEntry(f), new AbortController().signal);
        expect(result).toMatchObject({ outcome: 'delivered' });
        expect(f.port.calls).toHaveLength(1);
        expect(f.port.calls[0]!.input.textFallback).toContain(SENTINEL);
    });
});
