/**
 * SETUP-ENV-CONFIG-DIR-ISOLATION
 *
 * Pins the invariant that a vitest worker NEVER resolves the daemon config/state
 * directory to the developer's real `~/.adhdev`. helpers/setup-env.ts pins
 * ADHDEV_CONFIG_DIR to a per-run mkdtemp dir UNCONDITIONALLY, because the dev
 * environment itself can export ADHDEV_CONFIG_DIR (the session-host daemon pins it
 * for every spawned child — managed-host.ts), which used to defeat the old
 * `if (!set)` guard and let mesh tests write synthetic rows into the live
 * mesh-runtime.db (2026-08-05: 870+ fixture 'delivered' turn-attempt rows).
 *
 * Note on coverage: reverting the fix (restoring the conditional guard) turns this
 * test red only in an environment where ADHDEV_CONFIG_DIR is actually leaked into
 * the test process — which is precisely the environment where the leak does damage.
 * On a clean CI runner the guard-revert is invisible here, by design.
 */
import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { getConfigDir } from '../../src/config/config.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js';

describe('setup-env config-dir isolation', () => {
    it('ADHDEV_CONFIG_DIR is pinned to a throwaway temp dir, never a live track home', () => {
        const liveHomes = [
            path.join(os.homedir(), '.adhdev'),
            path.join(os.homedir(), '.adhdev-preview'),
        ];
        expect(process.env.ADHDEV_CONFIG_DIR).toBeTruthy();
        const pinned = path.resolve(process.env.ADHDEV_CONFIG_DIR!);
        const resolved = path.resolve(getConfigDir());
        for (const live of liveHomes) {
            expect(pinned).not.toBe(path.resolve(live));
            expect(resolved).not.toBe(path.resolve(live));
            expect(getLedgerDir()).not.toBe(path.join(live, 'mesh-ledger'));
        }
    });
});
