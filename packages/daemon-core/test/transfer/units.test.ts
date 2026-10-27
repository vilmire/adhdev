import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRANSFER_LIMITS, TRANSFER_RETENTION_MS } from '../../src/transfer/limits.js';
import { ManifestError, selectionDigest, validateSelectionManifest, type SelectionManifest } from '../../src/transfer/manifest.js';
import { FrameType, bindingTagsEqual, computeBindingTag, decodeFrame, encodeFrame, extractSdpFingerprint } from '../../src/transfer/protocol.js';
import { TransferRateLimiter } from '../../src/transfer/rate-limit.js';
import { matchSecretPath, sniffSecretContent } from '../../src/transfer/secret-exclusion.js';
import { TransferStore, type TransferRecord } from '../../src/transfer/store.js';
import { tmpDir } from './helpers.js';

const base = (entries: SelectionManifest['entries']): SelectionManifest => ({
  v: 1, transferId: 'a'.repeat(32), sourceDaemonId: 's', targetDaemonId: 't', sourceWorkspaceId: 'ws1', targetWorkspaceId: 'ws2',
  finalName: 'dest', entries, excluded: [],
});
const GIB = 1024 ** 3;
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return (e as ManifestError).code; } return undefined; };

describe('A05 limits (boundaries)', () => {
  it('entry count: 1000 ok, 1001 rejected', () => {
    const mk = (n: number) => base(Array.from({ length: n }, (_, i) => ({ path: `d${i}`, kind: 'dir' as const })));
    expect(code(() => validateSelectionManifest(mk(1000)))).toBeUndefined();
    expect(code(() => validateSelectionManifest(mk(1001)))).toBe('LIMIT_EXCEEDED');
  });
  it('per-file 2 GiB ok, +1 byte rejected', () => {
    expect(code(() => validateSelectionManifest(base([{ path: 'f', kind: 'file', size: 2 * GIB }])))).toBeUndefined();
    expect(code(() => validateSelectionManifest(base([{ path: 'f', kind: 'file', size: 2 * GIB + 1 }])))).toBe('LIMIT_EXCEEDED');
  });
  it('transfer total 5 GiB ok, +1 byte rejected', () => {
    const three = (last: number) => base([{ path: 'a', kind: 'file', size: 2 * GIB }, { path: 'b', kind: 'file', size: 2 * GIB }, { path: 'c', kind: 'file', size: last }]);
    expect(code(() => validateSelectionManifest(three(GIB)))).toBeUndefined();
    expect(code(() => validateSelectionManifest(three(GIB + 1)))).toBe('LIMIT_EXCEEDED');
  });
  it('manifest serialised size is capped at 2 MiB', () => {
    const long = 'x'.repeat(1000);
    const m = base([{ path: 'a', kind: 'file', size: 1 }]);
    m.excluded = Array.from({ length: 4000 }, (_, i) => ({ path: `${long}${i}`, reason: 'secret:x' }));
    expect(code(() => validateSelectionManifest(m))).toBe('LIMIT_EXCEEDED');
  });
  it('rejects traversal, case collisions, missing parents', () => {
    expect(code(() => validateSelectionManifest(base([{ path: '../x', kind: 'file', size: 1 }])))).toBe('PATH_REJECTED');
    expect(code(() => validateSelectionManifest(base([{ path: 'A', kind: 'dir' }, { path: 'a', kind: 'dir' }])))).toBe('CASE_COLLISION');
    expect(code(() => validateSelectionManifest(base([{ path: 'd/f', kind: 'file', size: 1 }])))).toBe('MANIFEST_INVALID');
    expect(code(() => validateSelectionManifest(base([{ path: 'C:x', kind: 'file', size: 1 }])))).toBe('PATH_REJECTED');
  });
  it('digest is order independent and changes with exclusions', () => {
    const a = base([{ path: 'b', kind: 'file', size: 1 }, { path: 'a', kind: 'file', size: 2 }]);
    const b = base([{ path: 'a', kind: 'file', size: 2 }, { path: 'b', kind: 'file', size: 1 }]);
    expect(selectionDigest(a)).toBe(selectionDigest(b));
    expect(selectionDigest({ ...a, excluded: [{ path: 'x', reason: 'r' }] })).not.toBe(selectionDigest(a));
  });
  it('retention constants match D3', () => {
    expect(TRANSFER_RETENTION_MS).toMatchObject({ preview: 900_000, consent: 86_400_000, tempIdle: 86_400_000, tempMax: 604_800_000, receipt: 604_800_000, audit: 2_592_000_000 });
    expect(TRANSFER_LIMITS).toMatchObject({ maxConcurrentPerDaemon: 2, totalBytesPerSecond: 4 * 1024 * 1024, maxFrameBytes: 16384, frameHeaderBytes: 128 });
  });
});

describe('A04 secret rules (unit)', () => {
  it.each([
    '.env', '.env.example', '.env.production', 'app/prod.env', 'a/.ssh/id_ed25519', 'id_rsa.pub', 'k.pem', 'cert.p12', 'x/.aws/credentials',
    '.npmrc', 'infra/terraform.tfstate', 'infra/prod.tfvars', 'client_secret_123.json', 'service-account-prod.json', '.git/config', '.config/gh/hosts.yml',
    '.dev.vars', 'secrets.yaml', 'db.kdbx', 'a/.kube/config', 'Credentials.JSON', '.adhdev/config.json',
  ])('excludes %s', (p) => expect(matchSecretPath(p)).not.toBeNull());
  it.each(['README.md', 'src/environment.ts', 'src/index.ts', 'envelope.txt', 'docs/secret-santa.md.txt'])('does not exclude %s', (p) => {
    expect(matchSecretPath(p)).toBeNull();
  });
  it('content sniff only adds exclusions', () => {
    expect(sniffSecretContent(Buffer.from('-----BEGIN RSA PRIVATE KEY-----\n'))).toBe('private-key-content');
    expect(sniffSecretContent(Buffer.from('-----BEGIN PUBLIC KEY-----\n'))).toBeNull();
  });
});

describe('A12 frame codec', () => {
  const ok = { type: FrameType.DATA, transferId: 'b'.repeat(32), fileIndex: 3, offset: 12345, seq: 9, payload: Buffer.from('hi') };
  it('round-trips and is <= 16 KiB with a 128 byte header', () => {
    const buf = encodeFrame(ok);
    expect(buf.length).toBe(128 + 2);
    expect(decodeFrame(buf)).toEqual(ok);
    expect(encodeFrame({ ...ok, payload: Buffer.alloc(16_384 - 128) }).length).toBe(16_384);
    expect(() => encodeFrame({ ...ok, payload: Buffer.alloc(16_384 - 128 + 1) })).toThrow();
  });
  it('rejects bad magic, type, length, reserved bytes, oversize', () => {
    const buf = encodeFrame(ok);
    const mut = (fn: (b: Buffer) => void) => { const c = Buffer.from(buf); fn(c); return () => decodeFrame(c); };
    expect(mut((b) => { b[0] = 0; })).toThrow();
    expect(mut((b) => { b[4] = 99; })).toThrow();
    expect(mut((b) => { b[36] = 9; })).toThrow();
    expect(mut((b) => { b[60] = 1; })).toThrow();
    expect(() => decodeFrame(Buffer.alloc(16_385))).toThrow();
    expect(() => decodeFrame(Buffer.alloc(10))).toThrow();
  });
  it('binding tag depends on key, generation and both fingerprints', () => {
    const k = Buffer.alloc(32, 1);
    const t = computeBindingTag(k, 'x', 1, 'fpA', 'fpB');
    expect(bindingTagsEqual(t, computeBindingTag(k, 'x', 1, 'fpB', 'fpA'))).toBe(true);
    expect(bindingTagsEqual(t, computeBindingTag(k, 'x', 2, 'fpA', 'fpB'))).toBe(false);
    expect(bindingTagsEqual(t, computeBindingTag(k, 'x', 1, 'fpA', 'fpEVIL'))).toBe(false);
    expect(bindingTagsEqual(t, computeBindingTag(Buffer.alloc(32, 2), 'x', 1, 'fpA', 'fpB'))).toBe(false);
    expect(extractSdpFingerprint('v=0\r\na=fingerprint:sha-256 ab:CD\r\n')).toBe('sha-256 AB:CD');
  });
});

describe('rate limit 4 MiB/s', () => {
  it('paces to the configured rate (fake clock)', async () => {
    let now = 0;
    const slept: number[] = [];
    const rl = new TransferRateLimiter(4 * 1024 * 1024, () => now, async (ms) => { slept.push(ms); now += ms; });
    const chunk = 1024 * 1024;
    const t0 = now;
    for (let i = 0; i < 12; i++) await rl.take(chunk); // 12 MiB with a 4 MiB burst
    const elapsedSec = (now - t0) / 1000;
    expect(elapsedSec).toBeGreaterThanOrEqual(1.95);
    expect(elapsedSec).toBeLessThan(2.3);
  });
});

describe('retention / GC', () => {
  const rec = (id: string, over: Partial<TransferRecord>): TransferRecord => ({
    v: 1, id, role: 'target', peerDaemonId: 'p', selection: base([{ path: 'a', kind: 'file', size: 1 }]), selectionDigest: 'd', state: 'transferring',
    createdAt: 0, updatedAt: 0, activityAt: 0, previewExpiresAt: 0, linkGen: 1, blocksDone: [], bytesDone: 0, totalBytes: 1, ...over,
  });
  it('flags idle >24h and age >7d temp data; keeps fresh; prunes receipts>7d and audit>30d', () => {
    const s = new TransferStore(tmpDir('store'));
    const H = 3_600_000;
    const now = 40 * 24 * H;
    s.save(rec('a'.repeat(32), { activityAt: now - 25 * H, createdAt: now - 26 * H }));
    s.save(rec('b'.repeat(32), { activityAt: now - H, createdAt: now - 8 * 24 * H }));
    s.save(rec('c'.repeat(32), { activityAt: now - H, createdAt: now - 2 * H }));
    expect(s.gc(now).staleTempIds.sort()).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    s.audit({ id: 'x'.repeat(32), role: 'source', event: 'old' }, now - 31 * 24 * H);
    s.audit({ id: 'y'.repeat(32), role: 'source', event: 'new', files: 1 }, now - H);
    s.gc(now);
    const lines = fs.readFileSync(`${s.baseDir}/audit.jsonl`, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/path|name/i);
  });
});
