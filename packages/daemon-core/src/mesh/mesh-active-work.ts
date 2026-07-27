import type { MeshLedgerEntry } from './mesh-ledger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import type { MeshWorkQueueEntry, DirectDispatchRecord } from './mesh-work-queue.js';
import { deleteDirectDispatchesByTaskId } from './mesh-work-queue.js';
import { meshNodeIdMatches, daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveTurnAttemptRow, presentationFromAttemptRow } from './mesh-turn-presentation.js';
import type { TurnStage } from './mesh-turn-ledger.js';

export type MeshActiveWorkSource = 'queue' | 'direct';
export type MeshActiveWorkStatus = 'pending' | 'assigned' | 'generating' | 'idle' | 'failed' | 'awaiting_approval' | 'awaiting_choice' | 'finalizing';

/**
 * TURN-PRESENTATION (Stage 6): task-level active-work status for a task with a
 * Stage 5 attempt comes from the SAME reducer projection as read_chat /
 * session_status / mesh_status — so all surfaces agree on stage and attemptId.
 * `finalizing` is surfaced verbatim (never collapsed to idle) until the reducer
 * commits terminal. Returns null when no attempt exists (legacy behavior keeps
 * governing — the ONLY fallback condition).
 */
function turnProjectionActiveWorkStatus(meshId: string, taskId: string): { status: MeshActiveWorkStatus; attemptId: string; stage: TurnStage } | null {
    const row = resolveTurnAttemptRow({ meshId, taskId });
    if (!row) return null;
    const presentation = presentationFromAttemptRow(row);
    const stage = presentation.stage;
    if (!stage) return null;
    switch (stage) {
        case 'accepted':
        case 'delivered':
            return { status: 'assigned', attemptId: presentation.attemptId!, stage };
        case 'consumed':
        case 'generating':
            return { status: 'generating', attemptId: presentation.attemptId!, stage };
        case 'waiting_approval':
            return { status: 'awaiting_approval', attemptId: presentation.attemptId!, stage };
        case 'waiting_choice':
            return { status: 'awaiting_choice', attemptId: presentation.attemptId!, stage };
        case 'finalizing':
            return { status: 'finalizing', attemptId: presentation.attemptId!, stage };
        case 'completed':
            return { status: 'idle', attemptId: presentation.attemptId!, stage };
        case 'failed':
        case 'cancelled':
            return { status: 'failed', attemptId: presentation.attemptId!, stage };
    }
}

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
    /** Stage 6: attempt identity + causal stage when the reducer projection is authoritative. */
    attemptId?: string;
    turnStage?: string;
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

export function sessionStatusFromNodes(nodes: any[] | undefined, nodeId?: string, sessionId?: string): { status?: MeshActiveWorkStatus; staleReason?: string } {
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
        if (typeof item === 'string') return sessionIdsEquivalent(item, sessionId);
        const id = readString(item?.id) || readString(item?.sessionId) || readString(item?.session_id) || readString(item?.runtimeSessionId) || readString(item?.instanceId);
        return sessionIdsEquivalent(id, sessionId);
    });
    if (!session) return { staleReason: 'direct task session is not present in live session records' };
    if (typeof session === 'string') return {};
    const raw = `${readString(session.status) || ''} ${readString(session.lifecycle) || ''} ${readString(session.state) || ''} ${readString(session.activeChat?.status) || ''}`.toLowerCase();
    // A question picker surfaces as waiting_choice — distinct from an approval modal.
    // Check it first so a question worker is not mislabeled awaiting_approval and
    // pulled into the approval inbox (mission f1d25e11).
    if (raw.includes('waiting_choice') || raw.includes('choice')) return { status: 'awaiting_choice' };
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
    if (dispatch.sessionId && sessionIdsEquivalent(terminal.sessionId, dispatch.sessionId)) return true;
    // Node ids can carry interchangeable daemon-id forms (bare `mach_X` vs
    // `daemon_mach_X`); compare under the canonical machine core, not raw `===`.
    return Boolean(dispatch.nodeId && daemonIdsEquivalent(terminal.nodeId, dispatch.nodeId) && !dispatch.sessionId);
}

function statusFromTerminal(entry: MeshLedgerEntry): MeshActiveWorkStatus {
    if (entry.kind === 'task_approval_needed') return 'awaiting_approval';
    // A question (waiting_choice) is a distinct blocked state — kept OUT of
    // awaiting_approval so it is not surfaced in the approval inbox / mesh_approve
    // flow (mission f1d25e11). Answered via mesh_answer_question.
    if (entry.kind === 'task_question_pending') return 'awaiting_choice';
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

/**
 * Build a direct-dispatch MeshActiveWorkRecord from a `task_dispatched` ledger entry,
 * matching it against the terminal ledger entries and live mesh nodes. Shared by the
 * remote-ledger scan (inside the MeshRuntimeStore branch) and the full-ledger scan
 * (standalone branch) — those two loops were previously byte-identical except for a
 * single `dbTaskIds.has(taskId)` skip guard that stays in the caller. Returns the record
 * plus `terminalRow` so the caller can route it into terminal/stale/active buckets.
 */
function buildLedgerDirectDispatchRecord(
    dispatch: MeshLedgerEntry,
    ctx: { terminals: MeshLedgerEntry[]; nodes: any[] | undefined; now: number },
): { record: MeshActiveWorkRecord; terminalRow: boolean } {
    const taskId = directDispatchTaskId(dispatch);
    const matching = ctx.terminals
        .filter(entry => new Date(entry.timestamp).getTime() >= new Date(dispatch.timestamp).getTime())
        .filter(entry => terminalMatchesDispatch(entry, dispatch, taskId));
    // APPROVAL-Q1-REALTIME (stale level state): prefer a REAL terminal (task_completed /
    // task_failed) over an earlier task_approval_needed for the same dispatch. An approval
    // that was subsequently resolved — the worker went on to complete or fail — must NOT keep
    // the node pinned to awaiting_approval, which would falsely tell the coordinator (via
    // mesh_status/read_chat) the worker is still blocked (the UX inversion this fix avoids).
    // Among real terminals the earliest still wins (unchanged); approval-needed is selected
    // only when no real terminal followed it. `terminals` is sorted ascending, so `.find`
    // returns the earliest real terminal.
    const terminal = matching.find(entry => entry.kind !== 'task_approval_needed') || matching[0];
    const terminalStatus = terminal ? statusFromTerminal(terminal) : undefined;
    const live = sessionStatusFromNodes(ctx.nodes, dispatch.nodeId, dispatch.sessionId);
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
        elapsedMs: elapsedSince(dispatch.timestamp, ctx.now),
        terminal: terminalRow,
        terminalKind: terminal?.kind,
        terminalAt: terminal?.timestamp,
        staleReason: live.staleReason || ledgerOnlyStaleReason,
        ...(isFreshUnacknowledged ? { staleDispatchUnacknowledged: true } : {}),
    };
    return { record, terminalRow };
}

/**
 * One session awaiting an approval decision — the derived row `mesh_list_pending_approvals`
 * returns and the UI approvals inbox renders. A thin projection of the `awaiting_approval`
 * MeshActiveWorkRecord: it carries exactly what a coordinator needs to route a follow-up
 * mesh_approve(node_id, session_id) and what the inbox needs to label the item. No new
 * store or data source — derived from the same buildMeshActiveWork records.
 */
export interface MeshPendingApproval {
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskId: string;
    taskTitle: string;
    /** Always 'awaiting_approval' — kept explicit so consumers can render/assert on it. */
    status: 'awaiting_approval';
    /** ISO timestamp the underlying task was created/dispatched — the "waiting since" anchor. */
    waitingSince: string;
    /** Milliseconds the record has been outstanding (elapsed from dispatch/create). */
    waitingMs: number;
}

/**
 * Derive the mesh-wide pending-approval inbox from already-built active-work records.
 * Filter+projection over `status === 'awaiting_approval'`, then a deterministic dedup
 * keyed by (nodeId, sessionId) — no new store, no probe;
 * the caller supplies the records (typically buildMeshActiveWork(...).activeWork so the
 * enumeration reuses the exact classification `mesh_status` already computes). Records
 * without a node/session are skipped: an approval that cannot be routed to a live
 * node+session via mesh_approve is not actionable inbox content.
 */
export function collectPendingApprovals(activeWork: MeshActiveWorkRecord[]): MeshPendingApproval[] {
    const approvals: MeshPendingApproval[] = [];
    for (const record of activeWork) {
        if (record.status !== 'awaiting_approval') continue;
        if (!record.nodeId || !record.sessionId) continue;
        approvals.push({
            nodeId: record.nodeId,
            sessionId: record.sessionId,
            providerType: record.providerType,
            taskId: record.taskId,
            taskTitle: record.taskTitle,
            status: 'awaiting_approval',
            waitingSince: record.dispatchedAt || record.createdAt,
            waitingMs: record.elapsedMs,
        });
    }
    // DETERMINISTIC DEDUP (rc.19 live defect: mesh_list_pending_approvals returned the
    // same session twice). One live session exposes exactly ONE modal at a time, so one
    // (nodeId, sessionId) pair can never need two inbox rows — yet the active-work build
    // can yield two records for it (a queue-assigned task record AND a direct-dispatch
    // record bound to the same session, or the MeshRuntimeStore + remote-ledger paths
    // overlapping). Keyed by node/session identity; the longest-waiting row wins (it is
    // the most-stalled binding and the one the coordinator should act on first). Ties
    // keep the first-seen row — activeWork arrives createdAt-sorted, so the outcome is
    // deterministic across identical inputs.
    const bySession = new Map<string, MeshPendingApproval>();
    for (const approval of approvals) {
        const key = `${approval.nodeId}::${approval.sessionId}`;
        const existing = bySession.get(key);
        if (!existing || approval.waitingMs > existing.waitingMs) {
            bySession.set(key, approval);
        }
    }
    const deduped = [...bySession.values()];
    // Longest-waiting first — the coordinator/inbox should address the most-stalled approval first.
    deduped.sort((a, b) => b.waitingMs - a.waitingMs);
    return deduped;
}

export function buildMeshActiveWorkSummary(activeWork: MeshActiveWorkRecord[]): MeshActiveWorkSummary {
    const statusCounts: Record<MeshActiveWorkStatus, number> = {
        pending: 0,
        assigned: 0,
        generating: 0,
        idle: 0,
        failed: 0,
        awaiting_approval: 0,
        awaiting_choice: 0,
        finalizing: 0,
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
        const queueNodeId = task.assignedNodeId || task.targetNodeId;
        const queueSessionId = task.assignedSessionId || task.targetSessionId;
        // APPROVAL-INBOX-BLINDSPOT (Fix A.2): a queue task previously reported its raw DB
        // status (pending|assigned) verbatim, while direct dispatches consulted the live
        // session status via sessionStatusFromNodes. That asymmetry meant a queue-dispatched
        // worker sitting on an approval modal was recorded as 'assigned', so
        // collectPendingApprovals (which filters status==='awaiting_approval') never counted
        // it and mesh_list_pending_approvals returned 0. Overlay the live session status for
        // an ASSIGNED queue task so an approval (or an active generation) on its bound session
        // is reflected — the exact promotion the direct-dispatch path already does. A 'pending'
        // task has no bound session yet, so it keeps its queue status.
        const queueLive = task.status === 'assigned'
            ? sessionStatusFromNodes(opts.nodes, queueNodeId ?? undefined, queueSessionId ?? undefined)
            : {};
        let queueStatus: MeshActiveWorkStatus = queueLive.status === 'awaiting_approval'
            || queueLive.status === 'awaiting_choice'
            || queueLive.status === 'generating'
            ? queueLive.status
            : task.status;
        // Stage 6: when the task has a turn attempt, the reducer projection is the
        // status authority (equivalent to read_chat/session_status/dashboard).
        const turnOverlay = task.status === 'assigned'
            ? turnProjectionActiveWorkStatus(opts.meshId, task.id)
            : null;
        if (turnOverlay) queueStatus = turnOverlay.status;
        records.push({
            taskId: task.id,
            source: 'queue',
            status: queueStatus,
            ...(turnOverlay ? { attemptId: turnOverlay.attemptId, turnStage: turnOverlay.stage } : {}),
            nodeId: queueNodeId,
            sessionId: queueSessionId,
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
            // Stage 6: the reducer projection outranks the live point sample for
            // nonterminal direct dispatches (same authority as the queue path).
            const turnOverlay = isTerminal ? null : turnProjectionActiveWorkStatus(opts.meshId, dispatch.taskId);
            const status: MeshActiveWorkStatus = isTerminal
                ? (dbStatus === 'completed' ? 'idle' : 'failed')
                : turnOverlay?.status || live.status || (dbStatus === 'acked' ? 'generating' : 'assigned');
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
                ...(turnOverlay ? { attemptId: turnOverlay.attemptId, turnStage: turnOverlay.stage } : {}),
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
            if (dbTaskIds.has(directDispatchTaskId(dispatch))) continue; // already covered by MeshRuntimeStore path above
            const { record, terminalRow } = buildLedgerDirectDispatchRecord(dispatch, { terminals, nodes: opts.nodes, now });
            if (terminalRow) {
                terminalDirectWork.push(record);
                if (opts.includeTerminalDirect !== true) continue;
            }
            if (record.staleReason && !terminalRow) {
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
            const { record, terminalRow } = buildLedgerDirectDispatchRecord(dispatch, { terminals, nodes: opts.nodes, now });
            if (terminalRow) {
                terminalDirectWork.push(record);
                if (opts.includeTerminalDirect !== true) continue;
            }
            if (record.staleReason && !terminalRow) {
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
