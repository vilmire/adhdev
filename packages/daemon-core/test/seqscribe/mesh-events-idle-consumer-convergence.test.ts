import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Channel } from 'seqscribe';
import {
    activateKnownMeshTopics,
    configureMeshDualWrite,
    recordMeshEventShadow,
    __resetMeshDualWriteForTests,
} from '../../src/seqscribe/mesh-dual-write.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { meshEventsTopic } from '../../src/seqscribe/topics.js';

/**
 * `mesh.<id>.events` replication to an IDLE peer — the live stall this suite pins.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * Production opens the node with NO `meshIds` (boot/daemon-lifecycle.ts), so
 * `mesh.<id>.events` used to be defined ONLY by `ensureTopic` on this daemon's
 * first mesh append. A node that participates in a mesh but never WRITES to it
 * therefore never defined the topic — and since each side derives its grant map
 * from its own defined topic set, it never granted it either.
 *
 * `mutualFull(topic)` requires BOTH sides to grant `full`, and every sync path
 * is gated on it: `processPeerVectors` skips the topic, `serveHave` omits it
 * from the advertised vectors, and `queueWant` is never reached. Anti-entropy
 * kept firing and simply could not see the topic.
 *
 * Live symptom: the writer's unreplicated count for this topic climbed
 * monotonically (291 → 313 → 317) while its sync logs showed the topic was
 * never once selected for a round — because on that pair the topic effectively
 * did not exist.
 *
 * ── What these tests pin ───────────────────────────────────────────────────
 * The first test is the RED/GREEN one: reverting `activateKnownMeshTopics` (or
 * its boot call) leaves the consumer at zero entries forever, because nothing
 * else in the system will ever define the topic on a node that does not write.
 *
 * ★ Both nodes are opened WITHOUT `meshIds`, deliberately: passing them would
 * define the topic at boot and paper over the exact gap under test.
 */

const MESH_ID = 'idle-consumer-mesh';
const TOPIC = meshEventsTopic(MESH_ID);

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-idlesync-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: {},
        storedFleetSecret: null,
        // ★ No meshIds — this is the production shape and the whole point.
    });
    handles.push(handle);
    return handle;
}

afterEach(async () => {
    __resetMeshDualWriteForTests();
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

/** In-memory Channel pair; delivery is deferred so a send never re-enters the
 *  peer session mid-handler. Mirrors the helper in journal.test.ts. */
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

/**
 * Grants derived exactly as the cloud transport derives them
 * (`SeqscribeDataChannelRouter.deriveGrants`): from the node's CURRENT topic
 * set, with `subscribe-only` topics getting `serve` rather than `full`.
 *
 * Deriving them here rather than hard-coding `{[TOPIC]: 'full'}` is what makes
 * the test faithful: hard-coding the grant would hand the consumer the topic
 * the production bug denied it, and the test would pass against the defect.
 */
function deriveGrants(handle: SeqscribeNodeHandle): Record<string, 'full' | 'serve' | 'none'> {
    return Object.fromEntries(
        handle.topics.map(({ topic, policy }) => [
            topic,
            policy.replication === 'subscribe-only' ? 'serve' : 'full',
        ]),
    ) as Record<string, 'full' | 'serve' | 'none'>;
}

function entry(id: string) {
    return {
        id,
        timestamp: new Date().toISOString(),
        kind: 'task_dispatched',
        nodeId: 'node-writer',
        taskId: `task-${id}`,
    };
}

/** Rows the node holds on the mesh events topic (0 when it is undefined here). */
function entryCount(handle: SeqscribeNodeHandle): number {
    return handle.node.stats().topics[TOPIC]?.logRows ?? 0;
}

describe('mesh.<id>.events convergence to an idle (non-writing) peer', () => {
    it('replicates a writer backlog to a peer that never writes the mesh', async () => {
        const writer = openNode('writer');
        const consumer = openNode('consumer');

        // The writer arms its shadow leg and appends — this defines the topic on
        // the WRITER only, which is the pre-fix production state.
        configureMeshDualWrite(writer);
        recordMeshEventShadow(MESH_ID, entry('e1'));
        recordMeshEventShadow(MESH_ID, entry('e2'));
        recordMeshEventShadow(MESH_ID, entry('e3'));
        await waitFor(() => entryCount(writer) === 3, 'writer local appends');

        // ★ The consumer knows the mesh but has never written an event for it.
        // This is the call under test — without it the topic is undefined here,
        // the grant map below omits it, `mutualFull` is false forever, and no
        // WANT round is ever issued for the topic.
        configureMeshDualWrite(consumer);
        activateKnownMeshTopics([MESH_ID]);

        const [chW, chC] = channelPair();
        const peerW = writer.node.attach(chW, {
            peerId: 'consumer',
            peerClass: 'content',
            grants: deriveGrants(writer),
        });
        const peerC = consumer.node.attach(chC, {
            peerId: 'writer',
            peerClass: 'content',
            grants: deriveGrants(consumer),
        });
        await waitFor(
            () => peerW.state() === 'ready' && peerC.state() === 'ready',
            'sync handshake',
        );

        // The backlog converges with no write on the consumer side and without
        // waiting for anti-entropy — the topic becoming mutual triggers a HAVE
        // round immediately.
        await waitFor(
            () => entryCount(consumer) === 3,
            'writer backlog replicated to the idle consumer',
        );
    });

    it('defines the topic on a node that has appended nothing', () => {
        const consumer = openNode('define-only');
        configureMeshDualWrite(consumer);

        expect(consumer.topics.some((d) => d.topic === TOPIC)).toBe(false);
        expect(activateKnownMeshTopics([MESH_ID])).toBe(1);
        // `node.topics` must stay truthful: the transport builds its grant map
        // from it, so a topic missing here is invisible to every later attach.
        expect(consumer.topics.some((d) => d.topic === TOPIC)).toBe(true);
        expect(deriveGrants(consumer)[TOPIC]).toBe('full');
    });

    it('is idempotent and appends nothing', async () => {
        const node = openNode('idempotent');
        configureMeshDualWrite(node);

        expect(activateKnownMeshTopics([MESH_ID])).toBe(1);
        // A second activation (a re-arm, or a mesh already activated by a write)
        // must not redefine the topic — the library rejects that — and must not
        // re-announce it as newly activated.
        expect(activateKnownMeshTopics([MESH_ID])).toBe(0);
        expect(node.topics.filter((d) => d.topic === TOPIC)).toHaveLength(1);
        // Activation is definition only. It must never manufacture entries.
        expect(entryCount(node)).toBe(0);
    });

    it('no-ops when the dual-write leg is not armed', () => {
        const node = openNode('unarmed');
        __resetMeshDualWriteForTests();
        expect(activateKnownMeshTopics([MESH_ID])).toBe(0);
        expect(node.topics.some((d) => d.topic === TOPIC)).toBe(false);
    });
});
