import assert from 'node:assert/strict';
import test from 'node:test';

import { meshReconcileLedger } from '../src/tools/mesh-tools.js';
import { MESH_RECONCILE_LEDGER_TOOL } from '../src/tools/mesh-tool-schemas.js';

/**
 * mesh_reconcile_ledger's `import_entries` schema said "Defaults true", but the
 * IMPORT half of P2P ledger reconciliation was retired in C-W9a — the tool is
 * read-only report-only. The retirement note used to appear ONLY when
 * `import_entries === true` was passed explicitly (mesh-tools-mission.ts), so
 * a caller who never passed the flag (relying on the schema's stale "Defaults
 * true" claim) got no signal at all that nothing was ever going to import.
 * Fixed by (1) describing the flag as retired/no-op in the schema and (2)
 * always returning the retirement note, regardless of the flag's value.
 */

function buildCtx(): any {
    const commandCalls: Array<{ verb: string; args: any }> = [];
    return {
        ctx: {
            mesh: {
                id: 'mesh-reconcile-import-retired',
                name: 'Reconcile Mesh',
                repoIdentity: 'example/repo',
                policy: {},
                coordinator: {},
                nodes: [
                    // No daemonId -> reconcileNode treats it as local, avoiding any
                    // P2P/commandForNode plumbing this unit test doesn't stub.
                    { id: 'node-local', workspace: '/local/repo', policy: {}, userOverrides: {} },
                ],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            transport: {
                command: async (verb: string, args: any) => {
                    commandCalls.push({ verb, args });
                    if (verb === 'get_mesh') return { success: true, mesh: { nodes: [] } };
                    if (verb === 'get_mesh_ledger_slice') {
                        return { success: true, slice: { protocol: 'adhdev.mesh.ledger.slice.v1', entries: [] } };
                    }
                    if (verb === 'record_local') return { success: true };
                    throw new Error(`unexpected command ${verb}`);
                },
            },
        },
        commandCalls,
    };
}

test('mesh_reconcile_ledger: retirement note is present even when import_entries is OMITTED (was silent)', async () => {
    const { ctx } = buildCtx();
    const raw = await meshReconcileLedger(ctx, {});
    const res = JSON.parse(raw);

    assert.equal(res.success, true);
    assert.equal(res.importRetired, true);
    assert.match(res.note, /retired/i);
});

test('mesh_reconcile_ledger: retirement note is present when import_entries:false is passed', async () => {
    const { ctx } = buildCtx();
    const raw = await meshReconcileLedger(ctx, { import_entries: false } as any);
    const res = JSON.parse(raw);

    assert.equal(res.importRetired, true);
    assert.match(res.note, /retired/i);
});

test('mesh_reconcile_ledger: retirement note is present when import_entries:true is passed (still never imports)', async () => {
    const { ctx } = buildCtx();
    const raw = await meshReconcileLedger(ctx, { import_entries: true } as any);
    const res = JSON.parse(raw);

    assert.equal(res.importRetired, true);
    assert.match(res.note, /retired/i);
});

test('mesh_reconcile_ledger schema describes import_entries as retired/no-op, not "Defaults true"', () => {
    const desc = (MESH_RECONCILE_LEDGER_TOOL.inputSchema.properties as any).import_entries.description as string;
    assert.match(desc, /retired/i);
    assert.doesNotMatch(desc, /Defaults true/);
});
