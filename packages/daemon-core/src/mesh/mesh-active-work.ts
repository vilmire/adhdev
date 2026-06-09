import type { MeshLedgerEntry } from './mesh-ledger.js';
import type { MeshWorkQueueEntry, DirectDispatchRecord } from './mesh-work-queue.js';

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
    const node = nodes.find(item => readString(item?.id) === nodeId || readString(item?.nodeId) === nodeId || readString(item?.node_id) === nodeId);
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
            const isNoTransition = !isTerminal && !live.status;
            const isIdleUnacknowledged = status === 'idle' && !isTerminal;
            const ledgerOnlyStaleReason = !isTerminal && (isIdleUnacknowledged || isNoTransition || (dispatch.dispatchedToIdleSession && isIdleUnacknowledged))
                ? 'direct task dispatch has no provider acknowledgement, transcript append, or active runtime transition'
                : undefined;
            const isFreshUnacknowledged = Boolean(ledgerOnlyStaleReason && !live.staleReason);
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
            const dispatchedToIdleSession = dispatch.payload?.dispatchedToIdleSession === true;
            const isNoTransition = !terminalStatus && !live.status;
            const isIdleUnacknowledged = status === 'idle';
            const ledgerOnlyStaleReason = !terminalRow && (isIdleUnacknowledged || isNoTransition || (dispatchedToIdleSession && isIdleUnacknowledged))
                ? 'direct task dispatch has no provider acknowledgement, transcript append, or active runtime transition'
                : undefined;
            const message = readString(dispatch.payload?.message) || readString(dispatch.payload?.summary) || '';
            const { title, summary } = summarizeMessage(message);
            const isFreshUnacknowledged = Boolean(ledgerOnlyStaleReason && !live.staleReason);
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
            const dispatchedToIdleSession = dispatch.payload?.dispatchedToIdleSession === true;
            const isNoTransition = !terminalStatus && !live.status;
            const isIdleUnacknowledged = status === 'idle';
            const ledgerOnlyStaleReason = !terminalRow && (isIdleUnacknowledged || isNoTransition || (dispatchedToIdleSession && isIdleUnacknowledged))
                ? 'direct task dispatch has no provider acknowledgement, transcript append, or active runtime transition'
                : undefined;
            const message = readString(dispatch.payload?.message) || readString(dispatch.payload?.summary) || '';
            const { title, summary } = summarizeMessage(message);
            const isFreshUnacknowledged = Boolean(ledgerOnlyStaleReason && !live.staleReason);
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
