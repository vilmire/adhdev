/**
 * Overwrite support for `existing_path` transfers (owner decision O1-O5, 2026-11-02).
 *
 *   - {@link scanOverwriteTargets}: the TARGET machine inspects the existing project directory
 *     (handle-relative, never following symlinks) and classifies every selected file as new or
 *     replaced. The resulting digest binds the owner approval to exactly that state.
 *   - {@link applyOverwrite}: backs up every replaced original first, then replaces per file
 *     (staged temp file -> rename); nothing is ever deleted that exists only on the target.
 *   - {@link revertOverwrite}: restores the backed-up originals (owner-only command).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TransferFsError, close as nativeClose, createExcl, fullFsync, getIdentity, openFileRead, readHandle,
  renameAtExcl, resolveParentDirHandle, unlinkAt, walkDir, writeHandle,
} from '../transfer-fs/index.js';
import { TRANSFER_LIMITS } from './limits.js';
import { canonicalJson, type SelectionManifest } from './manifest.js';
import { matchSecretPath } from './secret-exclusion.js';

export class OverwriteError extends Error {
  constructor(public readonly code: 'TARGET_DIR_MISSING' | 'TARGET_PATH_UNSAFE' | 'TARGET_CONFLICT' | 'SECRET_PATH_REJECTED' | 'TARGET_CHANGED' | 'BACKUP_FAILED' | 'REVERT_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'OverwriteError';
  }
}

export interface ReplacedFile { path: string; size: number; sha256: string }

export interface OverwritePlan {
  targetDir: string;
  newFiles: string[];
  replaced: ReplacedFile[];
  /** Binds the approval to the target state the owner saw. */
  digest: string;
}

/** What a revert needs per replaced file. */
export interface BackupManifest {
  v: 1;
  files: Array<{ path: string; size: number; sha256: string; newSha256: string }>;
}

const CHUNK = 1024 * 1024;

function safeClose(h: number | null | undefined): void {
  if (h === null || h === undefined) return;
  try { nativeClose(h); } catch { /* ignore */ }
}

function closeAll(hs: number[]): void { for (const h of hs.slice().reverse()) safeClose(h); }

export function targetRel(targetDir: string, entryPath: string): string {
  return targetDir ? `${targetDir}/${entryPath}` : entryPath;
}

function isMissing(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === 'ENOENT';
}

/** Hash an existing regular, non-hardlinked file without following symlinks. `null` = absent. */
function hashExisting(rootH: number, rel: string): { size: number; sha256: string } | null {
  let chain: ReturnType<typeof resolveParentDirHandle> | null = null;
  let fh: number | null = null;
  try {
    try { chain = resolveParentDirHandle(rootH, rel, { createDirs: false }); } catch (e) {
      if (isMissing(e)) return null;
      throw new OverwriteError('TARGET_CONFLICT', 'a parent of the target path is not a directory');
    }
    try { fh = openFileRead(chain.parentHandle, chain.leafName); } catch (e) {
      if (isMissing(e)) return null;
      throw new OverwriteError('TARGET_PATH_UNSAFE', 'the existing target entry is a symlink or not a plain file');
    }
    const id = getIdentity(fh);
    if (id.isDirectory) throw new OverwriteError('TARGET_CONFLICT', 'a directory exists where a file would be written');
    if (id.isReparsePoint || id.linkCount > 1) throw new OverwriteError('TARGET_PATH_UNSAFE', 'the existing target file is a link');
    const size = Number(id.size);
    if (size > TRANSFER_LIMITS.maxFileBytes) throw new OverwriteError('TARGET_PATH_UNSAFE', 'the existing target file is too large to replace');
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let o = 0; o < size;) {
      const n = readHandle(fh, buf, 0, Math.min(CHUNK, size - o), o);
      if (n <= 0) throw new OverwriteError('TARGET_CHANGED', 'the target file changed while it was inspected');
      h.update(buf.subarray(0, n)); o += n;
    }
    return { size, sha256: h.digest('hex') };
  } catch (e) {
    if (e instanceof OverwriteError) throw e;
    if (e instanceof TransferFsError) throw new OverwriteError('TARGET_PATH_UNSAFE', e.message);
    throw e;
  } finally {
    safeClose(fh);
    if (chain) closeAll(chain.intermediateHandles);
  }
}

/** A directory entry must not collide with an existing non-directory. */
function checkDirEntry(rootH: number, rel: string): void {
  let chain: ReturnType<typeof resolveParentDirHandle> | null = null;
  let dh: number | null = null;
  try {
    try { chain = resolveParentDirHandle(rootH, rel, { createDirs: false }); } catch (e) {
      if (isMissing(e)) return;
      throw new OverwriteError('TARGET_CONFLICT', 'a parent of the target path is not a directory');
    }
    try { dh = walkDir(chain.parentHandle, chain.leafName); } catch (e) {
      if (isMissing(e)) return;
      throw new OverwriteError('TARGET_CONFLICT', 'a non-directory exists where a folder would be created');
    }
  } finally {
    safeClose(dh);
    if (chain) closeAll(chain.intermediateHandles);
  }
}

export function overwriteDigest(targetDir: string, newFiles: string[], replaced: ReplacedFile[]): string {
  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  return createHash('sha256').update(canonicalJson({
    v: 1, targetDir,
    newFiles: [...newFiles].sort(cmp),
    replaced: [...replaced].sort((a, b) => cmp(a.path, b.path)),
  }), 'utf8').digest('hex');
}

/**
 * Inspect the target project for an `existing_path` selection. Throws {@link OverwriteError}
 * when the target cannot be written safely (missing directory, secret/protected location,
 * symlink or link in the way, directory/file collision).
 */
export function scanOverwriteTargets(rootH: number, selection: SelectionManifest): OverwritePlan {
  const targetDir = selection.targetDir ?? '';
  if (targetDir) {
    const held: number[] = [];
    try {
      let cur = rootH;
      for (const seg of targetDir.split('/')) {
        try { cur = walkDir(cur, seg); } catch (e) {
          throw new OverwriteError(isMissing(e) ? 'TARGET_DIR_MISSING' : 'TARGET_PATH_UNSAFE', 'the target directory does not exist or is not a plain directory');
        }
        held.push(cur);
      }
    } finally { closeAll(held); }
  }
  const newFiles: string[] = [];
  const replaced: ReplacedFile[] = [];
  for (const e of selection.entries) {
    const rel = targetRel(targetDir, e.path);
    if (matchSecretPath(rel) !== null) throw new OverwriteError('SECRET_PATH_REJECTED', 'a target path matches a secret exclusion rule');
    if (e.kind === 'dir') { checkDirEntry(rootH, rel); continue; }
    const existing = hashExisting(rootH, rel);
    if (!existing) newFiles.push(e.path);
    else replaced.push({ path: e.path, size: existing.size, sha256: existing.sha256 });
  }
  return { targetDir, newFiles, replaced, digest: overwriteDigest(targetDir, newFiles, replaced) };
}

function atomicWriteFs(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** Copy one existing file (handle-relative read) into the backup tree, verifying its hash. */
function backupOne(rootH: number, rel: string, dest: string, expectedSha: string): void {
  let chain: ReturnType<typeof resolveParentDirHandle> | null = null;
  let fh: number | null = null;
  let fd: number | null = null;
  try {
    chain = resolveParentDirHandle(rootH, rel, { createDirs: false });
    fh = openFileRead(chain.parentHandle, chain.leafName);
    const size = Number(getIdentity(fh).size);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fd = fs.openSync(dest, 'w', 0o600);
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let o = 0; o < size;) {
      const n = readHandle(fh, buf, 0, Math.min(CHUNK, size - o), o);
      if (n <= 0) throw new OverwriteError('TARGET_CHANGED', 'the target file changed before it was backed up');
      h.update(buf.subarray(0, n)); fs.writeSync(fd, buf, 0, n); o += n;
    }
    fs.fsyncSync(fd);
    if (h.digest('hex') !== expectedSha) throw new OverwriteError('TARGET_CHANGED', 'the target file changed before it was backed up');
  } catch (e) {
    if (e instanceof OverwriteError) throw e;
    throw new OverwriteError('BACKUP_FAILED', (e as Error).message);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    safeClose(fh);
    if (chain) closeAll(chain.intermediateHandles);
  }
}

export function backupFilesDir(backupDir: string): string { return path.join(backupDir, 'files'); }
const manifestFile = (backupDir: string): string => path.join(backupDir, 'manifest.json');

export function readBackupManifest(backupDir: string): BackupManifest | null {
  try { return JSON.parse(fs.readFileSync(manifestFile(backupDir), 'utf8')) as BackupManifest; } catch { return null; }
}

/** Restore bytes into `rel` by writing a temp sibling and renaming it over the leaf (the leaf is unlinked first). */
function replaceLeafWithFile(rootH: number, rel: string, source: { fd: number; size: number; sha256: string }, createDirs: boolean): void {
  const chain = resolveParentDirHandle(rootH, rel, { createDirs });
  const tmp = `.adhdev-replace-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  let th: number | null = null;
  let made = false;
  try {
    th = createExcl(chain.parentHandle, tmp, { allowProtectedMetadata: true });
    made = true;
    const buf = Buffer.allocUnsafe(CHUNK);
    const h = createHash('sha256');
    for (let o = 0; o < source.size;) {
      const n = fs.readSync(source.fd, buf, 0, Math.min(CHUNK, source.size - o), o);
      if (n <= 0) throw new OverwriteError('BACKUP_FAILED', 'backup is shorter than recorded');
      h.update(buf.subarray(0, n)); writeHandle(th, buf, 0, n, o); o += n;
    }
    if (h.digest('hex') !== source.sha256) throw new OverwriteError('BACKUP_FAILED', 'backup does not match its recorded hash');
    fullFsync(th); safeClose(th); th = null;
    try { unlinkAt(chain.parentHandle, chain.leafName, false); } catch (e) { if (!isMissing(e)) throw e; }
    renameAtExcl(chain.parentHandle, tmp, chain.parentHandle, chain.leafName, { allowProtectedMetadata: true });
    made = false;
    try { fullFsync(chain.parentHandle); } catch { /* best effort */ }
  } finally {
    safeClose(th);
    if (made) { try { unlinkAt(chain.parentHandle, tmp, false, { allowProtectedMetadata: true }); } catch { /* ignore */ } }
    closeAll(chain.intermediateHandles);
  }
}

export interface ApplyResult { created: string[]; replaced: string[] }

/**
 * Publish the verified staging tree into the existing target directory.
 * Order: re-scan (TARGET_CHANGED when it differs from the approved plan) -> back up EVERY replaced
 * original -> per-file replace (staged file renamed over the original, new files no-replace).
 * Files that exist only on the target are never touched.
 */
export function applyOverwrite(args: {
  rootH: number;
  stageH: number;
  selection: SelectionManifest;
  plan: OverwritePlan;
  newSha256: ReadonlyMap<string, string>;
  backupDir: string;
}): ApplyResult {
  const { rootH, stageH, selection, plan, backupDir } = args;
  const now = scanOverwriteTargets(rootH, selection);
  if (now.digest !== plan.digest) throw new OverwriteError('TARGET_CHANGED', 'the target changed after the owner approved it');

  const replacedSet = new Set(plan.replaced.map((r) => r.path));
  if (plan.replaced.length) {
    for (const r of plan.replaced) backupOne(rootH, targetRel(plan.targetDir, r.path), path.join(backupFilesDir(backupDir), ...r.path.split('/')), r.sha256);
    const manifest: BackupManifest = {
      v: 1,
      files: plan.replaced.map((r) => ({ path: r.path, size: r.size, sha256: r.sha256, newSha256: args.newSha256.get(r.path) ?? '' })),
    };
    atomicWriteFs(manifestFile(backupDir), JSON.stringify(manifest));
  }

  const out: ApplyResult = { created: [], replaced: [] };
  // Directories first so empty selected folders exist.
  for (const e of selection.entries) {
    if (e.kind !== 'dir') continue;
    const chain = resolveParentDirHandle(rootH, `${targetRel(plan.targetDir, e.path)}/x`, { createDirs: true });
    closeAll(chain.intermediateHandles);
  }
  const files = selection.entries.filter((e) => e.kind === 'file').sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const e of files) {
    const rel = targetRel(plan.targetDir, e.path);
    const src = resolveParentDirHandle(stageH, e.path, { createDirs: false });
    let dst: ReturnType<typeof resolveParentDirHandle> | null = null;
    try {
      dst = resolveParentDirHandle(rootH, rel, { createDirs: true });
      if (replacedSet.has(e.path)) {
        // The re-scan above pinned the original; remove it and move the verified file in. If the move fails the original is restored.
        unlinkAt(dst.parentHandle, dst.leafName, false);
        try {
          renameAtExcl(src.parentHandle, src.leafName, dst.parentHandle, dst.leafName);
        } catch (err) {
          const b = path.join(backupFilesDir(backupDir), ...e.path.split('/'));
          const fd = fs.openSync(b, 'r');
          try { replaceLeafWithFile(rootH, rel, { fd, size: fs.fstatSync(fd).size, sha256: plan.replaced.find((r) => r.path === e.path)!.sha256 }, false); } finally { fs.closeSync(fd); }
          throw err;
        }
        out.replaced.push(e.path);
      } else {
        renameAtExcl(src.parentHandle, src.leafName, dst.parentHandle, dst.leafName);
        out.created.push(e.path);
      }
      try { fullFsync(dst.parentHandle); } catch { /* best effort */ }
    } finally {
      closeAll(src.intermediateHandles);
      if (dst) closeAll(dst.intermediateHandles);
    }
  }
  return out;
}

export interface RevertResult { restored: string[]; conflicts: Array<{ path: string; reason: string }> }

/**
 * Put the backed-up originals back. A file whose current content is no longer what the transfer wrote
 * (the owner edited it since) is left alone and reported as a conflict.
 */
export function revertOverwrite(rootH: number, selection: SelectionManifest, backupDir: string): RevertResult {
  const manifest = readBackupManifest(backupDir);
  if (!manifest || manifest.files.length === 0) throw new OverwriteError('REVERT_UNAVAILABLE', 'no backup is available for this transfer');
  const targetDir = selection.targetDir ?? '';
  const out: RevertResult = { restored: [], conflicts: [] };
  for (const f of manifest.files) {
    const rel = targetRel(targetDir, f.path);
    try {
      const cur = hashExisting(rootH, rel);
      if (!cur) { out.conflicts.push({ path: f.path, reason: 'missing' }); continue; }
      if (cur.sha256 === f.sha256) { out.restored.push(f.path); continue; } // already the original
      if (cur.sha256 !== f.newSha256) { out.conflicts.push({ path: f.path, reason: 'modified_since_transfer' }); continue; }
      const fd = fs.openSync(path.join(backupFilesDir(backupDir), ...f.path.split('/')), 'r');
      try { replaceLeafWithFile(rootH, rel, { fd, size: f.size, sha256: f.sha256 }, false); } finally { fs.closeSync(fd); }
      out.restored.push(f.path);
    } catch (e) {
      out.conflicts.push({ path: f.path, reason: e instanceof OverwriteError ? e.code.toLowerCase() : 'failed' });
    }
  }
  return out;
}
