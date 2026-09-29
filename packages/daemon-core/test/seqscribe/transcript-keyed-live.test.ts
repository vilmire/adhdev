import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel, LogEntry, Row, TailSource } from 'seqscribe';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionChatTopic } from '../../src/seqscribe/topics.js';
import { CHAT_COMMIT_KIND, CHAT_MSG_KIND } from '../../src/seqscribe/transcript-keyed-codec.js';
import {
    __resetTranscriptChatRuntimeForTests,
    createLiveChatPublisher,
    ledgerSeedFromPersisted,
    readPersistedChatTopic,
    transcriptChatRuntimeCounters,
} from '../../src/seqscribe/transcript-keyed-publish-runtime.js';
import { TranscriptProjectionService } from '../../src/seqscribe/transcript-publisher.js';
import { TranscriptReplicaStore } from '../../src/seqscribe/transcript-replica-store.js';
import { selectChatTailSnapshot } from '../../src/seqscribe/transcript-tail-snapshot.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import { MessageIdentityLedger } from '../../src/chat/message-identity-ledger.js';
import type { TranscriptObservation } from '../../src/seqscribe/transcript-observation.js';
import { DAEMON, SESSION, filler, observation, ordOf, type BubbleSpec } from './keyed-chat-fixtures.js';

/**
 * The keyed chat lane end to end on REAL seqscribe nodes (design 2026-09-28):
 * the publish runtime appends keyed frames, the owner's tail selector serves
 * `latestPerKey(W) ∪ rowsAfter(W)`, a subscriber's replica store folds SNAP +
 * DELTA into the same view, compaction keeps the topic near its live size, and
 * a restarted producer resumes without rewriting anything.
 */

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterAll(async () => {
    for (const h of handles) await h.close().catch(() => {});
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function freshDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-keyed-${name}-`));
    tmpDirs.push(dir);
    return dir;
}

function openNode(dir: string): SeqscribeNodeHandle {
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'test-fleet-secret' },
        storedFleetSecret: null,
        meshIds: [],
    });
    handles.push(handle);
    return handle;
}

function channelPair(): [Channel, Channel] {
    let aMsg: ((m: string) => void) | null = null;
    let bMsg: ((m: string) => void) | null = null;
    const a: Channel = { send: (m) => setImmediate(() => bMsg?.(m)), onMessage: (cb) => void (aMsg = cb), onClose: () => {}, close: () => {} };
    const b: Channel = { send: (m) => setImmediate(() => aMsg?.(m)), onMessage: (cb) => void (bMsg = cb), onClose: () => {}, close: () => {} };
    return [a, b];
}

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 5));
    }
}

function service(node: SeqscribeNodeHandle, epoch: string): TranscriptProjectionService {
    const chat = createLiveChatPublisher(node, new TranscriptTopicClaimRegistry(), DAEMON);
    const svc = new TranscriptProjectionService({
        daemonId: () => DAEMON,
        writerId: () => node.writerId,
        epoch,
        appendChatFrame: (sessionId, frame, obs) => chat.appendChatFrame(sessionId, frame, obs),
        readPersistedChat: (sessionId) => chat.readPersistedChat(sessionId),
    });
    return svc;
}

async function publish(svc: TranscriptProjectionService, obs: TranscriptObservation): Promise<void> {
    const before = svc.getCounters();
    svc.observe(SESSION, obs);
    await waitFor(() => {
        const c = svc.getCounters();
        return c.published + c.deduped + c.publishFailed + c.unidentified > before.published + before.deduped + before.publishFailed + before.unidentified;
    });
}

function transcript(n: number, last = ''): BubbleSpec[] {
    return Array.from({ length: n }, (_, i) => ({ id: `d.live.${i + 1}`, ord: ordOf(i), text: i === n - 1 ? `bubble ${i}${last}` : `bubble ${i}` }));
}

const TOPIC = sessionChatTopic(SESSION);

describe('keyed chat lane over real nodes', () => {
    it('publishes keyed frames; a subscriber folds SNAP + DELTA into the same view', async () => {
        const server = openNode(freshDir('srv'));
        const client = openNode(freshDir('cli'));
        const svc = service(server, 'epoch-live');

        await publish(svc, observation(transcript(30)));
        for (let i = 0; i < 20; i += 1) await publish(svc, observation(transcript(30, ` +${'x'.repeat(i)}`)));
        expect(svc.getCounters().published).toBe(21);
        // Every streaming tick after the first wrote one head + commit.
        expect(svc.getCounters().chatRowsWritten).toBe(32 + 20 * 2);

        const [sChan, cChan] = channelPair();
        server.node.attach(sChan, { peerId: 'cli', peerClass: 'content', grants: { [TOPIC]: 'serve' } });
        const peer = client.node.attach(cChan, { peerId: 'srv', peerClass: 'content', grants: {} });
        await waitFor(() => peer.state() === 'ready');

        const store = new TranscriptReplicaStore(client, new TranscriptTopicClaimRegistry());
        const key = { ownerDaemonId: DAEMON, rawSessionId: SESSION };
        expect(store.ensureSubscription(key, peer)).toEqual({ ok: true, alreadySubscribed: false });
        const snaps: Row[][] = [];
        const raw = client.node.subscribe(peer, { view: 'tail', params: { topic: TOPIC } });
        raw.onSnapshot((rows) => snaps.push(rows));

        await waitFor(() => store.getReplica(key).available && snaps.length > 0);
        const first = store.getReplica(key);
        if (!first.available) throw new Error('replica unavailable');
        expect(first.view.messages.map((m) => m.messageId)).toEqual(transcript(30).map((b) => b.id));
        expect(first.view.messages[29]!.content).toBe(`bubble 29 +${'x'.repeat(19)}`);
        // The SNAP is newest-per-key (30 heads + meta + commit), not the 72-row history.
        expect(snaps[0]!.length).toBe(32);
        expect(snaps[0]!.at(-1)!.kind).toBe(CHAT_COMMIT_KIND);

        // DELTA frames on top of the SNAP.
        await publish(svc, observation([...transcript(30, ' done'), { id: 'd.live.99', ord: ordOf(40), text: 'new bubble' }]));
        await waitFor(() => {
            const r = store.getReplica(key);
            return r.available && r.view.messages.length === 31;
        });
        const after = store.getReplica(key);
        if (!after.available) throw new Error('replica unavailable');
        expect(after.view.messages.at(-1)).toMatchObject({ messageId: 'd.live.99', content: 'new bubble' });
        expect(after.identity.frame).toBe(22);
        expect(store.diagnostics(key).rejectedRows).toBe(0);
        expect(store.getCounters().digestMismatches).toBe(0);
        store.stop();
        raw.close();
    }, 60_000);

    it('compaction keeps the topic near its live size while a bubble streams (§4.8)', async () => {
        __resetTranscriptChatRuntimeForTests();
        const node = openNode(freshDir('compact'));
        const svc = service(node, 'epoch-compact');
        await publish(svc, observation(transcript(10)));
        for (let i = 0; i < 200; i += 1) await publish(svc, observation(transcript(10, ` ${i}`)));
        await waitFor(() => transcriptChatRuntimeCounters().prunePasses > 0);
        await new Promise((r) => setTimeout(r, 50));
        const rows = node.node.stats().topics[TOPIC]!.logRows;
        // 10 heads + meta + commit live; without compaction this would be 412 rows.
        expect(transcriptChatRuntimeCounters().prunedRows).toBeGreaterThan(300);
        expect(rows).toBeLessThan(12 + 2 * 64 + 10);
        // The committed state is still whole after pruning.
        const persisted = readPersistedChatTopic(node, TOPIC);
        expect(persisted.committed.filter((r) => r.kind === CHAT_MSG_KIND)).toHaveLength(10);
    }, 60_000);

    it('a restarted producer resumes from the topic: unchanged source → zero rows; ids survive through the ledger seed (§4.10)', async () => {
        const dir = freshDir('restart');
        const first = openNode(dir);
        const svc1 = service(first, 'epoch-1');
        const specs = transcript(5);
        specs[1] = { ...specs[1], text: filler(1, 60_000) }; // a parted bubble
        await publish(svc1, observation(specs));
        await first.close();
        handles.splice(handles.indexOf(first), 1);

        const second = openNode(dir);
        const svc2 = service(second, 'epoch-2');
        await publish(svc2, observation(specs));
        expect(svc2.getCounters()).toMatchObject({ published: 0, deduped: 1 });

        // The ledger rebuilt from the topic keeps the daemon-issued ids and resumes its counter.
        const seed = ledgerSeedFromPersisted(readPersistedChatTopic(second, TOPIC))!;
        expect(seed.epoch).toBe('abc123');
        const ledger = new MessageIdentityLedger({ epoch: seed.epoch });
        expect(ledger.restore(seed)).toBe(true);
        const frame = ledger.observe(
            specs.map((s) => ({ role: 'assistant', kind: 'standard', text: s.text, revisionKey: s.text })),
        );
        expect(frame.assignments.map((a) => a.messageId)).toEqual(specs.map((s) => s.id));
        await second.close();
        handles.splice(handles.indexOf(second), 1);
    }, 60_000);
});

describe('selectChatTailSnapshot — latestPerKey(W) ∪ rowsAfter(W)', () => {
    function entry(n: number): LogEntry {
        return { topic: TOPIC, writer: 'w', seq: n, hlc: { l: n, c: 0 }, kind: 'k', payload: n, chain: 'c' };
    }
    function source(head: number | null): TailSource & { calls: string[] } {
        const calls: string[] = [];
        return {
            topic: TOPIC,
            retention: 'full',
            defaultLimit: 500,
            keyed: true,
            calls,
            page: () => [],
            latestPerKey: (upto) => { calls.push(`latest:${upto}`); return [1, 2, 3].map((n) => ({ entry: entry(n), rowid: n })); },
            rowsAfter: (rowid) => { calls.push(`after:${rowid}`); return [9].map((n) => ({ entry: entry(n), rowid: n })); },
            keyHead: () => (head === null ? null : { entry: entry(head), rowid: head }),
        };
    }

    it('pins the committed state to the newest commit and appends the frame in flight', () => {
        const src = source(3);
        expect(selectChatTailSnapshot(src)!.map((e) => e.seq)).toEqual([1, 2, 3, 9]);
        expect(src.calls).toEqual(['latest:3', 'after:3']);
    });

    it('with no commit yet, every row is pending', () => {
        const src = source(null);
        expect(selectChatTailSnapshot(src)!.map((e) => e.seq)).toEqual([9]);
        expect(src.calls).toEqual(['after:0']);
    });

    it('declines non-keyed topics', () => {
        expect(selectChatTailSnapshot({ ...source(3), keyed: false })).toBeNull();
    });
});
