/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * 12 tools: mesh_status, mesh_list_nodes, mesh_send_task, mesh_read_chat,
 *           mesh_read_debug,
 *           mesh_launch_session, mesh_git_status, mesh_checkpoint, mesh_approve,
 *           mesh_clone_node, mesh_remove_node, mesh_cleanup_sessions
 */

import { CloudTransport } from '../transports/cloud.js';
import { IpcTransport } from '../transports/ipc.js';
import { isLocalTransport } from '../transports/mode.js';
import type { McpTransport } from '../transports/mode.js';
import { compactChatPayload } from './chat-compact.js';
import { annotateRapidReadChatAdvisory } from './read-chat-polling-advisory.js';
import type { LocalMeshEntry, LocalMeshNodeEntry, RepoMeshPolicy, RepoMeshRelatedRepo } from '@adhdev/daemon-core';
import { appendLedgerEntry, readLedgerEntries, getLedgerSummary, enqueueTask, getQueue, cancelTask, requeueTask, getSessionRecoveryContext } from '@adhdev/daemon-core';

export interface MeshContext {
    mesh: LocalMeshEntry;
    transport: McpTransport;
    /** Daemon ID for this local machine (local mode) */
    localDaemonId?: string;
    /** Machine Registry ID for this local machine */
    localMachineId?: string;
}

type MeshSessionProviderMetadata = {
    providerType: string;
    providerSessionId?: string;
};

const meshSessionProviderMetadata = new Map<string, MeshSessionProviderMetadata>();

// ─── Helpers ────────────────────────────────────

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function findNode(mesh: LocalMeshEntry, nodeId: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`Node '${nodeId}' is not a member of mesh '${mesh.name}'`);
    return node;
}

const DUPLICATE_DISPATCH_WINDOW_MS = 60_000;
const STALE_ASSIGNED_QUEUE_MS = 30 * 60_000;

/**
 * Refresh the MCP process's mesh snapshot from the daemon inline mesh cache.
 * This is required for status/list tools when a previous MCP process already
 * created or removed worktree nodes through clone_mesh_node/remove_mesh_node.
 */
async function refreshMeshFromDaemon(ctx: MeshContext): Promise<void> {
    if (!(ctx.transport instanceof IpcTransport)) return;
    try {
        const result = await (ctx.transport as IpcTransport).command('get_mesh', { meshId: ctx.mesh.id }) as any;
        if (!result?.success || !Array.isArray(result.mesh?.nodes)) return;
        const refreshedNodes = result.mesh.nodes
            .filter((n: any) => n?.id)
            .map((n: any) => n as LocalMeshNodeEntry);
        if (!refreshedNodes.length) return;
        (ctx.mesh.nodes as LocalMeshNodeEntry[]).splice(0, ctx.mesh.nodes.length, ...refreshedNodes);
        ctx.mesh.updatedAt = result.mesh.updatedAt ?? ctx.mesh.updatedAt;
    } catch { /* refresh is best-effort; callers still report their original status/errors */ }
}

async function findNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry> {
    const hit = ctx.mesh.nodes.find(n => n.id === nodeId);
    if (hit) return hit;

    await refreshMeshFromDaemon(ctx);

    const refreshed = ctx.mesh.nodes.find(n => n.id === nodeId);
    if (!refreshed) throw new Error(`Node '${nodeId}' is not a member of mesh '${ctx.mesh.name}'`);
    return refreshed;
}

async function findOptionalNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry | null> {
    const hit = ctx.mesh.nodes.find(n => n.id === nodeId);
    if (hit) return hit;

    await refreshMeshFromDaemon(ctx);

    return ctx.mesh.nodes.find(n => n.id === nodeId) ?? null;
}

function hasRecentDuplicateDispatch(ctx: MeshContext, args: { node_id: string; session_id?: string; message: string }): { duplicate: boolean; entry?: any; source?: 'ledger' | 'queue' } {
    const now = Date.now();
    const normalizedMessage = args.message.trim();

    for (const task of getQueue(ctx.mesh.id)) {
        const timestamp = new Date(task.updatedAt || task.createdAt).getTime();
        if (!Number.isFinite(timestamp) || now - timestamp > DUPLICATE_DISPATCH_WINDOW_MS) continue;
        if (task.targetNodeId && task.targetNodeId !== args.node_id) continue;
        if (task.assignedNodeId && task.assignedNodeId !== args.node_id) continue;
        if (args.session_id && task.targetSessionId !== args.session_id && task.assignedSessionId !== args.session_id) continue;
        if (task.message?.trim() === normalizedMessage) {
            return { duplicate: true, entry: task, source: 'queue' };
        }
    }

    const entries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const timestamp = new Date(entry.timestamp).getTime();
        if (Number.isFinite(timestamp) && now - timestamp > DUPLICATE_DISPATCH_WINDOW_MS) break;
        if (entry.kind !== 'task_dispatched') continue;
        if (entry.nodeId !== args.node_id) continue;
        if (args.session_id && entry.sessionId !== args.session_id) continue;
        if (typeof entry.payload?.message !== 'string') continue;
        if (entry.payload.message.trim() === normalizedMessage) {
            return { duplicate: true, entry, source: 'ledger' };
        }
    }
    return { duplicate: false };
}

function buildMissingNodeReadChatRecovery(ctx: MeshContext, args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean }): Record<string, unknown> {
    const entries = readLedgerEntries(ctx.mesh.id, { tail: 300 });
    const relatedEntries = entries.filter(entry => entry.nodeId === args.node_id || entry.sessionId === args.session_id);
    const completedEntries = relatedEntries.filter(entry => entry.kind === 'task_completed');
    const lastDispatch = [...relatedEntries].reverse().find(entry => entry.kind === 'task_dispatched');
    const lastTerminal = [...relatedEntries].reverse().find(entry => entry.kind === 'task_completed' || entry.kind === 'task_failed' || entry.kind === 'task_stalled');
    const lastRemoved = [...relatedEntries].reverse().find(entry => entry.kind === 'node_removed');
    const lastLaunch = [...relatedEntries].reverse().find(entry => entry.kind === 'session_launched');
    const providerSessionId = args.provider_session_id
        || readString(lastTerminal?.payload?.providerSessionId)
        || readString(lastLaunch?.payload?.providerSessionId)
        || readString(lastDispatch?.payload?.providerSessionId);
    const finalSummary = readString(lastTerminal?.payload?.finalSummary)
        || readString(lastTerminal?.payload?.compactSummary)
        || readString(lastTerminal?.payload?.summary);
    const ledger = {
        taskCompletedFound: completedEntries.length > 0,
        nodeRemovedFound: !!lastRemoved,
        providerType: lastTerminal?.providerType || lastLaunch?.providerType || lastDispatch?.providerType,
        providerSessionId,
        nodeRemovedAt: lastRemoved?.timestamp,
        sessionCleanupMode: readString(lastRemoved?.payload?.sessionCleanupMode),
        readDebugLocator: readString(lastTerminal?.payload?.readDebugLocator) || readString(lastTerminal?.payload?.debugBundlePath),
    };

    if (finalSummary) {
        return {
            success: true,
            compact: args.compact === true,
            recoveredFromLedger: true,
            nodeId: args.node_id,
            sessionId: args.session_id,
            summary: finalSummary,
            ledger,
            messages: [{ role: 'assistant', content: finalSummary, isHistorical: true }],
        };
    }

    return {
        success: false,
        recoverable: true,
        code: 'mesh_removed_node_transcript_unavailable',
        error: `Node '${args.node_id}' is not a current member of mesh '${ctx.mesh.name}'.`,
        nodeId: args.node_id,
        sessionId: args.session_id,
        providerSessionId,
        reason: 'node_not_in_current_mesh_snapshot',
        ledger,
        completedSessionSeenInLedger: ledger.taskCompletedFound,
        lastDispatch: lastDispatch ? {
            timestamp: lastDispatch.timestamp,
            sessionId: lastDispatch.sessionId,
            providerType: lastDispatch.providerType,
            taskId: typeof lastDispatch.payload?.taskId === 'string' ? lastDispatch.payload.taskId : undefined,
            messagePreview: typeof lastDispatch.payload?.message === 'string' ? lastDispatch.payload.message.slice(0, 500) : undefined,
        } : null,
        lastTerminalEvent: lastTerminal ? {
            kind: lastTerminal.kind,
            timestamp: lastTerminal.timestamp,
            sessionId: lastTerminal.sessionId,
            providerType: lastTerminal.providerType,
            taskId: typeof lastTerminal.payload?.taskId === 'string' ? lastTerminal.payload.taskId : undefined,
            payload: lastTerminal.payload,
        } : null,
        nextSteps: [
            providerSessionId
                ? `Retry mesh_read_chat with provider_session_id='${providerSessionId}' on a current live node for the same daemon if one exists.`
                : 'If the node UI shows a provider transcript id, retry mesh_read_chat/mesh_read_debug with provider_session_id.',
            'Use mesh_read_debug with the provider_session_id or daemon-side debug bundle locator if available.',
            'Check mesh_task_history for task_completed and node_removed entries before redispatching; do not resend solely because transcript recovery failed.',
            'If this node was removed with stop_and_delete, the runtime transcript may be gone; rely on the ledger summary/locator or ask the operator for the saved UI output.',
        ],
        recoveryHints: [
            'The worktree/node may have been removed or the mesh snapshot may be stale after task completion.',
            'If you have a provider_session_id, retry mesh_read_chat with that value while targeting a live node for the same daemon if available.',
            'Use mesh_read_debug with provider_session_id, or inspect the daemon/session-host history locator if the transcript has already been archived.',
            'Avoid redispatching the same task solely because read_chat could not recover the transcript; check task_history and git status first.',
        ],
    };
}

function annotateQueueStaleness(queue: any[]): any[] {
    const now = Date.now();
    return queue.map(task => {
        const taskStatus = typeof task?.status === 'string' ? task.status : undefined;
        const annotated = {
            ...task,
            taskStatus,
            dispatchedAt: task?.createdAt,
            ...(taskStatus === 'assigned' ? { activeTaskId: task.id } : {}),
            ...(taskStatus === 'completed' || taskStatus === 'failed' ? {
                isHistorical: true,
                completedAt: task.updatedAt,
            } : {}),
        };
        if (taskStatus !== 'assigned') return annotated;
        const updatedAt = new Date(task.updatedAt).getTime();
        const ageMs = Number.isFinite(updatedAt) ? now - updatedAt : null;
        if (ageMs === null || ageMs < STALE_ASSIGNED_QUEUE_MS) return annotated;
        return {
            ...annotated,
            stale: true,
            staleAssigned: true,
            staleReason: 'assigned task has not reached a terminal state within 30 minutes',
            assignedAgeMs: ageMs,
        };
    });
}

function unwrapCommandPayload(value: any): any {
    let current = value;
    const seen = new Set<any>();
    for (let depth = 0; depth < 8; depth += 1) {
        if (!current || typeof current !== 'object' || seen.has(current)) break;
        seen.add(current);

        const nested = current.result ?? current.payload;
        if (!nested || typeof nested !== 'object') break;
        current = nested;
    }
    return current;
}

function isTerminalSessionRecord(session: any): boolean {
    const status = typeof session?.status === 'string' ? session.status.toLowerCase() : '';
    const lifecycle = typeof session?.lifecycle === 'string' ? session.lifecycle.toLowerCase() : '';
    const state = typeof session?.state === 'string' ? session.state.toLowerCase() : '';
    return [status, lifecycle, state].some(value => ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(value));
}

function isIdleSessionRecord(session: any): boolean {
    if (isTerminalSessionRecord(session)) return false;
    const status = typeof session?.status === 'string' ? session.status.toLowerCase() : '';
    const chatStatus = typeof session?.activeChat?.status === 'string' ? session.activeChat.status.toLowerCase() : '';
    return status === 'idle' || chatStatus === 'waiting_input';
}

function chooseDispatchableSession(sessions: any[], providerType: string, meshId: string, nodeId: string): any | undefined {
    const live = sessions.filter(session => !isTerminalSessionRecord(session));
    const matchingProvider = (session: any) => !providerType || session?.providerType === providerType || session?.cliType === providerType;
    const meshSessions = live.filter((session: any) =>
        session?.settings?.meshNodeFor === meshId ||
        session?.settings?.meshNodeId === nodeId
    );
    return meshSessions.find(session => isIdleSessionRecord(session) && matchingProvider(session))
        || meshSessions.find(matchingProvider)
        || live.find(session => isIdleSessionRecord(session) && matchingProvider(session))
        || live.find(matchingProvider)
        || live.find(isIdleSessionRecord)
        || live[0];
}

function findNestedPayload(value: any, predicate: (payload: any) => boolean): any {
    const seen = new Set<any>();
    const stack: Array<{ payload: any; depth: number }> = [{ payload: value, depth: 0 }];

    while (stack.length) {
        const { payload, depth } = stack.pop()!;
        if (predicate(payload)) return payload;
        if (!payload || typeof payload !== 'object' || seen.has(payload) || depth >= 8) continue;
        seen.add(payload);

        // Cloud/daemon relay layers have used both `result` and `payload` for
        // command_result bodies. Follow only those envelope keys so clone node
        // discovery stays tied to returned command payloads, not arbitrary data.
        for (const key of ['payload', 'result']) {
            if (key in payload) stack.push({ payload: payload[key], depth: depth + 1 });
        }
    }

    return value;
}

function extractCloneNodePayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.node?.id));
}

function extractGitStatus(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.status ?? value?.status ?? payload;
}

function extractGitDiff(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.diffSummary ?? payload?.diff ?? value?.diffSummary ?? value?.diff ?? payload;
}

function extractLaunchPayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.sessionId || payload?.id || payload?.runtimeSessionId));
}

type MeshLaunchFailureClassification = {
    code: 'p2p_unavailable' | 'local_ipc_unavailable' | 'mesh_transport_timeout' | 'mesh_launch_failed';
    reason: string;
    transport: string;
};

function classifyMeshLaunchFailure(error: unknown): MeshLaunchFailureClassification {
    const message = error instanceof Error ? error.message : String(error || 'launch failed');
    const lower = message.toLowerCase();
    if (lower.includes('p2p') || lower.includes('datachannel') || lower.includes('node-datachannel')) {
        return { code: 'p2p_unavailable', reason: 'daemon_mesh_p2p_transport_unavailable', transport: 'daemon_mesh_p2p' };
    }
    if (lower.includes('cannot connect to daemon ipc') || lower.includes('daemon ipc command')) {
        return { code: 'local_ipc_unavailable', reason: 'local_daemon_ipc_unavailable', transport: 'local_ipc' };
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
        return { code: 'mesh_transport_timeout', reason: 'mesh_transport_timeout', transport: 'mesh_transport' };
    }
    return { code: 'mesh_launch_failed', reason: 'provider_launch_failed', transport: 'mesh_transport' };
}

function buildWorktreeCleanupHint(node: LocalMeshNodeEntry): Record<string, unknown> | undefined {
    if (!node.isLocalWorktree) return undefined;
    return {
        tool: 'mesh_remove_node',
        args: { node_id: node.id, session_cleanup_mode: 'preserve' },
        hint: `If the worktree is no longer needed, remove the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`,
    };
}

function buildRecoverableLaunchFailure(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    providerType: string | undefined,
    error: unknown,
): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error || 'launch failed');
    const classified = classifyMeshLaunchFailure(error);
    const cleanup = buildWorktreeCleanupHint(node);
    return {
        success: false,
        recoverable: true,
        code: classified.code,
        reason: classified.reason,
        transport: classified.transport,
        error: message,
        meshId: ctx.mesh.id,
        nodeId: node.id,
        daemonId: node.daemonId,
        workspace: node.workspace,
        isLocalWorktree: node.isLocalWorktree === true,
        worktreeBranch: node.worktreeBranch,
        clonedFromNodeId: node.clonedFromNodeId,
        ...(providerType ? { resolvedProviderType: providerType } : {}),
        retryHint: `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ''}) after daemon mesh transport/P2P is healthy.`,
        ...(cleanup ? { cleanup } : {}),
        nextStepHints: [
            `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ''}) after checking daemon/P2P health.`,
            ...(cleanup ? [`Cleanup orphan worktree node with mesh_remove_node(node_id: "${node.id}") if retry is not desired.`] : []),
            'Run mesh_status to see the degraded reason and recovery hints before redispatching work.',
        ],
    };
}

function recordRecoverableLaunchFailure(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    providerType: string | undefined,
    error: unknown,
): Record<string, unknown> {
    const failure = buildRecoverableLaunchFailure(ctx, node, providerType, error);
    try {
        appendLedgerEntry(ctx.mesh.id, {
            kind: 'recovery_attempted',
            nodeId: node.id,
            providerType,
            payload: {
                event: 'session_launch_failed',
                ...failure,
            },
        });
    } catch { /* ledger append is best-effort */ }
    return failure;
}

function getLatestActiveLaunchFailure(meshId: string, nodeId: string): Record<string, unknown> | null {
    const entries = readLedgerEntries(meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.nodeId !== nodeId) continue;
        if (entry.kind === 'session_launched' || entry.kind === 'node_removed') return null;
        if (entry.kind === 'recovery_attempted' && entry.payload?.event === 'session_launch_failed') {
            return { timestamp: entry.timestamp, ...entry.payload };
        }
    }
    return null;
}

/**
 * For IpcTransport + remote node: resolve an active session on the node and
 * dispatch an agent_command directly via P2P relay (mesh_relay_command).
 *
 * This bypasses the local queue (which remote daemons cannot read) and sends
 * the message directly to the session running on the remote daemon.
 *
 * Returns { success, sessionId } or throws.
 */
async function ipcDispatchToRemoteAgent(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: { session_id?: string; message: string; providerType?: string },
): Promise<{ success: true; dispatched: true; sessionId: string } | { success: false; error: string }> {
    const transport = ctx.transport as IpcTransport;
    const daemonId = node.daemonId!;

    let sessionId = args.session_id?.trim() || '';
    // Resolve provider type: caller arg > node policy providerPriority > empty (fuzzy fallback)
    const providerPriorityList: string[] = Array.isArray((node.policy as any)?.providerPriority)
        ? (node.policy as any).providerPriority
        : [];
    let resolvedProviderType = args.providerType?.trim() || providerPriorityList[0] || '';

    // If no session_id given, ask the remote daemon via get_status_metadata.
    // mesh_relay_command wraps the response: { success, result: { success, status: { sessions[] } } }
    if (!sessionId) {
        try {
                const relayResult = await transport.meshCommand(daemonId, 'get_status_metadata', {});
            // Unwrap relay envelope: relayResult.result.status.sessions
            const innerResult = relayResult?.result ?? relayResult;
            const statusObj = innerResult?.status ?? innerResult;
            const sessions: any[] = Array.isArray(statusObj?.sessions) ? statusObj.sessions : [];
    
            // Prefer live idle sessions launched for this mesh node. Never route
            // a new task into restored/stopped session records; that produces the
            // coordinator-visible "pending only, chat never received it" failure.
            const targetSession = chooseDispatchableSession(sessions, resolvedProviderType, ctx.mesh.id, node.id);

            if (targetSession?.id || targetSession?.sessionId) {
                sessionId = targetSession.id || targetSession.sessionId;
                if (!resolvedProviderType) {
                    resolvedProviderType = targetSession.providerType || targetSession.cliType || '';
                }
            }
        } catch (e: any) {
                // fall through — will attempt dispatch with just providerType (fuzzy)
        }
    }

    // agent_command requires agentType — fail if we cannot determine provider type
    if (!resolvedProviderType) {
        return { success: false, error: `Cannot dispatch to remote node '${node.id}': providerType unknown. Set providerPriority on the node policy or call mesh_launch_session first.` };
    }

    try {
        const dispatchResult = await transport.meshCommand(daemonId, 'agent_command', {
            ...(sessionId ? { targetSessionId: sessionId } : {}),
            agentType: resolvedProviderType,
            cliType: resolvedProviderType,
            action: 'send_chat',
            message: args.message,
        });
        const dispatchPayload = unwrapCommandPayload(dispatchResult);
        if (dispatchPayload?.success === false || dispatchResult?.success === false) {
            return { success: false, error: `P2P dispatch failed: ${dispatchPayload?.error || dispatchResult?.error || 'agent_command rejected the task'}` };
        }
        return { success: true, dispatched: true, sessionId: sessionId || resolvedProviderType };
    } catch (e: any) {
        return { success: false, error: `P2P dispatch failed: ${e?.message || String(e)}` };
    }
}

function resolveCoordinatorNode(ctx: MeshContext): LocalMeshNodeEntry | undefined {
    const preferredNodeId = typeof ctx.mesh.coordinator?.preferredNodeId === 'string'
        ? ctx.mesh.coordinator.preferredNodeId.trim()
        : '';
    if (preferredNodeId) {
        const preferred = ctx.mesh.nodes.find(n => n.id === preferredNodeId && typeof n.daemonId === 'string' && n.daemonId.trim());
        if (preferred) return preferred;
    }
    if (ctx.localMachineId) {
        const byMachine = ctx.mesh.nodes.find(n => (n as any).machineId === ctx.localMachineId);
        if (byMachine) return byMachine;
    }
    if (ctx.localDaemonId) {
        return ctx.mesh.nodes.find(n => n.daemonId === ctx.localDaemonId);
    }
    return undefined;
}

function meshSessionCacheKey(nodeId: string, runtimeSessionId: string): string {
    return `${nodeId}:${runtimeSessionId}`;
}

function countUncommittedChanges(status: any): number {
    if (typeof status?.uncommittedChanges === 'number') return status.uncommittedChanges;
    const keys = ['staged', 'modified', 'untracked', 'deleted', 'renamed'];
    const counted = keys.reduce((sum, key) => sum + (Number.isFinite(Number(status?.[key])) ? Number(status[key]) : 0), 0);
    const conflicts = Array.isArray(status?.conflictFiles) ? status.conflictFiles.length : (status?.hasConflicts ? 1 : 0);
    return counted + conflicts;
}

function isGitStatusDirty(status: any): boolean {
    if (typeof status?.isDirty === 'boolean') return status.isDirty;
    if (typeof status?.dirty === 'boolean') return status.dirty;
    return countUncommittedChanges(status) > 0;
}

function readRelatedRepos(node: LocalMeshNodeEntry): RepoMeshRelatedRepo[] {
    const raw = Array.isArray((node as any).relatedRepos)
        ? (node as any).relatedRepos
        : Array.isArray((node.policy as any)?.relatedRepos)
            ? (node.policy as any).relatedRepos
            : [];

    return raw
        .map((entry: any) => ({
            label: typeof entry?.label === 'string' ? entry.label.trim() : '',
            workspace: typeof entry?.workspace === 'string' ? entry.workspace.trim() : '',
        }))
        .filter((entry: RepoMeshRelatedRepo) => Boolean(entry.label && entry.workspace));
}

function summarizeRelatedRepoStatus(repo: RepoMeshRelatedRepo, status: any): Record<string, unknown> {
    const dirty = isGitStatusDirty(status);
    return {
        label: repo.label,
        workspace: repo.workspace,
        isGitRepo: status?.isGitRepo === true,
        branch: status?.branch ?? null,
        ahead: Number.isFinite(Number(status?.ahead)) ? Number(status.ahead) : 0,
        behind: Number.isFinite(Number(status?.behind)) ? Number(status.behind) : 0,
        dirty,
        uncommittedChanges: countUncommittedChanges(status),
        head: status?.headCommit ?? null,
        lastCommitSummary: status?.headMessage ?? null,
        ...(status?.reason ? { reason: status.reason } : {}),
        ...(status?.error ? { error: status.error } : {}),
    };
}

async function collectRelatedRepoStatuses(ctx: MeshContext, node: LocalMeshNodeEntry): Promise<Array<Record<string, unknown>>> {
    const relatedRepos = readRelatedRepos(node);
    if (!relatedRepos.length) return [];

    const results: Array<Record<string, unknown>> = [];
    for (const repo of relatedRepos) {
        try {
            const statusResult = !isLocalTransport(ctx.transport) && node.daemonId
                ? await (ctx.transport as CloudTransport).gitStatus(node.daemonId, repo.workspace, false)
                : await commandForNode(ctx, node, 'git_status', { workspace: repo.workspace });
            const status = extractGitStatus(statusResult);
            results.push(summarizeRelatedRepoStatus(repo, status));
        } catch (e: any) {
            results.push({
                label: repo.label,
                workspace: repo.workspace,
                error: e?.message || 'related repo status failed',
            });
        }
    }
    return results;
}

function findNodeByWorkspace(mesh: LocalMeshEntry, workspace: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.workspace === workspace);
    if (!node) throw new Error(`Workspace '${workspace}' is not a member of mesh '${mesh.name}'`);
    return node;
}

function readProviderPriority(policy: unknown): string[] {
    const raw = (policy as any)?.providerPriority;
    return Array.isArray(raw)
        ? raw.map((type: unknown) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
        : [];
}

function readSpawnedSessionVisibility(policy: unknown): 'visible' | 'hidden' {
    return (policy as any)?.spawnedSessionVisibility === 'hidden' ? 'hidden' : 'visible';
}

function missingProviderPriorityMessage(nodeId: string): string {
    return `Node '${nodeId}' has no providerPriority policy; pass type explicitly or configure node.policy.providerPriority`;
}

function getNodeLaunchReadiness(node: LocalMeshNodeEntry): Record<string, unknown> {
    const providerPriority = readProviderPriority(node.policy);
    if (providerPriority.length) {
        return {
            providerPriority,
            launchReady: true,
        };
    }

    return {
        providerPriority,
        launchReady: false,
        launchBlockedReason: 'missing_provider_priority',
        launchBlockedMessage: missingProviderPriorityMessage(node.id),
    };
}

async function commandForNode(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    command: string,
    args: Record<string, unknown> = {},
): Promise<any> {
    const isLocalNode =
        (ctx.localMachineId && (node as any).machineId === ctx.localMachineId) ||
        (ctx.localDaemonId && node.daemonId === ctx.localDaemonId);

    if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
        return ctx.transport.meshCommand(node.daemonId, command, args);
    }
    if (isLocalTransport(ctx.transport)) {
        return ctx.transport.command(command, args);
    }
    throw new Error(`Command '${command}' requires daemon IPC/local transport for node '${node.id}'`);
}

// ─── Tool Definitions ───────────────────────────

export const MESH_STATUS_TOOL = {
    name: 'mesh_status',
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions, recovery hints, and recommended next steps. Use this to decide which node to send work to or how to recover from failures.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
        },
    },
};

export const MESH_LIST_NODES_TOOL = {
    name: 'mesh_list_nodes',
    description: 'List all nodes in the mesh with their capabilities, platform, and workspace paths.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
        },
    },
};

export const MESH_ENQUEUE_TASK_TOOL = {
    name: 'mesh_enqueue_task',
    description: 'Add a new task to the mesh work queue. Idle nodes will automatically pull and execute tasks from this queue. Use this instead of mesh_send_task when you do not need to target a specific node.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            message: { type: 'string', description: 'The task instruction for the agent.' },
        },
        required: ['message'],
    },
};

export const MESH_VIEW_QUEUE_TOOL = {
    name: 'mesh_view_queue',
    description: 'View the current status of the mesh work queue (pending, assigned, completed, failed, cancelled tasks).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            status: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by task status: pending, assigned, completed, failed, cancelled. Returns all if omitted.',
            },
        },
    },
};

export const MESH_QUEUE_CANCEL_TOOL = {
    name: 'mesh_queue_cancel',
    description: 'Cancel a pending/assigned/completed/failed mesh queue task without deleting audit history. Use this to retire stale queue items that target dead sessions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'Queue task ID to cancel.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for cancellation.' },
        },
        required: ['task_id'],
    },
};

export const MESH_QUEUE_REQUEUE_TOOL = {
    name: 'mesh_queue_requeue',
    description: 'Return a mesh queue task to pending for retry. By default clears stale assigned owner and target session so another live session can claim it.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'Queue task ID to requeue.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for requeueing.' },
            target_node_id: { type: 'string', description: 'Optional replacement target node ID.' },
            target_session_id: { type: 'string', description: 'Optional replacement target runtime session ID.' },
            clear_target_node: { type: 'boolean', description: 'When true, remove any existing target node constraint.' },
            keep_target_session: { type: 'boolean', description: 'When true, preserve an existing target session if target_session_id is not provided. Defaults false to avoid stale session targets.' },
        },
        required: ['task_id'],
    },
};

export const MESH_SEND_TASK_TOOL = {
    name: 'mesh_send_task',
    description: 'Legacy push-based task assignment. Enqueues a task specifically targeted at a given node. The node will pull it immediately if idle.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from mesh_list_nodes).' },
            session_id: { type: 'string', description: 'Agent session ID on the target node.' },
            message: { type: 'string', description: 'Natural-language task to send to the agent.' },
        },
        required: ['node_id', 'session_id', 'message'],
    },
};

export const MESH_READ_CHAT_TOOL = {
    name: 'mesh_read_chat',
    description: 'Read recent chat messages from a delegated agent session on a mesh node. Use compact=true for coordinator context-efficient review: it filters tool/internal/debug chatter and returns the final user-visible summary plus recent key messages. If the runtime session has completed, provider_session_id can explicitly target provider transcript history.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to read from.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed sessions.' },
            tail: { type: 'number', description: 'Number of recent messages to return (default: 10).' },
            compact: { type: 'boolean', description: 'When true, return a compact coordinator summary instead of the full transcript: tool/internal/control/debug messages are excluded and only recent user-visible key messages plus the final assistant summary are included.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_READ_DEBUG_TOOL = {
    name: 'mesh_read_debug',
    description: 'Collect a daemon-side chat/parser debug bundle for a delegated agent session on a mesh node without opening the browser UI. Defaults to daemon_file delivery and returns a saved bundle locator.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to debug.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed session history.' },
            tail: { type: 'number', description: 'Number of recent read_chat messages to embed (default: 40).' },
            delivery: { type: 'string', enum: ['daemon_file', 'inline'], description: 'daemon_file saves the full sanitized bundle on the daemon; inline returns it directly. Default: daemon_file.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_LAUNCH_SESSION_TOOL = {
    name: 'mesh_launch_session',
    description: 'Launch a new agent session on a mesh node. Returns the session ID for subsequent send_task/read_chat calls. If the user names a provider, preserve it exactly: Hermes = hermes-cli, Claude Code/Claude = claude-cli, Codex = codex-cli, Gemini = gemini-cli. If type is omitted, resolve strictly from the node policy providerPriority and provider detection; fail closed when no configured provider is usable. Do not default to claude-cli.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            type: { type: 'string', description: 'Optional provider type to launch. Use hermes-cli for Hermes, claude-cli for Claude Code, codex-cli for Codex, gemini-cli for Gemini. When omitted, node.policy.providerPriority is probed in order.' },
        },
        required: ['node_id'],
    },
};

export const MESH_GIT_STATUS_TOOL = {
    name: 'mesh_git_status',
    description: 'Get git status for a mesh node workspace — branch, dirty state, changed files.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
        },
        required: ['node_id'],
    },
};

export const MESH_CHECKPOINT_TOOL = {
    name: 'mesh_checkpoint',
    description: 'Create a git checkpoint (commit) on a mesh node workspace.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            message: { type: 'string', description: 'Checkpoint commit message.' },
        },
        required: ['node_id', 'message'],
    },
};

export const MESH_APPROVE_TOOL = {
    name: 'mesh_approve',
    description: 'Approve or reject a pending action on a delegated agent session.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID with pending approval.' },
            action: { type: 'string', enum: ['approve', 'reject'], description: 'Action to take.' },
        },
        required: ['node_id', 'session_id', 'action'],
    },
};

export const MESH_CLONE_NODE_TOOL = {
    name: 'mesh_clone_node',
    description: 'Create a new worktree-based node from an existing node for isolated parallel work. '
        + 'Creates a git worktree on a new branch so multiple tasks can run on separate branches simultaneously.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            source_node_id: { type: 'string', description: 'Node ID to clone from (from mesh_list_nodes).' },
            branch: { type: 'string', description: 'Branch name for the new worktree (e.g. "feat/auth-refactor").' },
            base_branch: { type: 'string', description: 'Starting point for the branch (default: current HEAD).' },
        },
        required: ['source_node_id', 'branch'],
    },
};

export const MESH_REMOVE_NODE_TOOL = {
    name: 'mesh_remove_node',
    description: 'Remove a node from the mesh. If the node is a worktree, also cleans up the git worktree and directory. Session cleanup is controlled by mesh policy sessionCleanupOnNodeRemove unless session_cleanup_mode overrides it for this call.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID to remove.' },
            session_cleanup_mode: {
                type: 'string',
                enum: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'],
                description: 'Optional override for cleanup of delegated sessions attached to this node. preserve keeps history/processes; stop stops live runtimes only; delete_stopped removes completed transcripts only; stop_and_delete stops live runtimes and deletes records.',
            },
        },
        required: ['node_id'],
    },
};

export const MESH_CLEANUP_SESSIONS_TOOL = {
    name: 'mesh_cleanup_sessions',
    description: 'Manually clean up delegated session records for a mesh node without removing the node. Defaults should preserve reviewable history unless the caller chooses a mode explicitly.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID whose delegated sessions should be considered for cleanup.' },
            mode: {
                type: 'string',
                enum: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'],
                description: 'preserve = no-op; stop = release process occupancy by stopping live runtimes; delete_stopped = remove completed/stopped records while leaving live runtimes alone; stop_and_delete = stop live runtimes and delete records.',
            },
            session_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional explicit session IDs to limit cleanup to. When omitted, sessions are matched by node/workspace metadata.',
            },
            dry_run: { type: 'boolean', description: 'Preview matched/stopped/deleted/skipped session IDs without mutating session-host state.' },
        },
        required: ['node_id', 'mode'],
    },
};

export const MESH_TASK_HISTORY_TOOL = {
    name: 'mesh_task_history',
    description: 'Read the task ledger for this mesh — dispatched tasks, completions, failures, checkpoints, and node lifecycle events. Use to understand what has been done before deciding next steps, to detect repeated failures, and to inform recovery decisions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            tail: { type: 'number', description: 'Number of recent entries to return (default: 20).' },
            kind: { type: 'string', description: 'Filter by entry kind: task_dispatched, task_completed, task_failed, task_stalled, session_launched, checkpoint_created, node_cloned, node_removed.' },
        },
    },
};

export const MESH_REFINE_NODE_TOOL = {
    name: 'mesh_refine_node',
    description: 'The Refinery: Automatically validate and merge a completed worktree node back into its base branch. This tool automates the validation gate and merge queue step. It will merge the node\'s branch into its base branch and cleanly remove the worktree node and its sessions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the completed worktree node to refine and merge.' },
        },
        required: ['node_id'],
    },
};

export const ALL_MESH_TOOLS = [
    MESH_STATUS_TOOL,
    MESH_LIST_NODES_TOOL,
    MESH_ENQUEUE_TASK_TOOL,
    MESH_VIEW_QUEUE_TOOL,
    MESH_QUEUE_CANCEL_TOOL,
    MESH_QUEUE_REQUEUE_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_READ_DEBUG_TOOL,
    MESH_LAUNCH_SESSION_TOOL,
    MESH_GIT_STATUS_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_APPROVE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
    MESH_TASK_HISTORY_TOOL,
];

// ─── Tool Implementations ───────────────────────

export async function meshStatus(ctx: MeshContext): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const { mesh, transport } = ctx;
    const results: any[] = [];

    const ledgerSummary = getLedgerSummary(mesh.id);

    for (const node of mesh.nodes) {
        const entry: any = {
            nodeId: node.id,
            workspace: node.workspace,
            ...getNodeLaunchReadiness(node),
        };

        try {
            if (!isLocalTransport(transport) && node.daemonId) {
                const result = await (transport as CloudTransport).gitStatus(node.daemonId, node.workspace, false);
                const status = extractGitStatus(result);
                const uncommittedChanges = countUncommittedChanges(status);
                const dirty = isGitStatusDirty(status);
                entry.health = status?.isGitRepo ? (dirty ? 'dirty' : 'online') : 'degraded';
                entry.branch = status?.branch;
                entry.isDirty = dirty;
                entry.uncommittedChanges = uncommittedChanges;
            } else if (isLocalTransport(transport)) {
                const statusResult = await commandForNode(ctx, node, 'git_status', { workspace: node.workspace });
                const status = extractGitStatus(statusResult);
                const uncommittedChanges = countUncommittedChanges(status);
                const dirty = isGitStatusDirty(status);
                entry.health = status?.isGitRepo ? (dirty ? 'dirty' : 'online') : 'degraded';
                entry.branch = status?.branch;
                entry.isDirty = dirty;
                entry.uncommittedChanges = uncommittedChanges;
            } else {
                entry.health = 'unknown';
                entry.note = 'No daemonId available for cloud status probe';
            }
        } catch (e: any) {
            entry.health = 'degraded';
            entry.error = e.message;
        }

        // Recovery Hints & Next-step reporting
        const recoveryContext = getSessionRecoveryContext(mesh.id, { nodeId: node.id });
        if (recoveryContext.consecutiveNodeFailures > 0) {
            entry.recoveryHints = {
                consecutiveFailures: recoveryContext.consecutiveNodeFailures,
                lastTaskMessage: recoveryContext.lastTaskMessage,
                advice: recoveryContext.advice,
                retryRecommended: recoveryContext.retryRecommended,
            };
        }

        const activeLaunchFailure = getLatestActiveLaunchFailure(mesh.id, node.id);
        if (activeLaunchFailure && node.isLocalWorktree) {
            entry.health = 'degraded';
            entry.degradedReason = 'worktree_launch_failed';
            entry.launchReady = false;
            entry.launchBlockedReason = activeLaunchFailure.code || 'mesh_launch_failed';
            entry.launchBlockedMessage = activeLaunchFailure.error || 'Previous worktree session launch failed';
            entry.lastLaunchFailure = activeLaunchFailure;
        }

        const nextStepHints: string[] = [];
        if (entry.degradedReason === 'worktree_launch_failed') {
            nextStepHints.push(`Retry mesh_launch_session(node_id: "${node.id}") after daemon mesh transport/P2P is healthy.`);
            nextStepHints.push(`If retry is not desired, cleanup the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`);
        } else if (entry.health === 'online' && node.isLocalWorktree) {
            nextStepHints.push(`Merge worktree to base via mesh_refine_node(node_id: "${node.id}")`);
        } else if (entry.health === 'dirty') {
            nextStepHints.push(`Commit changes via mesh_checkpoint(node_id: "${node.id}", message: "...")`);
        } else if (entry.health === 'degraded' && entry.error?.includes('git')) {
            nextStepHints.push('Initialize git repository or check workspace path.');
        }

        if (recoveryContext.consecutiveNodeFailures > 0) {
            if (recoveryContext.retryRecommended) {
                nextStepHints.push(`Retry task on this node or launch a fresh session.`);
            } else {
                nextStepHints.push(`Consider reassigning work to a different node.`);
            }
        }

        if (nextStepHints.length > 0) {
            entry.nextStepHints = nextStepHints;
        }

        const relatedRepos = await collectRelatedRepoStatuses(ctx, node);
        if (relatedRepos.length) entry.relatedRepos = relatedRepos;

        results.push(entry);
    }

    const response: Record<string, unknown> = {
        meshId: mesh.id,
        meshName: mesh.name,
        repoIdentity: mesh.repoIdentity,
        policy: mesh.policy,
        refreshedAt: new Date().toISOString(),
        nodes: results,
    };

    // Include task ledger summary for coordinator context
    try {
        response.ledgerSummary = ledgerSummary;
    } catch { /* ledger read is best-effort */ }

    // Drain MCP-coordinator pending events queued by the daemon (same-machine case).
    if (ctx.transport instanceof IpcTransport) {
        try {
            const eventsResult = await (ctx.transport as IpcTransport).command('get_pending_mesh_events', {}) as any;
            const pendingEvents = Array.isArray(eventsResult?.events) ? eventsResult.events : [];
            if (pendingEvents.length > 0) {
                response.pendingCoordinatorEvents = pendingEvents;
            }
        } catch {
            // Non-fatal: pending events are best-effort.
        }
    }

    return JSON.stringify(response, null, 2);
}

export async function meshTaskHistory(
    ctx: MeshContext,
    args: { tail?: number; kind?: string },
): Promise<string> {
    const { mesh } = ctx;
    const tail = typeof args.tail === 'number' && args.tail > 0 ? args.tail : 20;
    const kind = typeof args.kind === 'string' && args.kind.trim() ? [args.kind.trim() as any] : undefined;
    const entries = readLedgerEntries(mesh.id, { tail, kind });
    const summary = getLedgerSummary(mesh.id);
    return JSON.stringify({ meshId: mesh.id, entries, summary }, null, 2);
}

export async function meshListNodes(ctx: MeshContext): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const { mesh } = ctx;
    return JSON.stringify({
        meshId: mesh.id,
        meshName: mesh.name,
        nodes: mesh.nodes.map(n => ({
            nodeId: n.id,
            workspace: n.workspace,
            repoRoot: n.repoRoot,
            isLocalWorktree: n.isLocalWorktree,
            policy: n.policy,
            relatedRepos: readRelatedRepos(n),
            ...getNodeLaunchReadiness(n),
            userOverrides: n.userOverrides,
        })),
    }, null, 2);
}

export async function meshEnqueueTask(
    ctx: MeshContext,
    args: { message: string },
): Promise<string> {
    try {
        const task = enqueueTask(ctx.mesh.id, args.message);

        // ── LocalTransport: queue-based pull (standalone daemon, all local) ─────
        if (isLocalTransport(ctx.transport) && !(ctx.transport instanceof IpcTransport)) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
            return JSON.stringify({ success: true, taskId: task.id, status: task.status });
        }

        // ── IpcTransport (Cloud Mesh): the queue file lives on THIS machine only.
        //    Remote daemons on other machines cannot read the local queue file.
        //    Strategy: trigger local queue for local nodes, and for remote nodes
        //    directly P2P-dispatch to the first idle session found (enqueue-and-push).
        if (ctx.transport instanceof IpcTransport) {
            // 1. Trigger local queue for local node pick-up
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});

            // 2. For each remote node, directly dispatch to an idle session via P2P
            const dispatchPromises: Promise<void>[] = [];
            for (const node of ctx.mesh.nodes) {
                const isLocalNode =
                    (ctx.localMachineId && (node as any).machineId === ctx.localMachineId) ||
                    (ctx.localDaemonId && node.daemonId === ctx.localDaemonId);
                if (isLocalNode || !node.daemonId) continue;

                dispatchPromises.push(
                    ipcDispatchToRemoteAgent(ctx, node, { message: args.message })
                        .then(result => {
                            if (result.success) {
                                try {
                                    appendLedgerEntry(ctx.mesh.id, {
                                        kind: 'task_dispatched',
                                        nodeId: node.id,
                                        sessionId: result.sessionId,
                                        payload: { message: args.message, via: 'p2p_direct', taskId: task.id },
                                    });
                                } catch { /* best-effort */ }
                            }
                        })
                        .catch(() => { /* non-fatal: no idle session or P2P failure */ }),
                );
            }
            // Fire-and-forget — don't block the coordinator response
            Promise.all(dispatchPromises).catch(() => {});

            return JSON.stringify({ success: true, taskId: task.id, status: task.status });
        }

        // ── CloudTransport fallback ───────────────────────────────────────────────
        return JSON.stringify({ success: true, taskId: task.id, status: task.status });
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshViewQueue(
    ctx: MeshContext,
    args: { status?: string[] },
): Promise<string> {
    try {
        const queue = annotateQueueStaleness(getQueue(ctx.mesh.id, { status: args.status as any }));
        const staleAssignedTasks = queue.filter((task: any) => task?.status === 'assigned' && task?.staleAssigned);
        return JSON.stringify({
            success: true,
            queue,
            staleAssignedTasks,
            staleAssignedCount: staleAssignedTasks.length,
            // Back-compat alias for callers already reading the first hardening payload.
            staleAssignments: staleAssignedTasks,
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueCancel(
    ctx: MeshContext,
    args: { task_id?: string; taskId?: string; reason?: string },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });
        const task = cancelTask(ctx.mesh.id, taskId, { reason: args.reason });
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        return JSON.stringify({ success: true, task }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueRequeue(
    ctx: MeshContext,
    args: {
        task_id?: string;
        taskId?: string;
        reason?: string;
        target_node_id?: string;
        targetNodeId?: string;
        target_session_id?: string;
        targetSessionId?: string;
        clear_target_node?: boolean;
        clearTargetNode?: boolean;
        keep_target_session?: boolean;
        keepTargetSession?: boolean;
    },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });
        const targetNodeId = (args.target_node_id || args.targetNodeId || '').trim() || undefined;
        const targetSessionId = (args.target_session_id || args.targetSessionId || '').trim() || undefined;
        const keepTargetSession = args.keep_target_session === true || args.keepTargetSession === true;
        const task = requeueTask(ctx.mesh.id, taskId, {
            reason: args.reason,
            targetNodeId,
            targetSessionId,
            clearTargetNode: args.clear_target_node === true || args.clearTargetNode === true,
            clearTargetSession: targetSessionId ? false : !keepTargetSession,
        });
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        if (isLocalTransport(ctx.transport)) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        }
        return JSON.stringify({ success: true, task }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshSendTask(
    ctx: MeshContext,
    args: { node_id: string; session_id?: string; message: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Policy check: read-only node cannot receive tasks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
    }

    // Avoid duplicate side effects when an MCP/tool call is interrupted after
    // the daemon already accepted the send and the coordinator retries the
    // exact same node/session/message immediately.
    const duplicate = hasRecentDuplicateDispatch(ctx, args);
    if (duplicate.duplicate) {
        return JSON.stringify({
            success: true,
            duplicate: true,
            dispatched: false,
            warning: 'Duplicate mesh_send_task suppressed: the same node/session/message was dispatched recently.',
            nodeId: args.node_id,
            sessionId: args.session_id,
            source: duplicate.source,
            previousDispatch: duplicate.entry ? {
                id: duplicate.entry.id,
                timestamp: duplicate.entry.timestamp || duplicate.entry.updatedAt || duplicate.entry.createdAt,
                nodeId: duplicate.entry.nodeId || duplicate.entry.targetNodeId || duplicate.entry.assignedNodeId,
                sessionId: duplicate.entry.sessionId || duplicate.entry.targetSessionId || duplicate.entry.assignedSessionId,
            } : undefined,
        });
    }

    try {
        // ── CloudTransport: delegate to Cloud API ──────────────────────────────
        if (!isLocalTransport(ctx.transport) && node.daemonId) {
            const res = await (ctx.transport as CloudTransport).meshEnqueueTask(node.daemonId, {
                meshId: ctx.mesh.id,
                message: args.message,
                targetNodeId: args.node_id,
            });
            return JSON.stringify(res);
        }

        // ── IpcTransport + remote node: direct P2P agent_command dispatch ──────
        //
        // The local queue file (mesh-ledger/*.queue.json) is stored on THIS
        // machine and is inaccessible to the remote daemon.  Sending
        // trigger_mesh_queue to the remote daemon would always be a no-op
        // because it cannot read the queue.  Instead we relay agent_command
        // directly over P2P so the remote daemon forwards it to its agent.
        const isLocalNode =
            (ctx.localMachineId && (node as any).machineId === ctx.localMachineId) ||
            (ctx.localDaemonId && node.daemonId === ctx.localDaemonId);

        if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
            const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id || ''));
            const result = await ipcDispatchToRemoteAgent(ctx, node, {
                session_id: args.session_id,
                message: args.message,
                providerType: cached?.providerType,
            });
            if (result.success) {
                // Record dispatch in ledger so task_history is accurate
                const dispatchedSessionId = args.session_id || result.sessionId;
                try {
                    appendLedgerEntry(ctx.mesh.id, {
                        kind: 'task_dispatched',
                        nodeId: args.node_id,
                        sessionId: dispatchedSessionId,
                        payload: {
                            message: args.message,
                            via: 'p2p_direct',
                            ...(dispatchedSessionId ? { targetSessionId: dispatchedSessionId } : {}),
                        },
                    });
                } catch { /* best-effort */ }
            }
            return JSON.stringify({ ...result, nodeId: args.node_id, dispatched: result.success === true });
        }

        // ── LocalTransport or local IpcTransport node ────────────────────────
        // If the coordinator explicitly targets a runtime session, push directly
        // and surface route failures immediately instead of creating a queue item
        // that can remain pending forever when the session was already stopped.
        if (args.session_id && isLocalTransport(ctx.transport)) {
            const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
            const dispatchResult = await commandForNode(ctx, node, 'agent_command', {
                targetSessionId: args.session_id,
                ...(cached?.providerType ? { agentType: cached.providerType, cliType: cached.providerType, providerType: cached.providerType } : {}),
                action: 'send_chat',
                message: args.message,
            });
            const dispatchPayload = unwrapCommandPayload(dispatchResult);
            if (dispatchPayload?.success === false || dispatchResult?.success === false) {
                return JSON.stringify({
                    success: false,
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    error: dispatchPayload?.error || dispatchResult?.error || 'agent_command rejected the task',
                });
            }
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'task_dispatched',
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    providerType: cached?.providerType,
                    payload: { message: args.message, via: 'local_direct' },
                });
            } catch { /* best-effort */ }
            return JSON.stringify({ success: true, dispatched: true, nodeId: args.node_id, sessionId: args.session_id });
        }

        // ── Untargeted local task: use queue pull ─────────────────────────────
        const task = enqueueTask(ctx.mesh.id, args.message, {
            targetNodeId: args.node_id,
            targetSessionId: args.session_id,
        });

        if (isLocalTransport(ctx.transport) || ctx.transport instanceof IpcTransport) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        }

        return JSON.stringify({ success: true, nodeId: args.node_id, taskId: task.id, status: task.status });
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshReadChat(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean },
): Promise<string> {
    const node = await findOptionalNodeWithRefresh(ctx, args.node_id);
    if (!node) {
        return JSON.stringify(buildMissingNodeReadChatRecovery(ctx, args), null, 2);
    }

    if (isLocalTransport(ctx.transport)) {
        const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
        const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
            ? args.provider_session_id.trim()
            : cached?.providerSessionId;
        const result = await commandForNode(ctx, node, 'read_chat', {
            sessionId: args.session_id,
            targetSessionId: args.session_id,
            workspace: node.workspace,
            ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
            ...(providerSessionId ? { providerSessionId } : {}),
            tailLimit: args.tail ?? 10,
        });
        const payload = annotateRapidReadChatAdvisory(unwrapCommandPayload(result) as Record<string, any>, {
            key: `mesh:${args.node_id}:${args.session_id}`,
            toolName: 'mesh_read_chat',
            completionCallbackExpected: true,
        });
        if (args.compact) {
            const compactPayload = compactChatPayload(payload, {
                nodeId: args.node_id,
                sessionId: args.session_id,
                limit: args.tail ?? 10,
            });
            return JSON.stringify(
                payload.pollingAdvisory ? { ...compactPayload, pollingAdvisory: payload.pollingAdvisory } : compactPayload,
                null,
                2,
            );
        }
        return JSON.stringify(payload, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const targetId = `${node.daemonId}:session:${args.session_id}`;
            const res = await (ctx.transport as CloudTransport).readChat(targetId, {
                limit: args.tail ?? 10,
                sessionId: args.session_id,
            });
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh read_chat requires node daemonId' });
    }
}

export async function meshReadDebug(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; delivery?: 'daemon_file' | 'inline' },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
        const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
            ? args.provider_session_id.trim()
            : cached?.providerSessionId;
        const delivery = args.delivery === 'inline' ? undefined : 'daemon_file';
        const result = await commandForNode(ctx, node, 'get_chat_debug_bundle', {
            sessionId: args.session_id,
            targetSessionId: args.session_id,
            workspace: node.workspace,
            ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
            ...(providerSessionId ? { providerSessionId } : {}),
            tailLimit: args.tail ?? 40,
            ...(delivery ? { delivery } : {}),
        });
        const payload = unwrapCommandPayload(result);
        return JSON.stringify(payload, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const targetId = `${node.daemonId}:session:${args.session_id}`;
            const res = await (ctx.transport as CloudTransport).getChatDebugBundle(targetId, {
                sessionId: args.session_id,
                tailLimit: args.tail ?? 40,
                delivery: args.delivery,
            });
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    }

    return JSON.stringify({ error: 'Cloud mesh read_debug requires node daemonId' });
}

export async function meshLaunchSession(
    ctx: MeshContext,
    args: { node_id: string; type?: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        let resolvedProviderType = typeof args.type === 'string' && args.type.trim() ? args.type : '';
        if (!resolvedProviderType) {
            const providerPriority = readProviderPriority(node.policy);
            if (!providerPriority.length) {
                return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
            }

            const failed: string[] = [];
            for (const providerType of providerPriority) {
                const detectedResult = await commandForNode(ctx, node, 'detect_provider', { providerType });
                const detectedPayload = unwrapCommandPayload(detectedResult);
                if (detectedPayload?.success && detectedPayload?.detected) {
                    resolvedProviderType = providerType;
                    break;
                }
                failed.push(`${providerType}: ${detectedPayload?.error || 'not detected'}`);
            }
            if (!resolvedProviderType) {
                return JSON.stringify({ success: false, error: `No usable provider detected for node '${args.node_id}' from providerPriority: ${failed.join('; ')}` });
            }
        }

        const coordinatorNode = resolveCoordinatorNode(ctx);
        const coordinatorDaemonId = coordinatorNode?.daemonId || ctx.localDaemonId;
        const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
        let result: any;
        try {
            result = await commandForNode(ctx, node, 'launch_cli', {
                cliType: resolvedProviderType,
                dir: node.workspace,
                settings: {
                    meshNodeFor: ctx.mesh.id,
                    meshNodeId: args.node_id,
                    spawnedSessionVisibility,
                    ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
                    ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                    launchedByCoordinator: true
                }
            });
        } catch (e: any) {
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
        }
        const launchPayload = extractLaunchPayload(result);
        if (launchPayload?.success === false || result?.success === false) {
            const launchError = new Error(launchPayload?.error || result?.error || 'launch_cli rejected the session launch');
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, launchError), null, 2);
        }
        const runtimeSessionId = typeof launchPayload?.sessionId === 'string'
            ? launchPayload.sessionId
            : typeof launchPayload?.id === 'string'
                ? launchPayload.id
                : typeof launchPayload?.runtimeSessionId === 'string'
                    ? launchPayload.runtimeSessionId
                    : '';
        const providerSessionId = typeof launchPayload?.providerSessionId === 'string' && launchPayload.providerSessionId.trim()
            ? launchPayload.providerSessionId.trim()
            : undefined;
        if (runtimeSessionId) {
            meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, runtimeSessionId), {
                providerType: resolvedProviderType,
                ...(providerSessionId ? { providerSessionId } : {}),
            });
        }
        // Record session launch in ledger
        try {
            appendLedgerEntry(ctx.mesh.id, {
                kind: 'session_launched',
                nodeId: args.node_id,
                sessionId: runtimeSessionId || undefined,
                providerType: resolvedProviderType,
                payload: { providerSessionId },
            });
        } catch { /* ledger append is best-effort */ }

        // Tell daemon to trigger queue processing so the new session immediately picks up pending tasks
        const isLocalNode =
            (ctx.localMachineId && (node as any).machineId === ctx.localMachineId) ||
            (ctx.localDaemonId && node.daemonId === ctx.localDaemonId);

        if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
            ctx.transport.meshCommand(node.daemonId, 'trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        } else if (isLocalTransport(ctx.transport)) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        }

        return JSON.stringify({
            ...launchPayload,
            resolvedProviderType,
            ...(providerSessionId ? { providerSessionId } : {}),
        }, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        let resolvedProviderType = typeof args.type === 'string' && args.type.trim() ? args.type : '';
        if (!resolvedProviderType) {
            const providerPriority = readProviderPriority(node.policy);
            if (!providerPriority.length) {
                return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
            }
            resolvedProviderType = providerPriority[0]; // Best effort for cloud, skip detection
        }

        const coordinatorNode = resolveCoordinatorNode(ctx);
        const coordinatorDaemonId = coordinatorNode?.daemonId || ctx.localDaemonId;
        const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);

        try {
            const res = await (ctx.transport as CloudTransport).launch(node.daemonId, {
                type: resolvedProviderType,
                dir: node.workspace,
                settings: {
                    meshNodeFor: ctx.mesh.id,
                    meshNodeId: args.node_id,
                    spawnedSessionVisibility,
                    ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
                    ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                    launchedByCoordinator: true
                }
            });

            const runtimeSessionId = typeof res?.sessionId === 'string' ? res.sessionId : typeof res?.id === 'string' ? res.id : '';
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'session_launched',
                    nodeId: args.node_id,
                    sessionId: runtimeSessionId || undefined,
                    providerType: resolvedProviderType,
                    payload: {},
                });
            } catch { /* best-effort */ }

            return JSON.stringify({ ...res, resolvedProviderType }, null, 2);
        } catch (e: any) {
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh launch_session requires node daemonId' });
    }
}

export async function meshGitStatus(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (!isLocalTransport(ctx.transport) && node.daemonId) {
        const result = await (ctx.transport as CloudTransport).gitStatus(node.daemonId, node.workspace, true);
        return JSON.stringify({
            nodeId: args.node_id,
            workspace: node.workspace,
            status: extractGitStatus(result),
            diff: extractGitDiff(result),
            relatedRepos: await collectRelatedRepoStatuses(ctx, node),
        }, null, 2);
    } else if (isLocalTransport(ctx.transport)) {
        const statusResult = await commandForNode(ctx, node, 'git_status', {
            workspace: node.workspace,
        });
        const diffResult = await commandForNode(ctx, node, 'git_diff_summary', {
            workspace: node.workspace,
        });
        return JSON.stringify({
            nodeId: args.node_id,
            workspace: node.workspace,
            status: extractGitStatus(statusResult),
            diff: extractGitDiff(diffResult),
            relatedRepos: await collectRelatedRepoStatuses(ctx, node),
        }, null, 2);
    } else {
        return JSON.stringify({ error: 'No daemonId available for cloud git_status probe' });
    }
}

export async function meshCheckpoint(
    ctx: MeshContext,
    args: { node_id: string; message: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Policy checks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only — cannot checkpoint` });
    }

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, node, 'git_checkpoint', {
            workspace: node.workspace,
            message: args.message,
            includeUntracked: true,
        });

        // Record checkpoint in ledger
        try {
            appendLedgerEntry(ctx.mesh.id, {
                kind: 'checkpoint_created',
                nodeId: args.node_id,
                payload: { message: args.message, commit: (result as any)?.checkpoint?.commit },
            });
        } catch { /* ledger append is best-effort */ }

        return JSON.stringify(result, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).gitCheckpoint(node.daemonId, {
                workspace: node.workspace,
                message: args.message,
                includeUntracked: true,
            });
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'checkpoint_created',
                    nodeId: args.node_id,
                    payload: { message: args.message, commit: (res as any)?.checkpoint?.commit },
                });
            } catch { /* best-effort */ }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh checkpoint requires node daemonId' });
    }
}

export async function meshApprove(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; action: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id); // membership check

    if (isLocalTransport(ctx.transport)) {
        const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
        const providerSessionId = cached?.providerSessionId;
        const result = await commandForNode(ctx, node, 'resolve_action', {
            sessionId: args.session_id,
            targetSessionId: args.session_id,
            workspace: node.workspace,
            ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
            ...(providerSessionId ? { providerSessionId } : {}),
            action: args.action === 'reject' ? 'reject' : 'approve',
        });
        return JSON.stringify(result, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const targetId = `${node.daemonId}:session:${args.session_id}`;
            const res = await (ctx.transport as CloudTransport).approve(targetId, args.action === 'reject' ? 'reject' : 'approve');
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh approve requires node daemonId' });
    }
}

export async function meshCloneNode(
    ctx: MeshContext,
    args: { source_node_id: string; branch: string; base_branch?: string },
): Promise<string> {
    const sourceNode = await findNodeWithRefresh(ctx, args.source_node_id);

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, sourceNode, 'clone_mesh_node', {
            meshId: ctx.mesh.id,
            sourceNodeId: args.source_node_id,
            branch: args.branch,
            baseBranch: args.base_branch,
            inlineMesh: ctx.mesh,
        });
        const clonePayload = extractCloneNodePayload(result);
        if (clonePayload?.success && clonePayload.node?.id) {
            const existingIndex = ctx.mesh.nodes.findIndex(n => n.id === clonePayload.node.id);
            if (existingIndex >= 0) ctx.mesh.nodes[existingIndex] = clonePayload.node;
            else ctx.mesh.nodes.push(clonePayload.node);
            ctx.mesh.updatedAt = new Date().toISOString();
        }
        return JSON.stringify(result, null, 2);
    } else if (!isLocalTransport(ctx.transport) && sourceNode.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshCloneNode(sourceNode.daemonId, {
                meshId: ctx.mesh.id,
                sourceNodeId: args.source_node_id,
                branch: args.branch,
                baseBranch: args.base_branch,
                inlineMesh: ctx.mesh,
            });
            const clonePayload = extractCloneNodePayload(res);
            if (clonePayload?.success && clonePayload.node?.id) {
                const existingIndex = ctx.mesh.nodes.findIndex(n => n.id === clonePayload.node.id);
                if (existingIndex >= 0) ctx.mesh.nodes[existingIndex] = clonePayload.node;
                else ctx.mesh.nodes.push(clonePayload.node);
                ctx.mesh.updatedAt = new Date().toISOString();
            }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh clone_node requires source node daemonId' });
    }
}

export async function meshCleanupSessions(
    ctx: MeshContext,
    args: { node_id: string; mode: string; session_ids?: string[]; dry_run?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, node, 'cleanup_mesh_sessions', {
            meshId: ctx.mesh.id,
            nodeId: args.node_id,
            mode: args.mode,
            sessionIds: args.session_ids,
            dryRun: args.dry_run === true,
            inlineMesh: ctx.mesh,
        });
        return JSON.stringify(result, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshCleanupSessions(node.daemonId, {
                meshId: ctx.mesh.id,
                nodeId: args.node_id,
                mode: args.mode,
                sessionIds: args.session_ids,
                dryRun: args.dry_run === true,
                inlineMesh: ctx.mesh,
            });
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh cleanup_sessions requires node daemonId' });
    }
}

export async function meshRemoveNode(
    ctx: MeshContext,
    args: { node_id: string; session_cleanup_mode?: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, node, 'remove_mesh_node', {
            meshId: ctx.mesh.id,
            nodeId: args.node_id,
            ...(args.session_cleanup_mode ? { sessionCleanupMode: args.session_cleanup_mode } : {}),
            inlineMesh: ctx.mesh,
        });
        if (result?.success && result.removed !== false) {
            const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
            if (idx >= 0) {
                ctx.mesh.nodes.splice(idx, 1);
                ctx.mesh.updatedAt = new Date().toISOString();
            }
        }
        return JSON.stringify(result, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshRemoveNode(node.daemonId, {
                meshId: ctx.mesh.id,
                nodeId: args.node_id,
                ...(args.session_cleanup_mode ? { sessionCleanupMode: args.session_cleanup_mode } : {}),
                inlineMesh: ctx.mesh,
            });
            if (res?.success && res.removed !== false) {
                const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
                if (idx >= 0) {
                    ctx.mesh.nodes.splice(idx, 1);
                    ctx.mesh.updatedAt = new Date().toISOString();
                }
            }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh remove_node requires node daemonId' });
    }
}

export async function meshRefineNode(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, node, 'refine_mesh_node', {
            meshId: ctx.mesh.id,
            nodeId: args.node_id,
            inlineMesh: ctx.mesh,
        });
        if (result?.success && result.removeResult?.removed !== false) {
            const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
            if (idx >= 0) {
                ctx.mesh.nodes.splice(idx, 1);
                ctx.mesh.updatedAt = new Date().toISOString();
            }
        }
        return JSON.stringify(result, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshRefineNode(node.daemonId, {
                meshId: ctx.mesh.id,
                nodeId: args.node_id,
                inlineMesh: ctx.mesh,
            });
            if (res?.success && res.removeResult?.removed !== false) {
                const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
                if (idx >= 0) {
                    ctx.mesh.nodes.splice(idx, 1);
                    ctx.mesh.updatedAt = new Date().toISOString();
                }
            }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh refine_node requires node daemonId' });
    }
}
