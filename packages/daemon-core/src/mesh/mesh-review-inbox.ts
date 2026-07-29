/**
 * M4.0: Review inbox — derive review items from existing truth.
 *
 * No new store: review items are a query-time projection of
 *   - mesh_status node statuses (daemon-owned branchConvergence), and
 *   - the task ledger (completion evidence envelopes + refine job results).
 *
 * Scope (M4.0): host-daemon-local nodes only. Remote nodes are excluded and
 * surfaced via remoteNodesExcluded/excludedRemoteNodeIds until the
 * daemon↔daemon P2P relay path is live-verified (M4.2).
 */

import type { MeshLedgerEntry } from './mesh-ledger.js';
import { buildMeshAsyncRefineJobs } from './mesh-refine-status.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';

export type MeshReviewInboxReason = 'merge_candidate' | 'refine_blocked_review';

export interface MeshReviewInboxConvergence {
    status: string;
    reason: string | null;
    nextStep: string | null;
    needsConvergence: boolean;
}

export interface MeshReviewInboxEvidence {
    available: boolean;
    /** Ledger kind of the entry the evidence came from. */
    kind?: 'task_completed' | 'task_failed';
    /** 'task_completion' = ordinary worker completion envelope; 'refine_job' = Refinery result. */
    source?: 'task_completion' | 'refine_job';
    timestamp?: string;
    taskId?: string;
    sessionId?: string;
    /** M2-3 bootstrap stage from the refine validation gate: cached|ran|failed|skipped|legacy|not_configured. */
    bootstrap?: Record<string, unknown> | null;
    validation?: Record<string, unknown> | null;
    checkpoint?: Record<string, unknown> | null;
    worker?: {
        status: string;
        classification?: string;
        changedFiles: string[];
        changedFilesTruncated?: true;
        validationResults: Array<Record<string, unknown>>;
        errors: string[];
        requiresUserAction: boolean;
    } | null;
    finalBranchConvergenceState?: Record<string, unknown>;
    refineJob?: Record<string, unknown>;
}

export interface MeshReviewInboxDiffFile {
    path: string;
    status?: string;
    insertions?: number;
    deletions?: number;
    binary?: boolean;
    oldPath?: string;
}

export interface MeshReviewInboxDiffSummary {
    baseRef: string;
    files: MeshReviewInboxDiffFile[];
    totalFiles: number;
    totalInsertions: number;
    totalDeletions: number;
    truncated: boolean;
    error?: string;
}

export interface MeshReviewInboxItem {
    nodeId: string;
    workspace: string | null;
    branch: string | null;
    defaultBranch: string | null;
    isLocalWorktree: boolean;
    reviewReason: MeshReviewInboxReason;
    convergence: MeshReviewInboxConvergence;
    evidence: MeshReviewInboxEvidence;
    transcriptHandle: Record<string, unknown> | null;
    /** Latest non-terminal Refinery job for this node (accepted/running), if any. */
    activeRefineJob: Record<string, unknown> | null;
    lastActivityAt: string | null;
    /** Filled by the daemon command with a bounded base-branch diff probe; null when the workspace is not locally readable. */
    diffSummary?: MeshReviewInboxDiffSummary | null;
}

export interface MeshReviewInboxDerivation {
    items: MeshReviewInboxItem[];
    remoteNodesExcluded: boolean;
    excludedRemoteNodeIds: string[];
}

const MAX_CHANGED_FILES = 100;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readStringArray(value: unknown, max: number): { values: string[]; truncated: boolean } {
    if (!Array.isArray(value)) return { values: [], truncated: false };
    const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return { values: values.slice(0, max), truncated: values.length > max };
}

function isLocalNodeStatus(node: Record<string, unknown>): boolean {
    if (node.isLocalWorktree === true) return true;
    const connection = readRecord(node.connection);
    return readString(connection?.state) === 'self';
}

function readNodeConvergence(node: Record<string, unknown>): (MeshReviewInboxConvergence & { branch: string | null; defaultBranch: string | null }) | null {
    const convergence = readRecord(node.branchConvergence);
    const status = readString(convergence?.status);
    if (!convergence || !status) return null;
    return {
        status,
        reason: readString(convergence.reason),
        nextStep: readString(convergence.nextStep),
        needsConvergence: convergence.needsConvergence === true,
        branch: readString(convergence.branch),
        defaultBranch: readString(convergence.defaultBranch),
    };
}

function isMergeCandidate(convergence: MeshReviewInboxConvergence): boolean {
    if (convergence.status === 'pushed_feature_branch_needs_merge') return true;
    // Clean non-default worktree branch — the local merge candidate shape
    // (router classifies it cleanup_candidate with this reason).
    return convergence.status === 'cleanup_candidate'
        && convergence.reason === 'clean_non_default_worktree_branch';
}

function readWorkerArtifact(value: unknown): MeshReviewInboxEvidence['worker'] {
    const worker = readRecord(value);
    if (!worker) return null;
    const changed = readStringArray(worker.changedFiles, MAX_CHANGED_FILES);
    return {
        status: readString(worker.status) ?? 'unknown',
        ...(readString(worker.classification) ? { classification: readString(worker.classification)! } : {}),
        changedFiles: changed.values,
        ...(changed.truncated ? { changedFilesTruncated: true as const } : {}),
        validationResults: Array.isArray(worker.validationResults)
            ? worker.validationResults.map(item => readRecord(item)).filter((item): item is Record<string, unknown> => item !== null)
            : [],
        errors: readStringArray(worker.errors, 20).values,
        requiresUserAction: worker.requiresUserAction === true,
    };
}

function isTerminalLedgerKind(kind: string): kind is 'task_completed' | 'task_failed' {
    return kind === 'task_completed' || kind === 'task_failed';
}

/**
 * Latest terminal evidence for a node, normalized into the review card shape.
 * Refine job entries carry the validation gate summary (incl. the M2-3
 * bootstrap stage); ordinary completions carry the B-series evidence envelope.
 */
function resolveNodeEvidence(nodeId: string, ledgerEntries: MeshLedgerEntry[]): {
    evidence: MeshReviewInboxEvidence;
    transcriptHandle: Record<string, unknown> | null;
} {
    let evidence: MeshReviewInboxEvidence = { available: false };
    let transcriptHandle: Record<string, unknown> | null = null;

    for (let i = ledgerEntries.length - 1; i >= 0; i--) {
        const entry = ledgerEntries[i];
        if (!daemonIdsEquivalent(entry.nodeId, nodeId) || !isTerminalLedgerKind(entry.kind)) continue;
        const payload = readRecord(entry.payload) ?? {};

        if (!evidence.available) {
            if (payload.source === 'refine_mesh_node_async_job') {
                const result = readRecord(payload.result);
                const validationSummary = readRecord(result?.validationSummary);
                evidence = {
                    available: true,
                    kind: entry.kind,
                    source: 'refine_job',
                    timestamp: entry.timestamp,
                    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
                    bootstrap: readRecord(validationSummary?.bootstrap),
                    validation: validationSummary
                        ? Object.fromEntries(Object.entries(validationSummary).filter(([key]) => key !== 'bootstrap'))
                        : null,
                    checkpoint: readRecord(result?.checkpoint),
                    worker: null,
                    ...(readRecord(payload.finalBranchConvergenceState) ?? readRecord(result?.finalBranchConvergenceState)
                        ? { finalBranchConvergenceState: (readRecord(payload.finalBranchConvergenceState) ?? readRecord(result?.finalBranchConvergenceState))! }
                        : {}),
                    ...(readRecord(payload.refineJob) ? { refineJob: readRecord(payload.refineJob)! } : {}),
                };
            } else {
                const envelope = readRecord(payload.evidence);
                evidence = {
                    available: true,
                    kind: entry.kind,
                    source: 'task_completion',
                    timestamp: entry.timestamp,
                    ...(readString(payload.taskId) ? { taskId: readString(payload.taskId)! } : {}),
                    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
                    bootstrap: null,
                    validation: readRecord(envelope?.validation),
                    checkpoint: readRecord(envelope?.checkpoint),
                    worker: readWorkerArtifact(envelope?.workerResult ?? payload.workerResult),
                };
            }
        }

        if (!transcriptHandle) {
            const envelope = readRecord(payload.evidence);
            transcriptHandle = readRecord(envelope?.transcriptHandle);
        }

        if (evidence.available && transcriptHandle) break;
    }

    return { evidence, transcriptHandle };
}

/** Latest refine terminal result for a node that classified it blocked_review. */
export function hasBlockedReviewRefineResult(nodeId: string, ledgerEntries: MeshLedgerEntry[]): boolean {
    for (let i = ledgerEntries.length - 1; i >= 0; i--) {
        const entry = ledgerEntries[i];
        if (!daemonIdsEquivalent(entry.nodeId, nodeId) || !isTerminalLedgerKind(entry.kind)) continue;
        const payload = readRecord(entry.payload) ?? {};
        if (payload.source !== 'refine_mesh_node_async_job') continue;
        const result = readRecord(payload.result);
        const finalState = readRecord(payload.finalBranchConvergenceState) ?? readRecord(result?.finalBranchConvergenceState);
        // Only the most recent refine terminal counts — an older blocked_review
        // superseded by a successful refine must not resurrect the card.
        return readString(finalState?.status) === 'blocked_review'
            || readString(result?.code) === 'blocked_review';
    }
    return false;
}

/**
 * Derive review inbox items from mesh_status node statuses and a bounded
 * ledger tail. Pure and read-only; the caller attaches diffSummary separately.
 */
export function deriveMeshReviewInboxItems(args: {
    nodes: Array<Record<string, unknown>>;
    ledgerEntries: MeshLedgerEntry[];
}): MeshReviewInboxDerivation {
    const items: MeshReviewInboxItem[] = [];
    const excludedRemoteNodeIds: string[] = [];
    const refineJobs = buildMeshAsyncRefineJobs({ ledgerEntries: args.ledgerEntries });

    for (const node of args.nodes) {
        const nodeId = readString(node.nodeId) ?? readString(node.id);
        if (!nodeId) continue;

        if (!isLocalNodeStatus(node)) {
            excludedRemoteNodeIds.push(nodeId);
            continue;
        }

        const convergence = readNodeConvergence(node);
        if (!convergence) continue;
        if (convergence.status === 'merged_to_main') continue;

        let reviewReason: MeshReviewInboxReason | null = null;
        if (hasBlockedReviewRefineResult(nodeId, args.ledgerEntries)) {
            reviewReason = 'refine_blocked_review';
        } else if (isMergeCandidate(convergence)) {
            reviewReason = 'merge_candidate';
        }
        if (!reviewReason) continue;

        const { evidence, transcriptHandle } = resolveNodeEvidence(nodeId, args.ledgerEntries);
        const activeRefineJob = [...refineJobs].reverse().find(job =>
            (daemonIdsEquivalent(job.nodeId, nodeId) || daemonIdsEquivalent(job.targetNodeId, nodeId))
            && (job.status === 'accepted' || job.status === 'running'),
        ) ?? null;

        items.push({
            nodeId,
            workspace: readString(node.workspace),
            branch: convergence.branch ?? readString(node.worktreeBranch),
            defaultBranch: convergence.defaultBranch,
            isLocalWorktree: node.isLocalWorktree === true,
            reviewReason,
            convergence: {
                status: convergence.status,
                reason: convergence.reason,
                nextStep: convergence.nextStep,
                needsConvergence: convergence.needsConvergence,
            },
            evidence,
            transcriptHandle,
            activeRefineJob: activeRefineJob as Record<string, unknown> | null,
            lastActivityAt: evidence.timestamp ?? null,
        });
    }

    return {
        items,
        remoteNodesExcluded: excludedRemoteNodeIds.length > 0,
        excludedRemoteNodeIds,
    };
}
