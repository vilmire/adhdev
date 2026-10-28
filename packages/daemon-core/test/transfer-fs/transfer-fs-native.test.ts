import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TransferFsError,
  close,
  configureTestFaultInjection,
  createExcl,
  fullFsync,
  getBindingInfo,
  getIdentity,
  mkdirExcl,
  openFileRead,
  openRoot,
  probeRoot,
  readExistingFileSafe,
  readHandle,
  renameAtExcl,
  renameExcl,
  unlinkAt,
  verifyHandleIdentity,
  walkDir,
  writeHandle,
  writeNewFileAtomic,
} from '../../src/transfer-fs/index.js';
// @ts-expect-error — .mjs build/check scripts imported for provenance verification
import { computeBindingDigest, expectedApiLevel } from '../../src/transfer-fs/native/scripts/binding-digest.mjs';
// @ts-expect-error — .mjs host-path scanner imported for binary hygiene verification
import { scanHostPaths } from '../../src/transfer-fs/native/scripts/host-path-scan.mjs';
// @ts-expect-error — .mjs manifest verifier imported for 3-platform prebuilt verification
import { checkManifests } from '../../src/transfer-fs/native/scripts/prebuilt-manifest.mjs';

const IS_WIN = process.platform === 'win32';

function createJunctionOrSymlinkDir(targetDir: string, linkPath: string): void {
  fs.symlinkSync(targetDir, linkPath, IS_WIN ? 'junction' : 'dir');
}

describe('Phase 1: transfer-fs native handle-relative / atomic no-replace helper', () => {
  let tmpBase: string;
  let rootDir: string;
  let outsideDir: string;

  beforeEach(() => {
    const rawTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-tfs-p1-'));
    tmpBase = fs.realpathSync(rawTmp);
    rootDir = path.join(tmpBase, 'root');
    outsideDir = path.join(tmpBase, 'outside');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    try {
      configureTestFaultInjection(null);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  });

  it('verifies native binding digest, 3-platform prebuilt manifests, and zero embedded host paths/hostnames', () => {
    const info = getBindingInfo();
    expect(info.apiLevel).toBe(expectedApiLevel());
    expect(info.sourceDigest).toBe(computeBindingDigest());
    expect(info.napiVersion).toBe(8);
    expect(info.releaseEligible).toBe(true);

    const manifestCheck = checkManifests();
    expect(manifestCheck.results.map((r: { triplet: string; status: string }) => [r.triplet, r.status])).toEqual([
      ['darwin-arm64-node137', 'ok'],
      ['linux-x64-node137', 'ok'],
      ['win32-x64-node137', 'ok'],
    ]);

    const hostname = os.hostname();
    const username = os.userInfo().username;
    const homedir = os.homedir();
    const scanResults = scanHostPaths(undefined, {
      denylist: [username, homedir, hostname].filter((v) => v && v.length >= 3),
    });
    expect(scanResults.length).toBe(3);
    for (const entry of scanResults) {
      expect(entry.hits).toEqual([]);
    }
  });

  it('probes root capabilities and verifies 128-bit native handle identity + double-close safety', () => {
    const probe = probeRoot(rootDir);
    expect(probe.supports128BitFileId).toBe(true);
    expect(probe.supportsDirFullFsync).toBe(true);
    expect(probe.supportsAtomicNoReplace).toBe(true);
    if (IS_WIN) {
      expect(probe.filesystem).toBe('NTFS');
    }

    const rootH = openRoot(rootDir);
    try {
      const id = getIdentity(rootH);
      expect(id.volumeId > 0n).toBe(true);
      expect(id.fileId > 0n).toBe(true);
      expect(id.fileIdHex).toMatch(/^[0-9a-f]{32}$/);
      expect(id.isDirectory).toBe(true);
      expect(id.isReparsePoint).toBe(false);

      const verified = verifyHandleIdentity(rootH, id);
      expect(verified.fileId).toBe(id.fileId);
      expect(verified.volumeId).toBe(id.volumeId);
    } finally {
      expect(close(rootH)).toBe(true);
    }

    // Second close on the same token must be a safe no-op returning false (no double CloseHandle)
    expect(close(rootH)).toBe(false);
    // Using a closed handle token must deterministically fail with INVALID_HANDLE (EBADF)
    expect(() => getIdentity(rootH)).toThrowError(
      expect.objectContaining({ reason: 'INVALID_HANDLE', code: 'EBADF' }),
    );
  });

  it('rejects junctions/symlinks at openRoot (both leaf junction and ancestor junction)', () => {
    const leafJunc = path.join(tmpBase, 'root-junc');
    createJunctionOrSymlinkDir(outsideDir, leafJunc);

    expect(() => openRoot(leafJunc)).toThrowError(
      expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
    );

    const subInsideOutside = path.join(outsideDir, 'nested');
    fs.mkdirSync(subInsideOutside, { recursive: true });
    const viaAncestorJunc = path.join(leafJunc, 'nested');
    expect(() => openRoot(viaAncestorJunc)).toThrowError(
      expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
    );
    expect(() => probeRoot(leafJunc)).toThrowError(
      expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
    );
    expect(() => probeRoot(viaAncestorJunc)).toThrowError(
      expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
    );

    // Genuine ENOTDIR (a regular file where a root directory was expected) must remain distinguishable from ELOOP
    const regularRootFile = path.join(tmpBase, 'regular-file-not-dir.txt');
    fs.writeFileSync(regularRootFile, 'NOT_A_DIR');
    expect(() => openRoot(regularRootFile)).toThrowError(
      expect.objectContaining({ reason: 'ROOT_UNAVAILABLE', code: 'ENOTDIR' }),
    );
    expect(() => probeRoot(regularRootFile)).toThrowError(
      expect.objectContaining({ reason: 'ROOT_UNAVAILABLE', code: 'ENOTDIR' }),
    );
  });

  it('rejects traversal, ADS (:), 8.3 short aliases (~), trailing dot/space, non-NFC, control chars, protected metadata, and DOS device names', () => {
    const rootH = openRoot(rootDir);
    try {
      const hostileSegments = [
        '',
        '.',
        '..',
        '../outside',
        'a/b',
        'a\\b',
        'C:\\evil',
        '\\\\127.0.0.1\\c$',
        'stream:ads',
        'file.txt:$DATA',
        'GIT~1',
        'GITIGN~1',
        'VERYLO~1.TXT',
        'progra~1',
        'trailing.',
        'trailing ',
        'nul\x00byte',
        'ctrl\x1fchar',
        'del\x7fchar',
        'e\u0301', // NFD decomposed
        '.git',
        '.GIT',
        '.hg',
        '.svn',
        '.adhdev-transfer-staging',
        'CON',
        'con.txt',
        'PRN',
        'aux.json',
        'NUL',
        'nul.tar.gz',
        'NUL .txt',
        'COM1',
        'com9.log',
        'LPT1',
        'lpt9.dat',
        'COM\u00b9',
        'LPT\u00b2',
        'CONIN$',
        'CONOUT$',
        'CLOCK$',
      ];

      for (const bad of hostileSegments) {
        expect(() => walkDir(rootH, bad)).toThrowError(
          expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
        );
        expect(() => createExcl(rootH, bad)).toThrowError(
          expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
        );
        expect(() => mkdirExcl(rootH, bad)).toThrowError(
          expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
        );
      }

      const hostileRelPaths = [
        '/abs/path',
        'trailing/slash/',
        'back\\slash',
        'a/../b',
        'a/./b',
        'a//b',
        '.git/config',
        'sub/.git/hooks/pre-commit',
        'sub/GIT~1/config',
        'sub/con.txt',
        'sub/file.txt:ads',
        'sub/trailing./file.txt',
      ];
      for (const badRel of hostileRelPaths) {
        expect(() => writeNewFileAtomic(rootH, badRel, Buffer.from('x'))).toThrowError(
          expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
        );
      }
    } finally {
      close(rootH);
    }
  });

  it('blocks real NTFS 8.3 short-name alias resolution and protects .git/config on Windows', () => {
    const gitDir = path.join(rootDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), 'ORIGINAL_GIT_CONFIG');
    const longFile = path.join(rootDir, '.gitignore_long_filename_test');
    fs.writeFileSync(longFile, 'ORIGINAL_GITIGNORE');

    const rootH = openRoot(rootDir);
    try {
      for (const alias of ['.git', 'GIT~1', 'GIT~2', '.gitignore_long_filename_test']) {
        if (alias.includes('~') || alias.toLowerCase() === '.git') {
          expect(() => walkDir(rootH, alias)).toThrowError(
            expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
          );
          expect(() => createExcl(rootH, alias)).toThrowError(
            expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
          );
        }
      }
      expect(() => writeNewFileAtomic(rootH, 'GIT~1/config', Buffer.from('PWNED'))).toThrowError(
        expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
      );
      expect(() => writeNewFileAtomic(rootH, 'GITIGN~1', Buffer.from('PWNED'))).toThrowError(
        expect.objectContaining({ reason: 'PATH_TRAVERSAL_REJECTED' }),
      );
    } finally {
      close(rootH);
    }

    expect(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')).toBe('ORIGINAL_GIT_CONFIG');
    expect(fs.readFileSync(longFile, 'utf8')).toBe('ORIGINAL_GITIGNORE');
  });

  it('rejects junctions/symlinks during walkDir, openFileRead, renameAtExcl, and unlinkAt, and rejects hardlinked files', () => {
    const juncPath = path.join(rootDir, 'junc_out');
    createJunctionOrSymlinkDir(outsideDir, juncPath);

    const realFile = path.join(rootDir, 'real.txt');
    const hardlinkFile = path.join(rootDir, 'hardlink.txt');
    fs.writeFileSync(realFile, 'REAL_PAYLOAD');
    fs.linkSync(realFile, hardlinkFile);

    const rootH = openRoot(rootDir);
    try {
      expect(() => walkDir(rootH, 'junc_out')).toThrowError(
        expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
      );
      expect(() => writeNewFileAtomic(rootH, 'junc_out/escaped.txt', Buffer.from('ESCAPE'))).toThrowError(
        expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
      );
      expect(() => renameAtExcl(rootH, 'junc_out', rootH, 'renamed_junc')).toThrowError(
        expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
      );
      expect(() => unlinkAt(rootH, 'junc_out', true)).toThrowError(
        expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
      );
      expect(() => unlinkAt(rootH, 'junc_out', false)).toThrowError(
        expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
      );
      expect(() => openFileRead(rootH, 'junc_out')).toThrowError(
        expect.objectContaining({ reason: 'SYMLINK_OR_REPARSE_REJECTED', code: 'ELOOP' }),
      );

      // Genuine ENOTDIR (regular file where a directory was expected) remains distinguishable from ELOOP
      expect(() => walkDir(rootH, 'real.txt')).toThrowError(
        expect.objectContaining({ reason: 'IO_ERROR', code: 'ENOTDIR' }),
      );
      expect(() => unlinkAt(rootH, 'real.txt', true)).toThrowError(
        expect.objectContaining({ reason: 'IO_ERROR', code: 'ENOTDIR' }),
      );

      // Hardlinked files (nNumberOfLinks === 2) must be rejected by openFileRead and readExistingFileSafe
      expect(() => openFileRead(rootH, 'hardlink.txt')).toThrowError(
        expect.objectContaining({ reason: 'HARDLINK_REJECTED', code: 'EMLINK' }),
      );
      expect(() => readExistingFileSafe(rootH, 'hardlink.txt')).toThrowError(
        expect.objectContaining({ reason: 'HARDLINK_REJECTED', code: 'EMLINK' }),
      );

      // Unlinking the second link drops linkCount back to 1, allowing safe read
      fs.unlinkSync(hardlinkFile);
      const safeRead = readExistingFileSafe(rootH, 'real.txt');
      expect(safeRead.buffer.toString('utf8')).toBe('REAL_PAYLOAD');
      expect(safeRead.identity.linkCount).toBe(1);
    } finally {
      close(rootH);
    }

    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it('enforces deterministic atomic no-replace on existing file, existing dir, existing junction, and case-collision, plus directory fullFsync', () => {
    fs.writeFileSync(path.join(rootDir, 'existing.txt'), 'KEEP_FILE');
    fs.mkdirSync(path.join(rootDir, 'existing_empty_dir'));
    fs.mkdirSync(path.join(rootDir, 'existing_nonempty_dir'));
    fs.writeFileSync(path.join(rootDir, 'existing_nonempty_dir', 'inner.txt'), 'KEEP_INNER');
    fs.writeFileSync(path.join(rootDir, 'casefile.txt'), 'KEEP_LOWER');
    createJunctionOrSymlinkDir(outsideDir, path.join(rootDir, 'existing_junc'));

    const rootH = openRoot(rootDir);
    try {
      // Directory fullFsync works via native FlushFileBuffers, whereas Node fs.openSync(dir, 'r') + fsyncSync fails on Windows
      expect(fullFsync(rootH)).toBe(true);
      if (IS_WIN) {
        const nodeDirFd = fs.openSync(rootDir, 'r');
        try {
          expect(() => fs.fsyncSync(nodeDirFd)).toThrowError(/EPERM/);
        } finally {
          fs.closeSync(nodeDirFd);
        }
      }

      // Direct createExcl & mkdirExcl collisions
      for (const target of ['existing.txt', 'existing_empty_dir', 'existing_nonempty_dir', 'existing_junc', 'CASEFILE.TXT']) {
        expect(() => createExcl(rootH, target)).toThrowError(
          expect.objectContaining({ reason: 'TARGET_EXISTS', code: 'EEXIST' }),
        );
        expect(() => mkdirExcl(rootH, target)).toThrowError(
          expect.objectContaining({ reason: 'TARGET_EXISTS', code: 'EEXIST' }),
        );
      }

      // Staged file renameExcl into every collision target must fail with TARGET_EXISTS (EEXIST / WIN_183)
      const stageH = createExcl(rootH, '.stage-collision-test.tmp', { allowProtectedMetadata: true });
      try {
        writeHandle(stageH, Buffer.from('NEW_CONTENT'));
        fullFsync(stageH);

        for (const target of ['existing.txt', 'existing_empty_dir', 'existing_nonempty_dir', 'existing_junc', 'CASEFILE.TXT']) {
          expect(() => renameExcl(stageH, rootH, target)).toThrowError(
            expect.objectContaining({ reason: 'TARGET_EXISTS', code: 'EEXIST' }),
          );
        }

        // Publishing to a genuinely new name succeeds atomically
        expect(renameExcl(stageH, rootH, 'brand_new.txt')).toBe(true);
      } finally {
        close(stageH);
      }

      // Staged directory renameExcl into existing directory / file must fail with TARGET_EXISTS
      const stageDirH = mkdirExcl(rootH, '.stage-dir-test', { allowProtectedMetadata: true });
      try {
        const innerH = createExcl(stageDirH, 'inside.txt');
        writeHandle(innerH, Buffer.from('DIR_PAYLOAD'));
        fullFsync(innerH);
        close(innerH);
        fullFsync(stageDirH);

        expect(() => renameExcl(stageDirH, rootH, 'existing_empty_dir')).toThrowError(
          expect.objectContaining({ reason: 'TARGET_EXISTS', code: 'EEXIST' }),
        );
        expect(() => renameExcl(stageDirH, rootH, 'existing_nonempty_dir')).toThrowError(
          expect.objectContaining({ reason: 'TARGET_EXISTS', code: 'EEXIST' }),
        );
        expect(() => renameExcl(stageDirH, rootH, 'existing.txt')).toThrowError(
          expect.objectContaining({ reason: 'TARGET_EXISTS', code: 'EEXIST' }),
        );
        expect(renameExcl(stageDirH, rootH, 'published_dir')).toBe(true);
      } finally {
        close(stageDirH);
      }
    } finally {
      close(rootH);
    }

    expect(fs.readFileSync(path.join(rootDir, 'existing.txt'), 'utf8')).toBe('KEEP_FILE');
    expect(fs.readFileSync(path.join(rootDir, 'existing_nonempty_dir', 'inner.txt'), 'utf8')).toBe('KEEP_INNER');
    expect(fs.readFileSync(path.join(rootDir, 'casefile.txt'), 'utf8')).toBe('KEEP_LOWER');
    expect(fs.readFileSync(path.join(rootDir, 'brand_new.txt'), 'utf8')).toBe('NEW_CONTENT');
    expect(fs.readFileSync(path.join(rootDir, 'published_dir', 'inside.txt'), 'utf8')).toBe('DIR_PAYLOAD');
  });

  it('proves 0 outside writes under a live concurrent path-swap (junction swap) race', async () => {
    const subDir = path.join(rootDir, 'sub');
    const subReal = path.join(rootDir, 'sub.real');
    const subJunc = path.join(rootDir, 'sub.junc');
    fs.mkdirSync(subDir, { recursive: true });
    createJunctionOrSymlinkDir(outsideDir, subJunc);

    const swapWorkerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const { subDir, subReal, subJunc } = workerData;
      let swaps = 0;
      let shareBlocked = 0;
      let stop = false;
      let readySent = false;
      parentPort.on('message', (m) => { if (m === 'stop') stop = true; });

      function tick() {
        if (stop) {
          parentPort.postMessage({ swaps, shareBlocked });
          return;
        }
        for (let i = 0; i < 20; i++) {
          try {
            fs.renameSync(subDir, subReal);
            try {
              fs.renameSync(subJunc, subDir);
              swaps++;
            } catch {}
            try {
              fs.renameSync(subDir, subJunc);
            } catch {}
            try {
              fs.renameSync(subReal, subDir);
            } catch {}
          } catch (err) {
            if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
              shareBlocked++;
            }
          }
        }
        // Signal once the first batch of swap attempts has run, so the writer loop races a live attacker.
        if (!readySent) { readySent = true; parentPort.postMessage('ready'); }
        setImmediate(tick);
      }
      tick();
    `;

    const worker = new Worker(swapWorkerCode, {
      eval: true,
      workerData: { subDir, subReal, subJunc },
    });
    await new Promise<void>((resolve) => worker.once('message', () => resolve()));

    const rootH = openRoot(rootDir);
    let succeededInside = 0;
    let refusedOnSwap = 0;

    try {
      const rounds = 300;
      for (let i = 0; i < rounds; i++) {
        try {
          writeNewFileAtomic(rootH, `sub/raced-${i}.bin`, Buffer.from(`SAFE-${i}`));
          succeededInside++;
        } catch (err) {
          if (err instanceof TransferFsError) {
            expect(['SYMLINK_OR_REPARSE_REJECTED', 'PATH_TRAVERSAL_REJECTED', 'IO_ERROR', 'ROOT_UNAVAILABLE']).toContain(err.reason);
            refusedOnSwap++;
          } else {
            throw err;
          }
        }
        if (i % 15 === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
    } finally {
      close(rootH);
    }

    const stats = await new Promise<{ swaps: number; shareBlocked: number }>((resolve) => {
      worker.once('message', (msg) => resolve(msg as { swaps: number; shareBlocked: number }));
      worker.postMessage('stop');
    });
    await worker.terminate();

    const outsideEntries = fs.readdirSync(outsideDir);
    expect(outsideEntries).toEqual([]);
    expect(succeededInside + refusedOnSwap).toBe(300);
    expect(stats.swaps + stats.shareBlocked).toBeGreaterThan(0);
  }, 30_000);

  it('proves 0 clobbered user files/directories under a live concurrent destination-creation race', async () => {
    const rounds = 250;
    const clobberWorkerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const path = require('node:path');
      const { rootDir, rounds } = workerData;
      let userCreatedFiles = 0;
      let userCreatedDirs = 0;
      for (let i = 0; i < rounds; i++) {
        const f = path.join(rootDir, 'race-file-' + i + '.txt');
        try {
          fs.writeFileSync(f, 'USER_ORIGINAL_' + i, { flag: 'wx' });
          userCreatedFiles++;
        } catch {}
        const d = path.join(rootDir, 'race-dir-' + i);
        try {
          fs.mkdirSync(d);
          fs.writeFileSync(path.join(d, 'sentinel.txt'), 'USER_DIR_' + i, { flag: 'wx' });
          userCreatedDirs++;
        } catch {}
      }
      parentPort.postMessage({ userCreatedFiles, userCreatedDirs });
    `;

    const worker = new Worker(clobberWorkerCode, {
      eval: true,
      workerData: { rootDir, rounds },
    });

    const rootH = openRoot(rootDir);
    let helperPublishedFiles = 0;
    let helperRefusedFiles = 0;
    let helperPublishedDirs = 0;
    let helperRefusedDirs = 0;

    try {
      for (let i = 0; i < rounds; i++) {
        // 1. Race file publish
        try {
          writeNewFileAtomic(rootH, `race-file-${i}.txt`, Buffer.from(`HELPER_NEW_${i}`));
          helperPublishedFiles++;
        } catch (err) {
          expect(err).toBeInstanceOf(TransferFsError);
          expect((err as TransferFsError).reason).toBe('TARGET_EXISTS');
          helperRefusedFiles++;
        }

        // 2. Race directory publish
        const stageDirName = `.stage-racedir-${i}`;
        const stageDirH = mkdirExcl(rootH, stageDirName, { allowProtectedMetadata: true });
        let dirPublished = false;
        try {
          const fH = createExcl(stageDirH, 'helper.txt');
          writeHandle(fH, Buffer.from(`HELPER_DIR_${i}`));
          fullFsync(fH);
          close(fH);
          fullFsync(stageDirH);

          renameExcl(stageDirH, rootH, `race-dir-${i}`);
          dirPublished = true;
          helperPublishedDirs++;
        } catch (err) {
          expect(err).toBeInstanceOf(TransferFsError);
          expect((err as TransferFsError).reason).toBe('TARGET_EXISTS');
          helperRefusedDirs++;
        } finally {
          close(stageDirH);
          if (!dirPublished) {
            try {
              unlinkAt(stageDirH, 'helper.txt');
            } catch {
              /* already closed */
            }
            try {
              fs.rmSync(path.join(rootDir, stageDirName), { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }
        }
      }
    } finally {
      close(rootH);
    }

    const workerResult = await new Promise<{ userCreatedFiles: number; userCreatedDirs: number }>((resolve) => {
      worker.once('message', (msg) => resolve(msg as { userCreatedFiles: number; userCreatedDirs: number }));
    });
    await worker.terminate();

    let clobberedFiles = 0;
    let clobberedDirs = 0;
    for (let i = 0; i < rounds; i++) {
      const content = fs.readFileSync(path.join(rootDir, `race-file-${i}.txt`), 'utf8');
      if (content !== `USER_ORIGINAL_${i}` && content !== `HELPER_NEW_${i}`) {
        clobberedFiles++;
      }
      const dirPath = path.join(rootDir, `race-dir-${i}`);
      const hasUserSentinel = fs.existsSync(path.join(dirPath, 'sentinel.txt'));
      const hasHelperFile = fs.existsSync(path.join(dirPath, 'helper.txt'));
      // Mutual exclusion: a directory cannot contain both user and helper files, nor lose user sentinel!
      if ((hasUserSentinel && hasHelperFile) || (!hasUserSentinel && !hasHelperFile)) {
        clobberedDirs++;
      }
    }

    expect(clobberedFiles).toBe(0);
    expect(clobberedDirs).toBe(0);
    expect(helperPublishedFiles + helperRefusedFiles).toBe(rounds);
    expect(helperPublishedDirs + helperRefusedDirs).toBe(rounds);
    expect(workerResult.userCreatedFiles + helperPublishedFiles).toBe(rounds);
    expect(workerResult.userCreatedDirs + helperPublishedDirs).toBe(rounds);
  }, 30_000);

  it('prevents source-entry substitution (check-then-rename TOCTOU) and preserves linkCount === 1 during concurrent renameExcl / renameAtExcl publication', async () => {
    const rounds = 200;
    const outsideTarget = path.join(outsideDir, 'outside-secret.txt');
    fs.writeFileSync(outsideTarget, 'OUTSIDE_SECRET');

    const sourceSwapWorkerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const path = require('node:path');
      const { rootDir, outsideDir, rounds, isWin } = workerData;
      let stop = false;
      let substitutions = 0;
      parentPort.on('message', (m) => { if (m === 'stop') stop = true; });

      function tick() {
        if (stop) {
          parentPort.postMessage({ substitutions });
          return;
        }
        for (let i = 0; i < rounds; i++) {
          const stageSrcPath = path.join(rootDir, '.stage-src-' + i + '.tmp');
          try {
            fs.unlinkSync(stageSrcPath);
            if (i % 2 === 0) {
              fs.symlinkSync(outsideDir, stageSrcPath, isWin ? 'junction' : 'dir');
            } else {
              fs.writeFileSync(stageSrcPath, 'ATTACKER_SUBSTITUTED_' + i);
            }
            substitutions++;
          } catch {}

          const atSrcPath = path.join(rootDir, '.at-src-' + i + '.tmp');
          try {
            fs.unlinkSync(atSrcPath);
            fs.symlinkSync(outsideDir, atSrcPath, isWin ? 'junction' : 'dir');
            substitutions++;
          } catch {}
        }
        setImmediate(tick);
      }
      tick();
    `;

    const worker = new Worker(sourceSwapWorkerCode, {
      eval: true,
      workerData: { rootDir, outsideDir, rounds, isWin: IS_WIN },
    });

    const rootH = openRoot(rootDir);
    let publishedExcl = 0;
    let rejectedExcl = 0;
    let publishedAtExcl = 0;
    let rejectedAtExcl = 0;

    try {
      for (let i = 0; i < rounds; i++) {
        // 1. Test renameExcl against concurrent source-entry substitution
        const stageName = `.stage-src-${i}.tmp`;
        const dstName = `published-excl-${i}.txt`;
        let stageH: number | null = null;
        try {
          stageH = createExcl(rootH, stageName, { allowProtectedMetadata: true });
          writeHandle(stageH, Buffer.from(`GENUINE_EXCL_${i}`));
          fullFsync(stageH);
          renameExcl(stageH, rootH, dstName);
          publishedExcl++;
        } catch (err) {
          expect(err).toBeInstanceOf(TransferFsError);
          expect([
            'SYMLINK_OR_REPARSE_REJECTED',
            'POST_RENAME_QUARANTINED',
            'PUBLISHED_HARDLINK_DETECTED',
            'HARDLINK_REJECTED',
            'IO_ERROR',
            'TARGET_EXISTS',
          ]).toContain((err as TransferFsError).reason);
          rejectedExcl++;
        } finally {
          if (stageH !== null) {
            close(stageH);
          }
          try {
            fs.rmSync(path.join(rootDir, stageName), { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }

        // 2. Test renameAtExcl against concurrent source-entry substitution
        const atSrcName = `.at-src-${i}.tmp`;
        const atDstName = `published-at-${i}.txt`;
        let atH: number | null = null;
        try {
          atH = createExcl(rootH, atSrcName, { allowProtectedMetadata: true });
          writeHandle(atH, Buffer.from(`GENUINE_AT_${i}`));
          fullFsync(atH);
          close(atH);
          atH = null;
          renameAtExcl(rootH, atSrcName, rootH, atDstName, { allowProtectedMetadata: true });
          publishedAtExcl++;
        } catch (err) {
          expect(err).toBeInstanceOf(TransferFsError);
          expect([
            'SYMLINK_OR_REPARSE_REJECTED',
            'POST_RENAME_QUARANTINED',
            'PUBLISHED_HARDLINK_DETECTED',
            'HARDLINK_REJECTED',
            'IO_ERROR',
            'TARGET_EXISTS',
          ]).toContain((err as TransferFsError).reason);
          rejectedAtExcl++;
        } finally {
          if (atH !== null) {
            close(atH);
          }
          try {
            fs.rmSync(path.join(rootDir, atSrcName), { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }

        if (i % 15 === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }

      // Verify every published destination file has genuine content, is not a symlink, and has linkCount === 1
      for (let i = 0; i < rounds; i++) {
        const exclPath = path.join(rootDir, `published-excl-${i}.txt`);
        if (fs.existsSync(exclPath)) {
          const lst = fs.lstatSync(exclPath);
          expect(lst.isSymbolicLink()).toBe(false);
          expect(lst.isFile()).toBe(true);
          expect(lst.nlink).toBe(1);
          const safe = readExistingFileSafe(rootH, `published-excl-${i}.txt`);
          expect(safe.buffer.toString('utf8')).toBe(`GENUINE_EXCL_${i}`);
          expect(safe.identity.linkCount).toBe(1);
        }

        const atPath = path.join(rootDir, `published-at-${i}.txt`);
        if (fs.existsSync(atPath)) {
          const lst = fs.lstatSync(atPath);
          expect(lst.isSymbolicLink()).toBe(false);
          expect(lst.isFile()).toBe(true);
          expect(lst.nlink).toBe(1);
          const safe = readExistingFileSafe(rootH, `published-at-${i}.txt`);
          expect(safe.buffer.toString('utf8')).toBe(`GENUINE_AT_${i}`);
          expect(safe.identity.linkCount).toBe(1);
        }
      }
    } finally {
      close(rootH);
    }

    await new Promise<{ substitutions: number }>((resolve) => {
      worker.once('message', (msg) => resolve(msg as { substitutions: number }));
      worker.postMessage('stop');
    });
    await worker.terminate();

    expect(fs.readdirSync(outsideDir)).toEqual(['outside-secret.txt']);
    expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('OUTSIDE_SECRET');
    expect(publishedExcl + rejectedExcl).toBe(rounds);
    expect(publishedAtExcl + rejectedAtExcl).toBe(rounds);
  }, 30_000);

  it.skipIf(IS_WIN)(
    'quarantines substituted files, third-party dst replacements, and non-empty directories without deleting user data (F1)',
    () => {
      const rootH = openRoot(rootDir);
      try {
        // (a) Substituted legitimate regular file before renameat2/renameatx_np must be quarantined, never unlinked
        const legitFileA = path.join(rootDir, 'legit-f1a.txt');
        fs.writeFileSync(legitFileA, 'USER_PRECIOUS_DATA_F1A');
        const legitInoA = fs.lstatSync(legitFileA).ino;

        const stageHA = createExcl(rootH, '.stage-f1a.tmp', { allowProtectedMetadata: true });
        try {
          writeHandle(stageHA, Buffer.from('STAGE_A'));
          fullFsync(stageHA);
          configureTestFaultInjection('swap_src_before_rename', 'legit-f1a.txt');
          expect(() => renameExcl(stageHA, rootH, 'published-f1a.txt')).toThrowError(
            expect.objectContaining({
              reason: 'POST_RENAME_QUARANTINED',
              code: 'POST_RENAME_QUARANTINED',
            }),
          );
        } finally {
          close(stageHA);
        }

        expect(fs.existsSync(path.join(rootDir, 'published-f1a.txt'))).toBe(false);
        const quarantinedFilesA = fs
          .readdirSync(rootDir)
          .filter((name) => name.startsWith('.adhdev-quarantine-'));
        expect(quarantinedFilesA.length).toBe(1);
        const qPathA = path.join(rootDir, quarantinedFilesA[0]!);
        expect(fs.lstatSync(qPathA).ino).toBe(legitInoA);
        expect(fs.readFileSync(qPathA, 'utf8')).toBe('USER_PRECIOUS_DATA_F1A');
        fs.unlinkSync(qPathA);

        // (b) Third-party replacement at dst between rename and post-check fstatat must be quarantined, never unlinked
        const thirdPartyB = path.join(rootDir, 'third-party-f1b.txt');
        fs.writeFileSync(thirdPartyB, 'THIRD_PARTY_DATA_F1B');
        const thirdPartyInoB = fs.lstatSync(thirdPartyB).ino;

        const stageHB = createExcl(rootH, '.stage-f1b.tmp', { allowProtectedMetadata: true });
        writeHandle(stageHB, Buffer.from('STAGE_B'));
        fullFsync(stageHB);
        close(stageHB);

        configureTestFaultInjection('replace_dst_after_rename', 'third-party-f1b.txt');
        expect(() =>
          renameAtExcl(rootH, '.stage-f1b.tmp', rootH, 'published-f1b.txt', {
            allowProtectedMetadata: true,
          }),
        ).toThrowError(
          expect.objectContaining({
            reason: 'POST_RENAME_QUARANTINED',
            code: 'POST_RENAME_QUARANTINED',
          }),
        );

        expect(fs.existsSync(path.join(rootDir, 'published-f1b.txt'))).toBe(false);
        const quarantinedFilesB = fs
          .readdirSync(rootDir)
          .filter((name) => name.startsWith('.adhdev-quarantine-'));
        expect(quarantinedFilesB.length).toBe(1);
        const qPathB = path.join(rootDir, quarantinedFilesB[0]!);
        expect(fs.lstatSync(qPathB).ino).toBe(thirdPartyInoB);
        expect(fs.readFileSync(qPathB, 'utf8')).toBe('THIRD_PARTY_DATA_F1B');
        fs.unlinkSync(qPathB);

        // (c) Substituted non-empty directory must not stay published at dst and must be quarantined intact
        const substDirC = path.join(rootDir, 'subst-nonempty-dir');
        fs.mkdirSync(substDirC);
        fs.writeFileSync(path.join(substDirC, 'nested.txt'), 'NONEMPTY_DIR_CHILD');
        const substDirInoC = fs.lstatSync(substDirC).ino;

        const stageDirHC = mkdirExcl(rootH, '.stage-dir-f1c', { allowProtectedMetadata: true });
        try {
          configureTestFaultInjection('swap_src_before_rename', 'subst-nonempty-dir');
          expect(() => renameExcl(stageDirHC, rootH, 'published-dir-f1c')).toThrowError(
            expect.objectContaining({
              reason: 'POST_RENAME_QUARANTINED',
              code: 'POST_RENAME_QUARANTINED',
            }),
          );
        } finally {
          close(stageDirHC);
        }

        expect(fs.existsSync(path.join(rootDir, 'published-dir-f1c'))).toBe(false);
        const quarantinedDirsC = fs
          .readdirSync(rootDir)
          .filter((name) => name.startsWith('.adhdev-quarantine-'));
        expect(quarantinedDirsC.length).toBe(1);
        const qDirC = path.join(rootDir, quarantinedDirsC[0]!);
        expect(fs.lstatSync(qDirC).isDirectory()).toBe(true);
        expect(fs.lstatSync(qDirC).ino).toBe(substDirInoC);
        expect(fs.readFileSync(path.join(qDirC, 'nested.txt'), 'utf8')).toBe('NONEMPTY_DIR_CHILD');

        // (F3) renameAtExcl pins directory sources with O_SEARCH / O_PATH without requiring read permission on the directory
        const searchOnlyDir = path.join(rootDir, 'search-only-dir');
        fs.mkdirSync(searchOnlyDir, 0o700);
        fs.writeFileSync(path.join(searchOnlyDir, 'marker.txt'), 'PINNED_BY_O_SEARCH');
        fs.chmodSync(searchOnlyDir, 0o100);
        try {
          expect(renameAtExcl(rootH, 'search-only-dir', rootH, 'renamed-search-only-dir')).toBe(
            true,
          );
        } finally {
          const finalSearchDir = fs.existsSync(path.join(rootDir, 'renamed-search-only-dir'))
            ? path.join(rootDir, 'renamed-search-only-dir')
            : searchOnlyDir;
          fs.chmodSync(finalSearchDir, 0o700);
        }
        expect(
          fs.readFileSync(path.join(rootDir, 'renamed-search-only-dir', 'marker.txt'), 'utf8'),
        ).toBe('PINNED_BY_O_SEARCH');
      } finally {
        close(rootH);
      }
    },
  );

  it.skipIf(IS_WIN)(
    'returns PUBLISHED_HARDLINK_DETECTED and quarantines when a hardlink is added in the rename window (F2)',
    () => {
      const rootH = openRoot(rootDir);
      try {
        const stageH = createExcl(rootH, '.stage-f2.tmp', { allowProtectedMetadata: true });
        try {
          writeHandle(stageH, Buffer.from('STAGE_F2_PAYLOAD'));
          fullFsync(stageH);

          configureTestFaultInjection('hardlink_after_rename', 'attacker-hardlink-f2.txt');
          expect(() => renameExcl(stageH, rootH, 'published-f2.txt')).toThrowError(
            expect.objectContaining({
              reason: 'PUBLISHED_HARDLINK_DETECTED',
              code: 'PUBLISHED_HARDLINK_DETECTED',
            }),
          );
        } finally {
          close(stageH);
        }

        // Must not stay published at dst, and both links preserve the payload without silent ELOOP
        expect(fs.existsSync(path.join(rootDir, 'published-f2.txt'))).toBe(false);
        const quarantined = fs
          .readdirSync(rootDir)
          .filter((name) => name.startsWith('.adhdev-quarantine-'));
        expect(quarantined.length).toBe(1);
        expect(fs.readFileSync(path.join(rootDir, quarantined[0]!), 'utf8')).toBe('STAGE_F2_PAYLOAD');
        expect(fs.readFileSync(path.join(rootDir, 'attacker-hardlink-f2.txt'), 'utf8')).toBe(
          'STAGE_F2_PAYLOAD',
        );
      } finally {
        close(rootH);
      }
    },
  );

  it('maps ENOSYS, ENOTSUP, EOPNOTSUPP, and renameat2/renameatx_np EINVAL to ATOMIC_NOREPLACE_UNSUPPORTED and reports supportsAtomicNoReplace in probeRoot (F4)', () => {
    const liveProbe = probeRoot(rootDir, { requireAtomicNoReplace: true });
    expect(liveProbe.supportsAtomicNoReplace).toBe(true);

    const rootH = openRoot(rootDir);
    try {
      for (const errName of ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL']) {
        const stageName = `.stage-f4-${errName.toLowerCase()}.tmp`;
        const stageH = createExcl(rootH, stageName, { allowProtectedMetadata: true });
        try {
          writeHandle(stageH, Buffer.from(`PAYLOAD_${errName}`));
          fullFsync(stageH);

          configureTestFaultInjection('atomic_rename_errno', errName);
          expect(() => renameExcl(stageH, rootH, `dst-excl-${errName}.txt`)).toThrowError(
            expect.objectContaining({
              reason: 'ATOMIC_NOREPLACE_UNSUPPORTED',
              code: 'ATOMIC_NOREPLACE_UNSUPPORTED',
            }),
          );
        } finally {
          close(stageH);
        }

        configureTestFaultInjection('atomic_rename_errno', errName);
        expect(() =>
          renameAtExcl(rootH, stageName, rootH, `dst-at-${errName}.txt`, {
            allowProtectedMetadata: true,
          }),
        ).toThrowError(
          expect.objectContaining({
            reason: 'ATOMIC_NOREPLACE_UNSUPPORTED',
            code: 'ATOMIC_NOREPLACE_UNSUPPORTED',
          }),
        );

        configureTestFaultInjection('atomic_rename_errno', errName);
        const unsupportedProbe = probeRoot(rootDir);
        expect(unsupportedProbe.supportsAtomicNoReplace).toBe(false);

        configureTestFaultInjection('atomic_rename_errno', errName);
        expect(() => probeRoot(rootDir, { requireAtomicNoReplace: true })).toThrowError(
          expect.objectContaining({
            reason: 'ATOMIC_NOREPLACE_UNSUPPORTED',
            code: 'ATOMIC_NOREPLACE_UNSUPPORTED',
          }),
        );
      }
    } finally {
      close(rootH);
    }
  });
});
