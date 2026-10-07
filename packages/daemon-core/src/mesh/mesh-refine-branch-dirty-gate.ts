/**
 * Refinery pre-gate `branch_worktree_dirty` (docs/design/2026-10-07-mesh-workspace-policy.md B2).
 *
 * Refine MERGES the branch's commits, but VALIDATES the branch worktree's working
 * tree. With uncommitted work in that tree the two differ: validation can pass on a
 * file that never reaches main (a new untracked file imported by committed code),
 * and the post-merge `remove_mesh_node { force: true }` cleanup then deletes the
 * uncommitted work. This gate closes that one remaining loss path by refusing to
 * validate a branch worktree that is not committed — so the validated tree IS the
 * merged tree, and whatever dirt the forced cleanup removes was created after
 * validation (e.g. a bootstrap lockfile rewrite).
 *
 * Scope: `git status --porcelain` of the branch worktree — untracked files INCLUDED
 * (unlike the base preflight, where untracked files do not block a merge, a branch's
 * untracked file is work that would be left out of it), gitignored files excluded (git
 * never lists them), and submodule-gitlink pointer moves excluded (the normal
 * aftermath of committing inside a submodule — worktree-bootstrap-config.ts).
 *
 * The daemon never commits on the worker's behalf (owner decision E1): the gate only
 * blocks and names the files; the coordinator gets the commit made (a delta to the
 * worker session, or an explicit `mesh_checkpoint` of the worktree node).
 *
 * Fails OPEN on an uninspectable tree (no workspace, git error): an indeterminate
 * verdict never becomes a new way for refine to be unavailable.
 */
import { existsSync } from 'fs';
import { getRegisteredSubmodulePaths, listPorcelainChangesIgnoringSubmoduleGitlinks } from './worktree-bootstrap-config.js';
import type { RefineExecFileAsync } from './mesh-refine-gates.js';

export const BRANCH_WORKTREE_DIRTY_CODE = 'branch_worktree_dirty';
const MAX_REPORTED_FILES = 20;

export type BranchWorktreeDirtVerdict =
    | { kind: 'clean' }
    | { kind: 'dirty'; files: string[]; fileCount: number }
    | { kind: 'indeterminate'; reason: string };

/** Probe the branch worktree for uncommitted work (see module doc for scope). */
export async function probeBranchWorktreeDirt(
    execFileAsync: RefineExecFileAsync,
    workspace: string,
    opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<BranchWorktreeDirtVerdict> {
    if (!workspace || !existsSync(workspace)) return { kind: 'indeterminate', reason: 'workspace_missing' };
    let porcelain: string;
    try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
            cwd: workspace,
            encoding: 'utf8',
            windowsHide: true,
            ...(opts.env ? { env: opts.env } : {}),
            ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        });
        porcelain = String(stdout || '');
    } catch (e: any) {
        return { kind: 'indeterminate', reason: `git_status_failed: ${e?.message || String(e)}` };
    }
    if (!porcelain.trim()) return { kind: 'clean' };
    // Gitlinks = the .gitmodules-registered submodules PLUS every index entry of mode
    // 160000 (a gitlink committed without .gitmodules, or whose checkout is absent).
    const gitlinks = getRegisteredSubmodulePaths(workspace);
    for (const path of await listIndexGitlinkPaths(execFileAsync, workspace, opts)) gitlinks.add(path);
    const changes = listPorcelainChangesIgnoringSubmoduleGitlinks(porcelain, gitlinks)
        // A gitlink whose checkout directory is missing (" D <path>") is not
        // uncommitted work either — the commit it points at is what merges.
        .filter(line => !(line.slice(0, 2) === ' D' && gitlinks.has(normalizePorcelainPath(line))));
    if (changes.length === 0) return { kind: 'clean' };
    return {
        kind: 'dirty',
        files: changes.slice(0, MAX_REPORTED_FILES).map(line => line.slice(3).trim()),
        fileCount: changes.length,
    };
}

function normalizePorcelainPath(line: string): string {
    return line.slice(3).trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Index entries of mode 160000 (gitlinks); empty on any git error (conservative: no exemption). */
async function listIndexGitlinkPaths(
    execFileAsync: RefineExecFileAsync,
    workspace: string,
    opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('git', ['ls-files', '--stage'], {
            cwd: workspace,
            encoding: 'utf8',
            windowsHide: true,
            ...(opts.env ? { env: opts.env } : {}),
            ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        });
        const paths: string[] = [];
        for (const line of String(stdout || '').split(/\r?\n/)) {
            // `<mode> <object> <stage>\t<path>`
            if (!line.startsWith('160000 ')) continue;
            const tab = line.indexOf('\t');
            if (tab > 0) paths.push(line.slice(tab + 1).trim().replace(/\\/g, '/').replace(/\/+$/, ''));
        }
        return paths;
    } catch {
        return [];
    }
}

/** The terminal refine result for a dirty branch worktree (convergence: blocked_review). */
export function buildBranchWorktreeDirtyRefusal(params: {
    meshId: string;
    nodeId: string;
    workspace: string;
    branch: string;
    files: string[];
    fileCount: number;
}): { success: false; [key: string]: unknown } {
    const { meshId, nodeId, workspace, branch, files, fileCount } = params;
    const shown = files.join(', ') + (fileCount > files.length ? `, … (+${fileCount - files.length} more)` : '');
    return {
        success: false,
        code: BRANCH_WORKTREE_DIRTY_CODE,
        error: `Branch worktree for '${branch}' has ${fileCount} uncommitted change(s) (${shown}). `
            + 'Refine merges only commits but validates the working tree, so these would pass validation and then be left out of the merge '
            + '(and deleted by the post-merge worktree cleanup). Nothing was validated or merged.',
        branchWorktreeDirty: { workspace, branch, files, fileCount },
        meshId,
        nodeId,
        targetNodeId: nodeId,
        convergenceStatus: 'blocked_review',
        retryable: true,
        nextStep: `Get the changes committed on '${branch}' — send the worker session a delta to commit them (or discard what should not ship), `
            + `or checkpoint the worktree node with mesh_checkpoint — then re-run mesh_refine_node.`,
    };
}
