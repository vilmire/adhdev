/**
 * Source-side project traversal. Every open is handle-relative through the native helper
 * (O_NOFOLLOW / NtCreateFile(RootDirectory)); path-based `readdir` supplies NAMES only, so a
 * swapped directory can at worst make an open fail — it can never redirect a read outside
 * the pinned project root.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TransferFsError,
  close as nativeClose,
  getIdentity,
  openFileRead,
  openRoot,
  readHandle,
  resolveParentDirHandle,
  splitPortableRelativePath,
  walkDir,
  type NativeHandleIdentity,
} from '../transfer-fs/index.js';
import { TRANSFER_LIMITS } from './limits.js';
import { ManifestError, type ExcludedEntry, type SelectionEntry } from './manifest.js';
import { SECRET_SNIFF_BYTES, matchSecretPath, sniffSecretContent } from './secret-exclusion.js';

export interface ScanResult {
  entries: SelectionEntry[];
  excluded: ExcludedEntry[];
}

function safeClose(h: number | null): void {
  if (h === null) return;
  try { nativeClose(h); } catch { /* best effort */ }
}

function classifyOpenError(err: unknown): string {
  const reason = (err as TransferFsError)?.reason;
  if (reason === 'SYMLINK_OR_REPARSE_REJECTED') return 'link';
  if (reason === 'HARDLINK_REJECTED') return 'hardlink';
  if ((err as TransferFsError)?.code === 'ENOENT') return 'vanished';
  return 'unreadable';
}

/** Open one project-relative file handle-relatively; caller closes `handle` (and `parentHandles`). */
export function openSourceFile(rootHandle: number, relPath: string): { handle: number; identity: NativeHandleIdentity; release(): void } {
  const chain = resolveParentDirHandle(rootHandle, relPath, { createDirs: false });
  let handle: number | null = null;
  try {
    handle = openFileRead(chain.parentHandle, chain.leafName);
    const identity = getIdentity(handle);
    if (identity.isDirectory || identity.isReparsePoint) {
      throw new TransferFsError('SYMLINK_OR_REPARSE_REJECTED', 'not a regular file', 'ELOOP');
    }
    if (identity.linkCount > 1) throw new TransferFsError('HARDLINK_REJECTED', 'hardlinked file', 'EMLINK');
    const h = handle;
    return {
      handle: h,
      identity,
      release() {
        safeClose(h);
        for (let i = chain.intermediateHandles.length - 1; i >= 0; i--) safeClose(chain.intermediateHandles[i]!);
      },
    };
  } catch (err) {
    safeClose(handle);
    for (let i = chain.intermediateHandles.length - 1; i >= 0; i--) safeClose(chain.intermediateHandles[i]!);
    throw err;
  }
}

/** Children of one directory (names + kind + size), handle-relative classification. */
export function browseDirectory(rootPath: string, relDir: string): Array<{ name: string; kind: 'file' | 'dir' | 'other'; size?: number; excluded?: string }> {
  const root = openRoot(rootPath);
  try {
    const abs = relDir ? path.join(rootPath, ...relDir.split('/')) : rootPath;
    let dirHandle: number | null = null;
    const held: number[] = [];
    try {
      if (relDir) {
        for (const seg of splitPortableRelativePath(relDir)) {
          dirHandle = walkDir(dirHandle ?? root, seg);
          held.push(dirHandle);
        }
      }
      const names = fs.readdirSync(abs).sort();
      const out: Array<{ name: string; kind: 'file' | 'dir' | 'other'; size?: number; excluded?: string }> = [];
      for (const name of names.slice(0, 5000)) {
        const rel = relDir ? `${relDir}/${name}` : name;
        const secret = matchSecretPath(rel);
        let kind: 'file' | 'dir' | 'other' = 'other';
        let size: number | undefined;
        try {
          const dh = walkDir(dirHandle ?? root, name, { allowProtectedMetadata: true });
          nativeClose(dh);
          kind = 'dir';
        } catch {
          try {
            const fh = openFileRead(dirHandle ?? root, name, { allowProtectedMetadata: true });
            try { size = Number(getIdentity(fh).size); kind = 'file'; } finally { safeClose(fh); }
          } catch { kind = 'other'; }
        }
        out.push({ name, kind, ...(size !== undefined ? { size } : {}), ...(secret ? { excluded: `secret:${secret}` } : kind === 'other' ? { excluded: 'link-or-special' } : {}) });
      }
      return out;
    } finally {
      for (let i = held.length - 1; i >= 0; i--) safeClose(held[i]!);
    }
  } finally {
    safeClose(root);
  }
}

/** Walk the owner's selection and produce entries + exclusions, enforcing D3 limits early. */
export function scanSelection(rootPath: string, selected: string[]): ScanResult {
  const root = openRoot(rootPath);
  const entries = new Map<string, SelectionEntry>();
  const excluded: ExcludedEntry[] = [];
  let totalBytes = 0;

  const addDirChain = (rel: string): void => {
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      if (!entries.has(p)) entries.set(p, { path: p, kind: 'dir' });
    }
  };
  const bump = (): void => {
    if (entries.size > TRANSFER_LIMITS.maxEntries) throw new ManifestError('LIMIT_EXCEEDED', `more than ${TRANSFER_LIMITS.maxEntries} entries`);
  };

  const visit = (rel: string, depth: number): void => {
    if (depth > 64) { excluded.push({ path: rel, reason: 'too-deep' }); return; }
    const secret = matchSecretPath(rel);
    if (secret) { excluded.push({ path: rel, reason: `secret:${secret}` }); return; }
    try { splitPortableRelativePath(rel); } catch { excluded.push({ path: rel, reason: 'unportable_name' }); return; }

    let chain: ReturnType<typeof resolveParentDirHandle>;
    try { chain = resolveParentDirHandle(root, rel, { createDirs: false }); } catch (err) {
      excluded.push({ path: rel, reason: classifyOpenError(err) });
      return;
    }
    try {
      // Directory?
      let dirHandle: number | null = null;
      try { dirHandle = walkDir(chain.parentHandle, chain.leafName); } catch { /* not a directory (or link) */ }
      if (dirHandle !== null) {
        try {
          addDirChain(rel);
          bump();
          const abs = path.join(rootPath, ...rel.split('/'));
          let names: string[] = [];
          try { names = fs.readdirSync(abs).sort(); } catch { names = []; }
          for (const n of names) visit(`${rel}/${n}`, depth + 1);
        } finally { safeClose(dirHandle); }
        return;
      }
      // File?
      let fh: number | null = null;
      try {
        fh = openFileRead(chain.parentHandle, chain.leafName);
        const id = getIdentity(fh);
        if (id.isDirectory || id.isReparsePoint) { excluded.push({ path: rel, reason: 'link' }); return; }
        if (id.linkCount > 1) { excluded.push({ path: rel, reason: 'hardlink' }); return; }
        const size = Number(id.size);
        if (size > TRANSFER_LIMITS.maxFileBytes) throw new ManifestError('LIMIT_EXCEEDED', 'file exceeds per-file limit');
        if (size > 0) {
          const head = Buffer.alloc(Math.min(size, SECRET_SNIFF_BYTES));
          const n = readHandle(fh, head, 0, head.length, 0);
          const sniff = sniffSecretContent(head.subarray(0, n));
          if (sniff) { excluded.push({ path: rel, reason: `secret:${sniff}` }); return; }
        }
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        if (parent) addDirChain(parent);
        entries.set(rel, { path: rel, kind: 'file', size });
        totalBytes += size;
        if (totalBytes > TRANSFER_LIMITS.maxTransferBytes) throw new ManifestError('LIMIT_EXCEEDED', 'transfer exceeds total size limit');
        bump();
      } catch (err) {
        if (err instanceof ManifestError) throw err;
        excluded.push({ path: rel, reason: classifyOpenError(err) });
      } finally { safeClose(fh); }
    } finally {
      for (let i = chain.intermediateHandles.length - 1; i >= 0; i--) safeClose(chain.intermediateHandles[i]!);
    }
  };

  try {
    for (const rel of selected) visit(rel, 0);
  } finally {
    safeClose(root);
  }
  return { entries: [...entries.values()], excluded };
}
