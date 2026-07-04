/**
 * Mesh refine validation gates & gitlink fast-forward evaluation
 *
 * Extracted from commands/router.ts (behavior-preserving move). Contains:
 *   - the MeshCoordinator config-format type
 *   - refine validation / patch-equivalence / effective-diff / submodule
 *     reachability gates and their summary types + job handles
 *   - gitlink trivial-fast-forward evaluation and submodule alignment helpers
 *
 * router.ts re-exports every public symbol from here so existing import paths
 * keep working. `CommandRouterResult` is imported type-only from router.ts
 * (erased at compile time — no runtime import cycle).
 */

import { getGitRepoStatus } from '../git/git-status.js';
import * as yaml from 'js-yaml';
import { loadMeshRefineConfig, resolveMeshRefineValidationPlan } from '../mesh/refine-config.js';
import type { MeshRefineValidationCommandPlan } from '../mesh/refine-config.js';
import { evaluateWorktreeBootstrapState, loadMeshWorktreeBootstrapConfig, runMeshWorktreeBootstrap, resolveSubmoduleDefaultBranch } from '../mesh/worktree-bootstrap-config.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { basename as pathBasename, join as pathJoin, resolve as pathResolve } from 'path';
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import { resolveWin32Executable, buildWin32ExecFileSpawn } from '../cli-adapters/resolve-executable.js';
import type { CommandRouterResult } from '../commands/router.js';

// Fix (4): resolve the git executable to an absolute path once on win32. A bare `git` handed to
// execFile(Sync)/execFileAsync is resolved by libuv's spawn search, which appends only .com/.exe
// (no PATHEXT) over the inherited PATH — so a `git.cmd`/`git.exe` that `where` finds is missed and
// the spawn ENOENTs (the live win32 refine/batch failure). resolveWin32Executable is the same helper
// the validation/bootstrap spawn path already uses. No-op on non-win32 (returns 'git' verbatim), and
// no shell:true is used anywhere here so there is no quoting risk.
const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git';

export type MeshCoordinatorConfigFormat = 'claude_mcp_json' | 'hermes_config_yaml';
type MeshRefineValidationStatus = 'passed' | 'failed' | 'skipped';
type MeshRefineValidationCommand = MeshRefineValidationCommandPlan;

type MeshRefineValidationSummary = {
    status: MeshRefineValidationStatus;
    required: true;
    commandsRun: Array<Record<string, unknown>>;
    bootstrapCommandsRun: Array<Record<string, unknown>>;
    rejectedCommands: Array<Record<string, unknown>>;
    skippedReason?: string;
    failureKind?: string;
    failureCode?: string;
    /** Human-readable cause when failureKind === 'spawn_resolution_failed' (win32 .cmd shim, etc). */
    spawnResolutionError?: string;
    timeoutMs: number;
    outputLimitBytes: number;
    configSource?: string;
    configSourceType?: string;
    suggestions?: unknown[];
    suggestedConfig?: unknown;
    /**
     * M2-3: the bootstrap stage recorded separately from validation so review
     * surfaces can distinguish environment failures from validation failures.
     *   cached — worktree_bootstrap was 'ready' (staleInputs unchanged), skipped
     *   ran    — worktree_bootstrap was stale/never-ran and re-ran successfully
     *   failed — bootstrap run failed (refine stops before validation)
     *   skipped — refine config validation.bootstrap === 'skip'
     *   legacy — deprecated validation.bootstrapCommands path was used
     *   not_configured — no bootstrap definition anywhere
     */
    bootstrap?: {
        stage: 'cached' | 'ran' | 'failed' | 'skipped' | 'legacy' | 'not_configured';
        status?: string;
        skipped?: boolean;
        configSource?: string;
        staleReason?: string;
        error?: string;
        commandsRun?: Array<Record<string, unknown>>;
    };
    /** M2-2: deprecation notices from the refine config (e.g. bootstrapCommands). */
    deprecationWarnings?: string[];
};

type MeshRefineStageStatus = 'passed' | 'failed' | 'skipped';

type MeshRefinePatchEquivalenceSummary = {
    status: MeshRefineStageStatus;
    equivalent: boolean;
    baseHead: string;
    branchHead: string;
    mergeBase?: string;
    mergedTree?: string;
    expectedPatchId?: string;
    actualPatchId?: string;
    durationMs: number;
    error?: string;
    stdout?: string;
    stderr?: string;
    actionableHint?: MeshRefineSubmoduleConflictHint;
    /**
     * Set when a `merge-tree` submodule conflict was reclassified as a trivial
     * gitlink fast-forward and the gate passed via a synthesized merge tree.
     */
    gitlinkTrivialFastForward?: {
        resolved: boolean;
        gitlinks: Array<{ path: string; baseCommit?: string; branchCommit?: string; fastForward: boolean }>;
        reason?: string;
    };
};

type MeshRefineEffectiveDiffSummary = {
    status: MeshRefineStageStatus;
    /** True when there is at least one root-tree change between base and branch (incl. gitlink bumps). */
    hasEffectiveDiff: boolean;
    baseHead: string;
    branchHead: string;
    /** Root-level paths that differ between base and branch (capped). */
    changedPaths?: string[];
    /** Submodule paths with uncommitted/divergent commits but NO committed gitlink bump in the root tree. */
    submoduleHints?: Array<{ path: string; reason: string }>;
    durationMs: number;
    error?: string;
    stdout?: string;
    stderr?: string;
};

type MeshRefineSubmoduleConflictHint = {
    kind: 'submodule_conflict';
    message: string;
    conflicts: Array<{
        path: string;
        baseCommit?: string;
        branchCommit?: string;
    }>;
    nextSteps: string[];
};

type MeshRefineSubmoduleAlignmentSummary = {
    status: 'passed' | 'failed' | 'skipped';
    changedGitlinkPaths: string[];
    outOfSyncPaths: string[];
    updatedPaths: string[];
    verifiedPaths: string[];
    durationMs: number;
    reason?: string;
    command?: string;
    error?: string;
    stdout?: string;
    stderr?: string;
};

type MeshRefineSubmoduleReachabilityEntry = {
    path: string;
    commit: string;
    reachable: boolean;
    publishRequired?: boolean;
    autoPublishAllowed?: boolean;
    autoPublishAttempted?: boolean;
    autoPublishSucceeded?: boolean;
    autoPublishVerified?: boolean;
    autoPublishRefspec?: string;
    autoPublishSkippedReason?: string;
    importedFromWorktree?: boolean;
    checkedLocal?: boolean;
    localReachable?: boolean;
    remote?: string;
    remoteUrl?: string;
    remoteReachable?: boolean;
    remoteMainBranch?: string;
    remoteMainReachable?: boolean;
    fetchedFromOrigin?: boolean;
    error?: string;
    publishStdout?: string;
    publishStderr?: string;
};

type MeshRefineSubmoduleReachabilitySummary = {
    status: MeshRefineStageStatus;
    checked: number;
    unreachable: MeshRefineSubmoduleReachabilityEntry[];
    entries: MeshRefineSubmoduleReachabilityEntry[];
    durationMs: number;
    autoPublishAllowed?: boolean;
    autoPublishPolicySource?: string;
    error?: string;
};

export type MeshRefineAsyncJobStatus = 'accepted' | 'completed' | 'failed';

export type MeshRefineJobHandle = {
    success: true;
    async: true;
    status: MeshRefineAsyncJobStatus;
    jobId: string;
    interactionId: string;
    meshId: string;
    nodeId: string;
    targetNodeId: string;
    targetDaemonId?: string;
    workspace?: string;
    startedAt: string;
    completedAt?: string;
    duplicate?: boolean;
    retryOfJobId?: string;
    /**
     * The coordinator daemon ID that initiated this refine job.
     * When set, events for this job are scoped to that coordinator's
     * pending-events queue instead of the shared broadcast queue.
     */
    targetCoordinatorDaemonId?: string;
    eventDelivery: {
        pendingEvents: true;
        ledger: true;
    };
    evidence: {
        pendingEventsCommand: 'get_pending_mesh_events';
        ledgerCommand: 'get_mesh_ledger_slice';
        taskHistoryKind: 'task_dispatched' | 'task_completed' | 'task_failed';
    };
};

export type MeshRefineTerminalJob = MeshRefineJobHandle & { result?: Record<string, unknown> };

export type MeshRefineBatchJobStatus = 'accepted' | 'completed' | 'failed';

/**
 * Async handle returned by the batch Refinery the instant a convergence run is
 * accepted. Mirrors {@link MeshRefineJobHandle} (async:true / status:'accepted' +
 * terminal pending-event + ledger delivery) but scopes a whole batch of sibling
 * nodes rather than a single node. The synthetic `batchLabel` is used as the
 * `nodeLabel` for the shared refine event/message renderer.
 */
export type MeshRefineBatchJobHandle = {
    success: true;
    async: true;
    batch: true;
    status: MeshRefineBatchJobStatus;
    jobId: string;
    interactionId: string;
    meshId: string;
    batchLabel: string;
    nodeIds: string[];
    nodeCount: number;
    order: string[];
    startedAt: string;
    completedAt?: string;
    duplicate?: boolean;
    targetCoordinatorDaemonId?: string;
    eventDelivery: {
        pendingEvents: true;
        ledger: true;
    };
    evidence: {
        pendingEventsCommand: 'get_pending_mesh_events';
        ledgerCommand: 'get_mesh_ledger_slice';
        taskHistoryKind: 'task_dispatched' | 'task_completed' | 'task_failed';
    };
};

export type MeshRefineBatchTerminalJob = MeshRefineBatchJobHandle & { result?: Record<string, unknown> };

const REFINE_VALIDATION_CATEGORIES = ['typecheck', 'test', 'lint', 'build'] as const;
const REFINE_VALIDATION_TIMEOUT_MS = 120_000;
const REFINE_VALIDATION_OUTPUT_LIMIT_BYTES = 128 * 1024;
const REFINE_VALIDATION_SUMMARY_CHARS = 2_000;
const REFINE_VALIDATION_MAX_COMMANDS = 4;
const REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

export function truncateValidationOutput(value: unknown): string {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    if (text.length <= REFINE_VALIDATION_SUMMARY_CHARS) return text;
    return `${text.slice(0, REFINE_VALIDATION_SUMMARY_CHARS)}\n[truncated ${text.length - REFINE_VALIDATION_SUMMARY_CHARS} chars]`;
}

/**
 * A spawn-resolution failure is when the executable itself could not be found by
 * the OS spawn boundary — `spawn <cmd> ENOENT` — as opposed to the command
 * running and exiting non-zero. On win32 this is the .cmd-shim case: libuv's
 * spawn search appends only .com/.exe, so a bare `npm`/`npx`/`tsc` (which are
 * .cmd shims) ENOENTs even though it is installed. It carries no stderr, so it
 * must be detected by error.code/syscall, not by string-matching output.
 */
export function isSpawnResolutionError(error: any): boolean {
    if (!error) return false;
    if (error.code === 'ENOENT' && typeof error.syscall === 'string' && error.syscall.startsWith('spawn')) return true;
    // Fall back to code alone: execFile sets syscall on the spawn boundary error,
    // but guard for environments/mocks that only surface the code.
    return error.code === 'ENOENT' && (error.syscall === undefined || String(error.syscall).startsWith('spawn'));
}

export function describeSpawnError(error: any, command: string, spawnResolutionFailed: boolean): string {
    if (spawnResolutionFailed) {
        const hint = process.platform === 'win32'
            ? ' On Windows, npm-family commands (npm/npx/tsc/vitest) are .cmd shims that the bare-command spawn search does not resolve; configure an absolute path or ensure the command is on PATH.'
            : '';
        return `Could not resolve executable "${command}" (spawn ENOENT).${hint}`;
    }
    return String(error?.message || error);
}

export function recordMeshRefineStage(
    stages: Array<Record<string, unknown>>,
    stage: string,
    status: MeshRefineStageStatus,
    startedAt: number,
    details?: Record<string, unknown>,
): void {
    stages.push({
        stage,
        status,
        durationMs: Date.now() - startedAt,
        ...(details || {}),
    });
}

export function buildSubmodulePublishRequiredNextStep(entries: MeshRefineSubmoduleReachabilityEntry[]): string {
    const refs = entries
        .map(entry => `${entry.path}@${entry.commit}`)
        .join(', ');
    return `Ask the user for explicit approval to push/publish the unreachable submodule commit(s) (${refs}) to the configured submodule remote main branch, then rerun mesh_refine_node. Do not merge the root branch until every submodule gitlink commit is reachable from submodule origin/main.`;
}

/**
 * Async git exec helper used across the synchronous-refine stage pipeline. Bound
 * once in the orchestrator and threaded through RefineContext so every stage runs
 * git the same way (execFile + promisify, utf8). Returns the child's stdout/stderr.
 */
export type RefineExecFileAsync = (file: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => Promise<{ stdout: string; stderr: string }>;

/**
 * Accumulated state shared by the synchronous-refine stages. The orchestrator
 * (executeMeshRefineNodeSynchronously) seeds this in the resolve_refs stage and
 * each later stage reads / extends it. `branchHead` and `patchEquivalence` are the
 * only fields a stage mutates after creation (auto-rebase updates both), so they
 * are carried on the mutable context rather than re-threaded through return types.
 */
export interface RefineContext {
    meshId: string;
    nodeId: string;
    args: any;
    refineStages: Array<Record<string, unknown>>;
    execFileAsync: RefineExecFileAsync;
    mesh: any;
    node: any;
    sourceNode: any;
    repoRoot: string;
    branch: string;
    baseBranch: string;
    baseHead: string;
    branchHead: string;
    validationSummary: Awaited<ReturnType<typeof runMeshRefineValidationGate>>;
    patchEquivalence: Awaited<ReturnType<typeof runMeshRefinePatchEquivalenceGate>>;
    submoduleReachability: Awaited<ReturnType<typeof runMeshRefineSubmoduleReachabilityGate>>;
}

/**
 * Stage outcome for the synchronous-refine pipeline. A stage either produces a
 * terminal CommandRouterResult (an early-exit gate failure, or a successful
 * already-merged short-circuit), in which case the orchestrator returns it
 * immediately, or it returns `continue` with the (possibly extended) context for
 * the next stage. This makes the orchestrator a flat sequence of stage calls
 * while preserving the original body's exact early-return control flow.
 */
export type RefineStageOutcome =
    | { kind: 'terminal'; result: CommandRouterResult }
    | { kind: 'continue'; ctx: RefineContext };

export function resolveRefineryAutoPublishSubmoduleMainCommits(mesh: any, workspace: string): { enabled: boolean; source?: string } {
    if (mesh?.policy?.allowAutoPublishSubmoduleMainCommits === true) {
        process.stderr.write(
            `[adhdev-mesh] WARNING: allowAutoPublishSubmoduleMainCommits is ENABLED via mesh.policy. `
            + `Refinery may push unreachable submodule commits to submodule origin/main without additional user approval.\n`,
        );
        return { enabled: true, source: 'mesh.policy.allowAutoPublishSubmoduleMainCommits' };
    }
    const loaded = loadMeshRefineConfig(mesh, workspace);
    if (loaded.config?.allowAutoPublishSubmoduleMainCommits === true) {
        process.stderr.write(
            `[adhdev-mesh] WARNING: allowAutoPublishSubmoduleMainCommits is ENABLED via ${loaded.path || loaded.source}. `
            + `Refinery may push unreachable submodule commits to submodule origin/main without additional user approval.\n`,
        );
        return { enabled: true, source: loaded.path || loaded.source };
    }
    return { enabled: false };
}

async function computeGitPatchId(
    cwd: string,
    fromRef: string,
    toRef: string,
    excludePaths: string[] = [],
): Promise<string> {
    const { execFileSync } = await import('node:child_process');
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
    const diff = execFileSync(GIT, diffArgs, {
        cwd,
        encoding: 'utf8',
        maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
    });
    if (!diff.trim()) return '';
    const patchId = execFileSync(GIT, ['patch-id', '--stable'], {
        cwd,
        input: diff,
        encoding: 'utf8',
        maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
    }).trim();
    return patchId.split(/\s+/)[0] || '';
}

export async function runMeshRefinePatchEquivalenceGate(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
): Promise<MeshRefinePatchEquivalenceSummary> {
    const startedAt = Date.now();
    try {
        const { execFileSync } = await import('node:child_process');
        const git = (args: string[]) => execFileSync(GIT, args, {
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
        const { execFileSync } = await import('node:child_process');
        const git = (gitArgs: string[]) => execFileSync(GIT, gitArgs, {
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
                // prove containment, so block conservatively.
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
        const { execFileSync } = await import('node:child_process');
        const git = (args: string[], opts?: { cwd?: string }) => execFileSync(GIT, args, {
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

function readChangedGitlinkPaths(repoRoot: string, fromRef: string, toRef: string): string[] {
    try {
        const output = execFileSync(GIT, ['diff', '--raw', '--no-abbrev', fromRef, toRef], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const paths = new Set<string>();
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            const metaAndPath = line.split('\t');
            const meta = metaAndPath[0] || '';
            const path = metaAndPath[metaAndPath.length - 1]?.trim();
            if (!path) continue;
            const parts = meta.split(/\s+/);
            if (parts[0]?.includes('160000') || parts[1]?.includes('160000')) {
                paths.add(path);
            }
        }
        return [...paths].sort();
    } catch {
        return [];
    }
}

function readTreeObject(repoRoot: string, ref: string, path: string): string | undefined {
    try {
        const output = execFileSync(GIT, ['ls-tree', ref, '--', path], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        }).trim();
        const match = output.match(/\bcommit\s+([0-9a-f]{40})\b/i);
        return match?.[1];
    } catch {
        return undefined;
    }
}

/**
 * Resolve the absolute path to the repo's real git directory. In a linked
 * worktree, `.git` is a file pointing elsewhere, so we cannot assume a `.git`
 * subdirectory exists — a temporary index file must live in the actual git dir.
 */
function resolveGitDir(repoRoot: string): string {
    const out = execFileSync(GIT, ['rev-parse', '--absolute-git-dir'], {
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
type GitlinkTrivialFastForwardEvaluation = {
    /** True only when the merge-tree conflict is *fully* explained by trivial-ff gitlinks. */
    trivial: boolean;
    /** Why the evaluation declined to treat the conflict as trivial (set when trivial=false). */
    reason?: string;
    /** Per-path detail for the changed gitlinks that were inspected. */
    gitlinks: Array<{
        path: string;
        baseCommit?: string;
        branchCommit?: string;
        fastForward: boolean;
    }>;
};

/**
 * Check, inside a submodule repo, whether `baseCommit` is an ancestor of
 * `branchCommit` (i.e. advancing the gitlink from base→branch is a pure
 * fast-forward). Returns false on any error or when either commit is missing
 * locally — safety first, ambiguity stays "not a fast-forward".
 */
function isSubmoduleFastForward(submoduleRepoPath: string, baseCommit: string, branchCommit: string): boolean {
    if (!baseCommit || !branchCommit) return false;
    if (baseCommit === branchCommit) return true;
    try {
        if (!fs.existsSync(submoduleRepoPath)) return false;
        // Both commits must exist locally for the ancestry check to be meaningful.
        execFileSync(GIT, ['cat-file', '-e', `${baseCommit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
        execFileSync(GIT, ['cat-file', '-e', `${branchCommit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
        // exit 0 ⇒ baseCommit is an ancestor of branchCommit ⇒ branch fast-forwards base.
        execFileSync(GIT, ['merge-base', '--is-ancestor', baseCommit, branchCommit], { cwd: submoduleRepoPath, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Read the set of paths that differ between two refs, tagging whether each is a
 * gitlink (submodule, mode 160000) on either side. Returns one entry per
 * changed path. Empty on error.
 */
function readChangedPathKinds(repoRoot: string, fromRef: string, toRef: string): Array<{ path: string; isGitlink: boolean }> {
    try {
        const output = execFileSync(GIT, ['diff', '--raw', '--no-abbrev', fromRef, toRef], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const result: Array<{ path: string; isGitlink: boolean }> = [];
        const seen = new Set<string>();
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            const metaAndPath = line.split('\t');
            const meta = metaAndPath[0] || '';
            const path = metaAndPath[metaAndPath.length - 1]?.trim();
            if (!path || seen.has(path)) continue;
            seen.add(path);
            const parts = meta.split(/\s+/);
            const isGitlink = !!(parts[0]?.includes('160000') || parts[1]?.includes('160000'));
            result.push({ path, isGitlink });
        }
        return result;
    } catch {
        return [];
    }
}

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
        const fastForward = !!baseCommit && !!branchCommit
            && isSubmoduleFastForward(submoduleRepoPath, baseCommit, branchCommit);
        return { path, baseCommit, branchCommit, fastForward };
    });

    if (changedGitlinks.length === 0) {
        return { trivial: false, reason: 'no_changed_gitlinks', gitlinks: changedGitlinks };
    }

    const nonFastForward = changedGitlinks.filter(entry => !entry.fastForward);
    if (nonFastForward.length > 0) {
        return {
            trivial: false,
            reason: `diverged_gitlinks:${nonFastForward.map(entry => entry.path).join(',')}`,
            gitlinks: changedGitlinks,
        };
    }

    // Prove there is no *other* conflict (regular files, or a gitlink that
    // diverged on both sides). A 3-way merge can only conflict on a path that
    // changed on BOTH sides relative to the merge-base. Compute that overlap and
    // require every overlapping path to be a gitlink — non-gitlink overlap means
    // a genuine content conflict that must stay blocked.
    let mergeBase = '';
    try {
        mergeBase = execFileSync(GIT, ['merge-base', baseHead, branchHead], {
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
        const tree = execFileSync(GIT, ['rev-parse', `${commitish}^{tree}`], {
            cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
        }).trim();
        if (!tree) return undefined;
        const updates = paths.map(path => `160000 commit ${placeholderCommit}\t${path}`).join('\n');
        if (!updates) return tree;
        const tmpIndex = pathJoin(resolveGitDir(repoRoot), `adhdev-refine-eq-${commitish.slice(0, 12)}.index`);
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        try {
            execFileSync(GIT, ['read-tree', tree], { cwd: repoRoot, env, stdio: 'ignore' });
            execFileSync(GIT, ['update-index', '--index-info'], {
                cwd: repoRoot, env, input: `${updates}\n`, encoding: 'utf8',
                stdio: ['pipe', 'ignore', 'ignore'],
            });
            const newTree = execFileSync(GIT, ['write-tree'], { cwd: repoRoot, env, encoding: 'utf8' }).trim();
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
function synthesizeTrivialFastForwardMergeTree(
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
        const mergeBase = execFileSync(GIT, ['merge-base', baseHead, branchHead], {
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
                    const baseEqCommit = execFileSync(GIT, ['commit-tree', baseEqTree, '-m', 'refine-ff-base'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const oursEqCommit = execFileSync(GIT, ['commit-tree', oursEqTree, '-p', baseEqCommit, '-m', 'refine-ff-ours'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const theirsEqCommit = execFileSync(GIT, ['commit-tree', theirsEqTree, '-p', baseEqCommit, '-m', 'refine-ff-theirs'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const mergeOut = execFileSync(GIT, ['merge-tree', '--write-tree', oursEqCommit, theirsEqCommit], {
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
            || execFileSync(GIT, ['rev-parse', `${baseHead}^{tree}`], {
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
            execFileSync(GIT, ['read-tree', contentTree], { cwd: repoRoot, env, stdio: 'ignore' });
            execFileSync(GIT, ['update-index', '--index-info'], {
                cwd: repoRoot,
                env,
                input: `${updates}\n`,
                encoding: 'utf8',
                stdio: ['pipe', 'ignore', 'ignore'],
            });
            const newTree = execFileSync(GIT, ['write-tree'], { cwd: repoRoot, env, encoding: 'utf8' }).trim();
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

export async function runMeshRefineSubmoduleReachabilityGate(
    repoRoot: string,
    mergedTree: string,
    options: { allowAutoPublishSubmoduleMainCommits?: boolean; autoPublishPolicySource?: string; worktreeRoot?: string } = {},
): Promise<MeshRefineSubmoduleReachabilitySummary> {
    const startedAt = Date.now();
    const entries: MeshRefineSubmoduleReachabilityEntry[] = [];
    try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const runGit = async (cwd: string, args: string[]): Promise<string> => {
            const { stdout } = await execFileAsync(GIT, args, {
                cwd,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
                windowsHide: true,
            });
            return String(stdout || '');
        };
        const verifyRemoteMainContainsCommit = async (submodulePath: string, commit: string, branch = 'main'): Promise<void> => {
            await runGit(submodulePath, ['-c', 'protocol.file.allow=always', 'fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
            await runGit(submodulePath, ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`]);
        };
        const publishCommitToRemoteMain = async (submodulePath: string, commit: string, branch = 'main'): Promise<{ stdout: string; stderr: string; refspec: string }> => {
            const refspec = `${commit}:refs/heads/${branch}`;
            const { stdout, stderr } = await execFileAsync(GIT, ['push', 'origin', refspec], {
                cwd: submodulePath,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
                windowsHide: true,
            });
            return { stdout: String(stdout || ''), stderr: String(stderr || ''), refspec };
        };
        const importCommitFromWorktreeSubmodule = async (submodulePath: string, worktreeSubmodulePath: string, commit: string): Promise<boolean> => {
            if (!fs.existsSync(worktreeSubmodulePath)) return false;
            try {
                await runGit(worktreeSubmodulePath, ['cat-file', '-e', `${commit}^{commit}`]);
            } catch {
                return false;
            }
            await runGit(submodulePath, ['-c', 'protocol.file.allow=always', 'fetch', worktreeSubmodulePath, commit]);
            await runGit(submodulePath, ['cat-file', '-e', `${commit}^{commit}`]);
            return true;
        };

        const treeOutput = await runGit(repoRoot, ['ls-tree', '-r', '-z', mergedTree]);
        const gitlinks = treeOutput
            .split('\0')
            .filter(Boolean)
            .map(record => {
                const match = /^160000\s+commit\s+([0-9a-f]{40})\t(.+)$/.exec(record);
                return match ? { commit: match[1], path: match[2] } : null;
            })
            .filter((entry): entry is { commit: string; path: string } => !!entry);

        for (const gitlink of gitlinks) {
            const submodulePath = pathResolve(repoRoot, gitlink.path);
            const entry: MeshRefineSubmoduleReachabilityEntry = {
                path: gitlink.path,
                commit: gitlink.commit,
                reachable: false,
            };
            // Resolved lazily once the submodule checkout/remote are confirmed; defaults
            // to 'main' so error messages emitted before resolution stay byte-identical
            // to the pre-generalization behavior on a main-default repo.
            let submoduleDefaultBranch = 'main';
            try {
                if (!fs.existsSync(submodulePath)) {
                    entry.error = `Submodule checkout missing at ${gitlink.path}`;
                    entry.publishRequired = true;
                    if (options.allowAutoPublishSubmoduleMainCommits === true) {
                        entry.autoPublishAllowed = true;
                        entry.autoPublishAttempted = false;
                        entry.autoPublishSkippedReason = `submodule checkout missing at ${gitlink.path}; cannot perform non-force push to origin/main`;
                    }
                    entries.push(entry);
                    continue;
                }

                entry.checkedLocal = true;
                try {
                    await runGit(submodulePath, ['cat-file', '-e', `${gitlink.commit}^{commit}`]);
                    entry.localReachable = true;
                } catch {
                    entry.localReachable = false;
                    if (options.allowAutoPublishSubmoduleMainCommits === true && options.worktreeRoot) {
                        try {
                            const imported = await importCommitFromWorktreeSubmodule(
                                submodulePath,
                                pathResolve(options.worktreeRoot, gitlink.path),
                                gitlink.commit,
                            );
                            if (imported) {
                                entry.localReachable = true;
                                entry.importedFromWorktree = true;
                            }
                        } catch (importError: any) {
                            entry.autoPublishSkippedReason = `candidate commit was not present in the source checkout and could not be imported from worktree submodule: ${truncateValidationOutput(importError?.stderr || importError?.message || String(importError))}`;
                        }
                    }
                    // Probe the submodule remote before allowing cleanup/completion.
                }

                try {
                    entry.remote = 'origin';
                    let remoteUrl = '';
                    try {
                        remoteUrl = (await runGit(submodulePath, ['remote', 'get-url', 'origin'])).trim();
                        if (!remoteUrl) throw new Error('origin remote has no URL');
                        entry.remoteUrl = remoteUrl;
                    } catch {
                        entry.error = 'Submodule remote reachability check failed: no configured origin remote';
                        entry.publishRequired = true;
                        if (options.allowAutoPublishSubmoduleMainCommits === true) {
                            entry.autoPublishAllowed = true;
                            entry.autoPublishAttempted = false;
                            entry.autoPublishSkippedReason = 'submodule origin remote is not configured; cannot perform non-force push to origin/main';
                        }
                        entries.push(entry);
                        continue;
                    }
                    // Generalize the submodule's default branch (F18): '.gitmodules'
                    // branch → local remote HEAD → remote-advertised HEAD → 'main'. On a
                    // main-default submodule this resolves to 'main' and every ref target
                    // below is byte-identical to the prior hardcoded path.
                    submoduleDefaultBranch = await resolveSubmoduleDefaultBranch({
                        submoduleRepoPath: submodulePath,
                        superprojectWorkspace: repoRoot,
                        submodulePath: gitlink.path,
                    });
                    entry.remoteMainBranch = submoduleDefaultBranch;
                    try {
                        await verifyRemoteMainContainsCommit(submodulePath, gitlink.commit, submoduleDefaultBranch);
                        entry.fetchedFromOrigin = true;
                        entry.remoteReachable = true;
                        entry.remoteMainReachable = true;
                        entry.reachable = true;
                    } catch (e: any) {
                        entry.remoteReachable = false;
                        entry.remoteMainReachable = false;
                        entry.publishRequired = true;
                        const details = truncateValidationOutput(e?.stderr || e?.message || String(e));
                        entry.error = `Submodule remote main reachability check failed for origin/${submoduleDefaultBranch}: ${details}`;
                        if (options.allowAutoPublishSubmoduleMainCommits === true && entry.localReachable === true) {
                            entry.autoPublishAllowed = true;
                            entry.autoPublishAttempted = true;
                            try {
                                const publish = await publishCommitToRemoteMain(submodulePath, gitlink.commit, submoduleDefaultBranch);
                                entry.autoPublishRefspec = publish.refspec;
                                entry.publishStdout = truncateValidationOutput(publish.stdout);
                                entry.publishStderr = truncateValidationOutput(publish.stderr);
                                entry.autoPublishSucceeded = true;
                                await verifyRemoteMainContainsCommit(submodulePath, gitlink.commit, submoduleDefaultBranch);
                                entry.fetchedFromOrigin = true;
                                entry.remoteReachable = true;
                                entry.remoteMainReachable = true;
                                entry.autoPublishVerified = true;
                                entry.publishRequired = false;
                                entry.reachable = true;
                                entry.error = undefined;
                            } catch (publishError: any) {
                                entry.autoPublishSucceeded = false;
                                entry.autoPublishVerified = false;
                                const publishDetails = truncateValidationOutput(publishError?.stderr || publishError?.message || String(publishError));
                                entry.error = `Submodule auto-publish to origin/${submoduleDefaultBranch} failed or could not be verified: ${publishDetails}`;
                            }
                        } else if (options.allowAutoPublishSubmoduleMainCommits === true) {
                            entry.autoPublishAllowed = true;
                            entry.autoPublishAttempted = false;
                            entry.autoPublishSkippedReason = entry.autoPublishSkippedReason
                                || `candidate commit is not reachable in the source checkout or worktree submodule, so Refinery cannot push it to origin/${submoduleDefaultBranch}`;
                        }
                    }
                } catch (e: any) {
                    entry.remoteReachable = false;
                    entry.remoteMainReachable = false;
                    entry.publishRequired = true;
                    const details = truncateValidationOutput(e?.stderr || e?.message || String(e));
                    entry.error = `Submodule remote main reachability check failed for origin/${submoduleDefaultBranch}: ${details}`;
                }
            } catch (e: any) {
                entry.error = truncateValidationOutput(e?.message || String(e));
                entry.publishRequired = true;
            }
            entries.push(entry);
        }

        const unreachable = entries.filter(entry => !entry.reachable);
        return {
            status: unreachable.length ? 'failed' : 'passed',
            checked: entries.length,
            unreachable: unreachable.map(entry => ({ ...entry, publishRequired: entry.publishRequired !== false })),
            entries: entries.map(entry => entry.reachable ? entry : { ...entry, publishRequired: entry.publishRequired !== false }),
            durationMs: Date.now() - startedAt,
            autoPublishAllowed: options.allowAutoPublishSubmoduleMainCommits === true,
            autoPublishPolicySource: options.autoPublishPolicySource,
        };
    } catch (e: any) {
        const unreachable = entries.filter(entry => !entry.reachable).map(entry => ({ ...entry, publishRequired: true }));
        return {
            status: 'failed',
            checked: entries.length,
            unreachable,
            entries: entries.map(entry => entry.reachable ? entry : { ...entry, publishRequired: true }),
            durationMs: Date.now() - startedAt,
            autoPublishAllowed: options.allowAutoPublishSubmoduleMainCommits === true,
            autoPublishPolicySource: options.autoPublishPolicySource,
            error: truncateValidationOutput(e?.message || String(e)),
        };
    }
}

export function buildMeshRefineValidationPlan(mesh: any, workspace: string): Record<string, unknown> {
    const plan = resolveMeshRefineValidationPlan(mesh, workspace);
    const mapCommand = (command: MeshRefineValidationCommandPlan) => ({
        displayCommand: command.displayCommand,
        category: command.category,
        source: command.source,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
    });
    return {
        source: plan.source,
        sourceType: plan.sourceType,
        bootstrapCommands: plan.bootstrapCommands.map(mapCommand),
        commands: plan.commands.map(mapCommand),
        unavailableReason: plan.unavailableReason,
        rejectedCommands: plan.rejectedCommands,
        suggestions: plan.suggestions,
        suggestedConfig: plan.suggestedConfig,
        note: plan.sourceType === 'unavailable'
            ? 'No validation command will be executed until a repo mesh/refine config is provided. Heuristics are suggestions only.'
            : 'Validation commands are resolved from repo mesh/refine config; heuristics are suggestions only.',
    };
}

export async function runMeshRefineValidationGate(
    mesh: any,
    workspace: string,
    opts?: {
        /** M2-2: persisted node bootstrap state for staleness evaluation. */
        persistedBootstrapState?: WorktreeBootstrapState | null;
        /** M2-2: called after an inherit-mode bootstrap run so the caller can persist the new state. */
        onBootstrapStateChange?: (state: WorktreeBootstrapState) => void;
    },
): Promise<MeshRefineValidationSummary> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const selection = resolveMeshRefineValidationPlan(mesh, workspace);
    const summary: MeshRefineValidationSummary = {
        status: 'skipped',
        required: true,
        commandsRun: [],
        bootstrapCommandsRun: [],
        rejectedCommands: selection.rejectedCommands,
        skippedReason: undefined,
        timeoutMs: REFINE_VALIDATION_TIMEOUT_MS,
        outputLimitBytes: REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
        configSource: selection.source,
        configSourceType: selection.sourceType,
        suggestions: selection.suggestions,
        suggestedConfig: selection.suggestedConfig,
        ...(selection.deprecationWarnings.length > 0 ? { deprecationWarnings: selection.deprecationWarnings } : {}),
    };

    if (!selection.commands.length) {
        summary.skippedReason = selection.unavailableReason || 'validation_unavailable: repo mesh/refine config did not provide executable validation.commands';
        return summary;
    }

    // ── M2-2: Bootstrap stage — refine consumes the worktree_bootstrap config
    //    instead of defining its own. Legacy validation.bootstrapCommands run
    //    only when no worktree_bootstrap config exists (deprecation path).
    let runLegacyBootstrapCommands = selection.bootstrapCommands.length > 0;
    if (selection.bootstrapMode === 'skip') {
        summary.bootstrap = { stage: 'skipped', skipped: true };
        runLegacyBootstrapCommands = false;
    } else {
        const wbLoad = loadMeshWorktreeBootstrapConfig(mesh, workspace);
        const wbUsable = !!wbLoad.config && wbLoad.sourceType !== 'invalid'
            && wbLoad.config.enabled !== false && wbLoad.config.runOnClone !== false;
        if (wbUsable) {
            runLegacyBootstrapCommands = false; // worktree_bootstrap wins over deprecated bootstrapCommands
            const evaluated = evaluateWorktreeBootstrapState(mesh, workspace, opts?.persistedBootstrapState);
            if (evaluated.status === 'ready') {
                summary.bootstrap = { stage: 'cached', status: 'ready', skipped: true, configSource: evaluated.configSource };
            } else {
                const ran = await runMeshWorktreeBootstrap(mesh, workspace);
                try { opts?.onBootstrapStateChange?.(ran); } catch { /* persistence is best-effort */ }
                if (ran.status === 'ready') {
                    summary.bootstrap = {
                        stage: 'ran',
                        status: 'ready',
                        configSource: ran.configSource,
                        ...(evaluated.staleReason ? { staleReason: evaluated.staleReason } : {}),
                        commandsRun: ran.commandsRun,
                    };
                } else {
                    summary.bootstrap = {
                        stage: 'failed',
                        status: ran.status,
                        configSource: ran.configSource,
                        error: ran.error,
                        commandsRun: ran.commandsRun,
                    };
                    summary.status = 'failed';
                    summary.failureKind = 'dependency_bootstrap_failed';
                    summary.failureCode = 'dependency_bootstrap_failed';
                    return summary;
                }
            }
        } else if (!runLegacyBootstrapCommands) {
            summary.bootstrap = { stage: 'not_configured' };
        }
    }

    const commandRecord = (candidate: MeshRefineValidationCommand, cwd: string, startedAt: number, result: any, passed: boolean, extras: Record<string, unknown> = {}) => ({
        command: candidate.command,
        args: candidate.args,
        displayCommand: candidate.displayCommand,
        category: candidate.category,
        source: candidate.source,
        cwd,
        passed,
        durationMs: Date.now() - startedAt,
        stdout: truncateValidationOutput(result?.stdout),
        stderr: truncateValidationOutput(result?.stderr || result?.message),
        ...extras,
    });
    const isPackageManagerValidation = (candidate: MeshRefineValidationCommand): boolean => {
        const command = pathBasename(candidate.command).replace(/\.(?:cmd|exe)$/i, '');
        return ['npm', 'pnpm', 'yarn', 'bun'].includes(command)
            && candidate.args.some(arg => arg === 'run' || arg === 'test' || arg === 'exec');
    };
    const dependenciesLikelyMissing = (cwd: string): boolean => {
        if (!fs.existsSync(pathJoin(cwd, 'package.json'))) return false;
        if (fs.existsSync(pathJoin(cwd, 'node_modules'))) return false;
        return ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']
            .some(lock => fs.existsSync(pathJoin(cwd, lock)));
    };

    if (runLegacyBootstrapCommands) {
        summary.bootstrap = { stage: 'legacy' };
        for (const candidate of selection.bootstrapCommands) {
            const startedAt = Date.now();
            const cwd = candidate.cwd ? pathResolve(workspace, candidate.cwd) : workspace;
            const timeout = candidate.timeoutMs || REFINE_VALIDATION_TIMEOUT_MS;
            // On win32, libuv's spawn search only appends .com/.exe (not .cmd/.bat),
            // so a bare `npm`/`npx`/`tsc` (which are .cmd shims) throws spawn ENOENT.
            // Resolve to an absolute path via the same helper the PTY path uses
            // (no-op on non-win32 and when the command is already absolute).
            const resolvedCommand = resolveWin32Executable(candidate.command);
            // A win32 .cmd/.bat shim cannot be exec'd directly — wrap it in
            // cmd.exe /c (no-op off win32 / for a real .exe). Keep
            // resolvedCommand for diagnostics.
            const spawn = buildWin32ExecFileSpawn(resolvedCommand, candidate.args);
            try {
                const result = await execFileAsync(spawn.file, spawn.args, {
                    cwd,
                    encoding: 'utf8',
                    timeout,
                    maxBuffer: candidate.outputLimitBytes || REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
                    env: { ...process.env, CI: process.env.CI || '1', ...(candidate.env || {}) },
                    ...(spawn.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
                });
                summary.bootstrapCommandsRun.push(commandRecord(candidate, cwd, startedAt, result, true, { exitCode: 0 }));
            } catch (error: any) {
                const spawnResolutionFailed = isSpawnResolutionError(error);
                summary.bootstrapCommandsRun.push(commandRecord(candidate, cwd, startedAt, error, false, {
                    exitCode: typeof error?.code === 'number' ? error.code : null,
                    signal: typeof error?.signal === 'string' ? error.signal : null,
                    timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                    ...(spawnResolutionFailed
                        ? { failureKind: 'spawn_resolution_failed', resolvedCommand }
                        : { failureKind: 'dependency_bootstrap_failed' }),
                }));
                summary.bootstrap = { stage: 'failed', error: describeSpawnError(error, resolvedCommand, spawnResolutionFailed) };
                summary.status = 'failed';
                summary.failureKind = spawnResolutionFailed ? 'spawn_resolution_failed' : 'dependency_bootstrap_failed';
                summary.failureCode = spawnResolutionFailed ? 'spawn_resolution_failed' : 'dependency_bootstrap_failed';
                return summary;
            }
        }
    }

    for (const candidate of selection.commands) {
        const startedAt = Date.now();
        const cwd = candidate.cwd ? pathResolve(workspace, candidate.cwd) : workspace;
        const timeout = candidate.timeoutMs || REFINE_VALIDATION_TIMEOUT_MS;
        const bootstrapProvidedDependencies = summary.bootstrap?.stage === 'cached' || summary.bootstrap?.stage === 'ran' || summary.bootstrap?.stage === 'legacy';
        if (!bootstrapProvidedDependencies && isPackageManagerValidation(candidate) && dependenciesLikelyMissing(cwd)) {
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, {
                stderr: 'Dependencies appear to be missing: package.json and a lockfile are present, but node_modules is absent. Configure validation.bootstrapCommands in repo mesh/refine config if Refinery should install/bootstrap before validation.',
            }, false, {
                exitCode: null,
                skipped: true,
                failureKind: 'missing_dependencies',
            }));
            summary.status = 'failed';
            summary.failureKind = 'missing_dependencies';
            summary.failureCode = 'missing_dependencies';
            return summary;
        }
        // See the bootstrap loop above: resolve the win32 .cmd shim to an
        // absolute path before handing it to the spawn boundary.
        const resolvedCommand = resolveWin32Executable(candidate.command);
        const spawn = buildWin32ExecFileSpawn(resolvedCommand, candidate.args);
        try {
            const result = await execFileAsync(spawn.file, spawn.args, {
                cwd,
                encoding: 'utf8',
                timeout,
                maxBuffer: candidate.outputLimitBytes || REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
                env: { ...process.env, CI: process.env.CI || '1', ...(candidate.env || {}) },
                ...(spawn.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            });
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, result, true, { exitCode: 0 }));
        } catch (error: any) {
            // ENOENT check first: a spawn-resolution failure ("spawn npm ENOENT")
            // carries no stderr and would otherwise fall through to an
            // unclassified generic failure. Classify it distinctly so the
            // coordinator surfaces the real cause (win32 .cmd resolution).
            const spawnResolutionFailed = isSpawnResolutionError(error);
            const stderr = truncateValidationOutput(error?.stderr || error?.message);
            const missingDependencyFailure = !spawnResolutionFailed
                && /Cannot find module|MODULE_NOT_FOUND|node_modules|command not found|not found/i.test(stderr);
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, error, false, {
                exitCode: typeof error?.code === 'number' ? error.code : null,
                signal: typeof error?.signal === 'string' ? error.signal : null,
                timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                ...(spawnResolutionFailed
                    ? { failureKind: 'spawn_resolution_failed', resolvedCommand }
                    : missingDependencyFailure ? { failureKind: 'missing_dependencies' } : {}),
            }));
            summary.status = 'failed';
            if (spawnResolutionFailed) {
                summary.failureKind = 'spawn_resolution_failed';
                summary.failureCode = 'spawn_resolution_failed';
                summary.spawnResolutionError = describeSpawnError(error, resolvedCommand, true);
            } else if (missingDependencyFailure) {
                summary.failureKind = 'missing_dependencies';
                summary.failureCode = 'missing_dependencies';
            }
            return summary;
        }
    }

    summary.status = 'passed';
    return summary;
}
