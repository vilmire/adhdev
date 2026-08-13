import { describe, expect, it, vi, afterEach } from 'vitest';
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


// ── WIN32-INJECT-ENTER-RETRY ────────────────────────────────────────────────
// On win32 ConPTY the ENTER terminating an injected text+ENTER sequence can be
// silently swallowed (no ack exists on the PTY write path). The adapter resends
// the bare ENTER up to 2× at 300ms cadence, stopping as soon as the injected
// text leaves the composer region (bottom 8 viewport lines) — the cheap
// already-submitted check that prevents a double submit when the original
// ENTER was merely DELAYED, not lost.

const RETRY_DELAY_MS = 300; // mirrors WIN32_INJECT_ENTER_RETRY_DELAY_MS
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** Put `content` at the bottom of a small screen so it sits inside the
 *  composer region (bottom 8 lines) the retry stop-check inspects. */
function feedComposer(adapter: any, content: string): void {
  adapter.terminalScreen.reset(10, 80);
  adapter.terminalScreen.write(`\n\n\n${content}`);
}

describe('ProviderCliAdapter.injectKeys — win32 ENTER retry', () => {
  afterEach(() => setPlatform(ORIGINAL_PLATFORM));

  it('win32: resends the bare ENTER while the text stands in the composer, bounded at 2 retries', async () => {
    setPlatform('win32');
    const { adapter, writes } = makeAdapter();
    const r = await adapter.injectKeys([{ text: 'retryprobe' }, { key: 'ENTER' }]);
    expect(r.ok).toBe(true);
    // The composer echoes the injected text; the (lost) ENTER never consumed it.
    feedComposer(adapter, 'retryprobe');
    await sleep(RETRY_DELAY_MS * 2 + 200); // let both retry ticks fire
    // Fused text+ENTER write, then exactly MAX_RETRIES bare ENTERs — no runaway.
    expect(writes[0]).toBe('retryprobe\r');
    expect(writes.filter(w => w === '\r')).toHaveLength(2);
    expect(writes).toHaveLength(3);
    clearTimeout((adapter as any).injectEnterRetryTimer);
  }, 5000);

  it('win32: NO retry when the text already left the composer (delayed ENTER landed — no duplicate submit)', async () => {
    setPlatform('win32');
    const { adapter, writes } = makeAdapter();
    const r = await adapter.injectKeys([{ text: 'retryprobe' }, { key: 'ENTER' }]);
    expect(r.ok).toBe(true);
    // The submit was consumed: the composer re-rendered empty (text is gone
    // from the bottom region — it scrolled up into the transcript / cleared).
    feedComposer(adapter, '>');
    await sleep(RETRY_DELAY_MS * 2 + 200);
    expect(writes).toEqual(['retryprobe\r']); // the single fused write, nothing more
  }, 5000);

  it('win32: stops MID-chain once the submit is observed (first retry fires, second does not)', async () => {
    setPlatform('win32');
    const { adapter, writes } = makeAdapter();
    await adapter.injectKeys([{ text: 'retryprobe' }, { key: 'ENTER' }]);
    feedComposer(adapter, 'retryprobe'); // still standing → retry 1 fires
    await sleep(RETRY_DELAY_MS + 120);
    expect(writes.filter(w => w === '\r')).toHaveLength(1);
    // The (delayed) original ENTER now submits: the composer clears.
    feedComposer(adapter, '>');
    await sleep(RETRY_DELAY_MS + 200);
    expect(writes.filter(w => w === '\r')).toHaveLength(1); // no second retry
    clearTimeout((adapter as any).injectEnterRetryTimer);
  }, 5000);

  it('win32: text visible only in the transcript (top lines), NOT the composer, does NOT trigger a retry', async () => {
    setPlatform('win32');
    const { adapter, writes } = makeAdapter();
    await adapter.injectKeys([{ text: 'retryprobe' }, { key: 'ENTER' }]);
    // Submitted message lives in the scrollback-style transcript at the TOP;
    // filler output occupies the composer region at the bottom.
    adapter.terminalScreen.reset(32, 80);
    adapter.terminalScreen.write('retryprobe' + '\n'.repeat(22));
    adapter.terminalScreen.write(Array.from({ length: 9 }, (_, i) => `filler output ${i}`).join('\n'));
    expect(adapter.terminalScreen.getText()).toContain('retryprobe'); // still in viewport…
    await sleep(RETRY_DELAY_MS * 2 + 200);
    expect(writes).toEqual(['retryprobe\r']); // …but outside the composer → no resend
  }, 5000);

  it('win32: a bare ENTER with no text gets no retry (no snippet → no cheap stop check)', async () => {
    setPlatform('win32');
    const { adapter, writes } = makeAdapter();
    const r = await adapter.injectKeys([{ key: 'ENTER' }]);
    expect(r.ok).toBe(true);
    await sleep(RETRY_DELAY_MS * 2 + 200);
    expect(writes).toEqual(['\r']); // exactly the one injected ENTER
  }, 5000);

  it('non-win32: keeps the single fused write — no retry is armed', async () => {
    setPlatform('darwin');
    const { adapter, writes } = makeAdapter();
    await adapter.injectKeys([{ text: 'retryprobe' }, { key: 'ENTER' }]);
    feedComposer(adapter, 'retryprobe'); // even with the text still visible
    await sleep(RETRY_DELAY_MS * 2 + 200);
    expect(writes).toEqual(['retryprobe\r']);
  }, 5000);

  it('win32: a fresh injection cancels the previous pending retry (no stale ENTER on the new write)', async () => {
    setPlatform('win32');
    const { adapter, writes } = makeAdapter();
    await adapter.injectKeys([{ text: 'firstprobe' }, { key: 'ENTER' }]);
    feedComposer(adapter, 'firstprobe');
    // Re-inject before the first retry tick fires — it supersedes the old chain.
    await adapter.injectKeys([{ text: 'secondprobe' }, { key: 'ENTER' }]);
    feedComposer(adapter, '>');
    await sleep(RETRY_DELAY_MS * 2 + 200);
    // Both fused writes only — the first chain was cancelled before firing and
    // the second chain saw an already-submitted (empty) composer.
    expect(writes).toEqual(['firstprobe\r', 'secondprobe\r']);
    clearTimeout((adapter as any).injectEnterRetryTimer);
  }, 5000);
});
