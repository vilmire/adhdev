import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Spy that fails the test if ANY process is spawned during IDE detection.
const execSpy = vi.fn(() => {
  throw new Error('boot-time IDE detection must not spawn a process');
});

vi.mock('child_process', () => ({
  exec: (cmd: string, _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    try {
      cb(null, execSpy() as unknown as string, '');
    } catch (e) {
      cb(e as Error, '', '');
    }
    return {};
  },
}));

let binDir: string | null = null;
const originalPath = process.env.PATH;

describe('detectIDEs (boot path)', () => {
  afterEach(() => {
    execSpy.mockClear();
    process.env.PATH = originalPath;
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true });
      binDir = null;
    }
    vi.resetModules();
  });

  it('does not spawn `--version` and still resolves installed via existsSync', async () => {
    // Put a fake CLI wrapper on PATH so findCliCommand resolves it.
    binDir = mkdtempSync(join(tmpdir(), 'adhdev-ide-detect-'));
    const cliName = process.platform === 'win32' ? 'mockide.cmd' : 'mockide';
    const cliPath = join(binDir, cliName);
    writeFileSync(cliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${originalPath || ''}`;

    const { registerIDEDefinition, detectIDEs } = await import('../../src/detection/ide-detector.js');
    registerIDEDefinition({
      id: 'mockide',
      name: 'MockIDE',
      displayName: 'Mock IDE',
      icon: '',
      cli: 'mockide',
      paths: {},
    });

    const results = await detectIDEs();
    const mock = results.find((r) => r.id === 'mockide');

    expect(mock).toBeDefined();
    expect(mock!.installed).toBe(true); // decided by existsSync, not by exec
    expect(mock!.version).toBeNull(); // boot detection never fills version
    expect(execSpy).not.toHaveBeenCalled();
  });
});
