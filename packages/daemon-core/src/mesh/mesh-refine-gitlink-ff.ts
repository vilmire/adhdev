// Refinery submodule gitlink handling around a merge: detect trivially
// fast-forwardable gitlink conflicts, synthesize the equalized merge tree, and
// align the submodules after the merge. Split out of mesh-refine-gates.ts
// (re-exported there).

import { hiddenExecFileSync } from '../process/hidden-spawn.js';
import {
    GIT,
    readChangedGitlinkPaths,
    readTreeObject,
    isSubmoduleFastForward,
    ensureSubmoduleCommitLocal,
    type GitlinkTrivialFastForwardEvaluation,
    probeSubmoduleFastForward,
    type GitAncestryProbe,
    readChangedPathKinds,
    REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
    truncateValidationOutput,
} from './mesh-refine-gitlink-utils.js';
import { resolve as pathResolve, join as pathJoin } from 'path';
import * as fs from 'fs';
import type { MeshRefineSubmoduleAlignmentSummary } from './mesh-refine-gates.js';
import { getGitRepoStatus } from '../git/git-status.js';

/**
 * Resolve the absolute path to the repo's real git directory. In a linked
 * worktree, `.git` is a file pointing elsewhere, so we cannot assume a `.git`
 * subdirectory exists — a temporary index file must live in the actual git dir.
 */
function resolveGitDir(repoRoot: string): string {
    const out = hiddenExecFileSync(GIT, ['rev-parse', '--absolute-git-dir'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    }).trim();
    return out;
}

/**
 * Result of evaluating whether a `git merge-tree --write-tree` submodule
 * conflict is in fact a trivial gitlink fast-forward that should pass the
 * patch-equivalence gate.
 *
 * `git merge-tree` (and `git merge` with the default recursive strategy)
 * refuses to 3-way merge gitlinks unless the case is "trivial" — and it
 * treats *any* gitlink that differs across merge-base/base/branch as
 * non-trivial, even when the branch-side commit is a strict descendant of the
 * base-side commit (i.e. a real fast-forward). Refinery only ever wants to
 * accept the branch's recorded gitlink, so a fast-forwardable bump is safe to
 * resolve to the branch side without any conflict.
 */

/**
 * Return the changed gitlink paths between base and branch whose advance is a
 * strict fast-forward (the base-side commit is an ancestor of the branch-side
 * commit inside that submodule's repo). These are the paths whose patch-id hunk
 * may legitimately differ when base has advanced the same submodule, so they
 * are safe to exclude from the patch-equivalence comparison. A non-ff (genuinely
 * diverged) gitlink is deliberately excluded from this set so it still fails the
 * gate.
 */
export function collectFastForwardGitlinkPaths(repoRoot: string, baseHead: string, branchHead: string): string[] {
    return readChangedGitlinkPaths(repoRoot, baseHead, branchHead).filter(path => {
        const baseCommit = readTreeObject(repoRoot, baseHead, path);
        const branchCommit = readTreeObject(repoRoot, branchHead, path);
        if (!baseCommit || !branchCommit) return false;
        return isSubmoduleFastForward(pathResolve(repoRoot, path), baseCommit, branchCommit);
    });
}

/**
 * Collect gitlink resolutions for the *trivial fast-forward* case, so the
 * gitlink-aware root rebase ({@link rootRebaseResolvingGitlinks}) can drive a
 * behind>0 rebase whose changed submodule pointer would otherwise make a plain
 * `git rebase baseHead` abort on the gitlink.
 *
 * When base has advanced the SAME submodule as the branch, git's recursive merge
 * refuses to auto-merge the gitlink even when the two commits are in a strict
 * ancestor/descendant relationship (a real fast-forward). That is fine for the
 * patch-equivalence gate (it synthesizes the merged tree), but the sync_base
 * *rebase* still runs `git rebase baseHead`, which stops on the same gitlink
 * conflict and aborts → the branch is wrongly blocked. This helper produces the
 * per-path resolution the root rebase needs so those paths take the gitlink-aware
 * path instead of the plain rebase.
 *
 * Direction rule (kept consistent with the diverged path, which always resolves to
 * the linear descendant): pick whichever of base/branch commit is the DESCENDANT
 * of the other and resolve the gitlink to it — the more-advanced commit wins.
 *   - base ancestor-of branch  → branch is more advanced → resolve to branch-side.
 *   - branch ancestor-of base  → base is more advanced   → resolve to base-side.
 *   - neither ancestor (diverged) or ambiguous → excluded (left to the diverged
 *     converge path / patch-equivalence gate).
 *
 * The base-side submodule commit is committed in the base workspace and may be
 * missing from the worktree's submodule object store; a best-effort local fetch
 * (identical to {@link convergeDivergedSubmoduleGitlinks}) brings it in so the
 * ancestry checks and the root rebase's `checkout --detach` can see it.
 */
export function collectTrivialFastForwardGitlinkResolutions(
    worktreeRoot: string,
    baseRepoRoot: string,
    baseHead: string,
    branchHead: string,
): Array<{ path: string; rebasedCommit: string }> {
    const resolutions: Array<{ path: string; rebasedCommit: string }> = [];
    for (const path of readChangedGitlinkPaths(worktreeRoot, baseHead, branchHead)) {
        const baseCommit = readTreeObject(baseRepoRoot, baseHead, path);
        const branchCommit = readTreeObject(worktreeRoot, branchHead, path);
        if (!baseCommit || !branchCommit) continue;
        const submoduleRepoPath = pathResolve(worktreeRoot, path);
        // Make the base-side commit available locally (it may only live in base/<path>).
        ensureSubmoduleCommitLocal(submoduleRepoPath, pathResolve(baseRepoRoot, path), baseCommit);
        if (baseCommit === branchCommit) {
            // Identical pointer — no gitlink conflict to resolve; skip.
            continue;
        }
        if (isSubmoduleFastForward(submoduleRepoPath, baseCommit, branchCommit)) {
            // base ancestor-of branch → branch-side is the descendant (more advanced).
            resolutions.push({ path, rebasedCommit: branchCommit });
        } else if (isSubmoduleFastForward(submoduleRepoPath, branchCommit, baseCommit)) {
            // branch ancestor-of base → base-side is the descendant (more advanced).
            resolutions.push({ path, rebasedCommit: baseCommit });
        }
        // else: diverged / ambiguous → leave to convergeDivergedSubmoduleGitlinks.
    }
    return resolutions;
}


/**
 * Decide whether a merge-tree submodule conflict between base and branch is a
 * trivial gitlink fast-forward (and nothing else).
 *
 * The conflict is treated as trivial ONLY when:
 *   1. at least one changed gitlink exists,
 *   2. every changed gitlink fast-forwards (base-commit is an ancestor of the
 *      branch-commit inside that submodule's repo), and
 *   3. the *only* paths that changed on both sides of the merge (i.e. the paths
 *      that could possibly produce a 3-way conflict — the intersection of
 *      mergeBase→base and mergeBase→branch changes) are gitlinks. Any
 *      overlapping non-gitlink path means a genuine content conflict could be
 *      hiding behind the submodule failure, so we keep the block.
 *
 * If any of these fail, the conflict is left as a genuine block. This never
 * passes a regular-file conflict or a diverged (non-ff) gitlink.
 */
export function evaluateGitlinkTrivialFastForward(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
): GitlinkTrivialFastForwardEvaluation {
    const changedGitlinks = readChangedGitlinkPaths(repoRoot, baseHead, branchHead).map(path => {
        const baseCommit = readTreeObject(repoRoot, baseHead, path);
        const branchCommit = readTreeObject(repoRoot, branchHead, path);
        const submoduleRepoPath = pathResolve(repoRoot, path);
        const probe = (!!baseCommit && !!branchCommit)
            ? probeSubmoduleFastForward(submoduleRepoPath, baseCommit, branchCommit)
            : 'undeterminable' as GitAncestryProbe;
        return {
            path,
            baseCommit,
            branchCommit,
            fastForward: probe === true,
            ...(probe === 'undeterminable' ? { fastForwardUndeterminable: true } : {}),
        };
    });

    if (changedGitlinks.length === 0) {
        return { trivial: false, reason: 'no_changed_gitlinks', gitlinks: changedGitlinks };
    }

    // ★Split the block reason by WHAT WE ACTUALLY KNOW. Both cases still block —
    // the gate's strength is unchanged — but they are opposite statements:
    //   diverged      — git answered "not an ancestor" with both commits present.
    //   undeterminable — git was never able to answer (missing object/checkout).
    // Reporting the second as `diverged_gitlinks` is a claim about the history
    // that was never measured, and it has already cost a coordinator an
    // unnecessary submodule rebase. Undeterminable is reported separately and
    // LOUDLY (see warnGitlinkFastForwardUndeterminable).
    const undeterminable = changedGitlinks.filter(entry => entry.fastForwardUndeterminable);
    const diverged = changedGitlinks.filter(entry => !entry.fastForward && !entry.fastForwardUndeterminable);
    if (undeterminable.length > 0 || diverged.length > 0) {
        const parts: string[] = [];
        // Diverged first: it is the stronger, measured claim.
        if (diverged.length > 0) parts.push(`diverged_gitlinks:${diverged.map(entry => entry.path).join(',')}`);
        if (undeterminable.length > 0) {
            parts.push(`undeterminable_gitlinks:${undeterminable.map(entry => entry.path).join(',')}`);
        }
        return { trivial: false, reason: parts.join(' '), gitlinks: changedGitlinks };
    }

    // Prove there is no *other* conflict (regular files, or a gitlink that
    // diverged on both sides). A 3-way merge can only conflict on a path that
    // changed on BOTH sides relative to the merge-base. Compute that overlap and
    // require every overlapping path to be a gitlink — non-gitlink overlap means
    // a genuine content conflict that must stay blocked.
    let mergeBase = '';
    try {
        mergeBase = hiddenExecFileSync(GIT, ['merge-base', baseHead, branchHead], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        }).trim();
    } catch {
        return { trivial: false, reason: 'merge_base_unresolved', gitlinks: changedGitlinks };
    }
    if (!mergeBase) {
        return { trivial: false, reason: 'merge_base_unresolved', gitlinks: changedGitlinks };
    }

    const baseSideChanges = readChangedPathKinds(repoRoot, mergeBase, baseHead);
    const branchSideChanges = readChangedPathKinds(repoRoot, mergeBase, branchHead);
    const baseChangedPaths = new Map(baseSideChanges.map(entry => [entry.path, entry]));
    // Overlapping paths = candidates for a real 3-way conflict.
    const overlapping = branchSideChanges.filter(entry => baseChangedPaths.has(entry.path));
    const nonGitlinkOverlap = overlapping.filter(entry => {
        const baseEntry = baseChangedPaths.get(entry.path);
        return !(entry.isGitlink && baseEntry?.isGitlink);
    });
    if (nonGitlinkOverlap.length > 0) {
        return {
            trivial: false,
            reason: `non_gitlink_overlap:${nonGitlinkOverlap.map(entry => entry.path).join(',')}`,
            gitlinks: changedGitlinks,
        };
    }

    return { trivial: true, gitlinks: changedGitlinks };
}

/**
 * Build a tree identical to `commitish`'s tree except every gitlink in `paths`
 * is rewritten to `placeholderCommit`. Used to neutralize submodule pointers so
 * `git merge-tree` stops bailing on the "Recursive merging with submodules"
 * limitation and can 3-way merge the surrounding regular-file content. Returns
 * the tree SHA, or undefined on failure.
 */
function buildTreeWithGitlinksEqualized(
    repoRoot: string,
    commitish: string,
    paths: string[],
    placeholderCommit: string,
): string | undefined {
    try {
        const tree = hiddenExecFileSync(GIT, ['rev-parse', `${commitish}^{tree}`], {
            cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
        }).trim();
        if (!tree) return undefined;
        const updates = paths.map(path => `160000 commit ${placeholderCommit}\t${path}`).join('\n');
        if (!updates) return tree;
        const tmpIndex = pathJoin(resolveGitDir(repoRoot), `adhdev-refine-eq-${commitish.slice(0, 12)}.index`);
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        try {
            hiddenExecFileSync(GIT, ['read-tree', tree], { cwd: repoRoot, env, stdio: 'ignore' });
            hiddenExecFileSync(GIT, ['update-index', '--index-info'], {
                cwd: repoRoot, env, input: `${updates}\n`, encoding: 'utf8',
                stdio: ['pipe', 'ignore', 'ignore'],
            });
            const newTree = hiddenExecFileSync(GIT, ['write-tree'], { cwd: repoRoot, env, encoding: 'utf8' }).trim();
            return newTree || undefined;
        } finally {
            try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ }
        }
    } catch {
        return undefined;
    }
}

/**
 * Synthesize the merge result for a trivial gitlink fast-forward.
 *
 * `git merge-tree` bails whenever a gitlink differs across base/branch even
 * when the advance is a strict fast-forward, so we synthesize the result it
 * *would* have produced. Crucially, when the merge-base of base and branch is
 * NOT `baseHead` (i.e. base has diverged — a sibling was merged into main
 * ahead of us), `baseHead`'s tree does not contain our branch's own
 * non-gitlink changes. Simply overlaying gitlinks onto `baseHead`'s tree would
 * therefore drop those changes and break patch-equivalence.
 *
 * To handle the diverged case correctly we run a REAL 3-way merge of the
 * regular-file content (with the conflicting gitlinks temporarily equalized to
 * a common placeholder so merge-tree won't bail), then overlay each changed
 * gitlink's branch-side commit onto the merged result. This preserves both
 * sides' non-gitlink changes.
 *
 * Returns the tree SHA, or undefined on failure / genuine non-gitlink
 * conflict. Caller must have already proven (via
 * evaluateGitlinkTrivialFastForward) that every changed gitlink fast-forwards
 * and no other path conflicts.
 */
export function synthesizeTrivialFastForwardMergeTree(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
    gitlinks: Array<{ path: string; branchCommit?: string }>,
): string | undefined {
    try {
        const branchGitlinks = gitlinks.filter(entry => entry.branchCommit);
        const gitlinkPaths = branchGitlinks.map(entry => entry.path);

        // Establish the regular-file content of the merge via a real 3-way merge
        // with the conflicting gitlinks neutralized. The placeholder is the
        // merge-base's value for a gitlink (or, failing that, any branch-side
        // commit) — it only needs to be identical across all three trees.
        const mergeBase = hiddenExecFileSync(GIT, ['merge-base', baseHead, branchHead], {
            cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
        }).trim();

        let mergedContentTree: string | undefined;
        if (mergeBase && gitlinkPaths.length > 0) {
            const placeholder = readTreeObject(repoRoot, mergeBase, gitlinkPaths[0])
                || branchGitlinks[0].branchCommit!;
            const baseEqTree = buildTreeWithGitlinksEqualized(repoRoot, mergeBase, gitlinkPaths, placeholder);
            const oursEqTree = buildTreeWithGitlinksEqualized(repoRoot, baseHead, gitlinkPaths, placeholder);
            const theirsEqTree = buildTreeWithGitlinksEqualized(repoRoot, branchHead, gitlinkPaths, placeholder);
            if (baseEqTree && oursEqTree && theirsEqTree) {
                try {
                    // merge-tree --write-tree needs commits (to derive a merge-base);
                    // synthesize ours/theirs as children of a common base commit.
                    const baseEqCommit = hiddenExecFileSync(GIT, ['commit-tree', baseEqTree, '-m', 'refine-ff-base'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const oursEqCommit = hiddenExecFileSync(GIT, ['commit-tree', oursEqTree, '-p', baseEqCommit, '-m', 'refine-ff-ours'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const theirsEqCommit = hiddenExecFileSync(GIT, ['commit-tree', theirsEqTree, '-p', baseEqCommit, '-m', 'refine-ff-theirs'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const mergeOut = hiddenExecFileSync(GIT, ['merge-tree', '--write-tree', oursEqCommit, theirsEqCommit], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
                    }).trim();
                    mergedContentTree = mergeOut.split(/\s+/)[0] || undefined;
                } catch {
                    // A real conflict in the equalized merge means a genuine
                    // non-gitlink content conflict the evaluator did not foresee
                    // (or unavailable objects). Fall through to the simple synth.
                    mergedContentTree = undefined;
                }
            }
        }

        // Fallback: when there is no diverged base (merge-base === baseHead) the
        // regular-file content of the merge is exactly baseHead's tree, so just
        // overlay the gitlinks. Also used when the real merge could not run.
        const contentTree = mergedContentTree
            || hiddenExecFileSync(GIT, ['rev-parse', `${baseHead}^{tree}`], {
                cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
            }).trim();
        if (!contentTree) return undefined;

        const updates = branchGitlinks
            .map(entry => `160000 commit ${entry.branchCommit}\t${entry.path}`)
            .join('\n');
        if (!updates) return contentTree;
        const tmpIndex = pathJoin(resolveGitDir(repoRoot), `adhdev-refine-ff-${baseHead.slice(0, 12)}-${branchHead.slice(0, 12)}.index`);
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        try {
            hiddenExecFileSync(GIT, ['read-tree', contentTree], { cwd: repoRoot, env, stdio: 'ignore' });
            hiddenExecFileSync(GIT, ['update-index', '--index-info'], {
                cwd: repoRoot,
                env,
                input: `${updates}\n`,
                encoding: 'utf8',
                stdio: ['pipe', 'ignore', 'ignore'],
            });
            const newTree = hiddenExecFileSync(GIT, ['write-tree'], { cwd: repoRoot, env, encoding: 'utf8' }).trim();
            return newTree || undefined;
        } finally {
            try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ }
        }
    } catch {
        return undefined;
    }
}

export async function alignRefinerySubmodulesAfterMerge(
    repoRoot: string,
    previousBaseHead: string,
    currentHead: string,
    options: { submoduleIgnorePaths?: string[] } = {},
): Promise<MeshRefineSubmoduleAlignmentSummary> {
    const startedAt = Date.now();
    const changedGitlinkPaths = readChangedGitlinkPaths(repoRoot, previousBaseHead, currentHead)
        .filter(path => !(options.submoduleIgnorePaths || []).includes(path));
    const preStatus = await getGitRepoStatus(repoRoot, {
        includeSubmodules: true,
        submoduleIgnorePaths: options.submoduleIgnorePaths,
        timeoutMs: 15_000,
        // Decision path — the out-of-sync submodule set drives a mutating `submodule
        // update`. Must not act on a TTL-cached status; bypass the C1 cache.
        forceFresh: true,
    });
    const outOfSyncPaths = (preStatus.submodules || [])
        .filter(submodule => submodule.dirty || submodule.outOfSync || !!submodule.error)
        .map(submodule => submodule.path);
    const updatePaths = [...new Set([...changedGitlinkPaths, ...outOfSyncPaths])].sort();

    if (updatePaths.length === 0) {
        return {
            status: 'skipped',
            changedGitlinkPaths,
            outOfSyncPaths,
            updatedPaths: [],
            verifiedPaths: [],
            durationMs: Date.now() - startedAt,
            reason: 'no_changed_or_out_of_sync_submodules',
        };
    }

    const commandArgs = ['submodule', 'update', '--init', '--recursive', '--', ...updatePaths];
    try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const result = await execFileAsync(GIT, commandArgs, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
            timeout: 60_000,
            windowsHide: true,
        });
        const postStatus = await getGitRepoStatus(repoRoot, {
            includeSubmodules: true,
            submoduleIgnorePaths: options.submoduleIgnorePaths,
            timeoutMs: 15_000,
            // Re-read AFTER `submodule update` mutated the tree — MUST be fresh, never the
            // cached preStatus from moments ago (which would falsely report still-dirty).
            forceFresh: true,
        });
        const remaining = (postStatus.submodules || [])
            .filter(submodule => updatePaths.includes(submodule.path) && (submodule.dirty || submodule.outOfSync || !!submodule.error));
        return {
            status: remaining.length === 0 ? 'passed' : 'failed',
            changedGitlinkPaths,
            outOfSyncPaths,
            updatedPaths: updatePaths,
            verifiedPaths: updatePaths.filter(path => !remaining.some(submodule => submodule.path === path)),
            durationMs: Date.now() - startedAt,
            command: `git ${commandArgs.join(' ')}`,
            stdout: truncateValidationOutput(result.stdout),
            stderr: truncateValidationOutput(result.stderr),
            ...(remaining.length > 0 ? { error: `Submodule checkout remained out of sync after update: ${remaining.map(entry => entry.path).join(', ')}` } : {}),
        };
    } catch (e: any) {
        return {
            status: 'failed',
            changedGitlinkPaths,
            outOfSyncPaths,
            updatedPaths: updatePaths,
            verifiedPaths: [],
            durationMs: Date.now() - startedAt,
            command: `git ${commandArgs.join(' ')}`,
            error: e?.message || String(e),
            stdout: truncateValidationOutput(e?.stdout),
            stderr: truncateValidationOutput(e?.stderr),
        };
    }
}
