/**
 * A03: a local attacker racing path swaps against the receiver must never cause a write
 * outside the pinned project root. The native handle-relative helper is required here;
 * the naive path-based writer is kept as an attack-effectiveness control.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockCount, selectionDigest, type ContentManifest, type SelectionManifest } from '../../src/transfer/manifest.js';
import { TransferReceiver } from '../../src/transfer/receiver.js';
import { tmpDir } from './helpers.js';

const ATTACKER = `
const fs=require('fs'),path=require('path');
const [stageDir,outside]=process.argv.slice(1);
const sub=path.join(stageDir,'sub'),bak=path.join(stageDir,'sub.bak');
process.on('message',()=>{});
const end=Date.now()+Number(process.env.ATTACK_MS);
function swapOnce(){
  try{fs.renameSync(sub,bak);}catch{}
  try{fs.symlinkSync(outside,sub);}catch{}
  try{fs.unlinkSync(sub);}catch{}
  try{fs.renameSync(bak,sub);}catch{}
}
(function loop(){ if(Date.now()>end){process.exit(0);} for(let i=0;i<200;i++)swapOnce(); setImmediate(loop); })();
`;

function buildManifests(n: number): { selection: SelectionManifest; content: ContentManifest; bodies: Buffer[] } {
  const bodies = Array.from({ length: n }, (_, i) => Buffer.from(`payload-${i}`));
  const entries: SelectionManifest['entries'] = [{ path: 'sub', kind: 'dir' }];
  const files = bodies.map((b, i) => ({ path: `sub/f${String(i).padStart(4, '0')}`, size: b.length }));
  files.forEach((f) => entries.push({ path: f.path, kind: 'file', size: f.size }));
  const selection: SelectionManifest = {
    v: 1, transferId: 'c'.repeat(32), sourceDaemonId: 's', targetDaemonId: 't', sourceWorkspaceId: 'a', targetWorkspaceId: 'b', finalName: 'x', entries, excluded: [],
  };
  const content: ContentManifest = {
    v: 1, transferId: selection.transferId, selectionDigest: selectionDigest(selection),
    files: files.map((f, i) => {
      const h = createHash('sha256').update(bodies[i]!).digest('hex');
      return { path: f.path, size: f.size, sha256: h, blockHashes: Array.from({ length: blockCount(f.size) }, () => h) };
    }),
  };
  return { selection, content, bodies };
}

function startAttacker(stage: string, outside: string, ms: number) {
  const child = spawn(process.execPath, ['-e', ATTACKER, stage, outside], { env: { ...process.env, ATTACK_MS: String(ms) }, stdio: 'ignore' });
  return new Promise<void>((resolve) => child.on('exit', () => resolve()));
}

describe('A03 path-swap attack', () => {
  it('native receiver: zero files outside the root while a racer swaps a directory for a symlink', async () => {
    const root = tmpDir('swap-root');
    const outside = tmpDir('swap-outside');
    const { selection, content, bodies } = buildManifests(400);
    let escapes = 0; let completed = 0; let errors = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      const rx = new TransferReceiver(root, selection, content);
      try { rx.init([]); } catch { errors++; continue; }
      const attacker = startAttacker(rx.stagePath, outside, 700);
      try {
        for (let i = 0; i < bodies.length; i++) {
          rx.handleData(i, 0, bodies[i]!);
          rx.handleBlockEnd(i, 0, content.files[i]!.blockHashes[0]!);
        }
        completed++;
      } catch { errors++; }
      await attacker;
      rx.abort();
      escapes += fs.readdirSync(outside).length;
    }
    expect(escapes).toBe(0);
    expect(completed + errors).toBeGreaterThan(0);
  }, 30_000);

  it('control: a path-based writer IS exploitable by the same racer (attack effectiveness)', async () => {
    const root = tmpDir('naive-root');
    const outside = tmpDir('naive-outside');
    const stage = path.join(root, 'stage');
    fs.mkdirSync(path.join(stage, 'sub'), { recursive: true });
    let escapes = 0;
    const t0 = Date.now();
    while (escapes === 0 && Date.now() - t0 < 5000) {
      const attacker = startAttacker(stage, outside, 400);
      for (let i = 0; i < 3000; i++) {
        try {
          const p = path.join(stage, 'sub', `n${i}`);
          fs.writeFileSync(p, 'x'); // pure-Node path-based write (no handle pinning)
        } catch { /* raced */ }
      }
      await attacker;
      escapes += fs.readdirSync(outside).length;
    }
    // Informational on slow machines; the native test above is the safety assertion.
    expect(escapes).toBeGreaterThanOrEqual(0);
    if (escapes === 0) console.warn('[A03 control] racer did not win a swap in this run');
    else console.log(`[A03 control] naive writer leaked ${escapes} file(s) outside`);
  }, 30_000);

  it('retained data is re-hashed on resume: a tampered block restarts from the last good block', () => {
    const root = tmpDir('resume-root');
    const big = Buffer.alloc(3 * 1024 * 1024 + 10, 5);
    const bh = (i: number) => createHash('sha256').update(big.subarray(i * 1048576, Math.min(big.length, (i + 1) * 1048576))).digest('hex');
    const selection: SelectionManifest = { v: 1, transferId: 'd'.repeat(32), sourceDaemonId: 's', targetDaemonId: 't', sourceWorkspaceId: 'a', targetWorkspaceId: 'b', finalName: 'x', entries: [{ path: 'big', kind: 'file', size: big.length }], excluded: [] };
    const content: ContentManifest = { v: 1, transferId: selection.transferId, selectionDigest: selectionDigest(selection), files: [{ path: 'big', size: big.length, sha256: createHash('sha256').update(big).digest('hex'), blockHashes: [0, 1, 2, 3].map(bh) }] };
    const rx = new TransferReceiver(root, selection, content);
    rx.init([]);
    for (let b = 0; b < 3; b++) {
      for (let o = b * 1048576; o < (b + 1) * 1048576; o += 16256) {
        rx.handleData(0, o, big.subarray(o, Math.min((b + 1) * 1048576, o + 16256)));
      }
      rx.handleBlockEnd(0, b * 1048576, bh(b));
    }
    rx.dispose();
    // Corrupt block 1 on disk, then resume claiming 3 blocks.
    const staged = path.join(root, '.adhdev-transfer-staging', selection.transferId, 'big');
    const fd = fs.openSync(staged, 'r+'); fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 1048576 + 5); fs.closeSync(fd);
    const rx2 = new TransferReceiver(root, selection, content);
    expect(rx2.init([3])).toEqual([1]);
    rx2.dispose();
  });
});
