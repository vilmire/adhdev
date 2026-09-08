import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    configureFleetStatusShadow,
    recordFleetStatusShadow,
    fleetStatusCounters,
    fleetStatusInflight,
    MAX_INFLIGHT,
    __resetFleetStatusShadowForTests,
} from '../../src/seqscribe/fleet-status-shadow.js';
import { fleetStatusEntry, type FleetStatusEntry } from '../../src/status/reporter.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';

/**
 * In-flight accounting for the `fleet.status` shadow leg.
 *
 * The mirror of `mesh-dual-write-inflight.test.ts`. The two legs hand-roll the
 * same fire-and-forget accounting, so they had the same two defects, and the
 * fix has to hold on both or the next reader will "fix" one and leave the other:
 *
 *   A. LEAK — a synchronous throw out of `append` (P11 §11.1 static misuse) left
 *      the slot held forever, because neither settle handler runs on that path.
 *      Repeated, `inflight` parks at the cap and the leg drops every subsequent
 *      status record permanently while the topic is perfectly healthy.
 *   B. NEGATIVE — `configureFleetStatusShadow` zeroed the counter with appends
 *      still outstanding; their later settles decremented past zero, and a
 *      negative baseline puts `>= MAX_INFLIGHT` out of reach entirely.
 */

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-fleet-inflight-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: {},
        storedFleetSecret: null,
        daemonId: 'daemon_mach_test',
    });
    handles.push(handle);
    return handle;
}

function entry(): FleetStatusEntry {
    return fleetStatusEntry({
        daemonId: 'daemon_mach_test',
        sessions: [],
        onlineState: 'online',
        p2pActive: true,
        timestamp: 1_700_000_000_000,
    } as any);
}

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
    __resetFleetStatusShadowForTests();
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

describe('fleet.status shadow in-flight accounting — synchronous append throw', () => {
    it('returns the slot when append throws synchronously', () => {
        const real = openNode('leak-one');
        configureFleetStatusShadow(withSyncThrowingAppend(real), {
            ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow',
        });

        expect(recordFleetStatusShadow(entry())).toBe(false);
        expect(fleetStatusCounters().failed).toBe(1);
        expect(fleetStatusInflight()).toBe(0);
    });

    it('does not wedge the cap after many synchronous throws', () => {
        const real = openNode('leak-many');
        configureFleetStatusShadow(withSyncThrowingAppend(real), {
            ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow',
        });

        for (let i = 0; i < MAX_INFLIGHT * 2; i++) recordFleetStatusShadow(entry());

        expect(fleetStatusInflight()).toBe(0);
        expect(fleetStatusCounters().dropped).toBe(0);
        expect(fleetStatusCounters().failed).toBe(MAX_INFLIGHT * 2);
    });

    it('still admits a healthy record after a burst of synchronous throws', async () => {
        const real = openNode('leak-recover');
        configureFleetStatusShadow(withSyncThrowingAppend(real), {
            ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow',
        });

        for (let i = 0; i < MAX_INFLIGHT + 5; i++) recordFleetStatusShadow(entry());

        configureFleetStatusShadow(real, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        expect(recordFleetStatusShadow(entry())).toBe(true);
        await until(() => fleetStatusCounters().written >= 1, 'the healthy record to be written');

        expect(fleetStatusCounters().written).toBeGreaterThanOrEqual(1);
    });
});

// ─── Defect B — reconfigure must not drive the counter negative ─────────────

describe('fleet.status shadow in-flight accounting — reconfigure', () => {
    it('never goes negative when appends outlive the configuration', async () => {
        const realA = openNode('neg-a');
        const pending = withPendingAppend(realA);
        configureFleetStatusShadow(pending.handle, {
            ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow',
        });

        for (let i = 0; i < 4; i++) recordFleetStatusShadow(entry());
        expect(fleetStatusInflight()).toBe(4);

        const realB = openNode('neg-b');
        configureFleetStatusShadow(realB, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        pending.settleAll();
        await flush();

        expect(fleetStatusInflight()).toBeGreaterThanOrEqual(0);
    });

    it('keeps the cap bounding after a reconfigure with appends outstanding', async () => {
        const realA = openNode('neg-cap-a');
        const pending = withPendingAppend(realA);
        configureFleetStatusShadow(pending.handle, {
            ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow',
        });

        for (let i = 0; i < 8; i++) recordFleetStatusShadow(entry());

        const realB = openNode('neg-cap-b');
        const pendingB = withPendingAppend(realB);
        configureFleetStatusShadow(pendingB.handle, {
            ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow',
        });
        pending.settleAll();
        await flush();

        for (let i = 0; i < MAX_INFLIGHT * 2; i++) recordFleetStatusShadow(entry());

        expect(fleetStatusInflight()).toBeLessThanOrEqual(MAX_INFLIGHT);
        expect(fleetStatusCounters().dropped).toBeGreaterThan(0);
    });
});
