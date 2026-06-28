import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMagiPanel, listMagiPanels, upsertMagiPanel, removeMagiPanel } from '@adhdev/daemon-core';

// Isolate the machine-local config dir so panel CRUD never touches a real
// ~/.adhdev/meshes.json. getConfigDir() reads ADHDEV_CONFIG_DIR at call time.
function withTempConfigDir<T>(fn: () => T): T {
    const prev = process.env.ADHDEV_CONFIG_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'magi-panels-'));
    process.env.ADHDEV_CONFIG_DIR = dir;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prev;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test('upsertMagiPanel persists and getMagiPanel reads it back, normalized', () => {
    withTempConfigDir(() => {
        const saved = upsertMagiPanel('design-review', {
            description: 'three machines',
            members: [
                { nodeId: 'win32-main', provider: '  claude-cli  ' },
                { provider: 'codex-cli', capabilityTags: ['os=darwin', 'os=darwin'], n: 2 },
            ],
            defaultN: 1,
        });
        assert.equal(saved.members.length, 2);
        // provider trimmed; duplicate tags deduped; dedupExempt defaulted true.
        assert.equal(saved.members[0].provider, 'claude-cli');
        assert.deepEqual(saved.members[1].capabilityTags, ['os=darwin']);
        assert.equal(saved.members[1].n, 2);
        assert.equal(saved.dedupExempt, true);

        const got = getMagiPanel('design-review');
        assert.ok(got);
        assert.equal(got!.members[0].nodeId, 'win32-main');
    });
});

test('upsertMagiPanel refuses to clobber without overwrite, allows with overwrite', () => {
    withTempConfigDir(() => {
        upsertMagiPanel('p', { members: [{ provider: 'claude-cli' }] });
        assert.throws(() => upsertMagiPanel('p', { members: [{ provider: 'codex-cli' }] }), /magi_panel_exists/);
        const replaced = upsertMagiPanel('p', { members: [{ provider: 'codex-cli' }] }, { overwrite: true });
        assert.equal(replaced.members[0].provider, 'codex-cli');
    });
});

test('upsertMagiPanel rejects invalid configs', () => {
    withTempConfigDir(() => {
        assert.throws(() => upsertMagiPanel('x', { members: [] }), /invalid_magi_panel/);
        assert.throws(() => upsertMagiPanel('x', { members: [{}] }), /provider is required/);
        assert.throws(() => upsertMagiPanel('', { members: [{ provider: 'claude-cli' }] }), /panel name is required/);
    });
});

test('listMagiPanels returns all panels; removeMagiPanel deletes one', () => {
    withTempConfigDir(() => {
        upsertMagiPanel('a', { members: [{ provider: 'claude-cli' }] });
        upsertMagiPanel('b', { members: [{ provider: 'codex-cli' }] });
        const all = listMagiPanels();
        assert.deepEqual(Object.keys(all).sort(), ['a', 'b']);

        assert.equal(removeMagiPanel('a'), true);
        assert.equal(removeMagiPanel('a'), false);
        assert.equal(getMagiPanel('a'), undefined);
        assert.ok(getMagiPanel('b'));
    });
});

test('magiPanels coexists with an existing meshes.json meshes array', () => {
    withTempConfigDir(() => {
        // Panels live at the top level alongside meshes — adding a panel must not
        // disturb the meshes array (empty here, but the write path is shared).
        upsertMagiPanel('coexist', { members: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }] });
        const panel = getMagiPanel('coexist');
        assert.ok(panel);
        assert.equal(panel!.members.length, 2);
    });
});
