import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel, LogEntry, Row, TailSource } from 'seqscribe';
import { jcs } from 'seqscribe';
import { afterAll, describe, expect, it } from 'vitest';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import { encodeTranscriptSnapshot, type TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';
import { TranscriptReplicaStore } from '../../src/seqscribe/transcript-replica-store.js';
import {
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    encodeTranscriptRevision,
    type TranscriptRevisionIdentity,
} from '../../src/seqscribe/transcript-revision-codec.js';
import {
    isSessionTranscriptTopic,
    selectTranscriptTailSnapshot,
} from '../../src/seqscribe/transcript-tail-snapshot.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';

/**
 * Transcript tail-SNAP selector (transcript-tail-snapshot.ts): a fresh or
 * resyncing subscriber to `session.<id>.transcript` receives the newest
 * structurally complete revision plus the in-flight one — not the last 500
 * rows (up to ~18 MB at 36 KiB chunks), which the 2026-09-27 resync storm
 * re-serialized per write.
 */

// ─── unit: selection over a synthetic tail ──────────────────────────────────

let rowid = 0;
function entry(kind: string, payload: Record<string, unknown>, writer = 'w-owner'): LogEntry {
    rowid++;
    return {
        topic: 'session.s.transcript',
        writer,
        seq: rowid,
        hlc: { l: rowid, c: 0 },
        kind,
        payload: payload as never,
        chain: 'x',
    };
}
function revisionRows(revision: number, chunks: number, opts: { skipChunk?: number; epoch?: string } = {}): LogEntry[] {
    const producerEpoch = opts.epoch ?? 'e1';
    const rows = [entry(TRANSCRIPT_REVISION_BEGIN_KIND, { producerEpoch, revision, chunks })];
    for (let index = 0; index < chunks; index++) {
        if (index === opts.skipChunk) continue;
        rows.push(entry(TRANSCRIPT_REVISION_CHUNK_KIND, { producerEpoch, revision, chunks, index }));
    }
    rows.push(entry(TRANSCRIPT_REVISION_COMMIT_KIND, { producerEpoch, revision, chunks }));
    return rows;
}
function sourceOver(rows: LogEntry[], defaultLimit = 500): TailSource & { reads: number } {
    const withIds = rows.map((e, i) => ({ entry: e, rowid: i + 1 }));
    const src = {
        topic: 'session.s.transcript',
        retention: 'full' as const,
        defaultLimit,
        reads: 0,
        page(before: number | null, limit: number) {
            const end = before === null ? withIds.length : before - 1;
            const out = withIds.slice(Math.max(0, end - limit), end).reverse();
            src.reads += out.length;
            return out;
        },
    };
    return src;
}
const tag = (rows: LogEntry[] | null) =>
    rows?.map((e) => `${e.kind.split('.')[2]}:${(e.payload as { revision: number }).revision}`) ?? null;

describe('selectTranscriptTailSnapshot', () => {
    it('keeps the newest complete revision plus the in-flight one, nothing older', () => {
        const rows = [...revisionRows(1, 3), ...revisionRows(2, 3), ...revisionRows(3, 2)];
        const inflight = revisionRows(4, 3).slice(0, 2); // begin + chunk 0, no commit yet
        const src = sourceOver([...rows, ...inflight]);
        expect(tag(selectTranscriptTailSnapshot(src))).toEqual([
            'begin:3',
            'chunk:3',
            'chunk:3',
            'commit:3',
            'begin:4',
            'chunk:4',
        ]);
        // bounded read: only what it needed, not the window
        expect(src.reads).toBeLessThanOrEqual(64);
    });

    it('skips a torn newest revision (missing chunk) and falls back to the previous complete one', () => {
        const src = sourceOver([...revisionRows(1, 2), ...revisionRows(2, 3, { skipChunk: 1 })]);
        expect(tag(selectTranscriptTailSnapshot(src))).toEqual([
            'begin:1',
            'chunk:1',
            'chunk:1',
            'commit:1',
            'begin:2',
            'chunk:2',
            'chunk:2',
            'commit:2',
        ]);
    });

    it('null (→ default window) when no complete revision is reachable', () => {
        expect(selectTranscriptTailSnapshot(sourceOver(revisionRows(1, 3).slice(0, 3)))).toBeNull();
        expect(selectTranscriptTailSnapshot(sourceOver([]))).toBeNull();
        // begin fell outside the window the default SNAP would have served
        expect(selectTranscriptTailSnapshot(sourceOver(revisionRows(1, 10), 5))).toBeNull();
    });

    it('a commit whose begin carries a different producerEpoch is not paired with it', () => {
        const rows = [...revisionRows(1, 1, { epoch: 'old' })];
        rows.push(entry(TRANSCRIPT_REVISION_COMMIT_KIND, { producerEpoch: 'new', revision: 1, chunks: 1 }));
        // the new-epoch commit has no begin; the old-epoch revision is complete
        expect(tag(selectTranscriptTailSnapshot(sourceOver(rows)))).toEqual([
            'begin:1',
            'chunk:1',
            'commit:1',
            'commit:1',
        ]);
    });

    it('matches only session transcript topics', () => {
        expect(isSessionTranscriptTopic(sessionTranscriptTopic('abc'))).toBe(true);
        expect(isSessionTranscriptTopic('fleet.status')).toBe(false);
        expect(isSessionTranscriptTopic('session..transcript')).toBe(false);
    });
});

// ─── integration: real nodes, real SUB, real replica store ──────────────────

const SESSION_ID = 'sess-tail-snap-1';
const TOPIC = sessionTranscriptTopic(SESSION_ID);
const OWNER_DAEMON = 'daemon_mach_tail_snap_owner';
const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterAll(async () => {
    for (const h of handles) await h.close().catch(() => {});
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-tail-snap-${name}-`));
    tmpDirs.push(dir);
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
    const a: Channel = {
        send: (m) => setImmediate(() => bMsg?.(m)),
        onMessage: (cb) => void (aMsg = cb),
        onClose: () => {},
        close: () => {},
    };
    const b: Channel = {
        send: (m) => setImmediate(() => aMsg?.(m)),
        onMessage: (cb) => void (bMsg = cb),
        onClose: () => {},
        close: () => {},
    };
    return [a, b];
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 5));
    }
}

function bigText(revision: number, bytes: number): string {
    let s = `rev ${revision}: `;
    let x = revision * 2654435761;
    while (s.length < bytes) {
        x = (x * 1103515245 + 12345) >>> 0;
        s += x.toString(36);
    }
    return s;
}

function encodeRevision(writerId: string, revision: number, text: string) {
    const identity: TranscriptRevisionIdentity = {
        sessionId: SESSION_ID,
        producerDaemonId: OWNER_DAEMON,
        producerWriterId: writerId,
        producerEpoch: 'epoch-tail-snap',
        revision,
    };
    const candidate: TranscriptSnapshotCandidate = {
        sessionId: SESSION_ID,
        providerType: 'codex-cli',
        producerDaemonId: OWNER_DAEMON,
        producerWriterId: writerId,
        producerEpoch: identity.producerEpoch,
        revision,
        observedAt: '2026-09-27T00:00:00.000Z',
        status: 'generating',
        messages: [{ role: 'assistant', kind: 'standard', content: text }],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    };
    const encoded = encodeTranscriptRevision(encodeTranscriptSnapshot(candidate), identity);
    if (!encoded.ok) throw new Error('fixture encode failed');
    return encoded;
}

async function appendRows(handle: SeqscribeNodeHandle, rows: { kind: string; payload: unknown }[]): Promise<void> {
    const log = handle.node.log(TOPIC);
    await Promise.all(rows.map((r) => log.append(r.kind, r.payload as never)));
}

function revisionAppends(enc: ReturnType<typeof encodeRevision>) {
    return [
        { kind: TRANSCRIPT_REVISION_BEGIN_KIND, payload: enc.begin },
        ...enc.chunks.map((c) => ({ kind: TRANSCRIPT_REVISION_CHUNK_KIND, payload: c })),
        { kind: TRANSCRIPT_REVISION_COMMIT_KIND, payload: enc.commit },
    ];
}

describe('transcript tail SNAP over real nodes (installed by openSeqscribeNode)', () => {
    it('a fresh subscriber gets only the newest complete + in-flight revision, and the replica store resolves it', async () => {
        const server = openNode('srv');
        const client = openNode('cli');
        server.node.defineTopic(TOPIC, sessionTranscriptPolicy());

        // 40 revisions × (begin + 3 chunks + commit) = 200 rows of history,
        // then revision 41 in flight (begin + 1 chunk).
        const REVISIONS = 40;
        for (let rev = 1; rev <= REVISIONS; rev++) {
            await appendRows(server, revisionAppends(encodeRevision(server.writerId, rev, bigText(rev, 80_000))));
        }
        const inflight = encodeRevision(server.writerId, REVISIONS + 1, bigText(REVISIONS + 1, 80_000));
        const inflightRows = revisionAppends(inflight);
        await appendRows(server, inflightRows.slice(0, 2));
        const totalRows = REVISIONS * (2 + 3) + 2;
        expect(server.node.stats().topics[TOPIC]!.logRows).toBe(totalRows);

        const [sChan, cChan] = channelPair();
        server.node.attach(sChan, { peerId: 'cli', peerClass: 'content', grants: { [TOPIC]: 'serve' } });
        const peer = client.node.attach(cChan, { peerId: 'srv', peerClass: 'content', grants: {} });
        await waitFor(() => peer.state() === 'ready');

        const store = new TranscriptReplicaStore(client, new TranscriptTopicClaimRegistry());
        const key = { ownerDaemonId: OWNER_DAEMON, rawSessionId: SESSION_ID };
        expect(store.ensureSubscription(key, peer)).toEqual({ ok: true, alreadySubscribed: false });
        // raw observer on the same wire, to measure the SNAP itself
        const snaps: Row[][] = [];
        const raw = client.node.subscribe(peer, { view: 'tail', params: { topic: TOPIC } });
        raw.onSnapshot((rows) => snaps.push(rows));

        await waitFor(() => store.getReplica(key).available && snaps.length > 0);
        const replica = store.getReplica(key);
        expect(replica.available && replica.snapshot.revision).toBe(REVISIONS);

        // SNAP = revision 40 (5 rows) + in-flight 41 (2 rows) — not 202 rows
        expect(snaps[0]!.length).toBe(5 + 2);
        expect(snaps[0]!.map((r) => r.kind)).toEqual([
            TRANSCRIPT_REVISION_BEGIN_KIND,
            TRANSCRIPT_REVISION_CHUNK_KIND,
            TRANSCRIPT_REVISION_CHUNK_KIND,
            TRANSCRIPT_REVISION_CHUNK_KIND,
            TRANSCRIPT_REVISION_COMMIT_KIND,
            TRANSCRIPT_REVISION_BEGIN_KIND,
            TRANSCRIPT_REVISION_CHUNK_KIND,
        ]);
        // bounded to the latest revision's size, not the tail's
        const snapBytes = jcs(snaps[0] as never).length;
        const perRevisionBytes = jcs(revisionAppends(inflight).map((r) => r.payload) as never).length;
        expect(snapBytes).toBeLessThan(perRevisionBytes * 2.5);

        // the in-flight revision completes over DELTA on top of the trimmed SNAP
        await appendRows(server, inflightRows.slice(2));
        await waitFor(() => {
            const r = store.getReplica(key);
            return r.available && r.snapshot.revision === REVISIONS + 1;
        });
        const after = store.getReplica(key);
        expect(after.available && after.snapshot.messages[0]?.content.startsWith(`rev ${REVISIONS + 1}:`)).toBe(true);
        expect(store.diagnostics(key).rejectedRows).toBe(0);
        store.stop();
        raw.close();
    }, 60_000);
});
