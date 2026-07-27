import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InstanceContextConflictError,
  resolveInstanceContext,
} from '../../src/config/instance-context.js';
import {
  resolveInstanceConfigDir,
  resolveSessionHostIpcKey,
} from '@adhdev/session-host-core';

// Stage 3: one typed instance context drives every mutable path derivation.
// These tests pin the resolution contract: default-instance compatibility,
// explicit-instance disjointness, fail-closed conflict handling, and parity
// with the env-only derivation the session-host child process performs.

const IPC_KEY_RE = /^[0-9a-f]{12}$/;

let tempRoot = '';

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-instance-ctx-'));
});

afterEach(() => {
  if (tempRoot && fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  tempRoot = '';
});

function home(): string {
  return path.join(tempRoot, 'home');
}

describe('resolveInstanceContext', () => {
  it('resolves the default stable instance when nothing is pinned', () => {
    const ctx = resolveInstanceContext({ env: {}, homeDir: home() });
    expect(ctx.configDir).toBe(path.join(home(), '.adhdev'));
    expect(ctx.instanceDir).toBe('.adhdev');
    expect(ctx.isDefault).toBe(true);
    expect(ctx.ipcKey).toBe('');
    expect(ctx.sessionHostAppName).toBe('adhdev');
  });

  it('treats an explicit override pointing at the default dir as default (compat)', () => {
    const ctx = resolveInstanceContext({
      env: { ADHDEV_CONFIG_DIR: path.join(home(), '.adhdev') + path.sep },
      homeDir: home(),
    });
    expect(ctx.isDefault).toBe(true);
    expect(ctx.ipcKey).toBe('');
  });

  it('resolves a preview instance with a distinct dir and ipc key', () => {
    const previewDir = path.join(home(), '.adhdev-preview');
    const ctx = resolveInstanceContext({ env: { ADHDEV_CONFIG_DIR: previewDir }, homeDir: home() });
    expect(ctx.configDir).toBe(previewDir);
    expect(ctx.instanceDir).toBe('.adhdev-preview');
    expect(ctx.isDefault).toBe(false);
    expect(ctx.ipcKey).toMatch(IPC_KEY_RE);
  });

  it('stable and preview contexts produce disjoint mutable paths', () => {
    const stable = resolveInstanceContext({ env: {}, homeDir: home() });
    const preview = resolveInstanceContext({
      env: { ADHDEV_CONFIG_DIR: path.join(home(), '.adhdev-preview') },
      homeDir: home(),
    });
    expect(stable.ipcKey).not.toBe(preview.ipcKey);
    for (const leaf of ['config.json', 'state.json', 'daemon.pid', 'logs', 'providers', 'session-host']) {
      const stablePath = path.join(stable.configDir, leaf);
      const previewPath = path.join(preview.configDir, leaf);
      expect(stablePath).not.toBe(previewPath);
      expect(previewPath.startsWith(stable.configDir + path.sep)).toBe(false);
    }
  });

  it('accepts an explicit configDir that canonically matches the env pin', () => {
    const dir = path.join(home(), '.adhdev-preview');
    const ctx = resolveInstanceContext({
      configDir: dir + path.sep,
      env: { ADHDEV_CONFIG_DIR: dir },
      homeDir: home(),
    });
    expect(ctx.instanceDir).toBe('.adhdev-preview');
  });

  it('FAILS CLOSED on conflicting explicit vs env instance identity', () => {
    expect(() => resolveInstanceContext({
      configDir: path.join(home(), '.adhdev-preview'),
      env: { ADHDEV_CONFIG_DIR: path.join(home(), '.adhdev-other') },
      homeDir: home(),
    })).toThrow(InstanceContextConflictError);
  });

  it('standalone role resolves the reserved standalone session-host namespace', () => {
    const ctx = resolveInstanceContext({ env: {}, homeDir: home(), standalone: true });
    expect(ctx.sessionHostAppName).toBe('adhdev-standalone');
  });

  it('PARITY: daemon-side ipc key matches the env-only derivation the host child performs', () => {
    // The parent daemon derives the endpoint through InstanceContext; the
    // detached session-host child only sees env vars and derives its endpoint
    // via session-host-core helpers. Both must agree byte-for-byte or the
    // parent would spawn a host it cannot connect to.
    for (const dir of [
      path.join(home(), '.adhdev'),
      path.join(home(), '.adhdev-preview'),
      path.join(home(), '.adhdev-standalone'),
      path.join(home(), 'nested', 'custom'),
    ]) {
      const env = { ADHDEV_CONFIG_DIR: dir };
      const ctx = resolveInstanceContext({ env, homeDir: home() });
      const childSide = resolveSessionHostIpcKey(resolveInstanceConfigDir(env, home()), home());
      expect(ctx.ipcKey).toBe(childSide);
      expect(ctx.configDir).toBe(resolveInstanceConfigDir(env, home()));
    }
  });
});
