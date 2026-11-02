import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkBroker, makeSide, readTree, tmpDir, waitFor, writeTree, type Side } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function pair(src: Record<string, string>, dst: Record<string, string>, opts: { targetDir?: string; selected?: string[]; targetMode?: 'existing_path' | 'new_folder' } = {}) {
  const broker = new LinkBroker();
  const peers = new Map<string, Side>();
  const a = makeSide('daemon_mach_a', broker, peers);
  const b = makeSide('daemon_mach_b', broker, peers);
  cleanups.push(() => { a.engine.shutdown(); b.engine.shutdown(); });
  writeTree(a.ws.path, src);
  writeTree(b.ws.path, dst);
  const created = await a.engine.create({
    workspaceId: a.ws.id, selected: opts.selected ?? ['proj'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'x',
    targetMode: opts.targetMode ?? 'existing_path', targetDir: opts.targetDir ?? '',
  });
  return { a, b, created };
}

async function approveBoth(a: Side, b: Side, id: string) {
  const ra = a.engine.get(id)!;
  const rb = b.engine.get(id)!;
  const r1 = await a.engine.approve(id, ra.selectionDigest, ra.overwrite?.digest);
  const r2 = await b.engine.approve(id, rb.selectionDigest, rb.overwrite?.digest);
  return [r1, r2] as const;
}

describe('existing_path overwrite (O1-O5)', () => {
  it('previews new vs replaced, needs the matching digest, replaces in place, keeps target-only files and reverts', async () => {
    const { a, b, created } = await pair(
      { 'proj/a.txt': 'NEW-A', 'proj/b.txt': 'NEW-B', 'proj/sub/c.txt': 'NEW-C' },
      { 'proj/a.txt': 'OLD-A', 'proj/only-target.txt': 'KEEP' },
    );
    if (!created.ok) throw new Error(created.code);
    const id = created.transferId;
    const ov = a.engine.get(id)!.overwrite!;
    expect(ov.replaced.map((r) => r.path)).toEqual(['proj/a.txt']);
    expect(ov.newFiles).toHaveLength(2);
    // approval bound to the preview digest
    const bad = await a.engine.approve(id, a.engine.get(id)!.selectionDigest);
    expect(bad).toMatchObject({ ok: false, code: 'APPROVAL_MISMATCH' });
    const wrong = await a.engine.approve(id, a.engine.get(id)!.selectionDigest, 'f'.repeat(64));
    expect(wrong).toMatchObject({ ok: false, code: 'APPROVAL_MISMATCH' });
    const [r1, r2] = await approveBoth(a, b, id);
    expect(r1.ok && r2.ok).toBe(true);
    await waitFor(() => b.engine.get(id)?.state === 'completed' && a.engine.get(id)?.state === 'completed');
    const tree = readTree(b.ws.path);
    expect(tree['proj/a.txt']).toBe('NEW-A');
    expect(tree['proj/b.txt']).toBe('NEW-B');
    expect(tree['proj/sub/c.txt']).toBe('NEW-C');
    expect(tree['proj/only-target.txt']).toBe('KEEP');
    expect(fs.existsSync(path.join(b.ws.path, '.adhdev-transfer-staging'))).toBe(false);
    expect(fs.existsSync(path.join(b.engine.store.backupDir(id), 'files', 'proj', 'a.txt'))).toBe(true);
    // revert restores the original bytes; target-only and new files stay
    const rev = b.engine.revert(id);
    expect(rev.ok).toBe(true);
    expect(readTree(b.ws.path)['proj/a.txt']).toBe('OLD-A');
    expect(readTree(b.ws.path)['proj/only-target.txt']).toBe('KEEP');
    expect(b.engine.get(id)!.overwrite!.reverted).toBe(true);
    expect(b.engine.revert(id)).toMatchObject({ ok: false, code: 'ALREADY_REVERTED' });
    // the source cannot revert
    expect(a.engine.revert(id)).toMatchObject({ ok: false, code: 'NOT_TARGET' });
  });

  it('revert leaves a file the owner edited after the transfer and reports a conflict', async () => {
    const { a, b, created } = await pair({ 'proj/a.txt': 'NEW' }, { 'proj/a.txt': 'OLD' });
    if (!created.ok) throw new Error(created.code);
    await approveBoth(a, b, created.transferId);
    await waitFor(() => b.engine.get(created.transferId)?.state === 'completed');
    fs.writeFileSync(path.join(b.ws.path, 'proj', 'a.txt'), 'EDITED-LATER');
    const rev = b.engine.revert(created.transferId);
    expect(rev.ok && rev.result.conflicts).toEqual([{ path: 'proj/a.txt', reason: 'modified_since_transfer' }]);
    expect(readTree(b.ws.path)['proj/a.txt']).toBe('EDITED-LATER');
  });

  it('a target that changed after the preview ends with TARGET_CHANGED and writes nothing', async () => {
    const { a, b, created } = await pair({ 'proj/a.txt': 'NEW' }, { 'proj/a.txt': 'OLD' });
    if (!created.ok) throw new Error(created.code);
    const id = created.transferId;
    fs.writeFileSync(path.join(b.ws.path, 'proj', 'a.txt'), 'CHANGED-AFTER-PREVIEW');
    const rb = b.engine.get(id)!;
    const r = await b.engine.approve(id, rb.selectionDigest, rb.overwrite!.digest);
    expect(r).toMatchObject({ ok: false, code: 'TARGET_CHANGED' });
    expect(b.engine.get(id)!.state).toBe('failed');
    expect(readTree(b.ws.path)['proj/a.txt']).toBe('CHANGED-AFTER-PREVIEW');
  });

  it('zero replacements are allowed and need no backup', async () => {
    const { a, b, created } = await pair({ 'proj/a.txt': 'NEW' }, { 'other.txt': 'x' });
    if (!created.ok) throw new Error(created.code);
    expect(a.engine.get(created.transferId)!.overwrite!.replaced).toHaveLength(0);
    await approveBoth(a, b, created.transferId);
    await waitFor(() => b.engine.get(created.transferId)?.state === 'completed');
    expect(readTree(b.ws.path)['proj/a.txt']).toBe('NEW');
    expect(b.engine.revert(created.transferId)).toMatchObject({ ok: false, code: 'REVERT_UNAVAILABLE' });
  });

  it('writes under targetDir', async () => {
    const { a, b, created } = await pair({ 'proj/a.txt': 'NEW' }, { 'dest/keep.txt': 'k' }, { targetDir: 'dest' });
    if (!created.ok) throw new Error(created.code);
    await approveBoth(a, b, created.transferId);
    await waitFor(() => b.engine.get(created.transferId)?.state === 'completed');
    expect(readTree(b.ws.path)['dest/proj/a.txt']).toBe('NEW');
  });

  it('refuses secret / protected target directories and a missing target directory', async () => {
    for (const dir of ['.git', '.ssh', '.aws', 'cfg/.git', 'cfg/.ssh']) {
      // the directory EXISTS on the target: only the secret/protected rule can refuse it
      const { created } = await pair({ 'proj/a.txt': 'N' }, { 'cfg/x': '1', '.git/HEAD': 'ref', '.ssh/known_hosts': 'k', '.aws/config': 'c', 'cfg/.git/HEAD': 'r', 'cfg/.ssh/k': 'k' }, { targetDir: dir });
      expect(created, dir).toMatchObject({ ok: false, code: expect.stringMatching(/SECRET_PATH_REJECTED|PATH_REJECTED/) });
    }
    const { created } = await pair({ 'proj/a.txt': 'N' }, { 'cfg/x': '1' }, { targetDir: 'nope' });
    expect(created).toMatchObject({ ok: false, code: 'TARGET_DIR_MISSING' });
  });

  it('never writes through a symlink (directory or file leaf) and leaves the outside untouched', async () => {
    const outside = tmpDir('outside');
    fs.writeFileSync(path.join(outside, 'a.txt'), 'OUTSIDE');
    // directory symlink in the target tree
    {
      const broker = new LinkBroker(); const peers = new Map<string, Side>();
      const a = makeSide('daemon_mach_a', broker, peers); const b = makeSide('daemon_mach_b', broker, peers);
      cleanups.push(() => { a.engine.shutdown(); b.engine.shutdown(); });
      writeTree(a.ws.path, { 'proj/a.txt': 'NEW' });
      fs.symlinkSync(outside, path.join(b.ws.path, 'proj'));
      const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['proj'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'x', targetMode: 'existing_path', targetDir: '' });
      expect(c.ok).toBe(false);
    }
    // file symlink leaf
    {
      const broker = new LinkBroker(); const peers = new Map<string, Side>();
      const a = makeSide('daemon_mach_a', broker, peers); const b = makeSide('daemon_mach_b', broker, peers);
      cleanups.push(() => { a.engine.shutdown(); b.engine.shutdown(); });
      writeTree(a.ws.path, { 'proj/a.txt': 'NEW' });
      fs.mkdirSync(path.join(b.ws.path, 'proj'));
      fs.symlinkSync(path.join(outside, 'a.txt'), path.join(b.ws.path, 'proj', 'a.txt'));
      const c = await a.engine.create({ workspaceId: a.ws.id, selected: ['proj'], targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName: 'x', targetMode: 'existing_path', targetDir: '' });
      expect(c).toMatchObject({ ok: false, code: 'TARGET_PATH_UNSAFE' });
    }
    expect(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8')).toBe('OUTSIDE');
  });

  it('a symlink swapped in after the preview is refused at publish and the outside file stays intact', async () => {
    const outside = tmpDir('outside2');
    fs.writeFileSync(path.join(outside, 'a.txt'), 'OUTSIDE');
    const { a, b, created } = await pair({ 'proj/a.txt': 'NEW' }, { 'proj/a.txt': 'OLD' });
    if (!created.ok) throw new Error(created.code);
    const id = created.transferId;
    // swap the file for a symlink between preview and approval
    fs.rmSync(path.join(b.ws.path, 'proj', 'a.txt'));
    fs.symlinkSync(path.join(outside, 'a.txt'), path.join(b.ws.path, 'proj', 'a.txt'));
    const rb = b.engine.get(id)!;
    const r = await b.engine.approve(id, rb.selectionDigest, rb.overwrite!.digest);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8')).toBe('OUTSIDE');
  });

  it('new_folder transfers are unchanged (default) and carry no overwrite info', async () => {
    const { a, created } = await pair({ 'proj/a.txt': 'N' }, {}, { targetMode: 'new_folder', targetDir: undefined });
    if (!created.ok) throw new Error(created.code);
    expect(a.engine.get(created.transferId)!.overwrite).toBeUndefined();
  });
});
