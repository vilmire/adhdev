import { describe, expect, it, vi } from 'vitest';
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';

// MESH-READ-TERMINAL (feature 2: RAW terminal read). getTerminalScreenSnapshot returns
// ONLY the current rendered viewport + cursor + size (no debug buffers / parser state /
// history), byte-bounded with bottom-tail preservation. The CliProviderInstance wrapper
// gates it on isMeshWorkerSession().

function makeAdapter(screenText: string, size = { cols: 80, rows: 24 }, cursor = { col: 3, row: 5 }) {
  const adapter = new ProviderCliAdapter({
    category: 'cli',
    spawn: { command: 'x', args: [], shell: true, env: {} },
    scripts: { detectStatus: () => 'idle', parseApproval: () => null },
    type: 'claude-cli',
    name: 'Claude',
    binary: 'claude',
  } as any, '/tmp/project') as any;
  adapter.terminalScreen = {
    write: vi.fn(),
    getText: () => screenText,
    getSize: () => size,
    getCursorPosition: () => cursor,
  };
  return adapter as ProviderCliAdapter;
}

describe('ProviderCliAdapter.getTerminalScreenSnapshot', () => {
  it('returns the current viewport + cursor + size with a hash', () => {
    const adapter = makeAdapter('hello\n❯ ', { cols: 120, rows: 40 }, { col: 2, row: 1 });
    const snap = adapter.getTerminalScreenSnapshot();
    expect(snap.text).toBe('hello\n❯ ');
    expect(snap.cols).toBe(120);
    expect(snap.rows).toBe(40);
    expect(snap.cursor).toEqual({ col: 2, row: 1 });
    expect(snap.truncated).toBe(false);
    expect(snap.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(snap.originalBytes).toBe(Buffer.byteLength('hello\n❯ ', 'utf8'));
  });

  it('byte-truncates a huge screen bottom-first', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `row-${i}-${'x'.repeat(40)}`);
    const adapter = makeAdapter(lines.join('\n'));
    const snap = adapter.getTerminalScreenSnapshot(2048);
    expect(snap.truncated).toBe(true);
    expect(snap.returnedBytes).toBeLessThanOrEqual(2048);
    // Bottom of the screen preserved.
    expect(snap.text.endsWith('row-4999-' + 'x'.repeat(40))).toBe(true);
  });

  it('clamps maxBytes to the absolute 64KiB cap', () => {
    // A screen larger than 64KiB, requesting an absurd cap → still capped at 64KiB.
    const big = 'y'.repeat(200 * 1024);
    const adapter = makeAdapter(big);
    const snap = adapter.getTerminalScreenSnapshot(10 * 1024 * 1024);
    expect(snap.truncated).toBe(true);
    expect(snap.returnedBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it('clamps a tiny maxBytes up to the 1KiB floor', () => {
    const big = 'z'.repeat(4096);
    const adapter = makeAdapter(big);
    const snap = adapter.getTerminalScreenSnapshot(1);
    // Floor is 1024, so ~1KiB is returned (not 1 byte).
    expect(snap.returnedBytes).toBeGreaterThanOrEqual(512);
    expect(snap.returnedBytes).toBeLessThanOrEqual(1024);
  });
});

describe('CliProviderInstance.getTerminalScreenSnapshot ownership gate', () => {
  function makeInstance(settings: Record<string, any>, adapterSnapshot: any) {
    const instance = Object.create(CliProviderInstance.prototype) as any;
    instance.instanceId = 'sess-1';
    instance.type = 'claude-cli';
    instance.settings = settings;
    instance.adapter = { getTerminalScreenSnapshot: vi.fn(() => adapterSnapshot) };
    return instance;
  }

  const snap = { text: 'screen', cursor: { col: 0, row: 0 }, cols: 80, rows: 24, truncated: false, originalBytes: 6, returnedBytes: 6, hash: 'abc' };

  it('delegates to the adapter for a mesh worker session', () => {
    const instance = makeInstance({ meshNodeFor: 'mesh-1', meshNodeId: 'node-1' }, snap);
    const result = instance.getTerminalScreenSnapshot(1234);
    expect(result).toBe(snap);
    expect(instance.adapter.getTerminalScreenSnapshot).toHaveBeenCalledWith(1234);
  });

  it('returns null for a non-mesh session (never touches the adapter)', () => {
    const instance = makeInstance({}, snap);
    const result = instance.getTerminalScreenSnapshot();
    expect(result).toBeNull();
    expect(instance.adapter.getTerminalScreenSnapshot).not.toHaveBeenCalled();
  });
});
