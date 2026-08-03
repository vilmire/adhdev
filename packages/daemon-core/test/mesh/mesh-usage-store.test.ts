/**
 * Mesh usage store — keyed upsert, bounded growth, and mesh aggregation.
 *
 * The store's reason for existing is that usage must NOT go in the mesh
 * ledger (30-day prune + rotation under a 150k-entry load). The properties
 * pinned here are the ones that justify that choice:
 *   - upsert keyed by session ⇒ size is O(sessions), not O(turns)
 *   - eviction folds into a rollup ⇒ the mesh total never silently shrinks
 *   - aggregation reports cost coverage ⇒ a partial cost is never read as complete
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUsageTotals } from '../../src/providers/native-history/usage-normalize.js';

// The store writes under getConfigDir(), which test/helpers/setup-env.ts
// already isolates to a per-run tmp dir via ADHDEV_CONFIG_DIR. Do NOT reassign
// that env var here: setup-env runs after this module's top level, so an
// override set at import time is replaced before the first test and writes
// would land in one directory while reads resolved another.
const {
    recordSessionUsage,
    readSessionUsage,
    summarizeMeshUsage,
    getUsageDir,
    MAX_SESSIONS_PER_MESH,
    USAGE_MAX_AGE_MS,
} = await import('../../src/mesh/mesh-usage-store.js');

const MESH = 'mesh-test';

// Default the fixture's usage timestamp to NOW. A fixed small epoch (e.g.
// 1_000_000 ≈ Jan 1970) is older than USAGE_MAX_AGE_MS, so every record would
// be aged straight into the evicted rollup and the retained set would read
// empty — the age bound doing exactly its job against an unrealistic fixture.
function totals(fields: Partial<SessionUsageTotals> & { providerSessionId: string }): SessionUsageTotals {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        agent: 'test-cli',
        recordCount: 1,
        lastUsageAt: Date.now(),
        ...fields,
    };
}

/**
 * Own this file's config-dir isolation rather than inheriting it.
 *
 * `setup-env.ts` points ADHDEV_CONFIG_DIR at a per-run tmp dir, but only when
 * the var is unset, and several sibling suites legitimately `delete` it while
 * exercising the unset-env path (config-dir, provider-loader, chat-history,
 * loader-integration, …). Vitest reuses worker processes, so a file that ran
 * after one of those deletes inherits an *unset* var — and this store then
 * resolves getUsageDir() to the developer's real ~/.adhdev, where it both
 * writes test data outside the sandbox and `rmSync`s a real directory.
 * Observed before this guard: a "2 sessions" assertion receiving 1641 from
 * state accumulated across runs, and ENOENT on rename when a parallel worker
 * removed the shared dir mid-write.
 *
 * Assigning per test (not at import time) is what makes this safe: setup-env
 * runs after this module's top level, so an import-time override would be
 * replaced before the first test — the hazard the note above warns about.
 */
let usageConfigDir = '';
const previousConfigDir = process.env.ADHDEV_CONFIG_DIR;

beforeEach(() => {
    usageConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-usage-store-test-'));
    process.env.ADHDEV_CONFIG_DIR = usageConfigDir;
    try { fs.rmSync(getUsageDir(), { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
    try { fs.rmSync(usageConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterAll(() => {
    try { fs.rmSync(getUsageDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    // Hand the env back exactly as found: this file overrides it per test, and
    // leaking that override would make sibling suites depend on our temp dir.
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
});

describe('recordSessionUsage', () => {
    it('upserts by session id instead of appending', () => {
        // The core bound: re-recording a live session's growing totals must
        // replace the entry, so the file stays O(sessions) not O(turns).
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', inputTokens: 100 }));
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', inputTokens: 250 }));
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', inputTokens: 400 }));

        const stored = readSessionUsage(MESH);
        expect(stored).toHaveLength(1);
        expect(stored[0].inputTokens).toBe(400);
    });

    it('keeps distinct sessions separate and attaches mesh context', () => {
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', inputTokens: 100 }), { nodeId: 'node-a', taskId: 't1' });
        recordSessionUsage(MESH, totals({ providerSessionId: 's2', inputTokens: 200 }), { nodeId: 'node-b' });

        const stored = readSessionUsage(MESH);
        expect(stored).toHaveLength(2);
        const s1 = stored.find((s) => s.providerSessionId === 's1')!;
        expect(s1.nodeId).toBe('node-a');
        expect(s1.taskId).toBe('t1');
    });

    it('isolates meshes from each other', () => {
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', inputTokens: 100 }));
        recordSessionUsage('other-mesh', totals({ providerSessionId: 's2', inputTokens: 999 }));

        expect(readSessionUsage(MESH)).toHaveLength(1);
        expect(summarizeMeshUsage(MESH).total.inputTokens).toBe(100);
        expect(summarizeMeshUsage('other-mesh').total.inputTokens).toBe(999);
    });

    it('survives a corrupt store file instead of throwing', () => {
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', inputTokens: 100 }));
        const file = path.join(getUsageDir(), `${MESH}.json`);
        fs.writeFileSync(file, '{ this is not json', 'utf-8');

        // Usage is derived data — a corrupt file rebuilds rather than failing
        // the caller.
        expect(() => readSessionUsage(MESH)).not.toThrow();
        expect(readSessionUsage(MESH)).toEqual([]);
        recordSessionUsage(MESH, totals({ providerSessionId: 's2', inputTokens: 5 }));
        expect(readSessionUsage(MESH)).toHaveLength(1);
    });
});

describe('bounded growth', () => {
    it('evicts the oldest sessions past the cap and folds them into the rollup', () => {
        const now = 2_000_000_000_000;
        const overflow = 5;
        const total = MAX_SESSIONS_PER_MESH + overflow;

        // Seed everything below the cap straight to disk, and drive only the
        // overflow writes through the API.
        //
        // Going through recordSessionUsage for all 2005 would not test anything
        // extra — the first 2000 writes are under the cap, so they exercise the
        // upsert path already covered above, not eviction. What they DO cost is
        // 2005 sequential atomic whole-file writes: the store rewrites the
        // entire file on every key update, so the run is quadratic. Measured
        // floor for that write pattern alone, with zero store logic, is ~49s —
        // above the 30s budget no matter how fast the implementation gets.
        // Seeding keeps the assertions identical while leaving the eviction
        // transition itself (crossing the cap) genuinely driven by the API.
        const seeded = MAX_SESSIONS_PER_MESH - 1;
        const sessions: Record<string, unknown> = {};
        for (let i = 0; i < seeded; i += 1) {
            sessions[`s${i}`] = {
                ...totals({ providerSessionId: `s${i}`, inputTokens: 10, lastUsageAt: now - (total - i) * 1000 }),
                updatedAt: now,
            };
        }
        fs.mkdirSync(getUsageDir(), { recursive: true });
        fs.writeFileSync(
            path.join(getUsageDir(), `${MESH}.json`),
            JSON.stringify({ version: 1, meshId: MESH, sessions }),
            'utf-8',
        );

        // These cross the cap, so eviction runs on the real code path.
        for (let i = seeded; i < total; i += 1) {
            recordSessionUsage(
                MESH,
                totals({ providerSessionId: `s${i}`, inputTokens: 10, lastUsageAt: now - (total - i) * 1000 }),
                undefined,
                now,
            );
        }

        const stored = readSessionUsage(MESH);
        expect(stored).toHaveLength(MAX_SESSIONS_PER_MESH);
        // Oldest went first.
        expect(stored.some((s) => s.providerSessionId === 's0')).toBe(false);

        const summary = summarizeMeshUsage(MESH);
        expect(summary.evicted?.sessionCount).toBe(overflow);
        // The headline total still covers every session ever recorded.
        expect(summary.total.inputTokens).toBe((MAX_SESSIONS_PER_MESH + overflow) * 10);
        expect(summary.retained.inputTokens).toBe(MAX_SESSIONS_PER_MESH * 10);
    });

    it('ages out stale sessions into the rollup without losing their totals', () => {
        const now = 2_000_000_000_000;
        recordSessionUsage(MESH, totals({ providerSessionId: 'old', inputTokens: 70, lastUsageAt: now - USAGE_MAX_AGE_MS - 1 }), undefined, now);
        recordSessionUsage(MESH, totals({ providerSessionId: 'fresh', inputTokens: 30, lastUsageAt: now }), undefined, now);

        const stored = readSessionUsage(MESH);
        expect(stored.map((s) => s.providerSessionId)).toEqual(['fresh']);

        const summary = summarizeMeshUsage(MESH);
        expect(summary.retained.inputTokens).toBe(30);
        expect(summary.total.inputTokens).toBe(100);
    });
});

describe('summarizeMeshUsage', () => {
    it('breaks usage down per node, newest usage first', () => {
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', outputTokens: 10 }), { nodeId: 'node-a' });
        recordSessionUsage(MESH, totals({ providerSessionId: 's2', outputTokens: 30 }), { nodeId: 'node-b' });
        recordSessionUsage(MESH, totals({ providerSessionId: 's3', outputTokens: 5 }), { nodeId: 'node-a' });

        const summary = summarizeMeshUsage(MESH);
        expect(summary.byNode.map((n) => n.nodeId)).toEqual(['node-b', 'node-a']);
        expect(summary.byNode.find((n) => n.nodeId === 'node-a')!.outputTokens).toBe(15);
        expect(summary.byNode.find((n) => n.nodeId === 'node-a')!.sessionCount).toBe(2);
    });

    it('buckets sessions with no node under "unassigned"', () => {
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', outputTokens: 10 }));
        expect(summarizeMeshUsage(MESH).byNode[0].nodeId).toBe('unassigned');
    });

    it('reports partial cost coverage', () => {
        recordSessionUsage(MESH, totals({ providerSessionId: 's1', costUsd: 1.5 }));
        recordSessionUsage(MESH, totals({ providerSessionId: 's2' }));

        const summary = summarizeMeshUsage(MESH);
        expect(summary.costCoverage).toEqual({ withCost: 1, total: 2 });
        expect(summary.total.costUsd).toBeCloseTo(1.5);
    });

    it('returns a zeroed summary for a mesh with no usage', () => {
        const summary = summarizeMeshUsage('never-used');
        expect(summary.total.inputTokens).toBe(0);
        expect(summary.retained.sessionCount).toBe(0);
        expect(summary.byNode).toEqual([]);
        expect(summary.evicted).toBeUndefined();
    });
});
