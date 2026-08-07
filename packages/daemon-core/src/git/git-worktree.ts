/**
 * Git Worktree — Create/remove/list worktrees for Repo Mesh node cloning
 *
 * Used by the `clone_mesh_node` daemon command to create isolated
 * worktree-based nodes for parallel branch work within a mesh.
 *
 * Worktrees are placed under a home-directory base (outside every source repo)
 * to avoid .gitignore pollution and submodule conflicts:
 *   <configDir>/worktrees/<meshName>/<branch>/
 * where <configDir> is track-aware (`~/.adhdev` stable, `~/.adhdev-preview`
 * preview), so the two tracks never share a worktree tree.
 *
 * The base can be overridden per-clone via `worktreeBaseDir` (mesh policy);
 * see resolveWorktreeBaseDir / resolveWorktreePath.
 */

import * as path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveConfigDir } from '../config/config-dir.js';

const execFileAsync = promisify(execFile);

/** Directory name (under the base) that namespaces all managed worktrees. */
const WORKTREE_DIR_NAME = 'worktrees';

/**
 * Default base directory that holds all managed mesh worktrees:
 * `<configDir>/worktrees`, where the config dir is the TRACK's dir
 * (`.adhdev` stable / `.adhdev-preview` preview) — never a hard-coded
 * `.adhdev`.
 *
 * This used to join `.adhdev` literally, which quietly put a preview daemon's
 * worktrees inside the STABLE config dir. Nothing errored — the directory
 * exists on both tracks — so both tracks' worktrees piled into one tree and
 * the per-track isolation that separate config dirs are meant to provide was
 * silently defeated. Observed live: a preview daemon (port 19223) had created
 * every one of its mesh worktrees under `~/.adhdev/worktrees/`.
 *
 * Delegates to resolveConfigDir() so this honors ADHDEV_CONFIG_DIR too: a
 * daemon pointed at a custom config dir now keeps its worktrees with the rest
 * of its state instead of stranding them in `~/.adhdev`. Resolved per call
 * (not a module-load snapshot) for the same reason config-dir.ts does it —
 * homedir()/env are read at call time. `path.join` emits the platform-native
 * separator, so this stays correct on win32 (%USERPROFILE%).
 */
export function getDefaultWorktreeBaseDir(): string {
    return path.join(resolveConfigDir(), WORKTREE_DIR_NAME);
}
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const SUBMODULE_WORKTREE_REMOVE_RE = /working trees containing submodules cannot be moved or removed/i;

// ─── Types ──────────────────────────────────────

export interface WorktreeCreateOptions {
    /** Absolute path to the source repo's git root */
    repoRoot: string;
    /** Branch name for the new worktree */
    branch: string;
    /** Starting point for the branch (default: HEAD) */
    baseBranch?: string;
    /** Mesh name, used for organizing worktree directories */
    meshName: string;
    /** Override the auto-resolved target directory */
    targetDir?: string;
    /**
     * Base directory under which the worktree is placed as
     * `<worktreeBaseDir>/<meshName>/<branch>`. When omitted (or blank), defaults
     * to `<configDir>/worktrees` (see getDefaultWorktreeBaseDir). Ignored when
     * `targetDir` is given.
     */
    worktreeBaseDir?: string;
    /**
     * Remote to fetch+compare the base branch against before branching.
     * Default: 'origin'.
     */
    remote?: string;
    /**
     * When true (default) and `baseBranch` is given, fetch the base branch from
     * `remote` and, if the local base branch is strictly behind the remote
     * (no divergence), branch the worktree from the remote-tracking ref instead
     * of the stale local ref. The decision is always surfaced via `baseSync`.
     * Set false to preserve the legacy "branch from local ref, never fetch"
     * behavior.
     */
    syncBaseFromRemote?: boolean;
}

/**
 * How the worktree's start point was resolved relative to the remote base.
 * Surfaced so the coordinator can detect a stale base node before dispatching
 * work onto a worktree built on a behind/diverged base.
 */
export interface WorktreeBaseSync {
    /** The base branch name requested (e.g. 'main'). */
    branch: string;
    /** The remote compared against (e.g. 'origin'). */
    remote: string;
    /** The actual ref/commit-ish used as the worktree branch start point. */
    startRef: string;
    /** Whether `git fetch <remote> <branch>` succeeded. */
    fetched: boolean;
    /** Local base-branch SHA before clone, if the local ref exists. */
    localSha?: string;
    /** Remote-tracking base-branch SHA after fetch, if it exists. */
    remoteSha?: string;
    /** Commits the local base ref is behind the remote (0 when up-to-date/ahead). */
    behindBy: number;
    /** Commits the local base ref is ahead of the remote. */
    aheadBy: number;
    /** What was done with the base ref. */
    action:
        | 'up_to_date'
        | 'local_behind_used_remote'
        | 'local_ahead_used_local'
        | 'diverged_used_local'
        | 'no_remote_ref_used_local'
        | 'no_local_ref_used_remote';
    /** Human-readable warning when the base was stale/diverged. */
    warning?: string;
}

export interface WorktreeCreateResult {
    success: true;
    worktreePath: string;
    branch: string;
    /** Present when `baseBranch` was given and base sync resolution ran. */
    baseSync?: WorktreeBaseSync;
}

export interface WorktreeEntry {
    path: string;
    head: string;
    branch: string | null;
    bare: boolean;
}

export interface WorktreeRemoveOptions {
    /** Refuse to remove a worktree with uncommitted or untracked changes. */
    requireClean?: boolean;
    /**
     * If normal removal fails with Git's submodule-worktree guard, retry with
     * `git worktree remove --force`. Callers must perform their own
     * higher-level managed-path/convergence checks before enabling this.
     */
    allowSubmoduleForceFallback?: boolean;
}

export interface WorktreeRemoveResult {
    success: true;
    removedPath: string;
    fallback?: 'git_worktree_remove_force_submodule';
    forced?: boolean;
    reason?: 'working_trees_containing_submodules';
}

// ─── Path Resolution ────────────────────────────

/**
 * Normalize a caller-supplied worktree base override, falling back to the
 * home-directory default when it is missing/blank. Exported so the cleanup
 * guard resolves the exact same base as creation did.
 */
export function resolveWorktreeBaseDir(worktreeBaseDir?: string): string {
    const override = typeof worktreeBaseDir === 'string' ? worktreeBaseDir.trim() : '';
    return override || getDefaultWorktreeBaseDir();
}

/**
 * Resolve the target directory for a new worktree.
 * Places worktrees at: <worktreeBaseDir>/<meshName>/<branch>/, where
 * `worktreeBaseDir` defaults to `<configDir>/worktrees` (getDefaultWorktreeBaseDir).
 * The mesh-name namespacing keeps multi-repo / multi-branch clones from colliding.
 */
export function resolveWorktreePath(repoRoot: string, meshName: string, branch: string, worktreeBaseDir?: string): string {
    // Sanitize branch name for filesystem (e.g. feat/auth → feat-auth)
    const safeBranch = branch.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '');
    const safeMeshName = meshName.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '');
    const baseDir = resolveWorktreeBaseDir(worktreeBaseDir);
    return path.join(baseDir, safeMeshName, safeBranch);
}

// ─── Base sync (anti-stale-base) ─────────────────

/** Run a git command, returning ok/stdout/stderr instead of throwing. */
async function tryGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execFileAsync('git', args, {
            cwd,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            windowsHide: true,
        });
        return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
    } catch (error: any) {
        return {
            ok: false,
            stdout: typeof error?.stdout === 'string' ? error.stdout.trim() : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr.trim() : (error?.message || ''),
        };
    }
}

/**
 * Fetch the base branch from the remote and decide what to branch the new
 * worktree from. Without this, `git worktree add -b <branch> main` always uses
 * the local `refs/heads/main`, so a base node whose local main is behind a
 * cross-machine-pushed origin/main produces a worktree on a STALE base —
 * unaware of already-converged work, forcing a rebase before its push can
 * fast-forward.
 *
 * Resolution (no history rewrite, never mutates the checked-out local branch):
 *   - local strictly behind remote → branch from the remote-tracking ref.
 *   - local ahead / up-to-date / no remote ref → branch from the local ref.
 *   - diverged → branch from local + emit a warning for the coordinator.
 */
async function resolveWorktreeBaseStartPoint(
    repoRoot: string,
    baseBranch: string,
    remote: string,
): Promise<WorktreeBaseSync> {
    const fetchResult = await tryGit(repoRoot, ['fetch', remote, baseBranch]);
    const fetched = fetchResult.ok;

    const localRev = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`]);
    const remoteRev = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${baseBranch}`]);
    const localSha = localRev.ok && localRev.stdout ? localRev.stdout : undefined;
    const remoteSha = remoteRev.ok && remoteRev.stdout ? remoteRev.stdout : undefined;
    const remoteRef = `${remote}/${baseBranch}`;

    const base: WorktreeBaseSync = {
        branch: baseBranch,
        remote,
        startRef: baseBranch,
        fetched,
        localSha,
        remoteSha,
        behindBy: 0,
        aheadBy: 0,
        action: 'up_to_date',
    };

    const fetchWarn = fetched ? '' : ` (warning: git fetch ${remote} ${baseBranch} failed: ${fetchResult.stderr || 'unknown error'})`;

    // No remote-tracking ref → nothing to compare; keep legacy local behavior.
    if (!remoteSha) {
        return {
            ...base,
            action: 'no_remote_ref_used_local',
            ...(fetched ? {} : { warning: `Could not fetch ${remoteRef}${fetchWarn}; worktree branched from local ${baseBranch}.` }),
        };
    }

    // Base branch only exists on the remote → branch from the remote ref.
    if (!localSha) {
        return {
            ...base,
            startRef: remoteRef,
            action: 'no_local_ref_used_remote',
        };
    }

    if (localSha === remoteSha) {
        return base; // up_to_date
    }

    const localIsAncestor = (await tryGit(repoRoot, ['merge-base', '--is-ancestor', localSha, remoteSha])).ok;
    const remoteIsAncestor = (await tryGit(repoRoot, ['merge-base', '--is-ancestor', remoteSha, localSha])).ok;
    const behindBy = Number((await tryGit(repoRoot, ['rev-list', '--count', `${localSha}..${remoteSha}`])).stdout) || 0;
    const aheadBy = Number((await tryGit(repoRoot, ['rev-list', '--count', `${remoteSha}..${localSha}`])).stdout) || 0;

    if (localIsAncestor && !remoteIsAncestor) {
        // Local strictly behind — THE stale-base fix: branch from the remote tip.
        return {
            ...base,
            startRef: remoteRef,
            behindBy,
            aheadBy,
            action: 'local_behind_used_remote',
            warning: `Base node local ${baseBranch} was behind ${remoteRef} by ${behindBy} commit(s); worktree branched from ${remoteRef} (${remoteSha.slice(0, 8)}) instead of stale local ${localSha.slice(0, 8)}.${fetchWarn}`,
        };
    }

    if (remoteIsAncestor) {
        // Local ahead of remote (or remote is an ancestor) — local has the newer work.
        return { ...base, behindBy, aheadBy, action: 'local_ahead_used_local' };
    }

    // Diverged: neither is an ancestor of the other. Don't silently pick a side —
    // keep local (preserve local-only commits) and warn so the coordinator rebases.
    return {
        ...base,
        behindBy,
        aheadBy,
        action: 'diverged_used_local',
        warning: `Base node local ${baseBranch} (${localSha.slice(0, 8)}) has DIVERGED from ${remoteRef} (${remoteSha.slice(0, 8)}): behind ${behindBy}, ahead ${aheadBy}. Worktree branched from local; a rebase onto ${remoteRef} will be required before its push can fast-forward.${fetchWarn}`,
    };
}

// ─── Create ─────────────────────────────────────

/**
 * Create a new git worktree with a fresh branch.
 *
 * Runs: git worktree add <targetDir> -b <branch> [startRef]
 *
 * When `baseBranch` is given and `syncBaseFromRemote` is not disabled, the
 * start point is resolved against the remote first (see
 * resolveWorktreeBaseStartPoint) so a stale local base does not produce a stale
 * worktree. The resolution is returned as `baseSync`.
 */
export async function createWorktree(opts: WorktreeCreateOptions): Promise<WorktreeCreateResult> {
    const { repoRoot, branch, baseBranch, meshName } = opts;
    const remote = (opts.remote || 'origin').trim() || 'origin';
    const targetDir = opts.targetDir || resolveWorktreePath(repoRoot, meshName, branch, opts.worktreeBaseDir);

    if (existsSync(targetDir)) {
        throw new Error(`Worktree target directory already exists: ${targetDir}`);
    }

    // Ensure parent directory exists
    await mkdir(path.dirname(targetDir), { recursive: true });

    let baseSync: WorktreeBaseSync | undefined;
    let startRef = baseBranch;
    if (baseBranch && opts.syncBaseFromRemote !== false) {
        baseSync = await resolveWorktreeBaseStartPoint(repoRoot, baseBranch, remote);
        startRef = baseSync.startRef;
    }

    const args = ['worktree', 'add', targetDir, '-b', branch];
    if (startRef) {
        args.push(startRef);
    }

    try {
        await execFileAsync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            windowsHide: true,
        });
    } catch (error: any) {
        const stderr = typeof error.stderr === 'string' ? error.stderr : '';
        if (/already exists/i.test(stderr)) {
            // Distinguish directory-collision (TOCTOU race) from branch-already-exists
            if (existsSync(targetDir)) {
                throw new Error(`Worktree target directory was created concurrently: ${targetDir}`);
            }
            throw new Error(`Branch '${branch}' already exists or is checked out in another worktree`);
        }
        throw new Error(`git worktree add failed: ${stderr.trim() || error.message}`);
    }

    return {
        success: true,
        worktreePath: targetDir,
        branch,
        ...(baseSync ? { baseSync } : {}),
    };
}

// ─── Remove ─────────────────────────────────────

/**
 * Remove a git worktree and clean up the directory.
 *
 * Runs: git worktree remove <worktreePath>
 */
export async function removeWorktree(repoRoot: string, worktreePath: string, opts: WorktreeRemoveOptions = {}): Promise<WorktreeRemoveResult> {
    if (!existsSync(worktreePath)) {
        // Already gone — just prune
        await pruneWorktrees(repoRoot);
        return { success: true, removedPath: worktreePath };
    }

    if (opts.requireClean) {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
            cwd: worktreePath,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            windowsHide: true,
        });
        if (stdout.trim()) {
            throw new Error(`Refusing to remove dirty worktree: ${worktreePath}`);
        }
    }

    try {
        await execFileAsync('git', ['worktree', 'remove', worktreePath], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            windowsHide: true,
        });
    } catch (error: any) {
        const stderr = typeof error.stderr === 'string' ? error.stderr : '';
        const stdout = typeof error.stdout === 'string' ? error.stdout : '';
        const detail = `${stderr}\n${stdout}\n${error.message || ''}`;
        if (opts.allowSubmoduleForceFallback && SUBMODULE_WORKTREE_REMOVE_RE.test(detail)) {
            process.stderr.write(
                `[adhdev-mesh] WARNING: git worktree remove --force fallback for submodule worktree '${worktreePath}'. `
                + `Any uncommitted changes inside submodules will be lost.\n`,
            );
            try {
                await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
                    cwd: repoRoot,
                    encoding: 'utf8',
                    timeout: GIT_TIMEOUT_MS,
                    maxBuffer: GIT_MAX_BUFFER,
                    windowsHide: true,
                });
            } catch (forceError: any) {
                const forceStderr = typeof forceError.stderr === 'string' ? forceError.stderr : '';
                const forceStdout = typeof forceError.stdout === 'string' ? forceError.stdout : '';
                throw new Error(`git worktree remove --force fallback failed: ${forceStderr.trim() || forceStdout.trim() || forceError.message}`);
            }
            return {
                success: true,
                removedPath: worktreePath,
                fallback: 'git_worktree_remove_force_submodule',
                forced: true,
                reason: 'working_trees_containing_submodules',
            };
        }
        throw new Error(`git worktree remove failed: ${stderr.trim() || stdout.trim() || error.message}`);
    }

    return { success: true, removedPath: worktreePath };
}

// ─── List ───────────────────────────────────────

/**
 * List all worktrees for a repository.
 *
 * Runs: git worktree list --porcelain
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
    });

    return parseWorktreeListOutput(stdout);
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 */
export function parseWorktreeListOutput(output: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    const blocks = output.trim().split(/\n\n+/);

    for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.trim().split('\n');
        const entry: WorktreeEntry = { path: '', head: '', branch: null, bare: false };

        for (const line of lines) {
            if (line.startsWith('worktree ')) {
                entry.path = line.slice('worktree '.length).trim();
            } else if (line.startsWith('HEAD ')) {
                entry.head = line.slice('HEAD '.length).trim();
            } else if (line.startsWith('branch ')) {
                const ref = line.slice('branch '.length).trim();
                // refs/heads/feat/auth → feat/auth
                entry.branch = ref.replace(/^refs\/heads\//, '');
            } else if (line === 'bare') {
                entry.bare = true;
            }
        }

        if (entry.path) {
            entries.push(entry);
        }
    }

    return entries;
}

// ─── Branch ref deletion ────────────────────────

export interface BranchRefDeleteResult {
    /** True if the branch ref no longer exists after this call. */
    deleted: boolean;
    /** Why it was (not) deleted, for surfacing in the cleanup result. */
    reason: string;
    /** True when a forced delete (`-D`) was needed (e.g. squash/patch-equivalent merge). */
    forced?: boolean;
}

/**
 * Delete a local branch ref after its worktree was removed.
 *
 * SAFETY: this is only meant to be called once the caller has independently
 * verified that the branch is fully merged / its content is contained in the
 * default ref (no work loss). It first tries the safe `git branch -d`, which
 * refuses to delete a branch git itself does not consider merged. If
 * `safeDeleteOnly` is false (the caller proved containment by patch-equivalence,
 * which `-d` cannot see), it falls back to `git branch -D`. When the branch is
 * already gone, this reports `deleted: true` idempotently.
 */
export async function deleteBranchRef(
    repoRoot: string,
    branch: string,
    opts: { safeDeleteOnly?: boolean } = {},
): Promise<BranchRefDeleteResult> {
    const name = (branch || '').trim();
    if (!name) return { deleted: false, reason: 'empty_branch_name' };

    // Idempotent: nothing to delete if the ref does not exist.
    try {
        await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
            cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
        });
    } catch {
        return { deleted: true, reason: 'branch_ref_absent' };
    }

    // Try the safe delete first — git refuses if it cannot see the branch as merged.
    try {
        await execFileAsync('git', ['branch', '-d', name], {
            cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
        });
        return { deleted: true, reason: 'safe_deleted_merged_branch' };
    } catch (error: any) {
        const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
        const notMerged = /not fully merged/i.test(stderr) || /not fully merged/i.test(String(error?.message || ''));
        if (!notMerged) {
            return { deleted: false, reason: `branch_delete_failed: ${stderr.trim() || error?.message || 'unknown error'}` };
        }
        // git -d refused. Only force when the caller proved containment another way
        // (e.g. squash/cherry-pick/patch-equivalent merge that -d cannot detect).
        if (opts.safeDeleteOnly) {
            return { deleted: false, reason: 'branch_not_merged_per_git_safe_delete_only' };
        }
        try {
            await execFileAsync('git', ['branch', '-D', name], {
                cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
            });
            return { deleted: true, reason: 'force_deleted_patch_equivalent_branch', forced: true };
        } catch (forceError: any) {
            const fErr = typeof forceError?.stderr === 'string' ? forceError.stderr : forceError?.message;
            return { deleted: false, reason: `branch_force_delete_failed: ${String(fErr || 'unknown error').trim()}` };
        }
    }
}

// ─── Prune ──────────────────────────────────────

async function pruneWorktrees(repoRoot: string): Promise<void> {
    try {
        await execFileAsync('git', ['worktree', 'prune'], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
        });
    } catch {
        // Prune is best-effort
    }
}
