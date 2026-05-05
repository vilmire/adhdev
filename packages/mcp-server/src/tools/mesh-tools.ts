/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * 8 tools: mesh_status, mesh_list_nodes, mesh_send_task, mesh_read_chat,
 *          mesh_launch_session, mesh_git_status, mesh_checkpoint, mesh_approve
 */

import type { LocalTransport } from '../transports/local.js';
import { CloudTransport } from '../transports/cloud.js';
import { isLocalTransport } from '../transports/mode.js';
import type { LocalMeshEntry, LocalMeshNodeEntry, RepoMeshPolicy } from '@adhdev/daemon-core';

export interface MeshContext {
    mesh: LocalMeshEntry;
    transport: LocalTransport | CloudTransport;
    /** Daemon ID for this local machine (local mode) */
    localDaemonId?: string;
}

// ─── Helpers ────────────────────────────────────

function findNode(mesh: LocalMeshEntry, nodeId: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`Node '${nodeId}' is not a member of mesh '${mesh.name}'`);
    return node;
}

function findNodeByWorkspace(mesh: LocalMeshEntry, workspace: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.workspace === workspace);
    if (!node) throw new Error(`Workspace '${workspace}' is not a member of mesh '${mesh.name}'`);
    return node;
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
    description: 'Read recent chat messages from a delegated agent session on a mesh node. Use this to check progress.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to read from.' },
            tail: { type: 'number', description: 'Number of recent messages to return (default: 10).' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_LAUNCH_SESSION_TOOL = {
    name: 'mesh_launch_session',
    description: 'Launch a new agent session on a mesh node. Returns the session ID for subsequent send_task/read_chat calls.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            type: { type: 'string', description: 'Provider type (e.g. "claude-cli", "gemini-cli", "cursor").' },
        },
        required: ['node_id', 'type'],
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

export const ALL_MESH_TOOLS = [
    MESH_STATUS_TOOL,
    MESH_LIST_NODES_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_LAUNCH_SESSION_TOOL,
    MESH_GIT_STATUS_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_APPROVE_TOOL,
];

// ─── Tool Implementations ───────────────────────

export async function meshStatus(ctx: MeshContext): Promise<string> {
    const { mesh, transport } = ctx;
    const results: any[] = [];

    for (const node of mesh.nodes) {
        const entry: any = {
            nodeId: node.id,
            workspace: node.workspace,
        };

        try {
            if (!isLocalTransport(transport) && node.daemonId) {
                const result = await (transport as CloudTransport).gitStatus(node.daemonId, node.workspace, false);
                const status = result?.status ?? result;
                entry.health = status?.isGitRepo ? (status?.isDirty ? 'dirty' : 'online') : 'degraded';
                entry.branch = status?.branch;
                entry.isDirty = status?.isDirty;
                entry.uncommittedChanges = status?.uncommittedChanges ?? 0;
            } else if (isLocalTransport(transport)) {
                const statusResult = await transport.command('git_status', { workspace: node.workspace });
                const status = statusResult?.status ?? statusResult;
                entry.health = status?.isGitRepo ? (status?.isDirty ? 'dirty' : 'online') : 'degraded';
                entry.branch = status?.branch;
                entry.isDirty = status?.isDirty;
                entry.uncommittedChanges = status?.uncommittedChanges ?? 0;
            } else {
                entry.health = 'unknown';
                entry.note = 'No daemonId available for cloud status probe';
            }
        } catch (e: any) {
            entry.health = 'degraded';
            entry.error = e.message;
        }

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
            userOverrides: n.userOverrides,
        })),
    }, null, 2);
}

export async function meshSendTask(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; message: string },
): Promise<string> {
    const node = findNode(ctx.mesh, args.node_id);

    // Policy check: read-only node cannot receive tasks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
    }

    if (isLocalTransport(ctx.transport)) {
        await ctx.transport.command('send_chat', {
            message: args.message,
            sessionId: args.session_id,
        });
        return JSON.stringify({ success: true, nodeId: args.node_id, sessionId: args.session_id });
    } else {
        return JSON.stringify({ error: 'Cloud mesh send_task not yet implemented' });
    }
}

export async function meshReadChat(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; tail?: number },
): Promise<string> {
    findNode(ctx.mesh, args.node_id); // membership check

    if (isLocalTransport(ctx.transport)) {
        const result = await ctx.transport.command('read_chat', {
            sessionId: args.session_id,
            tailLimit: args.tail ?? 10,
        });
        return JSON.stringify(result, null, 2);
    } else {
        return JSON.stringify({ error: 'Cloud mesh read_chat not yet implemented' });
    }
}

export async function meshLaunchSession(
    ctx: MeshContext,
    args: { node_id: string; type: string },
): Promise<string> {
    const node = findNode(ctx.mesh, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const result = await ctx.transport.command('launch_cli', {
            cliType: args.type,
            dir: node.workspace,
            settings: {
                meshNodeFor: ctx.mesh.id,
                launchedByCoordinator: true
            }
        });
        return JSON.stringify(result, null, 2);
    } else {
        return JSON.stringify({ error: 'Cloud mesh launch_session not yet implemented' });
    }
}

export async function meshGitStatus(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = findNode(ctx.mesh, args.node_id);

    if (!isLocalTransport(ctx.transport) && node.daemonId) {
        const result = await (ctx.transport as CloudTransport).gitStatus(node.daemonId, node.workspace, true);
        return JSON.stringify({
            nodeId: args.node_id,
            workspace: node.workspace,
            status: result?.status ?? result,
            diff: result?.diff ?? null,
        }, null, 2);
    } else if (isLocalTransport(ctx.transport)) {
        const statusResult = await ctx.transport.command('git_status', {
            workspace: node.workspace,
        });
        const diffResult = await ctx.transport.command('git_diff_summary', {
            workspace: node.workspace,
        });
        return JSON.stringify({
            nodeId: args.node_id,
            workspace: node.workspace,
            status: statusResult?.status ?? statusResult,
            diff: diffResult?.diffSummary ?? diffResult,
        }, null, 2);
    } else {
        return JSON.stringify({ error: 'No daemonId available for cloud git_status probe' });
    }
}

export async function meshCheckpoint(
    ctx: MeshContext,
    args: { node_id: string; message: string },
): Promise<string> {
    const node = findNode(ctx.mesh, args.node_id);

    // Policy checks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only — cannot checkpoint` });
    }

    if (isLocalTransport(ctx.transport)) {
        const result = await ctx.transport.command('git_checkpoint', {
            workspace: node.workspace,
            message: args.message,
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
    findNode(ctx.mesh, args.node_id); // membership check

    if (isLocalTransport(ctx.transport)) {
        const result = await ctx.transport.command('resolve_action', {
            sessionId: args.session_id,
            action: args.action === 'reject' ? 'reject' : 'approve',
        });
        return JSON.stringify(result, null, 2);
    } else {
        return JSON.stringify({ error: 'Cloud mesh approve not yet implemented' });
    }
}
