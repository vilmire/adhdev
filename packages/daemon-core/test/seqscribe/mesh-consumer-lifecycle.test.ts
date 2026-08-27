import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MESH_EVENT_ENTRY_KIND,
    projectMeshLedgerEntry,
} from '../../src/seqscribe/mesh-event-projection.js';
import {
    configureMeshDualWrite,
    __resetMeshDualWriteForTests,
} from '../../src/seqscribe/mesh-dual-write.js';
import {
    configureMeshReadModel,
    primeMeshReadModel,
    pruneStaleReadModelConsumers,
    rebuildMeshReadModel,
    meshReadModelConsumerName,
    meshReadModelRebuildEpoch,
    __resetMeshReadModelForTests,
} from '../../src/seqscribe/mesh-read-model.js';
import {
    evaluateMeshReadReadiness,
    reportMeshTopicGrants,
    __resetMeshReadReadinessForTests,
} from '../../src/seqscribe/mesh-read-readiness.js';
import { meshEventsTopic } from '../../src/seqscribe/topics.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import type { ParityLedgerEntry } from '../../src/seqscribe/mesh-parity.js';

/**
 * Durable-consumer lifecycle adoption (seqscribe proposals-v3.5 P17–P19).
 *
 * These pin the three host-side behaviours the adoption is responsible for,
 * each of which replaced a workaround that the library now obsoletes:
 *
 *   P19 — the readiness gate's catch-up condition is EVENT-DRIVEN
 *         (`consumerCaughtUp`), not a `lagRows === 0` poll, and a rebuild
 *         invalidates a previously-latched resolution rather than letting the
 *         gate serve from an index that is mid-replay.
 *   P18 — pre-P17 generation cursors (`…#N`) and pre-P21 parity nonce cursors
 *         are GC-able, and the LIVE consumer's own cursor never is.
 *   P17 — covered end-to-end in tests/seqscribe-read-primary.test.mjs
 *         ("at-least-once redelivery…"), which asserts the stable name is
 *         reused and the replay actually happens.
 */

const MESH_ID = 'lifecycle-mesh';

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-lifecycle-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: {},
        storedFleetSecret: null,
        meshIds: [MESH_ID],
    });
    handles.push(handle);
    return handle;
}

async function writeShadowRecord(
    handle: SeqscribeNodeHandle,
    entry: ParityLedgerEntry,
): Promise<void> {
    const projected = projectMeshLedgerEntry(entry);
    await handle.node.log(meshEventsTopic(MESH_ID)).append(MESH_EVENT_ENTRY_KIND, projected);
}

function entry(id: string, timestamp: string): ParityLedgerEntry {
    return { id, timestamp, kind: 'test_kind' };
}

/** Poll a predicate — the gate is synchronous, so readiness lands on a later turn. */
async function until(predicate: () => boolean, what: string, budgetMs = 2000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timeout waiting for: ${what}`);
}

afterEach(async () => {
    __resetMeshDualWriteForTests();
    __resetMeshReadModelForTests();
    __resetMeshReadReadinessForTests();
    for (const handle of handles.splice(0)) {
        await handle.close().catch(() => {});
    }
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('read readiness — event-driven catch-up (P19)', () => {
    it('becomes ready via the catch-up signal once the backlog is absorbed', async () => {
        const handle = openNode('caughtup');
        await writeShadowRecord(handle, entry('cu-1', '2026-01-01T00:00:00.000Z'));
        await writeShadowRecord(handle, entry('cu-2', '2026-01-01T00:01:00.000Z'));

        // The gate short-circuits on `mode_not_primary` before any other
        // condition, so primary mode has to be armed for condition 3 to run.
        configureMeshDualWrite(handle, { ADHDEV_SEQSCRIBE_MESH: 'primary' });
        configureMeshReadModel(handle);
        reportMeshTopicGrants(null);
        primeMeshReadModel(MESH_ID);

        // ★ The FIRST evaluation only ARMS the watch — it must report
        // `consumer_lag`, never an optimistic ready. This is the fail-closed
        // direction: an un-drained index must not answer reads.
        const first = evaluateMeshReadReadiness(MESH_ID);
        expect(first.ready).toBe(false);
        expect(first.reason).toBe('consumer_lag');

        // Readiness then arrives on the promise's resolution, with no polling
        // of `lagRows` anywhere in the path.
        await until(
            () => evaluateMeshReadReadiness(MESH_ID).ready,
            'catch-up signal to make the mesh ready',
        );
    });

    it('a resolved catch-up survives a head that moves afterwards', async () => {
        const handle = openNode('no-flap');
        const topic = meshEventsTopic(MESH_ID);
        await writeShadowRecord(handle, entry('nf-1', '2026-01-01T00:00:00.000Z'));

        configureMeshDualWrite(handle, { ADHDEV_SEQSCRIBE_MESH: 'primary' });
        configureMeshReadModel(handle);
        reportMeshTopicGrants(null);
        primeMeshReadModel(MESH_ID);
        await until(() => evaluateMeshReadReadiness(MESH_ID).ready, 'initial readiness');

        // ★ THE CONTRACT DIFFERENCE between the catch-up signal and the
        // `lagRows === 0` poll it replaced, asserted at the library seam where
        // it is deterministic.
        //
        // `lagRows` is `maxRowid - lastRowid`, so it goes positive the instant a
        // row lands and BEFORE the consumer callback runs. A poll therefore
        // re-derives "behind" from a head that has moved, and kicks the mesh
        // back to the ledger on writes the index was never asked about. A
        // resolved `consumerCaughtUp` is a statement about the head observed
        // when it was taken, and a later append begins a NEW interval instead of
        // retroactively unresolving it (seqscribe P19).
        //
        // Asserting it here rather than through the gate is deliberate: the gate
        // is synchronous while the drain is not, so any test that tries to
        // observe the gate mid-drain depends on scheduling. The property that
        // actually distinguishes the two implementations does not.
        const settled = await handle.node.consumerCaughtUp(topic, 'stage4a-mesh-read-model');
        expect(settled.throughRowid).toBeGreaterThan(0);

        await writeShadowRecord(handle, entry('nf-2', '2026-01-01T00:01:00.000Z'));

        // The head moved past what the resolution covered...
        const head = handle.node.stats().topics[topic]!;
        expect(head.consumers['stage4a-mesh-read-model']).toBeDefined();

        // ...and re-asking resolves against the NEW head rather than reporting
        // the previous interval as broken. Under a poll this same moment is a
        // `consumer_lag` fallback.
        const again = await handle.node.consumerCaughtUp(topic, 'stage4a-mesh-read-model');
        expect(again.throughRowid).toBeGreaterThanOrEqual(settled.throughRowid);

        // The gate, which reads the latch rather than the head, stayed ready
        // throughout — no flap.
        expect(evaluateMeshReadReadiness(MESH_ID).ready).toBe(true);
    });

    it('drives condition 3 from consumerCaughtUp, never from a lagRows reading', async () => {
        const handle = openNode('no-poll');
        const topic = meshEventsTopic(MESH_ID);
        await writeShadowRecord(handle, entry('np-1', '2026-01-01T00:00:00.000Z'));

        configureMeshDualWrite(handle, { ADHDEV_SEQSCRIBE_MESH: 'primary' });
        configureMeshReadModel(handle);
        reportMeshTopicGrants(null);
        primeMeshReadModel(MESH_ID);
        await until(() => evaluateMeshReadReadiness(MESH_ID).ready, 'initial readiness');

        // ★ THE STRUCTURAL ASSERTION, and the one that actually fails if
        // condition 3 is reverted to the poll.
        //
        // The behavioural tests above pass under BOTH implementations — the
        // drain is fast enough in-process that a poll usually reads zero lag
        // too, so no timing-based assertion reliably separates them. What does
        // separate them is which library call the condition is built on. So:
        // make `consumerCaughtUp` unavailable and lie about the lag. A gate on
        // the catch-up signal cannot report ready; a gate on `lagRows` reads the
        // planted zero and does.
        const real = handle.node.consumerCaughtUp.bind(handle.node);
        const realStats = handle.node.stats.bind(handle.node);
        let caughtUpCalls = 0;
        try {
            (handle.node as { consumerCaughtUp: unknown }).consumerCaughtUp = (
                t: string,
                c: string,
            ) => {
                caughtUpCalls++;
                return Promise.reject(new Error('catch-up unavailable'));
            };
            (handle.node as { stats: unknown }).stats = () => {
                const s = realStats();
                const entryStats = s.topics[topic];
                if (entryStats) {
                    // A poll-based gate would believe this.
                    entryStats.consumers['stage4a-mesh-read-model'] = {
                        lastRowid: 999,
                        lagRows: 0,
                    };
                }
                return s;
            };

            // Force the latch to rearm against the stubbed surface.
            rebuildMeshReadModel(MESH_ID);
            const verdict = evaluateMeshReadReadiness(MESH_ID);

            expect(caughtUpCalls).toBeGreaterThan(0);
            expect(verdict.ready).toBe(false);
            expect(verdict.reason).toBe('consumer_lag');
        } finally {
            (handle.node as { consumerCaughtUp: unknown }).consumerCaughtUp = real;
            (handle.node as { stats: unknown }).stats = realStats;
        }
    });

    it('a rebuild invalidates a latched catch-up rather than serving a mid-replay index', async () => {
        const handle = openNode('rebuild-invalidate');
        await writeShadowRecord(handle, entry('ri-1', '2026-01-01T00:00:00.000Z'));

        // The gate short-circuits on `mode_not_primary` before any other
        // condition, so primary mode has to be armed for condition 3 to run.
        configureMeshDualWrite(handle, { ADHDEV_SEQSCRIBE_MESH: 'primary' });
        configureMeshReadModel(handle);
        reportMeshTopicGrants(null);
        primeMeshReadModel(MESH_ID);
        await until(() => evaluateMeshReadReadiness(MESH_ID).ready, 'initial readiness');

        const epochBefore = meshReadModelRebuildEpoch(MESH_ID);
        rebuildMeshReadModel(MESH_ID);
        expect(meshReadModelRebuildEpoch(MESH_ID)).toBe(epochBefore + 1);

        // ★ The rebuild rewound the cursor under the SAME consumer name, so the
        // gate cannot reuse the resolution it latched before. Without the epoch
        // in the latch identity, this would still report ready while the index
        // is replaying from the floor — the "confidently empty replica" failure.
        const immediatelyAfter = evaluateMeshReadReadiness(MESH_ID);
        expect(immediatelyAfter.ready).toBe(false);
        expect(immediatelyAfter.reason).toBe('consumer_lag');

        // And it recovers on the new watch rather than staying stuck.
        await until(
            () => evaluateMeshReadReadiness(MESH_ID).ready,
            'readiness to return after the rebuild replays',
        );
    });
});

describe('durable-consumer GC (P18)', () => {
    it('prunes generation and parity cursors but never the live consumer', async () => {
        const handle = openNode('prune');
        const topic = meshEventsTopic(MESH_ID);
        await writeShadowRecord(handle, entry('gc-1', '2026-01-01T00:00:00.000Z'));

        configureMeshReadModel(handle);
        primeMeshReadModel(MESH_ID);
        expect(meshReadModelConsumerName(MESH_ID)).toBe('stage4a-mesh-read-model');

        // Simulate what older builds left on disk: a pre-P17 generation cursor
        // and a pre-P21 parity nonce cursor. `resetConsumer` materializes the
        // row without registering a live consumer, which is exactly the shape
        // an abandoned cursor has.
        handle.node.resetConsumer(topic, 'stage4a-mesh-read-model#2', { from: 'earliest-retained' });
        handle.node.resetConsumer(topic, 'stage3-mesh-parity:1234-0', { from: 'earliest-retained' });

        const before = handle.node.listConsumers(topic).map((c) => c.consumer);
        expect(before).toContain('stage4a-mesh-read-model#2');
        expect(before).toContain('stage3-mesh-parity:1234-0');

        const pruned = pruneStaleReadModelConsumers(MESH_ID);
        expect(pruned.sort()).toEqual(['stage3-mesh-parity:1234-0', 'stage4a-mesh-read-model#2']);

        const after = handle.node.listConsumers(topic).map((c) => c.consumer);
        // ★ The live consumer's own row survives. `stage4a-mesh-read-model` is a
        // PREFIX of `stage4a-mesh-read-model#2`, so a prune keyed on the bare
        // constant would delete the live cursor and silently force a full
        // replay on next boot — the prefix is `…#` for exactly this reason.
        expect(after).toContain('stage4a-mesh-read-model');
        expect(after).not.toContain('stage4a-mesh-read-model#2');
        expect(after).not.toContain('stage3-mesh-parity:1234-0');
    });
});
