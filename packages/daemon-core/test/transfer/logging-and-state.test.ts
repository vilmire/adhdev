import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG } from '../../src/logging/logger.js';
import type { TransferLink, TransferLinkFactory } from '../../src/transfer/link.js';
import { approveBoth, setupPair, waitFor } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.restoreAllMocks(); });

const SDP = 'v=0\r\na=fingerprint:sha-256 AB:CD:EF:01\r\na=candidate:1 1 udp 2122 192.0.2.7 50000 typ host\r\n';
const CANDIDATE = 'candidate:9 1 udp 2122 192.0.2.8 50001 typ host';

/** A link that never opens (or closes with a reason) and emits secret-looking signalling. */
function fakeFactory(closeReason?: string): TransferLinkFactory {
  return {
    create: () => {
      let out: ((s: any) => void) | undefined;
      let onClose: ((r: string) => void) | undefined;
      const link: TransferLink = {
        send: () => false, bufferedAmount: () => 0, onMessage: () => {}, onOpen: () => {},
        onClose: (cb) => { onClose = cb; },
        signalIn: () => {},
        onSignalOut: (cb) => { out = cb; setTimeout(() => { out?.({ kind: 'offer', sdp: SDP }); out?.({ kind: 'candidate', candidate: CANDIDATE }); if (closeReason) onClose?.(closeReason); }, 5); },
        localFingerprint: () => 'sha-256 AB:CD', remoteFingerprint: () => 'sha-256 EF:01',
        close: () => {},
      };
      return link;
    },
  };
}

function captureLogs(): () => string {
  const lines: string[] = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(LOG, level).mockImplementation(((tag: string, msg: string) => { lines.push(`${level} ${tag} ${msg}`); }) as any);
  }
  return () => lines.join('\n');
}

describe('transfer engine logging', () => {
  it('logs the failure code and never SDP, candidates, fingerprints or keys', async () => {
    const logs = captureLogs();
    const t = await setupPair({ 'proj/a.txt': 'hello' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    let keyB64 = '';
    const origDispatch = t.a.ports.dispatchPeer;
    t.a.ports.dispatchPeer = async (peer, args) => { if (args.op === 'content') keyB64 = String(args.linkKeyB64); return origDispatch(peer, args); };
    t.a.ports.linkFactory = fakeFactory('DIRECT_UNAVAILABLE');
    t.b.ports.linkFactory = fakeFactory();
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'failed');
    const text = logs();
    expect(text).toMatch(/Transfer .*link attempt 1 started/);
    expect(text).toMatch(/Transfer .*link 1 failed code=DIRECT_UNAVAILABLE/);
    expect(text).toMatch(/Transfer .*terminal state=failed code=DIRECT_UNAVAILABLE/);
    expect(text).toMatch(/Transfer .*approved/);
    expect(keyB64.length).toBeGreaterThan(10);
    for (const secret of [keyB64, 'AB:CD', 'EF:01', 'fingerprint', 'a=candidate', '192.0.2.', 'typ host', 'a.txt', 'proj/']) expect(text).not.toContain(secret);
  });

  it('stays in linking (never transferring) while no link is established', async () => {
    captureLogs();
    const t = await setupPair({ 'proj/a.txt': 'hello' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    t.a.ports.linkFactory = fakeFactory();
    t.b.ports.linkFactory = fakeFactory();
    const seen = new Set<string>();
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    const end = Date.now() + 300;
    while (Date.now() < end) { seen.add(t.a.engine.get(t.id)!.state); seen.add(t.b.engine.get(t.id)!.state); await new Promise((r) => setTimeout(r, 10)); }
    expect(seen.has('linking')).toBe(true);
    expect(seen.has('transferring')).toBe(false);
  });

  it('reaches transferring only after the link is established, then completes', async () => {
    captureLogs();
    const t = await setupPair({ 'proj/a.txt': 'hello' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    // Sender-side state observed at every frame the initiator writes (A's link is pair[0]).
    const states: string[] = [];
    t.broker.taps.push((d) => { states.push(t.a.engine.get(t.id)!.state); return d; });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'completed' && t.b.engine.get(t.id)?.state === 'completed');
    expect(states[0]).toBe('linking'); // HELLO goes out before the binding is verified
    expect(states).toContain('transferring'); // DATA frames only after it was
  });
});

describe('peer-supplied failure codes', () => {
  it('keep only the closed code shape before they reach logs or state', async () => {
    const { safeTransferCode } = await import('../../src/transfer/link-session.js')
    expect(safeTransferCode('DIRECT_UNAVAILABLE')).toBe('DIRECT_UNAVAILABLE')
    expect(safeTransferCode('X\n[00:00:00.000] [INF] [Transfer] forged')).toBe('PEER_ERROR')
    expect(safeTransferCode('lowercase')).toBe('PEER_ERROR')
    expect(safeTransferCode('A'.repeat(49))).toBe('PEER_ERROR')
    expect(safeTransferCode(undefined, 'TARGET_FAILED')).toBe('TARGET_FAILED')
  })
})
