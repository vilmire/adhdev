import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    runMeshParityCheck,
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
