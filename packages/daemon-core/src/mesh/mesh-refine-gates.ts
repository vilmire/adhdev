/**
 * Mesh refine validation gate
 *
 * Extracted from commands/router.ts (behavior-preserving move). Contains:
 *   - the MeshCoordinator config-format type
 *   - the refine summary types + job handles and the refine context
 *   - the validation gate (bootstrap, change-scope selection, command runs,
 *     failure classification and preserved failure logs)
 *
 * The patch-equivalence / effective-diff gates (mesh-refine-patch-equivalence.ts)
 * and the gitlink trivial-fast-forward + submodule alignment helpers
 * (mesh-refine-gitlink-ff.ts) live beside it and are re-exported here.
 *
 * router.ts re-exports every public symbol from here so existing import paths
 * keep working. `CommandRouterResult` is imported type-only from router.ts
 * (erased at compile time — no runtime import cycle).
 */

import type { ChangedPackageClassification } from '../git/git-status.js';
import { loadMeshRefineConfig, resolveMeshRefineValidationPlan } from '../mesh/refine-config.js';
import type { MeshRefineConfigLoadOptions, MeshRefineValidationCommandPlan, MeshRefineValidationScope } from '../mesh/refine-config.js';
import { evaluateWorktreeBootstrapState, loadMeshWorktreeBootstrapConfig, runMeshWorktreeBootstrap } from '../mesh/worktree-bootstrap-config.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { basename as pathBasename, join as pathJoin, resolve as pathResolve } from 'path';
import * as fs from 'fs';
import { resolveWin32Executable, buildWin32ExecFileSpawn } from '../cli-adapters/resolve-executable.js';
import { refineGateChildEnv } from './mesh-refine-worker-cap.js';
import { sanitizeRefineGateChildEnv } from './mesh-refine-env-sanitize.js';
// ★B1: type-only — the gate never emits, it only carries the caller's channel.
import type { RefineProgressContext } from './mesh-refine-progress.js';
import type { MeshRefineStageStatus } from './mesh-refine-gitlink-utils.js';
import { runMeshRefineSubmoduleReachabilityGate, truncateValidationOutput } from './mesh-refine-gitlink-utils.js';
// Submodule-gitlink convergence lives in its own module (pure move, file-size gate);
// re-exported here so existing importers of this module are unaffected.
export * from './mesh-refine-submodule-converge.js';
// Generated-vendor-bundle rebase policy — same barrel-preserving pattern.
export * from './mesh-refine-generated-bundles.js';
export * from './mesh-refine-gitlink-utils.js';
import type { CommandRouterResult } from '../commands/router.js';
import type { runMeshRefinePatchEquivalenceGate } from './mesh-refine-patch-equivalence.js';
export { collectFastForwardGitlinkPaths, collectTrivialFastForwardGitlinkResolutions, evaluateGitlinkTrivialFastForward, synthesizeTrivialFastForwardMergeTree, alignRefinerySubmodulesAfterMerge } from './mesh-refine-gitlink-ff.js';
export { runMeshRefinePatchEquivalenceGate, classifyAndWarnPatchEquivalenceFailure, classifyPatchEquivalenceFailure, checkWorktreeChangesPatchEquivalentInRef, runMeshRefineEffectiveDiffGate } from './mesh-refine-patch-equivalence.js';
export type { MeshRefinePatchEquivalenceDetailedReasonCode, MeshRefinePatchEquivalenceFailureClassification, MeshWorktreePatchContainmentSummary } from './mesh-refine-patch-equivalence.js';

// Fix (4): resolve the git executable to an absolute path once on win32. A bare `git` handed to
// execFile(Sync)/execFileAsync is resolved by libuv's spawn search, which appends only .com/.exe
// (no PATHEXT) over the inherited PATH — so a `git.cmd`/`git.exe` that `where` finds is missed and
// the spawn ENOENTs (the live win32 refine/batch failure). resolveWin32Executable is the same helper
// the validation/bootstrap spawn path already uses. No-op on non-win32 (returns 'git' verbatim), and
// no shell:true is used anywhere here so there is no quoting risk.

export type MeshCoordinatorConfigFormat = 'claude_mcp_json' | 'opencode_json';
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
    /**
     * ★C: set when a vendor-drift failure is attributable to this refine's OWN
     * rebase changing the bundle build base (see buildRefineVendorDriftHint).
     */
    vendorDriftHint?: string;
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


export type MeshRefinePatchEquivalenceSummary = {
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

export type MeshRefineEffectiveDiffSummary = {
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

export type MeshRefineSubmoduleConflictHint = {
    kind: 'submodule_conflict';
    message: string;
    conflicts: Array<{
        path: string;
        baseCommit?: string;
        branchCommit?: string;
    }>;
    nextSteps: string[];
};

export type MeshRefineSubmoduleAlignmentSummary = {
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

const REFINE_VALIDATION_TIMEOUT_MS = 120_000;
const REFINE_VALIDATION_OUTPUT_LIMIT_BYTES = 128 * 1024;

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
export type RefineExecFileAsync = (file: string, args: string[], options: { cwd: string; encoding: 'utf8'; env?: NodeJS.ProcessEnv; timeout?: number; windowsHide?: boolean }) => Promise<{ stdout: string; stderr: string }>;

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
    /**
     * ★B1 progress channel for this node's run. Optional: absent means the pipeline
     * emits no progress events, which is the behaviour every pre-existing caller
     * (and every test that builds a context by hand) gets unchanged.
     */
    progress?: RefineProgressContext;
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

export function buildMeshRefineValidationPlan(mesh: any, workspace: string, configOptions?: MeshRefineConfigLoadOptions): Record<string, unknown> {
    // BASE-REF-CONFIG-FALLBACK: plan surfaces pass the node's base refs so a worktree cut
    // before the config landed on base previews the plan execute will actually run.
    const plan = resolveMeshRefineValidationPlan(mesh, workspace, configOptions);
    const mapCommand = (command: MeshRefineValidationCommandPlan) => ({
        displayCommand: command.displayCommand,
        category: command.category,
        source: command.source,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        // DOCS-ROOT: surface the change-impact scopes so `mesh_config` kind=refine shows which
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

/**
 * ★B1: report a completed validation command to the caller's progress channel.
 *
 * Defensive by construction: the callback belongs to the notification layer,
 * which is strictly less important than the validation run it observes, so a
 * throwing callback is swallowed rather than allowed to fail the gate.
 */
function reportRefineCommandComplete(
    callback: ((info: { displayCommand: string; durationMs: number; passed: boolean }) => void) | undefined,
    candidate: MeshRefineValidationCommand,
    startedAt: number,
    passed: boolean,
): void {
    if (!callback) return;
    try {
        callback({
            displayCommand: candidate.displayCommand || [candidate.command, ...(candidate.args || [])].join(' ').trim(),
            durationMs: Date.now() - startedAt,
            passed,
        });
    } catch { /* observability must never fail the run */ }
}

/**
 * ★C: explain a vendor-drift failure that the Refinery's OWN rebase caused.
 *
 * ## The failure
 *
 * `npm run bundle:vendor:all` emits bundles built from a specific base. When the
 * Refinery rebases a branch onto an advanced base (because a sibling landed
 * first), the committed bundles were built against the OLD base and no longer
 * reproduce — so `check-vendor-drift.mjs` fails. Measured 2026-09-22: the
 * Refinery created the state its own gate then rejected.
 *
 * ## Why this is a MESSAGE and not an automatic re-bundle
 *
 * Re-bundling automatically was considered and rejected, on the strength of a
 * design decision already recorded in this repo. `mesh-refine-generated-bundles.ts`
 * resolves the rebase-time bundle CONFLICT by taking the branch side, and
 * documents explicitly that this "deliberately leaves a bundle built from the
 * branch's PRE-REBASE source" — with `check:vendor` named as the gate that must
 * therefore catch it. That gate failing is the designed outcome, not a defect.
 *
 * Auto-re-bundling would dismantle that safety property: the verification the
 * conflict resolver relies on is precisely "a separate gate rebuilds it and
 * fails if it is wrong". A Refinery that regenerates the bundle and commits it
 * would be marking its own homework — and would do so by running an arbitrary
 * build (`bundle:vendor:all` spawns npm across two repos) inside a merge path,
 * then committing output nobody reviewed into both the root repo and the oss
 * submodule, requiring a pointer bump. A wrong bundle would reach main with no
 * gate left to catch it.
 *
 * The cost of NOT automating is one worker command. The cost of automating it
 * wrongly is unreviewed build output on a public AGPL repo's main branch. So the
 * Refinery says exactly what happened and what to run.
 */
export function buildRefineVendorDriftHint(params: {
    displayCommand: string;
    args?: string[];
    rebased: boolean;
}): string | undefined {
    if (!params.rebased) return undefined;
    const haystack = [params.displayCommand, ...(params.args || [])].join(' ');
    if (!/check-vendor-drift/.test(haystack)) return undefined;
    return 'This refine REBASED the branch onto an advanced base before validating, which changed the commit the vendor bundles were built from — '
        + 'so the committed bundles no longer reproduce and check-vendor-drift fails. This is expected after a rebase and does NOT mean the branch is wrong. '
        + 'Fix: run `npm run bundle:vendor:all` in the worktree, commit the regenerated vendor paths (the daemon-standalone copy lives inside oss, so bump the oss pointer too), then re-run refine.';
}

type RefineValidationSelection = ReturnType<typeof resolveMeshRefineValidationPlan>;
type RefineGateExecFile = (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout?: string; stderr?: string }>;

interface MeshRefineValidationGateOptions {
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
    /**
     * BASE-REF-CONFIG-FALLBACK: base refs (pinned baseHead, then the base branch) the
     * refine config is read from when the worktree itself has no config file. The
     * worktree's own config still wins when present.
     */
    configBaseRefs?: string[];
    /**
     * ★B1 SLOW-GATE PROGRESS. Called after each validation command completes, with
     * its display name and wall-clock duration. The CALLER decides what is worth
     * announcing (see mesh-refine-progress.ts's threshold) — this gate only reports
     * facts, so the notification policy lives in one place instead of being
     * duplicated here. Optional and never awaited: a throwing callback must not be
     * able to fail a validation run, so it is invoked defensively.
     */
    onCommandComplete?: (info: { displayCommand: string; durationMs: number; passed: boolean }) => void;
    /**
     * ★C: whether sync_base rebased the branch in THIS refine run. A vendor-drift
     * failure means something different depending on the answer — see
     * {@link buildRefineVendorDriftHint}.
     */
    branchWasRebased?: boolean;
}

function refineCommandRecord(candidate: MeshRefineValidationCommand, cwd: string, startedAt: number, result: any, passed: boolean, extras: Record<string, unknown> = {}) {
    return {
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
    };
}

/**
 * A validation command needs installed node_modules to run. Only package-manager
 * commands can hit the missing-deps hard-block; non-package-manager commands (e.g.
 * a plain `node scripts/check-vendor-drift.mjs`) need no deps and must never be
 * aborted by a preceding command's missing-deps.
 */
function refineCommandNeedsMissingNodeModules(candidate: MeshRefineValidationCommand, cwd: string): boolean {
    const command = pathBasename(candidate.command).replace(/\.(?:cmd|exe)$/i, '');
    const isPackageManagerValidation = ['npm', 'pnpm', 'yarn', 'bun'].includes(command)
        && candidate.args.some(arg => arg === 'run' || arg === 'test' || arg === 'exec');
    if (!isPackageManagerValidation) return false;
    if (!fs.existsSync(pathJoin(cwd, 'package.json'))) return false;
    if (fs.existsSync(pathJoin(cwd, 'node_modules'))) return false;
    return ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']
        .some(lock => fs.existsSync(pathJoin(cwd, lock)));
}

/**
 * (a) Coarse change-impact scoping. When the branch is web-only
 * (changeImpact.isDaemonAffecting === false), daemon-scoped validation commands
 * are pointless — and often un-runnable in a web-only worktree that never
 * bootstrapped daemon deps. Identify daemon-scoped commands ONLY by the coarse
 * daemon-vs-web bucket: a command whose script/args reference a daemon package
 * (daemon-core / daemon-cloud) or the vendor-drift check. web-side commands
 * (test:web-core / test:web-cloud) and `typecheck` ALWAYS run — the daemon/web
 * boundary is the human-curated safe line; we deliberately do NOT do fine
 * per-package skipping (web-cloud consumes web-core, so it must still run).
 */
function isDaemonScopedRefineCommand(candidate: MeshRefineValidationCommand): boolean {
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
}

/**
 * DOCS-ROOT: a command runs in the branch's change area ('none' | 'web' | 'daemon')
 * when the area is unknown (fail-open: run everything), OR the command declared no
 * scopes (runs in the code areas), OR the command's scopes include the area. On a
 * docs-only branch ('none') an un-scoped command does NOT run — there is nothing for
 * a code command to validate when only docs changed.
 */
function refineCommandRunsInArea(candidate: MeshRefineValidationCommand, changeArea: MeshRefineValidationScope | undefined): boolean {
    if (!changeArea) return true;
    const scopes = candidate.scopes;
    if (scopes && scopes.length) return scopes.includes(changeArea);
    return changeArea !== 'none';
}

/**
 * Filter the configured commands by change area (the explicit, config-declared
 * signal, checked first) and the coarse daemon scope. Every skip is recorded on the
 * summary — never silently dropped.
 */
function selectRefineCommandsToRun(
    selection: RefineValidationSelection,
    summary: MeshRefineValidationSummary,
    changeImpact: ChangedPackageClassification | undefined,
): MeshRefineValidationCommand[] {
    const scopeUnaffectedDaemon = changeImpact?.isDaemonAffecting === false;
    const changeArea: MeshRefineValidationScope | undefined = changeImpact?.changeArea;
    const skippedDaemonCommands: string[] = [];
    const skippedScopeCommands: string[] = [];
    const commandsToRun: MeshRefineValidationCommand[] = [];
    for (const candidate of selection.commands) {
        if (!refineCommandRunsInArea(candidate, changeArea)) {
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
        if (scopeUnaffectedDaemon && isDaemonScopedRefineCommand(candidate)) {
            skippedDaemonCommands.push(candidate.displayCommand);
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
    if (changeImpact) {
        summary.changeImpact = {
            isDaemonAffecting: changeImpact.isDaemonAffecting,
            affectedPackages: changeImpact.affectedPackages,
            ...(changeArea ? { changeArea } : {}),
            ...(skippedDaemonCommands.length ? { skippedDaemonCommands } : {}),
            ...(skippedScopeCommands.length ? { skippedScopeCommands } : {}),
        };
    }
    return commandsToRun;
}

/**
 * Spawn one validation / bootstrap command. On win32, libuv's spawn search only
 * appends .com/.exe (not .cmd/.bat), so a bare `npm`/`npx`/`tsc` (which are .cmd
 * shims) throws spawn ENOENT: the command is resolved to an absolute path via the
 * same helper the PTY path uses, and a .cmd/.bat shim is wrapped in cmd.exe /c
 * (no-ops off win32 / for a real .exe).
 */
async function execRefineCommand(execFileAsync: RefineGateExecFile, candidate: MeshRefineValidationCommand, cwd: string, resolvedCommand: string) {
    const spawn = buildWin32ExecFileSpawn(resolvedCommand, candidate.args);
    return execFileAsync(spawn.file, spawn.args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: candidate.timeoutMs || REFINE_VALIDATION_TIMEOUT_MS,
        maxBuffer: candidate.outputLimitBytes || REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
        env: { ...sanitizeRefineGateChildEnv(), CI: process.env.CI || '1', ...refineGateChildEnv(), ...(candidate.env || {}) },
        ...(spawn.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
}

function refineExecFailureExtras(error: any) {
    return {
        exitCode: typeof error?.code === 'number' ? error.code : null,
        signal: typeof error?.signal === 'string' ? error.signal : null,
        timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
    };
}

/**
 * ── M2-2: Bootstrap stage — refine consumes the worktree_bootstrap config instead
 * of defining its own. Legacy validation.bootstrapCommands run only when no
 * worktree_bootstrap config exists (deprecation path). Returns whether the legacy
 * commands must run, or 'failed' after recording the bootstrap failure.
 */
async function runRefineWorktreeBootstrap(
    mesh: any,
    workspace: string,
    selection: RefineValidationSelection,
    summary: MeshRefineValidationSummary,
    opts: MeshRefineValidationGateOptions | undefined,
): Promise<{ runLegacyBootstrapCommands: boolean } | 'failed'> {
    if (selection.bootstrapMode === 'skip') {
        summary.bootstrap = { stage: 'skipped', skipped: true };
        return { runLegacyBootstrapCommands: false };
    }
    const runLegacyBootstrapCommands = selection.bootstrapCommands.length > 0;
    const wbLoad = loadMeshWorktreeBootstrapConfig(mesh, workspace);
    const wbUsable = !!wbLoad.config && wbLoad.sourceType !== 'invalid'
        && wbLoad.config.enabled !== false && wbLoad.config.runOnClone !== false;
    if (!wbUsable) {
        if (!runLegacyBootstrapCommands) summary.bootstrap = { stage: 'not_configured' };
        return { runLegacyBootstrapCommands };
    }
    // worktree_bootstrap wins over deprecated bootstrapCommands
    const evaluated = evaluateWorktreeBootstrapState(mesh, workspace, opts?.persistedBootstrapState);
    if (evaluated.status === 'ready') {
        summary.bootstrap = { stage: 'cached', status: 'ready', skipped: true, configSource: evaluated.configSource };
        return { runLegacyBootstrapCommands: false };
    }
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
        return { runLegacyBootstrapCommands: false };
    }
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
    return 'failed';
}

/** Legacy validation.bootstrapCommands. Returns false after recording a failure. */
async function runLegacyRefineBootstrap(
    execFileAsync: RefineGateExecFile,
    workspace: string,
    selection: RefineValidationSelection,
    summary: MeshRefineValidationSummary,
): Promise<boolean> {
    summary.bootstrap = { stage: 'legacy' };
    for (const candidate of selection.bootstrapCommands) {
        const startedAt = Date.now();
        const cwd = candidate.cwd ? pathResolve(workspace, candidate.cwd) : workspace;
        const resolvedCommand = resolveWin32Executable(candidate.command);
        try {
            const result = await execRefineCommand(execFileAsync, candidate, cwd, resolvedCommand);
            summary.bootstrapCommandsRun.push(refineCommandRecord(candidate, cwd, startedAt, result, true, { exitCode: 0 }));
        } catch (error: any) {
            const spawnResolutionFailed = isSpawnResolutionError(error);
            summary.bootstrapCommandsRun.push(refineCommandRecord(candidate, cwd, startedAt, error, false, {
                ...refineExecFailureExtras(error),
                ...(spawnResolutionFailed
                    ? { failureKind: 'spawn_resolution_failed', resolvedCommand }
                    : { failureKind: 'dependency_bootstrap_failed' }),
            }));
            summary.bootstrap = { stage: 'failed', error: describeSpawnError(error, resolvedCommand, spawnResolutionFailed) };
            summary.status = 'failed';
            summary.failureKind = spawnResolutionFailed ? 'spawn_resolution_failed' : 'dependency_bootstrap_failed';
            summary.failureCode = spawnResolutionFailed ? 'spawn_resolution_failed' : 'dependency_bootstrap_failed';
            return false;
        }
    }
    return true;
}

/** Record a failed validation command on the summary and classify the gate failure. */
function recordRefineCommandFailure(
    summary: MeshRefineValidationSummary,
    workspace: string,
    candidate: MeshRefineValidationCommand,
    cwd: string,
    startedAt: number,
    resolvedCommand: string,
    error: any,
    opts: MeshRefineValidationGateOptions | undefined,
): void {
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
    summary.commandsRun.push(refineCommandRecord(candidate, cwd, startedAt, error, false, {
        ...refineExecFailureExtras(error),
        ...(failureLogPath ? { failureLogPath } : {}),
        ...(spawnResolutionFailed
            ? { failureKind: 'spawn_resolution_failed', resolvedCommand }
            : outputLimitExceeded ? { failureKind: 'output_limit_exceeded' }
            : missingDependencyFailure ? { failureKind: 'missing_dependencies' } : {}),
    }));
    reportRefineCommandComplete(opts?.onCommandComplete, candidate, startedAt, false);
    summary.status = 'failed';
    // ★C REBASE-VENDOR-STALENESS: when the failing command is the vendor drift
    // check AND this refine rebased the branch, say so. Without this the
    // coordinator sees only a bundle diff and cannot tell a genuine un-synced
    // vendor commit from one the Refinery's own rebase invalidated — the 4th
    // incident of 2026-09-22. See buildRefineVendorDriftHint for why the fix is a
    // message rather than an automatic re-bundle.
    const vendorHint = buildRefineVendorDriftHint({
        displayCommand: candidate.displayCommand || candidate.command,
        args: candidate.args,
        rebased: opts?.branchWasRebased === true,
    });
    if (vendorHint) {
        summary.failureKind = 'vendor_drift_after_rebase';
        summary.failureCode = 'vendor_drift_after_rebase';
        summary.vendorDriftHint = vendorHint;
    }
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
}

export async function runMeshRefineValidationGate(
    mesh: any,
    workspace: string,
    opts?: MeshRefineValidationGateOptions,
): Promise<MeshRefineValidationSummary> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile) as unknown as RefineGateExecFile;
    const selection = resolveMeshRefineValidationPlan(mesh, workspace, opts?.configBaseRefs?.length ? { baseRefs: opts.configBaseRefs } : undefined);
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

    const bootstrap = await runRefineWorktreeBootstrap(mesh, workspace, selection, summary, opts);
    if (bootstrap === 'failed') return summary;
    const commandsToRun = selectRefineCommandsToRun(selection, summary, opts?.changeImpact);
    if (bootstrap.runLegacyBootstrapCommands && !(await runLegacyRefineBootstrap(execFileAsync, workspace, selection, summary))) {
        return summary;
    }

    // (b) Track a genuine missing-deps block for an AFFECTED command. Instead of
    // aborting the whole gate at the first missing-deps hit (which also killed
    // trailing no-dep commands like check-vendor-drift.mjs), we mark the blocked
    // command and CONTINUE evaluating the rest: commands whose deps are present, or
    // which need no deps at all, still run. missing_dependencies only becomes the
    // gate failure if at least one command that truly needed deps could not run.
    let missingDepsBlocked = false;
    const bootstrapProvidedDependencies = summary.bootstrap?.stage === 'cached' || summary.bootstrap?.stage === 'ran' || summary.bootstrap?.stage === 'legacy';
    for (const candidate of commandsToRun) {
        const startedAt = Date.now();
        const cwd = candidate.cwd ? pathResolve(workspace, candidate.cwd) : workspace;
        if (!bootstrapProvidedDependencies && refineCommandNeedsMissingNodeModules(candidate, cwd)) {
            // This command genuinely needs node_modules that are absent. Mark it
            // blocked, but do NOT abort — a following no-dep command (or one in a
            // different cwd that DOES have deps) must still get its chance to run.
            summary.commandsRun.push(refineCommandRecord(candidate, cwd, startedAt, {
                stderr: 'Dependencies appear to be missing: package.json and a lockfile are present, but node_modules is absent. Configure validation.bootstrapCommands (or .adhdev/worktree_bootstrap.json) in repo mesh/refine config if Refinery should install/bootstrap before validation.',
            }, false, {
                exitCode: null,
                skipped: true,
                failureKind: 'missing_dependencies',
            }));
            missingDepsBlocked = true;
            continue;
        }
        const resolvedCommand = resolveWin32Executable(candidate.command);
        try {
            const result = await execRefineCommand(execFileAsync, candidate, cwd, resolvedCommand);
            summary.commandsRun.push(refineCommandRecord(candidate, cwd, startedAt, result, true, { exitCode: 0 }));
            reportRefineCommandComplete(opts?.onCommandComplete, candidate, startedAt, true);
        } catch (error: any) {
            recordRefineCommandFailure(summary, workspace, candidate, cwd, startedAt, resolvedCommand, error, opts);
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
