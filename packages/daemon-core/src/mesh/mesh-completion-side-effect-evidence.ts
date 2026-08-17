// COMPLETION-SIDE-EFFECT-EVIDENCE
//
// A `code_change` task's completion notification is built entirely from the
// worker's OWN self-reported transcript shape (final_assistant present? a JSON
// answer parsed?) — never from whether the workspace actually changed. A worker
// that delegates the real work to a subagent and returns can self-report a
// "genuine" completion with zero commits. The ASYNC path below is a best-effort,
// diagnostic-only follow-up: it runs strictly AFTER the synchronous
// task_completed ledger append + coordinator notification that
// mesh-event-forwarding.ts already performs (that whole event-forwarding
// pipeline is synchronous end to end, invoked from a plain EventEmitter
// callback with no request awaiting its result — see injectMeshSystemMessage),
// so it can only ever ADD a follow-up ledger entry, never delay or block
// delivery of the completion itself.
//
// checkCodeChangeWorkspaceCleanSync (below) is the WIRED-INTO-STATE counterpart:
// mesh-event-forwarding.ts's markSessionTerminal calls it SYNCHRONOUSLY, before
// the queue-row status flip, so a clean-tree code_change completion can be
// flagged for review in the SAME state transition instead of only via a
// trailing ledger entry nothing re-reads. It reuses the exact local-node +
// workspace resolution this file already uses for the async path, but shells
// out to git synchronously (execFileSync) with a short, caller-bounded timeout
// — the async getGitRepoStatus() has no sync form, and turning the whole
// event-forwarding pipeline async to await it would be a much larger, riskier
// change than this file's narrow ownership allows. Any failure (timeout,
// git error, not-a-repo) fails OPEN — `checked:false` — so a slow/broken git
// call degrades to exactly today's behavior (no review flag), never to a
// stuck or delayed completion.
//
// Deliberately LOCAL-ONLY (both the async and sync checks): a REMOTE node's
// status is only reachable via a P2P round trip issued from the MCP/coordinator
// layer (mesh_git_status), which this daemon-core event-processing path has no
// handle to. Checking the completing node's OWN daemon only (no P2P) keeps this
// a pure local filesystem read — cheap, no network. A remote node's completion
// is left unchecked (fails open) by resolveLocalCodeChangeWorkspace's isLocal guard.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { LOG } from '../logging/logger.js';
import { daemonIdsEquivalent, expandDaemonIdForms, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { appendLedgerEntry } from './mesh-ledger.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import { MESH_TASK_MODES, type MeshTaskMode } from './mesh-work-queue.js';

const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git';

function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Mirrors resolveCoordinatorDrainDaemonIds in mesh-event-forwarding.ts: every
// id form this daemon answers to, so a node's daemonId can be compared for
// local-machine equivalence regardless of which form it was stamped in.
function resolveLocalDaemonIds(components: DaemonComponents): string[] {
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const machineId = readNonEmptyString(loadConfig().machineId);
    return expandDaemonIdForms([statusInstanceId, machineId]);
}

/**
 * Resolve a code_change task's node to a LOCAL workspace path, or undefined if
 * the node is unresolvable, has no workspace, or is not this daemon (remote —
 * no local filesystem access, no P2P transport on this path). Shared by the
 * async diagnostic scheduler and the sync state-gating check so the two can
 * never disagree about which nodes are in scope.
 */
export function resolveLocalCodeChangeWorkspace(
    components: DaemonComponents,
    meshId: string,
    nodeId: string | undefined,
): string | undefined {
    if (!nodeId) return undefined;
    const mesh = getMesh(meshId);
    const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, nodeId));
    const workspace = readNonEmptyString(node?.workspace);
    if (!workspace) return undefined;

    const nodeDaemonId = node ? readMeshNodeDaemonId(node as unknown as Record<string, unknown>) : undefined;
    if (nodeDaemonId) {
        const localDaemonIds = resolveLocalDaemonIds(components);
        const isLocal = localDaemonIds.some((id) => daemonIdsEquivalent(id, nodeDaemonId));
        if (!isLocal) return undefined;
    }
    return workspace;
}

export interface SyncGitEvidenceResult {
    /** True when the check actually ran to completion (repo resolved, status/log read). */
    checked: boolean;
    /**
     * True when there is NO evidence of a change attributable to this task: the working
     * tree has no diff AND no commit landed since `sinceIso`. False means evidence WAS
     * found — either a dirty tree or a fresh commit. Only meaningful when checked===true.
     */
    noEvidenceSinceDispatch: boolean;
    /**
     * Diagnostic-only breakdown of what was actually observed, so a caller can log/report
     * WHY noEvidenceSinceDispatch resolved the way it did instead of only the verdict.
     */
    detail: {
        dirty: boolean;
        /** True when `git log -1` shows a commit strictly after `sinceIso`. */
        newCommitSinceDispatch: boolean;
        /** Last-commit ISO timestamp, when readable. */
        lastCommitAt?: string;
    };
}

/**
 * Bounded, synchronous, fail-open git-evidence probe for a code_change completion.
 * Used ONLY by mesh-event-forwarding.ts's markSessionTerminal to gate the terminal
 * state decision itself (see the file-header note above for why this needs a sync
 * form distinct from the async getGitRepoStatus()).
 *
 * DEEPER THAN A CLEAN/DIRTY CHECK (gap 2 fix): a plain "is the tree dirty" check has
 * two independent false results:
 *   - FALSE POSITIVE (flags a genuinely good completion): a worker that COMMITS its
 *     change leaves a perfectly clean working tree — plain dirty-check would flag this
 *     as "no evidence" even though real work landed. Reading the last commit timestamp
 *     and comparing it to `sinceIso` (the task's dispatch/assign time) fixes this.
 *   - FALSE NEGATIVE (misses a false completion): ANY dirty file counts as "evidence"
 *     under a bare dirty check — stale leftovers from a PRIOR task, or a subagent that
 *     "delegated and scribbled something" unrelated, both pass. Comparing dirty files'
 *     mtimes against `sinceIso` narrows this to changes that happened DURING this task's
 *     window, not merely present at some point in the workspace's history.
 * This is still not a semantic "did the worker do the RIGHT thing" check — see the
 * dirtyDetectionDepth limitation in the fix report — but it is materially deeper than
 * clean-vs-dirty: it requires the evidence to be TIME-ATTRIBUTABLE to this task.
 *
 * Fails open (`{checked:false, ...}`) on ANY git error, non-zero exit, or timeout —
 * including a workspace that is not a git repository. Callers MUST treat checked:false
 * as "no evidence either way", never as a positive or negative verdict. `timeoutMs`
 * bounds the worst case this can add to the synchronous completion path; keep it short.
 */
export function checkGitEvidenceSync(workspace: string, sinceIso: string | undefined, timeoutMs: number): SyncGitEvidenceResult {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
        const statusOutput = execFileSync(GIT, ['status', '--porcelain=v2'], {
            cwd: workspace,
            encoding: 'utf8',
            timeout: remaining(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const changedPaths = parsePorcelainV2Paths(statusOutput);
        const dirty = changedPaths.length > 0;

        // FALSE-POSITIVE FIX: a clean tree with a commit newer than dispatch is real
        // evidence (the worker committed), not "no side effects". Read unconditionally
        // (cheap — a single `git log -1`) so a committed-and-clean completion is never
        // mistaken for a no-op one.
        let lastCommitAt: string | undefined;
        let newCommitSinceDispatch = false;
        try {
            const logOutput = execFileSync(GIT, ['log', '-1', '--format=%cI'], {
                cwd: workspace,
                encoding: 'utf8',
                timeout: remaining(),
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            if (logOutput) {
                lastCommitAt = logOutput;
                if (sinceIso) {
                    const commitMs = Date.parse(logOutput);
                    const sinceMs = Date.parse(sinceIso);
                    if (Number.isFinite(commitMs) && Number.isFinite(sinceMs)) {
                        // `%cI` (strict ISO 8601) is SECOND-precision — git's commit timestamp
                        // carries no milliseconds, a structural limit of git itself (not fixable
                        // by reading a different format). A commit made within the same wall-clock
                        // SECOND as dispatch is genuinely ambiguous from this signal alone: it could
                        // be the pre-existing HEAD (dispatch landed a moment after repo setup) or a
                        // brand-new commit (a very fast worker). Resolve the ambiguity conservatively
                        // toward "not proven new" (strict > only, no floor/tolerance) — this can
                        // under-detect a same-second real commit, but the dirty-file mtime check
                        // below independently covers the far more common "worker edited but hasn't
                        // committed yet" case, and a completion this fast is itself unusual enough
                        // that the code_change git-evidence gate is not the primary safety net for
                        // it. Sub-second commit precision does not exist in git — this is a
                        // documented limitation, not an oversight (see dirtyDetectionDepth in the
                        // fix report).
                        newCommitSinceDispatch = commitMs > sinceMs;
                    }
                }
            }
        } catch {
            // No commits yet (unborn HEAD) or log failed — leave newCommitSinceDispatch
            // false; the dirty-file mtime check below is still evaluated independently.
        }

        // FALSE-NEGATIVE NARROWING: a dirty tree is only real evidence FOR THIS TASK if
        // at least one changed file's mtime is after sinceIso — otherwise it is
        // indistinguishable from stale leftovers the workspace already carried in from a
        // prior task. Best-effort: stat() failures (deleted/renamed paths, permission
        // issues) are skipped rather than failing the whole probe — a path git reports as
        // changed but that can't be stat'd is conservatively treated as NOT proving
        // recency (it does not clear noEvidenceSinceDispatch on its own).
        let dirtyAttributableToDispatch = dirty && !sinceIso; // no dispatch time to compare against → cannot narrow, fall back to bare dirty
        if (dirty && sinceIso) {
            const sinceMs = Date.parse(sinceIso);
            if (Number.isFinite(sinceMs)) {
                for (const rel of changedPaths) {
                    if (Date.now() > deadline) break; // stay inside the caller's bound
                    try {
                        const st = statSync(path.join(workspace, rel));
                        if (st.mtimeMs >= sinceMs) { dirtyAttributableToDispatch = true; break; }
                    } catch { /* path unreadable (deleted/renamed) — skip, don't fail the probe */ }
                }
            } else {
                dirtyAttributableToDispatch = true; // unparseable sinceIso — fall back to bare dirty rather than silently dropping evidence
            }
        }

        const hasEvidence = dirtyAttributableToDispatch || newCommitSinceDispatch;
        return {
            checked: true,
            noEvidenceSinceDispatch: !hasEvidence,
            detail: { dirty, newCommitSinceDispatch, ...(lastCommitAt ? { lastCommitAt } : {}) },
        };
    } catch (e: any) {
        LOG.warn('MeshLedger', `Sync git-evidence check skipped for workspace ${workspace}: ${e?.message || e}`);
        return { checked: false, noEvidenceSinceDispatch: false, detail: { dirty: false, newCommitSinceDispatch: false } };
    }
}

/** Parse `git status --porcelain=v2` output into the list of changed file paths (relative). */
function parsePorcelainV2Paths(output: string): string[] {
    const paths: string[] = [];
    for (const line of output.split('\n')) {
        if (!line) continue;
        if (line.startsWith('? ')) { paths.push(line.slice(2).trim()); continue; }
        if (line.startsWith('1 ') || line.startsWith('2 ')) {
            const fields = line.split(' ');
            const rest = fields.slice(line.startsWith('2 ') ? 9 : 8).join(' ');
            // A rename ('2 ' entries) separates old/new paths with a tab; take the new path.
            const filePath = rest.split('\t')[0];
            if (filePath) paths.push(filePath);
        }
    }
    return paths;
}

// ─── Per-taskMode completion-evidence strategy (structural registry) ──────
//
// FALSE-COMPLETION-GIT-EVIDENCE gap 1: a completion is trusted purely off the worker's
// self-reported transcript shape for EVERY task mode, not just code_change — a worker
// that delegates to a subagent and returns can self-report "done" with nothing actually
// verified regardless of mode. There is no single evidence check that fits every mode
// (code_change: git; a read-only investigation: the ABSENCE of git changes; a test run:
// something this codebase does not independently observe at all today), so the mapping
// from taskMode to evidence STRATEGY is made structural — a Record<MeshTaskMode, ...>
// literal — rather than left as an if/else chain a reader has to trust is exhaustive.
// `MESH_TASK_MODES` (mesh-work-queue.ts) is iterated at module load via
// assertTaskModeEvidenceStrategyIsExhaustive() so a 6th mode added to that enum without a
// matching entry here fails FAST (a thrown error at import time) instead of silently
// falling through to "unhandled". THIS is the answer to "where does a future validation
// evidence hook get wired in": add a 'checkable' entry here with its own checker function,
// nothing else in mesh-event-forwarding.ts needs to change (see resolveTaskModeEvidence).
export type TaskModeEvidenceKind =
    // A real, independent (worker-unfalsifiable) evidence check exists and runs.
    | 'checkable'
    // No independent evidence hook exists anywhere in this codebase today for this mode's
    // completion path — a genuine, reported limitation (see the per-mode reason string),
    // not silently-treated-as-verified. Never sets reviewRecommended (see the "cry wolf"
    // note on notifyOnUnverified below); the ledger still records evidenceScope so the gap
    // is visible to anyone reading the payload, and so a future evidence hook has an
    // obvious slot: flip evidenceKind to 'checkable' and provide a checker.
    | 'not_applicable_today'
    // No side effects is the CORRECT, expected outcome for this mode — evidence-checking
    // is structurally inapplicable (there is nothing to prove happened). Never checked,
    // never scope-marked, never flagged.
    | 'no_evidence_expected';

export interface TaskModeEvidenceStrategy {
    mode: MeshTaskMode;
    kind: TaskModeEvidenceKind;
    /** Human-readable justification, surfaced in the evidenceScope ledger marker's sibling field. */
    reason: string;
    /**
     * Whether a `not_applicable_today` verdict should also set reviewRecommended (surfacing
     * a verify note to the coordinator on EVERY completion of this mode), vs. staying a
     * silent ledger-only marker. Deliberately false for validation/launch_app/convergence —
     * flagging every single completion of an entire task mode would make the warning routine
     * noise the coordinator learns to ignore (the boy-who-cried-wolf failure mode), which
     * defeats the point of a review flag more thoroughly than never emitting one. The
     * declaration surviving in completionDiagnostic.evidenceScope already satisfies "don't
     * silently pass" — visible to anyone who reads the ledger/payload, without training the
     * coordinator to tune out routine noise. Never true for 'checkable' or
     * 'no_evidence_expected' kinds (irrelevant to them).
     */
    notifyOnUnverified: boolean;
}

// Deliberately typed as `Record<MeshTaskMode, ...>` (not `Partial<...>`) so TypeScript
// itself rejects an incomplete map at compile time — the exhaustiveness guarantee this
// registry exists to provide is enforced by the type checker, not only the runtime assert
// below (defense in depth: the runtime assert also catches a MeshTaskMode value added
// without a matching build having run yet, e.g. mixed dist/src versions).
export const TASK_MODE_EVIDENCE_STRATEGY: Record<MeshTaskMode, TaskModeEvidenceStrategy> = {
    code_change: {
        mode: 'code_change',
        kind: 'checkable',
        reason: 'A real code change leaves a git trace (dirty file or new commit) attributable to this dispatch.',
        notifyOnUnverified: false, // irrelevant — 'checkable' path sets reviewRecommended directly on a real miss
    },
    live_debug_readonly: {
        mode: 'live_debug_readonly',
        kind: 'no_evidence_expected',
        reason: "No side effects is the CORRECT outcome — the write guardrail (mesh-task-mode-guardrail.ts) forbids mutation for this mode in the first place.",
        notifyOnUnverified: false,
    },
    validation: {
        mode: 'validation',
        kind: 'not_applicable_today',
        reason: "validationResults is parsed verbatim from the worker's own self-reported JSON footer (normalizeValidationResults, mesh-ledger.ts) — no real command execution or exit code is captured independently, tied to task completion.",
        notifyOnUnverified: false,
    },
    launch_app: {
        mode: 'launch_app',
        kind: 'not_applicable_today',
        reason: 'processArtifacts (pid/port/url) is self-reported with no liveness probe (port scan, process check, HTTP GET) tied to task completion.',
        notifyOnUnverified: false,
    },
    convergence: {
        mode: 'convergence',
        kind: 'not_applicable_today',
        reason: "Real, independent git-ancestry evidence exists (mesh-fast-forward.ts's fastForwardMeshNode) but lives solely on the separate mesh_fast_forward command path — never invoked from task completion. Also: unlike code_change, a convergence task's workspace being CLEAN is the NORMAL post-merge state, so the code_change git-clean check cannot simply be reused here without inverting its own signal.",
        notifyOnUnverified: false,
    },
};

/** Module-load-time exhaustiveness guard — see the registry's own doc comment above. */
function assertTaskModeEvidenceStrategyIsExhaustive(): void {
    const missing = MESH_TASK_MODES.filter((mode) => !(mode in TASK_MODE_EVIDENCE_STRATEGY));
    if (missing.length > 0) {
        throw new Error(`TASK_MODE_EVIDENCE_STRATEGY is missing an entry for taskMode(s): ${missing.join(', ')} — every MeshTaskMode must have a completion-evidence strategy (see mesh-completion-side-effect-evidence.ts)`);
    }
}
assertTaskModeEvidenceStrategyIsExhaustive();

/** Resolve a taskMode's evidence strategy, defaulting unknown/legacy string values to 'not_applicable_today' (conservative — never silently 'verified'). */
export function resolveTaskModeEvidenceStrategy(mode: string | undefined): TaskModeEvidenceStrategy {
    if (mode && mode in TASK_MODE_EVIDENCE_STRATEGY) return TASK_MODE_EVIDENCE_STRATEGY[mode as MeshTaskMode];
    return {
        mode: (mode as MeshTaskMode) ?? ('code_change' as MeshTaskMode), // placeholder; kind carries the real signal
        kind: 'not_applicable_today',
        reason: `Unrecognized or absent taskMode ('${mode ?? 'undefined'}') — no evidence strategy is registered for it.`,
        notifyOnUnverified: false,
    };
}

/**
 * FALSE-COMPLETION-GIT-EVIDENCE (gap 1 — per-taskMode evidence, not a code_change-only
 * special case): a GENUINE (non-weak) `completed` outcome is otherwise trusted purely off
 * the worker's self-reported transcript shape for EVERY task mode, not only code_change —
 * a worker that delegates to a subagent and returns can self-report completion with
 * nothing actually done regardless of mode. Dispatches on TASK_MODE_EVIDENCE_STRATEGY
 * (this file's structural registry — see its own doc comment for how a future evidence
 * hook gets wired in) and MUTATES `metadataEvent` in place exactly like the code_change
 * gate always has: stamping reviewRecommended/evidenceLevel/completionDiagnostic so the
 * signal rides the already-wired reviewRecommended plumbing (buildMeshSystemMessage's
 * coordinator verify note, the ledger's evidenceLevel/reviewRecommended fields) — no new
 * status value.
 *
 * Factored OUT of mesh-event-forwarding.ts's markSessionTerminal (which only calls this
 * one function) for two reasons: (1) that file is SHARED with other workers' concurrent
 * changes — keeping its footprint to one call site minimizes merge-conflict surface; (2)
 * this file already owns every other piece of the false-completion-evidence domain
 * (checkGitEvidenceSync, resolveLocalCodeChangeWorkspace, the strategy registry), so the
 * per-mode dispatch belongs here too.
 *
 * Fail-open throughout: any git-check failure/timeout/remote-node is caught internally
 * and never propagates — a caller only needs to invoke this and move on, exactly as
 * before extraction.
 */
export function applyTaskModeCompletionEvidence(
    components: DaemonComponents,
    args: {
        meshId: string;
        nodeId?: string;
        meshNodeId?: string;
        sessionId: string;
        taskId: string;
        taskMode: string | undefined;
        preFlipAssignedAt: string | undefined;
        timeoutMs: number;
        metadataEvent: Record<string, unknown>;
    },
): void {
    if (!args.taskMode) return;
    const strategy = resolveTaskModeEvidenceStrategy(args.taskMode);
    const setCompletionDiagnostic = (extra: Record<string, unknown>) => {
        args.metadataEvent.completionDiagnostic = {
            ...(args.metadataEvent.completionDiagnostic && typeof args.metadataEvent.completionDiagnostic === 'object'
                ? args.metadataEvent.completionDiagnostic as Record<string, unknown>
                : {}),
            ...extra,
        };
    };
    if (strategy.kind === 'checkable' && args.taskMode === 'code_change') {
        try {
            const gateNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.meshNodeId);
            const workspace = resolveLocalCodeChangeWorkspace(components, args.meshId, gateNodeId);
            if (workspace) {
                const gitCheck = checkGitEvidenceSync(workspace, args.preFlipAssignedAt, args.timeoutMs);
                if (gitCheck.checked && gitCheck.noEvidenceSinceDispatch) {
                    args.metadataEvent.reviewRecommended = true;
                    args.metadataEvent.evidenceLevel = readNonEmptyString(args.metadataEvent.evidenceLevel) || 'reported';
                    setCompletionDiagnostic({ noSideEffectsAtCompletion: true, evidenceScope: 'code_change_git' });
                    LOG.info('MeshLedger', `code_change task ${args.taskId} (session ${args.sessionId}) completed with NO git evidence attributable to this dispatch — flagged reviewRecommended (${JSON.stringify(gitCheck.detail)})`);
                }
            }
        } catch (e: any) {
            // Fail-open: never let this probe surface as a task failure or block/delay the
            // completion path it is only meant to annotate.
            LOG.warn('MeshLedger', `False-completion git evidence check skipped for task ${args.taskId} (session ${args.sessionId}): ${e?.message || e}`);
        }
    } else if (strategy.kind === 'not_applicable_today') {
        // No independent evidence hook exists today for this mode (reason carried on the
        // strategy entry) — mark the scope explicitly so a consumer can distinguish "checked
        // and clean" from "never checkable" rather than reading silence as verified.
        // Deliberately NOT reviewRecommended by default (notifyOnUnverified is false for
        // every registered mode today) — flagging EVERY completion of an entire task mode
        // would make the warning routine noise the coordinator learns to ignore, defeating
        // the point of a review flag more thoroughly than never emitting one. The declaration
        // surviving in the ledger payload already satisfies "don't silently pass" without
        // training the coordinator to tune out routine noise.
        setCompletionDiagnostic({ evidenceScope: 'not_applicable_for_mode', evidenceScopeReason: strategy.reason });
        if (strategy.notifyOnUnverified) {
            args.metadataEvent.reviewRecommended = true;
        }
    } else if (strategy.kind === 'no_evidence_expected' && args.taskMode === 'live_debug_readonly') {
        // READONLY-CONTRACT-VIOLATION (owner-requested extension): the inverse of the
        // code_change check — for a read-only task, git EVIDENCE (not its absence) is the
        // anomaly. isTaskReadonly / mesh-task-mode-guardrail.ts already reject an obviously
        // mutating INSTRUCTION at enqueue time by matching keywords in the task message; this
        // is the completion-time counterpart that catches what the text guardrail cannot — an
        // ACTUAL file write regardless of what the message said (an approval-bypassed edit, a
        // provider tool that mutates despite the read-only instruction, a stray write from an
        // unrelated background process). Same attribution logic as code_change
        // (checkGitEvidenceSync + preFlipAssignedAt) so a workspace already dirty BEFORE this
        // task's dispatch (a prior task's leftover) is not blamed on this one. Same
        // fail-open/local-only/bounded-timeout guarantees as the code_change path.
        try {
            const gateNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.meshNodeId);
            const workspace = resolveLocalCodeChangeWorkspace(components, args.meshId, gateNodeId);
            if (workspace) {
                const gitCheck = checkGitEvidenceSync(workspace, args.preFlipAssignedAt, args.timeoutMs);
                if (gitCheck.checked && !gitCheck.noEvidenceSinceDispatch) {
                    args.metadataEvent.reviewRecommended = true;
                    args.metadataEvent.evidenceLevel = readNonEmptyString(args.metadataEvent.evidenceLevel) || 'reported';
                    setCompletionDiagnostic({ readonlyContractViolation: true, evidenceScope: 'live_debug_readonly_git' });
                    LOG.warn('MeshLedger', `live_debug_readonly task ${args.taskId} (session ${args.sessionId}) completed with git evidence attributable to this dispatch — a read-only task should have produced NONE; flagged reviewRecommended (${JSON.stringify(gitCheck.detail)})`);
                }
            }
        } catch (e: any) {
            LOG.warn('MeshLedger', `Readonly-contract-violation check skipped for task ${args.taskId} (session ${args.sessionId}): ${e?.message || e}`);
        }
    }
}

export function scheduleTaskCompletionSideEffectEvidence(
    components: DaemonComponents,
    args: {
        meshId: string;
        taskId?: string;
        taskMode?: string;
        sessionId?: string;
        nodeId?: string;
    },
): void {
    if (args.taskMode !== 'code_change') return;
    if (!args.taskId) return;
    const nodeId = args.nodeId;
    if (!nodeId) return;

    setImmediate(() => {
        (async () => {
            try {
                // Fail-open, local-only: a node whose daemonId isn't one of THIS daemon's
                // own forms is remote — skip rather than attempt a P2P round trip this path
                // has no transport for (cost guard: never block/slow completion delivery).
                const workspace = resolveLocalCodeChangeWorkspace(components, args.meshId, nodeId);
                if (!workspace) return;

                // NOTE: this async path intentionally stays a bare dirty check (no commit-time
                // comparison like checkGitEvidenceSync's sync counterpart) — by the time this
                // setImmediate callback runs, updateSessionTaskStatus has ALREADY overwritten the
                // queue row's updatedAt to the completion timestamp, so there is no reliable
                // dispatch-time reference left to compare against here. That timing gap is exactly
                // why the deeper, sinceIso-aware check had to move into markSessionTerminal itself
                // (synchronous, BEFORE the flip) — see mesh-event-forwarding.ts's preFlipAssignedAt
                // capture. This async path remains a lower-fidelity, purely diagnostic ledger note.
                const status = await getGitRepoStatus(workspace, { includeSubmodules: false });
                if (!status.isGitRepo) return;
                if (status.dirty) return; // has a diff — evidence is already consistent, nothing to downgrade

                appendLedgerEntry(args.meshId, {
                    kind: 'task_completion_no_side_effects',
                    nodeId,
                    sessionId: args.sessionId,
                    taskId: args.taskId,
                    payload: {
                        taskId: args.taskId,
                        sessionId: args.sessionId,
                        nodeId,
                        workspace,
                        gitDirty: false,
                        changedFiles: 0,
                        reason: 'no_side_effects',
                    },
                });
            } catch (e: any) {
                // Fail-open: this is purely diagnostic. Never let a git error surface as a
                // task failure or slow down/interrupt the completion path.
                LOG.warn('MeshLedger', `Skipped completion side-effect evidence check for task ${args.taskId}: ${e?.message || e}`);
            }
        })();
    });
}
