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
  assert.equal(String(execFileSync(helper, ['--attest'], { windowsHide: true })).trim(), 'adhdev-host-guardian/2');
});

test('protocol-1 coverage does not execute an unadvertised option on legacy helpers', { skip: process.platform !== 'darwin' }, async () => {
  const { HostUpgradeLease } = await import('../src/upgrade-lease.js');
  // No executable exists. A probe/read/spawn would fail this positive control.
  const lease = new HostUpgradeLease({ helperPath: '/fixture/nonexistent-helper', helperSha256: '0'.repeat(64), stateDir: '/fixture/not-written' }, 'fixture-endpoint') as any;
  lease.healthy = true;
  lease.child = { exitCode: null, signalCode: null };
  assert.deepEqual(lease.recoveryCoverage(), { protocol: 1, verdict: 'UNKNOWN', reason: 'historical_native_attribution_unavailable' });
});

test('protocol-2 adapter parses bounded native observations and keeps historical coverage UNKNOWN', { skip: process.platform !== 'darwin' }, async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { HostUpgradeLease } = await import('../src/upgrade-lease.js');
  const root = mkdtempSync(join(tmpdir(), 'recovery-native-parser-'));
  const helper = join(root, 'fixture-helper');
  // This fixture emits synthetic counters; it does NOT enumerate author-host
  // processes or claim a positive physical proof.
  writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' \'{"protocol":2,"verdict":"UNKNOWN","reason":"historical_native_attribution_unavailable","nativeBootSeconds":1,"processCount":2,"descriptorCount":3,"unreadable":1}\'\n', { mode: 0o700 });
  const pin = createHash('sha256').update(readFileSync(helper)).digest('hex');
  const lease = new HostUpgradeLease({ helperPath: helper, helperSha256: pin, helperProtocol: 2, stateDir: root }, 'fixture-endpoint') as any;
  lease.healthy = true; lease.child = { exitCode: null, signalCode: null };
  assert.deepEqual(lease.recoveryCoverage(), { protocol: 2, verdict: 'UNKNOWN', reason: 'historical_native_attribution_unavailable', processCount: 2, descriptorCount: 3, unreadable: 1 });
});

test('native unknown option fails without creating a lock', { skip: process.platform !== 'darwin' }, async () => {
  const { existsSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'recovery-unknown-option-')); const helper = join(root, 'guardian');
  execFileSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', resolve('native/instance-lock.c'), '-o', helper], { windowsHide: true });
  assert.throws(() => execFileSync(helper, ['--misspelled-recovery'], { cwd: root, timeout: 300, windowsHide: true }), (e: any) => e.status === 64);
  assert.equal(existsSync(join(root, '--misspelled-recovery')), false);
});
