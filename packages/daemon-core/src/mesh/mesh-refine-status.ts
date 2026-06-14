import type { MeshLedgerEntry } from './mesh-ledger.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events.js';
import type { MeshAsyncJobLifecycle } from '../repo-mesh-types.js';

export type MeshAsyncRefineJobStatus = 'accepted' | 'running' | 'completed' | 'failed';

export interface MeshAsyncRefineJobSummary extends MeshAsyncJobLifecycle {
    jobId: string;
    interactionId?: string;
    status: MeshAsyncRefineJobStatus;
    meshId?: string;
    nodeId?: string;
    targetNodeId?: string;
    targetDaemonId?: string;
    workspace?: string;
    branch?: string;
    into?: string;
    retryOfJobId?: string;
    lastEvent?: string;
    lastLedgerKind?: string;
    lastUpdatedAt?: string;
    instruction: string;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function eventStatus(event: string | undefined, fallback?: string): MeshAsyncRefineJobStatus | undefined {
    if (event === 'refine:accepted') return 'accepted';
    if (event === 'refine:completed') return 'completed';
    if (event === 'refine:failed') return 'failed';
    if (fallback === 'completed' || fallback === 'failed' || fallback === 'accepted') return fallback;
    return undefined;
}

function ledgerStatus(kind: string, fallback?: string): MeshAsyncRefineJobStatus {
    if (kind === 'task_completed') return 'completed';
    if (kind === 'task_failed') return 'failed';
    if (fallback === 'accepted') return 'accepted';
    return 'running';
}

function instructionForStatus(status: MeshAsyncRefineJobStatus): string {
    if (status === 'accepted') return 'Refine job is accepted; wait for asyncRefineJobs or pendingCoordinatorEvents to report running/completed/failed.';
    if (status === 'running') return 'Refine job is running; do not poll the ledger repeatedly. Watch asyncRefineJobs or pendingCoordinatorEvents for the terminal result.';
    if (status === 'completed') return 'Refine job completed; inspect branch convergence and cleanup evidence before reporting final merge state.';
    return 'Refine job failed; inspect result/finalBranchConvergenceState in mesh_task_history, fix the blocker, then rerun mesh_refine_node when ready.';
}

function mergeJob(
    jobs: Map<string, MeshAsyncRefineJobSummary>,
    patch: Partial<MeshAsyncRefineJobSummary> & { jobId?: string },
): void {
    const jobId = readString(patch.jobId);
    if (!jobId) return;
    const previous = jobs.get(jobId);
    const status = patch.status || previous?.status || 'running';
    const definedPatch = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<MeshAsyncRefineJobSummary>;
    jobs.set(jobId, {
        ...previous,
        ...definedPatch,
        jobId,
        status,
        instruction: instructionForStatus(status),
    });
}

export function buildMeshAsyncRefineJobs(args: {
    meshId?: string;
    ledgerEntries?: MeshLedgerEntry[];
    pendingEvents?: PendingMeshCoordinatorEvent[];
}): MeshAsyncRefineJobSummary[] {
    const jobs = new Map<string, MeshAsyncRefineJobSummary>();

    for (const entry of args.ledgerEntries || []) {
        const payload = readRecord(entry.payload);
        if (payload?.source !== 'refine_mesh_node_async_job') continue;
        const refineJob = readRecord(payload.refineJob);
        const result = readRecord(payload.result);
        const finalState = readRecord(payload.finalBranchConvergenceState) || readRecord(result?.finalBranchConvergenceState);
        const jobId = readString(refineJob?.jobId);
        if (!jobId) continue;
        const status = ledgerStatus(entry.kind, readString(refineJob?.status));
        mergeJob(jobs, {
            jobId,
            interactionId: readString(refineJob?.interactionId),
            status,
            meshId: readString(refineJob?.meshId) || args.meshId,
            nodeId: readString(refineJob?.nodeId) || entry.nodeId,
            targetNodeId: readString(refineJob?.nodeId) || entry.nodeId,
            targetDaemonId: readString(refineJob?.targetDaemonId),
            workspace: readString(refineJob?.workspace),
            branch: readString(result?.branch) || readString(finalState?.branch),
            into: readString(result?.into) || readString(finalState?.baseBranch),
            startedAt: readString(refineJob?.startedAt),
            completedAt: readString(refineJob?.completedAt),
            retryOfJobId: readString(refineJob?.retryOfJobId) || readString(payload.retryOfJobId),
            lastLedgerKind: entry.kind,
            lastUpdatedAt: entry.timestamp,
        });
    }

    for (const event of args.pendingEvents || []) {
        const metadata = readRecord(event.metadataEvent);
        if (metadata?.source !== 'refine_mesh_node_async_job') continue;
        const result = readRecord(metadata.result);
        const finalState = readRecord(result?.finalBranchConvergenceState);
        const jobId = readString(metadata.jobId);
        if (!jobId) continue;
        const status = eventStatus(event.event, readString(metadata.status));
        mergeJob(jobs, {
            jobId,
            interactionId: readString(metadata.interactionId),
            ...(status ? { status } : {}),
            meshId: readString(metadata.meshId) || event.meshId || args.meshId,
            nodeId: readString(metadata.nodeId) || event.nodeId,
            targetNodeId: readString(metadata.nodeId) || event.nodeId,
            targetDaemonId: readString(metadata.targetDaemonId),
            workspace: readString(metadata.workspace) || event.workspace,
            branch: readString(result?.branch) || readString(finalState?.branch),
            into: readString(result?.into) || readString(finalState?.baseBranch),
            startedAt: readString(metadata.startedAt),
            completedAt: readString(metadata.completedAt),
            retryOfJobId: readString(metadata.retryOfJobId),
            lastEvent: event.event,
            lastUpdatedAt: new Date(event.queuedAt).toISOString(),
        });
    }

    return Array.from(jobs.values()).sort((a, b) => {
        const aTime = new Date(a.lastUpdatedAt || a.startedAt || '').getTime();
        const bTime = new Date(b.lastUpdatedAt || b.startedAt || '').getTime();
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });
}

const TERMINAL_REFINE_STATUSES = new Set<MeshAsyncRefineJobStatus>(['completed', 'failed']);

/** Terminal refine jobs older than this (relative to the newest job in the set) are
 * "stale" — already-resolved historical refinery rejections/successes that should not
 * keep inflating the status counts in mesh_status. 6h covers a long working session
 * while still folding multi-day-old residue. */
export const STALE_TERMINAL_REFINE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Cap on how many recent terminal jobs are counted even if all fall inside the freshness
 * window — prevents a burst of refines from dominating the summary. */
export const RECENT_TERMINAL_REFINE_CAP = 8;

export interface MeshAsyncRefineJobsSummary {
    /** Count of jobs reflected in `byStatus` (active jobs + recent terminal jobs). */
    total: number;
    byStatus: Record<string, number>;
    /** Terminal jobs dropped from the counts because they are stale residue. */
    staleTerminal: number;
    /** Non-terminal (accepted/running) jobs still in flight. */
    activeJobs: MeshAsyncRefineJobSummary[];
}

function jobActivityTime(job: MeshAsyncRefineJobSummary): number {
    const raw = job.lastUpdatedAt || job.completedAt || job.startedAt || '';
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : 0;
}

/**
 * Build a compact summary of refine jobs that folds stale terminal jobs.
 *
 * The full job list (from `buildMeshAsyncRefineJobs`) is derived from a recent ledger
 * window and deduped by jobId, but it still includes every terminal (completed/failed)
 * job that happens to fall in that window — including multi-day-old refinery rejections
 * that have long since been resolved. Those stale terminals inflate `byStatus.failed`
 * and read as "current breakage" when they are historical noise.
 *
 * Active (accepted/running) jobs are always counted. Terminal jobs are counted only when
 * they are recent: within `STALE_TERMINAL_REFINE_WINDOW_MS` of the newest job's activity
 * time AND among the `RECENT_TERMINAL_REFINE_CAP` most-recent terminals. Everything else
 * is folded into `staleTerminal` and excluded from `byStatus`.
 *
 * Freshness is measured relative to the newest job in the set (not wall-clock), so the
 * result is deterministic for a given input — important for tests and for stale-clock
 * environments.
 */
export function summarizeMeshAsyncRefineJobs(
    jobs: MeshAsyncRefineJobSummary[],
): MeshAsyncRefineJobsSummary {
    const activeJobs: MeshAsyncRefineJobSummary[] = [];
    const terminalJobs: MeshAsyncRefineJobSummary[] = [];
    for (const job of jobs) {
        if (TERMINAL_REFINE_STATUSES.has(job.status)) terminalJobs.push(job);
        else activeJobs.push(job);
    }

    // Newest activity across ALL jobs anchors the freshness window.
    let newest = 0;
    for (const job of jobs) newest = Math.max(newest, jobActivityTime(job));
    const cutoff = newest - STALE_TERMINAL_REFINE_WINDOW_MS;

    const terminalByRecency = [...terminalJobs].sort(
        (a, b) => jobActivityTime(b) - jobActivityTime(a),
    );
    const freshTerminal = terminalByRecency
        .filter(job => jobActivityTime(job) >= cutoff)
        .slice(0, RECENT_TERMINAL_REFINE_CAP);
    const freshTerminalIds = new Set(freshTerminal.map(job => job.jobId));

    const byStatus: Record<string, number> = {};
    for (const job of activeJobs) {
        byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    }
    for (const job of freshTerminal) {
        byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    }

    const staleTerminal = terminalJobs.length - freshTerminalIds.size;

    return {
        total: activeJobs.length + freshTerminal.length,
        byStatus,
        staleTerminal,
        activeJobs,
    };
}
