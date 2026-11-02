import { afterEach, describe, expect, it } from 'vitest';
import { issueTrustedOwnerIngressProof, markTrustedOwnerIngress } from '../../src/commands/command-args.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { TRANSFER_LIMITS } from '../../src/transfer/limits.js';
import type { TransferLink, TransferLinkFactory } from '../../src/transfer/link.js';
import { TransferStore } from '../../src/transfer/store.js';
import { configureProjectTransfer, resetProjectTransferForTest } from '../../src/transfer/runtime.js';
import { approveBoth, setupPair, waitFor, type LinkBroker } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); resetProjectTransferForTest(); });

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SDP_RELAY = 'v=0\r\na=fingerprint:sha-256 AB:CD:EF:01\r\na=candidate:1 1 udp 2122 192.0.2.7 50000 typ relay\r\n';
const CAND_RELAY = 'candidate:9 1 udp 2122 192.0.2.8 50001 typ relay';

/** A link that never opens; optionally closes with a reason a few ms after the engine listens. */
function deadLink(closeReason?: string): TransferLink {
  let onClose: ((r: string) => void) | undefined;
  return {
    send: () => false, bufferedAmount: () => 0, onMessage: () => {}, onOpen: () => {},
    onClose: (cb) => { onClose = cb; if (closeReason) setTimeout(() => onClose?.(closeReason), 5); },
    signalIn: () => {}, onSignalOut: () => {},
    localFingerprint: () => 'sha-256 AA:AA', remoteFingerprint: () => 'sha-256 BB:BB', close: () => {},
  };
}

/**
 * Network that cannot connect directly: a non-relay initiator link dies with `directFailure`, the
 * non-relay responder link stays inert; a relay-allowed pair connects through the memory broker and
 * reports `relay` (or `reportedPath`) as the path ICE picked.
 */
function blockedNetwork(broker: LinkBroker, opts?: { directFailure?: string; reportedPath?: 'relay' | 'direct' | 'unknown' }) {
  const inner = broker.factory();
  const created: Array<{ role: string; allowRelay: boolean }> = [];
  const factory: TransferLinkFactory = {
    create: (o) => {
      created.push({ role: o.role, allowRelay: o.allowRelay === true });
      if (!o.allowRelay) return deadLink(o.role === 'initiator' ? (opts?.directFailure ?? 'DIRECT_UNAVAILABLE') : undefined);
      const link = inner.create(o);
      const path = opts?.reportedPath ?? 'relay';
      return Object.assign(link, { transportPath: () => path }) as TransferLink;
    },
  };
  return { factory, created };
}

async function pairOverBlockedNetwork(files: Record<string, string>, opts?: Parameters<typeof blockedNetwork>[1]) {
  const t = await setupPair(files);
  cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
  const net = blockedNetwork(t.broker, opts);
  t.a.ports.linkFactory = net.factory;
  t.b.ports.linkFactory = net.factory;
  return { ...t, net };
}

describe('relay fallback (owner decision 2026-11-02)', () => {
  it('is ON by default and persists the owner choice', async () => {
    const t = await setupPair({ 'proj/a.txt': 'x' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    expect(t.a.engine.capabilities().relayAllowed).toBe(true);
    t.a.engine.setRelayAllowed(false);
    expect(t.a.engine.capabilities().relayAllowed).toBe(false);
    expect(new TransferStore(t.a.base).readRelayAllowed()).toBe(false);
  });

  it('retries the link with relay allowed when direct is unavailable and BOTH daemons allow it; records the path', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hello relay' });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'completed' && t.b.engine.get(t.id)?.state === 'completed', 15000);
    expect(t.net.created.some((c) => !c.allowRelay)).toBe(true); // direct first
    expect(t.net.created.filter((c) => c.allowRelay).map((c) => c.role).sort()).toEqual(['initiator', 'responder']);
    expect(t.net.created.findIndex((c) => c.allowRelay)).toBeGreaterThan(0);
    expect(t.a.engine.get(t.id)!.path).toBe('relay');
    expect(t.b.engine.get(t.id)!.path).toBe('relay');
    expect(t.a.engine.store.relayUsedToday(Date.now())).toBe(11); // bytes of 'hello relay'
    expect(t.b.engine.store.relayUsedToday(Date.now())).toBe(11);
  });

  it('escalates after the direct reconnect attempts time out (LINK_LOST path), too', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hi' }, { directFailure: 'connect_timeout' });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'completed', 20000);
    expect(t.net.created.filter((c) => !c.allowRelay && c.role === 'initiator').length).toBe(TRANSFER_LIMITS.directRetriesBeforeRelay + 1);
    expect(t.a.engine.get(t.id)!.path).toBe('relay');
  }, 30000);

  it('a direct success stays direct and never asks for a relay', async () => {
    const t = await setupPair({ 'proj/a.txt': 'hello' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'completed' && t.b.engine.get(t.id)?.state === 'completed');
    expect(t.a.engine.get(t.id)!.path).toBe('direct');
    expect(t.b.engine.get(t.id)!.path).toBe('direct');
    expect(t.a.engine.store.relayUsedToday(Date.now())).toBe(0);
  });

  it('an allowed relay whose ICE picked a direct pair is recorded direct and not counted', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hello' }, { reportedPath: 'direct' });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'completed', 15000);
    expect(t.a.engine.get(t.id)!.path).toBe('direct');
    expect(t.a.engine.store.relayUsedToday(Date.now())).toBe(0);
  });

  it('keeps the failure (no relay link at all) when the SOURCE disallows relays', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hello' });
    t.a.engine.setRelayAllowed(false);
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'failed');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('DIRECT_UNAVAILABLE');
    expect(t.net.created.some((c) => c.allowRelay)).toBe(false);
  });

  it('keeps today\'s failure when the TARGET disallows relays (source asked, peer refused)', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hello' });
    t.b.engine.setRelayAllowed(false);
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'failed');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('DIRECT_UNAVAILABLE');
    expect(t.net.created.some((c) => c.allowRelay)).toBe(false);
    await waitFor(() => t.b.engine.get(t.id)?.state === 'cancelled' || t.b.engine.get(t.id)?.state === 'failed');
  });

  it('refuses a relay transfer over the per-transfer limit with RELAY_LIMIT_EXCEEDED', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hello' });
    t.a.engine.get(t.id)!.totalBytes = TRANSFER_LIMITS.relayMaxTransferBytes + 1;
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'failed');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('RELAY_LIMIT_EXCEEDED');
    expect(t.net.created.some((c) => c.allowRelay)).toBe(false);
  });

  it('refuses a relay transfer that would pass the daily budget; the budget is per UTC day', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hello' });
    t.a.engine.store.addRelayBytes(TRANSFER_LIMITS.relayDailyBytes - 3, Date.now());
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'failed');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('RELAY_LIMIT_EXCEEDED');
    expect(TRANSFER_LIMITS.relayDailyBytes).toBe(2 * GIB);
    expect(TRANSFER_LIMITS.relayMaxTransferBytes).toBe(500 * MIB);
    // next UTC day: the counter starts over
    const tomorrow = Date.now() + 36 * 3_600_000;
    expect(t.a.engine.store.relayUsedToday(tomorrow)).toBe(0);
    expect(t.a.engine.store.addRelayBytes(5, tomorrow)).toBe(5);
  });

  it('enforces the target\'s own daily budget too', async () => {
    const t = await pairOverBlockedNetwork({ 'proj/a.txt': 'hello' });
    t.b.engine.store.addRelayBytes(TRANSFER_LIMITS.relayDailyBytes, Date.now());
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.a.engine.get(t.id)?.state === 'failed');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('RELAY_LIMIT_EXCEEDED');
  });

  it('accepts relay candidates in signalling only for a relay-mode link', async () => {
    const t = await setupPair({ 'proj/a.txt': 'hello' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    t.a.ports.linkFactory = { create: () => deadLink() };
    t.b.ports.linkFactory = { create: () => deadLink() };
    const content = (relay: boolean, gen: number) => ({ op: 'content', transferId: t.id, selectionDigest: t.rec.selectionDigest, linkGen: gen, linkKeyB64: Buffer.alloc(32, 1).toString('base64'), ...(relay ? { relay: true } : {}) });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.b.engine.get(t.id)?.state === 'linking');
    const gen1 = t.b.engine.get(t.id)!.linkGen;
    const sig = (kind: string, gen: number) => t.b.engine.handlePeerOp(t.a.id, { op: 'signal', transferId: t.id, linkGen: gen, signal: kind === 'candidate' ? { kind, candidate: CAND_RELAY } : { kind, sdp: SDP_RELAY } });
    expect(await sig('candidate', gen1)).toMatchObject({ ok: false, code: 'RELAY_CANDIDATE_REFUSED' });
    expect(await sig('offer', gen1)).toMatchObject({ ok: false, code: 'RELAY_CANDIDATE_REFUSED' });
    // a relay-mode content op (real content from the source is reused for validity)
    const real = t.a.engine.get(t.id)!.content;
    const r = await t.b.engine.handlePeerOp(t.a.id, { ...content(true, gen1 + 1), content: real });
    expect(r.ok).toBe(true);
    expect(await sig('candidate', gen1 + 1)).toMatchObject({ ok: true });
    expect(await sig('offer', gen1 + 1)).toMatchObject({ ok: true });
  });

  it('the target refuses a relay content op when it disallows relays', async () => {
    const t = await setupPair({ 'proj/a.txt': 'hello' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    t.a.ports.linkFactory = { create: () => deadLink() };
    t.b.ports.linkFactory = { create: () => deadLink() };
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => t.b.engine.get(t.id)?.state === 'linking');
    t.b.engine.setRelayAllowed(false);
    const gen = t.b.engine.get(t.id)!.linkGen + 1;
    const r = await t.b.engine.handlePeerOp(t.a.id, { op: 'content', transferId: t.id, selectionDigest: t.rec.selectionDigest, content: t.a.engine.get(t.id)!.content, linkGen: gen, linkKeyB64: Buffer.alloc(32, 1).toString('base64'), relay: true });
    expect(r).toMatchObject({ ok: false, code: 'RELAY_NOT_ALLOWED' });
  });
});

describe('set_relay owner command', () => {
  it('toggles the setting for verified owners only and validates the argument', async () => {
    const t = await setupPair({ 'proj/a.txt': 'x' });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    configureProjectTransfer(t.a.ports);
    const eng = (await import('../../src/transfer/runtime.js')).getProjectTransferEngine()!;
    const spec = getDaemonCommandRegistry().get('project_transfer_set_relay')!;
    expect(spec.sources).toEqual(['p2p', 'standalone']);
    // forged fields are not an ownership proof
    expect(await (spec.run as any)({}, { allowRelay: false, ownerVerified: true, source: 'p2p' })).toMatchObject({ success: false, code: 'OWNER_INGRESS_REQUIRED' });
    expect(eng.relayAllowed()).toBe(true);
    const proof = () => issueTrustedOwnerIngressProof({ source: 'p2p', peerId: 'dash-1', ownerVerified: true });
    expect(await (spec.run as any)({}, markTrustedOwnerIngress({ allowRelay: 'no' }, proof()))).toMatchObject({ success: false, code: 'INVALID_ARGS' });
    expect(await (spec.run as any)({}, markTrustedOwnerIngress({ allowRelay: false }, proof()))).toMatchObject({ success: true, relayAllowed: false });
    expect(eng.relayAllowed()).toBe(false);
    const caps = getDaemonCommandRegistry().get('project_transfer_capabilities')!;
    expect(await (caps.run as any)({}, markTrustedOwnerIngress({}, proof()))).toMatchObject({ success: true, relayAllowed: false });
    expect(await (spec.run as any)({}, markTrustedOwnerIngress({ allowRelay: true }, proof()))).toMatchObject({ success: true, relayAllowed: true });
  });
});
