import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execNpmCommandAsync, resolveNpmPublishedVersionAsync } from '../../src/commands/upgrade-install-surface.js';
import { isSpawnTimeoutError } from '../../src/commands/upgrade-process-stop.js';

/**
 * Regression: daemon_upgrade resolved its target with spawnSync, 10s × 3 attempts,
 * which froze the daemon's event loop for 30s when the registry was slow. Callers
 * saw p2p_timeout on a machine that was otherwise healthy.
 */
function fakeNpm(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-'));
  const script = path.join(dir, 'npm.cjs');
  fs.writeFileSync(script, body);
  return {
    surface: { npmExecutable: process.execPath, npmArgsPrefix: [script], execOptions: { shell: false } },
    counter: path.join(dir, 'count'),
    dir,
  };
}

describe('resolveNpmPublishedVersionAsync', () => {
  it('keeps the event loop running during a slow lookup', async () => {
    const { surface } = fakeNpm(`setTimeout(() => { console.log('1.2.3'); process.exit(0); }, 400);`);
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 20);
    try {
      await expect(resolveNpmPublishedVersionAsync('adhdev', 'next', surface)).resolves.toBe('1.2.3');
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(5);
  });

  it('retries a timeout once, then gives up inside the 30s command deadline', async () => {
    const { surface } = fakeNpm(`setInterval(() => {}, 1000);`);
    const retries: number[] = [];
    const started = Date.now();
    const error = await resolveNpmPublishedVersionAsync('adhdev', 'next', surface, {
      timeout: 200,
      onRetry: ({ attempt }) => retries.push(attempt),
    }).catch((e) => e);
    expect(isSpawnTimeoutError(error)).toBe(true);
    expect(retries).toEqual([1]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rethrows a real failure without retrying', async () => {
    const { surface, counter } = fakeNpm(
      `require('fs').appendFileSync(process.env.FAKE_COUNT, 'x'); process.exit(1);`,
    );
    process.env.FAKE_COUNT = counter;
    const error = await resolveNpmPublishedVersionAsync('adhdev', 'next', surface).catch((e) => e);
    delete process.env.FAKE_COUNT;
    expect(isSpawnTimeoutError(error)).toBe(false);
    expect(fs.readFileSync(counter, 'utf8')).toBe('x');
  });

  it('does not wait for a grandchild that keeps stdout open after the timeout', async () => {
    const { surface } = fakeNpm(
      `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const error = await execNpmCommandAsync(['view'], { timeout: 200 }, surface).catch((e) => e);
    expect(isSpawnTimeoutError(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
