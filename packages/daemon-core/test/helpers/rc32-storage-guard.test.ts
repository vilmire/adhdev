import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { resolveInstanceConfigDir } from '../../../session-host-core/src/instance-key.js';

import { SessionHostStorage } from '../../../session-host-daemon/src/storage.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger-paths.js';
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => process.env.ADHDEV_CONFIG_DIR }));

afterEach(() => vi.unstubAllEnvs());
it.each(['.adhdev', '.adhdev-preview'])('session-host rejects inherited live %s storage under a test runner', track => {
    vi.stubEnv('ADHDEV_CONFIG_DIR', join(userInfo().homedir, track));
    expect(() => resolveInstanceConfigDir()).toThrow(/LIVE.*test|test.*LIVE/);
    expect(() => new SessionHostStorage({ rootDir: join(userInfo().homedir, track, 'session-host', 'test') })).toThrow(/LIVE/);
    expect(() => getLedgerDir()).toThrow(/LIVE/);
});
it('explicit pure environment fixtures remain usable', () => {
    expect(resolveInstanceConfigDir({ ADHDEV_CONFIG_DIR: '/tmp/rc32-isolated' }, '/tmp/home')).toBe('/tmp/rc32-isolated');
});
