/**
 * Contract versioning — exact multi-repository source reader (design §5, F4).
 *
 * Reads normative unit bytes from IMMUTABLE git objects named by commit OID,
 * through a root→submodule gitlink chain, never from a working tree:
 *
 *   - a sanitized read-only object reader: replace objects off
 *     (`--no-replace-objects` + GIT_NO_REPLACE_OBJECTS), system/global config
 *     ignored, every GIT_DIR/GIT_OBJECT_DIRECTORY/alternates override stripped,
 *     no prompts; `cat-file blob` never runs textconv/smudge/filters;
 *   - every hop verified: the parent tree entry at the gitlink path must be a
 *     160000 gitlink naming exactly the declared child commit, and the child
 *     commit must exist in the child binding's own object database (a parent
 *     tree does not attest to bytes inside a differently checked-out submodule);
 *   - the final entry must be a regular blob (100644/100755) — trees, gitlinks
 *     and symlinks (120000) are refused for normative units in the MVP;
 *   - the retrieved bytes are re-hashed as a git blob (sha1/sha256 per the
 *     repository) AND as plain SHA-256 before any availability claim;
 *   - no implicit fetch, no mutation of any repository.
 *
 * A dirty continuation workspace is observed separately (`observeWorkspace`):
 * that record is timestamped drift evidence, never an immutable source pin.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContractRefusal, type ContractSourceEntry } from './contract-types.js';

export interface ContractRepoBindingRecord {
    repoBindingId: string;
    repoPath: string;
    /** Realpath of `git rev-parse --git-common-dir` at enrollment — the repository identity. */
    commonDir: string;
    hashAlgorithm: 'sha1' | 'sha256';
}

export interface ContractSourceRequest {
    repoBindingId: string;
    commitOid: string;
    gitlinks?: Array<{ path: string; childRepoBindingId: string }>;
    path: string;
}

export interface ContractWorkspaceObservation {
    observedAtMs: number;
    repoBindingId: string;
    headOid: string | null;
    entries: Array<{ path: string; status: string; worktreeSha256: string | null }>;
}

export interface ContractSourceReader {
    describeRepository(repoPath: string): { commonDir: string; hashAlgorithm: 'sha1' | 'sha256' };
    resolveBlob(
        bindings: ReadonlyMap<string, ContractRepoBindingRecord>,
        request: ContractSourceRequest,
        maxBytes: number,
    ): { entry: ContractSourceEntry; bytes: Buffer };
    observeWorkspace(binding: ContractRepoBindingRecord, paths: readonly string[], nowMs: number): ContractWorkspaceObservation;
}

const STRIPPED_GIT_ENV = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT', 'GIT_EXTERNAL_DIFF', 'GIT_EXEC_PATH', 'GIT_SHALLOW_FILE',
];

/** Minimal env: PATH/system roots only, plus the read-only hardening switches. */
export function sanitizedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) {
        if (typeof base[key] === 'string') env[key] = base[key];
    }
    for (const key of STRIPPED_GIT_ENV) delete env[key];
    env.HOME = os.tmpdir();
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = os.devNull;
    env.GIT_NO_REPLACE_OBJECTS = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_NO_LAZY_FETCH = '1';
    return env;
}

/** Repository-relative normative path: no traversal, no absolute, no backslash, no `.git` segment. */
export function validateContractPath(p: unknown): string {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\u0000') || p.includes('\\')) {
        throw new ContractRefusal('invalid_source');
    }
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new ContractRefusal('invalid_source');
    const segs = p.split('/');
    for (const s of segs) {
        if (!s || s === '.' || s === '..' || s.toLowerCase() === '.git') throw new ContractRefusal('invalid_source');
    }
    return p;
}

function isFullOid(oid: unknown, algo: 'sha1' | 'sha256'): oid is string {
    return typeof oid === 'string' && (algo === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(oid);
}

export function gitBlobOid(bytes: Buffer, algo: 'sha1' | 'sha256'): string {
    return createHash(algo).update(`blob ${bytes.length}\u0000`).update(bytes).digest('hex');
}

function git(repoPath: string, args: string[], maxBuffer = 1024 * 1024): Buffer {
    return execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', repoPath, ...args], {
        env: sanitizedGitEnv(),
        maxBuffer,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 30_000,
    });
}

function tryGit(repoPath: string, args: string[], maxBuffer?: number): Buffer | null {
    try { return git(repoPath, args, maxBuffer); } catch { return null; }
}

/** One `ls-tree` entry at an exact path of an exact commit. */
function lsTreeEntry(repoPath: string, commitOid: string, entryPath: string): { mode: string; type: string; oid: string } | null {
    const out = tryGit(repoPath, ['ls-tree', '-z', '--full-tree', commitOid, '--', entryPath]);
    if (!out) return null;
    const records = out.toString('utf8').split('\u0000').filter(Boolean);
    if (records.length !== 1) return null;
    const tab = records[0].indexOf('\t');
    if (tab < 0) return null;
    const [mode, type, oid] = records[0].slice(0, tab).split(' ');
    const name = records[0].slice(tab + 1);
    if (name !== entryPath) return null;
    return { mode, type, oid };
}

function objectType(repoPath: string, oid: string): string | null {
    const out = tryGit(repoPath, ['cat-file', '-t', oid]);
    return out ? out.toString('utf8').trim() : null;
}

function verifyBindingIdentity(binding: ContractRepoBindingRecord): void {
    let current: string;
    try {
        current = resolveCommonDir(binding.repoPath);
    } catch {
        throw new ContractRefusal('source_unavailable');
    }
    if (current !== binding.commonDir) throw new ContractRefusal('invalid_source');
}

function resolveCommonDir(repoPath: string): string {
    const out = git(repoPath, ['rev-parse', '--git-common-dir']).toString('utf8').trim();
    const abs = path.isAbsolute(out) ? out : path.resolve(repoPath, out);
    return realpathSync(abs);
}

export class GitContractSourceReader implements ContractSourceReader {
    describeRepository(repoPath: string): { commonDir: string; hashAlgorithm: 'sha1' | 'sha256' } {
        if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath) || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
            throw new ContractRefusal('invalid_source');
        }
        let commonDir: string;
        try { commonDir = resolveCommonDir(repoPath); } catch { throw new ContractRefusal('invalid_source'); }
        const fmt = tryGit(repoPath, ['rev-parse', '--show-object-format'])?.toString('utf8').trim();
        return { commonDir, hashAlgorithm: fmt === 'sha256' ? 'sha256' : 'sha1' };
    }

    resolveBlob(
        bindings: ReadonlyMap<string, ContractRepoBindingRecord>,
        request: ContractSourceRequest,
        maxBytes: number,
    ): { entry: ContractSourceEntry; bytes: Buffer } {
        const root = bindings.get(request.repoBindingId);
        if (!root) throw new ContractRefusal('invalid_source');
        verifyBindingIdentity(root);
        if (!isFullOid(request.commitOid, root.hashAlgorithm)) throw new ContractRefusal('invalid_source');
        if (objectType(root.repoPath, request.commitOid) !== 'commit') throw new ContractRefusal('source_unavailable');

        let repo = root;
        let commit = request.commitOid;
        const hops: ContractSourceEntry['gitlinks'] = [];
        for (const hop of request.gitlinks ?? []) {
            const hopPath = validateContractPath(hop.path);
            const entry = lsTreeEntry(repo.repoPath, commit, hopPath);
            if (!entry || entry.mode !== '160000' || entry.type !== 'commit') throw new ContractRefusal('invalid_source');
            const child = bindings.get(hop.childRepoBindingId);
            if (!child) throw new ContractRefusal('invalid_source');
            verifyBindingIdentity(child);
            if (!isFullOid(entry.oid, child.hashAlgorithm)) throw new ContractRefusal('invalid_source');
            if (objectType(child.repoPath, entry.oid) !== 'commit') throw new ContractRefusal('source_unavailable');
            hops.push({ path: hopPath, childRepoBindingId: child.repoBindingId, childCommitOid: entry.oid });
            repo = child;
            commit = entry.oid;
        }

        const unitPath = validateContractPath(request.path);
        const leaf = lsTreeEntry(repo.repoPath, commit, unitPath);
        if (!leaf) throw new ContractRefusal('source_unavailable');
        if (leaf.type !== 'blob' || (leaf.mode !== '100644' && leaf.mode !== '100755')) throw new ContractRefusal('invalid_source');
        let bytes: Buffer;
        try {
            bytes = git(repo.repoPath, ['cat-file', 'blob', leaf.oid], maxBytes + 1);
        } catch (e: any) {
            if (e && (e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message)))) throw new ContractRefusal('budget_exceeded');
            throw new ContractRefusal('source_unavailable');
        }
        if (bytes.length > maxBytes) throw new ContractRefusal('budget_exceeded');
        if (gitBlobOid(bytes, repo.hashAlgorithm) !== leaf.oid) throw new ContractRefusal('source_digest_mismatch');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        return {
            bytes,
            entry: {
                repoBindingId: root.repoBindingId,
                hashAlgorithm: repo.hashAlgorithm,
                commitOid: request.commitOid,
                gitlinks: hops,
                path: unitPath,
                blobOid: leaf.oid,
                mode: leaf.mode,
                byteLength: bytes.length,
                sha256,
            },
        };
    }

    observeWorkspace(binding: ContractRepoBindingRecord, paths: readonly string[], nowMs: number): ContractWorkspaceObservation {
        const head = tryGit(binding.repoPath, ['rev-parse', '--verify', '-q', 'HEAD'])?.toString('utf8').trim() || null;
        const statusRaw = tryGit(binding.repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths.map(validateContractPath)])
            ?.toString('utf8') ?? '';
        const statusByPath = new Map<string, string>();
        for (const rec of statusRaw.split('\u0000').filter(Boolean)) {
            if (rec.length > 3) statusByPath.set(rec.slice(3), rec.slice(0, 2));
        }
        const entries = paths.map((p) => {
            const abs = path.join(binding.repoPath, p);
            let worktreeSha256: string | null = null;
            try {
                if (existsSync(abs) && statSync(abs).isFile()) worktreeSha256 = createHash('sha256').update(readFileSync(abs)).digest('hex');
            } catch { /* observation only */ }
            return { path: p, status: statusByPath.get(p) ?? 'clean', worktreeSha256 };
        });
        return { observedAtMs: nowMs, repoBindingId: binding.repoBindingId, headOid: head, entries };
    }
}
