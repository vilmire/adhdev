import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Channel } from 'seqscribe';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import {
    __resetTranscriptWriterGcForTests,
    configureTranscriptWriterGc,
    runTranscriptWriterGcSweep,
    transcriptWriterGcCounters,
    TRANSCRIPT_PRUNE_MAX_ENTRIES,
} from '../../src/seqscribe/writer-gc.js';

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterAll(async () => {
    for (const h of handles) await h.close().catch(() => {});
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
    __resetTranscriptWriterGcForTests();
    configureTranscriptWriterGc(null);
});

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-writer-gc-${name}-`));
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

async function appendEntries(handle: SeqscribeNodeHandle, topic: string, count: number): Promise<void> {
    const log = handle.node.log(topic);
    for (let i = 0; i < count; i++) {
        await log.append('adhdev.test.entry', { i });
    }
}

/** In-memory Channel pair; delivery is deferred so a send never re-enters the
 *  peer session mid-handler. Mirrors the helper in
 *  mesh-events-idle-consumer-convergence.test.ts / journal.test.ts. */
function channelPair(): [Channel, Channel] {
    const aMsg = { cb: null as ((m: string) => void) | null };
    const bMsg = { cb: null as ((m: string) => void) | null };
    const aClose = { cb: null as (() => void) | null };
    const bClose = { cb: null as (() => void) | null };
    const mk = (
        mine: { cb: ((m: string) => void) | null },
        peerIn: { cb: ((m: string) => void) | null },
        mineClose: { cb: (() => void) | null },
        peerClose: { cb: (() => void) | null },
    ): Channel => ({
        send(msg: string) {
            setTimeout(() => peerIn.cb?.(msg), 0);
        },
        onMessage(cb) {
            mine.cb = cb;
        },
        onClose(cb) {
            mineClose.cb = cb;
        },
        close() {
            peerClose.cb?.();
        },
    });
    return [mk(aMsg, bMsg, aClose, bClose), mk(bMsg, aMsg, bClose, aClose)];
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
}

describe('runTranscriptWriterGcSweep', () => {
    // G2b landed (2026-09-24): `session.<id>.transcript` is now `full`
    // retention (`topics.ts#sessionTranscriptPolicy`), so these tests exercise
    // the REAL topic policy directly rather than a synthetic stand-in.

    it('a topic under the cap is inspected, not flagged, and pruneTopic is called (no-op)', async () => {
        const handle = openNode('under-cap');
        const topic = sessionTranscriptTopic('sess-under');
        handle.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendEntries(handle, topic, 5);

        const result = await runTranscriptWriterGcSweep(handle, { maxEntries: 10 });

        expect(result.overCap).toEqual([]);
        const counters = transcriptWriterGcCounters();
        expect(counters.runs).toBe(1);
        expect(counters.overCapTopics).toBe(0);
        // Under cap, nothing to prune — pruneTopic is idempotent/no-op here.
        expect(counters.rowsPruned).toBe(0);
        expect(handle.node.stats().topics[topic]?.logRows).toBe(5);
    });

    it('★ a topic over the cap is flagged AND actually pruned down to keepNewest', async () => {
        const handle = openNode('over-cap');
        const topic = sessionTranscriptTopic('sess-over');
        handle.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendEntries(handle, topic, 12);

        const result = await runTranscriptWriterGcSweep(handle, { maxEntries: 10 });

        expect(result.overCap).toHaveLength(1);
        expect(result.overCap[0]?.topic).toBe(topic);
        expect(result.overCap[0]?.logRows).toBe(12);
        const counters = transcriptWriterGcCounters();
        expect(counters.overCapTopics).toBe(1);
        // ★ The vendor prune primitive is real now — rowsPruned must be
        // nonzero and the durable row count must actually drop to the cap.
        expect(counters.rowsPruned).toBe(2);
        expect(handle.node.stats().topics[topic]?.logRows).toBe(10);
    });

    it('non-transcript topics are never inspected (prefix/suffix gate)', async () => {
        const handle = openNode('non-transcript');
        // `assistant.journal` is real, boot-defined, `full` retention — a
        // cap of 0 would flag it too if the gate did not restrict to
        // `session.*.transcript` by NAME (not by retention mode).
        await appendEntries(handle, 'assistant.journal', 12);
        const result = await runTranscriptWriterGcSweep(handle, { maxEntries: 0 });
        expect(result.overCap).toEqual([]);
        // pruneTopic must not even be attempted on a non-transcript topic —
        // rowsPruned stays 0 and the journal's rows are untouched.
        expect(transcriptWriterGcCounters().rowsPruned).toBe(0);
        expect(handle.node.stats().topics['assistant.journal']?.logRows).toBe(12);
    });

    it('uses the default cap (TRANSCRIPT_PRUNE_MAX_ENTRIES) when none is supplied', async () => {
        const handle = openNode('default-cap');
        const topic = sessionTranscriptTopic('sess-default');
        handle.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendEntries(handle, topic, 3);

        const result = await runTranscriptWriterGcSweep(handle);
        expect(result.overCap).toEqual([]);
        expect(TRANSCRIPT_PRUNE_MAX_ENTRIES).toBeGreaterThan(3);
    });

    it('★ an active tail subscriber makes the sweep SKIP the topic (counter, not error)', async () => {
        const server = openNode('active-sub-server');
        const client = openNode('active-sub-client');
        const topic = sessionTranscriptTopic('sess-active');
        server.node.defineTopic(topic, sessionTranscriptPolicy());
        client.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendEntries(server, topic, 12);

        const [chS, chC] = channelPair();
        const peerS = server.node.attach(chS, {
            peerId: 'active-sub-client',
            peerClass: 'content',
            grants: { [topic]: 'serve' },
        });
        const peerC = client.node.attach(chC, {
            peerId: 'active-sub-server',
            peerClass: 'content',
            grants: { [topic]: 'none' },
        });
        await waitFor(
            () => peerS.state() === 'ready' && peerC.state() === 'ready',
            'server/client handshake',
        );

        const sub = client.node.subscribe(peerC, { view: 'tail', params: { topic } });
        const unsub = sub.onSnapshot(() => {});
        // Give the SUB a moment to actually attach server-side before pruning.
        await new Promise((r) => setTimeout(r, 50));

        const result = await runTranscriptWriterGcSweep(server, { maxEntries: 10 });

        expect(result.overCap).toHaveLength(1); // still flagged by the row-count read
        const counters = transcriptWriterGcCounters();
        expect(counters.skippedActive).toBe(1);
        expect(counters.errors).toBe(0);
        expect(counters.rowsPruned).toBe(0);
        // Nothing was actually deleted — the refusal blocked the whole call.
        expect(server.node.stats().topics[topic]?.logRows).toBe(12);

        unsub();
    });

    it('a sweep failure (stats() throws) is swallowed and counted, never thrown', async () => {
        const handle = openNode('sweep-error');
        const broken = {
            ...handle,
            node: {
                ...handle.node,
                stats: () => {
                    throw new Error('boom');
                },
            },
        } as unknown as SeqscribeNodeHandle;

        await expect(runTranscriptWriterGcSweep(broken)).resolves.toEqual({ overCap: [] });
        expect(transcriptWriterGcCounters().errors).toBe(1);
    });

    it('a genuine prune failure (not the active-subscriber refusal) is counted as an error, not a skip', async () => {
        const handle = openNode('prune-error');
        const topic = sessionTranscriptTopic('sess-prune-error');
        handle.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendEntries(handle, topic, 12);

        const broken = {
            ...handle,
            node: {
                ...handle.node,
                pruneTopic: async () => {
                    throw new Error('boom: unrelated failure');
                },
            },
        } as unknown as SeqscribeNodeHandle;

        const result = await runTranscriptWriterGcSweep(broken, { maxEntries: 10 });
        expect(result.overCap).toHaveLength(1);
        const counters = transcriptWriterGcCounters();
        // Two independent pruneTopic calls per topic (count bound, then age
        // bound — see writer-gc.ts header for why they are not combined into
        // one call) — a broken pruneTopic fails both.
        expect(counters.errors).toBe(2);
        expect(counters.skippedActive).toBe(0);
    });
});

describe('configureTranscriptWriterGc', () => {
    it('arm/disarm is idempotent and runOnce delegates to the sweep (real prune)', async () => {
        const handle = openNode('arm-disarm');
        const topic = sessionTranscriptTopic('sess-arm');
        handle.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendEntries(handle, topic, 12);

        const gc = configureTranscriptWriterGc(handle, { maxEntries: 10, once: true });
        expect(gc).not.toBeNull();

        const result = await gc!.runOnce();
        expect(result.overCap).toHaveLength(1);
        expect(handle.node.stats().topics[topic]?.logRows).toBe(10);

        gc!.stop();
        // A second stop is a no-op, not a throw.
        expect(() => gc!.stop()).not.toThrow();
    });

    it('configuring a second handle disarms runOnce on the first (ownedHandle guard)', async () => {
        const handleA = openNode('owned-a');
        const handleB = openNode('owned-b');

        const gcA = configureTranscriptWriterGc(handleA, { once: true });
        expect(gcA).not.toBeNull();

        // Re-arming with a different handle should make gcA's runOnce a no-op,
        // matching fleet-status-parity.ts's identical ownedHandle guard.
        configureTranscriptWriterGc(handleB, { once: true });

        const staleResult = await gcA!.runOnce();
        expect(staleResult).toEqual({ overCap: [] });
    });

    it('calling with null disarms and clears the active handle', () => {
        expect(configureTranscriptWriterGc(null)).toBeNull();
    });
});
