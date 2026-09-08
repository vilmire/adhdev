import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    configureMeshDualWrite,
    recordMeshEventShadow,
    meshDualWriteCounters,
    meshDualWriteInflight,
    MAX_INFLIGHT,
    __resetMeshDualWriteForTests,
    type MeshShadowEntry,
} from '../../src/seqscribe/mesh-dual-write.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';

/**
 * In-flight accounting for the mesh shadow leg.
 *
 * The cap at `MAX_INFLIGHT` is a LOAD-SHED, and a load-shed is only correct if
 * the counter it reads is an honest measure of appends actually outstanding.
 * Two ways it stopped being honest, both pinned here:
 *
 *   A. LEAK — `append` keeps ONE synchronous throw (seqscribe v3.5 P11 §11.1:
 *      a raw append on a register topic is a static API misuse, normatively a
 *      throw). If the slot is taken before that throw, neither settle handler
 *      ever runs and the slot is never returned. Enough of them and `inflight`
 *      parks at the cap permanently: every subsequent record is dropped, for the
 *      life of the process, with the topic perfectly healthy. Fail-closed and
 *      silent — the worst shape a shadow leg can fail in.
 *   B. NEGATIVE — reconfiguring zeroed the counter while earlier appends were
 *      still outstanding. Each of those then settled and decremented from zero,
 *      driving `inflight` negative. A negative baseline puts `>= MAX_INFLIGHT`
 *      out of reach and the cap silently stops bounding anything.
 *
 * Both are tested through the module's public surface with an injected handle
 * whose `log()`/`append()` we control, because the point is the CALLER's
 * accounting, not the library's.
 */

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(name: string, meshIds: readonly string[]): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-mesh-dw-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: {},
        storedFleetSecret: null,
        daemonId: 'daemon_mach_test',
        meshIds,
    });
    handles.push(handle);
    return handle;
}

function entry(id: string): MeshShadowEntry {
    return {
        id,
        timestamp: new Date(1_700_000_000_000).toISOString(),
        kind: 'task.created',
        nodeId: 'node_test',
        sessionId: 'sess_test',
        payload: { note: 'x' },
    };
}

/**
 * Wrap a real handle so `log(topic).append()` throws SYNCHRONOUSLY, exactly as
 * the library does for its one surviving static-misuse case. Everything else —
 * `topics`, `defineTopic`, `writerId` — stays real, so `ensureTopic` and the
 * size pre-flight run their genuine code paths and the throw lands precisely
 * where the production one does.
 */
function withSyncThrowingAppend(handle: SeqscribeNodeHandle): SeqscribeNodeHandle {
    return {
        ...handle,
        node: {
            ...handle.node,
            log: (_topic: string) => ({
                append: (): Promise<string> => {
                    throw new Error('raw append on register topic — static API misuse');
                },
            }),
        } as SeqscribeNodeHandle['node'],
    };
}

/** Wrap a handle so appends never settle — slots stay held until we release. */
function withPendingAppend(handle: SeqscribeNodeHandle): {
    handle: SeqscribeNodeHandle;
    settleAll: () => void;
} {
    const resolvers: Array<() => void> = [];
    const wrapped: SeqscribeNodeHandle = {
        ...handle,
        node: {
            ...handle.node,
            log: (_topic: string) => ({
                append: (): Promise<string> =>
                    new Promise<string>((resolve) => {
                        resolvers.push(() => resolve('entry_id'));
                    }),
            }),
        } as SeqscribeNodeHandle['node'],
    };
    return {
        handle: wrapped,
        settleAll: () => {
            for (const r of resolvers.splice(0)) r();
        },
    };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Poll until a predicate holds. The append does real SQLite I/O, so a
 * microtask flush alone does not settle it — waiting on the observable
 * outcome is what the pre-existing suites do too.
 */
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
    for (const handle of handles.splice(0)) {
        try {
            await handle.close();
        } catch {
            /* noop */
        }
    }
    for (const dir of tmpDirs.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* noop */
        }
    }
});

// ─── Defect A — synchronous throw must not leak an in-flight slot ───────────

describe('mesh dual-write in-flight accounting — synchronous append throw', () => {
    it('returns the slot when append throws synchronously', () => {
        const real = openNode('leak-one', ['mesh_a']);
        configureMeshDualWrite(withSyncThrowingAppend(real), {
            ADHDEV_SEQSCRIBE_MESH: 'shadow',
        });

        recordMeshEventShadow('mesh_a', entry('e1'));

        expect(meshDualWriteCounters().failed).toBe(1);
        // The throw is counted as a failure AND the slot is released. Leaving it
        // held is the leak: nothing else can ever return it.
        expect(meshDualWriteInflight()).toBe(0);
    });

    it('does not wedge the cap after many synchronous throws', () => {
        const real = openNode('leak-many', ['mesh_a']);
        configureMeshDualWrite(withSyncThrowingAppend(real), {
            ADHDEV_SEQSCRIBE_MESH: 'shadow',
        });

        // Far past the cap. With the leak, `inflight` climbs monotonically and
        // parks at MAX_INFLIGHT; every record after that is shed as "load" even
        // though nothing is actually in flight.
        for (let i = 0; i < MAX_INFLIGHT * 2; i++) {
            recordMeshEventShadow('mesh_a', entry(`e${i}`));
        }

        expect(meshDualWriteInflight()).toBe(0);
        // Every record reached the append and failed there. None was shed by a
        // cap reading a phantom backlog.
        expect(meshDualWriteCounters().dropped).toBe(0);
        expect(meshDualWriteCounters().failed).toBe(MAX_INFLIGHT * 2);
    });

    it('still admits a healthy record after a burst of synchronous throws', async () => {
        const real = openNode('leak-recover', ['mesh_a']);
        const throwing = withSyncThrowingAppend(real);
        configureMeshDualWrite(throwing, { ADHDEV_SEQSCRIBE_MESH: 'shadow' });

        for (let i = 0; i < MAX_INFLIGHT + 5; i++) {
            recordMeshEventShadow('mesh_a', entry(`bad${i}`));
        }

        // Same process, same configuration — only the node's append recovers.
        configureMeshDualWrite(real, { ADHDEV_SEQSCRIBE_MESH: 'shadow' });
        recordMeshEventShadow('mesh_a', entry('good'));
        await until(
            () => meshDualWriteCounters().written >= 1,
            'the healthy record to be written',
        );

        // With the leak the record above never reaches the topic: the counter is
        // pinned at the cap and the write is shed before it is attempted.
        expect(meshDualWriteCounters().written).toBeGreaterThanOrEqual(1);
    });
});

// ─── Defect B — reconfigure must not drive the counter negative ─────────────

describe('mesh dual-write in-flight accounting — reconfigure', () => {
    it('never goes negative when appends outlive the configuration', async () => {
        const realA = openNode('neg-a', ['mesh_a']);
        const pending = withPendingAppend(realA);
        configureMeshDualWrite(pending.handle, { ADHDEV_SEQSCRIBE_MESH: 'shadow' });

        for (let i = 0; i < 4; i++) recordMeshEventShadow('mesh_a', entry(`p${i}`));
        expect(meshDualWriteInflight()).toBe(4);

        // Reconfigure while all four are still outstanding, then let them land.
        const realB = openNode('neg-b', ['mesh_a']);
        configureMeshDualWrite(realB, { ADHDEV_SEQSCRIBE_MESH: 'shadow' });
        pending.settleAll();
        await flush();

        expect(meshDualWriteInflight()).toBeGreaterThanOrEqual(0);
    });

    it('keeps the cap bounding after a reconfigure with appends outstanding', async () => {
        const realA = openNode('neg-cap-a', ['mesh_a']);
        const pending = withPendingAppend(realA);
        configureMeshDualWrite(pending.handle, { ADHDEV_SEQSCRIBE_MESH: 'shadow' });

        for (let i = 0; i < 8; i++) recordMeshEventShadow('mesh_a', entry(`p${i}`));

        const realB = openNode('neg-cap-b', ['mesh_a']);
        const pendingB = withPendingAppend(realB);
        configureMeshDualWrite(pendingB.handle, { ADHDEV_SEQSCRIBE_MESH: 'shadow' });
        pending.settleAll();
        await flush();

        // The load-shed must still engage. With a negative baseline the counter
        // has to climb back through the deficit first, so the cap admits far
        // more than MAX_INFLIGHT concurrent appends — it stops bounding.
        for (let i = 0; i < MAX_INFLIGHT * 2; i++) {
            recordMeshEventShadow('mesh_a', entry(`q${i}`));
        }

        expect(meshDualWriteInflight()).toBeLessThanOrEqual(MAX_INFLIGHT);
        expect(meshDualWriteCounters().dropped).toBeGreaterThan(0);
    });
});
