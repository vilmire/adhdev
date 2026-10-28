/** Regression tests for the independent security review of project file transfer (M1-M5, L1-L7). */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManifestError, selectionDigest, validateSelectionManifest, type ContentManifest, type SelectionManifest } from '../../src/transfer/manifest.js';
import { FrameType, computeBindingTag, decodeFrame, encodeFrame, extractSdpFingerprint, jsonPayload, sdpHasRelayCandidate } from '../../src/transfer/protocol.js';
import { ReceiverSession, SenderSession } from '../../src/transfer/link-session.js';
import type { TransferLink } from '../../src/transfer/link.js';
import { TransferRateLimiter } from '../../src/transfer/rate-limit.js';
import { TransferReceiver, ReceiverError } from '../../src/transfer/receiver.js';
import { requireFreeDisk } from '../../src/transfer/spool.js';
import { configureProjectTransfer, resetProjectTransferForTest } from '../../src/transfer/runtime.js';
import { SECRET_SNIFF_BYTES, matchSecretPath, sniffSecretContent } from '../../src/transfer/secret-exclusion.js';
import { LinkBroker, approveBoth, makeSide, setupPair, tmpDir, waitFor, writeTree, type Side } from './helpers.js';

const diskStub = vi.hoisted(() => ({ fake: false }));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, statfsSync: (...a: Parameters<typeof actual.statfsSync>) => (diskStub.fake ? ({ bavail: 0, bsize: 4096 } as never) : actual.statfsSync(...a)) };
});

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetProjectTransferForTest(); while (cleanups.length) cleanups.pop()!(); });
const track = (...sides: Side[]) => cleanups.push(() => sides.forEach((s) => s.engine.shutdown()));
const ID = 'c'.repeat(32);
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return undefined; };

const selection = (entries: SelectionManifest['entries'], id = ID): SelectionManifest => ({
  v: 1, transferId: id, sourceDaemonId: 'daemon_mach_a', targetDaemonId: 'daemon_mach_b',
  sourceWorkspaceId: 'ws-daemon_mach_a', targetWorkspaceId: 'ws-daemon_mach_b', finalName: 'dest', entries, excluded: [],
});

describe('M1 receiver enforces secret exclusion', () => {
  it('validateSelectionManifest rejects secret paths', () => {
    expect(code(() => validateSelectionManifest(selection([{ path: '.env', kind: 'file', size: 1 }])))).toBe('SECRET_PATH_REJECTED');
    expect(code(() => validateSelectionManifest(selection([{ path: '.ssh', kind: 'dir' }])))).toBe('SECRET_PATH_REJECTED');
    expect(code(() => validateSelectionManifest(selection([{ path: 'ok.txt', kind: 'file', size: 1 }])))).toBeUndefined();
  });
  it('a tampered offer carrying a secret path is refused by the target', async () => {
    const broker = new LinkBroker();
    const peers = new Map<string, Side>();
    makeSide('daemon_mach_a', broker, peers);
    const b = makeSide('daemon_mach_b', broker, peers);
    track(b);
    const sel = selection([{ path: 'id_rsa', kind: 'file', size: 3 }]);
    // Build the raw wire form (the source-side validator would refuse to even create this).
    const r = await b.engine.handlePeerOp('daemon_mach_a', { op: 'offer', transferId: ID, selection: sel, selectionDigest: selectionDigest(sel) });
    expect(r).toMatchObject({ ok: false, code: 'SECRET_PATH_REJECTED' });
    expect(b.engine.get(ID)).toBeNull();
  });
  it('verifyAll sniffs received bytes and refuses to publish key material', () => {
    const ws = tmpDir('rx-ws');
    const data = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n');
    const sha = createHash('sha256').update(data).digest('hex');
    const sel = selection([{ path: 'notes.txt', kind: 'file', size: data.length }]);
    const content: ContentManifest = { v: 1, transferId: ID, selectionDigest: selectionDigest(sel), files: [{ path: 'notes.txt', size: data.length, sha256: sha, blockHashes: [sha] }] };
    const rx = new TransferReceiver(ws, sel, content);
    try {
      rx.init();
      rx.handleData(0, 0, data);
      rx.handleBlockEnd(0, 0, sha);
      expect(code(() => rx.verifyAll())).toBe('SECRET_CONTENT_REJECTED');
    } finally { rx.abort(); }
  });
});

describe('M3 SDP fingerprint', () => {
  const fp = (v: string) => `a=fingerprint:sha-256 ${v}\r\n`;
  it('requires exactly one distinct fingerprint value', () => {
    expect(extractSdpFingerprint(`v=0\r\n${fp('AA:BB')}m=application\r\n${fp('aa:bb')}`)).toBe('sha-256 AA:BB');
    expect(extractSdpFingerprint(`v=0\r\n${fp('AA:BB')}m=application\r\n${fp('CC:DD')}`)).toBeNull();
    expect(extractSdpFingerprint('v=0\r\n')).toBeNull();
  });
});

describe('M2 relay candidates inside SDP', () => {
  const sdp = (cand: string) => `v=0\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 UDP 1 1.2.3.4 5 typ ${cand}\r\n`;
  it('sdpHasRelayCandidate detects relay lines only', () => {
    expect(sdpHasRelayCandidate(sdp('relay raddr 0.0.0.0 rport 0'))).toBe(true);
    expect(sdpHasRelayCandidate(sdp('host'))).toBe(false);
  });
  it('engine refuses an offer/answer SDP with a relay candidate or ambiguous fingerprint', async () => {
    const broker = new LinkBroker();
    const peers = new Map<string, Side>();
    // A rate limiter that never grants keeps the target waiting for data in 'transferring'.
    const a = makeSide('daemon_mach_a', broker, peers, { rate: new TransferRateLimiter(1, () => 0, () => new Promise(() => {})) });
    const b = makeSide('daemon_mach_b', broker, peers);
    track(a, b);
    writeTree(a.ws.path, { 'proj/x.bin': Buffer.alloc(3_000_000, 1) });
    const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['proj'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'in' });
    if (!c.ok) throw new Error(c.code);
    await approveBoth(a, b, c.transferId, c.record.selectionDigest);
    await waitFor(() => b.engine.get(c.transferId)?.state === 'transferring');
    const gen = b.engine.get(c.transferId)!.linkGen;
    const send = (signal: object) => b.engine.handlePeerOp('daemon_mach_a', { op: 'signal', transferId: c.transferId, linkGen: gen, signal });
    expect(await send({ kind: 'offer', sdp: sdp('relay raddr 0.0.0.0 rport 0') })).toMatchObject({ ok: false, code: 'RELAY_CANDIDATE_REFUSED' });
    expect(await send({ kind: 'answer', sdp: 'v=0\r\n' })).toMatchObject({ ok: false, code: 'SDP_FINGERPRINT_INVALID' });
    expect(await send({ kind: 'offer', sdp: sdp('host') })).toMatchObject({ ok: true });
  });
});

describe('M4 consent age is enforced on the hot path', () => {
  it('a stale approval cannot start a transfer even before the hourly sweep', async () => {
    const t = await setupPair({ 'proj/a.txt': 'x' });
    track(t.a, t.b);
    const base = Date.now();
    let clock = base;
    t.a.ports.now = () => clock;
    await t.a.engine.approve(t.id, t.rec.selectionDigest); // localApproval.at = base
    clock = base + 25 * 3_600_000;
    await t.b.engine.approve(t.id, t.rec.selectionDigest); // peer approval arrives -> maybeStart on A
    await waitFor(() => t.a.engine.get(t.id)?.state === 'expired');
    expect(t.a.engine.get(t.id)!.errorCode).toBe('CONSENT_EXPIRED');
    expect(t.a.engine.get(t.id)!.content).toBeUndefined();
  });
});

describe('M5 secret list additions', () => {
  it.each([
    'application_default_credentials.json', 'a/firebase-adminsdk-abc12.json', '.cargo/credentials', '.cargo/credentials.toml', 'x/.cargo/credentials.toml',
    '.yarnrc', '.yarnrc.yml', '.m2/settings.xml', 'gradle.properties', '.terraformrc', 'prod.tfrc', '.sentryclirc', 'rclone.conf',
    '.wrangler/state/x', '.vercel/project.json', '.netlify/state.json', '.config/rclone/rclone.conf',
    'AuthKey_ABC.p8', 'store.pkcs12', 'x.jceks', 'office.ovpn', 'login.keychain', 'login.keychain-db',
    '.bash_history', '.zsh_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', '.lesshst',
    'Chrome/Default/Login Data', 'Cookies', 'Web Data', 'logins.json', 'key4.db', 'cookies.sqlite',
    'config/credentials.json', 'config/credential.yaml', 'my-credentials.toml', 'credentials-prod.yml',
  ])('excludes %s', (p) => expect(matchSecretPath(p), p).not.toBeNull());
  it.each(['src/credentials.ts', 'docs/cargo.md', 'src/settings.xml', 'history.md', 'src/cookies.ts', 'wrangler.toml'])('keeps %s', (p) => expect(matchSecretPath(p), p).toBeNull());
  it('sniffs PGP private key blocks', () => {
    expect(sniffSecretContent(Buffer.from('-----BEGIN PGP PRIVATE KEY BLOCK-----\n'))).toBe('private-key-content');
    expect(sniffSecretContent(Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----\n'))).toBeNull();
    expect(SECRET_SNIFF_BYTES).toBeGreaterThan(0);
  });
});

describe('L1 caps and sweep cadence', () => {
  it('a target holds at most 10 open offers', async () => {
    const broker = new LinkBroker();
    const peers = new Map<string, Side>();
    makeSide('daemon_mach_a', broker, peers);
    const b = makeSide('daemon_mach_b', broker, peers);
    track(b);
    const offer = (i: number) => {
      const id = i.toString(16).padStart(32, 'a');
      const sel = selection([{ path: 'f.txt', kind: 'file', size: 1 }], id);
      return b.engine.handlePeerOp('daemon_mach_a', { op: 'offer', transferId: id, selection: sel, selectionDigest: selectionDigest(sel) });
    };
    for (let i = 0; i < 10; i++) expect((await offer(i)).ok, `offer ${i}`).toBe(true);
    expect(await offer(10)).toMatchObject({ ok: false, code: 'TOO_MANY_TRANSFERS' });
  });
  it('expiry sweep runs every minute', () => {
    vi.useFakeTimers();
    const broker = new LinkBroker();
    const side = makeSide('daemon_mach_a', broker, new Map());
    const eng = configureProjectTransfer(side.ports);
    const spy = vi.spyOn(eng, 'sweep');
    vi.advanceTimersByTime(61_000);
    expect(spy).toHaveBeenCalled();
    side.engine.shutdown();
  });
});

// ── fake link for session-level tests ─────────────────────────────────────────
function fakeLink() {
  const sent: Buffer[] = [];
  let onMsg: (d: Uint8Array) => void = () => {};
  let onOpen: () => void = () => {};
  const link: TransferLink = {
    send: (d) => { sent.push(Buffer.from(d)); return true; },
    bufferedAmount: () => 0,
    onMessage: (cb) => { onMsg = cb; },
    onOpen: (cb) => { onOpen = cb; },
    onClose: () => {},
    signalIn: () => {},
    onSignalOut: () => {},
    localFingerprint: () => 'sha-256 AA:AA',
    remoteFingerprint: () => 'sha-256 BB:BB',
    close: () => {},
  };
  return { link, sent, feed: (b: Uint8Array) => onMsg(b), open: () => onOpen() };
}
const KEY = Buffer.alloc(32, 7);
const emptyContent: ContentManifest = { v: 1, transferId: ID, selectionDigest: 'd', files: [] };
const mkSender = (link: TransferLink) => new SenderSession(link, ID, 1, KEY, emptyContent, tmpDir('spool'), new TransferRateLimiter(1e12));
const types = (sent: Buffer[]) => sent.map((b) => decodeFrame(b).type);
const peerHello = (role: 'sender' | 'receiver', tagRole = role) => encodeFrame({
  type: FrameType.HELLO, transferId: ID, fileIndex: 0, offset: 0, seq: 0,
  payload: jsonPayload({ tag: computeBindingTag(KEY, ID, 1, 'sha-256 AA:AA', 'sha-256 BB:BB', tagRole), role }),
});

describe('L3 HELLO role binding', () => {
  it('a HELLO reflected back to its author is rejected', () => {
    const f = fakeLink();
    const s = mkSender(f.link);
    s.wait().catch(() => {});
    f.open();
    expect(types(f.sent)).toEqual([FrameType.HELLO]);
    f.feed(f.sent[0]!); // reflection
    expect(types(f.sent)).toContain(FrameType.ABORT);
  });
  it('the genuine peer HELLO is accepted', () => {
    const f = fakeLink();
    const s = mkSender(f.link);
    s.wait().catch(() => {});
    f.open();
    f.feed(peerHello('receiver'));
    expect(types(f.sent)).not.toContain(FrameType.ABORT);
  });
});

describe('L4 liveness', () => {
  it('a peer that never completes HELLO is dropped at the HELLO deadline', async () => {
    vi.useFakeTimers();
    const f = fakeLink();
    const s = mkSender(f.link);
    let failed = false;
    s.wait().catch(() => { failed = true; });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(failed).toBe(true);
  });
  it('duplicate / replayed frames do not keep the link alive', async () => {
    vi.useFakeTimers();
    const f = fakeLink();
    const s = mkSender(f.link);
    let failed = false;
    s.wait().catch(() => { failed = true; });
    f.open();
    const hello = peerHello('receiver');
    f.feed(hello);
    await vi.advanceTimersByTimeAsync(40_000);
    f.feed(hello); // replay of seq 0: ignored, must not reset the idle timer
    await vi.advanceTimersByTimeAsync(25_000);
    expect(failed).toBe(true);
  });
});

describe('L5 owner-command path args are masked in the command log', () => {
  it('masks selected/path/finalName/publishedName for project_transfer_* only', async () => {
    const { maskCommandLogArgs } = await import('../../src/logging/command-log.js');
    const args = { workspaceId: 'ws1', selected: ['client-acme/contracts'], path: 'client-acme', finalName: 'acme-final', publishedName: 'acme-final-2' };
    const masked = JSON.stringify(maskCommandLogArgs(args, 'project_transfer_create'));
    for (const secret of ['client-acme', 'acme-final']) expect(masked).not.toContain(secret);
    expect(masked).toContain('ws1');
    expect(JSON.stringify(maskCommandLogArgs({ path: 'visible/dir' }, 'read_file'))).toContain('visible/dir');
  });
});

describe('L6 peer completion is only honoured where expected', () => {
  it('a premature or malformed completed op does not finish the source', async () => {
    const t = await setupPair({ 'proj/a.txt': 'x' });
    track(t.a, t.b);
    const early = await t.a.engine.handlePeerOp('daemon_mach_b', { op: 'state', transferId: t.id, state: 'completed', publishedName: 'x' });
    expect(early.ok).toBe(false);
    expect(t.a.engine.get(t.id)!.state).toBe('previewed');
    const rec = t.a.engine.get(t.id)!;
    rec.state = 'verifying';
    rec.content = { v: 1, transferId: t.id, selectionDigest: rec.selectionDigest, files: [] };
    const bad = await t.a.engine.handlePeerOp('daemon_mach_b', { op: 'state', transferId: t.id, state: 'completed', publishedName: '../evil' });
    expect(bad.ok).toBe(false);
    expect(t.a.engine.get(t.id)!.state).toBe('verifying');
    const good = await t.a.engine.handlePeerOp('daemon_mach_b', { op: 'state', transferId: t.id, state: 'completed', publishedName: 'incoming-2' });
    expect(good.ok).toBe(true);
    expect(t.a.engine.get(t.id)!.publishedName).toBe('incoming-2');
  });
});

describe('L7 disk checks', () => {
  it('requireFreeDisk never creates the directory', () => {
    const root = tmpDir('disk');
    const target = path.join(root, 'not', 'yet');
    requireFreeDisk(target, 1);
    expect(fs.existsSync(path.join(root, 'not'))).toBe(false);
  });
  it('the receiver re-checks free disk before each block', () => {
    const ws = tmpDir('rx-disk');
    const data = Buffer.from('hello');
    const sha = createHash('sha256').update(data).digest('hex');
    const sel = selection([{ path: 'a.txt', kind: 'file', size: data.length }]);
    const content: ContentManifest = { v: 1, transferId: ID, selectionDigest: selectionDigest(sel), files: [{ path: 'a.txt', size: data.length, sha256: sha, blockHashes: [sha] }] };
    const rx = new TransferReceiver(ws, sel, content);
    try {
      rx.init();
      diskStub.fake = true;
      let err: unknown;
      try { rx.handleData(0, 0, data); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ReceiverError);
      expect((err as ReceiverError).code).toBe('DISK_SPACE_EXHAUSTED');
    } finally { diskStub.fake = false; rx.abort(); }
  });
});

void ManifestError; void ReceiverSession;
