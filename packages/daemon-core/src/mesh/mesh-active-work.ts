import type { MeshLedgerEntry } from './mesh-ledger.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';

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
     * When staleDirectCount > 0, this note clarifies that stale direct records are
     * historical/recovery evidence — orphaned ledger entries whose original node or session
     * is no longer present in the live mesh. They are NOT active or unresolved work items.
     * The active queue (queue source) is the authoritative source for pending/assigned work.
     */
    staleDirectNote?: string;
}

export interface BuildMeshActiveWorkOptions {
    meshId: string;
    queue?: MeshWorkQueueEntry[];
    ledgerEntries?: MeshLedgerEntry[];
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
    for (const value of [node.sessions, node.activeSessions, node.active_sessions, node.lastProbe?.sessions, node.last_probe?.sessions, node.lastProbe?.status?.sessions, node.last_probe?.status?.sessions]) {
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
            staleReason: live.staleReason,
        };
        if (terminalRow) {
            terminalDirectWork.push(record);
            if (opts.includeTerminalDirect !== true) continue;
        }
        if (live.staleReason && !terminalRow) {
            staleDirectWork.push(record);
            continue;
        }
        records.push(record);
    }

    records.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    staleDirectWork.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    terminalDirectWork.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const summary = buildMeshActiveWorkSummary(records);
    summary.staleDirectCount = staleDirectWork.length;
    const staleDirectWorkNote = staleDirectWork.length > 0
        ? 'These are orphaned ledger entries whose original node or session no longer exists in the live mesh. They are historical/recovery evidence only — not active or unresolved work. Do not treat staleDirectCount as a status mismatch; use the queue (source: queue) as authoritative for pending/assigned tasks.'
        : undefined;
    if (staleDirectWorkNote) {
        summary.staleDirectNote = staleDirectWorkNote;
    }
    return { activeWork: records, staleDirectWork, staleDirectWorkNote, terminalDirectWork, summary };
}
