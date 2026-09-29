/**
 * Cheap change detector for a workspace's git state — the member side of the
 * coordinator-held node state (mesh-node-state-pusher.ts) uses it so a commit,
 * checkout, reset, merge or `git add` made OUTSIDE any daemon event (a terminal,
 * an editor) reaches the coordinator within about a second, instead of on the
 * next heartbeat.
 *
 * What is watched (never the working tree — node_modules-sized trees would cost
 * a watcher per directory on Linux):
 *   - the worktree's git dir (`.git/`, or the `gitdir:` a linked worktree's
 *     `.git` file names): HEAD, index, ORIG_HEAD, MERGE_HEAD, REBASE_HEAD,
 *     CHERRY_PICK_HEAD, packed-refs;
 *   - the common dir (the main repository's git dir for a linked worktree):
 *     packed-refs, and `refs/` recursively (branch / remote-tracking moves).
 * Directories are watched, not the files: git replaces HEAD / index / refs by
 * renaming a `*.lock` file over them, which silently orphans a watch on the
 * file's old inode on Linux.
 *
 * Nothing here spawns git or polls: the callback only says "something under the
 * git dir moved" (debounced, so one commit's burst of writes is one callback);
 * the caller decides whether to re-read. Lock files, FETCH_HEAD and reflogs are
 * ignored. Platform notes: recursive `fs.watch` exists on macOS and Windows
 * everywhere and on Linux since Node 20 — where it throws, `refs/heads` and
 * `refs/remotes` are watched one level deep instead. A git dir that cannot be
 * watched at all (unusual filesystems, a missing path) returns null so the
 * caller keeps its own periodic check for that workspace.
 */
import * as fs from 'fs';
import * as path from 'path';

/** A burst of git writes (one commit touches index, HEAD, refs, logs) becomes one callback after this quiet period. */
export const WORKSPACE_GIT_WATCH_DEBOUNCE_MS = 750;

/** Names under a git dir whose change can change the visible git state. */
const GIT_DIR_TRIGGER_NAMES: ReadonlySet<string> = new Set([
    'HEAD', 'index', 'ORIG_HEAD', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'packed-refs',
]);

export interface WorkspaceGitDirs {
    /** The worktree's own git dir (HEAD, index). */
    gitDir: string;
    /** Where refs / packed-refs live (the same as gitDir for a plain checkout). */
    commonDir: string;
}

/** Resolve a workspace's git dirs without spawning git (`.git` directory, or a linked worktree's `.git` file). */
export function resolveWorkspaceGitDirs(workspace: string): WorkspaceGitDirs | null {
    if (typeof workspace !== 'string' || !workspace) return null;
    const dotGit = path.join(workspace, '.git');
    let gitDir: string;
    try {
        const info = fs.statSync(dotGit);
        if (info.isDirectory()) {
            gitDir = dotGit;
        } else if (info.isFile()) {
            const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
            if (!match) return null;
            gitDir = path.resolve(workspace, match[1]!.trim());
        } else {
            return null;
        }
    } catch {
        return null;
    }
    let commonDir = gitDir;
    try {
        const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (common) commonDir = path.resolve(gitDir, common);
    } catch { /* a plain checkout has no commondir file */ }
    return { gitDir, commonDir };
}

/** Whether a changed path (relative to the watched dir) can move the visible git state. */
export function isGitStateTrigger(kind: 'gitDir' | 'refs', filename: string | null | undefined): boolean {
    // No filename (some platforms / overflow): assume it mattered.
    if (!filename) return true;
    const name = String(filename).replace(/\\/g, '/');
    const base = name.split('/').pop() ?? name;
    if (base.endsWith('.lock')) return false;
    if (kind === 'refs') return true;
    return GIT_DIR_TRIGGER_NAMES.has(base) && !name.includes('/');
}

type WatchFn = (target: string, options: { recursive?: boolean; persistent?: boolean }, listener: (event: string, filename: string | Buffer | null) => void) => fs.FSWatcher;

export interface WatchWorkspaceGitOptions {
    debounceMs?: number;
    /** Injected for tests (defaults to fs.watch). */
    watch?: WatchFn;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    /** Called once when a watch errors out (the caller falls back to its periodic check). */
    onError?: (error: unknown) => void;
    /** Injected for tests (defaults to resolveWorkspaceGitDirs). */
    resolveDirs?: (workspace: string) => WorkspaceGitDirs | null;
}

export interface WorkspaceGitWatchHandle {
    stop(): void;
}

/**
 * Watch `workspace`'s git dirs; `onChange` fires (debounced) when something
 * that can change the visible git state moved. Returns null when nothing could
 * be watched.
 */
export function watchWorkspaceGit(
    workspace: string,
    onChange: () => void,
    opts: WatchWorkspaceGitOptions = {},
): WorkspaceGitWatchHandle | null {
    const dirs = (opts.resolveDirs ?? resolveWorkspaceGitDirs)(workspace);
    if (!dirs) return null;
    const watch: WatchFn = opts.watch ?? ((target, options, listener) => fs.watch(target, options, listener as any));
    const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        (handle as { unref?: () => void }).unref?.();
        return handle;
    });
    const clearTimeoutFn = opts.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const debounceMs = opts.debounceMs ?? WORKSPACE_GIT_WATCH_DEBOUNCE_MS;
    const watchers: fs.FSWatcher[] = [];
    let timer: unknown = null;
    let stopped = false;
    let errored = false;

    const stop = () => {
        stopped = true;
        if (timer !== null) clearTimeoutFn(timer);
        timer = null;
        for (const watcher of watchers.splice(0)) {
            try { watcher.close(); } catch { /* noop */ }
        }
    };
    const fire = () => {
        if (stopped) return;
        if (timer !== null) clearTimeoutFn(timer);
        timer = setTimeoutFn(() => {
            timer = null;
            if (stopped) return;
            try { onChange(); } catch { /* the caller's problem, never the watcher's */ }
        }, debounceMs);
    };
    const add = (target: string, kind: 'gitDir' | 'refs', recursive: boolean): boolean => {
        let watcher: fs.FSWatcher;
        try {
            watcher = watch(target, { recursive, persistent: false }, (_event, filename) => {
                if (isGitStateTrigger(kind, filename == null ? null : String(filename))) fire();
            });
        } catch {
            return false;
        }
        watcher.on?.('error', (error: unknown) => {
            if (errored) return;
            errored = true;
            stop();
            opts.onError?.(error);
        });
        watchers.push(watcher);
        return true;
    };

    if (!add(dirs.gitDir, 'gitDir', false)) {
        stop();
        return null;
    }
    if (dirs.commonDir !== dirs.gitDir) add(dirs.commonDir, 'gitDir', false);
    const refs = path.join(dirs.commonDir, 'refs');
    if (!add(refs, 'refs', true)) {
        // No recursive watch on this platform / Node: one level of the two ref
        // namespaces that move the visible state (local branches, remote-tracking).
        add(path.join(refs, 'heads'), 'refs', false);
        try {
            for (const remote of fs.readdirSync(path.join(refs, 'remotes'))) add(path.join(refs, 'remotes', remote), 'refs', false);
        } catch { /* no remotes */ }
    }
    return { stop };
}
