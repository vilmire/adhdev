import type { MeshLedgerEntry } from './mesh-ledger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import type { MeshWorkQueueEntry, DirectDispatchRecord } from './mesh-work-queue.js';
import { deleteDirectDispatchesByTaskId } from './mesh-work-queue.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';

export type MeshActiveWorkSource = 'queue' | 'direct';
export type MeshActiveWorkStatus = 'pending' | 'assigned' | 'generating' | 'idle' | 'failed' | 'awaiting_approval';

export interface MeshActiveWorkRecord {
    taskId: string;
    source: MeshActiveWorkSource;
    status: MeshActiveWorkStatus;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskTitle: string;
    taskSummary: string;
    message?: string;
    taskMode?: string;
    createdAt: string;
    updatedAt: string;
    dispatchedAt?: string;
    elapsedMs: number;
    terminal?: boolean;
    terminalKind?: string;
    terminalAt?: string;
    staleReason?: string;
    /**
     * When true, the session targeted by this direct dispatch still exists in the live mesh
     * but did not transition to generating — the dispatch was not acknowledged by the provider.
     * Distinct from historical/orphaned stale entries where the node/session is gone.
     */
    staleDispatchUnacknowledged?: boolean;
}

export interface MeshActiveWorkSummary {
    totalActiveCount: number;
    queueActiveCount: number;
    directActiveCount: number;
    awaitingApprovalCount: number;
    generatingCount: number;
    failedCount: number;
    idleCount: number;
    sourceCounts: Record<MeshActiveWorkSource, number>;
    statusCounts: Record<MeshActiveWorkStatus, number>;
    staleDirectCount: number;
    /**
     * Count of stale direct entries where the target session still exists in the live mesh
     * but never transitioned to generating — these are fresh dispatch failures, not historical orphans.
     * Requires immediate recovery: launch a fresh session and retry the task.
     */
    staleDirectUnacknowledgedCount?: number;
    /**
     * When staleDirectCount > 0, this note clarifies what kind of stale records exist.
     * Fresh unacknowledged dispatches carry an actionable recovery note; orphaned historical
     * entries carry the "historical evidence only" note. Both may coexist.
     */
    staleDirectNote?: string;
}

export interface MeshStaleDirectWorkSummary {
    count: number;
    sampleLimit: number;
    sample: Array<Pick<MeshActiveWorkRecord, 'taskId' | 'status' | 'nodeId' | 'sessionId' | 'taskTitle' | 'createdAt' | 'staleReason'>>;
    reasonCounts: Record<string, number>;
    detailHint: string;
    note?: string;
}

export interface BuildMeshActiveWorkOptions {
    meshId: string;
    queue?: MeshWorkQueueEntry[];
    ledgerEntries?: MeshLedgerEntry[];
    /**
     * Active direct dispatches from MeshRuntimeStore. When provided, these are used instead of
     * scanning ledger entries for direct dispatches — eliminates the O(n_ledger) scan.
     * Falls back to ledger scanning when not provided.
     */
    directDispatches?: DirectDispatchRecord[];
    nodes?: any[];
    now?: number;
    /** Include terminal direct rows (idle/failed) for handoff/recent-work surfaces. Defaults false. */
    includeTerminalDirect?: boolean;
}

const DIRECT_DISPATCH_VIA = new Set(['p2p_direct', 'local_direct', 'mesh_send_task']);
const TERMINAL_LEDGER_KINDS = new Set(['task_completed', 'task_failed', 'task_stalled']);

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function summarizeMessage(message: string): { title: string; summary: string } {
    const oneLine = message.replace(/\s+/g, ' ').trim();
    const title = oneLine.length > 96 ? `${oneLine.slice(0, 93)}...` : oneLine;
    return { title: title || '(untitled task)', summary: oneLine };
}

function elapsedSince(value: string | undefined, now: number): number {
    const started = value ? new Date(value).getTime() : Number.NaN;
    return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

function sessionStatusFromNodes(nodes: any[] | undefined, nodeId?: string, sessionId?: string): { status?: MeshActiveWorkStatus; staleReason?: string } {
    if (!Array.isArray(nodes)) return {};
    if (!nodeId) return { staleReason: 'direct task has no node id' };
    const node = nodes.find(item => meshNodeIdMatches(item, nodeId));
    if (!node) return { staleReason: 'direct task node is no longer in the live mesh' };
    if (!sessionId) return {};
    const candidates: any[] = [];
    for (const value of [
        node.sessions,
        node.activeSessions,
        node.active_sessions,
        node.activeSessionDetails,
        node.active_session_details,
        node.sessionDetails,
        node.session_details,
        node.lastProbe?.sessions,
        node.last_probe?.sessions,
        node.lastProbe?.status?.sessions,
        node.last_probe?.status?.sessions,
    ]) {
        if (Array.isArray(value)) candidates.push(...value);
    }
    for (const value of [node.activeSession, node.active_session, node.currentSession, node.current_session, node.runtimeSession, node.runtime_session, node.session]) {
        if (value && typeof value === 'object') candidates.push(value);
    }
    const session = candidates.find(item => {
        if (typeof item === 'string') return item === sessionId;
        const id = readString(item?.id) || readString(item?.sessionId) || readString(item?.session_id) || readString(item?.runtimeSessionId) || readString(item?.instanceId);
        return id === sessionId;
    });
    if (!session) return { staleReason: 'direct task session is not present in live session records' };
    if (typeof session === 'string') return {};
    const raw = `${readString(session.status) || ''} ${readString(session.lifecycle) || ''} ${readString(session.state) || ''} ${readString(session.activeChat?.status) || ''}`.toLowerCase();
    if (raw.includes('approval')) return { status: 'awaiting_approval' };
    if (raw.includes('generating') || raw.includes('running') || raw.includes('busy')) return { status: 'generating' };
    if (raw.includes('failed') || raw.includes('stopped') || raw.includes('terminated') || raw.includes('exited')) return { status: 'failed' };
    if (raw.includes('idle') || raw.includes('waiting_input') || raw.includes('ready')) return { status: 'idle' };
    return {};
}

function isDirectDispatch(entry: MeshLedgerEntry): boolean {
    if (entry.kind !== 'task_dispatched') return false;
    const payload = entry.payload || {};
    if (payload.source === 'direct') return true;
    const via = readString(payload.via);
    return Boolean(via && DIRECT_DISPATCH_VIA.has(via) && payload.source !== 'queue');
}

function directDispatchTaskId(entry: MeshLedgerEntry): string {
    return readString(entry.payload?.taskId) || entry.id;
}

function terminalMatchesDispatch(terminal: MeshLedgerEntry, dispatch: MeshLedgerEntry, taskId: string): boolean {
    const terminalTaskId = readString(terminal.payload?.taskId);
    if (terminalTaskId && terminalTaskId === taskId) return true;
    if (terminalTaskId && terminalTaskId !== taskId) return false;
    if (dispatch.sessionId && terminal.sessionId === dispatch.sessionId) return true;
    return Boolean(dispatch.nodeId && terminal.nodeId === dispatch.nodeId && !dispatch.sessionId);
}

function statusFromTerminal(entry: MeshLedgerEntry): MeshActiveWorkStatus {
    if (entry.kind === 'task_approval_needed') return 'awaiting_approval';
    if (entry.kind === 'task_completed') return 'idle';
    return 'failed';
}

const LEDGER_ONLY_STALE_REASON =
    'direct task dispatch has no provider acknowledgement, transcript append, or active runtime transition';

/**
 * Single source of truth for classifying whether a direct dispatch is ledger-only
 * stale (dispatched but never acknowledged: no provider ack, no transcript append,
 * no runtime transition) and whether that staleness is "fresh unacknowledged"
 * (target session still live) vs. an orphaned historical record.
 *
 * Previously this predicate was inlined in all three dispatch-classification blocks
 * (MeshRuntimeStore path, remote-ledger path, full-ledger path) and had drifted —
 * e.g. one block gated `isIdleUnacknowledged` on `!isTerminal` and another did not.
 * Extracting it keeps the three callers byte-for-byte consistent. Status derivation
 * stays per-block: it genuinely differs by data source and is passed in via `status`.
 */
function classifyDirectDispatch(params: {
    /** Final classified status of the dispatch. */
    status: MeshActiveWorkStatus;
    /** True when a real terminal row applies (completed/failed/stale); excludes approval_needed. Gates the stale verdict. */
    isTerminalRow: boolean;
    /** True when any terminal-derived status exists (incl. approval_needed). Used to detect "no transition". */
    hasTerminalStatus: boolean;
    /** Live session status from the mesh nodes, if any. */
    liveStatus?: string;
    /** Live stale reason from the mesh nodes, if any. */
    liveStaleReason?: string;
    /** Whether the dispatch targeted an already-idle session. */
    dispatchedToIdleSession: boolean;
}): { ledgerOnlyStaleReason: string | undefined; isFreshUnacknowledged: boolean } {
    const { status, isTerminalRow, hasTerminalStatus, liveStatus, liveStaleReason, dispatchedToIdleSession } = params;
    const isNoTransition = !hasTerminalStatus && !liveStatus;
    const isIdleUnacknowledged = status === 'idle';
    const ledgerOnlyStaleReason =
        !isTerminalRow && (isIdleUnacknowledged || isNoTransition || (dispatchedToIdleSession && isIdleUnacknowledged))
            ? LEDGER_ONLY_STALE_REASON
            : undefined;
    const isFreshUnacknowledged = Boolean(ledgerOnlyStaleReason && !liveStaleReason);
    return { ledgerOnlyStaleReason, isFreshUnacknowledged };
}

export function buildMeshActiveWorkSummary(activeWork: MeshActiveWorkRecord[]): MeshActiveWorkSummary {
    const statusCounts: Record<MeshActiveWorkStatus, number> = {
        pending: 0,
        assigned: 0,
        generating: 0,
        idle: 0,
        failed: 0,
        awaiting_approval: 0,
    };
    const sourceCounts: Record<MeshActiveWorkSource, number> = { queue: 0, direct: 0 };
    for (const item of activeWork) {
        sourceCounts[item.source] += 1;
        statusCounts[item.status] += 1;
    }
    const staleDirectCount = activeWork.filter(item => item.source === 'direct' && item.staleReason).length;
    const staleDirectUnacknowledgedCount = activeWork.filter(item => item.source === 'direct' && item.staleDispatchUnacknowledged).length;
    return {
        totalActiveCount: activeWork.length,
        queueActiveCount: sourceCounts.queue,
        directActiveCount: sourceCounts.direct,
        awaitingApprovalCount: statusCounts.awaiting_approval,
        generatingCount: statusCounts.generating,
        failedCount: statusCounts.failed,
        idleCount: statusCounts.idle,
        sourceCounts,
        statusCounts,
        staleDirectCount,
        ...(staleDirectUnacknowledgedCount > 0 ? { staleDirectUnacknowledgedCount } : {}),
        ...(staleDirectCount > 0 ? { staleDirectNote: 'Stale direct records are orphaned ledger entries whose node/session no longer exists. They are historical recovery evidence only — not active or unresolved work. The queue (source: queue) is authoritative for pending/assigned tasks.' } : {}),
    };
}


export function buildMeshActiveWork(opts: BuildMeshActiveWorkOptions): { activeWork: MeshActiveWorkRecord[]; staleDirectWork: MeshActiveWorkRecord[]; staleDirectWorkNote?: string; terminalDirectWork: MeshActiveWorkRecord[]; summary: MeshActiveWorkSummary } {
    const now = opts.now ?? Date.now();
    const records: MeshActiveWorkRecord[] = [];
    const staleDirectWork: MeshActiveWorkRecord[] = [];
    const terminalDirectWork: MeshActiveWorkRecord[] = [];

    for (const task of opts.queue || []) {
        if (task.status !== 'pending' && task.status !== 'assigned') continue;
        const { title, summary } = summarizeMessage(task.message || '');
        records.push({
            taskId: task.id,
            source: 'queue',
            status: task.status,
            nodeId: task.assignedNodeId || task.targetNodeId,
            sessionId: task.assignedSessionId || task.targetSessionId,
            taskTitle: title,
            taskSummary: summary,
            message: task.message,
            taskMode: task.taskMode,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            dispatchedAt: task.dispatchTimestamp,
            elapsedMs: elapsedSince(task.dispatchTimestamp || task.createdAt, now),
        });
    }

    // When MeshRuntimeStore direct dispatches are provided, use them for LOCAL dispatches (O(1) indexed).
    // ALSO scan ledger for remote dispatches (P2P) whose taskIds are not in MeshRuntimeStore — these
    // are never written to the local MeshRuntimeStore since they're dispatched from a remote daemon.
    if (opts.directDispatches !== undefined) {
        const dbTaskIds = new Set(opts.directDispatches.map(d => d.taskId));
        for (const dispatch of opts.directDispatches) {
            const live = sessionStatusFromNodes(opts.nodes, dispatch.nodeId ?? undefined, dispatch.sessionId ?? undefined);
            const dbStatus = dispatch.status; // 'dispatched' | 'acked' | 'completed' | 'failed' | 'stale'
            const isTerminal = dbStatus === 'completed' || dbStatus === 'failed' || dbStatus === 'stale';
            const status: MeshActiveWorkStatus = isTerminal
                ? (dbStatus === 'completed' ? 'idle' : 'failed')
                : live.status || (dbStatus === 'acked' ? 'generating' : 'assigned');
            const { ledgerOnlyStaleReason, isFreshUnacknowledged } = classifyDirectDispatch({
                status,
                isTerminalRow: isTerminal,
                hasTerminalStatus: isTerminal,
                liveStatus: live.status,
                liveStaleReason: live.staleReason,
                dispatchedToIdleSession: dispatch.dispatchedToIdleSession === true,
            });
            const { title, summary } = summarizeMessage(dispatch.message || '');
            const record: MeshActiveWorkRecord = {
                taskId: dispatch.taskId,
                source: 'direct',
                status,
                nodeId: dispatch.nodeId ?? undefined,
                sessionId: dispatch.sessionId ?? undefined,
                providerType: dispatch.providerType ?? undefined,
                taskTitle: title,
                taskSummary: summary,
                message: dispatch.message,
                taskMode: dispatch.taskMode ?? undefined,
                createdAt: dispatch.dispatchedAt,
                updatedAt: dispatch.updatedAt,
                dispatchedAt: dispatch.dispatchedAt,
                elapsedMs: elapsedSince(dispatch.dispatchedAt, now),
                terminal: isTerminal,
                terminalKind: isTerminal ? (dbStatus === 'completed' ? 'task_completed' : 'task_failed') : undefined,
                terminalAt: isTerminal ? dispatch.updatedAt : undefined,
                staleReason: live.staleReason || ledgerOnlyStaleReason,
                ...(isFreshUnacknowledged ? { staleDispatchUnacknowledged: true } : {}),
            };
            if (isTerminal) {
                terminalDirectWork.push(record);
                if (opts.includeTerminalDirect !== true) continue;
            }
            if ((live.staleReason || ledgerOnlyStaleReason) && !isTerminal) {
                staleDirectWork.push(record);
                continue;
            }
            records.push(record);
        }
        // Also scan ledger for remote dispatches (via p2p_direct) whose taskIds are NOT in MeshRuntimeStore.
        // Remote daemons write their own local MeshRuntimeStore; this coordinator's MeshRuntimeStore only has local dispatches.
        const ledgerEntries = (opts.ledgerEntries || []).slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const terminals = ledgerEntries.filter(entry => TERMINAL_LEDGER_KINDS.has(entry.kind) || entry.kind === 'task_approval_needed');
        for (const dispatch of ledgerEntries.filter(isDirectDispatch)) {
            const taskId = directDispatchTaskId(dispatch);
            if (dbTaskIds.has(taskId)) continue; // already covered by MeshRuntimeStore path above
            const terminal = terminals
                .filter(entry => new Date(entry.timestamp).getTime() >= new Date(dispatch.timestamp).getTime())
                .find(entry => terminalMatchesDispatch(entry, dispatch, taskId));
            const terminalStatus = terminal ? statusFromTerminal(terminal) : undefined;
            const live = sessionStatusFromNodes(opts.nodes, dispatch.nodeId, dispatch.sessionId);
            const status = terminalStatus || live.status || 'assigned';
            const terminalRow = Boolean(terminal && terminal.kind !== 'task_approval_needed');
            const { ledgerOnlyStaleReason, isFreshUnacknowledged } = classifyDirectDispatch({
                status,
                isTerminalRow: terminalRow,
                hasTerminalStatus: Boolean(terminalStatus),
                liveStatus: live.status,
                liveStaleReason: live.staleReason,
                dispatchedToIdleSession: dispatch.payload?.dispatchedToIdleSession === true,
            });
            const message = readString(dispatch.payload?.message) || readString(dispatch.payload?.summary) || '';
            const { title, summary } = summarizeMessage(message);
            const record: MeshActiveWorkRecord = {
                taskId,
                source: 'direct',
                status,
                nodeId: dispatch.nodeId,
                sessionId: dispatch.sessionId,
                providerType: dispatch.providerType || readString(dispatch.payload?.providerType),
                taskTitle: readString(dispatch.payload?.taskTitle) || title,
                taskSummary: readString(dispatch.payload?.taskSummary) || summary,
                message,
                taskMode: readString(dispatch.payload?.taskMode),
                createdAt: dispatch.timestamp,
                updatedAt: terminal?.timestamp || dispatch.timestamp,
                dispatchedAt: dispatch.timestamp,
                elapsedMs: elapsedSince(dispatch.timestamp, now),
                terminal: terminalRow,
                terminalKind: terminal?.kind,
                terminalAt: terminal?.timestamp,
                staleReason: live.staleReason || ledgerOnlyStaleReason,
                ...(isFreshUnacknowledged ? { staleDispatchUnacknowledged: true } : {}),
            };
            if (terminalRow) {
                terminalDirectWork.push(record);
                if (opts.includeTerminalDirect !== true) continue;
            }
            if ((live.staleReason || ledgerOnlyStaleReason) && !terminalRow) {
                staleDirectWork.push(record);
                continue;
            }
            records.push(record);
        }
    } else {
        // Full ledger scan: no MeshRuntimeStore direct dispatches available (standalone mode or empty).
        const ledgerEntries = (opts.ledgerEntries || []).slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const terminals = ledgerEntries.filter(entry => TERMINAL_LEDGER_KINDS.has(entry.kind) || entry.kind === 'task_approval_needed');
        for (const dispatch of ledgerEntries.filter(isDirectDispatch)) {
            const taskId = directDispatchTaskId(dispatch);
            const terminal = terminals
                .filter(entry => new Date(entry.timestamp).getTime() >= new Date(dispatch.timestamp).getTime())
                .find(entry => terminalMatchesDispatch(entry, dispatch, taskId));
            const terminalStatus = terminal ? statusFromTerminal(terminal) : undefined;
            const live = sessionStatusFromNodes(opts.nodes, dispatch.nodeId, dispatch.sessionId);
            const status = terminalStatus || live.status || 'assigned';
            const terminalRow = Boolean(terminal && terminal.kind !== 'task_approval_needed');
            const { ledgerOnlyStaleReason, isFreshUnacknowledged } = classifyDirectDispatch({
                status,
                isTerminalRow: terminalRow,
                hasTerminalStatus: Boolean(terminalStatus),
                liveStatus: live.status,
                liveStaleReason: live.staleReason,
                dispatchedToIdleSession: dispatch.payload?.dispatchedToIdleSession === true,
            });
            const message = readString(dispatch.payload?.message) || readString(dispatch.payload?.summary) || '';
            const { title, summary } = summarizeMessage(message);
            const record: MeshActiveWorkRecord = {
                taskId,
                source: 'direct',
                status,
                nodeId: dispatch.nodeId,
                sessionId: dispatch.sessionId,
                providerType: dispatch.providerType || readString(dispatch.payload?.providerType),
                taskTitle: readString(dispatch.payload?.taskTitle) || title,
                taskSummary: readString(dispatch.payload?.taskSummary) || summary,
                message,
                taskMode: readString(dispatch.payload?.taskMode),
                createdAt: dispatch.timestamp,
                updatedAt: terminal?.timestamp || dispatch.timestamp,
                dispatchedAt: dispatch.timestamp,
                elapsedMs: elapsedSince(dispatch.timestamp, now),
                terminal: terminalRow,
                terminalKind: terminal?.kind,
                terminalAt: terminal?.timestamp,
                staleReason: live.staleReason || ledgerOnlyStaleReason,
                ...(isFreshUnacknowledged ? { staleDispatchUnacknowledged: true } : {}),
            };
            if (terminalRow) {
                terminalDirectWork.push(record);
                if (opts.includeTerminalDirect !== true) continue;
            }
            if ((live.staleReason || ledgerOnlyStaleReason) && !terminalRow) {
                staleDirectWork.push(record);
                continue;
            }
            records.push(record);
        }
    }

    records.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    staleDirectWork.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    terminalDirectWork.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const summary = buildMeshActiveWorkSummary(records);
    summary.staleDirectCount = staleDirectWork.length;
    const unacknowledgedCount = staleDirectWork.filter(r => r.staleDispatchUnacknowledged).length;
    if (unacknowledgedCount > 0) {
        summary.staleDirectUnacknowledgedCount = unacknowledgedCount;
    }
    // Build a note that accurately describes what's in the stale set.
    // When there are fresh unacknowledged entries (node/session still live, session never started),
    // use the actionable recovery note instead of the misleading "historical evidence only" note.
    const staleDirectWorkNote = staleDirectWork.length > 0
        ? unacknowledgedCount > 0 && unacknowledgedCount === staleDirectWork.length
            ? `${unacknowledgedCount} direct dispatch(es) were not acknowledged by the target session — the session received the agent_command but never transitioned to generating. This is a fresh dispatch failure, not historical noise. Recovery: launch a fresh session on the same node and retry the task, or use mesh_enqueue_task for queue-based assignment.`
            : unacknowledgedCount > 0
                ? `${unacknowledgedCount} of ${staleDirectWork.length} stale direct record(s) are fresh unacknowledged dispatch failures (session still live but never transitioned to generating); the rest are orphaned historical entries whose node/session no longer exists. Fresh unacknowledged dispatches need recovery: launch a fresh session and retry. Orphaned entries are historical evidence only — not active or unresolved work.`
                : 'These are orphaned ledger entries whose original node or session no longer exists in the live mesh. They are historical/recovery evidence only — not active or unresolved work. Do not treat staleDirectCount as a status mismatch; use the queue (source: queue) as authoritative for pending/assigned tasks.'
        : undefined;
    if (staleDirectWorkNote) {
        summary.staleDirectNote = staleDirectWorkNote;
    }
    return { activeWork: records, staleDirectWork, staleDirectWorkNote, terminalDirectWork, summary };
}

/**
 * staleReason strings (produced by sessionStatusFromNodes above) that indicate the original
 * node/session is GONE from the live mesh — i.e. the staleDirect record is an orphaned ledger
 * artifact, not active or recoverable work. These are the only reasons safe to prune from the
 * active staleDirect surface. The "no provider acknowledgement" reason is deliberately excluded:
 * those entries have a still-live node/session (staleDispatchUnacknowledged) and represent
 * recoverable dispatch failures, never orphans.
 */
export const PRUNABLE_ORPHAN_STALE_REASONS: ReadonlySet<string> = new Set([
    'direct task node is no longer in the live mesh',
    'direct task session is not present in live session records',
    'direct task has no node id',
]);

export type StaleDirectPruneClassification = 'prunable_orphan' | 'prunable_terminal' | 'preserve_unacknowledged' | 'preserve_active';

/**
 * Classify a direct-work record for the staleDirect prune path. Pure function — the prune tool
 * uses this so the safety rules (never touch active work or recoverable unacknowledged dispatches)
 * live next to the staleReason producers and are independently testable.
 */
export function classifyStaleDirectForPrune(
    record: Pick<MeshActiveWorkRecord, 'staleReason' | 'staleDispatchUnacknowledged' | 'terminal'>,
    opts: { includeTerminal?: boolean } = {},
): StaleDirectPruneClassification {
    if (record.staleDispatchUnacknowledged === true) return 'preserve_unacknowledged';
    if (record.terminal === true) return opts.includeTerminal ? 'prunable_terminal' : 'preserve_active';
    if (record.staleReason && PRUNABLE_ORPHAN_STALE_REASONS.has(record.staleReason)) return 'prunable_orphan';
    return 'preserve_active';
}

/**
 * Outcome of one staleDirect prune pass. Pure data — callers (the MCP tool, the
 * daemon reconcile loop) format/log this however they need. The MCP tool wraps it in
 * its JSON response; the reconcile loop logs prunedCount when > 0.
 */
export interface StaleDirectPruneResult {
    mode: 'execute' | 'dry_run';
    includeTerminal: boolean;
    /** Total staleDirect (+terminal when included) candidates surfaced this pass. */
    candidateCount: number;
    /** Records classified prunable AND (when minAgeMs > 0) old enough to auto-prune. */
    prunable: MeshActiveWorkRecord[];
    prunedCount: number;
    /** Prunable by classification but younger than the age gate — only populated when minAgeMs > 0. */
    skippedTooYoung: MeshActiveWorkRecord[];
    preservedUnacknowledged: MeshActiveWorkRecord[];
    /** Prunable orphans/terminals with no store-backed row to delete (ledger-only audit). */
    preservedLedgerOnly: MeshActiveWorkRecord[];
    preservedNotOrphan: MeshActiveWorkRecord[];
}

export interface PruneStaleDirectDispatchesOptions {
    meshId: string;
    /** Active direct dispatches from MeshRuntimeStore (getActiveDirectDispatches). */
    directDispatches: DirectDispatchRecord[];
    /** Ledger tail used to attribute remote/terminal dispatches (readLedgerEntries). */
    ledgerEntries?: MeshLedgerEntry[];
    queue?: MeshWorkQueueEntry[];
    /** Live mesh nodes (decorated with live session details) — drives orphan detection. */
    nodes?: any[];
    /** When true, actually delete + append the audit ledger entry. Default false (dry run). */
    execute?: boolean;
    /** Include terminal (idle/failed) direct rows as prune candidates. Default false. */
    includeTerminal?: boolean;
    /**
     * Minimum age (ms, measured from createdAt/dispatchedAt) before a prunable orphan is
     * eligible. 0 (default) prunes immediately regardless of age — the manual prune behavior.
     * The daemon auto-prune passes a conservative threshold so a node/session that is only
     * transiently invisible is never pruned on the spot.
     */
    minAgeMs?: number;
    /** Audit source string written into the direct_dispatch_pruned ledger payload. */
    source?: string;
    now?: number;
}

/**
 * Shared staleDirect prune core. Single source of truth for the prune decision + the
 * mutation (store-row delete + audit-ledger append) used by BOTH the manual MCP tool
 * (mesh_prune_stale_direct, minAgeMs=0) and the daemon reconcile loop's auto-prune
 * PHASE (minAgeMs > 0). Pure decision logic via buildMeshActiveWork + classifyStaleDirectForPrune;
 * the only side effects (on execute) are deleteDirectDispatchesByTaskId and a single
 * direct_dispatch_pruned ledger entry — never touching the append-only audit history of the
 * pruned dispatches themselves.
 *
 * Safety rules (identical for manual + auto):
 *  - Only records classified as staleDirectWork against the CURRENT live mesh are eligible.
 *  - Of those, only orphans (node/session gone) — and terminals when includeTerminal — are prunable.
 *    Fresh unacknowledged dispatch failures (node/session still live) are always preserved.
 *  - Only store-backed rows (taskId present in MeshRuntimeStore) are deleted; ledger-only remote
 *    entries are preserved.
 *  - When minAgeMs > 0, a prunable orphan younger than the gate is held back (skippedTooYoung).
 *    This applies ONLY to the auto path; the manual path passes minAgeMs=0 (immediate).
 *
 * Idempotent: a deleted row no longer appears in getActiveDirectDispatches, so a second pass
 * over the same orphan finds nothing to prune.
 */
export function pruneStaleDirectDispatches(opts: PruneStaleDirectDispatchesOptions): StaleDirectPruneResult {
    const now = opts.now ?? Date.now();
    const includeTerminal = opts.includeTerminal === true;
    const execute = opts.execute === true;
    const minAgeMs = Math.max(0, opts.minAgeMs ?? 0);

    const activeWorkEvidence = buildMeshActiveWork({
        meshId: opts.meshId,
        queue: opts.queue,
        ledgerEntries: opts.ledgerEntries,
        directDispatches: opts.directDispatches,
        nodes: opts.nodes,
        now,
        includeTerminalDirect: includeTerminal,
    });

    const candidates = [
        ...activeWorkEvidence.staleDirectWork,
        ...(includeTerminal ? activeWorkEvidence.terminalDirectWork : []),
    ];
    // Only prune store-backed dispatch rows (taskIds present in MeshRuntimeStore). Ledger-only
    // remote entries have no store row to delete and are pure audit history — leave them alone.
    const storeTaskIds = new Set(opts.directDispatches.map(d => d.taskId));

    const prunable: MeshActiveWorkRecord[] = [];
    const skippedTooYoung: MeshActiveWorkRecord[] = [];
    const preservedUnacknowledged: MeshActiveWorkRecord[] = [];
    const preservedLedgerOnly: MeshActiveWorkRecord[] = [];
    const preservedNotOrphan: MeshActiveWorkRecord[] = [];
    for (const record of candidates) {
        const classification = classifyStaleDirectForPrune(record, { includeTerminal });
        if (classification === 'preserve_unacknowledged') {
            preservedUnacknowledged.push(record);
            continue;
        }
        if (classification === 'preserve_active') {
            preservedNotOrphan.push(record);
            continue;
        }
        // prunable_orphan | prunable_terminal — only delete store-backed rows; ledger-only remote
        // entries have no store row to delete and are pure audit history.
        if (!storeTaskIds.has(record.taskId)) {
            preservedLedgerOnly.push(record);
            continue;
        }
        // Age gate (auto path only): hold back orphans that are too fresh — a node/session that is
        // only transiently invisible must not be pruned the instant it disappears.
        if (minAgeMs > 0) {
            const ageRef = record.dispatchedAt || record.createdAt;
            const ageMs = elapsedSince(ageRef, now);
            if (ageMs < minAgeMs) {
                skippedTooYoung.push(record);
                continue;
            }
        }
        prunable.push(record);
    }

    let prunedCount = 0;
    if (execute && prunable.length) {
        prunedCount = deleteDirectDispatchesByTaskId(opts.meshId, prunable.map(r => r.taskId));
        appendLedgerEntry(opts.meshId, {
            kind: 'direct_dispatch_pruned',
            payload: {
                source: opts.source || 'prune_stale_direct',
                prunedCount,
                taskIds: prunable.map(r => r.taskId),
                reasons: Array.from(new Set(prunable.map(r => r.staleReason || (r.terminal ? 'terminal' : 'unknown')))),
            },
        });
    }

    return {
        mode: execute ? 'execute' : 'dry_run',
        includeTerminal,
        candidateCount: candidates.length,
        prunable,
        prunedCount,
        skippedTooYoung,
        preservedUnacknowledged,
        preservedLedgerOnly,
        preservedNotOrphan,
    };
}

export function buildCompactStaleDirectWorkSummary(
    staleDirectWork: MeshActiveWorkRecord[],
    opts: { sampleLimit?: number; detailHint?: string; note?: string } = {},
): MeshStaleDirectWorkSummary {
    const sampleLimit = Math.max(0, Math.min(10, Math.floor(opts.sampleLimit ?? 3)));
    const reasonCounts: Record<string, number> = {};
    for (const entry of staleDirectWork) {
        const reason = entry.staleReason || 'unknown';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
    return {
        count: staleDirectWork.length,
        sampleLimit,
        sample: staleDirectWork.slice(0, sampleLimit).map(entry => ({
            taskId: entry.taskId,
            status: entry.status,
            nodeId: entry.nodeId,
            sessionId: entry.sessionId,
            taskTitle: entry.taskTitle,
            createdAt: entry.createdAt,
            staleReason: entry.staleReason,
        })),
        reasonCounts,
        detailHint: opts.detailHint || 'Stale direct records are historical recovery evidence only. Use mesh_task_history for full ledger details, or request includeStaleDirectWorkDetails when supported by the caller.',
        ...(opts.note ? { note: opts.note } : {}),
    };
}
