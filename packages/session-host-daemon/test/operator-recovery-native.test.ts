import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('compiled native guardian explicitly reports missing historical attribution', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-native-'));
  const helper = join(root, 'guardian');
  execFileSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', resolve('native/instance-lock.c'), '-o', helper], { windowsHide: true });
  const value = JSON.parse(String(execFileSync(helper, ['--recovery-coverage-v1'], { windowsHide: true })));
  assert.deepEqual(value, { protocol: 1, verdict: 'UNKNOWN', reason: 'historical_native_attribution_unavailable' });
  assert.equal(String(execFileSync(helper, ['--attest'], { windowsHide: true })).trim(), 'adhdev-host-guardian/1');
});

test('protocol-1 coverage does not execute an unadvertised option on legacy helpers', { skip: process.platform !== 'darwin' }, async () => {
  const { HostUpgradeLease } = await import('../src/upgrade-lease.js');
  // No executable exists. A probe/read/spawn would fail this positive control.
  const lease = new HostUpgradeLease({ helperPath: '/fixture/nonexistent-helper', helperSha256: '0'.repeat(64), stateDir: '/fixture/not-written' }, 'fixture-endpoint') as any;
  lease.healthy = true;
  lease.child = { exitCode: null, signalCode: null };
  assert.deepEqual(lease.recoveryCoverage(), { protocol: 1, verdict: 'UNKNOWN', reason: 'historical_native_attribution_unavailable' });
});
