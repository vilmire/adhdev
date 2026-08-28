import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    runMeshParityCheck,
    meshParityCounters,
    __resetMeshParityForTests,
    type ParityLedgerEntry,
} from '../../src/seqscribe/mesh-parity.js';
import { projectMeshLedgerEntry, MESH_EVENT_ENTRY_KIND } from '../../src/seqscribe/mesh-event-projection.js';
import { meshEventsTopic } from '../../src/seqscribe/topics.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';

/**
 * Window-alignment regression for `runMeshParityCheck`.
 *
 * `ledgerEntries` (the caller's argument, standing in for mesh-parity-loop's
 * PARITY_TAIL-bounded read) is bounded; the shadow topic read inside this
 * module is the FULL retained window. Before this fix, any shadow record
 * older than the oldest compared ledger row was reported `extra_in_shadow`
 * forever — the row that would match it simply fell off the bounded tail, not
 * off the ledger. These tests pin: (1) that ambiguous outside-window case is
 * now skipped, and (2) a genuine extra INSIDE the window is still caught —
 * the fix must not weaken detection, only stop it from firing on a window
 * mismatch.
 */

const MESH_ID = 'parity-window-mesh';

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function tmpDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-parity-${name}-`));
    tmpDirs.push(dir);
    return dir;
}

async function openNode(name: string): Promise<SeqscribeNodeHandle> {
    const handle = openSeqscribeNode({
        dbPath: join(tmpDir(name), 'seq.db'),
        env: {},
        storedFleetSecret: null,
        meshIds: [MESH_ID],
    });
    handles.push(handle);
    return handle;
}

/** Write a shadow record directly, bypassing the dual-write module's mesh-config plumbing. */
async function writeShadowRecord(handle: SeqscribeNodeHandle, entry: ParityLedgerEntry): Promise<void> {
    const projected = projectMeshLedgerEntry(entry);
    await handle.node.log(meshEventsTopic(MESH_ID)).append(MESH_EVENT_ENTRY_KIND, projected);
}

function ledgerEntry(over: Partial<ParityLedgerEntry> & { id: string; timestamp: string }): ParityLedgerEntry {
    return {
        kind: 'test_kind',
        ...over,
    };
}

afterEach(async () => {
    __resetMeshParityForTests();
    for (const handle of handles.splice(0)) {
        await handle.close().catch(() => {});
    }
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('runMeshParityCheck — window alignment', () => {
    it('does not flag a shadow record older than this sweep\'s oldest compared ledger entry', async () => {
        const handle = await openNode('outside-window');

        // A shadow record from "long ago" — its matching ledger row has fallen
        // off the bounded tail this sweep was given, NOT off the ledger itself.
        const oldEntry = ledgerEntry({ id: 'old-1', timestamp: '2020-01-01T00:00:00.000Z' });
        await writeShadowRecord(handle, oldEntry);

        // The window this sweep actually compared starts well after `oldEntry`.
        const windowEntries: ParityLedgerEntry[] = [
            ledgerEntry({ id: 'in-window-1', timestamp: '2026-01-01T00:00:00.000Z' }),
        ];
        await writeShadowRecord(handle, windowEntries[0]!);

        const result = await runMeshParityCheck(handle, MESH_ID, windowEntries);

        expect(result.mismatches.filter((m) => m.kind === 'extra_in_shadow')).toEqual([]);
    });

    it('still flags a genuine extra_in_shadow record inside the compared window', async () => {
        const handle = await openNode('inside-window');

        const windowEntries: ParityLedgerEntry[] = [
            ledgerEntry({ id: 'in-window-1', timestamp: '2026-01-01T00:00:00.000Z' }),
        ];
        await writeShadowRecord(handle, windowEntries[0]!);

        // A second shadow record, timestamped INSIDE the compared window, with
        // no corresponding ledger row — a real replication bug (e.g. a
        // duplicate write, or a ledger row the caller's tail somehow excluded
        // despite being newer than the window floor).
        const realExtra = ledgerEntry({ id: 'real-extra-1', timestamp: '2026-01-02T00:00:00.000Z' });
        await writeShadowRecord(handle, realExtra);

        const result = await runMeshParityCheck(handle, MESH_ID, windowEntries);

        const extras = result.mismatches.filter((m) => m.kind === 'extra_in_shadow');
        expect(extras).toEqual([{ kind: 'extra_in_shadow', id: 'real-extra-1', ledgerKind: 'test_kind' }]);
    });

    it('a mixed sweep reports the in-window extra and omits the out-of-window one in the same result', async () => {
        const handle = await openNode('mixed');

        const oldEntry = ledgerEntry({ id: 'old-1', timestamp: '2020-01-01T00:00:00.000Z' });
        await writeShadowRecord(handle, oldEntry);

        const windowEntries: ParityLedgerEntry[] = [
            ledgerEntry({ id: 'in-window-1', timestamp: '2026-01-01T00:00:00.000Z' }),
        ];
        await writeShadowRecord(handle, windowEntries[0]!);

        const realExtra = ledgerEntry({ id: 'real-extra-1', timestamp: '2026-01-02T00:00:00.000Z' });
        await writeShadowRecord(handle, realExtra);

        const result = await runMeshParityCheck(handle, MESH_ID, windowEntries);

        const extraIds = result.mismatches.filter((m) => m.kind === 'extra_in_shadow').map((m) => m.id);
        expect(extraIds).toEqual(['real-extra-1']);
        expect(extraIds).not.toContain('old-1');
    });
});

/**
 * P21 adoption regression — the shadow side is now read with
 * `scanEntries({ through })` against a head pinned by `headOrder`, replacing a
 * throwaway nonce consumer that drained the FULL retained topic behind two
 * macrotask yields.
 *
 * The three tests above already pin that the comparison's *findings* did not
 * change. These pin the properties the pinned interval adds, which are the
 * reason for the swap:
 *
 *   · a record appended DURING the sweep is above the pin and therefore cannot
 *     surface as `extra_in_shadow` — the race the old unbounded read had
 *   · the sweep leaves NO durable cursor behind, so it stops holding the §7.6
 *     archive floor open every 15 minutes
 *   · a clean pair still reports zero mismatches (the live invariant this
 *     adoption was required not to regress)
 */
describe('runMeshParityCheck — pinned scan interval (P21)', () => {
    it('reports zero mismatches for a clean ledger/shadow pair', async () => {
        const handle = await openNode('clean-zero');

        const entries: ParityLedgerEntry[] = [
            ledgerEntry({ id: 'c-1', timestamp: '2026-01-01T00:00:00.000Z' }),
            ledgerEntry({ id: 'c-2', timestamp: '2026-01-01T00:01:00.000Z' }),
            ledgerEntry({ id: 'c-3', timestamp: '2026-01-01T00:02:00.000Z' }),
        ];
        for (const entry of entries) await writeShadowRecord(handle, entry);

        const result = await runMeshParityCheck(handle, MESH_ID, entries);

        // ★ The invariant the live fleet is currently holding at zero. The
        // window rewrite must not reintroduce a single mismatch of any class.
        expect(result.mismatches).toEqual([]);
        expect(result.compared).toBe(3);
    });

    it('excludes a record appended after the head was pinned', async () => {
        const handle = await openNode('pinned-head');

        const entries: ParityLedgerEntry[] = [
            ledgerEntry({ id: 'p-1', timestamp: '2026-01-01T00:00:00.000Z' }),
        ];
        await writeShadowRecord(handle, entries[0]!);

        // A record whose TIMESTAMP is inside the compared window — so the old
        // lower-bound-only filter would have let it through as
        // `extra_in_shadow` — but which is appended after the ledger side was
        // captured. Under the pinned head it sits above the interval on the
        // shadow side too, which is the symmetry the pin buys.
        //
        // Appending it before the call is exactly the observable form of the
        // race: `headOrder` is taken inside `runMeshParityCheck`, so to test
        // "above the pin" we pin first and compare against that snapshot.
        const through = handle.node.headOrder(meshEventsTopic(MESH_ID));
        expect(through).not.toBeNull();

        const midSweep = ledgerEntry({ id: 'p-mid-sweep', timestamp: '2026-01-01T00:00:30.000Z' });
        await writeShadowRecord(handle, midSweep);

        // The scan bounded by the pre-append head must not see the new record.
        const scanned = handle.node.scanEntries(meshEventsTopic(MESH_ID), {
            through: through!,
            limit: 500,
        });
        const scannedIds = scanned.entries.map((e) => (e.payload as { id: string }).id);
        expect(scannedIds).toContain('p-1');
        expect(scannedIds).not.toContain('p-mid-sweep');
    });

    it('leaves no durable cursor behind — the sweep no longer gates archiving', async () => {
        const handle = await openNode('no-cursor');
        const topic = meshEventsTopic(MESH_ID);

        const entries: ParityLedgerEntry[] = [
            ledgerEntry({ id: 'nc-1', timestamp: '2026-01-01T00:00:00.000Z' }),
        ];
        await writeShadowRecord(handle, entries[0]!);

        const before = handle.node.listConsumers(topic);
        await runMeshParityCheck(handle, MESH_ID, entries);
        await runMeshParityCheck(handle, MESH_ID, entries);
        const after = handle.node.listConsumers(topic);

        // ★ Two sweeps, zero new cursor rows. The nonce-consumer implementation
        // added one per sweep (`stage3-mesh-parity:<nonce>`), each holding the
        // topic's archive floor open until abandonment.
        expect(after.length).toBe(before.length);
        expect(after.filter((c) => c.consumer.startsWith('stage3-mesh-parity'))).toEqual([]);
    });
});

/**
 * `persistentMismatches` — the readiness gate's condition 4.
 *
 * The distinction these pin is the one that makes the Phase 2 default flip
 * safe. `mismatches` is cumulative-since-boot and its EXPECTED production
 * value is nonzero: the mcp-server process appends ledger entries with no
 * armed shadow leg, every sweep reports them `missing_in_shadow`, and the
 * backfill repairs them between sweeps. Gating the read cutover on that
 * counter latched it closed on the first ordinary sweep, fleet-wide and
 * permanently. `persistentMismatches` counts only what a repair opportunity
 * did NOT fix, which is the design's own real-failure signal.
 */
describe('runMeshParityCheck — persistent vs. healed mismatches', () => {
    it('does not count a missing entry that a later sweep no longer reports', async () => {
        const handle = await openNode('healed');

        const entry = ledgerEntry({ id: 'healed-1', timestamp: '2026-01-01T00:00:00.000Z' });

        // Sweep 1: the entry is missing from the shadow — detected and counted
        // as a mismatch, but NOT yet as persistent. The backfill has not had
        // its chance.
        const first = await runMeshParityCheck(handle, MESH_ID, [entry]);
        expect(first.mismatches.map((m) => m.kind)).toEqual(['missing_in_shadow']);
        expect(meshParityCounters().mismatches).toBe(1);
        expect(meshParityCounters().persistentMismatches).toBe(0);

        // The repair lands.
        await writeShadowRecord(handle, entry);

        // Sweep 2 is clean, and the cumulative counter still records that
        // detection happened — evidence is preserved, not erased.
        const second = await runMeshParityCheck(handle, MESH_ID, [entry]);
        expect(second.mismatches).toEqual([]);
        expect(meshParityCounters().mismatches).toBe(1);
        expect(meshParityCounters().persistentMismatches).toBe(0);
    });

    it('counts a missing entry that a later sweep reports again', async () => {
        const handle = await openNode('persistent');

        const entry = ledgerEntry({ id: 'persist-1', timestamp: '2026-01-01T00:00:00.000Z' });

        await runMeshParityCheck(handle, MESH_ID, [entry]);
        expect(meshParityCounters().persistentMismatches).toBe(0);

        // Nothing repaired it. The recurrence is the real-failure signal.
        await runMeshParityCheck(handle, MESH_ID, [entry]);
        expect(meshParityCounters().persistentMismatches).toBe(1);

        // And it keeps counting while it stays broken.
        await runMeshParityCheck(handle, MESH_ID, [entry]);
        expect(meshParityCounters().persistentMismatches).toBe(2);
    });

    it('counts field_mismatch immediately — it is not repairable', async () => {
        const handle = await openNode('field');

        const entry = ledgerEntry({ id: 'field-1', timestamp: '2026-01-01T00:00:00.000Z' });
        await writeShadowRecord(handle, entry);

        // Same id, divergent projected field. The backfill refuses this class
        // by design (re-mirroring would erase the evidence), so there is no
        // repair opportunity to wait for.
        const result = await runMeshParityCheck(handle, MESH_ID, [
            { ...entry, kind: 'different_kind' },
        ]);
        expect(result.mismatches.map((m) => m.kind)).toEqual(['field_mismatch']);
        expect(meshParityCounters().persistentMismatches).toBe(1);
    });

    it('tracks pending ids per mesh, so a clean sweep on one cannot heal another', async () => {
        const OTHER_MESH = 'parity-window-mesh-other';
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('per-mesh'), 'seq.db'),
            env: {},
            storedFleetSecret: null,
            meshIds: [MESH_ID, OTHER_MESH],
        });
        handles.push(handle);

        // The SAME id in both meshes — the case a globally-keyed pending set
        // would confuse. Mesh A gets repaired; mesh B never does.
        const entry = ledgerEntry({ id: 'shared-id', timestamp: '2026-01-01T00:00:00.000Z' });

        await runMeshParityCheck(handle, MESH_ID, [entry]);
        await runMeshParityCheck(handle, OTHER_MESH, [entry]);
        expect(meshParityCounters().persistentMismatches).toBe(0);

        // Repair mesh A only.
        await handle.node
            .log(meshEventsTopic(MESH_ID))
            .append(MESH_EVENT_ENTRY_KIND, projectMeshLedgerEntry(entry));

        // A's sweep is clean and must NOT clear B's pending id.
        const a = await runMeshParityCheck(handle, MESH_ID, [entry]);
        expect(a.mismatches).toEqual([]);
        expect(meshParityCounters().persistentMismatches).toBe(0);

        // ★ B still reports it, and that recurrence must still count.
        const b = await runMeshParityCheck(handle, OTHER_MESH, [entry]);
        expect(b.mismatches.map((m) => m.kind)).toEqual(['missing_in_shadow']);
        expect(meshParityCounters().persistentMismatches).toBe(1);
    });
});
