/**
 * Git Worktree — Create/remove/list worktrees for Repo Mesh node cloning
 *
 * Used by the `clone_mesh_node` daemon command to create isolated
 * worktree-based nodes for parallel branch work within a mesh.
 *
 * Worktrees are placed outside the source repo to avoid .gitignore
 * pollution and submodule conflicts:
 *   <repoParent>/.adhdev-worktrees/<meshName>/<branch>/
 */

import * as path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WORKTREE_DIR_NAME = '.adhdev-worktrees';
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
}

export interface WorktreeCreateResult {
    success: true;
    worktreePath: string;
    branch: string;
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
 * Resolve the target directory for a new worktree.
 * Places worktrees at: <repoParent>/.adhdev-worktrees/<meshName>/<branch>/
 */
export function resolveWorktreePath(repoRoot: string, meshName: string, branch: string): string {
    // Sanitize branch name for filesystem (e.g. feat/auth → feat-auth)
    const safeBranch = branch.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '');
    const safeMeshName = meshName.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '');
    const parentDir = path.dirname(repoRoot);
    return path.join(parentDir, WORKTREE_DIR_NAME, safeMeshName, safeBranch);
}

// ─── Create ─────────────────────────────────────

/**
 * Create a new git worktree with a fresh branch.
 *
 * Runs: git worktree add <targetDir> -b <branch> [baseBranch]
 */
export async function createWorktree(opts: WorktreeCreateOptions): Promise<WorktreeCreateResult> {
    const { repoRoot, branch, baseBranch, meshName } = opts;
    const targetDir = opts.targetDir || resolveWorktreePath(repoRoot, meshName, branch);

    if (existsSync(targetDir)) {
        throw new Error(`Worktree target directory already exists: ${targetDir}`);
    }

    // Ensure parent directory exists
    await mkdir(path.dirname(targetDir), { recursive: true });

    const args = ['worktree', 'add', targetDir, '-b', branch];
    if (baseBranch) {
        args.push(baseBranch);
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
