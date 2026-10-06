/**
 * `discover_repos` scanner (design 2026-10-07-assistant-layer.md §4.4).
 *
 * A bounded walk for git checkouts: 2 s wall clock, depth 3, at most 300
 * directories read. Default roots: ~/Work ~/code ~/src ~/dev ~/Projects
 * (depth 3), ~ itself (depth 1), and the parent directories of known mesh
 * node workspaces (depth 1). Never runs on a timer — only when asked.
 *
 * Returns only `{path, repoIdentity, lastCommitAt, alreadyProject}` per repo.
 * It reads git metadata (`.git/config` remote url, the reflog's last
 * timestamp) to derive those fields and returns no file contents. Hidden
 * directories, `node_modules` and symlinks are not descended; a directory with
 * `.git` is a repo and is not descended either.
 */

import { existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, closeSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { normalizeRepoIdentity } from '../config/mesh-config-store.js';

export const DISCOVER_TIME_BUDGET_MS = 2_000;
export const DISCOVER_MAX_DEPTH = 3;
export const DISCOVER_MAX_DIRS = 300;
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'Library', 'Applications', 'vendor', 'target', 'dist', 'build']);

export interface DiscoverRoot {
    path: string;
    depth: number;
}

export interface DiscoveredRepo {
    path: string;
    repoIdentity: string | null;
    lastCommitAt: string | null;
    alreadyProject: boolean;
}

export interface DiscoverReposResult {
    roots: Array<{ path: string; depth: number; exists: boolean }>;
    repos: DiscoveredRepo[];
    dirsScanned: number;
    /** Set when a bound stopped the scan early. */
    truncated?: 'time' | 'dirs';
}

export interface KnownProjects {
    repoIdentities: ReadonlySet<string>;
    workspaces: ReadonlySet<string>;
}

export interface DiscoverReposOptions {
    roots: readonly DiscoverRoot[];
    known: KnownProjects;
    now?: () => number;
    timeBudgetMs?: number;
    maxDirs?: number;
}

export function defaultDiscoverRoots(meshWorkspaces: readonly string[] = [], home: string = homedir()): DiscoverRoot[] {
    const roots: DiscoverRoot[] = ['Work', 'code', 'src', 'dev', 'Projects'].map((d) => ({ path: join(home, d), depth: DISCOVER_MAX_DEPTH }));
    roots.push({ path: home, depth: 1 });
    for (const ws of meshWorkspaces) if (ws && isAbsolute(ws)) roots.push({ path: dirname(resolve(ws)), depth: 1 });
    return dedupeRoots(roots);
}

/** Caller-supplied roots: absolute (or ~-relative) paths, depth 3. */
export function explicitDiscoverRoots(paths: readonly unknown[], home: string = homedir()): DiscoverRoot[] {
    const out: DiscoverRoot[] = [];
    for (const p of paths) {
        if (typeof p !== 'string' || !p.trim()) continue;
        const raw = p.trim();
        const abs = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
        if (isAbsolute(abs)) out.push({ path: resolve(abs), depth: DISCOVER_MAX_DEPTH });
    }
    return dedupeRoots(out);
}

function dedupeRoots(roots: DiscoverRoot[]): DiscoverRoot[] {
    const byPath = new Map<string, DiscoverRoot>();
    for (const r of roots) {
        const prev = byPath.get(r.path);
        if (!prev || prev.depth < r.depth) byPath.set(r.path, r);
    }
    return [...byPath.values()];
}

function isDir(p: string): boolean {
    try { return statSync(p).isDirectory(); } catch { return false; }
}

/** The git dir holding config/logs for a checkout (`.git` dir, or a linked worktree's common dir). */
function gitCommonDir(repo: string): { gitDir: string; commonDir: string } | null {
    const dotGit = join(repo, '.git');
    try {
        const st = lstatSync(dotGit);
        if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
        if (!st.isFile()) return null;
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf-8'));
        if (!m) return null;
        const gitDir = resolve(repo, m[1].trim());
        const commonFile = join(gitDir, 'commondir');
        const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf-8').trim()) : gitDir;
        return { gitDir, commonDir };
    } catch {
        return null;
    }
}

/** `remote "origin"` url (else the first remote's url), normalized; null when no remote. */
export function readRepoIdentity(commonDir: string): string | null {
    let text: string;
    try { text = readFileSync(join(commonDir, 'config'), 'utf-8'); } catch { return null; }
    let section = '';
    const urls: Array<{ remote: string; url: string }> = [];
    for (const line of text.split(/\r?\n/)) {
        const head = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
        if (head) { section = head[1]; continue; }
        if (/^\s*\[/.test(line)) { section = ''; continue; }
        const url = section ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
        if (url) urls.push({ remote: section, url: url[1] });
    }
    const pick = urls.find((u) => u.remote === 'origin') ?? urls[0];
    const identity = pick ? normalizeRepoIdentity(pick.url) : '';
    return identity || null;
}

/** Timestamp of the reflog's last entry (only the number is parsed), else HEAD's mtime. */
export function readLastCommitAt(gitDir: string): string | null {
    const log = join(gitDir, 'logs', 'HEAD');
    try {
        const size = statSync(log).size;
        const len = Math.min(size, 1024);
        const buf = Buffer.alloc(len);
        const fd = openSync(log, 'r');
        try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
        const lines = buf.toString('utf-8').split('\n').filter(Boolean);
        const m = /> (\d{9,11}) [+-]\d{4}\t/.exec(lines[lines.length - 1] ?? '');
        if (m) return new Date(Number(m[1]) * 1000).toISOString();
    } catch { /* fall through */ }
    try { return statSync(join(gitDir, 'HEAD')).mtime.toISOString(); } catch { return null; }
}

export function discoverRepos(opts: DiscoverReposOptions): DiscoverReposResult {
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.timeBudgetMs ?? DISCOVER_TIME_BUDGET_MS);
    const maxDirs = opts.maxDirs ?? DISCOVER_MAX_DIRS;
    const repos = new Map<string, DiscoveredRepo>();
    const roots = opts.roots.map((r) => ({ ...r, exists: isDir(r.path) }));
    const queue: Array<{ path: string; left: number }> = roots.filter((r) => r.exists).map((r) => ({ path: r.path, left: r.depth }));
    const visited = new Set<string>();
    let dirsScanned = 0;
    let truncated: DiscoverReposResult['truncated'];

    const record = (path: string) => {
        if (repos.has(path)) return;
        const git = gitCommonDir(path);
        if (!git) return;
        const repoIdentity = readRepoIdentity(git.commonDir);
        repos.set(path, {
            path,
            repoIdentity,
            lastCommitAt: readLastCommitAt(git.gitDir),
            alreadyProject: opts.known.workspaces.has(path) || (!!repoIdentity && opts.known.repoIdentities.has(repoIdentity)),
        });
    };

    while (queue.length > 0) {
        if (now() > deadline) { truncated = 'time'; break; }
        if (dirsScanned >= maxDirs) { truncated = 'dirs'; break; }
        const { path, left } = queue.shift()!;
        if (visited.has(path)) continue;
        visited.add(path);
        if (existsSync(join(path, '.git'))) { record(path); continue; }
        if (left <= 0) continue;
        let names: string[];
        try { names = readdirSync(path); } catch { continue; }
        dirsScanned++;
        for (const name of names.sort()) {
            if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
            const child = join(path, name);
            try {
                const st = lstatSync(child);
                if (!st.isDirectory() || st.isSymbolicLink()) continue;
            } catch { continue; }
            if (existsSync(join(child, '.git'))) record(child);
            else if (left > 1) queue.push({ path: child, left: left - 1 });
        }
    }

    return {
        roots: roots.map(({ path, depth, exists }) => ({ path, depth, exists })),
        repos: [...repos.values()].sort((a, b) => (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? '')),
        dirsScanned,
        ...(truncated ? { truncated } : {}),
    };
}
