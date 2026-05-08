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
import type { LocalMeshEntry, LocalMeshNodeEntry, RepoMeshPolicy, RepoMeshRelatedRepo } from '@adhdev/daemon-core';

export interface MeshContext {
    mesh: LocalMeshEntry;
    transport: McpTransport;
    /** Daemon ID for this local machine (local mode) */
    localDaemonId?: string;
}

type MeshSessionProviderMetadata = {
    providerType: string;
    providerSessionId?: string;
};

const meshSessionProviderMetadata = new Map<string, MeshSessionProviderMetadata>();

// ─── Helpers ────────────────────────────────────

function findNode(mesh: LocalMeshEntry, nodeId: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`Node '${nodeId}' is not a member of mesh '${mesh.name}'`);
    return node;
}

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

function resolveCoordinatorNode(ctx: MeshContext): LocalMeshNodeEntry | undefined {
    const preferredNodeId = typeof ctx.mesh.coordinator?.preferredNodeId === 'string'
        ? ctx.mesh.coordinator.preferredNodeId.trim()
        : '';
    if (preferredNodeId) {
        const preferred = ctx.mesh.nodes.find(n => n.id === preferredNodeId && typeof n.daemonId === 'string' && n.daemonId.trim());
        if (preferred) return preferred;
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
    if (ctx.transport instanceof IpcTransport && node.daemonId && node.daemonId !== ctx.localDaemonId) {
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
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions. Use this to decide which node to send work to.',
    inputSchema: {
        type: 'object' as const,
        properties: {},
    },
};

export const MESH_LIST_NODES_TOOL = {
    name: 'mesh_list_nodes',
    description: 'List all nodes in the mesh with their capabilities, platform, and workspace paths.',
    inputSchema: {
        type: 'object' as const,
        properties: {},
    },
};

export const MESH_SEND_TASK_TOOL = {
    name: 'mesh_send_task',
    description: 'Send a natural-language task to an agent session on a mesh node. The agent will execute the task autonomously.',
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

export const ALL_MESH_TOOLS = [
    MESH_STATUS_TOOL,
    MESH_LIST_NODES_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_READ_DEBUG_TOOL,
    MESH_LAUNCH_SESSION_TOOL,
    MESH_GIT_STATUS_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_APPROVE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
];

// ─── Tool Implementations ───────────────────────

export async function meshStatus(ctx: MeshContext): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const { mesh, transport } = ctx;
    const results: any[] = [];

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

        const relatedRepos = await collectRelatedRepoStatuses(ctx, node);
        if (relatedRepos.length) entry.relatedRepos = relatedRepos;

        results.push(entry);
    }

    return JSON.stringify({
        meshId: mesh.id,
        meshName: mesh.name,
        repoIdentity: mesh.repoIdentity,
        policy: mesh.policy,
        refreshedAt: new Date().toISOString(),
        nodes: results,
    }, null, 2);
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

export async function meshSendTask(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; message: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Policy check: read-only node cannot receive tasks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
    }

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, node, 'send_chat', {
            message: args.message,
            sessionId: args.session_id,
            targetSessionId: args.session_id,
        });
        const payload = unwrapCommandPayload(result);
        if (payload?.success === false) {
            return JSON.stringify({
                success: false,
                nodeId: args.node_id,
                sessionId: args.session_id,
                error: payload.error || 'send_chat failed',
            });
        }
        return JSON.stringify({ success: true, nodeId: args.node_id, sessionId: args.session_id });
    } else {
        return JSON.stringify({ error: 'Cloud mesh send_task not yet implemented' });
    }
}

export async function meshReadChat(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id); // membership check

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
        const payload = unwrapCommandPayload(result);
        if (args.compact) {
            return JSON.stringify(compactChatPayload(payload, {
                nodeId: args.node_id,
                sessionId: args.session_id,
                limit: args.tail ?? 10,
            }), null, 2);
        }
        return JSON.stringify(payload, null, 2);
    } else {
        return JSON.stringify({ error: 'Cloud mesh read_chat not yet implemented' });
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
    }

    return JSON.stringify({ error: 'Cloud mesh read_debug not yet implemented' });
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
        const result = await commandForNode(ctx, node, 'launch_cli', {
            cliType: resolvedProviderType,
            dir: node.workspace,
            settings: {
                meshNodeFor: ctx.mesh.id,
                meshNodeId: args.node_id,
                ...(coordinatorNode?.daemonId ? { meshCoordinatorDaemonId: coordinatorNode.daemonId } : {}),
                ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                launchedByCoordinator: true
            }
        });
        const launchPayload = extractLaunchPayload(result);
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
        return JSON.stringify({
            ...launchPayload,
            resolvedProviderType,
            ...(providerSessionId ? { providerSessionId } : {}),
        }, null, 2);
    } else {
        return JSON.stringify({ error: 'Cloud mesh launch_session not yet implemented' });
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
        return JSON.stringify(result, null, 2);
    } else {
        return JSON.stringify({ error: 'Cloud mesh checkpoint not yet implemented' });
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
    } else {
        return JSON.stringify({ error: 'Cloud mesh approve not yet implemented' });
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
    } else {
        return JSON.stringify({ error: 'Cloud mesh clone_node not yet implemented' });
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
    } else {
        return JSON.stringify({ error: 'Cloud mesh cleanup_sessions not yet implemented' });
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
    } else {
        return JSON.stringify({ error: 'Cloud mesh remove_node not yet implemented' });
    }
}
