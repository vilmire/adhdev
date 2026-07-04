/**
 * Worktree / mesh-session cleanup — extracted from router.ts (behavior-preserving code move).
 *
 * These functions were `DaemonCommandRouter` methods; they now take the router
 * instance as `self`. The class keeps thin delegating wrappers (cleanupMeshSessions /
 * cleanupLocalWorktreeNode / precheckLocalWorktreeRemovable are bound into
 * MedFamilyContext; bestEffortRemoveWorktreeDir is overridden on the instance by a
 * unit test — intra-cluster calls therefore go through `self.` so instance dispatch
 * (and that test override) is preserved). No log string, error message, refusal
 * condition, or result shape changed — only physical location + `this.` → `self.`.
 */
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import { resolve as pathResolve } from 'path';
import type { DaemonCommandRouter } from './router.js';
import { LOG } from '../logging/logger.js';
import { meshNodeIdMatches, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { readStringValue, readObjectRecord, readBooleanValue } from '../mesh/mesh-node-identity.js';
import { checkWorktreeChangesPatchEquivalentInRef, MeshWorktreePatchContainmentSummary } from '../mesh/mesh-refine-gates.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import type { RepoMeshSessionCleanupMode } from '../repo-mesh-types.js';
import { DEFAULT_MESH_POLICY, magiAutoLaunchedSessionCleanupDecision } from '../repo-mesh-types.js';

export function sessionMatchesMeshNode(self: DaemonCommandRouter, record: any, node: any, nodeId: string, sessionIds?: Set<string>): boolean {
        const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
        if (!sessionId) return false;
        if (sessionIds?.size) return sessionIds.has(sessionId);
        const workspace = typeof node?.workspace === 'string' ? node.workspace : '';
        if (workspace && record?.workspace === workspace) return true;
        if (record?.meta?.meshNodeId === nodeId) return true;
        return false;
    }

    /**
     * Best-effort recursive removal of a managed worktree directory.
     *
     * The git-registry de-registration is the safety-critical step of worktree
     * teardown; a leftover directory must never gate dropping the node from the
     * mesh. On Windows, `fs.rmSync` can throw EINVAL/EPERM/EBUSY on submodule
     * gitlink (`.git`) files, long paths, junctions, or while a just-stopped
     * delegate session is still releasing a handle/cwd on the directory. This
     * helper absorbs those errors (never throws), with bounded retries + backoff
     * to give handles time to release, and reports whether residue remains.
     */
export async function bestEffortRemoveWorktreeDir(self: DaemonCommandRouter, dir: string): Promise<{ removed: boolean; residue: boolean; error?: string }> {
        if (!dir || !fs.existsSync(dir)) return { removed: true, residue: false };
        const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
        // EINVAL is the Windows symptom for submodule gitlink residue; the rest are
        // transient lock/permission classes. None should escape as a throw here.
        const ABSORB = new Set(['EINVAL', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE']);
        let lastErr: any;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                // maxRetries/retryDelay give fs.rmSync its own internal backoff for
                // EBUSY/EPERM/ENOTEMPTY; the outer loop extends tolerance to EINVAL.
                fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                if (!fs.existsSync(dir)) return { removed: true, residue: false };
                lastErr = new Error('directory still present after rmSync');
            } catch (e: any) {
                lastErr = e;
                const code = typeof e?.code === 'string' ? e.code : '';
                if (code && !ABSORB.has(code)) {
                    // Unexpected error class — stay best-effort (no throw) but stop retrying.
                    break;
                }
            }
            await sleep(150 * (attempt + 1));
        }
        return fs.existsSync(dir)
            ? { removed: false, residue: true, error: String(lastErr?.message || lastErr || 'unknown rm error') }
            : { removed: true, residue: false };
    }

    /**
     * Non-destructive precheck mirroring every REFUSAL condition in
     * {@link cleanupLocalWorktreeNode} — missing workspace / source-repo / branch
     * metadata, unexpected (non-managed) path, branch mismatch — PLUS the
     * dirty-worktree guard that `removeWorktree(requireClean)` enforces
     * (`git status --porcelain`). It performs ZERO destructive actions: no
     * `git worktree remove`, no `git worktree prune`, no directory deletion.
     *
     * remove_mesh_node calls this BEFORE any session cleanup so that a refusal
     * (the common one being a dirty worktree) does not first stop/delete the
     * delegated session and orphan it — the original ordering bug. Success/skip
     * cases that the real cleanup handles idempotently (worktree path already
     * gone, git-de-registered residue) are NOT refusals and return `{ ok: true }`.
     *
     * `force:true` skips the dirty guard, preserving `removeWorktree`'s
     * `requireClean: !force` semantics. This is a read-only superset check; the
     * authoritative `requireClean` guard inside `removeWorktree` is intentionally
     * kept as a second line of defense against a precheck→execute race.
     */
export async function precheckLocalWorktreeRemovable(self: DaemonCommandRouter, args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ ok: true } | { ok: false; code: string; error: string; recoveryHint: string }> {
        const sessionPreservedNote = ' The delegated session was left running (not stopped) — resolve the issue and retry mesh_remove_node.';
        const workspace = typeof args.node?.workspace === 'string' ? args.node.workspace.trim() : '';
        if (!workspace) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_missing_workspace',
                error: `Worktree node '${args.nodeId}' is missing workspace metadata`,
                recoveryHint: 'Inspect the mesh node record before removing it, or remove stale metadata manually only after confirming no managed worktree remains.' + sessionPreservedNote,
            };
        }

        // Worktree path already gone → not a refusal; the real cleanup returns a
        // skipped:true success and the node is dropped from the registry.
        if (!fs.existsSync(workspace)) return { ok: true };

        const sourceNode = args.node?.clonedFromNodeId
            ? args.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, args.node.clonedFromNodeId))
            : args.mesh?.nodes?.find((n: any) => !n.isLocalWorktree);
        const repoRoot = typeof sourceNode?.repoRoot === 'string' && sourceNode.repoRoot.trim()
            ? sourceNode.repoRoot.trim()
            : typeof sourceNode?.workspace === 'string' && sourceNode.workspace.trim()
                ? sourceNode.workspace.trim()
                : '';
        if (!repoRoot || !fs.existsSync(repoRoot)) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_missing_source_repo',
                error: `Refusing to remove worktree '${workspace}' because the source repo root is unavailable`,
                recoveryHint: 'Run mesh_remove_node from the machine that owns the source repo, or verify the source node metadata before retrying.' + sessionPreservedNote,
            };
        }
        if (typeof args.node?.worktreeBranch !== 'string' || !args.node.worktreeBranch.trim()) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_missing_branch',
                error: `Refusing to remove worktree '${workspace}' because worktreeBranch metadata is missing`,
                recoveryHint: 'Confirm this is an ADHDev-managed worktree before removing it manually; managed worktree nodes include worktreeBranch metadata.' + sessionPreservedNote,
            };
        }

        const { resolveWorktreePath, listWorktrees } = await import('../git/git-worktree.js');
        const normalizePath = (value: string) => {
            const resolved = pathResolve(value);
            try { return fs.realpathSync(resolved); } catch { return resolved; }
        };
        const expectedPath = normalizePath(resolveWorktreePath(repoRoot, String(args.mesh?.name || args.mesh?.id || 'mesh'), args.node.worktreeBranch));
        const actualPath = normalizePath(workspace);
        if (actualPath !== expectedPath) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_unexpected_path',
                error: `Refusing to remove worktree '${workspace}' because it is not at the expected managed path '${expectedPath}'`,
                recoveryHint: 'Use git worktree list/status to inspect the path. Retry only after confirming the mesh node metadata points to an ADHDev-managed worktree.' + sessionPreservedNote,
            };
        }

        const entries = await listWorktrees(repoRoot);
        const managedEntry = entries.find(entry => normalizePath(entry.path) === actualPath);
        // De-registered residue (git no longer lists it as a worktree) is an
        // idempotent recovery path in the real cleanup, NOT a refusal — neither the
        // branch-mismatch nor the dirty check applies, so let the removal proceed.
        if (!managedEntry) return { ok: true };

        if (managedEntry.branch && managedEntry.branch !== args.node.worktreeBranch) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_branch_mismatch',
                error: `Refusing to remove '${workspace}' because git reports branch '${managedEntry.branch}', expected '${args.node.worktreeBranch}'`,
                recoveryHint: 'Inspect the worktree branch and mesh metadata before retrying cleanup.' + sessionPreservedNote,
            };
        }

        // Dirty-worktree guard — a read-only mirror of removeWorktree(requireClean)
        // (`git status --porcelain` run inside the worktree). `force:true` skips it,
        // preserving the requireClean:!force semantics.
        if (args.force !== true) {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            try {
                const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
                    cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
                });
                if (stdout.trim()) {
                    return {
                        ok: false,
                        code: 'mesh_worktree_cleanup_dirty',
                        error: `Refusing to remove dirty worktree: ${workspace}`,
                        recoveryHint: 'Commit, stash, or intentionally discard the worktree changes before retrying mesh_remove_node. The mesh registry entry is preserved until cleanup is safe.' + sessionPreservedNote,
                    };
                }
            } catch {
                // A status probe failure is not itself proof of dirtiness; defer to
                // the authoritative removeWorktree(requireClean) guard rather than
                // refusing here (which would block an otherwise-clean removal).
                return { ok: true };
            }
        }

        return { ok: true };
    }

export async function cleanupLocalWorktreeNode(self: DaemonCommandRouter, args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown>; recovered?: boolean; residue?: boolean; residueWarning?: string; residueError?: string; branchRefDeleted?: boolean; branchRefReason?: string; branchRefForced?: boolean; branchRefWarning?: string } | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> }> {
        const workspace = typeof args.node?.workspace === 'string' ? args.node.workspace.trim() : '';
        if (!workspace) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_workspace',
                error: `Worktree node '${args.nodeId}' is missing workspace metadata`,
                recoveryHint: 'Inspect the mesh node record before removing it, or remove stale metadata manually only after confirming no managed worktree remains.',
            };
        }

        const worktreeExists = fs.existsSync(workspace);
        const sourceNode = args.node?.clonedFromNodeId
            ? args.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, args.node.clonedFromNodeId))
            : args.mesh?.nodes?.find((n: any) => !n.isLocalWorktree);
        const repoRoot = typeof sourceNode?.repoRoot === 'string' && sourceNode.repoRoot.trim()
            ? sourceNode.repoRoot.trim()
            : typeof sourceNode?.workspace === 'string' && sourceNode.workspace.trim()
                ? sourceNode.workspace.trim()
                : '';

        if (!worktreeExists) {
            return { success: true, skipped: true, removedPath: workspace, repoRoot: repoRoot || undefined, reason: 'worktree_path_missing' };
        }
        if (!repoRoot || !fs.existsSync(repoRoot)) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_source_repo',
                error: `Refusing to remove worktree '${workspace}' because the source repo root is unavailable`,
                recoveryHint: 'Run mesh_remove_node from the machine that owns the source repo, or verify the source node metadata before retrying.',
            };
        }
        if (typeof args.node?.worktreeBranch !== 'string' || !args.node.worktreeBranch.trim()) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_branch',
                error: `Refusing to remove worktree '${workspace}' because worktreeBranch metadata is missing`,
                recoveryHint: 'Confirm this is an ADHDev-managed worktree before removing it manually; managed worktree nodes include worktreeBranch metadata.',
            };
        }

        const { resolveWorktreePath, listWorktrees, removeWorktree } = await import('../git/git-worktree.js');
        const normalizePath = (value: string) => {
            const resolved = pathResolve(value);
            try { return fs.realpathSync(resolved); } catch { return resolved; }
        };
        const expectedPath = normalizePath(resolveWorktreePath(repoRoot, String(args.mesh?.name || args.mesh?.id || 'mesh'), args.node.worktreeBranch));
        const actualPath = normalizePath(workspace);
        if (actualPath !== expectedPath) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_unexpected_path',
                error: `Refusing to remove worktree '${workspace}' because it is not at the expected managed path '${expectedPath}'`,
                recoveryHint: 'Use git worktree list/status to inspect the path. Retry only after confirming the mesh node metadata points to an ADHDev-managed worktree.',
            };
        }

        const entries = await listWorktrees(repoRoot);
        const managedEntry = entries.find(entry => normalizePath(entry.path) === actualPath);
        if (!managedEntry) {
            // Idempotent residue recovery (NOT a refusal). By this point the path is
            // already proven ADHDev-managed: worktreeBranch metadata is present and
            // actualPath === expectedPath. Git nonetheless no longer lists it as a
            // worktree. This is the post-force-fallback re-entry state — an earlier
            // removal de-registered the worktree from git but left the directory
            // behind (commonly Windows EINVAL on submodule gitlink files). Refusing
            // here would strand the node in mesh membership forever, so prune any
            // stale registration, best-effort remove the leftover directory, and
            // report success so the caller drops the node from the mesh registry.
            try {
                const { execFile } = await import('node:child_process');
                const { promisify } = await import('node:util');
                const execFileAsync = promisify(execFile);
                await execFileAsync('git', ['worktree', 'prune'], {
                    cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
                });
            } catch { /* prune is best-effort */ }
            const rm = await self.bestEffortRemoveWorktreeDir(workspace);
            return {
                success: true,
                removedPath: workspace,
                repoRoot,
                reason: 'worktree_unregistered_residue_recovered',
                recovered: true,
                ...(rm.residue ? {
                    residue: true,
                    residueWarning: `Worktree was already de-registered from git but the directory could not be fully removed (leftover residue at '${workspace}'): ${rm.error || 'unknown error'}. The node will be dropped from the mesh; remove the directory manually if needed.`,
                    residueError: rm.error,
                } : {}),
            };
        }
        if (managedEntry.branch && managedEntry.branch !== args.node.worktreeBranch) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_branch_mismatch',
                error: `Refusing to remove '${workspace}' because git reports branch '${managedEntry.branch}', expected '${args.node.worktreeBranch}'`,
                recoveryHint: 'Inspect the worktree branch and mesh metadata before retrying cleanup.',
            };
        }

        // Always evaluate real merge convergence so we can decide whether the
        // branch ref is safe to delete after removal — even on the force path,
        // where `force_override` only authorizes the *worktree* removal and must
        // NOT be taken as proof the branch is merged (that would risk work loss).
        const mergeConvergence = await self.getWorktreeForceCleanupConvergence({ repoRoot, workspace, node: args.node });
        const forceFallbackConvergence = args.force
            ? { allow: true, status: 'force_override', source: 'caller_force_flag' }
            : mergeConvergence;

        // After the worktree is removed, delete the branch ref iff the branch is
        // fully merged into the default ref (no work loss). Otherwise preserve it
        // and surface a warning. `mergeConvergence` (NOT the force override) is the
        // authority on merged-ness.
        const deleteBranchIfMerged = async () => {
            const branch = String(args.node.worktreeBranch).trim();
            const status = mergeConvergence.allow ? (mergeConvergence.status || '') : '';
            const MERGED_STATUSES = new Set([
                'merged_to_main', 'merged_pushed', 'merged_to_default_ref', 'cleanup_candidate',
            ]);
            const PATCH_EQUIV_STATUS = 'patch_equivalent_to_default_ref';
            if (!branch) {
                return { branchRefDeleted: false, branchRefReason: 'empty_branch_name' };
            }
            if (!mergeConvergence.allow || (!MERGED_STATUSES.has(status) && status !== PATCH_EQUIV_STATUS)) {
                return {
                    branchRefDeleted: false,
                    branchRefReason: `branch_not_merged_preserved: ${mergeConvergence.error || mergeConvergence.status || 'convergence_unverified'}`,
                    branchRefWarning: `Branch ref '${branch}' was preserved (not deleted) because it is not confirmed merged into the default ref — no work was lost. Merge it (or pass a verified branchConvergence final state) and re-run cleanup, or delete it manually after confirming.`,
                };
            }
            const { deleteBranchRef } = await import('../git/git-worktree.js');
            // `-d` can detect a true fast-forward/merge; patch-equivalent landings
            // (squash/cherry-pick) are invisible to `-d`, so allow the verified `-D`
            // fallback only for the patch-equivalence status.
            const res = await deleteBranchRef(repoRoot, branch, { safeDeleteOnly: status !== PATCH_EQUIV_STATUS });
            return {
                branchRefDeleted: res.deleted,
                branchRefReason: res.reason,
                ...(res.forced ? { branchRefForced: true } : {}),
                ...(res.deleted ? {} : {
                    branchRefWarning: `Branch ref '${branch}' could not be deleted (${res.reason}); it was preserved so no work is lost.`,
                }),
            };
        };

        try {
            const result = await removeWorktree(repoRoot, workspace, {
                requireClean: !args.force,
                allowSubmoduleForceFallback: forceFallbackConvergence.allow,
            });
            const branchOutcome = await deleteBranchIfMerged();
            return {
                success: true,
                removedPath: result.removedPath,
                repoRoot,
                ...branchOutcome,
                ...(result.fallback ? {
                    fallback: result.fallback,
                    forced: result.forced,
                    reason: result.reason,
                    convergence: forceFallbackConvergence,
                } : {}),
            };
        } catch (e: any) {
            const message = String(e?.message || e || 'worktree cleanup failed');
            const dirty = message.includes('dirty worktree') || message.includes('local changes');
            const isSubmoduleGuard = /working trees containing submodules cannot be moved or removed/i.test(message);
            const submoduleForceBlocked = isSubmoduleGuard && !forceFallbackConvergence.allow;

            // Fallback 1: submodule guard on --force path — deinit submodules first, then retry remove
            if (isSubmoduleGuard && forceFallbackConvergence.allow) {
                const { execFile } = await import('node:child_process');
                const { promisify } = await import('node:util');
                const execFileAsync = promisify(execFile);
                const GIT_TIMEOUT_CLEANUP = 30_000;
                const GIT_MAX_BUFFER_CLEANUP = 4 * 1024 * 1024;
                try {
                    await execFileAsync('git', ['-C', workspace, 'submodule', 'deinit', '--all', '-f'], {
                        encoding: 'utf8', timeout: GIT_TIMEOUT_CLEANUP, maxBuffer: GIT_MAX_BUFFER_CLEANUP, windowsHide: true,
                    });
                    await execFileAsync('git', ['worktree', 'remove', '--force', workspace], {
                        cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_CLEANUP, maxBuffer: GIT_MAX_BUFFER_CLEANUP, windowsHide: true,
                    });
                    const branchOutcome = await deleteBranchIfMerged();
                    return {
                        success: true,
                        removedPath: workspace,
                        repoRoot,
                        ...branchOutcome,
                        fallback: 'git_worktree_remove_submodule_deinit' as const,
                        forced: true,
                        reason: 'working_trees_containing_submodules' as const,
                        convergence: forceFallbackConvergence,
                    };
                } catch (deinitError: any) {
                    // Fallback 2: deinit+remove still failed — best-effort directory
                    // removal + prune. The path is already proven managed/converged
                    // here, and a leftover directory must NOT gate dropping the node
                    // from the mesh, so absorb Windows EINVAL/EPERM and report success
                    // with a residue warning instead of failing the whole removal.
                    const rm = await self.bestEffortRemoveWorktreeDir(workspace);
                    try {
                        await execFileAsync('git', ['worktree', 'prune'], {
                            cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_CLEANUP, maxBuffer: GIT_MAX_BUFFER_CLEANUP, windowsHide: true,
                        });
                    } catch { /* prune is best-effort */ }
                    const branchOutcome = await deleteBranchIfMerged();
                    return {
                        success: true,
                        removedPath: workspace,
                        repoRoot,
                        ...branchOutcome,
                        fallback: 'fs_rm_worktree_prune' as const,
                        forced: true,
                        reason: 'working_trees_containing_submodules' as const,
                        convergence: forceFallbackConvergence,
                        ...(rm.residue ? {
                            residue: true,
                            residueWarning: `Worktree was de-registered from git but the directory could not be fully removed (leftover residue at '${workspace}'): ${rm.error || 'unknown error'}; deinit+remove first failed with: ${deinitError?.message || deinitError}. The node will be dropped from the mesh; remove the directory manually if needed.`,
                            residueError: rm.error,
                        } : {}),
                    };
                }
            }

            return {
                success: false,
                code: dirty
                    ? 'mesh_worktree_cleanup_dirty'
                    : submoduleForceBlocked
                        ? 'mesh_worktree_cleanup_force_fallback_blocked'
                        : 'mesh_worktree_cleanup_failed',
                error: submoduleForceBlocked
                    ? `${message}; refusing --force fallback because convergence could not be verified: ${forceFallbackConvergence.error || 'unknown convergence state'}`
                    : message,
                recoveryHint: dirty
                    ? 'Commit, stash, or intentionally discard the worktree changes before retrying mesh_remove_node. The mesh registry entry is preserved until cleanup is safe.'
                    : submoduleForceBlocked
                        ? 'Verify the worktree branch is merged/contained in the source default branch (for example origin/main) or mark the node with a safe branchConvergence final state, or pass force:true if content is confirmed already in main.'
                        : 'Inspect git worktree status/list from the source repo and retry after resolving the reported cleanup failure.',
                ...(submoduleForceBlocked ? { convergence: forceFallbackConvergence } : {}),
            };
        }
    }

export async function getWorktreeForceCleanupConvergence(self: DaemonCommandRouter, args: {
        repoRoot: string;
        workspace: string;
        node: any;
    }): Promise<{ allow: boolean; status?: string; source?: string; ref?: string; error?: string }> {
        const metadataStatus = typeof args.node?.branchConvergence?.status === 'string'
            ? args.node.branchConvergence.status
            : '';
        if (metadataStatus === 'merged_to_main' || metadataStatus === 'cleanup_candidate' || metadataStatus === 'merged_pushed') {
            return { allow: true, status: metadataStatus, source: 'node_branch_convergence' };
        }

        // Also allow when the node's last recorded refine job reached final convergence merged_pushed
        const refinedConvergence = typeof args.node?.refineState?.finalBranchConvergenceState?.status === 'string'
            ? args.node.refineState.finalBranchConvergenceState.status
            : typeof args.node?.lastRefineResult?.finalBranchConvergenceState?.status === 'string'
                ? args.node.lastRefineResult.finalBranchConvergenceState.status
                : '';
        if (refinedConvergence === 'merged_pushed' || refinedConvergence === 'merged_to_main') {
            return { allow: true, status: refinedConvergence, source: 'node_refine_state' };
        }

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const runGit = async (gitArgs: string[], cwd: string): Promise<string> => {
            const { stdout } = await execFileAsync('git', gitArgs, {
                cwd,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            });
            return String(stdout || '').trim();
        };

        let head = '';
        try {
            head = await runGit(['rev-parse', 'HEAD'], args.workspace);
        } catch (e: any) {
            return { allow: false, error: `could not resolve worktree HEAD: ${e?.message || e}` };
        }
        if (!head) return { allow: false, error: 'worktree HEAD is empty' };

        const candidateRefs: string[] = [];
        try {
            const defaultBranch = await runGit(['branch', '--show-current'], args.repoRoot);
            if (defaultBranch) {
                candidateRefs.push(defaultBranch, `origin/${defaultBranch}`);
            }
        } catch { /* fall through to common refs */ }
        candidateRefs.push('origin/main', 'origin/master', 'main', 'master');

        const seen = new Set<string>();
        const checkedRefs: string[] = [];
        const resolvedRefCommits: Array<{ ref: string; commit: string }> = [];
        for (const ref of candidateRefs) {
            if (!ref || seen.has(ref)) continue;
            seen.add(ref);
            let commit = '';
            try {
                commit = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], args.repoRoot);
            } catch {
                continue;
            }
            checkedRefs.push(ref);
            resolvedRefCommits.push({ ref, commit });
            try {
                await runGit(['merge-base', '--is-ancestor', head, commit], args.repoRoot);
                return { allow: true, status: 'merged_to_default_ref', source: 'git_merge_base', ref };
            } catch {
                // Not contained in this candidate ref; keep checking other safe refs.
            }
        }

        // SHA-reachability fallback: the worktree HEAD is not an ancestor of any
        // candidate ref, but its CONTENT may already be present via cherry-pick /
        // squash / rebase (a different commit SHA carrying the same patch). The
        // Refinery accepts such patch-equivalent landings; mirror that here so the
        // cleanup guard does not falsely block a converged worktree. This is the
        // heavier merge-tree/patch-id path, so it only runs after every ancestor
        // check has already failed. Any failure stays conservative (NOT contained).
        for (const { ref, commit } of resolvedRefCommits) {
            let containment: MeshWorktreePatchContainmentSummary;
            try {
                containment = await checkWorktreeChangesPatchEquivalentInRef(args.repoRoot, commit, head);
            } catch {
                // Defensive: the helper is already exception-safe, but never let a
                // thrown error escape into an allow.
                continue;
            }
            if (containment.contained) {
                return { allow: true, status: 'patch_equivalent_to_default_ref', source: 'git_patch_equivalence', ref };
            }
        }

        return {
            allow: false,
            status: metadataStatus || undefined,
            error: checkedRefs.length
                ? `worktree HEAD is not contained in checked refs: ${checkedRefs.join(', ')}`
                : 'no default/main refs were available for convergence verification',
        };
    }

export function isCompletedHostedSession(self: DaemonCommandRouter, record: any): boolean {
        return record?.lifecycle === 'stopped' || record?.lifecycle === 'failed' || record?.lifecycle === 'interrupted';
    }

export async function recordIntentionalMeshSessionStop(self: DaemonCommandRouter, args: {
        meshId: string;
        nodeId: string;
        node: any;
        sessionId: string;
        mode: RepoMeshSessionCleanupMode;
        source: 'mesh_cleanup_sessions' | 'mesh_remove_node' | 'magi_session_cleanup';
        action: 'stop_session' | 'delete_session_force';
    }): Promise<void> {
        try {
            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
            appendLedgerEntry(args.meshId, {
                kind: 'session_stopped',
                nodeId: args.nodeId,
                sessionId: args.sessionId,
                payload: {
                    intentional: true,
                    reason: 'operator_cleanup',
                    intentionalStopReason: 'operator_cleanup',
                    source: args.source,
                    cleanupMode: args.mode,
                    action: args.action,
                    workspace: typeof args.node?.workspace === 'string' ? args.node.workspace : undefined,
                },
            });
        } catch (e: any) {
            LOG.warn('MeshCleanup', `Failed to record intentional cleanup stop for ${args.sessionId}: ${e?.message || e}`);
        }
    }

export async function cleanupMeshSessions(self: DaemonCommandRouter, args: {
        meshId: string;
        nodeId: string;
        node: any;
        mode: RepoMeshSessionCleanupMode;
        sessionIds?: string[];
        dryRun?: boolean;
        source?: 'mesh_cleanup_sessions' | 'mesh_remove_node' | 'magi_session_cleanup';
        /**
         * MAGI auto-cleanup safety gate: a map of sessionId → the queue task id that
         * session must have been AUTO-LAUNCHED for (record meta autoLaunchedForQueueTaskId).
         * When set, a matched explicit session is only acted on if its record carries that
         * exact marker. A reused idle session (no marker), the coordinator session, a
         * re-assigned session, or any session whose marker points at a DIFFERENT task is
         * skipped (reason 'auto_launch_marker_mismatch') — so MAGI never kills a session it
         * didn't itself spawn for this fan-out. Only consulted alongside explicit sessionIds.
         */
        requireAutoLaunchedForTaskIds?: Record<string, string>;
        /**
         * Opt-in orphan reclaim (default false). See SESSION-ACCUMULATION-LEAK.
         * When true, a workspace-only live_runtime session (no node binding) OR a
         * live_runtime session bound to a node absent from `liveMeshNodeIds` is
         * stopped instead of skipped by the conservative shared-daemon guard. A
         * session whose meshNodeId is STILL in `liveMeshNodeIds` (active sibling)
         * is never reclaimed — that is the shared-daemon safety this preserves.
         */
        reclaimOrphans?: boolean;
        liveMeshNodeIds?: string[];
    }): Promise<{ success: boolean; [key: string]: unknown }> {
        if (args.mode === 'preserve') {
            return { success: true, mode: 'preserve', matchedCount: 0, stoppedSessionIds: [], deletedSessionIds: [], skippedSessionIds: [] };
        }
        if (!self.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };

        const requestedSessionIds = Array.isArray(args.sessionIds)
            ? new Set(args.sessionIds.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean))
            : undefined;
        // Orphan-reclaim support (opt-in). The live-node id list lets us tell an
        // orphan (owning node gone from the mesh) apart from a still-active sibling
        // sharing this daemon. daemonIdsEquivalent (not raw ===) guards against the
        // canon-identity defect class: daemonId forms (daemon_mach_ vs mach_) and
        // normalized vs raw meshNodeId must compare equivalent, not literally equal.
        const reclaimOrphans = args.reclaimOrphans === true;
        const liveMeshNodeIds = Array.isArray(args.liveMeshNodeIds)
            ? args.liveMeshNodeIds.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean)
            : [];
        const isNodeStillLive = (candidateNodeId: string): boolean => {
            if (!candidateNodeId) return false;
            return liveMeshNodeIds.some(liveId =>
                liveId === candidateNodeId
                || meshNodeIdMatches({ id: liveId }, candidateNodeId)
                || daemonIdsEquivalent(liveId, candidateNodeId));
        };
        const reclaimedOrphanSessionIds: string[] = [];
        const sessions = await self.deps.sessionHostControl.listSessions();
        const matched = sessions.filter(record => self.sessionMatchesMeshNode(record, args.node, args.nodeId, requestedSessionIds));
        const hasExplicitSessionIds = !!requestedSessionIds?.size;
        const stoppedSessionIds: string[] = [];
        const deletedSessionIds: string[] = [];
        const skippedSessionIds: string[] = [];
        const skippedLiveSessionIds: string[] = [];
        const skippedCoordinatorSessionIds: string[] = [];
        const skippedLiveSessionReasons: Array<{ sessionId: string; reason: string }> = [];
        const skippedMarkerMismatchSessionIds: string[] = [];
        const actedLiveDelegateSessionIds: string[] = [];
        const deleteUnsupportedSessionIds: string[] = [];
        const recordsRemainSessionIds: string[] = [];
        const errors: Array<{ sessionId: string; error: string }> = [];
        const cleanupSource = args.source || 'mesh_cleanup_sessions';
        const markedIntentionalStopSessionIds = new Set<string>();
        const markIntentionalStop = async (sessionId: string, action: 'stop_session' | 'delete_session_force') => {
            if (args.dryRun || markedIntentionalStopSessionIds.has(sessionId)) return;
            markedIntentionalStopSessionIds.add(sessionId);
            await self.recordIntentionalMeshSessionStop({
                meshId: args.meshId,
                nodeId: args.nodeId,
                node: args.node,
                sessionId,
                mode: args.mode,
                source: cleanupSource,
                action,
            });
        };
        const matchedBySurfaceKind = {
            live_runtime: 0,
            recovery_snapshot: 0,
            inactive_record: 0,
        };

        for (const record of matched) {
            const surfaceKind = getSessionHostSurfaceKind(record);
            matchedBySurfaceKind[surfaceKind] += 1;
        }

        for (const record of matched) {
            const sessionId = String(record.sessionId);
            const completed = self.isCompletedHostedSession(record);
            const surfaceKind = getSessionHostSurfaceKind(record);
            const liveRuntime = surfaceKind === 'live_runtime';
            const coordinatorSession = readStringValue(record?.meta?.meshCoordinatorFor) === args.meshId;
            // A delegate session was launched by the coordinator specifically FOR this node
            // (meta.meshNodeId === this node). It is 1:1 bound to the node, even when the node
            // shares its daemon runtime with the main/other nodes. Removing the node should be
            // able to stop its own delegate session — the shared-daemon concern only applies to
            // sessions we matched by workspace alone (which could belong to the coordinator or to
            // a sibling node that is still active).
            const recordNodeId = readStringValue(record?.meta?.meshNodeId);
            const recordMeshNodeFor = readStringValue(record?.meta?.meshNodeFor);
            const delegateBoundToThisNode = !!recordNodeId
                && recordNodeId === args.nodeId
                && (!recordMeshNodeFor || recordMeshNodeFor === args.meshId);
            if (!hasExplicitSessionIds && coordinatorSession) {
                skippedSessionIds.push(sessionId);
                skippedCoordinatorSessionIds.push(sessionId);
                continue;
            }
            // MAGI auto-cleanup marker gate. When the caller supplied a per-session
            // expected autoLaunchedForQueueTaskId, the session must (a) carry the marker
            // on its record meta AND (b) have it equal the expected replica task id.
            // This is the safety core for MAGI: explicit session_ids bypass the
            // self-coordinator / shared-daemon guards (hasExplicitSessionIds=true), so the
            // ONLY thing protecting a reused-idle / coordinator / re-assigned session here
            // is this marker check. Always-skip the coordinator session even when its id is
            // passed explicitly (it never carries an autoLaunchedForQueueTaskId marker, so
            // the mismatch branch already covers it, but be explicit for clarity).
            if (args.requireAutoLaunchedForTaskIds) {
                const decision = magiAutoLaunchedSessionCleanupDecision({
                    recordMarker: readStringValue(record?.meta?.autoLaunchedForQueueTaskId),
                    expectedTaskId: args.requireAutoLaunchedForTaskIds[sessionId],
                    isCoordinatorSession: coordinatorSession,
                });
                if (!decision.allow) {
                    skippedSessionIds.push(sessionId);
                    skippedMarkerMismatchSessionIds.push(sessionId);
                    skippedLiveSessionReasons.push({ sessionId, reason: decision.reason });
                    continue;
                }
            }
            // Only the conservative shared-daemon guard for live sessions that are NOT a delegate
            // explicitly bound to this node. Delegate-bound live sessions fall through and are
            // stopped/deleted by the mode handlers below (which already record an intentional stop).
            //
            // Worktree-removal exception: when a WORKTREE node is being removed
            // (source === 'mesh_remove_node' AND node.isLocalWorktree === true), its
            // node-binding is already gone, so a still-live session in that workspace
            // matches by workspace ALONE (recordNodeId is empty). The shared-daemon
            // concern does not apply — a worktree has a private workspace path that is
            // not shared with the base/other nodes — so leaving it skipped orphans the
            // chat after the node + worktree dir + branch are gone. Clean it instead.
            // This narrowly covers ONLY the pure workspace-only-no-binding case; a
            // session bound to ANOTHER node (recordNodeId set and != this node) is still
            // skipped (live_delegate_bound_to_other_node), and the coordinator session is
            // already protected unconditionally above.
            const matchedByWorkspaceOnly = !recordNodeId;
            const isWorktreeNodeRemoval = cleanupSource === 'mesh_remove_node' && args.node?.isLocalWorktree === true;
            const cleanWorkspaceOnlyForWorktree = isWorktreeNodeRemoval && matchedByWorkspaceOnly;
            // Opt-in orphan reclaim (SESSION-ACCUMULATION-LEAK): a live_runtime that
            // is either workspace-only (no node binding — the leaked spec-CLI case)
            // or bound to a node no longer present in the mesh is an orphan and safe
            // to stop. A session bound to a node STILL live in the mesh is an active
            // sibling on this shared daemon and is left to the normal guard. Node
            // equivalence uses isNodeStillLive (daemonIdsEquivalent under the hood),
            // never a raw === on the id form.
            const reclaimableOrphan = reclaimOrphans
                && liveRuntime
                && !delegateBoundToThisNode
                && (matchedByWorkspaceOnly || !isNodeStillLive(recordNodeId));
            if (!hasExplicitSessionIds && liveRuntime && !delegateBoundToThisNode && !cleanWorkspaceOnlyForWorktree && !reclaimableOrphan) {
                skippedSessionIds.push(sessionId);
                skippedLiveSessionIds.push(sessionId);
                const reason = recordNodeId && recordNodeId !== args.nodeId
                    ? `live_delegate_bound_to_other_node:${recordNodeId}`
                    : matchedByWorkspaceOnly
                        ? 'live_session_matched_by_workspace_only_no_node_binding'
                        : 'live_session_not_bound_to_this_node';
                skippedLiveSessionReasons.push({ sessionId, reason });
                continue;
            }
            if (cleanWorkspaceOnlyForWorktree && !delegateBoundToThisNode) {
                // A workspace-only live session on a worktree being removed is treated
                // like a bound delegate for accounting (so callers can see it was acted on).
                actedLiveDelegateSessionIds.push(sessionId);
            }
            if (reclaimableOrphan && !cleanWorkspaceOnlyForWorktree && !delegateBoundToThisNode) {
                // Reclaimed orphan — surface it distinctly so callers can audit what
                // the opt-in reclaim path stopped that the normal guard would have kept.
                reclaimedOrphanSessionIds.push(sessionId);
                actedLiveDelegateSessionIds.push(sessionId);
            }
            if (!hasExplicitSessionIds && liveRuntime && delegateBoundToThisNode && args.mode === 'delete_stopped') {
                // delete_stopped never stops live runtimes by contract — even bound delegates.
                // Surface a clear reason instead of an unexplained skip so callers know to use
                // stop / stop_and_delete to release a still-running bound delegate.
                skippedSessionIds.push(sessionId);
                skippedLiveSessionIds.push(sessionId);
                skippedLiveSessionReasons.push({ sessionId, reason: 'live_delegate_preserved_by_delete_stopped_mode_use_stop_or_stop_and_delete' });
                continue;
            }
            if (!hasExplicitSessionIds && liveRuntime && delegateBoundToThisNode) {
                actedLiveDelegateSessionIds.push(sessionId);
            }
            try {
                if (args.mode === 'stop') {
                    if (!completed) {
                        if (!args.dryRun) {
                            await markIntentionalStop(sessionId, 'stop_session');
                            await self.deps.sessionHostControl.stopSession(sessionId);
                        }
                        stoppedSessionIds.push(sessionId);
                    } else {
                        skippedSessionIds.push(sessionId);
                    }
                    continue;
                }

                if (args.mode === 'delete_stopped') {
                    if (completed) {
                        if (!args.dryRun) await self.deps.sessionHostControl.deleteSession(sessionId, { force: false });
                        deletedSessionIds.push(sessionId);
                    } else {
                        skippedSessionIds.push(sessionId);
                    }
                    continue;
                }

                if (args.mode === 'stop_and_delete') {
                    if (!completed) await markIntentionalStop(sessionId, 'delete_session_force');
                    if (!args.dryRun) await self.deps.sessionHostControl.deleteSession(sessionId, { force: true });
                    deletedSessionIds.push(sessionId);
                    continue;
                }
            } catch (e: any) {
                const message = e?.message || String(e);
                if (message.includes('Unsupported session host request: delete_session')
                    && (args.mode === 'delete_stopped' || args.mode === 'stop_and_delete')) {
                    deleteUnsupportedSessionIds.push(sessionId);
                    recordsRemainSessionIds.push(sessionId);
                    if (args.mode === 'stop_and_delete' && !completed) {
                        try {
                            await markIntentionalStop(sessionId, 'stop_session');
                            await self.deps.sessionHostControl.stopSession(sessionId);
                            stoppedSessionIds.push(sessionId);
                        } catch (stopError: any) {
                            errors.push({ sessionId, error: stopError?.message || String(stopError) });
                            continue;
                        }
                    }
                    skippedSessionIds.push(sessionId);
                    continue;
                }
                errors.push({ sessionId, error: message });
            }
        }

        const deleteUnsupported = deleteUnsupportedSessionIds.length > 0;
        return {
            success: errors.length === 0,
            mode: args.mode,
            dryRun: args.dryRun === true,
            matchedCount: matched.length,
            matchedBySurfaceKind,
            stoppedSessionIds,
            deletedSessionIds,
            skippedSessionIds,
            skippedLiveSessionIds,
            skippedCoordinatorSessionIds,
            ...(skippedMarkerMismatchSessionIds.length ? { skippedMarkerMismatchSessionIds } : {}),
            ...(actedLiveDelegateSessionIds.length ? { actedLiveDelegateSessionIds } : {}),
            ...(reclaimedOrphanSessionIds.length ? { reclaimedOrphanSessionIds } : {}),
            ...(skippedLiveSessionReasons.length ? { skippedLiveSessionReasons } : {}),
            ...(deleteUnsupported ? {
                deleteUnsupported: true,
                effectiveCleanup: args.mode === 'stop_and_delete'
                    ? 'stopped_only_records_remain'
                    : 'delete_unsupported_records_remain',
                deleteUnsupportedSessionIds,
                recordsRemainSessionIds,
            } : {}),
            ...(errors.length ? { errors } : {}),
        };
    }
