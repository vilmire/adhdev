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
import type { ChangedPackageClassification } from '../git/git-status.js';
import * as yaml from 'js-yaml';
import { loadMeshRefineConfig, resolveMeshRefineValidationPlan } from '../mesh/refine-config.js';
import type { MeshRefineValidationCommandPlan, MeshRefineValidationScope } from '../mesh/refine-config.js';
import { evaluateWorktreeBootstrapState, loadMeshWorktreeBootstrapConfig, runMeshWorktreeBootstrap, resolveSubmoduleDefaultBranch } from '../mesh/worktree-bootstrap-config.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { basename as pathBasename, join as pathJoin, resolve as pathResolve } from 'path';
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import { resolveWin32Executable, buildWin32ExecFileSpawn } from '../cli-adapters/resolve-executable.js';
import { refineGateChildEnv } from './mesh-refine-worker-cap.js';
import { LOG } from '../logging/logger.js';
import type { GitAncestryProbe, GitlinkTrivialFastForwardEvaluation, MeshRefineStageStatus, MeshRefineSubmoduleReachabilityEntry, MeshRefineSubmoduleReachabilitySummary } from './mesh-refine-gitlink-utils.js';
import { GIT, REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES, ensureSubmoduleCommitLocal, isSubmoduleFastForward, probeGitAncestry, probeSubmoduleFastForward, probeSubmoduleGitlinkReachability, readChangedGitlinkPaths, readChangedPathKinds, readTreeObject, runMeshRefineSubmoduleReachabilityGate, truncateValidationOutput, verifyRemoteBranchContainsCommit, warnGitlinkFastForwardUndeterminable, warnRefineSubmoduleUndeterminable } from './mesh-refine-gitlink-utils.js';
// Submodule-gitlink convergence lives in its own module (pure move, file-size gate);
// re-exported here so existing importers of this module are unaffected.
export * from './mesh-refine-submodule-converge.js';
export * from './mesh-refine-gitlink-utils.js';
import type { CommandRouterResult } from '../commands/router.js';

// Fix (4): resolve the git executable to an absolute path once on win32. A bare `git` handed to
// execFile(Sync)/execFileAsync is resolved by libuv's spawn search, which appends only .com/.exe
// (no PATHEXT) over the inherited PATH — so a `git.cmd`/`git.exe` that `where` finds is missed and
// the spawn ENOENTs (the live win32 refine/batch failure). resolveWin32Executable is the same helper
// the validation/bootstrap spawn path already uses. No-op on non-win32 (returns 'git' verbatim), and
// no shell:true is used anywhere here so there is no quoting risk.

export type MeshCoordinatorConfigFormat = 'claude_mcp_json' | 'hermes_config_yaml' | 'opencode_json';
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
    /**
     * Coarse daemon-vs-web change-impact used to scope the validation command set.
     * When `isDaemonAffecting === false`, daemon-scoped commands are recorded in
     * `commandsRun` with `skipped: true, skipReason: 'unaffected_daemon_scope'`
     * rather than executed; web + typecheck commands always run. Absent when no
     * change-impact was threaded in (legacy: full command set runs).
     */
    changeImpact?: {
        isDaemonAffecting: boolean;
        affectedPackages: string[];
        /** DOCS-ROOT: three-way change area ('none' | 'web' | 'daemon') when known. */
        changeArea?: MeshRefineValidationScope;
        /** displayCommands skipped because the daemon scope is unaffected. */
        skippedDaemonCommands?: string[];
        /** DOCS-ROOT: displayCommands skipped because the change-area scope excluded them. */
        skippedScopeCommands?: string[];
    };
};


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
    /**
     * The coordinator SESSION ID that initiated this refine job (REFINE-EVENT-SESSION-
     * SCOPED-UNICAST). The daemon anchor above narrows delivery to the right MACHINE;
     * this narrows it to the right coordinator SESSION on that machine. Without it the
     * terminal event's v2 `intendedFor` is session-less, and identityDeliversTo — which
     * compares sessions only when BOTH sides name one — matches ANY drainer on the
     * daemon: unicast silently degrades to first-come-first-served, and a sibling
     * coordinator session polling first consumes this job's result.
     * Absent on legacy / version-skewed requesters → daemon-level delivery, unchanged.
     */
    targetCoordinatorSessionId?: string;
    /**
     * Refinery serialization ⓪: accept-time verdict on whether the base moved out
     * from under this branch, scoped to the submodules the branch actually touches.
     * Recorded as a signal only — it never gates or delays acceptance today. A later
     * serialization queue reads this to decide which jobs may run in parallel;
     * `unknown` is fail-closed and must be treated as "must serialize".
     */
    baseDivergence?: {
        verdict: 'clear' | 'diverged' | 'unknown';
        scopes: Array<{
            path: string;
            verdict: 'clear' | 'diverged' | 'unknown';
            liveBaseHead?: string;
            mergeBase?: string;
            error?: string;
        }>;
        touchedSubmodulePaths: string[];
        durationMs: number;
    };
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
    /** Requesting coordinator SESSION (REFINE-EVENT-SESSION-SCOPED-UNICAST) — same
     *  contract as the single-node handle's field of the same name. */
    targetCoordinatorSessionId?: string;
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
const REFINE_VALIDATION_MAX_COMMANDS = 4;

/**
 * Classify a failed validation command. Exported (rather than inlined in the
 * gate) so the regression suite binds to the REAL logic — a test that mirrors a
 * copy of this silently stops protecting anything the moment the two diverge.
 *
 * A maxBuffer overflow is NOT a dependency problem. When a command's output
 * exceeds REFINE_VALIDATION_OUTPUT_LIMIT_BYTES, Node KILLS the child and rejects
 * with ERR_CHILD_PROCESS_STDIO_MAXBUFFER — carrying code === 1 even though the
 * command was on its way to exit 0. The missing-dependency heuristic then matches
 * "node_modules" inside the captured stack frames (every vitest/tsc frame contains
 * that substring) and reports `missing_dependencies`. That misdiagnosis cost a full
 * investigation into an absent packages/server/node_modules (normal npm hoisting)
 * and an uninitialized local D1 (never touched by those tests — measured: db:init
 * left the output byte-for-byte identical) before the real cause was found: a
 * verbose-reporter suite sitting ~7% under the output cap.
 *
 * Order matters — the output-budget check must run FIRST and suppress the
 * dependency heuristic, never the reverse.
 */
export function classifyValidationFailure(
    error: { code?: unknown; message?: unknown } | null | undefined,
    stderr: string,
    spawnResolutionFailed: boolean,
): { outputLimitExceeded: boolean; missingDependencyFailure: boolean } {
    const outputLimitExceeded = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        || /maxBuffer length exceeded/i.test(String(error?.message || ''));
    const missingDependencyFailure = !spawnResolutionFailed
        && !outputLimitExceeded
        && /Cannot find module|MODULE_NOT_FOUND|node_modules|command not found|not found/i.test(stderr);
    return { outputLimitExceeded, missingDependencyFailure };
}

// REFINE-LOG-PRESERVATION. The summary above is a payload budget, not a
// diagnostic record: a failing gate's output is cut TWICE on its way to the
// coordinator — once by execFile's maxBuffer (REFINE_VALIDATION_OUTPUT_LIMIT_BYTES)
// and again by truncateValidationOutput's head+tail window. Nothing kept the
// whole thing, so a coordinator receiving `code: 'SQLITE_ERROR'` plus three
// stack frames had no way to learn WHICH query or table failed. That gap
// blocked five consecutive refine diagnoses.
//
// So: write the untruncated stdout/stderr of a FAILING validation command to
// disk and surface the path in the command record. The truncated summary is
// unchanged — this ADDS a durable artifact, it does not replace the budget.
//
// Retention: failures only. A green refine writes nothing. Each run of this
// repo's own gate list is 17 commands, so preserving successes would accrue
// ~17 files per refine across every branch and worktree for output nobody
// reads — the log matters precisely when something failed. Best-effort
// throughout: a log-write failure must never turn a passing gate red, nor
// change the failure kind of a failing one, so every path is wrapped and
// falls back to returning undefined.
const REFINE_VALIDATION_LOG_DIR = pathJoin('.adhdev', 'logs');

export function writeValidationFailureLog(
    workspace: string,
    index: number,
    candidate: { command: string; args?: string[]; displayCommand?: string; cwd?: string },
    streams: { stdout?: unknown; stderr?: unknown },
    now: () => Date = () => new Date(),
): string | undefined {
    try {
        const dir = pathJoin(workspace, REFINE_VALIDATION_LOG_DIR);
        fs.mkdirSync(dir, { recursive: true });
        // Colons are illegal in win32 filenames, so the ISO stamp is flattened.
        const stamp = now().toISOString().replace(/[:.]/g, '-');
        const file = pathJoin(dir, `refine-${stamp}-${index}.log`);
        const asText = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
        const shown = candidate.displayCommand || [candidate.command, ...(candidate.args || [])].join(' ');
        fs.writeFileSync(
            file,
            `# refine validation failure\n`
            + `# command: ${shown}\n`
            + `# cwd: ${candidate.cwd || workspace}\n`
            + `# recorded: ${now().toISOString()}\n`
            + `\n=== stdout ===\n${asText(streams.stdout)}\n`
            + `\n=== stderr ===\n${asText(streams.stderr)}\n`,
            'utf8',
        );
        return file;
    } catch {
        // Never let diagnostics break the gate.
        return undefined;
    }
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


/**
 * Async git exec helper used across the synchronous-refine stage pipeline. Bound
 * once in the orchestrator and threaded through RefineContext so every stage runs
 * git the same way (execFile + promisify, utf8). Returns the child's stdout/stderr.
 */
export type RefineExecFileAsync = (file: string, args: string[], options: { cwd: string; encoding: 'utf8'; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;

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
    /**
     * Coarse daemon-vs-web change-impact for baseHead..branchHead, resolved in the
     * resolve_refs stage and threaded into the validation gate to scope its command
     * set. `undefined` means "could not classify" → the gate fails open and runs ALL
     * commands (never skip on uncertainty).
     */
    changeImpact?: ChangedPackageClassification;
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
        const git = (args: string[]): string => execFileSync(GIT, args, {
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

export function buildMeshRefineValidationPlan(mesh: any, workspace: string): Record<string, unknown> {
    const plan = resolveMeshRefineValidationPlan(mesh, workspace);
    const mapCommand = (command: MeshRefineValidationCommandPlan) => ({
        displayCommand: command.displayCommand,
        category: command.category,
        source: command.source,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        // DOCS-ROOT: surface the change-impact scopes so `mesh_refine_config` shows which
        // area(s) each command runs in (absent → every area).
        ...(command.scopes ? { scopes: command.scopes } : {}),
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
        /**
         * Coarse daemon-vs-web change-impact for the branch (resolve_refs computes it
         * over baseHead..branchHead). When provided and `isDaemonAffecting === false`,
         * daemon-scoped validation commands are skipped (web + typecheck still run).
         * When omitted or `isDaemonAffecting === true`, the full command set runs —
         * fail-open to full validation on any uncertainty.
         */
        changeImpact?: ChangedPackageClassification;
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
    // A validation command needs installed node_modules to run. Only these can hit
    // the missing-deps hard-block; non-package-manager commands (e.g. a plain
    // `node scripts/check-vendor-drift.mjs`) need no deps and must never be aborted
    // by a preceding command's missing-deps.
    const needsNodeModules = (candidate: MeshRefineValidationCommand, cwd: string): boolean =>
        isPackageManagerValidation(candidate) && dependenciesLikelyMissing(cwd);

    // (a) Coarse change-impact scoping. When the branch is web-only
    // (changeImpact.isDaemonAffecting === false), daemon-scoped validation commands
    // are pointless — and often un-runnable in a web-only worktree that never
    // bootstrapped daemon deps. Identify daemon-scoped commands ONLY by the coarse
    // daemon-vs-web bucket: a command whose script/args reference a daemon package
    // (daemon-core / daemon-cloud) or the vendor-drift check. web-side commands
    // (test:web-core / test:web-cloud) and `typecheck` ALWAYS run — the daemon/web
    // boundary is the human-curated safe line; we deliberately do NOT do fine
    // per-package skipping (web-cloud consumes web-core, so it must still run).
    const isDaemonScopedCommand = (candidate: MeshRefineValidationCommand): boolean => {
        const haystack = [candidate.command, ...(candidate.args || []), candidate.displayCommand || '']
            .join(' ')
            .toLowerCase();
        // Never treat a typecheck or an explicit web-side command as daemon-scoped.
        if (candidate.category === 'typecheck') return false;
        if (/\btypecheck\b/.test(haystack)) return false;
        if (/\bweb-core\b|\bweb-cloud\b|\bweb-standalone\b|\btest:web\b/.test(haystack)) return false;
        // Daemon-scoped signals: a daemon package name, a daemon test script, or the
        // vendor-drift check (which validates the daemon vendor bundle).
        return /\bdaemon-core\b|\bdaemon-cloud\b|\btest:daemon\b|check-vendor-drift/.test(haystack);
    };

    const scopeUnaffectedDaemon = opts?.changeImpact?.isDaemonAffecting === false;
    // DOCS-ROOT: the branch's three-way change area ('none' | 'web' | 'daemon'), when
    // known. `none` (docs-only) is the case this scoping exists for: a docs-only branch
    // must skip every code validation command and run ONLY commands explicitly scoped
    // ['none'] (e.g. a light docs:verify profile). Fail-open: an unknown change area
    // (changeImpact undefined) leaves changeArea undefined → no scope filtering, the full
    // command set runs exactly as before.
    const changeArea: MeshRefineValidationScope | undefined = opts?.changeImpact?.changeArea;
    // A command runs in the current change area when: the branch area is unknown (run
    // everything), OR the command declared no scopes (runs everywhere), OR the command's
    // scopes include the current area. When the branch is docs-only ('none'), an
    // un-scoped command does NOT run — only commands that explicitly opted into 'none'.
    const commandRunsInArea = (candidate: MeshRefineValidationCommand): boolean => {
        if (!changeArea) return true; // fail-open on unknown area
        const scopes = candidate.scopes;
        if (scopes && scopes.length) return scopes.includes(changeArea);
        // Un-scoped command: runs in web/daemon (code areas) but NOT on a docs-only
        // branch — there is nothing for a code command to validate when only docs changed.
        return changeArea !== 'none';
    };
    const skippedDaemonCommands: string[] = [];
    const skippedScopeCommands: string[] = [];
    const commandsToRun: MeshRefineValidationCommand[] = [];
    for (const candidate of selection.commands) {
        // DOCS-ROOT scope filter runs first: it is the explicit, config-declared signal
        // and supersedes the coarse daemon heuristic. A command excluded by change-area
        // scope is recorded skipped with `unaffected_change_scope`.
        if (!commandRunsInArea(candidate)) {
            skippedScopeCommands.push(candidate.displayCommand);
            summary.commandsRun.push({
                command: candidate.command,
                args: candidate.args,
                displayCommand: candidate.displayCommand,
                category: candidate.category,
                source: candidate.source,
                passed: true,
                skipped: true,
                skipReason: 'unaffected_change_scope',
                changeArea,
                ...(candidate.scopes ? { scopes: candidate.scopes } : {}),
            });
            continue;
        }
        if (scopeUnaffectedDaemon && isDaemonScopedCommand(candidate)) {
            skippedDaemonCommands.push(candidate.displayCommand);
            // Record the skip so it's visible in the summary, never silently dropped.
            summary.commandsRun.push({
                command: candidate.command,
                args: candidate.args,
                displayCommand: candidate.displayCommand,
                category: candidate.category,
                source: candidate.source,
                passed: true,
                skipped: true,
                skipReason: 'unaffected_daemon_scope',
            });
            continue;
        }
        commandsToRun.push(candidate);
    }
    if (opts?.changeImpact) {
        summary.changeImpact = {
            isDaemonAffecting: opts.changeImpact.isDaemonAffecting,
            affectedPackages: opts.changeImpact.affectedPackages,
            ...(changeArea ? { changeArea } : {}),
            ...(skippedDaemonCommands.length ? { skippedDaemonCommands } : {}),
            ...(skippedScopeCommands.length ? { skippedScopeCommands } : {}),
        };
    }

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
                    env: { ...process.env, CI: process.env.CI || '1', ...refineGateChildEnv(), ...(candidate.env || {}) },
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

    // (b) Track a genuine missing-deps block for an AFFECTED command. Instead of
    // aborting the whole gate at the first missing-deps hit (which also killed
    // trailing no-dep commands like check-vendor-drift.mjs), we mark the blocked
    // command and CONTINUE evaluating the rest: commands whose deps are present, or
    // which need no deps at all, still run. missing_dependencies only becomes the
    // gate failure if at least one command that truly needed deps could not run.
    let missingDepsBlocked = false;
    for (const candidate of commandsToRun) {
        const startedAt = Date.now();
        const cwd = candidate.cwd ? pathResolve(workspace, candidate.cwd) : workspace;
        const timeout = candidate.timeoutMs || REFINE_VALIDATION_TIMEOUT_MS;
        const bootstrapProvidedDependencies = summary.bootstrap?.stage === 'cached' || summary.bootstrap?.stage === 'ran' || summary.bootstrap?.stage === 'legacy';
        if (!bootstrapProvidedDependencies && needsNodeModules(candidate, cwd)) {
            // This command genuinely needs node_modules that are absent. Mark it
            // blocked, but do NOT abort — a following no-dep command (or one in a
            // different cwd that DOES have deps) must still get its chance to run.
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, {
                stderr: 'Dependencies appear to be missing: package.json and a lockfile are present, but node_modules is absent. Configure validation.bootstrapCommands (or .adhdev/worktree_bootstrap.json) in repo mesh/refine config if Refinery should install/bootstrap before validation.',
            }, false, {
                exitCode: null,
                skipped: true,
                failureKind: 'missing_dependencies',
            }));
            missingDepsBlocked = true;
            continue;
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
                env: { ...process.env, CI: process.env.CI || '1', ...refineGateChildEnv(), ...(candidate.env || {}) },
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
            const { outputLimitExceeded, missingDependencyFailure } =
                classifyValidationFailure(error, stderr, spawnResolutionFailed);
            // REFINE-LOG-PRESERVATION: keep the UNtruncated streams on disk before
            // the record below reduces them to the head+tail summary, and hand the
            // coordinator the path so it can read the real failure.
            const failureLogPath = writeValidationFailureLog(
                workspace,
                summary.commandsRun.length,
                { command: candidate.command, args: candidate.args, displayCommand: candidate.displayCommand, cwd },
                { stdout: error?.stdout, stderr: error?.stderr || error?.message },
            );
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, error, false, {
                exitCode: typeof error?.code === 'number' ? error.code : null,
                signal: typeof error?.signal === 'string' ? error.signal : null,
                timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                ...(failureLogPath ? { failureLogPath } : {}),
                ...(spawnResolutionFailed
                    ? { failureKind: 'spawn_resolution_failed', resolvedCommand }
                    : outputLimitExceeded ? { failureKind: 'output_limit_exceeded' }
                    : missingDependencyFailure ? { failureKind: 'missing_dependencies' } : {}),
            }));
            summary.status = 'failed';
            if (spawnResolutionFailed) {
                summary.failureKind = 'spawn_resolution_failed';
                summary.failureCode = 'spawn_resolution_failed';
                summary.spawnResolutionError = describeSpawnError(error, resolvedCommand, true);
            } else if (outputLimitExceeded) {
                summary.failureKind = 'output_limit_exceeded';
                summary.failureCode = 'output_limit_exceeded';
            } else if (missingDependencyFailure) {
                summary.failureKind = 'missing_dependencies';
                summary.failureCode = 'missing_dependencies';
            }
            return summary;
        }
    }

    // (b) A command that genuinely needed deps could not run. Surface it as the
    // gate failure now (after letting no-dep / deps-present commands run), so the
    // caller can classify it blocked_review and emit a self-service hint. Every
    // daemon-scoped command in a web-only branch was already filtered above, so a
    // missing-deps block here is a real affected-command block.
    if (missingDepsBlocked) {
        summary.status = 'failed';
        summary.failureKind = 'missing_dependencies';
        summary.failureCode = 'missing_dependencies';
        return summary;
    }

    summary.status = 'passed';
    return summary;
}
