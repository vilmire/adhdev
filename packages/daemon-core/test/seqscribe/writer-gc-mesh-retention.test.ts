/**
 * writer-gc.ts §3 — acknowledged retention on `mesh.<id>.events` / `.handoff`
 * (data-path audit P0-1; seqscribe host-guide §4.8), on REAL nodes over an
 * in-memory channel pair.
 *
 * The production window is 30 days; these tests pass `meshRetentionMs: 0` so
 * rows written a moment ago already count as "old", and keep the max-lag long.
 * What is under test is the wiring: the sweep finds the mesh topics, deletes
 * only what the peer acknowledged (its HAVE rounds), leaves each live stream's
 * head row, reports counters, and a node joining afterwards bootstraps past
 * the floor (TRUNCATED) instead of parking rows in sq_pending.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel } from 'seqscribe';
import { afterEach, describe, expect, it } from 'vitest';
import { noteBeaconAcks } from '../../src/seqscribe/beacon.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { summarizeSeqscribeStats } from '../../src/seqscribe/stats.js';
import { meshEventsTopic, meshHandoffTopic } from '../../src/seqscribe/topics.js';
import {
    __resetTranscriptWriterGcForTests,
    configureTranscriptWriterGc,
    isMeshFullSyncRetentionTopic,
    MESH_FULL_SYNC_MAX_LAG_MS,
    MESH_FULL_SYNC_RETENTION_MS,
    runTranscriptWriterGcSweep,
    transcriptWriterGcCounters,
} from '../../src/seqscribe/writer-gc.js';

const MESH_ID = 'mesh_retention_test';
const EVENTS = meshEventsTopic(MESH_ID);
const HANDOFF = meshHandoffTopic(MESH_ID);
const ENV = { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'mesh-retention-test-secret' };
// Fast anti-entropy so acknowledgments (HAVE rounds) land within a test.
const CONSTANTS = { ANTI_ENTROPY_MS: 150, CONTROL_RETRY_MS: 100, GROUP_COMMIT_MS: 5 };
const SWEEP = { meshRetentionMs: 0, meshMaxLagMs: 60 * 60 * 1000, vacuumMaxSteps: 0 };

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterEach(async () => {
    __resetTranscriptWriterGcForTests();
    configureTranscriptWriterGc(null);
    for (const h of handles.splice(0)) await h.close().catch(() => {});
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-mesh-retention-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: ENV,
        storedFleetSecret: null,
        meshIds: [MESH_ID],
        constants: CONSTANTS,
    });
    handles.push(handle);
    return handle;
}

/** In-memory Channel pair; deferred delivery (see mesh-events-idle-consumer-convergence.test.ts). */
function channelPair(): [Channel, Channel] {
    const box = () => ({ msg: null as ((m: string) => void) | null, close: null as (() => void) | null });
    const a = box();
    const b = box();
    const mk = (mine: ReturnType<typeof box>, peer: ReturnType<typeof box>): Channel => ({
        send(msg: string) {
            setTimeout(() => peer.msg?.(msg), 0);
        },
        onMessage(cb) {
            mine.msg = cb;
        },
        onClose(cb) {
            mine.close = cb;
        },
        close() {
            peer.close?.();
        },
    });
    return [mk(a, b), mk(b, a)];
}

function grants(h: SeqscribeNodeHandle): Record<string, 'full' | 'serve' | 'none'> {
    return Object.fromEntries(
        h.topics.map(({ topic, policy }) => [topic, policy.replication === 'subscribe-only' ? 'serve' : 'full']),
    ) as Record<string, 'full' | 'serve' | 'none'>;
}

function connect(a: SeqscribeNodeHandle, b: SeqscribeNodeHandle): () => void {
    const [ca, cb] = channelPair();
    const ha = a.node.attach(ca, { peerId: `peer-${b.writerId}`, peerClass: 'content', grants: grants(a) });
    b.node.attach(cb, { peerId: `peer-${a.writerId}`, peerClass: 'content', grants: grants(b) });
    return () => ha.detach();
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function appendN(h: SeqscribeNodeHandle, topic: string, n: number): Promise<void> {
    const log = h.node.log(topic);
    await Promise.all(Array.from({ length: n }, (_, i) => log.append('adhdev.mesh.ledger', { i } as never)));
}

const contig = (h: SeqscribeNodeHandle, topic: string, writer: string): number =>
    (h.node.vectors()[topic]?.writers[writer] as { contig?: number } | undefined)?.contig ?? 0;
const rows = (h: SeqscribeNodeHandle, topic: string): number => h.node.stats().topics[topic]?.logRows ?? 0;
const pending = (h: SeqscribeNodeHandle, topic: string): number => h.node.stats().topics[topic]?.pending ?? 0;

describe('writer-gc §3 — mesh full-sync acknowledged retention', () => {
    it('policy constants: 30-day window, max-lag equal to it; topic recognizer', () => {
        expect(MESH_FULL_SYNC_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
        expect(MESH_FULL_SYNC_MAX_LAG_MS).toBe(MESH_FULL_SYNC_RETENTION_MS);
        expect(isMeshFullSyncRetentionTopic(EVENTS)).toBe(true);
        expect(isMeshFullSyncRetentionTopic(HANDOFF)).toBe(true);
        expect(isMeshFullSyncRetentionTopic('mesh.a.b.events')).toBe(false);
        expect(isMeshFullSyncRetentionTopic('session.x.chat')).toBe(false);
    });

    it('deletes only acknowledged rows on both mesh topics, keeps each head row, and a late joiner bootstraps past the floor', async () => {
        const a = openNode('a');
        const b = openNode('b');
        connect(a, b);
        await appendN(a, EVENTS, 40);
        await appendN(b, EVENTS, 25);
        await appendN(a, HANDOFF, 6);
        await waitFor(
            () => contig(b, EVENTS, a.writerId) === 40 && contig(a, EVENTS, b.writerId) === 25 && contig(b, HANDOFF, a.writerId) === 6,
            'replication',
        );
        // a HAVE round AFTER the appends is what acknowledges them
        await waitFor(() => (a.node.stats().topics[EVENTS]?.retention?.ackNodes ?? 0) === 1, 'ack recorded');
        await sleep(400);

        const result = await runTranscriptWriterGcSweep(a, SWEEP);
        expect(result.meshRowsPruned).toBe(39 + 24 + 5);
        expect(rows(a, EVENTS)).toBe(2); // one head row per writer
        expect(rows(a, HANDOFF)).toBe(1);
        expect(a.node.retentionFloors(EVENTS)).toEqual({ [a.writerId]: 39, [b.writerId]: 24 });
        expect(transcriptWriterGcCounters()).toMatchObject({
            meshTopicsInspected: 2,
            meshRowsPruned: 68,
            meshStreamsPinned: 0,
            meshLaggingMembers: 0,
            meshPruneErrors: 0,
        });

        // local-only diagnostics carry the aggregate (no topic names)
        const summary = summarizeSeqscribeStats(a.node.stats(), { authorityEnabled: true, includeLocalDiagnostics: true });
        expect(summary.fullSyncRetentionDetail).toMatchObject({ topics: 2, prunedRows: 68, floorStreams: 3, sweepRowsPruned: 68 });
        const cloud = summarizeSeqscribeStats(a.node.stats(), { authorityEnabled: true });
        expect(cloud.fullSyncRetentionDetail).toBeUndefined();

        // a node joining after the prune: TRUNCATED, then the retained rows — no gap, nothing parked
        const c = openNode('c');
        connect(c, a);
        await waitFor(
            () => contig(c, EVENTS, a.writerId) === 40 && contig(c, EVENTS, b.writerId) === 25 && contig(c, HANDOFF, a.writerId) === 6,
            'bootstrap',
        );
        expect(pending(c, EVENTS)).toBe(0);
        expect(pending(c, HANDOFF)).toBe(0);
        expect(rows(c, EVENTS)).toBe(2);
        expect(c.node.stats().topics[EVENTS]!.retention).toMatchObject({ floorsAdopted: 2 });
        expect(a.node.stats().topics[EVENTS]!.retention!.truncatedServed).toBeGreaterThanOrEqual(2);

        // and replication carries on above the floor
        await appendN(b, EVENTS, 3);
        await waitFor(() => contig(c, EVENTS, b.writerId) === 28, 'post-bootstrap replication');
    });

    it('a peer that has not acknowledged pins the floor; the sweep reports it', async () => {
        const a = openNode('a2');
        const b = openNode('b2');
        const detach = connect(a, b);
        await appendN(a, EVENTS, 10);
        await waitFor(() => contig(b, EVENTS, a.writerId) === 10, 'first replication');
        await sleep(400); // b acknowledges 10
        detach();
        await sleep(100);
        await appendN(a, EVENTS, 20); // b never sees these

        const result = await runTranscriptWriterGcSweep(a, SWEEP);
        expect(result.meshRowsPruned).toBe(10); // exactly what b acknowledged
        expect(a.node.retentionFloors(EVENTS)).toEqual({ [a.writerId]: 10 });
        expect(transcriptWriterGcCounters().meshStreamsPinned).toBe(1);

        // b returns: it had 10, the floor is 10 — plain WANT above the floor, no bootstrap needed
        connect(b, a);
        await waitFor(() => contig(b, EVENTS, a.writerId) === 30, 'catch-up');
        expect(pending(b, EVENTS)).toBe(0);
        expect(b.node.stats().topics[EVENTS]!.retention!.floorsAdopted).toBe(0);
    });

    it('star topology: a member never directly connected pins our stream until its Beacon report acknowledges it', async () => {
        // a — coordinator — c ; a and c never exchange HAVE directly
        const a = openNode('star-a');
        const coord = openNode('star-coord');
        const c = openNode('star-c');
        connect(a, coord);
        connect(c, coord);
        await appendN(c, EVENTS, 15);
        await appendN(a, EVENTS, 1); // a writes too, so it is a member of the topic on c
        await waitFor(
            () => contig(a, EVENTS, c.writerId) === 15 && contig(c, EVENTS, a.writerId) === 1,
            'relay through the coordinator',
        );
        await sleep(400);

        // c holds acks from the coordinator only: a — which has c's rows, but c
        // cannot know it — pins c's stream at 0
        const pinned = await runTranscriptWriterGcSweep(c, SWEEP);
        expect(pinned.meshRowsPruned).toBe(0);
        expect(transcriptWriterGcCounters().meshStreamsPinned).toBeGreaterThanOrEqual(1);

        // a's Beacon report — its own committed heads — reaches c through the board
        const report = {
            node: a.writerId,
            at: new Date().toISOString(),
            vectors: { [EVENTS]: a.node.vectors()[EVENTS] as never, 'other.topic': { writers: {} } },
        };
        // c's own report is skipped; a's is recorded
        expect(noteBeaconAcks(c.node, c.writerId, [report, { ...report, node: c.writerId }], Date.now())).toBe(1);
        const after = await runTranscriptWriterGcSweep(c, SWEEP);
        expect(after.meshRowsPruned).toBe(14);
        expect(c.node.retentionFloors(EVENTS)).toEqual({ [c.writerId]: 14 });
    });

    it('never deletes rows a durable cursor has not read (mesh.index / turn cursors)', async () => {
        const a = openNode('a3');
        const b = openNode('b3');
        connect(a, b);
        let release = false;
        a.node.onEntry(EVENTS, 'mesh.index', async () => {
            if (!release) throw new Error('index not ready');
        });
        await appendN(a, EVENTS, 12);
        await waitFor(() => contig(b, EVENTS, a.writerId) === 12, 'replication');
        await sleep(400);
        const blocked = await runTranscriptWriterGcSweep(a, SWEEP);
        expect(blocked.meshRowsPruned).toBe(0);
        release = true;
        await waitFor(() => (a.node.stats().topics[EVENTS]!.consumers['mesh.index']?.lagRows ?? 1) === 0, 'cursor caught up', 40_000);
        const after = await runTranscriptWriterGcSweep(a, SWEEP);
        expect(after.meshRowsPruned).toBe(11);
    }, 60_000);
});
