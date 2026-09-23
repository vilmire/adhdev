import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SummaryRef, TurnEvidence } from '@adhdev/mesh-shared';
import { appendMeshHandoff, configureMeshPublisher, flushMeshPublisher, publishMeshRecord, __resetMeshPublisherForTests } from '../../src/seqscribe/mesh-publisher.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { meshEventsTopic, meshHandoffTopic } from '../../src/seqscribe/topics.js';
import { meshRuntimePublisher } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { LIVE_IDLE, dispatch, evd, ledgerOn, memDb } from './ledger-harness.js';

// C8 invariant 8 (the oss-side fourth content-boundary test, alongside
// cloud-status-content-boundary.test.ts and the two packages/server tests):
// sentinel text in every summary lives ONLY on the content-class
// `mesh.<id>.handoff` topic; no `mesh.<id>.events` entry — turn.evidence,
// turn.committed, turn.notify, mesh.record — ever carries it, for every
// attempt-outcome shape. The summaries travel by `ref`.

const SENTINEL = 'sentinel-9f3c-do-not-leak-into-mesh-events';
const MESH = 'm1';
const dirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-turn-boundary-'));
    dirs.push(dir);
    const handle = openSeqscribeNode({ dbPath: join(dir, 'seq.db'), env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'turn-boundary-test-secret' }, storedFleetSecret: null, meshIds: [MESH] });
    handles.push(handle);
    return handle;
}

afterEach(async () => {
    __resetMeshPublisherForTests();
    for (const h of handles.splice(0)) await h.close().catch(() => {});
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Shape = 'genuine' | 'weak_confirmed' | 'hollow_retry' | 'worker_report' | 'late_completion' | 'forwarded';

async function drive(shape: Shape, summary: SummaryRef): Promise<void> {
    let now = 1_000;
    const db = memDb();
    const ledger = ledgerOn(db, { publisher: meshRuntimePublisher, now: () => now, selfDaemonId: shape === 'forwarded' ? 'dw' : 'dc' });
    const ref = { attemptRef: { attemptId: `a-${shape}`, generation: 0 }, taskId: `t-${shape}` };
    if (shape === 'forwarded') {
        ledger.observe(evd('worker_report', { outcome: 'completed', summary, hasHandoffNotes: true }, { ...ref, source: 'worker_tool', observedBy: 'dw' }), { owner: { daemonId: 'dc', meshId: MESH } });
        await ledger.flushPublish();
        return;
    }
    ledger.observe(dispatch({ attemptId: ref.attemptRef.attemptId, taskId: ref.taskId, meshId: MESH }));
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { ...ref, source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }, ref));
    const end = (extra: Partial<TurnEvidence> = {}, body: Record<string, unknown> = {}) =>
        ledger.observe(evd('turn_end', { strength: 'genuine', summary, ...body } as never, { ...ref, ...extra }));
    switch (shape) {
        case 'genuine': end(); break;
        case 'weak_confirmed':
            ledger.observe(evd('transcript_final', { selfAttributing: false, nativeRead: false, live: LIVE_IDLE, summary }, { ...ref, source: 'coordinator_probe' }));
            now += 60_000;
            ledger.sweepExpiredHolds();
            break;
        case 'hollow_retry': end({}, { hollow: true }); break;
        case 'worker_report':
            ledger.observe(evd('worker_report', { outcome: 'completed', summary, hasHandoffNotes: true }, { ...ref, source: 'worker_tool' }));
            break;
        case 'late_completion': {
            ledger.observe(evd('process_exit', { exitCode: 1 }, { ...ref, source: 'pty_exit' }));
            const g1 = { attemptRef: { attemptId: ref.attemptRef.attemptId, generation: 1 }, taskId: ref.taskId };
            ledger.observe(evd('delivered', { messageId: 'msg-2', outcome: 'delivered', via: 'local' }, { ...g1, source: 'input_service', sessionId: 's2' }));
            ledger.observe(evd('turn_started', { retro: false }, { ...g1, sessionId: 's2' }));
            end();
            break;
        }
    }
    await ledger.flushPublish();
}

describe('content boundary — mesh.<id>.events never carries summary text (C8 #8)', () => {
    it('for every outcome shape, the sentinel is on the handoff topic and nowhere on the events topic', async () => {
        const node = openNode();
        configureMeshPublisher(node);
        const summary = await appendMeshHandoff(MESH, 'turn.summary', { text: SENTINEL });
        expect(summary.topic).toBe(meshHandoffTopic(MESH));

        for (const shape of ['genuine', 'weak_confirmed', 'hollow_retry', 'worker_report', 'late_completion', 'forwarded'] as const) {
            await drive(shape, summary);
        }
        // A mesh.record with text in its payload: the projection drops it.
        publishMeshRecord(MESH, { id: 'rec-1', timestamp: new Date(1_000).toISOString(), kind: 'task_completed', payload: { taskId: 't1', finalSummary: SENTINEL } });
        await flushMeshPublisher();

        const events = node.node.scanEntries(meshEventsTopic(MESH), { limit: 10_000 }).entries;
        const kinds = new Set(events.map((e) => e.kind));
        expect(kinds).toEqual(new Set(['turn.committed', 'turn.notify', 'turn.evidence', 'adhdev.mesh.ledger']));
        for (const entry of events) expect(JSON.stringify(entry.payload)).not.toContain(SENTINEL);
        // Summaries travel by ref: every committed/completion entry points at the handoff entry.
        const withRef = events.filter((e) => e.ref);
        expect(withRef.length).toBeGreaterThan(0);
        for (const e of withRef) expect(e.ref).toEqual([summary.topic, summary.writer, summary.seq]);

        const handoff = node.node.scanEntries(meshHandoffTopic(MESH), {}).entries;
        expect(handoff.some((e) => JSON.stringify(e.payload).includes(SENTINEL))).toBe(true);
    });
});
