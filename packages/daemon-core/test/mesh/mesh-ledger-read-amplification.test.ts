/**
 * LEDGER-READ-AMPLIFICATION regression suite.
 *
 * Live incident (2026-08-27): the mesh ledger read cache used a 100ms TTL and was
 * invalidated on EVERY write. On a mesh whose ledger had grown to ~78.5k rows,
 * appends arrived more often than every 100ms, so the cache never survived to
 * serve a second read — each of the 16 standing read paths re-ran a full
 * `SELECT * FROM mesh_event_ledger` and re-parsed every payload. The daemon spun
 * at 100% CPU with ~40% of JS time in readLedgerEntriesOrdered + its parse
 * callback.
 *
 * The fix makes invalidation precise (appends EXTEND the cached array) so a long
 * TTL is safe, and pushes since/kind predicates into SQL on cold reads. These
 * tests pin the three properties that make that safe:
 *   (a) an append is visible on the next read WITHOUT a full rescan,
 *   (b) append order — including same-millisecond ties — is unchanged, and
 *   (c) since/kind/tail results are identical to a full-scan read.
 *
 * (b) and (c) are the ones that would silently break behaviour rather than
 * performance, so they compare against the store read directly rather than
 * against a hardcoded expectation.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-ledger-amp-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
        return testConfigDir;
    },
}));

import {
    appendLedgerEntry,
    appendRemoteLedgerEntries,
    readLedgerEntries,
    readLedgerEntriesByKind,
    getLedgerScanStats,
    __resetLedgerScanStatsForTests,
} from '../../src/mesh/mesh-ledger.js';
import type { MeshLedgerEntry, MeshLedgerKind } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mesh-ledger read amplification', () => {
    let meshId: string;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        meshId = `amp-mesh-${randomUUID().slice(0, 8)}`;
        __resetLedgerScanStatsForTests();
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    /** Seed N entries and return them in append order. */
    function seed(count: number, kind: MeshLedgerKind = 'task_dispatched'): MeshLedgerEntry[] {
        const out: MeshLedgerEntry[] = [];
        for (let i = 0; i < count; i++) {
            out.push(appendLedgerEntry(meshId, { kind, payload: { seq: i } }));
        }
        return out;
    }

    // ── (a) append is absorbed by the cache, not re-scanned ──────────────────

    it('reflects a new append without re-scanning the ledger', () => {
        seed(5);
        // Warm the cache with one full scan.
        readLedgerEntries(meshId);
        const afterWarm = getLedgerScanStats().fullScans;
        expect(afterWarm).toBeGreaterThan(0);

        const appended = appendLedgerEntry(meshId, { kind: 'task_completed', payload: { seq: 'new' } });

        // The new entry must be visible...
        const entries = readLedgerEntries(meshId);
        expect(entries.map(e => e.id)).toContain(appended.id);
        expect(entries[entries.length - 1].id).toBe(appended.id);

        // ...and reading it must NOT have cost another full scan. This is the
        // assertion that fails if the append path goes back to invalidating.
        expect(getLedgerScanStats().fullScans).toBe(afterWarm);
    });

    it('absorbs many appends without a rescan per append', () => {
        seed(3);
        readLedgerEntries(meshId);
        const baseline = getLedgerScanStats().fullScans;

        for (let i = 0; i < 25; i++) {
            appendLedgerEntry(meshId, { kind: 'task_completed', payload: { i } });
            readLedgerEntries(meshId);
        }

        // Pre-fix this was 25 additional full scans (one per append+read cycle).
        expect(getLedgerScanStats().fullScans).toBe(baseline);
        expect(readLedgerEntries(meshId)).toHaveLength(28);
    });

    it('serves a remote batch that extends the tail without a rescan', () => {
        seed(3);
        readLedgerEntries(meshId);
        const baseline = getLedgerScanStats().fullScans;

        // Remote entries timestamped in the future — they extend the tail, so the
        // cache can absorb them in place.
        const future = new Date(Date.now() + 60_000).toISOString();
        const remote: MeshLedgerEntry[] = [{
            id: randomUUID(),
            meshId,
            timestamp: future,
            kind: 'task_completed' as MeshLedgerKind,
            payload: { origin: 'remote' },
        }];
        const result = appendRemoteLedgerEntries(meshId, remote);
        expect(result.accepted).toBe(1);

        const entries = readLedgerEntries(meshId);
        expect(entries[entries.length - 1].id).toBe(remote[0].id);
        expect(getLedgerScanStats().fullScans).toBe(baseline);
    });

    it('invalidates rather than mis-ordering when a remote batch predates the tail', () => {
        seed(3);
        readLedgerEntries(meshId);
        const baseline = getLedgerScanStats().fullScans;

        // An entry authored on another node BEFORE our local tail. Splicing it onto
        // the end would put the cache out of store order, so the cache must drop.
        const past = new Date(Date.now() - 60_000).toISOString();
        const remote: MeshLedgerEntry[] = [{
            id: randomUUID(),
            meshId,
            timestamp: past,
            kind: 'task_completed' as MeshLedgerKind,
            payload: { origin: 'remote-old' },
        }];
        expect(appendRemoteLedgerEntries(meshId, remote).accepted).toBe(1);

        const entries = readLedgerEntries(meshId);
        // Re-read from the store, so the old entry sorts into its true position.
        expect(getLedgerScanStats().fullScans).toBeGreaterThan(baseline);
        expect(entries[0].id).toBe(remote[0].id);
        expect(entries).toHaveLength(4);
        // Order is non-decreasing by timestamp — the ordering contract mesh-events
        // depends on.
        const times = entries.map(e => new Date(e.timestamp).getTime());
        expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    // ── (b) order preservation, including same-millisecond ties ──────────────

    it('preserves append order for entries sharing a timestamp', () => {
        // Freeze the clock so every append lands on the same millisecond — the tie
        // case readLedgerEntriesOrdered resolves by rowid and the cache resolves by
        // push position. Both must agree.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
        try {
            const appended = seed(10, 'task_dispatched');
            const expectedOrder = appended.map(e => e.id);

            // Served from the warm cache (built incrementally by the appends).
            const cached = readLedgerEntries(meshId).map(e => e.id);
            expect(cached).toEqual(expectedOrder);

            // Same list after a forced cold read straight from the store.
            MeshRuntimeStore.resetForTests();
            const cold = readLedgerEntries(meshId).map(e => e.id);
            expect(cold).toEqual(expectedOrder);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps cached and cold reads identical after interleaved appends and reads', () => {
        const ids: string[] = [];
        for (let i = 0; i < 12; i++) {
            ids.push(appendLedgerEntry(meshId, {
                kind: (i % 2 === 0 ? 'task_dispatched' : 'task_completed') as MeshLedgerKind,
                payload: { i },
            }).id);
            readLedgerEntries(meshId); // interleave reads so the cache stays warm
        }

        const warm = readLedgerEntries(meshId).map(e => e.id);
        MeshRuntimeStore.resetForTests();
        const cold = readLedgerEntries(meshId).map(e => e.id);

        expect(warm).toEqual(ids);
        expect(cold).toEqual(ids);
    });

    // ── (c) filter equivalence: pushdown result == full-scan result ──────────

    it('returns identical results for since/kind/tail whether cached or cold', () => {
        const kinds: MeshLedgerKind[] = ['task_dispatched', 'task_completed', 'task_failed'];
        for (let i = 0; i < 30; i++) {
            appendLedgerEntry(meshId, { kind: kinds[i % kinds.length], payload: { i } });
        }

        const since = new Date(Date.now() - 60_000).toISOString();
        const cases: Array<{ name: string; run: () => MeshLedgerEntry[] }> = [
            { name: 'no opts', run: () => readLedgerEntries(meshId) },
            { name: 'kind', run: () => readLedgerEntries(meshId, { kind: ['task_completed'] }) },
            { name: 'multi-kind', run: () => readLedgerEntries(meshId, { kind: ['task_completed', 'task_failed'] }) },
            { name: 'since', run: () => readLedgerEntries(meshId, { since }) },
            { name: 'since+kind', run: () => readLedgerEntries(meshId, { since, kind: ['task_failed'] }) },
            { name: 'tail', run: () => readLedgerEntries(meshId, { tail: 7 }) },
            { name: 'kind+tail', run: () => readLedgerEntries(meshId, { kind: ['task_dispatched'], tail: 4 }) },
            { name: 'since+kind+tail', run: () => readLedgerEntries(meshId, { since, kind: ['task_completed'], tail: 3 }) },
            { name: 'byKind helper', run: () => readLedgerEntriesByKind(meshId, ['task_failed']) },
            { name: 'byKind capped', run: () => readLedgerEntriesByKind(meshId, ['task_failed'], 2) },
        ];

        // Warm cache: every read is served from the parsed array.
        const warm = cases.map(c => ({ name: c.name, ids: c.run().map(e => e.id) }));

        // Cold cache: since/kind reads take the SQL pushdown path instead.
        MeshRuntimeStore.resetForTests();
        const cold = cases.map(c => {
            // Reset per case so each one is genuinely cold and exercises pushdown.
            MeshRuntimeStore.resetForTests();
            return { name: c.name, ids: c.run().map(e => e.id) };
        });

        expect(cold).toEqual(warm);
        // Sanity: the filters actually narrowed something, so equality is not
        // trivially comparing two empty lists.
        expect(warm.find(w => w.name === 'kind')!.ids.length).toBe(10);
        expect(warm.find(w => w.name === 'tail')!.ids.length).toBe(7);
        expect(warm.find(w => w.name === 'byKind capped')!.ids.length).toBe(2);
    });

    it('applies tail AFTER the node filter, matching full-scan semantics', () => {
        // The trap `tail` pushdown would fall into: `node` is filtered in JS, after
        // the raw read. If the SQL read applied LIMIT N first, it would take the
        // last N rows of ALL nodes and only then keep the matching ones, returning
        // fewer than N even though N matching entries exist.
        const target = 'mach_target';
        for (let i = 0; i < 10; i++) {
            // Interleave nodes so any last-N-rows window is mostly the other node.
            appendLedgerEntry(meshId, { kind: 'task_dispatched', nodeId: target, payload: { i } });
            appendLedgerEntry(meshId, { kind: 'task_dispatched', nodeId: 'mach_other', payload: { i } });
        }

        const expectFive = (entries: MeshLedgerEntry[]) => {
            expect(entries).toHaveLength(5);
            expect(entries.every(e => e.nodeId === target)).toBe(true);
        };

        // Warm cache.
        expectFive(readLedgerEntries(meshId, { node: target, tail: 5 }));
        // Cold cache — the read that would take the pushdown path.
        MeshRuntimeStore.resetForTests();
        expectFive(readLedgerEntries(meshId, { node: target, tail: 5 }));
        // And with a kind filter alongside, which does push down.
        MeshRuntimeStore.resetForTests();
        expectFive(readLedgerEntries(meshId, { node: target, kind: ['task_dispatched'], tail: 5 }));
    });

    it('uses SQL pushdown instead of a full scan for a cold filtered read', () => {
        for (let i = 0; i < 20; i++) {
            appendLedgerEntry(meshId, {
                kind: (i === 0 ? 'task_failed' : 'task_dispatched') as MeshLedgerKind,
                payload: { i },
            });
        }
        MeshRuntimeStore.resetForTests();
        __resetLedgerScanStatsForTests();

        const failed = readLedgerEntriesByKind(meshId, ['task_failed']);
        expect(failed).toHaveLength(1);

        const stats = getLedgerScanStats();
        // Bounded read: one pushdown scan touching only the matching row, and no
        // full scan parsing all 20 payloads.
        expect(stats.pushdownScans).toBe(1);
        expect(stats.pushdownRows).toBe(1);
        expect(stats.fullScans).toBe(0);
    });

    it('does not let a filtered pushdown result poison the raw cache', () => {
        for (let i = 0; i < 10; i++) {
            appendLedgerEntry(meshId, {
                kind: (i % 2 === 0 ? 'task_dispatched' : 'task_completed') as MeshLedgerKind,
                payload: { i },
            });
        }
        MeshRuntimeStore.resetForTests();

        // Cold filtered read first — this one goes through SQL pushdown.
        expect(readLedgerEntriesByKind(meshId, ['task_completed'])).toHaveLength(5);
        // A subsequent unfiltered read must still see EVERY entry. If the pushdown
        // result had been cached as the raw set, this would return 5.
        expect(readLedgerEntries(meshId)).toHaveLength(10);
    });

    // ── invalidation completeness ────────────────────────────────────────────

    it('drops cached entries when the store is reset underneath it', () => {
        seed(4);
        expect(readLedgerEntries(meshId)).toHaveLength(4);

        // resetForTests swaps the whole database; the cache is keyed by meshId and
        // cannot notice on its own, so the store notifies it.
        MeshRuntimeStore.resetForTests();
        rmSync(join(testConfigDir, 'mesh-ledger'), { recursive: true, force: true });

        expect(readLedgerEntries(meshId)).toHaveLength(0);
    });
});
