// Refinery patch-equivalence and effective-diff gates: is the branch's change
// already contained in the target (git patch-id), classify why not, and the
// worktree-containment check. Split out of mesh-refine-gates.ts (re-exported there).

import {
    GIT,
    REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
    warnGitlinkFastForwardUndeterminable,
    truncateValidationOutput,
    warnRefineSubmoduleUndeterminable,
    probeGitAncestry,
    probeSubmoduleGitlinkReachability,
    readChangedGitlinkPaths,
    readTreeObject,
} from './mesh-refine-gitlink-utils.js';
import type { MeshRefinePatchEquivalenceSummary, MeshRefineEffectiveDiffSummary, MeshRefineSubmoduleConflictHint } from './mesh-refine-gates.js';
import { evaluateGitlinkTrivialFastForward, synthesizeTrivialFastForwardMergeTree, collectFastForwardGitlinkPaths } from './mesh-refine-gitlink-ff.js';
import { hiddenExecFileSync } from '../process/hidden-spawn.js';
import { resolveSubmoduleDefaultBranch } from './worktree-bootstrap-config.js';
import { resolve as pathResolve } from 'path';

async function computeGitPatchId(
    cwd: string,
    fromRef: string,
    toRef: string,
    excludePaths: string[] = [],
): Promise<string> {
    const { hiddenSpawnSync } = await import('../process/hidden-spawn.js');
    // When excludePaths is non-empty we drop those paths from the diff via
    // `:(exclude)` pathspecs. This is used to omit gitlink paths that have
    // already been proven a safe fast-forward: their patch hunks legitimately
    // differ between the expected (mergeBase→branch) and actual (base→merged)
    // diffs because base may have advanced the same gitlink, so comparing them
    // would spuriously fail patch-equivalence even though the merge is sound.
    const diffArgs = ['diff', '--patch', '--full-index', fromRef, toRef];
    if (excludePaths.length > 0) {
        diffArgs.push('--', '.', ...excludePaths.map(path => `:(exclude)${path}`));
    }
    // The patch itself is streamed `git diff | git patch-id` through an OS pipe
    // and is NEVER buffered in this process: only the ~50-byte patch-id crosses
    // the boundary. Buffering it here used to cap the gate at
    // REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES (4 MB) of *patch text*, which a
    // large vendored bundle blows straight through — a 26 MB diff made
    // execFileSync throw ENOBUFS, the outer catch turned that I/O failure into
    // `status: 'failed'`, and a genuinely patch-equivalent branch was reported as
    // a divergence with no cause recorded anywhere (VENDOR-BUNDLE-ENOBUFS). The
    // gate's verdict is unchanged — same two `git patch-id --stable` values
    // compared the same way — it just no longer depends on patch size.
    // No shell is used: quoting rules differ between POSIX sh and cmd.exe, and
    // this gate runs on win32 mesh nodes too. Instead `git diff` writes to a
    // temp file and `git patch-id` reads it via stdin, so the patch stays on
    // disk and out of this process either way.
    const { mkdtempSync, rmSync, openSync, closeSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const scratch = mkdtempSync(join(tmpdir(), 'adhdev-patchid-'));
    const patchFile = join(scratch, 'patch.diff');
    try {
        const out = openSync(patchFile, 'w');
        let diffRun;
        try {
            diffRun = hiddenSpawnSync(GIT, diffArgs, {
                cwd,
                stdio: ['ignore', out, 'pipe'],
                encoding: 'utf8',
            });
        } finally {
            closeSync(out);
        }
        if (diffRun.error) throw diffRun.error;
        if (diffRun.status !== 0) {
            throw new Error(
                `git diff failed (exit ${diffRun.status}): ${(diffRun.stderr || '').trim() || 'no stderr'}`,
            );
        }
        const patchIn = openSync(patchFile, 'r');
        let patchIdRun;
        try {
            patchIdRun = hiddenSpawnSync(GIT, ['patch-id', '--stable'], {
                cwd,
                stdio: [patchIn, 'pipe', 'pipe'],
                encoding: 'utf8',
                maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
            });
        } finally {
            closeSync(patchIn);
        }
        if (patchIdRun.error) throw patchIdRun.error;
        if (patchIdRun.status !== 0) {
            throw new Error(
                `git patch-id failed (exit ${patchIdRun.status}): ${(patchIdRun.stderr || '').trim() || 'no stderr'}`,
            );
        }
        // Empty stdout == empty diff, preserving the previous `if (!diff.trim()) return ''`.
        return (patchIdRun.stdout || '').trim().split(/\s+/)[0] || '';
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

export async function runMeshRefinePatchEquivalenceGate(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
): Promise<MeshRefinePatchEquivalenceSummary> {
    const startedAt = Date.now();
    try {
        const { hiddenExecFileSync } = await import('../process/hidden-spawn.js');
        const git = (args: string[]) => hiddenExecFileSync(GIT, args, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const mergeBase = git(['merge-base', baseHead, branchHead]).trim();

        // `git merge-tree --write-tree` refuses to merge gitlinks that differ
        // across base/branch even when the advance is a strict fast-forward,
        // failing with "Recursive merging with submodules currently only
        // supports trivial cases". When that happens we check whether the
        // conflict is *entirely* trivial-ff gitlinks and, if so, synthesize the
        // merged tree ourselves (base tree + branch-side gitlinks).
        let mergedTree = '';
        let mergeTreeStdout = '';
        let gitlinkTrivialFastForward: MeshRefinePatchEquivalenceSummary['gitlinkTrivialFastForward'];
        try {
            mergeTreeStdout = git(['merge-tree', '--write-tree', baseHead, branchHead]);
            mergedTree = mergeTreeStdout.trim().split(/\s+/)[0] || '';
        } catch (mergeTreeErr: any) {
            const output = `${mergeTreeErr?.message || ''}\n${mergeTreeErr?.stdout || ''}\n${mergeTreeErr?.stderr || ''}`;
            const isSubmoduleConflict = /(submodule|160000)/i.test(output)
                || /Recursive merging with submodules/i.test(output);
            if (!isSubmoduleConflict) throw mergeTreeErr;
            const evaluation = evaluateGitlinkTrivialFastForward(repoRoot, baseHead, branchHead);
            if (!evaluation.trivial) {
                // Loud when the block is "could not judge" rather than "diverged".
                warnGitlinkFastForwardUndeterminable('patch-equivalence gate', evaluation.gitlinks);
                return {
                    status: 'failed',
                    equivalent: false,
                    baseHead,
                    branchHead,
                    mergeBase: mergeBase || undefined,
                    durationMs: Date.now() - startedAt,
                    error: mergeTreeErr?.message || String(mergeTreeErr),
                    stdout: truncateValidationOutput(mergeTreeErr?.stdout),
                    stderr: truncateValidationOutput(mergeTreeErr?.stderr),
                    gitlinkTrivialFastForward: { resolved: false, gitlinks: evaluation.gitlinks, reason: evaluation.reason },
                    actionableHint: buildPatchEquivalenceSubmoduleConflictHint(repoRoot, baseHead, branchHead, output),
                };
            }
            // All conflicting gitlinks fast-forward and nothing else conflicts:
            // synthesize the merge result as base's tree with branch-side gitlinks.
            mergedTree = synthesizeTrivialFastForwardMergeTree(repoRoot, baseHead, branchHead, evaluation.gitlinks) || '';
            gitlinkTrivialFastForward = { resolved: true, gitlinks: evaluation.gitlinks };
        }

        if (!mergeBase || !mergedTree) {
            return {
                status: 'failed',
                equivalent: false,
                baseHead,
                branchHead,
                mergeBase: mergeBase || undefined,
                mergedTree: mergedTree || undefined,
                durationMs: Date.now() - startedAt,
                error: 'patch equivalence preflight could not resolve merge-base or synthetic merge tree',
                stdout: truncateValidationOutput(mergeTreeStdout),
                gitlinkTrivialFastForward,
            };
        }
        // Exclude *proven fast-forward* gitlink paths from BOTH patch-ids. When
        // base has advanced a submodule pointer (a sibling merged into main ahead
        // of us) the gitlink hunk's old-value differs between the expected diff
        // (mergeBase→branch, showing the full base→branch advance) and the actual
        // diff (base→merged, showing only the shorter advanced-base→branch
        // advance). That mismatch would spuriously fail equivalence even though
        // advancing the pointer to the branch side is a provably safe
        // fast-forward — this is the root cause of the diverged-base
        // patch_equivalence_failed misjudgment.
        //
        // We exclude ONLY gitlinks whose base-side commit is an ancestor of the
        // branch-side commit (a strict ff, both objects available locally). A
        // non-ff or ambiguous gitlink (a genuine submodule divergence, or objects
        // not fetched locally) is deliberately left in the diff so its differing
        // hunk still drives the comparison — this preserves the original behavior
        // and prevents a false pass on a real divergence.
        const ffGitlinkExcludePaths = collectFastForwardGitlinkPaths(repoRoot, baseHead, branchHead);
        const expectedPatchId = await computeGitPatchId(repoRoot, mergeBase, branchHead, ffGitlinkExcludePaths);
        const actualPatchId = await computeGitPatchId(repoRoot, baseHead, mergedTree, ffGitlinkExcludePaths);
        const equivalent = expectedPatchId === actualPatchId;
        return {
            status: equivalent ? 'passed' : 'failed',
            equivalent,
            baseHead,
            branchHead,
            mergeBase,
            mergedTree,
            expectedPatchId,
            actualPatchId,
            durationMs: Date.now() - startedAt,
            gitlinkTrivialFastForward,
        };
    } catch (e: any) {
        return {
            status: 'failed',
            equivalent: false,
            baseHead,
            branchHead,
            durationMs: Date.now() - startedAt,
            error: e?.message || String(e),
            stdout: truncateValidationOutput(e?.stdout),
            stderr: truncateValidationOutput(e?.stderr),
            actionableHint: buildPatchEquivalenceSubmoduleConflictHint(
                repoRoot,
                baseHead,
                branchHead,
                `${e?.message || ''}\n${e?.stdout || ''}\n${e?.stderr || ''}`,
            ),
        };
    }
}

/**
 * Machine-readable sub-classification of a `patch_equivalence_failed` (and the
 * related submodule-gitlink preflight blocks). The opaque top-level
 * `patch_equivalence_failed` code is preserved for backward compatibility; this
 * detailed reason is added ALONGSIDE it so coordinators no longer have to guess
 * WHY the preflight blocked (the 2026-07-17 hidden-spinner convergence incident:
 * the real cause was a diverged base + an unreachable submodule gitlink artifact,
 * not a real patch conflict, but Refinery only returned the opaque code and the
 * coordinator mis-attributed it to a stale daemon version).
 */
export type MeshRefinePatchEquivalenceDetailedReasonCode =
    /** Worktree base diverged from target base (HEAD is not a descendant of origin/main). */
    | 'base_divergence'
    /**
     * ★Base ancestry COULD NOT BE JUDGED (the target base ref and/or the branch head
     * does not resolve in the classified repo). Distinct from `base_divergence`, which
     * asserts HEAD genuinely does not descend the base. Still blocks — but the remedy is
     * "make the probe answerable" (fetch/verify the refs), NOT "rebase". The root-repo
     * twin of `submodule_reachability_undeterminable`.
     */
    | 'base_ancestry_undeterminable'
    /** Submodule gitlink commit is not reachable from the submodule's remote main branch (publish needed). */
    | 'submodule_unreachable'
    /**
     * ★Submodule reachability COULD NOT BE JUDGED (missing object / missing origin/main
     * in the probed repo). Distinct from `submodule_unreachable`, which asserts the commit
     * is genuinely unpublished. Still blocks — but "make the probe answerable", not "publish".
     */
    | 'submodule_reachability_undeterminable'
    /** Genuine non-equivalent content: expected tree vs actual merge diff differ. */
    | 'actual_patch_diff'
    /** Submodule gitlink trivial fast-forward mis-judged as non-equivalent (HEAD descends origin/main, patch-id equal, blocked only by the gitlink). */
    | 'trivial_ff_misjudgment'
    /** Already identical to origin/main (ahead 0 / behind 0, no diff) — should be treated as success/no-op. */
    | 'already_converged'
    /** Fallback when the classifier itself could not run (git error); keep the opaque code, note the reason. */
    | 'unclassified';

export type MeshRefinePatchEquivalenceFailureClassification = {
    detailedReason: MeshRefinePatchEquivalenceDetailedReasonCode;
    /** Human-readable one-line description of the sub-cause. */
    detailedReasonDescription: string;
    /** Suggested next action for the coordinator/owner (free-form, actionable). */
    recommendedAction: string;
    /** Structured supporting evidence: SHAs, ahead/behind, submodule reachability, patch-id comparison, diff stat. */
    evidence: {
        baseHead?: string;
        branchHead?: string;
        mergeBase?: string;
        /** How many commits base (origin/main) is ahead of the branch's merge-base (branch is behind). */
        behind?: number;
        /** How many commits the branch is ahead of the merge-base. */
        ahead?: number;
        /**
         * True when HEAD is NOT a descendant of the target base (diverged).
         * ★`false`/`true` ONLY when both operands resolved and git actually
         * answered. OMITTED when the ancestry probe was unanswerable — see
         * `baseAncestryUndeterminable`. Never read "absent" as "not diverged".
         */
        baseDiverged?: boolean;
        /**
         * ★Set when the base-ancestry probe could not be answered at all (the
         * base ref or branch head does not resolve in the classified repo). The
         * root-repo twin of `submoduleReachabilityUndeterminable`: "we could not
         * judge", NOT "the branch diverged" — the remedy is to make the operands
         * resolvable, not to rebase.
         */
        baseAncestryUndeterminable?: boolean;
        expectedPatchId?: string;
        actualPatchId?: string;
        patchIdEqual?: boolean;
        /** Compact one-line diff stat summary of the residual/actual merge diff (best-effort). */
        diffStat?: string;
        /** Per-submodule gitlink reachability against submodule origin/main (best-effort). */
        submoduleGitlinks?: Array<{
            path: string;
            baseCommit?: string;
            branchCommit?: string;
            /** branchCommit descends baseCommit (strict ff). Omitted when unanswerable — see `undeterminable`. */
            fastForward?: boolean;
            /**
             * branchCommit is reachable from the submodule's local origin/main. `false`
             * ONLY when both operands resolved and git answered "no"; omitted when the
             * probe was unanswerable — see `undeterminable`.
             */
            reachableFromOriginMain?: boolean;
            /**
             * ★Which probes could not be judged (missing object / missing origin/main /
             * unreadable submodule path). A listed probe has its boolean OMITTED rather
             * than set to false, so "could not tell" is never misread as "proven unpublished".
             */
            undeterminable?: Array<'fastForward' | 'reachableFromOriginMain'>;
            /** The repo the reachability probes actually ran in (worktree submodule checkout). */
            probedRepo?: string;
        }>;
        /**
         * ★Set when at least one submodule reachability probe was undeterminable.
         * Surfaced on the evidence root so the coordinator sees "we could not judge"
         * without walking the per-gitlink array.
         */
        submoduleReachabilityUndeterminable?: boolean;
        /** Effective auto-publish-submodule-main-commits policy value at classification time. */
        autoPublishSubmoduleMainCommits?: boolean;
        /** Set when the classifier itself errored (detailedReason === 'unclassified'). */
        classifierError?: string;
    };
};

/**
 * Classify WHY a patch-equivalence preflight blocked, turning the opaque
 * `patch_equivalence_failed` code into a machine-readable {@link
 * MeshRefinePatchEquivalenceDetailedReasonCode} plus a recommended action and
 * structured evidence. Read-only: runs only `git` inspection commands (rev-list,
 * merge-base, diff --stat, submodule reachability probes) against the already-set
 * worktree — it never mutates the repo.
 *
 * Priority of classification (first match wins):
 *   1. already_converged     — ahead 0 & behind 0 & no residual diff
 *   2. submodule_unreachable  — a changed gitlink commit is PROVABLY not reachable
 *                               from the submodule's origin/main (publish needed)
 *   3. submodule_reachability_undeterminable — the reachability probe could not be
 *                               answered at all (missing object / missing origin/main)
 *   4. trivial_ff_misjudgment — HEAD descends origin/main AND (excl. gitlinks) the
 *                               patch-ids match — blocked only by a ff gitlink
 *   5. base_divergence        — HEAD is not a descendant of the target base
 *   6. actual_patch_diff      — genuine content divergence (the residual case)
 *
 * `targetBaseRef` is the ref the branch is meant to land on (e.g. 'origin/main'
 * or the pinned baseHead SHA). `autoPublishSubmoduleMainCommits` is threaded in so
 * the submodule_unreachable recommendation can name the current policy value.
 *
 * ★`worktreeRoot` — the refine node's WORKTREE. Root history (rev-list, merge-base,
 * diff) reads from `repoRoot`, which is correct: a worktree shares its base's object
 * store, so both heads resolve there. **Submodule** probes share nothing —
 * `<repoRoot>/<path>` and `<worktreeRoot>/<path>` are separate checkouts with
 * separate object stores and remote-tracking refs. Probing the base mirror was the
 * 2026-08-22 false-block: its `origin/main` was stale and it had never fetched the
 * branch's submodule commit, so a commit already on the submodule's main was
 * reported unreachable. The gate body (`collectFastForwardGitlinkPaths` /
 * `collectTrivialFastForwardGitlinkResolutions`) has always scoped to the worktree
 * and pre-fetched via {@link ensureSubmoduleCommitLocal}; the classifier now follows
 * suit. Omitted → falls back to `repoRoot` (single-repo callers/tests).
 */
/**
 * {@link classifyPatchEquivalenceFailure} + the loud undeterminable warning, in one
 * call. Both refine call sites need exactly this pair, and forgetting the warning is
 * how "we could not judge" goes silent — so they are bound together here.
 */
export async function classifyAndWarnPatchEquivalenceFailure(
    nodeId: string,
    repoRoot: string,
    baseHead: string,
    branchHead: string,
    summary: MeshRefinePatchEquivalenceSummary,
    options: { targetBaseRef?: string; autoPublishSubmoduleMainCommits?: boolean; worktreeRoot?: string } = {},
): Promise<MeshRefinePatchEquivalenceFailureClassification> {
    const classification = await classifyPatchEquivalenceFailure(repoRoot, baseHead, branchHead, summary, options);
    warnRefineSubmoduleUndeterminable(nodeId, classification.evidence);
    return classification;
}

export async function classifyPatchEquivalenceFailure(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
    summary: MeshRefinePatchEquivalenceSummary,
    options: { targetBaseRef?: string; autoPublishSubmoduleMainCommits?: boolean; worktreeRoot?: string } = {},
): Promise<MeshRefinePatchEquivalenceFailureClassification> {
    const targetBaseRef = options.targetBaseRef || baseHead;
    const autoPublish = options.autoPublishSubmoduleMainCommits;
    const submoduleProbeRoot = options.worktreeRoot || repoRoot;
    const evidence: MeshRefinePatchEquivalenceFailureClassification['evidence'] = {
        baseHead,
        branchHead,
        mergeBase: summary.mergeBase,
        expectedPatchId: summary.expectedPatchId,
        actualPatchId: summary.actualPatchId,
        patchIdEqual: !!summary.expectedPatchId && summary.expectedPatchId === summary.actualPatchId,
        ...(autoPublish !== undefined ? { autoPublishSubmoduleMainCommits: autoPublish } : {}),
    };
    try {
        const git = (args: string[]): string => hiddenExecFileSync(GIT, args, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
            windowsHide: true,
        });
        // ahead/behind of branch vs the target base ref. left = base-only (behind),
        // right = branch-only (ahead).
        let ahead = 0;
        let behind = 0;
        try {
            const out = git(['rev-list', '--left-right', '--count', `${targetBaseRef}...${branchHead}`]).trim();
            const [left, right] = out.split(/\s+/).map(n => Number.parseInt(n, 10));
            behind = Number.isFinite(left) ? left : 0;
            ahead = Number.isFinite(right) ? right : 0;
        } catch { /* keep zeros */ }
        evidence.ahead = ahead;
        evidence.behind = behind;
        // HEAD (branchHead) diverged from the target base = base is NOT an ancestor
        // of the branch. behind>0 with the base ref not reachable from HEAD.
        //
        // ★Tri-state, for the same reason as the submodule probes: the two-state
        // predecessor here folded "not an ancestor" (exit 1) together with "the ref
        // does not resolve in this repo" (exit 128 — routine when branchHead was
        // resolved in the node workspace but classification runs in repoRoot). The
        // unanswered case then surfaced as the `base_divergence` prose claim below,
        // prescribing a REBASE for what is actually a missing-object problem —
        // wasting exactly the rebase this class of fix exists to prevent. Note the
        // ahead/behind probe above fails on the same operands and leaves 0/0, so the
        // bogus message even read "ahead 0, behind 0" while asserting divergence.
        const baseAncestry = probeGitAncestry(repoRoot, targetBaseRef, branchHead);
        const baseIsAncestor = baseAncestry === true;
        if (baseAncestry === 'undeterminable') {
            evidence.baseAncestryUndeterminable = true;
        } else {
            evidence.baseDiverged = !baseAncestry;
        }

        // Residual/actual diff stat (best-effort): what the merge would still introduce.
        let diffStat = '';
        try {
            if (summary.mergedTree) {
                diffStat = git(['diff', '--stat', baseHead, summary.mergedTree]).trim().split('\n').filter(Boolean).slice(-1)[0] || '';
            } else {
                diffStat = git(['diff', '--stat', baseHead, branchHead]).trim().split('\n').filter(Boolean).slice(-1)[0] || '';
            }
        } catch { /* diff stat is best-effort */ }
        if (diffStat) evidence.diffStat = diffStat;

        // Changed gitlink reachability against each submodule's local default branch.
        const submoduleGitlinks: NonNullable<MeshRefinePatchEquivalenceFailureClassification['evidence']['submoduleGitlinks']> = [];
        try {
            const nameStatus = git(['diff', '--name-only', '--diff-filter=d', baseHead, branchHead]).trim();
            const changedPaths = nameStatus ? nameStatus.split('\n').map(p => p.trim()).filter(Boolean) : [];
            for (const p of changedPaths) {
                // Only submodule (gitlink, mode 160000) entries.
                let baseCommit: string | undefined;
                let branchCommit: string | undefined;
                try {
                    const baseLs = git(['ls-tree', baseHead, '--', p]).trim();
                    const branchLs = git(['ls-tree', branchHead, '--', p]).trim();
                    const isGitlink = /(^|\s)160000\s/.test(baseLs) || /(^|\s)160000\s/.test(branchLs);
                    if (!isGitlink) continue;
                    baseCommit = baseLs.split(/\s+/)[2];
                    branchCommit = branchLs.split(/\s+/)[2];
                } catch { continue; }
                // Generalize the submodule's default branch (H1, mirrors the F18
                // `verifyRemoteMainContainsCommit` resolution above): on a main-default
                // submodule this resolves to 'main' and the probe target is byte-identical
                // to the prior hardcoded `refs/remotes/origin/main`.
                let gitlinkDefaultBranch: string | undefined;
                try {
                    gitlinkDefaultBranch = await resolveSubmoduleDefaultBranch({
                        submoduleRepoPath: pathResolve(submoduleProbeRoot, p),
                        superprojectWorkspace: repoRoot,
                        submodulePath: p,
                    });
                } catch { /* falls back to 'main' inside the probe */ }
                submoduleGitlinks.push(probeSubmoduleGitlinkReachability({
                    path: p, baseCommit, branchCommit, probeRoot: submoduleProbeRoot, baseRepoRoot: repoRoot,
                    defaultBranch: gitlinkDefaultBranch,
                }));
            }
        } catch { /* submodule inspection is best-effort */ }
        if (submoduleGitlinks.length) evidence.submoduleGitlinks = submoduleGitlinks;
        const undeterminableGitlinks = submoduleGitlinks.filter(g => (g.undeterminable || []).includes('reachableFromOriginMain'));
        if (undeterminableGitlinks.length > 0) evidence.submoduleReachabilityUndeterminable = true;

        // Existing gate signal: the merge-tree trivial-ff evaluation, if the gate
        // captured it (a genuine non-trivial submodule conflict lands here too).
        const gitlinkFf = summary.gitlinkTrivialFastForward;

        // ── Classification (first match wins) ────────────────────────────────
        const noResidualDiff = !evidence.diffStat && (!summary.actualPatchId || summary.actualPatchId === '');

        // 1. already_converged: nothing ahead, nothing behind, no residual diff.
        if (ahead === 0 && behind === 0 && noResidualDiff) {
            return {
                detailedReason: 'already_converged',
                detailedReasonDescription: 'Branch is already identical to the target base (ahead 0, behind 0, no residual diff); the merge would be a no-op.',
                recommendedAction: 'Treat as already converged — no merge needed. Verify with `git range-diff` / patch-id, then mark the branch merged (or clean up the worktree).',
                evidence,
            };
        }

        // 2. submodule_unreachable: a changed gitlink is PROVABLY not reachable from
        //    the submodule's origin/main. This is the publish-needed artifact, and it
        //    still blocks — `reachableFromOriginMain === false` is now only ever set
        //    when both operands resolved and git answered "no" (see probeGitAncestry).
        const unreachable = submoduleGitlinks.filter(g => g.reachableFromOriginMain === false);
        if (unreachable.length > 0) {
            const paths = unreachable.map(g => g.path).join(', ');
            return {
                detailedReason: 'submodule_unreachable',
                detailedReasonDescription: `Submodule gitlink commit(s) not reachable from submodule origin/main (publish needed): ${paths}.`,
                recommendedAction: `Publish the submodule commit(s) to submodule origin/main, then retry mesh_refine_node (policy allowAutoPublishSubmoduleMainCommits=${autoPublish === undefined ? 'unknown' : autoPublish}).`,
                evidence,
            };
        }

        // 2b. ★submodule_reachability_undeterminable: the probe could not be answered.
        //     A SEPARATE code from submodule_unreachable on purpose: "we could not judge",
        //     not "nothing to converge" and not "unpublished". Conflating them is the
        //     2026-08-22 false-block. Still blocks (never merge on an unanswered submodule
        //     question), but the action is to make the probe answerable, not to publish.
        if (undeterminableGitlinks.length > 0) {
            const refs = undeterminableGitlinks
                .map(g => `${g.path}@${(g.branchCommit || '?').slice(0, 12)} (probed: ${g.probedRepo || 'unknown'})`)
                .join(', ');
            return {
                detailedReason: 'submodule_reachability_undeterminable',
                detailedReasonDescription: `Could NOT determine whether submodule gitlink commit(s) are reachable from submodule origin/main — the probe had no answer (missing commit object and/or missing refs/remotes/origin/main in the probed repo): ${refs}. This is "undeterminable", NOT "unpublished".`,
                recommendedAction: 'Make the probe answerable, then rerun mesh_refine_node: fetch the submodule remote in the probed checkout (`git -C <probedRepo> fetch origin main`) so both the gitlink commit object and refs/remotes/origin/main exist locally. Do NOT publish/push the submodule commit on the strength of this result — reachability was never established either way.',
                evidence,
            };
        }

        // 3. trivial_ff_misjudgment: HEAD descends the target base AND the non-gitlink
        //    patch-ids are equal, so the ONLY thing blocking is a fast-forward gitlink
        //    that merge-tree refused. (Either the gate flagged an unresolved gitlink
        //    ff, or every changed gitlink is a proven ff.)
        const changedGitlinks = submoduleGitlinks.length > 0;
        const allGitlinksFf = changedGitlinks && submoduleGitlinks.every(g => g.fastForward === true);
        const gateSawUnresolvedGitlinkFf = gitlinkFf?.resolved === false && Array.isArray(gitlinkFf.gitlinks) && gitlinkFf.gitlinks.some(g => g.fastForward);
        if (baseIsAncestor && (evidence.patchIdEqual || allGitlinksFf || gateSawUnresolvedGitlinkFf)) {
            return {
                detailedReason: 'trivial_ff_misjudgment',
                detailedReasonDescription: 'HEAD descends the target base and the patch content matches; the block is a submodule gitlink trivial fast-forward that merge-tree refused, not a real divergence.',
                recommendedAction: 'Converge via the strict fast-forward-only bypass (verify HEAD descends origin/main and patch-id equality, then merge --ff-only) instead of the refine gate.',
                evidence,
            };
        }

        // 3b. base_ancestry_undeterminable: the probe had NO ANSWER, so we cannot
        //     say whether HEAD descends the base. ★This must be tested BEFORE the
        //     base_divergence branch below, which keys off `!baseIsAncestor` and
        //     would otherwise absorb the unanswered case and report it as a
        //     measured divergence — the defect this branch exists to prevent. The
        //     remedy is to make the operands resolvable, NOT to rebase.
        if (baseAncestry === 'undeterminable') {
            return {
                detailedReason: 'base_ancestry_undeterminable',
                detailedReasonDescription: `Could NOT determine whether HEAD descends ${targetBaseRef} — the ancestry probe had no answer (${targetBaseRef} and/or ${branchHead.slice(0, 12)} does not resolve in ${repoRoot}). This is "undeterminable", NOT "diverged": the ahead/behind counts above are unmeasured, not zero.`,
                recommendedAction: `Make the probe answerable before judging: fetch/verify that ${targetBaseRef} and the branch head both resolve in ${repoRoot} (e.g. git fetch origin, git rev-parse --verify), then retry mesh_refine_node. Do NOT rebase on the strength of this result — no divergence has been measured.`,
                evidence,
            };
        }

        // 4. base_divergence: HEAD is not a descendant of the target base.
        //    Reached only when the probe ANSWERED (see 3b) — this is a measured claim.
        if (!baseIsAncestor) {
            return {
                detailedReason: 'base_divergence',
                detailedReasonDescription: `Worktree base has diverged from ${targetBaseRef} (HEAD is not a descendant; ahead ${ahead}, behind ${behind}).`,
                recommendedAction: `Rebase the branch onto ${targetBaseRef}, then retry mesh_refine_node.`,
                evidence,
            };
        }

        // 5. actual_patch_diff: genuine non-equivalent content.
        return {
            detailedReason: 'actual_patch_diff',
            detailedReasonDescription: 'The merge introduces content not equivalent to the branch\'s cumulative patch (expected tree vs actual merge diff differ).',
            recommendedAction: 'Manual review required — inspect the residual diff; the branch content is not patch-equivalent to a clean merge onto the base.',
            evidence,
        };
    } catch (e: any) {
        evidence.classifierError = e?.message || String(e);
        return {
            detailedReason: 'unclassified',
            detailedReasonDescription: 'Patch-equivalence sub-cause could not be classified (git inspection failed); see classifierError.',
            recommendedAction: 'Inspect the refineStages and patchEquivalence summary manually to determine the cause.',
            evidence,
        };
    }
}

export type MeshWorktreePatchContainmentSummary = {
    /** True only when merging worktreeHead into ref introduces no new patch. */
    contained: boolean;
    ref: string;
    worktreeHead: string;
    mergeBase?: string;
    mergedTree?: string;
    /** patch-id of (ref -> synthesized merge tree); empty string when nothing new is added. */
    residualPatchId?: string;
    durationMs: number;
    /** Set when the check could not run (treated conservatively as NOT contained). */
    error?: string;
};

/**
 * Patch-equivalence containment check for the worktree force-cleanup convergence
 * guard. Answers a narrower question than {@link runMeshRefinePatchEquivalenceGate}:
 * "are the worktree branch's changes ALREADY present in `ref` (e.g. origin/main),
 * even though the worktree HEAD's commit SHA is not an ancestor of ref?"
 *
 * This is the cherry-pick / squash / rebase case: the same content landed on the
 * default ref under a different commit SHA, so `merge-base --is-ancestor` (the
 * primary cleanup guard) reports the worktree as un-converged and refuses to
 * remove it. Refinery already accepts patch-equivalent landings via merge-tree +
 * patch-id; this brings the same notion of "convergence" to the cleanup guard.
 *
 * Mechanism: synthesize the merge of `worktreeHead` into `ref` (reusing the same
 * trivial-gitlink-fast-forward handling as the refine gate) and compute the
 * patch-id of (ref -> mergedTree). If that residual diff is EMPTY, merging the
 * worktree adds nothing new on top of ref — its changes are already present there
 * and the worktree is safe to remove. A non-empty residual means the worktree
 * still carries content not in ref, so it is NOT contained and must stay blocked.
 *
 * Conservative by construction: any merge-tree / patch-id failure, a genuine
 * (non-trivial) submodule conflict, or any thrown error yields `contained: false`
 * so an exception can never widen the cleanup allow-list.
 */
export async function checkWorktreeChangesPatchEquivalentInRef(
    repoRoot: string,
    ref: string,
    worktreeHead: string,
): Promise<MeshWorktreePatchContainmentSummary> {
    const startedAt = Date.now();
    try {
        const { hiddenExecFileSync } = await import('../process/hidden-spawn.js');
        const git = (gitArgs: string[]) => hiddenExecFileSync(GIT, gitArgs, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const mergeBase = git(['merge-base', ref, worktreeHead]).trim();

        // Reuse the refine gate's trivial-gitlink-fast-forward handling: a clean
        // submodule pointer fast-forward must not block the cleanup, but a real
        // (non-ff) submodule divergence must keep it blocked.
        let mergedTree = '';
        try {
            mergedTree = git(['merge-tree', '--write-tree', ref, worktreeHead]).trim().split(/\s+/)[0] || '';
        } catch (mergeTreeErr: any) {
            const output = `${mergeTreeErr?.message || ''}\n${mergeTreeErr?.stdout || ''}\n${mergeTreeErr?.stderr || ''}`;
            const isSubmoduleConflict = /(submodule|160000)/i.test(output)
                || /Recursive merging with submodules/i.test(output);
            if (!isSubmoduleConflict) throw mergeTreeErr;
            const evaluation = evaluateGitlinkTrivialFastForward(repoRoot, ref, worktreeHead);
            if (!evaluation.trivial) {
                // A genuine submodule divergence (or unfetched objects): we cannot
                // prove containment, so block conservatively. The reason string now
                // says which of the two it was; make the unanswerable case loud.
                warnGitlinkFastForwardUndeterminable(`containment check for ${ref}`, evaluation.gitlinks);
                return {
                    contained: false,
                    ref,
                    worktreeHead,
                    mergeBase: mergeBase || undefined,
                    durationMs: Date.now() - startedAt,
                    error: `merge-tree submodule conflict is not a trivial fast-forward: ${evaluation.reason || 'unknown'}`,
                };
            }
            mergedTree = synthesizeTrivialFastForwardMergeTree(repoRoot, ref, worktreeHead, evaluation.gitlinks) || '';
        }

        if (!mergedTree) {
            return {
                contained: false,
                ref,
                worktreeHead,
                mergeBase: mergeBase || undefined,
                durationMs: Date.now() - startedAt,
                error: 'could not resolve synthetic merge tree for containment check',
            };
        }

        // Exclude proven fast-forward gitlinks from the residual diff for the same
        // reason the refine gate does: advancing a submodule pointer to a strict
        // descendant is a safe fast-forward and must not count as "new content".
        const ffGitlinkExcludePaths = collectFastForwardGitlinkPaths(repoRoot, ref, worktreeHead);
        const residualPatchId = await computeGitPatchId(repoRoot, ref, mergedTree, ffGitlinkExcludePaths);
        const contained = residualPatchId === '';
        return {
            contained,
            ref,
            worktreeHead,
            mergeBase: mergeBase || undefined,
            mergedTree,
            residualPatchId,
            durationMs: Date.now() - startedAt,
        };
    } catch (e: any) {
        return {
            contained: false,
            ref,
            worktreeHead,
            durationMs: Date.now() - startedAt,
            error: e?.message || String(e),
        };
    }
}

/**
 * No-op guard: detect a "silent no-op" merge before the Refinery merge runs.
 *
 * A silent no-op occurs when the refine target branch's ROOT tree is byte-identical
 * to the merge base (origin/main). This is the trap where a submodule (e.g. oss) has
 * real commits but the root branch never committed the gitlink (oss-pointer) bump, so
 * the root diff Refinery would merge is empty. Merging that produces a merge commit with
 * no content change — reported as "success" while the actual work never reaches main.
 *
 * A committed gitlink bump (the legitimate oss-pointer bump) DOES show up in the root
 * tree diff (as a 160000-mode entry), so this guard does NOT block legitimate refines —
 * it only fires when the root tree diff vs base is COMPLETELY empty.
 *
 * Runs after the patch-equivalence gate; the "already merged via other path" case
 * (branch has real changes already present in base) is handled upstream and never
 * reaches here, so an empty root diff at this point is genuinely a no-op.
 */
export async function runMeshRefineEffectiveDiffGate(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
): Promise<MeshRefineEffectiveDiffSummary> {
    const startedAt = Date.now();
    try {
        const { hiddenExecFileSync } = await import('../process/hidden-spawn.js');
        const git = (args: string[], opts?: { cwd?: string }) => hiddenExecFileSync(GIT, args, {
            cwd: opts?.cwd || repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        // Root tree diff between base and branch. --raw surfaces gitlink (160000) entries,
        // so a committed submodule-pointer bump counts as an effective change. An empty
        // result means the branch's root tree is identical to base → nothing would merge.
        const rawDiff = git(['diff', '--raw', baseHead, branchHead]).trim();
        if (rawDiff) {
            const changedPaths = rawDiff
                .split('\n')
                .map(line => line.split('\t').slice(1).join('\t').trim())
                .filter(Boolean)
                .slice(0, 50);
            return {
                status: 'passed',
                hasEffectiveDiff: true,
                baseHead,
                branchHead,
                changedPaths,
                durationMs: Date.now() - startedAt,
            };
        }

        // No root diff → silent no-op. Try to surface which submodule(s) have commits that
        // were never captured by a committed gitlink bump, to make the message actionable.
        const submoduleHints: Array<{ path: string; reason: string }> = [];
        try {
            // `git submodule status` flags submodules whose checked-out commit differs from
            // the recorded gitlink with a leading '+'. That difference is exactly the
            // uncommitted-pointer-bump situation this guard exists to catch.
            const status = git(['submodule', 'status']);
            for (const line of status.split('\n')) {
                const trimmed = line.trimEnd();
                if (!trimmed) continue;
                if (trimmed.startsWith('+')) {
                    const parts = trimmed.slice(1).trim().split(/\s+/);
                    const path = parts[1] || parts[0] || '(unknown)';
                    submoduleHints.push({
                        path,
                        reason: 'submodule checked-out commit differs from the committed gitlink (pointer bump not committed on the root branch)',
                    });
                }
            }
        } catch { /* submodule status is best-effort */ }

        return {
            status: 'failed',
            hasEffectiveDiff: false,
            baseHead,
            branchHead,
            ...(submoduleHints.length ? { submoduleHints } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (e: any) {
        // On error, do NOT block the merge — fail open so a probe failure can't wedge refine.
        return {
            status: 'skipped',
            hasEffectiveDiff: true,
            baseHead,
            branchHead,
            durationMs: Date.now() - startedAt,
            error: e?.message || String(e),
            stdout: truncateValidationOutput(e?.stdout),
            stderr: truncateValidationOutput(e?.stderr),
        };
    }
}

function buildPatchEquivalenceSubmoduleConflictHint(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
    output: string,
): MeshRefineSubmoduleConflictHint | undefined {
    if (!/(submodule|160000)/i.test(output) || !/(conflict|failed to merge)/i.test(output)) return undefined;
    const conflicts = readChangedGitlinkPaths(repoRoot, baseHead, branchHead)
        .map(path => ({
            path,
            baseCommit: readTreeObject(repoRoot, baseHead, path),
            branchCommit: readTreeObject(repoRoot, branchHead, path),
        }));
    if (conflicts.length === 0) return undefined;
    return {
        kind: 'submodule_conflict',
        message: 'Refinery could not synthesize a safe merge tree because the branch and base point the same submodule path at different commits.',
        conflicts,
        nextSteps: [
            'Inspect the listed submodule path in both base and branch: baseCommit is the commit currently recorded by the base workspace, branchCommit is the commit recorded by the worktree branch.',
            'Resolve the submodule first by checking out or creating the intended submodule commit, then commit the chosen gitlink in the root branch.',
            'Ensure the chosen submodule commit is reachable from the configured submodule remote main branch, then rerun mesh_refine_node.',
        ],
    };
}
