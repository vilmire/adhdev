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
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

const WORKTREE_DIR_NAME = 'worktrees';
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
    const adhdevDir = path.join(os.homedir(), '.adhdev');
    return path.join(adhdevDir, WORKTREE_DIR_NAME, safeMeshName, safeBranch);
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
        // Clean error messages for common failures
        if (/already exists/i.test(stderr)) {
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
