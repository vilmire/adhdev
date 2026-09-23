import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MESH_TOPIC_PROTOCOL_VERSION, type MeshTopicEntry } from '@adhdev/mesh-shared';
import {
    MESH_PUBLISH_SLOTS,
    MeshTopicActivationError,
    activateMeshTopicsAtBoot,
    appendMeshHandoff,
    configureMeshPublisher,
    flushMeshPublisher,
    meshPublisherCounters,
    meshPublisherInflight,
    publishMeshRecord,
    publishMeshTopicEntry,
    __resetMeshPublisherForTests,
    type MeshRecordEntry,
} from '../../src/seqscribe/mesh-publisher.js';
import { MESH_EVENT_ENTRY_KIND } from '../../src/seqscribe/mesh-event-projection.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { meshEventsTopic } from '../../src/seqscribe/topics.js';

/**
 * mesh-publisher — the one writer of `mesh.<id>.events` (wiring-unification
 * C7-1). Replaces mesh-dual-write-inflight.test.ts, whose subject (the
 * MAX_INFLIGHT load-shed) is deleted: the publisher WAITS for a slot and never
 * drops a turn entry.
 */

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(
    name: string,
    meshIds: readonly string[] = [],
    opts: { localAuthority?: boolean } = {},
): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-mesh-pub-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: {},
        storedFleetSecret: null,
        daemonId: 'daemon_pub_test',
        meshIds,
        ...opts,
    });
    handles.push(handle);
    return handle;
}

function notify(eventId: string): MeshTopicEntry {
    return { v: MESH_TOPIC_PROTOCOL_VERSION, eventId, at: 1_700_000_000_000, k: 'turn.notify', attemptId: 'a1', notify: 'completed', targetDaemonId: 'dc', taskId: 't1' };
}

/** Appends never settle until released — every slot stays held. */
function withPendingAppend(handle: SeqscribeNodeHandle): { handle: SeqscribeNodeHandle; settleAll: () => void; started: () => number } {
    const resolvers: Array<() => void> = [];
    let seq = 0;
    return {
        handle: {
            ...handle,
            node: {
                ...handle.node,
                log: (topic: string) => ({
                    append: () => new Promise((resolve) => { resolvers.push(() => resolve([topic, 'w', ++seq])); }),
                }),
            } as SeqscribeNodeHandle['node'],
        },
        settleAll: () => { for (const r of resolvers.splice(0)) r(); },
        started: () => resolvers.length,
    };
}

function withRejectingAppend(handle: SeqscribeNodeHandle, error: Error): SeqscribeNodeHandle {
    return {
        ...handle,
        node: { ...handle.node, log: () => ({ append: () => Promise.reject(error) }) } as SeqscribeNodeHandle['node'],
    };
}

function withSyncThrowingAppend(handle: SeqscribeNodeHandle): SeqscribeNodeHandle {
    return {
        ...handle,
        node: { ...handle.node, log: () => ({ append: () => { throw new Error('static API misuse'); } }) } as SeqscribeNodeHandle['node'],
    };
}

async function ticks(n = 5): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
    __resetMeshPublisherForTests();
    for (const handle of handles.splice(0)) {
        try { await handle.close(); } catch { /* noop */ }
    }
    for (const dir of tmpDirs.splice(0)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
});

describe('backpressure — publish waits, never drops (C7-1)', () => {
    it('holds at most MESH_PUBLISH_SLOTS appends in flight and queues the rest, dropping none', async () => {
        const pending = withPendingAppend(openNode('bp', ['m1']));
        configureMeshPublisher(pending.handle);
        const total = MESH_PUBLISH_SLOTS * 3;
        const results = Array.from({ length: total }, (_, i) => publishMeshTopicEntry('m1', notify(`e${i}`)));
        await ticks();
        expect(meshPublisherInflight()).toEqual({ inflight: MESH_PUBLISH_SLOTS, waiting: total - MESH_PUBLISH_SLOTS });
        expect(pending.started()).toBe(MESH_PUBLISH_SLOTS);
        // Release in waves: every queued publish eventually appends.
        while (meshPublisherCounters().published < total) {
            pending.settleAll();
            await ticks();
        }
        await Promise.all(results);
        expect(meshPublisherCounters()).toMatchObject({ published: total, publishFailed: 0 });
        expect(meshPublisherInflight()).toEqual({ inflight: 0, waiting: 0 });
    });

    it('a rejected append is an ERROR + counter + rethrow (the caller keeps its row pending)', async () => {
        configureMeshPublisher(withRejectingAppend(openNode('rej', ['m1']), new Error('ERR_STORAGE sealed writer')));
        await expect(publishMeshTopicEntry('m1', notify('e1'))).rejects.toThrow(/ERR_STORAGE/);
        expect(meshPublisherCounters()).toMatchObject({ published: 0, publishFailed: 1 });
        expect(meshPublisherInflight().inflight).toBe(0);
    });

    it('a synchronous append throw releases its slot (no leak, no wedge)', async () => {
        configureMeshPublisher(withSyncThrowingAppend(openNode('sync', ['m1'])));
        const all = Array.from({ length: MESH_PUBLISH_SLOTS * 2 }, (_, i) => publishMeshTopicEntry('m1', notify(`s${i}`)).catch(() => 'rejected'));
        expect(new Set(await Promise.all(all))).toEqual(new Set(['rejected']));
        expect(meshPublisherInflight()).toEqual({ inflight: 0, waiting: 0 });
    });

    it('allow-list projection: an undeclared text field never reaches the topic', async () => {
        const node = openNode('guard', ['m1']);
        configureMeshPublisher(node);
        const leaky = { ...notify('bad'), summary: 'the agent wrote this' } as unknown as MeshTopicEntry;
        const [, writer, seq] = await publishMeshTopicEntry('m1', leaky);
        const [row] = node.node.scanEntries(meshEventsTopic('m1'), { writer, fromSeq: seq, toSeq: seq }).entries;
        expect(JSON.stringify(row?.payload)).not.toContain('the agent wrote this');
        expect(meshPublisherCounters().invalidEntries).toBe(1);
    });

    it('refuses an entry whose declared fields fail the guard', async () => {
        configureMeshPublisher(openNode('guard2', ['m1']));
        const bad = { ...notify('bad2'), notify: 'free text is not a notify kind' } as unknown as MeshTopicEntry;
        await expect(publishMeshTopicEntry('m1', bad)).rejects.toThrow(/content-boundary/);
    });

    it('rejects when unarmed instead of pretending to publish', async () => {
        await expect(publishMeshTopicEntry('m1', notify('x'))).rejects.toThrow(/not armed/);
    });
});

describe('real node', () => {
    it('appends a turn entry with kind = entry.k and returns its [topic, writer, seq]', async () => {
        const node = openNode('real', ['m1']);
        configureMeshPublisher(node);
        const [topic, writer, seq] = await publishMeshTopicEntry('m1', notify('real-1'));
        expect(topic).toBe(meshEventsTopic('m1'));
        expect(writer).toBe(node.writerId);
        const scan = node.node.scanEntries(meshEventsTopic('m1'), { writer, fromSeq: seq, toSeq: seq });
        expect(scan.entries[0]).toMatchObject({ kind: 'turn.notify', payload: { k: 'turn.notify', eventId: 'real-1' } });
    });

    it('mesh.record keeps the ledger append kind and carries the projection + the v2 envelope, text dropped', async () => {
        const node = openNode('record', ['m1']);
        configureMeshPublisher(node);
        const entry: MeshRecordEntry = {
            id: 'rec-1', timestamp: new Date(1_700_000_000_000).toISOString(), kind: 'task_dispatched', taskId: 't1',
            payload: { taskId: 't1', status: 'assigned', finalSummary: 'SECRET-TEXT-never-on-metadata-topic' },
        };
        expect(publishMeshRecord('m1', entry)).toBe(true);
        await flushMeshPublisher();
        const [row] = node.node.scanEntries(meshEventsTopic('m1'), {}).entries;
        expect(row?.kind).toBe(MESH_EVENT_ENTRY_KIND);
        expect(row?.payload).toMatchObject({ v: 2, k: 'mesh.record', eventId: 'rec-1', at: 1_700_000_000_000, id: 'rec-1', ledgerKind: 'task_dispatched', payload: { taskId: 't1', status: 'assigned' } });
        expect(JSON.stringify(row?.payload)).not.toContain('SECRET-TEXT');
        expect(meshPublisherCounters().recordsWritten).toBe(1);
    });

    it('appendMeshHandoff needs an authority (content class) — provisional nodes reject loudly', async () => {
        // C7-3: no fleet secret no longer means no authority at all (a local
        // one is minted by default) — pin the true authority-less case
        // explicitly to keep testing this rejection path.
        configureMeshPublisher(openNode('handoff', ['m1'], { localAuthority: false }));
        await expect(appendMeshHandoff('m1', 'turn.summary', { text: 'x' })).rejects.toThrow(/authority off/);
    });

});

describe('boot activation (C7-1: an undefinable topic is a mesh boot failure)', () => {
    it('throws MeshTopicActivationError naming the topics that failed', () => {
        // C7-3 opt-out: isolates this to the events-topic failure the test is
        // about. With the default local authority, ensureHandoffTopic also
        // attempts (and fails) defineTopic on the same broken mock, which is
        // real and correct (a genuinely broken node fails BOTH its topics),
        // but would double topicErrors here for a reason orthogonal to what
        // this test pins — see the next test for that combined count.
        const node = openNode('boot-fail', [], { localAuthority: false });
        const broken: SeqscribeNodeHandle = {
            ...node,
            node: { ...node.node, defineTopic: () => { throw new Error('ERR_TOPIC schema mismatch'); } } as SeqscribeNodeHandle['node'],
        };
        configureMeshPublisher(broken);
        expect(() => activateMeshTopicsAtBoot(['m1'])).toThrow(MeshTopicActivationError);
        expect(meshPublisherCounters().topicErrors).toBe(1);
    });

    it('with the default local authority, a broken node fails BOTH its events and handoff topics', () => {
        const node = openNode('boot-fail-local-authority');
        expect(node.authorityEnabled).toBe(true);
        expect(node.authorityIsLocal).toBe(true);
        const broken: SeqscribeNodeHandle = {
            ...node,
            node: { ...node.node, defineTopic: () => { throw new Error('ERR_TOPIC schema mismatch'); } } as SeqscribeNodeHandle['node'],
        };
        configureMeshPublisher(broken);
        expect(() => activateMeshTopicsAtBoot(['m1'])).toThrow(MeshTopicActivationError);
        expect(meshPublisherCounters().topicErrors).toBe(2);
    });

    it('defines every known mesh on a healthy node', () => {
        const node = openNode('boot-ok');
        configureMeshPublisher(node);
        expect(activateMeshTopicsAtBoot(['m1', 'm2'])).toBe(2);
        expect(node.topics.map((d) => d.topic)).toEqual(expect.arrayContaining([meshEventsTopic('m1'), meshEventsTopic('m2')]));
    });
});
