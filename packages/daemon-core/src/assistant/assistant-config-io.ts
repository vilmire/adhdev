/**
 * Private filesystem boundary enforcement and atomic conflict-checked config
 * writer for the assistant workspace (`<configDir>/assistant`) and its MCP
 * configuration files (`<workspace>/.codex/config.toml`,
 * `<configDir>/mcp-configs/assistant.json`, `<privateHome>/...`).
 *
 * Security & Durability Guarantees:
 * 1. Private Boundary (P1): Every directory segment from `configDir` down to
 *    `workspace` and the config parent directory is verified via `lstatSync`
 *    (never traversing symlinks, non-directories, or foreign-UID directories;
 *    newly created directories use `0700`) and checked with `realpathSync`
 *    containment. Existing target config files are verified via `lstatSync` +
 *    `O_NOFOLLOW` + `fstatSync` to be regular files owned by the current UID
 *    (`stat.uid === process.geteuid()` on POSIX) with `nlink === 1` (refusing
 *    live or dangling symlinks, hardlinks, FIFOs, sockets, or directories),
 *    while newly created temporary/replacement files use mode `0600`.
 * 2. Write Minimization & Atomic Replacement (P2): If `transform(before)`
 *    produces `next === before` on an existing regular file, no write occurs.
 *    When a write is needed, bytes are written to an `O_CREAT | O_EXCL`
 *    temporary file (`0600`) in the same canonical directory, flushed with
 *    `fsyncSync`, re-validated against concurrent modification or symlink
 *    replacement right before `renameSync`, and retried (re-running `transform`
 *    over the latest bytes) if a concurrent native/user edit occurred.
 *    Residual OS limit: POSIX `rename(2)` is an unconditional directory-entry
 *    replacement rather than an atomic kernel compare-and-swap (CAS) on the
 *    target inode; a narrow TOCTOU window remains between the final pre-rename
 *    `readPrivateAssistantConfigSnapshot` check and `renameSync(tmpPath, canonicalFilePath)`.
 *    Write minimization (`next === before` no-op on ordinary relaunches) avoids
 *    entering the rename path once the stable server entry is present.
 */

import { randomUUID } from 'node:crypto';
import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeSync,
    type Stats,
} from 'node:fs';
import * as os from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
    buildMeshCoordinatorMcpServerEntry,
    getMcpServersKey,
    isSupportedMeshCoordinatorConfigFormat,
    parseMeshCoordinatorMcpConfig,
    serializeMeshCoordinatorMcpConfig,
} from '../mesh/mesh-coordinator-config.js';
import { isOverBroadTrustRoot } from '../providers/workspace-trust-shared.js';
import {
    ASSISTANT_CODEX_MCP_CONFIG_FORMAT,
    mergeAssistantCodexMcpConfigToml,
    type AssistantMcpConfigWrite,
} from './assistant-launch-plan.js';

const O_NOFOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

function unsafePathError(message: string): Error {
    return new Error(`assistant_unsafe_path: ${message}`);
}

function conflictError(message: string): Error {
    return new Error(`assistant_config_write_conflict: ${message}`);
}

function assertOwnedByCurrentUser(stat: Stats, targetPath: string): void {
    if (process.platform !== 'win32' && typeof process.geteuid === 'function') {
        const uid = process.geteuid();
        if (stat.uid !== uid) {
            throw unsafePathError(`path ${targetPath} is owned by uid ${stat.uid}, expected ${uid}`);
        }
    }
}

function lstatOrNull(targetPath: string): Stats | null {
    try {
        return lstatSync(targetPath);
    } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        throw err;
    }
}

function assertNotGlobalProviderConfigDir(realTarget: string): void {
    const home = os.homedir();
    const candidates: string[] = [];
    for (const rel of ['.codex', '.gemini', '.claude', '.cursor']) {
        const p = join(home, rel);
        candidates.push(resolve(p));
        try {
            candidates.push(realpathSync(p));
        } catch {
            // ignore missing global dirs
        }
    }
    for (const globalDir of candidates) {
        if (realTarget === globalDir || realTarget.startsWith(globalDir + sep)) {
            throw unsafePathError(`target ${realTarget} resolves inside global provider config directory ${globalDir}`);
        }
    }
}

/**
 * Ensure `rootDir` and every directory segment down to `targetDir` exist as
 * real (non-symlink) directories owned by the current user, and verify that
 * `realpathSync(targetDir)` stays inside `realpathSync(rootDir)`.
 */
export function ensurePrivateAssistantDirectoryChain(rootDir: string, targetDir: string): string {
    const resolvedRoot = resolve(rootDir);
    const resolvedTarget = resolve(targetDir);
    if (!isAbsolute(resolvedRoot) || !isAbsolute(resolvedTarget)) {
        throw unsafePathError('assistant directory paths must be absolute');
    }
    if (isOverBroadTrustRoot(resolvedRoot)) {
        throw unsafePathError(`refusing over-broad assistant root directory ${resolvedRoot}`);
    }

    const rel = relative(resolvedRoot, resolvedTarget);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw unsafePathError(`target directory ${resolvedTarget} escapes root ${resolvedRoot}`);
    }

    let rootStat = lstatOrNull(resolvedRoot);
    if (!rootStat) {
        mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
        rootStat = lstatOrNull(resolvedRoot);
    }
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw unsafePathError(`assistant root ${resolvedRoot} must be a real directory (not a symlink)`);
    }
    assertOwnedByCurrentUser(rootStat, resolvedRoot);

    const segments = rel.split(sep).filter(Boolean);
    let cursor = resolvedRoot;
    for (const seg of segments) {
        if (seg === '.' || seg === '..') {
            throw unsafePathError(`invalid relative segment "${seg}" under ${resolvedRoot}`);
        }
        cursor = join(cursor, seg);
        let stat = lstatOrNull(cursor);
        if (!stat) {
            mkdirSync(cursor, { mode: 0o700 });
            stat = lstatOrNull(cursor);
        }
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
            throw unsafePathError(`assistant directory component ${cursor} must be a real directory (not a symlink)`);
        }
        assertOwnedByCurrentUser(stat, cursor);
    }

    const realRoot = realpathSync(resolvedRoot);
    const realTarget = realpathSync(resolvedTarget);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
        throw unsafePathError(`canonical directory ${realTarget} escapes canonical root ${realRoot}`);
    }
    if (isOverBroadTrustRoot(realTarget)) {
        throw unsafePathError(`canonical directory ${realTarget} is an over-broad root`);
    }
    assertNotGlobalProviderConfigDir(realTarget);
    return realTarget;
}

/** Ensure `<configDir>/assistant` is a private, non-symlinked directory inside `configDir`. */
export function ensurePrivateAssistantWorkspace(configDir: string, workspace: string): string {
    return ensurePrivateAssistantDirectoryChain(configDir, workspace);
}

interface PrivateFileSnapshot {
    exists: boolean;
    content: string;
    ino: number;
    dev: number;
    size: number;
    mtimeMs: number;
}

function readPrivateAssistantConfigSnapshot(
    requestedFilePath: string,
    canonicalFilePath: string,
    expectedRealParent: string,
): PrivateFileSnapshot {
    // Check both the requested path and the canonical parent path for symlinks/hardlinks.
    for (const candidate of new Set([resolve(requestedFilePath), canonicalFilePath])) {
        const lstat = lstatOrNull(candidate);
        if (!lstat) continue;
        if (lstat.isSymbolicLink()) {
            throw unsafePathError(`config file ${candidate} must not be a symlink`);
        }
        if (!lstat.isFile()) {
            throw unsafePathError(`config file ${candidate} must be a regular file`);
        }
        if (lstat.nlink > 1) {
            throw unsafePathError(`config file ${candidate} must not have multiple hard links (nlink=${lstat.nlink})`);
        }
        assertOwnedByCurrentUser(lstat, candidate);
    }

    const lstat = lstatOrNull(canonicalFilePath);
    if (!lstat) {
        return { exists: false, content: '', ino: 0, dev: 0, size: 0, mtimeMs: 0 };
    }

    let fd: number | null = null;
    try {
        fd = openSync(canonicalFilePath, fsConstants.O_RDONLY | O_NOFOLLOW_FLAG);
        const fstat = fstatSync(fd);
        if (!fstat.isFile() || fstat.nlink > 1 || fstat.ino !== lstat.ino || fstat.dev !== lstat.dev) {
            throw unsafePathError(`config file ${canonicalFilePath} changed or failed descriptor verification on open`);
        }
        assertOwnedByCurrentUser(fstat, canonicalFilePath);
        const realFile = realpathSync(canonicalFilePath);
        if (realFile !== canonicalFilePath || dirname(realFile) !== expectedRealParent) {
            throw unsafePathError(`canonical config file ${realFile} does not match expected ${canonicalFilePath}`);
        }
        const content = readFileSync(fd, 'utf-8');
        return {
            exists: true,
            content,
            ino: fstat.ino,
            dev: fstat.dev,
            size: fstat.size,
            mtimeMs: fstat.mtimeMs,
        };
    } finally {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* ignore */ }
        }
    }
}

export interface WriteProtectedAssistantConfigOptions {
    rootDir: string;
    filePath: string;
    transform: (before: string) => string;
    maxRetries?: number;
    /** Test-only hook invoked after writing the temp file and immediately before revalidation + rename. */
    onBeforeRenameForTest?: (attempt: number, canonicalFilePath: string, tempFilePath: string) => void;
    /** Test-only hook to simulate a mid-write IO failure on the temporary file. */
    onWriteTempChunkForTest?: (fd: number, buffer: Buffer, offset: number) => number;
}

/**
 * Atomically update `filePath` inside `rootDir` with symlink/hardlink/ownership
 * protection, write minimization (`next === before`), and pre-rename conflict
 * detection + retry.
 */
export function writeProtectedAssistantConfigFile(
    options: WriteProtectedAssistantConfigOptions,
): { written: boolean; content: string } {
    const resolvedFilePath = resolve(options.filePath);
    const parentDir = dirname(resolvedFilePath);
    const fileName = basename(resolvedFilePath);
    if (!fileName || fileName === '.' || fileName === '..') {
        throw unsafePathError(`invalid config file name: ${options.filePath}`);
    }

    const maxRetries = Math.max(1, options.maxRetries ?? 3);
    const realParent = ensurePrivateAssistantDirectoryChain(options.rootDir, parentDir);
    const canonicalFilePath = join(realParent, fileName);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const snapshot = readPrivateAssistantConfigSnapshot(resolvedFilePath, canonicalFilePath, realParent);
        const next = options.transform(snapshot.content);

        if (snapshot.exists && next === snapshot.content) {
            return { written: false, content: next };
        }

        const tmpPath = join(
            realParent,
            `.${fileName}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
        );
        let tmpFd: number | null = null;
        let renamed = false;

        try {
            tmpFd = openSync(
                tmpPath,
                fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW_FLAG,
                0o600,
            );
            const tmpStat = fstatSync(tmpFd);
            if (!tmpStat.isFile() || tmpStat.nlink !== 1) {
                throw unsafePathError(`temporary config file ${tmpPath} is not an isolated regular file`);
            }
            assertOwnedByCurrentUser(tmpStat, tmpPath);

            const buf = Buffer.from(next, 'utf-8');
            let offset = 0;
            while (offset < buf.length) {
                const writtenBytes = options.onWriteTempChunkForTest
                    ? options.onWriteTempChunkForTest(tmpFd, buf, offset)
                    : writeSync(tmpFd, buf, offset, buf.length - offset);
                if (!Number.isInteger(writtenBytes) || writtenBytes <= 0) {
                    throw new Error('EIO: short or zero-byte write while writing temporary assistant config');
                }
                offset += writtenBytes;
            }

            fsyncSync(tmpFd);
            closeSync(tmpFd);
            tmpFd = null;

            options.onBeforeRenameForTest?.(attempt, canonicalFilePath, tmpPath);

            // Re-validate parent directory chain and target file state right before atomic rename.
            const recheckedParent = ensurePrivateAssistantDirectoryChain(options.rootDir, parentDir);
            if (recheckedParent !== realParent) {
                throw unsafePathError(`parent directory ${parentDir} changed canonical location during write`);
            }

            const preRenameSnapshot = readPrivateAssistantConfigSnapshot(resolvedFilePath, canonicalFilePath, realParent);
            const changedConcurrently =
                preRenameSnapshot.exists !== snapshot.exists
                || (snapshot.exists && (
                    preRenameSnapshot.ino !== snapshot.ino
                    || preRenameSnapshot.dev !== snapshot.dev
                    || preRenameSnapshot.size !== snapshot.size
                    || preRenameSnapshot.mtimeMs !== snapshot.mtimeMs
                    || preRenameSnapshot.content !== snapshot.content
                ));

            if (changedConcurrently) {
                try { unlinkSync(tmpPath); } catch { /* ignore */ }
                if (attempt + 1 < maxRetries) {
                    continue;
                }
                throw conflictError(`concurrent modification detected on ${canonicalFilePath} after ${maxRetries} attempts`);
            }

            renameSync(tmpPath, canonicalFilePath);
            renamed = true;

            // Best-effort parent directory fsync on POSIX.
            if (process.platform !== 'win32') {
                let dirFd: number | null = null;
                try {
                    dirFd = openSync(realParent, fsConstants.O_RDONLY | O_NOFOLLOW_FLAG);
                    fsyncSync(dirFd);
                } catch {
                    // Some filesystems do not support fsync on directory fds; ignore.
                } finally {
                    if (dirFd !== null) {
                        try { closeSync(dirFd); } catch { /* ignore */ }
                    }
                }
            }

            return { written: true, content: next };
        } finally {
            if (tmpFd !== null) {
                try { closeSync(tmpFd); } catch { /* ignore */ }
            }
            if (!renamed) {
                try { unlinkSync(tmpPath); } catch { /* ignore */ }
            }
        }
    }

    throw conflictError(`failed to write ${canonicalFilePath} due to repeated concurrent modifications`);
}

export interface WriteAssistantMcpConfigContext {
    configDir?: string;
    workspace?: string;
    privateHomeDir?: string;
}

function resolveAllowedConfigRoot(w: AssistantMcpConfigWrite, ctx?: WriteAssistantMcpConfigContext): string {
    const target = resolve(w.path);
    const candidates = [ctx?.workspace, ctx?.privateHomeDir, ctx?.configDir].filter(
        (c): c is string => typeof c === 'string' && c.trim().length > 0,
    );
    for (const candidate of candidates) {
        const resolvedCandidate = resolve(candidate);
        const rel = relative(resolvedCandidate, target);
        if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
            if (ctx?.configDir && resolvedCandidate !== resolve(ctx.configDir)) {
                ensurePrivateAssistantDirectoryChain(ctx.configDir, resolvedCandidate);
            }
            return resolvedCandidate;
        }
    }
    if (ctx?.configDir) {
        throw unsafePathError(`config path ${w.path} is outside assistant roots under ${ctx.configDir}`);
    }
    return dirname(target);
}

/** Merge the assistant server into the (daemon-owned) MCP config file with private boundary & atomic replacement. */
export function writeAssistantMcpConfig(w: AssistantMcpConfigWrite, ctx?: WriteAssistantMcpConfigContext): void {
    const rootDir = resolveAllowedConfigRoot(w, ctx);
    if (w.format === ASSISTANT_CODEX_MCP_CONFIG_FORMAT) {
        writeProtectedAssistantConfigFile({
            rootDir,
            filePath: w.path,
            transform: (before) => mergeAssistantCodexMcpConfigToml(before, w.serverName, w.server),
        });
        return;
    }
    if (!isSupportedMeshCoordinatorConfigFormat(w.format)) {
        throw new Error(`unsupported MCP config format: ${w.format}`);
    }
    const format = w.format;
    writeProtectedAssistantConfigFile({
        rootDir,
        filePath: w.path,
        transform: (before) => {
            const parsed = before ? parseMeshCoordinatorMcpConfig(before, format) : {};
            const key = getMcpServersKey(format);
            const servers = parsed[key] && typeof parsed[key] === 'object' && !Array.isArray(parsed[key]) ? parsed[key] : {};
            return serializeMeshCoordinatorMcpConfig({
                ...parsed,
                [key]: { ...servers, [w.serverName]: buildMeshCoordinatorMcpServerEntry(format, w.server) },
            }, format);
        },
    });
}
