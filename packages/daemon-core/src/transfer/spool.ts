/** Freeze the approved source bytes into the private spool and build the content manifest. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openRoot, close as nativeClose, getIdentity, readHandle } from '../transfer-fs/index.js';
import { TRANSFER_LIMITS } from './limits.js';
import {
  ManifestError, blockCount, selectionDigest, selectionFiles, selectionTotalBytes,
  type ContentFileInfo, type ContentManifest, type SelectionManifest,
} from './manifest.js';
import { sniffSecretContent, SECRET_SNIFF_BYTES } from './secret-exclusion.js';
import { openSourceFile } from './source-scan.js';

export function spoolFilePath(spoolDir: string, fileIndex: number): string {
  return path.join(spoolDir, `f${fileIndex}`);
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export function requireFreeDisk(dir: string, needBytes: number): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const s = fs.statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < needBytes + TRANSFER_LIMITS.diskMarginBytes) {
      throw new ManifestError('DISK_SPACE_EXHAUSTED', 'not enough free disk space');
    }
  } catch (err) {
    if (err instanceof ManifestError) throw err;
    /* statfs unsupported: do not block */
  }
}

export async function freezeSelection(opts: {
  rootPath: string;
  selection: SelectionManifest;
  spoolDir: string;
  isCancelled?: () => boolean;
}): Promise<ContentManifest> {
  const { selection, spoolDir } = opts;
  requireFreeDisk(spoolDir, selectionTotalBytes(selection));
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(spoolDir, 0o700);
  const root = openRoot(opts.rootPath);
  const files: ContentFileInfo[] = [];
  try {
    const list = selectionFiles(selection);
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]!;
      if (opts.isCancelled?.()) throw new ManifestError('CANCELLED', 'cancelled while freezing');
      let src: ReturnType<typeof openSourceFile>;
      try { src = openSourceFile(root, entry.path); } catch {
        throw new ManifestError('SOURCE_CHANGED', 'a selected file is no longer readable as a regular file');
      }
      const out = fs.openSync(spoolFilePath(spoolDir, i), 'wx', 0o600);
      try {
        if (Number(src.identity.size) !== entry.size) throw new ManifestError('SOURCE_CHANGED', 'file size changed since preview');
        const whole = createHash('sha256');
        const blockHashes: string[] = [];
        const buf = Buffer.allocUnsafe(TRANSFER_LIMITS.blockBytes);
        let done = 0;
        while (done < entry.size) {
          const want = Math.min(buf.length, entry.size - done);
          let got = 0;
          while (got < want) {
            const n = readHandle(src.handle, buf, got, want - got, done + got);
            if (n <= 0) throw new ManifestError('SOURCE_CHANGED', 'file shrank while freezing');
            got += n;
          }
          if (done === 0) {
            const secret = sniffSecretContent(buf.subarray(0, Math.min(got, SECRET_SNIFF_BYTES)));
            if (secret) throw new ManifestError('SOURCE_CHANGED', 'file now matches a secret rule');
          }
          fs.writeSync(out, buf, 0, got);
          whole.update(buf.subarray(0, got));
          blockHashes.push(createHash('sha256').update(buf.subarray(0, got)).digest('hex'));
          done += got;
          await tick();
        }
        fs.fsyncSync(out);
        const after = getIdentity(src.handle);
        if (after.size !== src.identity.size || after.fileId !== src.identity.fileId || after.volumeId !== src.identity.volumeId) {
          throw new ManifestError('SOURCE_CHANGED', 'file changed while freezing');
        }
        files.push({ path: entry.path, size: entry.size, sha256: whole.digest('hex'), blockHashes });
      } finally {
        fs.closeSync(out);
        src.release();
      }
    }
  } catch (err) {
    fs.rmSync(spoolDir, { recursive: true, force: true });
    throw err;
  } finally {
    try { nativeClose(root); } catch { /* ignore */ }
  }
  for (const f of files) if (f.blockHashes.length !== blockCount(f.size)) throw new ManifestError('SOURCE_CHANGED', 'internal block accounting');
  return { v: 1, transferId: selection.transferId, selectionDigest: selectionDigest(selection), files };
}
