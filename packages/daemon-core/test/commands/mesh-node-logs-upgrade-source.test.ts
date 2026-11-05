import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const paths = vi.hoisted(() => ({ upgradeLog: '' }));
vi.mock('../../src/commands/upgrade-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/commands/upgrade-log.js')>()),
  getUpgradeLogPath: () => paths.upgradeLog,
}));

import { meshNodeLogsHandlers } from '../../src/commands/low-family/mesh-node-logs.js';

const ctx = { deps: { statusInstanceId: 'daemon_self' } } as any;

describe('get_mesh_node_logs source=upgrade', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-log-'));
    paths.upgradeLog = path.join(dir, 'daemon-upgrade.log');
    fs.writeFileSync(paths.upgradeLog, [
      '[2026-11-05T05:49:40.782Z] Upgrade helper started',
      '[2026-11-05T06:35:50.000Z] Installed with token adk_abcdefghijklmnopqrstuvwxyz012345',
      '',
    ].join('\n'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the helper trace from the file the daemon chose', async () => {
    const result: any = await meshNodeLogsHandlers.get_mesh_node_logs(ctx, { source: 'upgrade', date: '2020-01-01' });
    expect(result.success).toBe(true);
    expect(result.logPath).toBe(paths.upgradeLog);
    expect(result.lines[0]).toContain('Upgrade helper started');
  });

  it('redacts secrets like the daemon log', async () => {
    const result: any = await meshNodeLogsHandlers.get_mesh_node_logs(ctx, { source: 'upgrade' });
    expect(result.lines.join('\n')).not.toContain('adk_abcdefghijklmnopqrstuvwxyz012345');
  });

  it('applies sinceMs to the UTC timestamps in the file', async () => {
    const result: any = await meshNodeLogsHandlers.get_mesh_node_logs(ctx, {
      source: 'upgrade',
      sinceMs: Date.parse('2026-11-05T06:00:00.000Z'),
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain('06:35:50');
  });

  it('refuses any other source, and takes no path from the caller', async () => {
    const result: any = await meshNodeLogsHandlers.get_mesh_node_logs(ctx, { source: '/etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unknown log source');
    const ignored: any = await meshNodeLogsHandlers.get_mesh_node_logs(ctx, { source: 'upgrade', filePath: '/etc/passwd' });
    expect(ignored.logPath).toBe(paths.upgradeLog);
  });
});
