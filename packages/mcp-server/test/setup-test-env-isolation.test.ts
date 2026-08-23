import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { getConfigDir, getLedgerDir } from '@adhdev/daemon-core';

/**
 * Pins that mcp-server's --import setup-test-env.ts actually isolated this
 * process from the live ~/.adhdev and ~/.adhdev-preview homes. Revert-sensitive
 * against deleting the --import from package.json: without it, resolveConfigDir
 * now throws (NODE_TEST_CONTEXT + live-home pin), so this file fails loudly
 * instead of writing mesh_adopt_* rows into the live mesh-runtime.db.
 */
test('ADHDEV_CONFIG_DIR is a throwaway temp dir, never a live track home', () => {
    assert.ok(process.env.ADHDEV_CONFIG_DIR, 'setup-test-env.ts must pin ADHDEV_CONFIG_DIR');
    const pinned = resolve(process.env.ADHDEV_CONFIG_DIR);
    const resolved = resolve(getConfigDir());
    const liveHomes = [join(homedir(), '.adhdev'), join(homedir(), '.adhdev-preview')];
    for (const live of liveHomes) {
        assert.notEqual(pinned, resolve(live));
        assert.notEqual(resolved, resolve(live));
        assert.notEqual(getLedgerDir(), join(live, 'mesh-ledger'));
    }
});
