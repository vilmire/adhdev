import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProviderModule } from '../../src/providers/contracts.js';
import type { ProviderLoader } from '../../src/providers/provider-loader.js';

// Fail if version detection ever spawns a process for an IDE on win32.
const execSpy = vi.fn(() => {
  throw new Error('IDE version detection must not spawn a process on win32');
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

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    platform: () => 'win32',
  };
});

let tmp: string | null = null;
// version-archive.ts's local findBinary() searches the REAL process.env.PATH
// (no test seam) — on a dev machine that actually has Cursor installed,
// `findBinary('cursor')` resolves to the real cursor.cmd shim, which then
// misdirects the manifest read (wrong directory) and defeats the exec-guard
// (isKnownWin32GuiExe requires a `.exe` suffix; a `.cmd` shim doesn't
// qualify). Isolate PATH so provider.cli resolution only ever sees the
// fixture's own paths.win32 entry, exactly like a machine without Cursor
// installed.
let originalPath: string | undefined;

function createLoader(
  providers: ProviderModule[],
  win32ProcessNames: Record<string, string[]>,
): ProviderLoader {
  return {
    getAll: () => providers,
    getWinProcessNames: () => win32ProcessNames,
  } as unknown as ProviderLoader;
}

describe('detectAllVersions — IDE category on win32', () => {
  beforeEach(() => {
    originalPath = process.env.PATH;
    process.env.PATH = '';
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    execSpy.mockClear();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
    vi.resetModules();
  });

  it('reads IDE version from disk without spawning the GUI exe', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'adhdev-va-ide-'));
    const appDir = join(tmp, 'resources', 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'product.json'), JSON.stringify({ version: '1.99.0' }));
    const exePath = join(tmp, 'Cursor.exe');
    writeFileSync(exePath, 'fake');

    const { detectAllVersions } = await import('../../src/providers/version-archive.js');
    const results = await detectAllVersions(
      createLoader(
        [
          {
            type: 'cursor',
            name: 'Cursor',
            category: 'ide',
            cli: 'cursor',
            paths: { win32: [exePath] },
            processNames: { win32: ['Cursor.exe'] },
            versionCommand: 'cursor --version',
          } as ProviderModule,
        ],
        { cursor: ['Cursor.exe'] },
      ),
    );

    const cursor = results.find((r) => r.type === 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.installed).toBe(true);
    expect(cursor!.version).toBe('1.99.0');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('does not spawn the GUI exe even when no manifest is found', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'adhdev-va-ide2-'));
    const exePath = join(tmp, 'Cursor.exe');
    writeFileSync(exePath, 'fake'); // no resources/app manifest

    const { detectAllVersions } = await import('../../src/providers/version-archive.js');
    const results = await detectAllVersions(
      createLoader(
        [
          {
            type: 'cursor',
            name: 'Cursor',
            category: 'ide',
            cli: 'cursor',
            paths: { win32: [exePath] },
            processNames: { win32: ['Cursor.exe'] },
            versionCommand: 'cursor --version',
          } as ProviderModule,
        ],
        { cursor: ['Cursor.exe'] },
      ),
    );

    const cursor = results.find((r) => r.type === 'cursor');
    expect(cursor!.installed).toBe(true);
    expect(cursor!.version).toBeNull();
    expect(execSpy).not.toHaveBeenCalled(); // guard refused the GUI exe
  });
});
