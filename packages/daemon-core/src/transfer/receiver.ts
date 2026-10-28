/**
 * Target-side receiver. All writes go through the native handle-relative helper into
 * `<project>/.adhdev-transfer-staging/<transferId>/`; the finished tree becomes visible
 * only via one atomic no-replace rename into the project root.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TransferFsError, close as nativeClose, createExcl, fullFsync, getIdentity, mkdirExcl, openFileRead,
  openRoot, probeRoot, readHandle, renameAtExcl, resolveParentDirHandle, unlinkAt, walkDir, writeHandle,
} from '../transfer-fs/index.js';
import { TRANSFER_LIMITS } from './limits.js';
import { requireFreeDisk } from './spool.js';
import { SECRET_SNIFF_BYTES, sniffSecretContent } from './secret-exclusion.js';
import { blockCount, type ContentManifest, type SelectionManifest } from './manifest.js';

export const STAGING_DIR_NAME = '.adhdev-transfer-staging';

export class ReceiverError extends Error {
  constructor(public readonly code: 'HASH_MISMATCH' | 'PROTOCOL_ERROR' | 'PUBLISH_CONFLICT' | 'VERIFY_FAILED' | 'SECRET_CONTENT_REJECTED' | 'DISK_SPACE_EXHAUSTED', message: string) {
    super(message);
    this.name = 'ReceiverError';
  }
}

function safeClose(h: number | null | undefined): void {
  if (h === null || h === undefined) return;
  try { nativeClose(h); } catch { /* ignore */ }
}

interface Cur {
  index: number;
  parentChain: ReturnType<typeof resolveParentDirHandle>;
  handle: number;
  blockHash: ReturnType<typeof createHash>;
  whole: ReturnType<typeof createHash>;
  blockFill: number;
}

export class TransferReceiver {
  private rootH: number | null = null;
  private stagingParentH: number | null = null;
  private stageH: number | null = null;
  private cur: Cur | null = null;
  private get files() { return this.content.files; }
  /** Verified, checkpointed blocks per file. */
  blocksDone: number[] = [];
  private nextFile = 0;

  constructor(
    private readonly rootPath: string,
    private readonly selection: SelectionManifest,
    private readonly content: ContentManifest,
    private readonly onCheckpoint?: (fileIndex: number, blocksDone: number, bytesDone: number) => void,
  ) {}

  get stagePath(): string { return path.join(this.rootPath, STAGING_DIR_NAME, this.selection.transferId); }

  /** Prepare staging; returns per-file validated (re-hashed) block counts to resume from. */
  init(claimedBlocks: number[] = []): number[] {
    this.rootH = openRoot(this.rootPath);
    probeRoot(this.rootPath, { requireAtomicNoReplace: true });
    this.stagingParentH = this.walkOrMake(this.rootH, STAGING_DIR_NAME, true);
    this.stageH = this.walkOrMake(this.stagingParentH, this.selection.transferId, false);
    for (const e of [...this.selection.entries].filter((x) => x.kind === 'dir').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      this.ensureDir(e.path);
    }
    this.blocksDone = this.files.map((f, i) => this.validateRetained(i, claimedBlocks[i] ?? 0, f.size));
    // Files are received strictly in order: only the first incomplete file may hold partial progress.
    const firstOpen = this.blocksDone.findIndex((b, i) => b < blockCount(this.files[i]!.size));
    if (firstOpen >= 0) {
      for (let i = firstOpen + 1; i < this.blocksDone.length; i++) {
        if (this.blocksDone[i]! > 0) { this.dropFile(i); this.blocksDone[i] = 0; }
      }
    }
    this.nextFile = 0;
    this.advance();
    return [...this.blocksDone];
  }

  private walkOrMake(parent: number, name: string, protectedMeta: boolean): number {
    const opt = protectedMeta ? { allowProtectedMetadata: true } : undefined;
    try { return walkDir(parent, name, opt); } catch (err) {
      if ((err as TransferFsError).code !== 'ENOENT') throw err;
      try { return mkdirExcl(parent, name, opt); } catch (e2) {
        if ((e2 as TransferFsError).code === 'EEXIST') return walkDir(parent, name, opt);
        throw e2;
      }
    }
  }

  private ensureDir(rel: string): void {
    let h = this.stageH!;
    const held: number[] = [];
    try {
      for (const seg of rel.split('/')) { h = this.walkOrMake(h, seg, false); held.push(h); }
    } finally { for (const x of held.reverse()) safeClose(x); }
  }

  /** Re-hash a retained prefix against the authenticated manifest; returns the count of valid leading blocks. */
  private validateRetained(i: number, claimed: number, size: number): number {
    const want = Math.min(claimed, blockCount(size));
    if (want === 0) { this.dropFile(i); return 0; }
    const f = this.files[i]!;
    const chain = resolveParentDirHandle(this.stageH!, f.path, { createDirs: false });
    let fh: number | null = null;
    let ok = 0;
    try {
      fh = openFileRead(chain.parentHandle, chain.leafName);
      const buf = Buffer.allocUnsafe(TRANSFER_LIMITS.blockBytes);
      for (let b = 0; b < want; b++) {
        const len = Math.min(TRANSFER_LIMITS.blockBytes, size - b * TRANSFER_LIMITS.blockBytes);
        let got = 0;
        while (got < len) {
          const n = readHandle(fh, buf, got, len - got, b * TRANSFER_LIMITS.blockBytes + got);
          if (n <= 0) break;
          got += n;
        }
        if (got !== len || createHash('sha256').update(buf.subarray(0, len)).digest('hex') !== f.blockHashes[b]) break;
        ok = b + 1;
      }
    } catch { ok = 0; } finally {
      safeClose(fh);
      for (const h of chain.intermediateHandles.reverse()) safeClose(h);
    }
    if (ok === 0) this.dropFile(i);
    return ok;
  }

  private dropFile(i: number): void {
    const f = this.files[i]!;
    const chain = resolveParentDirHandle(this.stageH!, f.path, { createDirs: true });
    try { try { unlinkAt(chain.parentHandle, chain.leafName, false); } catch { /* absent */ } }
    finally { for (const h of chain.intermediateHandles.reverse()) safeClose(h); }
  }

  /** Move to the first incomplete file, creating zero-byte files on the way. */
  private advance(): void {
    this.closeCur();
    while (this.nextFile < this.files.length) {
      const i = this.nextFile;
      const f = this.files[i]!;
      if (this.blocksDone[i]! >= blockCount(f.size) && (f.size === 0 ? this.fileExists(i) : true)) {
        if (f.size > 0) { this.nextFile++; continue; }
      }
      if (f.size === 0) {
        const chain = resolveParentDirHandle(this.stageH!, f.path, { createDirs: true });
        try {
          try { const h = createExcl(chain.parentHandle, chain.leafName); fullFsync(h); safeClose(h); }
          catch (err) { if ((err as TransferFsError).code !== 'EEXIST') throw err; }
        } finally { for (const h of chain.intermediateHandles.reverse()) safeClose(h); }
        this.nextFile++;
        continue;
      }
      this.openCurrent(i);
      return;
    }
  }

  private fileExists(i: number): boolean {
    const chain = resolveParentDirHandle(this.stageH!, this.files[i]!.path, { createDirs: false });
    try { safeClose(openFileRead(chain.parentHandle, chain.leafName)); return true; } catch { return false; }
    finally { for (const h of chain.intermediateHandles.reverse()) safeClose(h); }
  }

  private openCurrent(i: number): void {
    const f = this.files[i]!;
    const done = this.blocksDone[i]!;
    const chain = resolveParentDirHandle(this.stageH!, f.path, { createDirs: true });
    let handle: number;
    try {
      if (done > 0) {
        // Reopen for append by re-creating: the retained prefix was rewritten into place by rewritePrefix.
        // The helper hands out write handles only from createExcl, so copy the verified prefix once more.
        const tmp = `.adhdev-reopen-${process.pid}-${Date.now().toString(36)}`;
        const src = openFileRead(chain.parentHandle, chain.leafName);
        handle = createExcl(chain.parentHandle, tmp, { allowProtectedMetadata: true });
        const buf = Buffer.allocUnsafe(TRANSFER_LIMITS.blockBytes);
        for (let b = 0; b < done; b++) {
          const len = Math.min(TRANSFER_LIMITS.blockBytes, f.size - b * TRANSFER_LIMITS.blockBytes);
          let got = 0;
          while (got < len) { const n = readHandle(src, buf, got, len - got, b * TRANSFER_LIMITS.blockBytes + got); if (n <= 0) throw new ReceiverError('VERIFY_FAILED', 'retained data vanished'); got += n; }
          writeHandle(handle, buf, 0, len, b * TRANSFER_LIMITS.blockBytes);
        }
        safeClose(src);
        unlinkAt(chain.parentHandle, chain.leafName, false);
        // Keep the write handle on the temp inode and give it the final name (no-replace; target removed above).
        renameAtExcl(chain.parentHandle, tmp, chain.parentHandle, chain.leafName, { allowProtectedMetadata: true });
      } else {
        try { unlinkAt(chain.parentHandle, chain.leafName, false); } catch { /* absent */ }
        handle = createExcl(chain.parentHandle, chain.leafName);
      }
    } catch (err) {
      for (const h of chain.intermediateHandles.reverse()) safeClose(h);
      throw err;
    }
    const whole = createHash('sha256');
    // Whole-file hash for resumed files is recomputed at verifyAll(); streaming hash only covers fresh files.
    this.cur = { index: i, parentChain: chain, handle, blockHash: createHash('sha256'), whole, blockFill: 0 };
  }

  private closeCur(): void {
    if (!this.cur) return;
    safeClose(this.cur.handle);
    for (const h of this.cur.parentChain.intermediateHandles.slice().reverse()) safeClose(h);
    this.cur = null;
  }

  get bytesDone(): number {
    return this.blocksDone.reduce((n, b, i) => n + Math.min(b * TRANSFER_LIMITS.blockBytes, this.files[i]!.size), 0);
  }

  get complete(): boolean { return this.nextFile >= this.files.length && this.cur === null; }
  get currentFile(): number { return this.cur ? this.cur.index : this.files.length; }

  handleData(fileIndex: number, offset: number, payload: Buffer): void {
    const c = this.cur;
    if (!c || c.index !== fileIndex) throw new ReceiverError('PROTOCOL_ERROR', 'data for unexpected file');
    const expected = this.blocksDone[c.index]! * TRANSFER_LIMITS.blockBytes + c.blockFill;
    if (offset < expected) return; // duplicate (already written): idempotent no-op
    if (offset !== expected) throw new ReceiverError('PROTOCOL_ERROR', 'gap in data stream');
    const f = this.files[c.index]!;
    const blockStart = this.blocksDone[c.index]! * TRANSFER_LIMITS.blockBytes;
    const blockLen = Math.min(TRANSFER_LIMITS.blockBytes, f.size - blockStart);
    if (c.blockFill + payload.length > blockLen) throw new ReceiverError('PROTOCOL_ERROR', 'data past block end');
    if (c.blockFill === 0) {
      // Free space can shrink during a long transfer: re-check before each block, not only at offer time.
      try { requireFreeDisk(this.stagePath, blockLen); } catch { throw new ReceiverError('DISK_SPACE_EXHAUSTED', 'not enough free disk space'); }
    }
    writeHandle(c.handle, payload, 0, payload.length, offset);
    c.blockHash.update(payload);
    c.whole.update(payload);
    c.blockFill += payload.length;
  }

  /** Returns the next-file transition info after a verified block. */
  handleBlockEnd(fileIndex: number, offset: number, senderHashHex: string): { blockIndex: number; fileDone: boolean } {
    const c = this.cur;
    if (!c || c.index !== fileIndex) throw new ReceiverError('PROTOCOL_ERROR', 'block end for unexpected file');
    const b = this.blocksDone[c.index]!;
    const f = this.files[c.index]!;
    if (offset !== b * TRANSFER_LIMITS.blockBytes) {
      if (offset < b * TRANSFER_LIMITS.blockBytes) return { blockIndex: offset / TRANSFER_LIMITS.blockBytes, fileDone: false }; // duplicate
      throw new ReceiverError('PROTOCOL_ERROR', 'block end out of order');
    }
    const blockLen = Math.min(TRANSFER_LIMITS.blockBytes, f.size - offset);
    if (c.blockFill !== blockLen) throw new ReceiverError('PROTOCOL_ERROR', 'block incomplete');
    const got = c.blockHash.digest('hex');
    if (got !== f.blockHashes[b] || got !== senderHashHex) throw new ReceiverError('HASH_MISMATCH', `block ${b} of file ${c.index} failed verification`);
    fullFsync(c.handle);
    this.blocksDone[c.index] = b + 1;
    c.blockHash = createHash('sha256');
    c.blockFill = 0;
    this.onCheckpoint?.(c.index, b + 1, this.bytesDone);
    const fileDone = b + 1 >= blockCount(f.size);
    if (fileDone) { this.nextFile++; this.advance(); }
    return { blockIndex: b, fileDone };
  }

  /** Full re-hash of every staged file from disk plus an unexpected-entry scan. */
  verifyAll(): void {
    const expected = new Set<string>(['']);
    for (const e of this.selection.entries) expected.add(e.path);
    const walk = (rel: string): void => {
      for (const n of fs.readdirSync(path.join(this.stagePath, ...(rel ? rel.split('/') : [])))) {
        const r = rel ? `${rel}/${n}` : n;
        if (!expected.has(r)) throw new ReceiverError('VERIFY_FAILED', 'unexpected entry in staging');
        const st = fs.lstatSync(path.join(this.stagePath, ...r.split('/')));
        if (st.isDirectory()) walk(r); else if (!st.isFile()) throw new ReceiverError('VERIFY_FAILED', 'non-regular entry in staging');
      }
    };
    walk('');
    for (const f of this.files) {
      const chain = resolveParentDirHandle(this.stageH!, f.path, { createDirs: false });
      let fh: number | null = null;
      try {
        fh = openFileRead(chain.parentHandle, chain.leafName);
        const id = getIdentity(fh);
        if (Number(id.size) !== f.size) throw new ReceiverError('VERIFY_FAILED', 'size mismatch');
        const h = createHash('sha256');
        const buf = Buffer.allocUnsafe(TRANSFER_LIMITS.blockBytes);
        for (let o = 0; o < f.size;) {
          const n = readHandle(fh, buf, 0, Math.min(buf.length, f.size - o), o);
          if (n <= 0) throw new ReceiverError('VERIFY_FAILED', 'short read');
          if (o === 0 && sniffSecretContent(buf.subarray(0, Math.min(n, SECRET_SNIFF_BYTES)))) {
            throw new ReceiverError('SECRET_CONTENT_REJECTED', 'received file looks like secret key material');
          }
          h.update(buf.subarray(0, n)); o += n;
        }
        if (h.digest('hex') !== f.sha256) throw new ReceiverError('HASH_MISMATCH', 'file hash mismatch');
      } finally {
        safeClose(fh);
        for (const h of chain.intermediateHandles.reverse()) safeClose(h);
      }
    }
  }

  /** Atomic no-replace publish of the verified tree. Returns the folder name actually used. */
  publish(finalName: string): string {
    this.closeCur();
    fullFsync(this.stageH!);
    const candidates = [finalName, ...Array.from({ length: 19 }, (_, i) => `${finalName}-${i + 2}`)];
    for (const name of candidates) {
      try {
        renameAtExcl(this.stagingParentH!, this.selection.transferId, this.rootH!, name);
        try { fullFsync(this.rootH!); } catch { /* best effort */ }
        try { unlinkAt(this.rootH!, STAGING_DIR_NAME, true, { allowProtectedMetadata: true }); } catch { /* not empty / other transfers */ }
        return name;
      } catch (err) {
        if ((err as TransferFsError).reason === 'TARGET_EXISTS') continue;
        throw err;
      }
    }
    throw new ReceiverError('PUBLISH_CONFLICT', 'target folder name is taken');
  }

  /** Remove the staging tree handle-relatively and release all handles. */
  abort(): void {
    this.closeCur();
    try {
      if (this.stagingParentH !== null && this.stageH !== null) {
        this.removeTree(this.stagingParentH, this.selection.transferId, this.stagePath);
        try { if (this.rootH !== null) unlinkAt(this.rootH, STAGING_DIR_NAME, true, { allowProtectedMetadata: true }); } catch { /* shared */ }
      }
    } finally { this.dispose(); }
  }

  private removeTree(parent: number, name: string, abs: string): void {
    let dh: number | null = null;
    try { dh = walkDir(parent, name, { allowProtectedMetadata: true }); } catch { try { unlinkAt(parent, name, false, { allowProtectedMetadata: true }); } catch { /* gone */ } return; }
    try {
      let names: string[] = [];
      try { names = fs.readdirSync(abs); } catch { names = []; }
      for (const n of names) this.removeTree(dh, n, path.join(abs, n));
    } finally { safeClose(dh); }
    try { unlinkAt(parent, name, true, { allowProtectedMetadata: true }); } catch { /* ignore */ }
  }

  dispose(): void {
    this.closeCur();
    safeClose(this.stageH); this.stageH = null;
    safeClose(this.stagingParentH); this.stagingParentH = null;
    safeClose(this.rootH); this.rootH = null;
  }
}

/** Remove a transfer's staging tree without a live receiver (cancel after restart / GC). */
export function removeStagingFor(rootPath: string, transferId: string): void {
  let root: number | null = null;
  let parent: number | null = null;
  try {
    root = openRoot(rootPath);
    parent = walkDir(root, STAGING_DIR_NAME, { allowProtectedMetadata: true });
    const rm = (p: number, name: string, abs: string): void => {
      let dh: number | null = null;
      try { dh = walkDir(p, name, { allowProtectedMetadata: true }); } catch { try { unlinkAt(p, name, false, { allowProtectedMetadata: true }); } catch { /* gone */ } return; }
      try { for (const n of fs.readdirSync(abs)) rm(dh, n, path.join(abs, n)); } finally { safeClose(dh); }
      try { unlinkAt(p, name, true, { allowProtectedMetadata: true }); } catch { /* ignore */ }
    };
    rm(parent, transferId, path.join(rootPath, STAGING_DIR_NAME, transferId));
    safeClose(parent); parent = null;
    try { unlinkAt(root, STAGING_DIR_NAME, true, { allowProtectedMetadata: true }); } catch { /* other transfers */ }
  } catch { /* nothing to remove */ } finally { safeClose(parent); safeClose(root); }
}
