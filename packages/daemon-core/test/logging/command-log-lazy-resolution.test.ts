/**
 * The command log dir must be resolved LAZILY, not frozen at module import.
 *
 * command-log.ts used to snapshot ADHDEV_HOME/LOG_DIR (and mkdir them) at
 * module load. Since the module is imported transitively by almost everything,
 * a test or entrypoint that pins ADHDEV_CONFIG_DIR AFTER the import was
 * silently ignored and command history went to the REAL ~/.adhdev/logs/ — the
 * same defect class logger.ts already fixed (see log-dir-lazy-resolution.test.ts).
 *
 * These tests deliberately do NOT use vi.resetModules(): the module is
 * statically imported above, before any env is set — that is the regression
 * scenario.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCommandLogPath, getRecentCommands, logCommand } from '../../src/logging/command-log.js';

const ORIGINAL_ENV = {
  ADHDEV_CONFIG_DIR: process.env.ADHDEV_CONFIG_DIR,
};

let tmpRoot = '';

function expectedLogFile(dir: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, 'logs', `commands-${date}.jsonl`);
}

describe('command log lazy dir resolution', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-lazy-cmdlog-'));
  });

  afterEach(() => {
    if (ORIGINAL_ENV.ADHDEV_CONFIG_DIR === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = ORIGINAL_ENV.ADHDEV_CONFIG_DIR;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
    tmpRoot = '';
  });

  it('honors ADHDEV_CONFIG_DIR set AFTER the module was imported', () => {
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;

    logCommand({ ts: new Date().toISOString(), cmd: 'send_chat', source: 'ws', success: true });

    const expected = expectedLogFile(tmpRoot);
    expect(getCommandLogPath()).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf-8')).toContain('send_chat');
    expect(getRecentCommands(1).some((e) => e.cmd === 'send_chat')).toBe(true);
  });

  it('follows a later ADHDEV_CONFIG_DIR change instead of sticking to the first dir', () => {
    const dirA = path.join(tmpRoot, 'a');
    const dirB = path.join(tmpRoot, 'b');

    process.env.ADHDEV_CONFIG_DIR = dirA;
    logCommand({ ts: new Date().toISOString(), cmd: 'send_chat', source: 'api' });
    expect(fs.existsSync(expectedLogFile(dirA))).toBe(true);

    process.env.ADHDEV_CONFIG_DIR = dirB;
    logCommand({ ts: new Date().toISOString(), cmd: 'set_cli_view_mode', source: 'ext' });
    expect(getCommandLogPath()).toBe(expectedLogFile(dirB));
    expect(fs.readFileSync(expectedLogFile(dirB), 'utf-8')).toContain('set_cli_view_mode');
  });
});
