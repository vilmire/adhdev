/**
 * The worker background-work guard runs on the daemon's main event loop (the
 * turn scheduler's probe, the ledger's synchronous `observe`). A synchronous
 * `ps` / PowerShell there blocks P2P signaling, IPC and every session for as
 * long as the OS takes to answer — on a saturated machine, seconds. The guard
 * therefore must never wait on the OS. Two independent tripwires:
 *
 *  1. SOURCE SHAPE: no `*Sync` process/file call and no raw `child_process`
 *     import in any file on the guard path (spawns go through the async
 *     `hiddenExecFileAsync` in process/hidden-spawn.ts).
 *  2. RUNTIME: with every synchronous child-process entry point replaced by a
 *     function that throws, the whole inspection path still works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const banned = (name: string) => () => { throw new Error(`SYNC PROCESS CALL ON THE GUARD PATH: ${name}`); };
  return {
    ...actual,
    execFileSync: banned('execFileSync'),
    execSync: banned('execSync'),
    spawnSync: banned('spawnSync'),
  };
});

import {
  createProcessTableSource,
  peekSessionBackgroundProcesses,
  readSessionBackgroundProcesses,
  readSystemProcessTableAsync,
} from '../../src/process/process-table-snapshot.js';
import { inspectSessionProcessTree } from '../../src/process/session-process-tree.js';

const SRC = path.resolve(__dirname, '../../src');

/** Every file whose code runs when the guard inspects, gates or decides. */
const GUARD_PATH_FILES = [
  'process/session-process-tree.ts',
  'process/process-table-snapshot.ts',
  'mesh/turn-ledger/background-work-guard.ts',
  'mesh/turn-ledger/probe.ts',
  'mesh/turn-ledger/ledger.ts',
  'mesh/turn-ledger/scheduler.ts',
  'mesh/turn-ledger/runtime-ledger.ts',
] as const;

const SYNC_CALL = /\b(?:execFileSync|execSync|spawnSync|hiddenExecFileSync|hiddenSpawnSync|hiddenExecSync|readFileSync|readdirSync|statSync|lstatSync|existsSync|readlinkSync|openSync)\b/;
const RAW_CHILD_PROCESS_IMPORT = /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/;

/**
 * Drop comments, keep strings. One left-to-right pass: a `/*` inside a `//`
 * comment (or inside a string) must not open a block comment — the naive
 * two-regex version did exactly that and silently erased every import in
 * probe.ts, which made this guard pass on a file that called `*Sync`.
 */
function stripComments(source: string): string {
  return source.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str: string | undefined) => str ?? '',
  );
}

/** Canary: stripping must leave every top-level import in place, or the scan is blind. */
function importCount(source: string): number {
  return (source.match(/^import\b/gm) ?? []).length;
}

describe('no synchronous process call anywhere on the guard path', () => {
  it('scans the intended file set (a rename must update this list, not silently shrink the scan)', () => {
    expect(GUARD_PATH_FILES).toHaveLength(7);
    for (const rel of GUARD_PATH_FILES) {
      expect(fs.existsSync(path.join(SRC, rel)), rel).toBe(true);
    }
  });

  it.each(GUARD_PATH_FILES)('%s has no *Sync call and no raw child_process import', (rel) => {
    const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const code = stripComments(raw);
    expect(importCount(code), `${rel}: comment stripping erased code (the scan would be blind)`).toBe(importCount(raw));
    expect(code.match(SYNC_CALL)?.[0], `${rel} uses a synchronous call`).toBeUndefined();
    expect(RAW_CHILD_PROCESS_IMPORT.test(code), `${rel} imports child_process directly`).toBe(false);
  });

  it('the boot wiring of the ledger gate only PEEKS the cache (no awaited read inside the synchronous callback)', () => {
    const code = stripComments(fs.readFileSync(path.join(SRC, 'boot/stages/mesh-runtime.ts'), 'utf8'));
    const start = code.indexOf('inspectBackgroundProcesses:');
    const end = code.indexOf('backgroundWorkReleased:', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const wiring = code.slice(start, end);
    expect(wiring).toContain('peekSessionBackgroundProcesses');
    expect(wiring).not.toMatch(SYNC_CALL);
    expect(wiring).not.toMatch(/\bawait\b|readSessionBackgroundProcesses|inspectSessionProcessTree\(/);
  });

  it('the provider completion gate does not consult the process table (the ledger gate owns that decision)', () => {
    const code = stripComments(fs.readFileSync(path.join(SRC, 'providers/completion/completion-diagnostics.ts'), 'utf8'));
    expect(code).not.toMatch(/session-process-tree|process-table-snapshot/);
  });

  it('the inspector refuses to read the OS by itself: processTable is required (no hidden default read)', () => {
    expect(() => inspectSessionProcessTree(100, {} as never)).toThrow();
    const sig = stripComments(fs.readFileSync(path.join(SRC, 'process/session-process-tree.ts'), 'utf8'));
    expect(sig).toMatch(/readonly processTable: readonly ProcessNodeInfo\[\];/);
  });
});

describe('with every synchronous child-process entry point banned, the whole inspection path still works', () => {
  it('the banned stubs are really installed (this test would otherwise prove nothing)', async () => {
    const cp = await import('node:child_process');
    expect(() => cp.execFileSync('true')).toThrow(/SYNC PROCESS CALL/);
    expect(() => cp.spawnSync('true')).toThrow(/SYNC PROCESS CALL/);
  });

  it.skipIf(process.platform === 'win32')('real async ps read → shared source → peek and bounded read both succeed', async () => {
    const table = await readSystemProcessTableAsync();
    expect(table?.some((n) => n.pid === process.pid)).toBe(true);

    const source = createProcessTableSource({ read: async () => table });
    expect(peekSessionBackgroundProcesses(process.pid, { source })).toBeNull(); // unknown until the async read lands
    const bounded = await readSessionBackgroundProcesses(process.pid, { source, maxWaitMs: 2_000 });
    expect(bounded).not.toBeNull();
    expect(peekSessionBackgroundProcesses(process.pid, { source })).not.toBeNull();
  });

  it('a failing read degrades to unknown without ever reaching a sync fallback', async () => {
    const source = createProcessTableSource({ read: async () => { throw new Error('boom'); } });
    expect(peekSessionBackgroundProcesses(1234, { source })).toBeNull();
    expect(await readSessionBackgroundProcesses(1234, { source })).toBeNull();
  });
});
