// ---------------------------------------------------------------------------
// mesh-worktree-retention — lifecycle retention Slice 2: safe automatic
// removal of CONVERGED local worktree nodes.
// ---------------------------------------------------------------------------
// Slice 1 (mesh-retention-config.ts / mesh-disk-retention.ts) reclaimed only
// inert bytes (SQLite rows, closed ledger rotations, stale backups) and
// explicitly kept worktree cleanup manual/coordinator-driven. Slice 2 closes
// the remaining growth: worktree clone nodes whose feature branch is PROVEN
// merged/pushed/converged would otherwise linger (node + worktree dir + git
// worktree registration) forever.
//
// Safety contract (see docs/plans + task spec):
//   1. CANDIDATES: only local `isLocalWorktree` nodes whose branch convergence
//      is proven (via the existing getWorktreeForceCleanupConvergence
//      authority: externally recorded metadata, git merge-base containment, or
//      patch-equivalence) and that have been observed eligible on at least TWO
//      separate retention passes spanning at least the configured grace
//      (default 48h, clamped, 0 disables — resolveWorktreeNodeRetentionGraceMs).
//   2. HARD EXCLUSIONS (reason-coded, fail-closed): base/non-worktree nodes,
//      coordinator identity, evidence/retention worktrees, nodes owned by a
//      remote daemon, the current process cwd, active/pending/assigned/direct
//      queue references, in-flight Refinery jobs, blocked_review state, any
//      live/starting/generating/waiting/idle retained session, every precheck
//      refusal (dirty/conflicted/unmerged content, missing metadata,
//      unexpected path, branch mismatch), stashes, submodule drift, and any
//      missing/stale/unproven upstream convergence proof. A node that fails
//      ANY check is skipped with a per-node reason code — never forced.
//   3. DRY-RUN BY DEFAULT: planning is read-only and idempotent; the same
//      tickId never double-counts a pass. Execution requires an explicit
//      execute flag, a durable lease (so two passes/daemons cannot remove the
//      same node concurrently), and a re-run of the non-destructive precheck
//      immediately before the destructive step (plan→execute race guard).
//   4. REUSE, NEVER FORCE: execution reuses the exact mesh_remove_node
//      building blocks — precheckLocalWorktreeRemovable,
//      cleanupLocalWorktreeNode (requireClean, branch refs deleted ONLY when
//      proven fully merged), removeNode + ledger 'node_removed' — so mesh
//      membership and the git worktree registry stay as atomic/recoverable as
//      the manual path. `force` is never passed.
//   5. RESTART-SAFE: the two-pass proof and leases live in a durable JSON
//      state file under the mesh-ledger dir (atomic tmp+rename writes; a
//      corrupt file degrades to an empty proof, never to a removal). Partial
//      failures are recoverable: an already-removed worktree / already-missing
//      membership are idempotent success cases, and an expired lease simply
//      lets the next pass retry.
//   6. CONTENT-FREE OBSERVABILITY: metrics/logs carry counts and reason codes
//      only — never file contents, diffs, or task text.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { hostname } from 'os';
import { join as pathJoin, resolve as pathResolve, sep as pathSep } from 'path';
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { loadConfig } from '../config/config.js';
import { removeNode as removeNodeFromMeshConfig } from '../config/mesh-config.js';
import { appendLedgerEntry, getLedgerDir, readLedgerEntries, type MeshLedgerEntry } from './mesh-ledger.js';
import { getQueue, getActiveDirectDispatches, type DirectDispatchRecord, type MeshWorkQueueEntry } from './mesh-work-queue.js';
import { buildMeshAsyncRefineJobs } from './mesh-refine-status.js';
import { hasBlockedReviewRefineResult } from './mesh-review-inbox.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import {
    resolveWorktreeNodeRetentionGraceMs,
    resolveWorktreeNodeRetentionLeaseMs,
} from './mesh-retention-config.js';
import type {
    CleanupLocalWorktreeNodeResult,
    WorktreeRemovalPrecheckResult,
} from '../commands/med-family/types.js';

const LOG_CATEGORY = 'WorktreeRetention';

// ─── Reason codes ────────────────────────────────────────────────────────────
// Every plan entry carries exactly one reason code. 'candidate' means the node
// passed every exclusion check; anything else is a skip. Precheck refusal
// codes (mesh_worktree_cleanup_*) pass through unchanged so the manual
// mesh_remove_node surface and this plan speak the same vocabulary.
export type WorktreeRetentionReasonCode =
    | 'candidate'
    | 'retention_disabled'
    | 'not_local_worktree'
    | 'coordinator_identity'
    | 'evidence_retention_worktree'
    | 'remote_node'
    | 'process_cwd_reference'
    | 'queue_reference'
    | 'review_inflight'
    | 'blocked_review'
    | 'live_session'
    | 'stash_present'
    | 'submodule_drift'
    | 'probe_failed'
    | 'convergence_unproven'
    | 'lease_held'
    // pass-through precheck refusal codes:
    | 'mesh_worktree_cleanup_missing_workspace'
    | 'mesh_worktree_cleanup_missing_source_repo'
    | 'mesh_worktree_cleanup_missing_branch'
    | 'mesh_worktree_cleanup_unexpected_path'
    | 'mesh_worktree_cleanup_branch_mismatch'
    | 'mesh_worktree_cleanup_dirty'
    // execution outcomes (only on entries an execute pass attempted):
    | 'execution_precheck_refused'
    | 'execution_cleanup_failed'
    | 'execution_membership_not_removed';

/** Convergence verdict mirrored from getWorktreeForceCleanupConvergence. */
export interface WorktreeRetentionConvergence {
    allow: boolean;
    status?: string;
    source?: string;
    ref?: string;
    error?: string;
}

export interface WorktreeRetentionPlanEntry {
    nodeId: string;
    /** True only when the node passed EVERY exclusion check this pass. */
    candidate: boolean;
    reasonCode: WorktreeRetentionReasonCode | string;
    /** Human-facing explanation; identifiers and codes only, never content. */
    detail?: string;
    convergence?: WorktreeRetentionConvergence;
    /** Two-pass/grace bookkeeping (present for candidates). */
    auto?: {
        passCount: number;
        firstPassAt?: number;
        eligibleAt?: number;
        /** Two DISTINCT passes recorded AND grace elapsed since firstPassAt. */
        autoEligible: boolean;
        leaseHeld?: boolean;
        leaseOwner?: string;
    };
    /** Present only when an execute pass attempted this node. */
    execution?: {
        attempted: true;
        success: boolean;
        code?: string;
        error?: string;
        removed?: boolean;
        skipped?: boolean;
        residue?: boolean;
        branchRefDeleted?: boolean;
        branchRefReason?: string;
    };
}

export interface WorktreeRetentionTickSummary {
    scanned: number;
    candidates: number;
    skipped: number;
    autoEligible: number;
    removed: number;
    removalFailures: number;
    leaseConflicts: number;
    byReason: Record<string, number>;
}

export interface WorktreeRetentionTickResult {
    meshId: string;
    tickId: string;
    dryRun: boolean;
    executeMode: 'auto' | 'manual';
    graceMs: number;
    entries: WorktreeRetentionPlanEntry[];
    summary: WorktreeRetentionTickSummary;
}

/**
 * Router-shaped collaborators the retention pass needs. Both
 * `DaemonCommandRouter` (reconcile tick) and an adapter over `MedFamilyContext`
 * (cleanup_worktree_nodes wire handler) satisfy this structurally; tests
 * inject fakes. All methods are the EXISTING mesh_remove_node building blocks.
 */
export interface WorktreeRetentionDeps {
    precheckLocalWorktreeRemovable(args: {
        mesh: any; node: any; nodeId: string; force?: boolean;
    }): Promise<WorktreeRemovalPrecheckResult>;
    cleanupLocalWorktreeNode(args: {
        mesh: any; node: any; nodeId: string; force?: boolean;
    }): Promise<CleanupLocalWorktreeNodeResult>;
    getWorktreeForceCleanupConvergence(args: {
        repoRoot: string; workspace: string; node: any;
    }): Promise<WorktreeRetentionConvergence>;
    /** Optional; when absent the session-liveness check is skipped-open ONLY
     *  if `sessions` is injected, otherwise the node is skipped fail-closed. */
    listSessions?(): Promise<any[]>;
    /** Best-effort stopped-session record cleanup at execute time. */
    cleanupMeshSessions?(args: {
        meshId: string; nodeId: string; node: any; mode: string; source?: string;
    }): Promise<{ success: boolean; [key: string]: unknown }>;
    /** Inline-cache membership mirror (keeps a warmed cache from resurrecting
     *  a file-removed node — MESH-MEMBERSHIP-INLINE-CACHE-SYNC). */
    getCachedInlineMesh?(meshId: string): any | undefined;
    removeInlineMeshNode?(meshId: string, mesh: any, nodeId: string): boolean;
    invalidateAggregateMeshStatus?(meshId: string): void;
}

export interface WorktreeRetentionTickOptions {
    mesh: any;
    nowMs: number;
    /** Distinct per retention pass. A re-run with the SAME tickId is idempotent
     *  (no additional pass counted) so a retried tick cannot fake the two-pass
     *  proof. */
    tickId: string;
    /** Default false — planning/recording only, nothing destructive. */
    execute?: boolean;
    /**
     * 'auto' (default): execute only candidates that passed the SAME checks on
     * at least two distinct ticks AND whose first pass is older than grace.
     * 'manual': execute any node that passes every exclusion check right now
     * (explicit operator request via cleanup_worktree_nodes dry_run:false).
     * Manual mode still never forces and still re-runs the precheck.
     */
    executeMode?: 'auto' | 'manual';
    /** Restrict the plan to a single node (manual MCP surface). */
    onlyNodeId?: string;
    /**
     * Default true: candidates' two-pass proof is durably recorded/advanced.
     * Pass false for a purely observational plan (the manual MCP dry-run) so
     * that simply LOOKING at the plan never accelerates the removal proof.
     */
    recordPasses?: boolean;
    graceMs?: number;
    leaseMs?: number;
    /** Lease owner identity; default is host/pid-based so a second daemon
     *  sharing the config root cannot collide with this process. */
    owner?: string;
    processCwd?: string;
    localDaemonId?: string;
    // ─── Injectable data sources (production defaults read the live stores) ──
    sessions?: any[];
    queueEntries?: MeshWorkQueueEntry[];
    directDispatches?: DirectDispatchRecord[];
    ledgerEntries?: MeshLedgerEntry[];
    runGit?: (args: string[], cwd: string) => Promise<string>;
    existsSync?: (p: string) => boolean;
    removeNodeFromMesh?: (meshId: string, nodeId: string) => boolean;
}

// ─── Content-free metrics ────────────────────────────────────────────────────
const metrics = {
    ticks: 0,
    nodesScanned: 0,
    candidates: 0,
    skips: 0,
    removed: 0,
    removalFailures: 0,
    leaseConflicts: 0,
};

export function getWorktreeNodeRetentionMetrics(): Readonly<typeof metrics> {
    return { ...metrics };
}

export function __resetWorktreeNodeRetentionMetricsForTests(): void {
    metrics.ticks = 0;
    metrics.nodesScanned = 0;
    metrics.candidates = 0;
    metrics.skips = 0;
    metrics.removed = 0;
    metrics.removalFailures = 0;
    metrics.leaseConflicts = 0;
}

// ─── Durable two-pass / lease state ──────────────────────────────────────────
interface WorktreeRetentionLease {
    owner: string;
    expiresAt: number;
}

interface WorktreeRetentionNodeState {
    firstPassAt: number;
    lastPassAt: number;
    lastTickId: string;
    passCount: number;
    convergenceStatus?: string;
    lease?: WorktreeRetentionLease;
}

interface WorktreeRetentionStateFile {
    version: 1;
    nodes: Record<string, WorktreeRetentionNodeState>;
}

function retentionStatePath(): string {
    return pathJoin(getLedgerDir(), 'worktree-node-retention-state.json');
}

function stateKey(meshId: string, nodeId: string): string {
    return `${meshId}::${nodeId}`;
}

function loadRetentionState(): WorktreeRetentionStateFile {
    try {
        const raw = fs.readFileSync(retentionStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.nodes && typeof parsed.nodes === 'object') {
            return parsed as WorktreeRetentionStateFile;
        }
    } catch { /* missing/corrupt → empty proof; conservative (re-proves over two ticks) */ }
    return { version: 1, nodes: {} };
}

function saveRetentionState(state: WorktreeRetentionStateFile): void {
    const file = retentionStatePath();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch (e: any) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
        throw e;
    }
}

/** Test hook: state is read from disk per call, so this only clears nothing
 *  in-module — it exists so tests can wipe the durable file deterministically. */
export function __deleteWorktreeNodeRetentionStateForTests(): void {
    try { fs.rmSync(retentionStatePath(), { force: true }); } catch { /* best-effort */ }
}

/**
 * Acquire the durable removal lease for a node. Returns false when another
 * owner holds an unexpired lease. A stale (expired) lease is treated as
 * released — the crashed remover's partial work is idempotently recoverable.
 */
export function acquireWorktreeRetentionLease(args: {
    meshId: string; nodeId: string; owner: string; nowMs: number; leaseMs: number;
}): boolean {
    const state = loadRetentionState();
    const key = stateKey(args.meshId, args.nodeId);
    const record = state.nodes[key];
    const lease = record?.lease;
    if (lease && lease.owner !== args.owner && lease.expiresAt > args.nowMs) return false;
    state.nodes[key] = {
        ...(record ?? { firstPassAt: args.nowMs, lastPassAt: args.nowMs, lastTickId: '', passCount: 0 }),
        lease: { owner: args.owner, expiresAt: args.nowMs + args.leaseMs },
    };
    saveRetentionState(state);
    return true;
}

export function releaseWorktreeRetentionLease(args: {
    meshId: string; nodeId: string; owner: string;
}): void {
    const state = loadRetentionState();
    const key = stateKey(args.meshId, args.nodeId);
    const record = state.nodes[key];
    if (record?.lease && record.lease.owner === args.owner) {
        delete record.lease;
        saveRetentionState(state);
    }
}

// ─── Small helpers ───────────────────────────────────────────────────────────
async function defaultRunGit(args: string[], cwd: string): Promise<string> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('git', args, {
        cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    return String(stdout || '');
}

function normalizePathForCompare(value: string): string {
    const resolved = pathResolve(value);
    try { return fs.realpathSync(resolved); } catch { return resolved; }
}

/** Evidence/retention worktrees are operator tooling, never feature work —
 *  marked either explicitly on the node or by branch namespace. */
function isEvidenceOrRetentionWorktree(node: any): boolean {
    if (node?.evidenceWorktree === true || node?.retentionWorktree === true) return true;
    if (node?.purpose === 'evidence' || node?.purpose === 'retention') return true;
    const branch = typeof node?.worktreeBranch === 'string' ? node.worktreeBranch.trim() : '';
    return /^(evidence|retention)[/_-]/i.test(branch);
}

function isCoordinatorIdentityNode(node: any): boolean {
    return node?.coordinator === true
        || node?.isCoordinator === true
        || typeof node?.coordinatorFor === 'string'
        || typeof node?.meshCoordinatorFor === 'string'
        || typeof node?.meta?.meshCoordinatorFor === 'string';
}

/** Session matches this node (mirrors sessionMatchesMeshNode semantics:
 *  workspace equality or meta.meshNodeId binding). */
function sessionMatchesNode(record: any, node: any, nodeId: string): boolean {
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
    if (!sessionId) return false;
    const workspace = typeof node?.workspace === 'string' ? node.workspace : '';
    if (workspace && record?.workspace === workspace) return true;
    if (record?.meta?.meshNodeId === nodeId) return true;
    return false;
}

function resolveSourceRepoRoot(mesh: any, node: any): string {
    const sourceNode = node?.clonedFromNodeId
        ? mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, node.clonedFromNodeId))
        : mesh?.nodes?.find((n: any) => !n.isLocalWorktree);
    return typeof sourceNode?.repoRoot === 'string' && sourceNode.repoRoot.trim()
        ? sourceNode.repoRoot.trim()
        : typeof sourceNode?.workspace === 'string' && sourceNode.workspace.trim()
            ? sourceNode.workspace.trim()
            : '';
}

// ─── Per-node eligibility checks ─────────────────────────────────────────────
async function evaluateNode(
    deps: WorktreeRetentionDeps,
    opts: Required<Pick<WorktreeRetentionTickOptions, 'nowMs' | 'graceMs'>> & WorktreeRetentionTickOptions,
    ctx: {
        meshId: string;
        sessions: any[] | undefined;
        queueEntries: MeshWorkQueueEntry[];
        directDispatches: DirectDispatchRecord[];
        ledgerEntries: MeshLedgerEntry[];
        runGit: (args: string[], cwd: string) => Promise<string>;
        exists: (p: string) => boolean;
        localDaemonId: string;
        processCwd: string;
        graceMs: number;
    },
    node: any,
): Promise<WorktreeRetentionPlanEntry> {
    const mesh = opts.mesh;
    const meshId = ctx.meshId;
    const nodeId = typeof node?.id === 'string' ? node.id : String(node?.id ?? '');
    const skip = (reasonCode: string, detail: string): WorktreeRetentionPlanEntry => ({ nodeId, candidate: false, reasonCode, detail });

    if (ctx.graceMs === 0) {
        return skip('retention_disabled', 'Worktree-node retention is disabled (grace = 0).');
    }
    if (node?.isLocalWorktree !== true) {
        return skip('not_local_worktree', 'Only local worktree clone nodes are retention candidates; base/non-worktree nodes are never auto-removed.');
    }
    if (isCoordinatorIdentityNode(node)) {
        return skip('coordinator_identity', 'Node carries coordinator identity; the coordinator node is never auto-removed.');
    }
    if (isEvidenceOrRetentionWorktree(node)) {
        return skip('evidence_retention_worktree', 'Node is marked as an evidence/retention worktree; excluded from automatic removal.');
    }
    const nodeDaemonId = typeof node?.daemonId === 'string' ? node.daemonId.trim() : '';
    if (nodeDaemonId && ctx.localDaemonId && !daemonIdsEquivalent(nodeDaemonId, ctx.localDaemonId)) {
        return skip('remote_node', 'Worktree is owned by a different daemon; only the owning daemon may retain it.');
    }

    const workspace = typeof node?.workspace === 'string' ? node.workspace.trim() : '';
    if (workspace && ctx.processCwd) {
        const normalizedWorkspace = normalizePathForCompare(workspace);
        const normalizedCwd = normalizePathForCompare(ctx.processCwd);
        if (normalizedCwd === normalizedWorkspace || normalizedCwd.startsWith(normalizedWorkspace + pathSep)) {
            return skip('process_cwd_reference', 'Worktree path is (or contains) the current process working directory; an open-runtime/cwd reference blocks removal.');
        }
    }

    // Queue references: active (pending/assigned) queue rows targeted at or
    // claimed by this node, plus non-terminal direct dispatches pinned to it.
    const queueHit = ctx.queueEntries.some(entry =>
        (entry.status === 'pending' || entry.status === 'assigned')
        && (daemonIdsEquivalent(entry.targetNodeId, nodeId) || daemonIdsEquivalent(entry.assignedNodeId, nodeId)));
    const directHit = ctx.directDispatches.some(d => daemonIdsEquivalent(d.nodeId ?? undefined, nodeId));
    if (queueHit || directHit) {
        return skip('queue_reference', 'An active/pending/assigned queue task or direct dispatch still references this node.');
    }

    // Refinery: an in-flight (accepted/running) refine job or a latest-terminal
    // blocked_review result keeps the node in the review inbox — never remove
    // from under a reviewer.
    const refineJobs = buildMeshAsyncRefineJobs({ meshId, ledgerEntries: ctx.ledgerEntries });
    const inFlight = refineJobs.some(job =>
        (job.status === 'accepted' || job.status === 'running')
        && (daemonIdsEquivalent(job.nodeId, nodeId) || daemonIdsEquivalent(job.targetNodeId, nodeId)));
    if (inFlight) {
        return skip('review_inflight', 'A Refinery job for this node is still in flight.');
    }
    if (hasBlockedReviewRefineResult(nodeId, ctx.ledgerEntries)) {
        return skip('blocked_review', 'The latest refine result for this node is blocked_review; a reviewer has not cleared it.');
    }

    // Sessions: any matched record on the live surface (starting / running /
    // generating / waiting / idle-retained — every live_runtime lifecycle)
    // blocks removal. Stopped/failed/inactive records do not.
    if (ctx.sessions === undefined) {
        return skip('live_session', 'Session inventory unavailable; refusing to plan removal without a liveness check (fail-closed).');
    }
    const liveSession = ctx.sessions.find(record =>
        sessionMatchesNode(record, node, nodeId) && getSessionHostSurfaceKind(record) === 'live_runtime');
    if (liveSession) {
        return skip('live_session', 'A live/starting/generating/waiting/idle retained session is still attached to this node.');
    }

    // Non-destructive removability precheck (the exact mesh_remove_node gate):
    // missing metadata, unexpected path, branch mismatch, dirty/conflicted/
    // unmerged content. Passes-through the refusal code.
    const precheck = await deps.precheckLocalWorktreeRemovable({ mesh, node, nodeId });
    if (precheck.ok === false) {
        return skip(precheck.code, precheck.error);
    }

    // Git-state exclusions that the porcelain dirty guard does not cover:
    // stashed work and submodule HEAD drift (a checked-out submodule commit
    // that differs from the recorded gitlink — invisible to `git status`).
    const workspaceExists = workspace ? ctx.exists(workspace) : false;
    if (workspaceExists) {
        try {
            const stash = await ctx.runGit(['stash', 'list'], workspace);
            if (stash.trim()) {
                return skip('stash_present', 'The worktree has stash entries; stashed work would be silently lost.');
            }
            const submodules = await ctx.runGit(['submodule', 'status', '--recursive'], workspace);
            if (submodules.split('\n').some(line => line.startsWith('+'))) {
                return skip('submodule_drift', 'A submodule is checked out at a commit that differs from the recorded gitlink (drift).');
            }
        } catch (e: any) {
            return skip('probe_failed', `Git probe failed; refusing to plan removal without proof (fail-closed): ${e?.message || e}`);
        }
    }

    // Convergence authority: externally recorded merge convergence (refine
    // final state / recorded branchConvergence) OR live git proof (merge-base
    // containment / patch-equivalence). Missing or stale upstream proof fails
    // closed here — this is also what keeps THIS task's own node protected
    // until its merge convergence is externally recorded.
    const repoRoot = resolveSourceRepoRoot(mesh, node);
    let convergence: WorktreeRetentionConvergence;
    try {
        convergence = await deps.getWorktreeForceCleanupConvergence({ repoRoot, workspace, node });
    } catch (e: any) {
        convergence = { allow: false, error: `convergence check threw: ${e?.message || e}` };
    }
    if (!convergence.allow) {
        return {
            nodeId,
            candidate: false,
            reasonCode: 'convergence_unproven',
            detail: `Merge/push convergence is not proven (missing or stale upstream proof): ${convergence.error || convergence.status || 'unknown'}`,
            convergence,
        };
    }

    return {
        nodeId,
        candidate: true,
        reasonCode: 'candidate',
        detail: `Eligible: convergence proven via ${convergence.source || 'unknown'} (${convergence.status || 'ok'}).`,
        convergence,
    };
}

// ─── Planning (read-only) ────────────────────────────────────────────────────
async function buildPlan(
    deps: WorktreeRetentionDeps,
    opts: WorktreeRetentionTickOptions,
): Promise<WorktreeRetentionPlanEntry[]> {
    const mesh = opts.mesh;
    const meshId = String(mesh?.id || mesh?.name || '');
    const graceMs = opts.graceMs ?? resolveWorktreeNodeRetentionGraceMs();
    const exists = opts.existsSync ?? fs.existsSync;
    const localDaemonId = opts.localDaemonId ?? (() => { try { return readNonEmptyString(loadConfig().machineId) || ''; } catch { return ''; } })();
    const processCwd = opts.processCwd ?? process.cwd();

    let sessions: any[] | undefined = opts.sessions;
    if (sessions === undefined && deps.listSessions) {
        try { sessions = await deps.listSessions(); } catch { sessions = undefined; }
    }
    const queueEntries = opts.queueEntries ?? (() => {
        try { return getQueue(meshId, { status: ['pending', 'assigned'] }); } catch { return []; }
    })();
    const directDispatches = opts.directDispatches ?? (() => {
        try { return getActiveDirectDispatches(meshId); } catch { return []; }
    })();
    const ledgerEntries = opts.ledgerEntries ?? (() => {
        try { return readLedgerEntries(meshId, { tail: 500 }); } catch { return []; }
    })();

    const ctxData = {
        meshId,
        sessions,
        queueEntries,
        directDispatches,
        ledgerEntries,
        runGit: opts.runGit ?? defaultRunGit,
        exists,
        localDaemonId,
        processCwd,
        graceMs,
    };

    const nodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    const selected = opts.onlyNodeId
        ? nodes.filter(n => meshNodeIdMatches(n, opts.onlyNodeId!))
        : nodes;

    const entries: WorktreeRetentionPlanEntry[] = [];
    for (const node of selected) {
        try {
            entries.push(await evaluateNode(deps, { ...opts, nowMs: opts.nowMs, graceMs }, ctxData, node));
        } catch (e: any) {
            // A planning error on one node must never fail the whole pass —
            // and must never accidentally become a candidate.
            entries.push({
                nodeId: typeof node?.id === 'string' ? node.id : String(node?.id ?? ''),
                candidate: false,
                reasonCode: 'probe_failed',
                detail: `Eligibility evaluation failed (fail-closed): ${e?.message || e}`,
            });
        }
    }
    return entries;
}

// ─── Execution (lease + re-precheck + existing removal building blocks) ──────
async function executeNodeRemoval(
    deps: WorktreeRetentionDeps,
    opts: WorktreeRetentionTickOptions,
    entry: WorktreeRetentionPlanEntry,
    owner: string,
    leaseMs: number,
): Promise<void> {
    const mesh = opts.mesh;
    const meshId = String(mesh?.id || mesh?.name || '');
    const nodeId = entry.nodeId;
    const node = (Array.isArray(mesh?.nodes) ? mesh.nodes : []).find((n: any) => meshNodeIdMatches(n, nodeId));
    const fail = (code: string, error: string) => {
        entry.execution = { attempted: true, success: false, code, error };
        metrics.removalFailures++;
    };

    if (!node) {
        // Node vanished between plan and execute — nothing to do; count as
        // idempotent success (membership is the end state we wanted).
        entry.execution = { attempted: true, success: true, removed: true, skipped: true };
        return;
    }

    const acquired = acquireWorktreeRetentionLease({ meshId, nodeId, owner, nowMs: opts.nowMs, leaseMs });
    if (!acquired) {
        const state = loadRetentionState();
        const lease = state.nodes[stateKey(meshId, nodeId)]?.lease;
        entry.reasonCode = 'lease_held';
        entry.detail = 'Another retention pass holds an unexpired removal lease for this node.';
        if (entry.auto) { entry.auto.leaseHeld = true; entry.auto.leaseOwner = lease?.owner; }
        entry.execution = { attempted: true, success: false, code: 'lease_held', error: entry.detail };
        metrics.leaseConflicts++;
        return;
    }

    try {
        // Race guard: re-run the SAME non-destructive precheck immediately
        // before any destructive step — a dirty write landing between plan and
        // execute aborts the removal here.
        const precheck = await deps.precheckLocalWorktreeRemovable({ mesh, node, nodeId });
        if (precheck.ok === false) {
            entry.reasonCode = 'execution_precheck_refused';
            fail(precheck.code, precheck.error);
            return;
        }

        // Stopped-session record cleanup is best-effort and only targets
        // terminal records (live sessions were excluded by the plan AND would
        // fail the cleanup's own guards); never gates removal on its failure.
        if (deps.cleanupMeshSessions) {
            try {
                await deps.cleanupMeshSessions({ meshId, nodeId, node, mode: 'delete_stopped', source: 'mesh_remove_node' });
            } catch { /* best-effort: dead session records never gate worktree removal */ }
        }

        const cleanup = await deps.cleanupLocalWorktreeNode({ mesh, node, nodeId });
        if (cleanup.success === false) {
            entry.reasonCode = 'execution_cleanup_failed';
            fail(cleanup.code, cleanup.error);
            return;
        }

        const removeNodeFromMesh = opts.removeNodeFromMesh ?? ((mid: string, nid: string) =>
            // Splice from the file-backed registry (meshes.json) — the same
            // mutation mesh_remove_node performs.
            removeNodeFromMeshConfig(mid, nid));
        let removed = false;
        try {
            removed = removeNodeFromMesh(meshId, nodeId) === true;
        } catch (e: any) {
            fail('execution_membership_not_removed', `Membership removal threw: ${e?.message || e}`);
            return;
        }
        // Inline-cache mirror: a warmed inline cache must not resurrect the
        // file-removed node (MESH-MEMBERSHIP-INLINE-CACHE-SYNC).
        try {
            const cached = deps.getCachedInlineMesh?.(meshId);
            if (cached && deps.removeInlineMeshNode) {
                if (deps.removeInlineMeshNode(meshId, cached, nodeId)) removed = true;
            }
        } catch { /* best-effort mirror */ }
        if (!removed) {
            entry.reasonCode = 'execution_membership_not_removed';
            fail('execution_membership_not_removed', 'Node was not present in the file registry or inline cache; nothing was removed. The next pass retries (partial-failure recoverable).');
            return;
        }
        try { deps.invalidateAggregateMeshStatus?.(meshId); } catch { /* best-effort */ }

        try {
            appendLedgerEntry(meshId, {
                kind: 'node_removed',
                nodeId,
                payload: {
                    worktree: true,
                    source: 'worktree_node_retention',
                    sessionCleanupMode: 'delete_stopped',
                    workspace: typeof node?.workspace === 'string' ? node.workspace : undefined,
                    daemonId: typeof node?.daemonId === 'string' ? node.daemonId : undefined,
                    worktreeBranch: typeof node?.worktreeBranch === 'string' ? node.worktreeBranch : undefined,
                    convergenceStatus: entry.convergence?.status,
                    convergenceSource: entry.convergence?.source,
                    branchRefDeleted: cleanup.branchRefDeleted === true ? true : undefined,
                    branchRefReason: typeof cleanup.branchRefReason === 'string' ? cleanup.branchRefReason : undefined,
                    forced: false,
                },
            });
        } catch { /* ledger append is best-effort */ }

        entry.execution = {
            attempted: true,
            success: true,
            removed: true,
            ...(cleanup.skipped ? { skipped: true } : {}),
            ...(cleanup.residue ? { residue: true } : {}),
            ...(cleanup.branchRefDeleted !== undefined ? { branchRefDeleted: cleanup.branchRefDeleted } : {}),
            ...(cleanup.branchRefReason ? { branchRefReason: cleanup.branchRefReason } : {}),
        };
        metrics.removed++;

        // Terminal state reached — drop the two-pass record so a future node
        // re-using the id starts a fresh proof.
        const state = loadRetentionState();
        delete state.nodes[stateKey(meshId, nodeId)];
        saveRetentionState(state);
    } finally {
        releaseWorktreeRetentionLease({ meshId, nodeId, owner });
    }
}

// ─── Tick entry point ────────────────────────────────────────────────────────
/**
 * Run one worktree-node retention pass over a mesh: build the reason-coded
 * plan, durably record the two-pass proof for candidates, and — only when
 * `execute` — remove the candidates the mode allows (auto: two passes + grace;
 * manual: any current candidate). Dry-run by default.
 */
export async function runWorktreeNodeRetentionTick(
    deps: WorktreeRetentionDeps,
    opts: WorktreeRetentionTickOptions,
): Promise<WorktreeRetentionTickResult> {
    const meshId = String(opts.mesh?.id || opts.mesh?.name || '');
    const graceMs = opts.graceMs ?? resolveWorktreeNodeRetentionGraceMs();
    const leaseMs = opts.leaseMs ?? resolveWorktreeNodeRetentionLeaseMs();
    const execute = opts.execute === true;
    const executeMode = opts.executeMode ?? 'auto';
    const owner = opts.owner ?? `${hostname()}:${process.pid}:worktree-retention`;

    metrics.ticks++;

    const entries = await buildPlan(deps, { ...opts, graceMs });

    // Two-pass bookkeeping for candidates (durable; restart-safe). A record is
    // only ADVANCED by a distinct tickId, so a retried/duplicated tick is
    // idempotent and cannot fake the proof. A node that fails any check on the
    // current pass has its record reset (unless leased mid-removal), so the
    // proof always reflects CONSECUTIVELY-eligible observations — a stale
    // record can never execute a now-ineligible node. recordPasses:false makes
    // the whole block read-only (observational dry-run).
    const recordPasses = opts.recordPasses !== false;
    const state = loadRetentionState();
    let stateDirty = false;
    for (const entry of entries) {
        const key = stateKey(meshId, entry.nodeId);
        if (!entry.candidate) {
            if (recordPasses && state.nodes[key] && !state.nodes[key].lease) {
                delete state.nodes[key];
                stateDirty = true;
            }
            continue;
        }
        const now = opts.nowMs;
        const existing = state.nodes[key];
        let record: WorktreeRetentionNodeState;
        if (!existing) {
            if (recordPasses) {
                record = { firstPassAt: now, lastPassAt: now, lastTickId: opts.tickId, passCount: 1 };
                state.nodes[key] = record;
                stateDirty = true;
            } else {
                // Observational: show what the proof WOULD look like without
                // recording it (passCount 0 = no durable passes yet).
                record = { firstPassAt: now, lastPassAt: now, lastTickId: opts.tickId, passCount: 0 };
            }
        } else {
            record = existing;
            if (recordPasses) {
                if (record.lastTickId !== opts.tickId) {
                    record.passCount += 1;
                    record.lastTickId = opts.tickId;
                    stateDirty = true;
                }
                if (record.lastPassAt !== now) { record.lastPassAt = now; stateDirty = true; }
                if (record.convergenceStatus !== entry.convergence?.status) {
                    record.convergenceStatus = entry.convergence?.status;
                    stateDirty = true;
                }
            }
        }
        const eligibleAt = record.firstPassAt + graceMs;
        const lease = record.lease;
        const leaseHeld = !!lease && lease.owner !== owner && lease.expiresAt > now;
        entry.auto = {
            passCount: record.passCount,
            firstPassAt: record.firstPassAt,
            eligibleAt,
            autoEligible: record.passCount >= 2 && now >= eligibleAt && !leaseHeld,
            ...(leaseHeld ? { leaseHeld: true, leaseOwner: lease?.owner } : {}),
        };
        if (leaseHeld) metrics.leaseConflicts++;
    }
    if (stateDirty) {
        try { saveRetentionState(state); } catch (e: any) {
            LOG.warn(LOG_CATEGORY, `Failed to persist retention state for mesh ${meshId}: ${e?.message || e}`);
        }
    }

    // Execution: dry-run by default; only explicit execute removes anything.
    if (execute && graceMs > 0) {
        for (const entry of entries) {
            if (!entry.candidate) continue;
            const allowed = executeMode === 'manual' ? true : entry.auto?.autoEligible === true;
            if (!allowed) continue;
            try {
                await executeNodeRemoval(deps, opts, entry, owner, leaseMs);
            } catch (e: any) {
                entry.execution = { attempted: true, success: false, code: 'execution_error', error: String(e?.message || e) };
                metrics.removalFailures++;
            }
        }
    }

    const summary: WorktreeRetentionTickSummary = {
        scanned: entries.length,
        candidates: 0,
        skipped: 0,
        autoEligible: 0,
        removed: 0,
        removalFailures: 0,
        leaseConflicts: 0,
        byReason: {},
    };
    for (const entry of entries) {
        summary.byReason[entry.reasonCode] = (summary.byReason[entry.reasonCode] ?? 0) + 1;
        if (entry.candidate) {
            summary.candidates++;
            if (entry.auto?.autoEligible) summary.autoEligible++;
        } else {
            summary.skipped++;
        }
        if (entry.execution?.success && entry.execution.removed) summary.removed++;
        if (entry.execution && !entry.execution.success) summary.removalFailures++;
        if (entry.auto?.leaseHeld) summary.leaseConflicts++;
    }
    metrics.nodesScanned += summary.scanned;
    metrics.candidates += summary.candidates;
    metrics.skips += summary.skipped;

    LOG.info(
        LOG_CATEGORY,
        `tick mesh=${meshId} dryRun=${!execute} mode=${executeMode}: scanned=${summary.scanned} candidates=${summary.candidates} `
        + `skipped=${summary.skipped} autoEligible=${summary.autoEligible} removed=${summary.removed} failed=${summary.removalFailures} leaseConflicts=${summary.leaseConflicts}`,
    );

    return { meshId, tickId: opts.tickId, dryRun: !execute, executeMode, graceMs, entries, summary };
}
