import { describe, expect, it, vi } from 'vitest';
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';

// MESH-SEND-KEYS (feature 3: key injection). adapter.injectKeys performs a single
// atomic write of the encoded sequence, and refuses when a submit/echo race is
// live or (for non-destructive keys) an actionable approval modal is present.

function makeAdapter() {
  const adapter = new ProviderCliAdapter({
    category: 'cli',
    spawn: { command: 'x', args: [], shell: true, env: {} },
    scripts: { detectStatus: () => 'idle', parseApproval: () => null },
    type: 'claude-cli',
    name: 'Claude',
    binary: 'claude',
  } as any, '/tmp/project') as any;
  const writes: string[] = [];
  adapter.ptyProcess = { write: vi.fn((d: string) => { writes.push(d); return Promise.resolve(); }) };
  // Ensure a clean, non-racing baseline.
  adapter.engine.submitPendingUntil = 0;
  adapter.engine.activeModal = null;
  adapter.submitRetryTimer = null;
  adapter.pendingOutboundFlushInFlight = false;
  adapter.pendingOutboundQueue = [];
  return { adapter: adapter as ProviderCliAdapter, writes };
}

describe('ProviderCliAdapter.injectKeys', () => {
  it('writes text+ENTER atomically in one write and reports success', async () => {
    const { adapter, writes } = makeAdapter();
    const r = await adapter.injectKeys([{ text: 'ls -la' }, { key: 'ENTER' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keys).toEqual(['ENTER']);
      expect(r.submits).toBe(true);
      expect(r.hasDestructive).toBe(false);
    }
    // Single atomic write carrying the whole sequence.
    expect(writes).toEqual(['ls -la\r']);
  });

  it('refuses when an echo-gated submit is pending (submit_race)', async () => {
    const { adapter, writes } = makeAdapter();
    (adapter as any).engine.submitPendingUntil = Date.now() + 5_000;
    const r = await adapter.injectKeys([{ text: 'x' }, { key: 'ENTER' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toBe('submit_race');
    expect(writes).toHaveLength(0); // nothing written on refusal
  });

  it('refuses when a stuck-submit retry is armed (submit_race)', async () => {
    const { adapter, writes } = makeAdapter();
    (adapter as any).submitRetryTimer = setTimeout(() => {}, 10_000);
    const r = await adapter.injectKeys([{ key: 'ENTER' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toBe('submit_race');
    expect(writes).toHaveLength(0);
    clearTimeout((adapter as any).submitRetryTimer);
  });

  it('refuses when the outbound flush queue is busy (submit_race)', async () => {
    const { adapter, writes } = makeAdapter();
    (adapter as any).pendingOutboundQueue = [{ id: 'q1', content: 'queued' }];
    const r = await adapter.injectKeys([{ text: 'a' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toBe('submit_race');
    expect(writes).toHaveLength(0);
  });

  it('refuses a NON-destructive injection into an actionable approval modal (fail-closed)', async () => {
    const { adapter, writes } = makeAdapter();
    (adapter as any).engine.activeModal = { message: 'Allow this?', buttons: ['Yes', 'No'] };
    const r = await adapter.injectKeys([{ key: 'ENTER' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toBe('actionable_modal');
    expect(writes).toHaveLength(0);
  });

  it('allows a NON-destructive injection into a modal when explicitly overridden', async () => {
    const { adapter, writes } = makeAdapter();
    (adapter as any).engine.activeModal = { message: 'Pick one', buttons: ['A', 'B'] };
    const r = await adapter.injectKeys([{ key: 'DOWN' }], { allowModalOverride: true });
    expect(r.ok).toBe(true);
    expect(writes).toEqual(['\x1b[B']);
  });

  it('allows a destructive ESC/CTRL_C past the modal gate (dismiss, not confirm)', async () => {
    const { adapter, writes } = makeAdapter();
    (adapter as any).engine.activeModal = { message: 'Pick one', buttons: ['A', 'B'] };
    const r = await adapter.injectKeys([{ key: 'ESC' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hasDestructive).toBe(true);
    expect(writes).toEqual(['\x1b']);
  });
});

describe('CliProviderInstance.injectKeys ownership gate', () => {
  function makeInstance(settings: Record<string, any>) {
    const instance = Object.create(CliProviderInstance.prototype) as any;
    instance.type = 'claude-cli';
    instance.settings = settings;
    instance.adapter = { injectKeys: vi.fn(async () => ({ ok: true, keys: ['ENTER'], hasDestructive: false, submits: true, bytes: 1 })) };
    return instance;
  }

  it('delegates to the adapter for a mesh worker session', async () => {
    const instance = makeInstance({ meshNodeFor: 'm1', meshNodeId: 'n1' });
    const r = await instance.injectKeys([{ key: 'ENTER' }]);
    expect(r.ok).toBe(true);
    expect(instance.adapter.injectKeys).toHaveBeenCalled();
  });

  it('refuses (not_mesh_worker) for a non-mesh session without touching the adapter', async () => {
    const instance = makeInstance({});
    const r = await instance.injectKeys([{ key: 'ENTER' }]);
    expect(r.ok).toBe(false);
    expect(r.refused).toBe('not_mesh_worker');
    expect(instance.adapter.injectKeys).not.toHaveBeenCalled();
  });
});
