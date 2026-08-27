import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Channel } from 'seqscribe';
import { appendAssistantJournal, consumeAssistantJournal } from '../../src/seqscribe/journal.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { summarizeSeqscribeStats } from '../../src/seqscribe/stats.js';
import { ASSISTANT_JOURNAL_TOPIC } from '../../src/seqscribe/topics.js';
import { buildCloudStatusReportPayload } from '../../src/status/reporter.js';

/**
 * assistant.journal official API (Phase 1, design §2) — and the SECRET LEAKAGE
 * REGRESSION that is the point of this suite: the HMAC fleet secret must appear
 * NOWHERE outside the in-memory authority object. Not in a sync frame, not in
 * stats, not in the status payload, and not in the seqscribe.db bytes (certs
 * store signatures, never keys). The canary string is long and distinctive so
 * any accidental serialization trips the assertions below.
 */

const CANARY = 'fleet-secret-LEAK-CANARY-0123456789abcdef';

/**
 * `JSON.stringify(x).not.toContain(CANARY)` catches the canary whether it
 * appears as a value or as a substring of an object KEY — `JSON.stringify`
 * renders keys as quoted strings too. The one shape it silently misses is a
 * `Map`/`Set`: `JSON.stringify(new Map([[CANARY, 1]]))` serializes to `"{}"`,
 * losing the canary entirely rather than leaking it. This walks the object
 * graph directly (unwrapping Map/Set) so a future stats field returning a Map
 * still trips the assertion instead of silently passing.
 */
function assertNoCanaryAnywhere(value: unknown, canary: string, path = 'root'): void {
    if (typeof value === 'string') {
        expect(value, `canary leaked at ${path}`).not.toContain(canary);
        return;
    }
    if (value instanceof Map) {
        for (const [k, v] of value.entries()) {
            expect(String(k), `canary leaked in Map key at ${path}`).not.toContain(canary);
            assertNoCanaryAnywhere(v, canary, `${path}[Map:${String(k)}]`);
        }
        return;
    }
    if (value instanceof Set) {
        for (const v of value.values()) assertNoCanaryAnywhere(v, canary, `${path}[Set]`);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((v, i) => assertNoCanaryAnywhere(v, canary, `${path}[${i}]`));
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            expect(k, `canary leaked in object key at ${path}`).not.toContain(canary);
            assertNoCanaryAnywhere(v, canary, `${path}.${k}`);
        }
    }
}

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function tmpDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-sqjrn-${name}-`));
    tmpDirs.push(dir);
    return dir;
}

async function openNode(name: string, env: NodeJS.ProcessEnv): Promise<SeqscribeNodeHandle> {
    const handle = openSeqscribeNode({
        dbPath: join(tmpDir(name), 'seq.db'),
        env,
        storedFleetSecret: null,
    });
    handles.push(handle);
    return handle;
}

afterEach(async () => {
    for (const handle of handles.splice(0)) {
        await handle.close().catch(() => {});
    }
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
}

/**
 * In-memory Channel pair. send() is recorded (the leak assertion wraps every
 * frame) and delivered to the PEER's onMessage on a macrotask — a synchronous
 * delivery would re-enter the session mid-handler. close() fires the peer's
 * onClose. (A loopback wiring here — send delivered to the SENDER's own
 * onMessage — still reaches `ready`, because the HELLO grants match; guard
 * against it by asserting actual cross-node delivery below, not just state.)
 */
function channelPair(frames: string[]): [Channel, Channel] {
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
            frames.push(msg);
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

describe('assistant.journal API', () => {
    it('appends and delivers entries to a consumer in order', async () => {
        const handle = await openNode('order', { ADHDEV_SEQSCRIBE_FLEET_SECRET: CANARY });

        await appendAssistantJournal(handle, 'note', { text: 'first' });
        await appendAssistantJournal(handle, 'note', { text: 'second' });
        await appendAssistantJournal(handle, 'action', { text: 'third' });

        const received: { kind: string; text: unknown }[] = [];
        consumeAssistantJournal(handle, 'reader-a', (entry) => {
            received.push({ kind: entry.kind, text: (entry.payload as { text?: unknown }).text });
        });

        await waitFor(() => received.length === 3, 'consumer delivery');
        expect(received).toEqual([
            { kind: 'note', text: 'first' },
            { kind: 'note', text: 'second' },
            { kind: 'action', text: 'third' },
        ]);
    });

    it('gives a second consumer name its own independent delivery', async () => {
        const handle = await openNode('consumers', { ADHDEV_SEQSCRIBE_FLEET_SECRET: CANARY });

        const first: string[] = [];
        consumeAssistantJournal(handle, 'reader-a', (entry) => {
            first.push(entry.kind);
        });
        await appendAssistantJournal(handle, 'one', {});
        await waitFor(() => first.length === 1, 'first consumer');

        // Registered AFTER the append: a distinct name is a distinct durable
        // cursor, so it replays the retained log from the start.
        const second: string[] = [];
        consumeAssistantJournal(handle, 'reader-b', (entry) => {
            second.push(entry.kind);
        });
        await appendAssistantJournal(handle, 'two', {});

        await waitFor(() => second.length === 2, 'second consumer replay');
        expect(second).toEqual(['one', 'two']);
        await waitFor(() => first.length === 2, 'first consumer follow-up');
        expect(first).toEqual(['one', 'two']);
    });

    it('rejects a blank consumer name', async () => {
        const handle = await openNode('blank', { ADHDEV_SEQSCRIBE_FLEET_SECRET: CANARY });
        expect(() => consumeAssistantJournal(handle, '  ', () => {})).toThrow(/non-empty/);
    });

    it('throws a clear error when appending on an authority-less node', async () => {
        const handle = await openNode('provisional', {});
        expect(handle.authorityEnabled).toBe(false);
        await expect(appendAssistantJournal(handle, 'note', {})).rejects.toThrow(/fleet secret/);
    });
});

describe('fleet secret leakage regression', () => {
    it('never serializes the secret into frames, stats, status payloads, or the DB file', async () => {
        const env: NodeJS.ProcessEnv = { ADHDEV_SEQSCRIBE_FLEET_SECRET: CANARY };
        const a = await openNode('leak-a', env);
        const b = await openNode('leak-b', env);

        const frames: string[] = [];
        const [chA, chB] = channelPair(frames);
        const grants = { [ASSISTANT_JOURNAL_TOPIC]: 'full' as const };
        const peerA = a.node.attach(chA, { peerId: 'node-b', peerClass: 'content', grants });
        const peerB = b.node.attach(chB, { peerId: 'node-a', peerClass: 'content', grants });
        await waitFor(
            () => peerA.state() === 'ready' && peerB.state() === 'ready',
            'sync handshake',
        );

        const received: string[] = [];
        consumeAssistantJournal(b, 'leak-check', (entry) => {
            received.push(entry.kind);
        });
        await appendAssistantJournal(a, 'canary-check', { marker: 'visible-payload-is-fine' });
        await waitFor(() => received.length === 1, 'replication to node b');
        // Let any trailing anti-entropy frames flush before asserting on the
        // full frame set.
        await new Promise((r) => setTimeout(r, 250));

        // (a) every frame sent over either channel
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) {
            expect(frame).not.toContain(CANARY);
        }

        // (b) node stats and the cloud status payload built from them
        for (const handle of [a, b]) {
            const stats = handle.node.stats();
            expect(JSON.stringify(stats)).not.toContain(CANARY);
            assertNoCanaryAnywhere(stats, CANARY, 'stats');
            const payload = buildCloudStatusReportPayload(
                [],
                undefined,
                1,
                summarizeSeqscribeStats(stats, { authorityEnabled: handle.authorityEnabled }),
            );
            expect(JSON.stringify(payload)).not.toContain(CANARY);
            assertNoCanaryAnywhere(payload, CANARY, 'payload');
        }

        // (c) the on-disk bytes — after close so the WAL is checkpointed
        await a.close();
        await b.close();
        handles.length = 0;
        for (const handle of [a, b]) {
            for (const file of readdirSync(dirname(handle.dbPath))) {
                const bytes = readFileSync(join(dirname(handle.dbPath), file));
                expect(bytes.includes(Buffer.from(CANARY, 'utf-8'))).toBe(false);
            }
        }
    });
});
