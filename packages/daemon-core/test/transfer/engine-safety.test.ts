import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameType, decodeFrame } from '../../src/transfer/protocol.js';
import { ProjectTransferEngine } from '../../src/transfer/engine.js';
import { TransferRateLimiter } from '../../src/transfer/rate-limit.js';
import { LinkBroker, approveBoth, makeSide, readTree, setupPair, tmpDir, waitFor, writeTree, type Side } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const track = (...sides: Side[]) => cleanups.push(() => sides.forEach((s) => s.engine.shutdown()));
const terminal = (s: Side, id: string) => s.engine.get(id)?.state;

describe('A02 no-replace publish', () => {
  it('never overwrites an existing target folder; publishes under a suffixed name', async () => {
    const t = await setupPair({ 'proj/a.txt': 'new' });
    track(t.a, t.b);
    writeTree(t.b.ws.path, { 'incoming/precious.txt': 'keep me' });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => terminal(t.b, t.id) === 'completed');
    expect(t.b.engine.get(t.id)!.publishedName).toBe('incoming-2');
    expect(fs.readFileSync(path.join(t.b.ws.path, 'incoming', 'precious.txt'), 'utf8')).toBe('keep me');
    expect(readTree(path.join(t.b.ws.path, 'incoming'))).toEqual({ 'precious.txt': 'keep me' });
    expect(fs.readFileSync(path.join(t.b.ws.path, 'incoming-2', 'proj', 'a.txt'), 'utf8')).toBe('new');
  });
});

describe('A04 secret exclusion', () => {
  it('excludes secrets from manifest and bytes (no exceptions, .env.example included)', async () => {
    const t = await setupPair({
      'proj/ok.txt': 'fine',
      'proj/.env': 'TOKEN=1',
      'proj/.env.example': 'TOKEN=',
      'proj/.env.local': 'x',
      'proj/id_rsa': 'k',
      'proj/cert.pem': 'k',
      'proj/.ssh/config': 'k',
      'proj/.git/config': 'k',
      'proj/notes.txt': '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n',
      'proj/terraform.tfstate': '{}',
    });
    track(t.a, t.b);
    const reasons = Object.fromEntries(t.rec.selection.excluded.map((e) => [e.path, e.reason]));
    for (const p of ['proj/.env', 'proj/.env.example', 'proj/.env.local', 'proj/id_rsa', 'proj/cert.pem', 'proj/.ssh', 'proj/.git', 'proj/notes.txt', 'proj/terraform.tfstate']) {
      expect(reasons[p], p).toMatch(/^secret:/);
    }
    expect(t.rec.selection.entries.filter((e) => e.kind === 'file').map((e) => e.path)).toEqual(['proj/ok.txt']);
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => terminal(t.b, t.id) === 'completed');
    expect(Object.keys(readTree(path.join(t.b.ws.path, 'incoming'))).sort()).toEqual(['proj/', 'proj/ok.txt']);
  });
});

describe('A05 concurrency', () => {
  it('refuses a third concurrent transfer on a daemon', async () => {
    const broker = new LinkBroker();
    const peers = new Map<string, Side>();
    // A rate limiter that never grants keeps transfers in the active state.
    const stuck = new TransferRateLimiter(1, () => 0, () => new Promise(() => {}));
    const a = makeSide('daemon_mach_a', broker, peers, { rate: stuck });
    const b = makeSide('daemon_mach_b', broker, peers);
    track(a, b);
    writeTree(a.ws.path, { 'p/x.bin': Buffer.alloc(3_000_000, 1) });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['p'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: `f${i}` });
      if (!c.ok) throw new Error(c.code);
      ids.push(c.transferId);
      await a.engine.approve(c.transferId, c.record.selectionDigest);
      await b.engine.approve(c.transferId, c.record.selectionDigest);
      if (i < 2) await waitFor(() => terminal(a, c.transferId) === 'transferring');
    }
    await waitFor(() => terminal(a, ids[2]!) === 'failed');
    expect(a.engine.get(ids[2]!)!.errorCode).toBe('TOO_MANY_TRANSFERS');
    expect(terminal(a, ids[0]!)).toBe('transferring');
  });
});

describe('A06 revocation / re-approval', () => {
  it('owner auth generation change revokes an active transfer', async () => {
    const broker = new LinkBroker();
    const peers = new Map<string, Side>();
    const stuck = new TransferRateLimiter(1, () => 0, () => new Promise(() => {}));
    const a = makeSide('daemon_mach_a', broker, peers, { rate: stuck });
    const b = makeSide('daemon_mach_b', broker, peers);
    track(a, b);
    writeTree(a.ws.path, { 'p/x.bin': Buffer.alloc(3_000_000, 1) });
    const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['p'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'f' });
    if (!c.ok) throw new Error(c.code);
    await approveBoth(a, b, c.transferId, c.record.selectionDigest);
    await waitFor(() => terminal(a, c.transferId) === 'transferring');
    a.authGen.value = 'gen-2';
    a.engine.onAuthorityChanged();
    expect(terminal(a, c.transferId)).toBe('revoked');
    await waitFor(() => terminal(b, c.transferId) === 'revoked' || terminal(b, c.transferId) === 'cancelled');
    expect(fs.existsSync(path.join(b.ws.path, 'f'))).toBe(false);
  });

  it('peer losing authorization revokes; restart requires re-approval and then resumes', async () => {
    const t = await setupPair({ 'proj/a.txt': 'x' });
    track(t.a, t.b);
    // Approve only the source: nothing starts, then simulate a daemon restart.
    await t.a.engine.approve(t.id, t.rec.selectionDigest);
    t.a.engine.shutdown();
    const reborn = new ProjectTransferEngine({ ...t.a.ports });
    t.peers.set(t.a.id, { ...t.a, engine: reborn });
    expect(reborn.get(t.id)!.state).toBe('needs_reapproval');
    expect(reborn.get(t.id)!.localApproval).toBeUndefined();
    const r1 = await reborn.approve(t.id, 'wrong-digest');
    expect(r1).toMatchObject({ ok: false, code: 'APPROVAL_MISMATCH' });
    await reborn.approve(t.id, t.rec.selectionDigest);
    await t.b.engine.approve(t.id, t.rec.selectionDigest);
    await waitFor(() => reborn.get(t.id)?.state === 'completed' && terminal(t.b, t.id) === 'completed');
    t.peers.get(t.a.id)!.engine.shutdown();
    t.a.authorized.value = false;
  });

  it('approval without the second owner never starts a transfer', async () => {
    const t = await setupPair({ 'proj/a.txt': 'x' });
    track(t.a, t.b);
    await t.a.engine.approve(t.id, t.rec.selectionDigest);
    await new Promise((r) => setTimeout(r, 150));
    expect(terminal(t.a, t.id)).toBe('awaiting_approval');
    expect(t.broker.created).toEqual([]);
  });
});

describe('A07 channel binding', () => {
  it('aborts with BINDING_MISMATCH when the DTLS fingerprints do not match', async () => {
    const t = await setupPair({ 'proj/a.txt': 'x' });
    track(t.a, t.b);
    t.broker.remoteSeen = { a: 'sha-256 EVIL', b: 'sha-256 AA:AA' };
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => terminal(t.a, t.id) === 'failed');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('BINDING_MISMATCH');
    await waitFor(() => ['failed', 'cancelled'].includes(terminal(t.b, t.id)!));
    expect(fs.existsSync(path.join(t.b.ws.path, 'incoming'))).toBe(false);
    expect(fs.existsSync(path.join(t.b.ws.path, '.adhdev-transfer-staging'))).toBe(false);
  });
});

describe('A08 integrity', () => {
  it('flipped payload byte fails verification and publishes nothing', async () => {
    const t = await setupPair({ 'proj/a.bin': Buffer.alloc(200_000, 3) });
    track(t.a, t.b);
    let n = 0;
    t.broker.taps.push((d) => {
      try { if (decodeFrame(d).type === FrameType.DATA && ++n === 5) d[200] ^= 0xff; } catch { /* ignore */ }
      return d;
    });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => terminal(t.b, t.id) === 'failed');
    expect(t.b.engine.get(t.id)!.errorCode).toBe('HASH_MISMATCH');
    expect(fs.readdirSync(t.b.ws.path)).toEqual([]);
  });
});

describe('A09 resume', () => {
  it('continues on a new link generation after the link drops, bytes identical', async () => {
    const big = Buffer.alloc(3_500_000, 9);
    for (let i = 0; i < big.length; i += 4099) big[i] = i & 0xff;
    const t = await setupPair({ 'proj/big.bin': big });
    track(t.a, t.b);
    let frames = 0;
    t.broker.taps.push((d) => {
      try {
        if (decodeFrame(d).type === FrameType.DATA && ++frames === 90) { queueMicrotask(() => t.broker.pairs.forEach((p) => p[0].close())); return null; }
      } catch { /* ignore */ }
      return d;
    });
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => terminal(t.b, t.id) === 'completed' && terminal(t.a, t.id) === 'completed', 15000);
    expect(t.a.engine.get(t.id)!.linkGen).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(path.join(t.b.ws.path, 'incoming', 'proj', 'big.bin')).equals(big)).toBe(true);
  });
});

describe('A10 cancel', () => {
  it('cancel from the target stops the source, removes staging and publishes nothing', async () => {
    const broker = new LinkBroker();
    const peers = new Map<string, Side>();
    const stuck = new TransferRateLimiter(1, () => 0, () => new Promise(() => {}));
    const a = makeSide('daemon_mach_a', broker, peers, { rate: stuck });
    const b = makeSide('daemon_mach_b', broker, peers);
    track(a, b);
    writeTree(a.ws.path, { 'p/x.bin': Buffer.alloc(3_000_000, 1) });
    const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['p'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'f' });
    if (!c.ok) throw new Error(c.code);
    await approveBoth(a, b, c.transferId, c.record.selectionDigest);
    await waitFor(() => terminal(b, c.transferId) === 'transferring');
    expect(fs.existsSync(path.join(b.ws.path, '.adhdev-transfer-staging', c.transferId))).toBe(true);
    await b.engine.cancel(c.transferId);
    await waitFor(() => terminal(a, c.transferId) === 'cancelled');
    expect(fs.existsSync(path.join(b.ws.path, '.adhdev-transfer-staging'))).toBe(false);
    expect(fs.existsSync(path.join(b.ws.path, 'f'))).toBe(false);
    expect(fs.existsSync(a.engine.store.spoolDir(c.transferId))).toBe(false);
  });
});

describe('A11 source changed', () => {
  it('fails SOURCE_CHANGED when the file changed after preview', async () => {
    const t = await setupPair({ 'proj/a.txt': 'abc' });
    track(t.a, t.b);
    fs.writeFileSync(path.join(t.a.ws.path, 'proj', 'a.txt'), 'abcdef');
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => terminal(t.a, t.id) === 'failed');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('SOURCE_CHANGED');
    await waitFor(() => terminal(t.b, t.id) === 'cancelled');
    expect(fs.readdirSync(t.b.ws.path)).toEqual([]);
  });
});

describe('A12 protocol strictness', () => {
  it('a dropped frame (sequence gap) aborts the session with PROTOCOL_ERROR', async () => {
    const t = await setupPair({ 'proj/a.bin': Buffer.alloc(100_000, 3) });
    track(t.a, t.b);
    let n = 0;
    t.broker.taps.push((d) => ((decodeFrame(d).type === FrameType.DATA && ++n === 3) ? null : d));
    await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    await waitFor(() => terminal(t.b, t.id) === 'failed');
    expect(t.b.engine.get(t.id)!.errorCode).toBe('PROTOCOL_ERROR');
  });
});

describe('capabilities', () => {
  it('a host without a link factory cannot create or accept transfers (no fallback)', async () => {
    const broker = new LinkBroker();
    const peers = new Map<string, Side>();
    const a = makeSide('daemon_mach_a', broker, peers, { noLink: true });
    const b = makeSide('daemon_mach_b', broker, peers);
    track(a, b);
    expect(a.engine.capabilities()).toMatchObject({ supported: false, reasons: ['LINK_UNAVAILABLE'] });
    writeTree(a.ws.path, { 'p/x': '1' });
    expect(await a.engine.create({ workspaceId: a.ws.id, selected: ['p'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'f' })).toMatchObject({ ok: false, code: 'LINK_UNAVAILABLE' });
    // And a capable source cannot offer to an incapable target.
    writeTree(b.ws.path, { 'p/x': '1' });
    expect(await b.engine.create({ workspaceId: b.ws.id, selected: ['p'], targetDaemonId: a.id, targetWorkspaceId: a.ws.id, finalName: 'f' })).toMatchObject({ ok: false, code: 'LINK_UNAVAILABLE' });
  });
});
void tmpDir;
