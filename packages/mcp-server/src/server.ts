/**
 * ADHDev MCP Server
 *
 * Exposes IDE agent sessions as MCP tools via stdio transport.
 * Three modes:
 *   local  — talks to standalone daemon at localhost:3847
 *   cloud  — talks to ADHDev cloud API with an API key
 *   ipc    — talks to cloud daemon local IPC at localhost:19222
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import os from 'node:os';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { LocalTransport } from './transports/local.js';
import { CloudTransport } from './transports/cloud.js';
import { IpcTransport } from './transports/ipc.js';
import type { McpTransport } from './transports/mode.js';

import { LIST_SESSIONS_TOOL, listSessions } from './tools/list-sessions.js';
import { LIST_DAEMONS_TOOL, listDaemons } from './tools/list-daemons.js';
import { READ_CHAT_TOOL, readChat } from './tools/read-chat.js';
import { READ_CHAT_DEBUG_TOOL, readChatDebug } from './tools/read-chat-debug.js';
import { SEND_CHAT_TOOL, sendChat } from './tools/send-chat.js';
import { APPROVE_TOOL, approve } from './tools/approve.js';
import { SCREENSHOT_TOOL, screenshot } from './tools/screenshot.js';
import { GIT_STATUS_TOOL, gitStatus } from './tools/git-status.js';
import { GIT_LOG_TOOL, gitLog } from './tools/git-log.js';
import { GIT_DIFF_TOOL, gitDiff } from './tools/git-diff.js';
import { GIT_CHECKPOINT_TOOL, gitCheckpoint } from './tools/git-checkpoint.js';
import { GIT_PUSH_TOOL, gitPush } from './tools/git-push.js';
import { LAUNCH_SESSION_TOOL, launchSession } from './tools/launch-session.js';
import { STOP_SESSION_TOOL, stopSession } from './tools/stop-session.js';
import { CHECK_PENDING_TOOL, checkPending } from './tools/check-pending.js';
import {
  ALL_MESH_TOOLS, meshStatus, meshListNodes, meshSendTask, meshReadChat,
  meshEnqueueTask, meshViewQueue, meshQueueCancel, meshQueueRequeue,
  meshReadDebug,
  meshLaunchSession, meshGitStatus, meshFastForwardNode, meshCheckpoint, meshApprove,
  meshCloneNode, meshRemoveNode, meshRefineNode,
  meshRefineConfigSchema, meshValidateRefineConfig, meshSuggestRefineConfig, meshRefinePlan,
  meshCleanupSessions, meshTaskHistory, meshReconcileLedger
} from './tools/mesh-tools.js';
import type { MeshContext } from './tools/mesh-tools.js';

export interface AdhdevMcpServerOptions {
  mode: 'local' | 'cloud' | 'ipc';
  // local options
  port?: number;
  password?: string;
  // cloud options
  apiKey?: string;
  baseUrl?: string;
  // mesh mode (optional — restricts tools to mesh-scoped set)
  meshId?: string;
}

export async function buildMeshModeCoordinatorPrompt(mesh: any): Promise<string> {
  try {
    const { buildCoordinatorSystemPrompt } = await import('@adhdev/daemon-core');
    return buildCoordinatorSystemPrompt({ mesh });
  } catch (e: any) {
    throw new Error(`Failed to build Repo Mesh coordinator prompt: ${e?.message ?? String(e)}`);
  }
}

export async function startMcpServer(opts: AdhdevMcpServerOptions): Promise<void> {
  const transport: McpTransport =
    opts.mode === 'cloud'
      ? new CloudTransport({ apiKey: opts.apiKey!, baseUrl: opts.baseUrl })
      : opts.mode === 'ipc'
        ? new IpcTransport({ port: opts.port })
        : new LocalTransport({ port: opts.port, password: opts.password });

  // Verify connectivity before registering tools
  const alive = await transport.ping();
  if (!alive) {
    const hint =
      opts.mode === 'local'
        ? `Make sure the standalone daemon is running (adhdev standalone or npx @adhdev/daemon-standalone).`
        : opts.mode === 'ipc'
          ? `Make sure the cloud daemon is running with local IPC enabled (adhdev daemon).`
          : `Check your API key and network connectivity.`;
    process.stderr.write(`[adhdev-mcp] Cannot reach ${opts.mode} daemon. ${hint}\n`);
    process.exit(1);
  }

  const isLocal = opts.mode === 'local';

  // ── Mesh Mode ─────────────────────────────────
  if (opts.meshId) {
    let mesh: any;

    // Priority 1: ADHDEV_INLINE_MESH env var (set by daemon in .mcp.json for cloud meshes)
    if (!mesh && process.env.ADHDEV_INLINE_MESH) {
      try {
        mesh = JSON.parse(process.env.ADHDEV_INLINE_MESH);
        process.stderr.write(`[adhdev-mcp] Loaded mesh config from ADHDEV_INLINE_MESH env\n`);
      } catch (e: any) {
        process.stderr.write(`[adhdev-mcp] Failed to parse ADHDEV_INLINE_MESH: ${e.message}\n`);
      }
    }

    // Priority 2: Cloud API (when running with --api-key)
    if (!mesh && opts.mode === 'cloud' && opts.apiKey) {
      try {
        const base = opts.baseUrl || 'https://api.adhf.dev';
        const res = await fetch(`${base}/api/v1/repo-meshes/${opts.meshId}`, {
          headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const data = await res.json() as any;
          const rm = data.mesh;
          const nodes = data.nodes || [];
          // Convert cloud D1 record → LocalMeshEntry shape for mesh tools
          let policy: any = {};
          try { policy = JSON.parse(rm.policy_json || rm.policy || '{}'); } catch { /* */ }
          let coordinator: any = {};
          try { coordinator = JSON.parse(rm.coordinator_json || rm.coordinator_config || '{}'); } catch { /* */ }
          mesh = {
            id: rm.id,
            name: rm.name,
            repoIdentity: rm.repo_identity,
            repoRemoteUrl: rm.repo_remote_url,
            defaultBranch: rm.default_branch,
            policy: {
              requirePreTaskCheckpoint: false,
              requirePostTaskCheckpoint: true,
              requireApprovalForPush: true,
              allowAutoPublishSubmoduleMainCommits: false,
              requireApprovalForDestructiveGit: true,
              dirtyWorkspaceBehavior: 'warn',
              maxParallelTasks: 2,
              spawnedSessionVisibility: 'visible',
              ...policy,
            },
            coordinator,
            nodes: nodes.map((n: any) => ({
              id: n.id,
              workspace: n.workspace,
              repoRoot: n.repo_root,
              daemonId: n.daemon_id,
              userOverrides: {},
              policy: {},
              isLocalWorktree: false,
            })),
            createdAt: rm.created_at,
            updatedAt: rm.updated_at,
          };
          process.stderr.write(`[adhdev-mcp] Loaded mesh config from cloud API\n`);
        }
      } catch (e: any) {
        process.stderr.write(`[adhdev-mcp] Cloud mesh fetch failed, falling back to local: ${e.message}\n`);
      }
    }

    // Priority 3: Local ~/.adhdev/meshes.json
    if (!mesh) {
      try {
        const { getMesh } = await import('@adhdev/daemon-core');
        mesh = getMesh(opts.meshId);
      } catch (e: any) {
        process.stderr.write(`[adhdev-mcp] Local meshes.json lookup failed: ${e.message}\n`);
      }
    }

    // Fallback: query the running daemon (supports cloud-originating meshes
    // launched via inlineMesh that don't exist in local meshes.json)
    if (!mesh && (transport instanceof LocalTransport || transport instanceof IpcTransport)) {
      try {
        const result = await transport.command('get_mesh', { meshId: opts.meshId });
        if (result?.success && result.mesh) {
          mesh = result.mesh;
          process.stderr.write(`[adhdev-mcp] Loaded mesh config from daemon\n`);
        }
      } catch (e: any) {
        process.stderr.write(`[adhdev-mcp] Daemon mesh query failed: ${e.message}\n`);
      }
    }

    if (!mesh) {
      process.stderr.write(`[adhdev-mcp] Mesh '${opts.meshId}' not found in ${opts.mode === 'cloud' ? 'cloud or local' : 'local'} config. Use 'adhdev mesh list' to see available meshes.\n`);
      process.exit(1);
    }

    let localDaemonId: string | undefined;
    let localMachineId: string | undefined;
    let coordinatorHostname: string | undefined = os.hostname();

    if (transport instanceof LocalTransport || transport instanceof IpcTransport) {
      try {
        const { loadConfig } = await import('@adhdev/daemon-core');
        const cfg = loadConfig();
        if (cfg.registeredMachineId) localMachineId = cfg.registeredMachineId;
      } catch { /* best-effort */ }
    }

    if (transport instanceof IpcTransport) {
      try {
        const statusResult = await transport.getStatus();
        const instanceId = typeof statusResult?.status?.instanceId === 'string' ? statusResult.status.instanceId.trim() : '';
        const hostname = typeof statusResult?.status?.hostname === 'string'
          ? statusResult.status.hostname.trim()
          : typeof statusResult?.status?.machine?.hostname === 'string'
            ? statusResult.status.machine.hostname.trim()
            : '';
        if (instanceId) localDaemonId = instanceId;
        if (hostname) coordinatorHostname = hostname;
      } catch { /* best-effort metadata for remote completion forwarding */ }
    }

    const meshCtx: MeshContext = { mesh, transport, ...(localDaemonId ? { localDaemonId } : {}), ...(localMachineId ? { localMachineId } : {}), ...(coordinatorHostname ? { coordinatorHostname } : {}) };

    const coordinatorPrompt = await buildMeshModeCoordinatorPrompt(mesh);

    const server = new Server(
      { name: 'adhdev-mcp-server', version: '0.9.81' },
      { capabilities: { tools: {}, resources: {} } },
    );

    // Expose coordinator prompt as MCP resource
    const { ListResourcesRequestSchema, ReadResourceRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{
        uri: 'coordinator://system-prompt',
        name: 'Coordinator System Prompt',
        description: `System prompt for mesh "${mesh.name}" coordinator`,
        mimeType: 'text/plain',
      }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      if (req.params.uri === 'coordinator://system-prompt') {
        return { contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: coordinatorPrompt }] };
      }
      throw new Error(`Unknown resource: ${req.params.uri}`);
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_MESH_TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a = (args ?? {}) as Record<string, any>;
      try {
        let text: string;
        switch (name) {
          case 'mesh_status': text = await meshStatus(meshCtx); break;
          case 'mesh_list_nodes': text = await meshListNodes(meshCtx); break;
          case 'mesh_enqueue_task': text = await meshEnqueueTask(meshCtx, a as any); break;
          case 'mesh_view_queue': text = await meshViewQueue(meshCtx, a as any); break;
          case 'mesh_queue_cancel': text = await meshQueueCancel(meshCtx, a as any); break;
          case 'mesh_queue_requeue': text = await meshQueueRequeue(meshCtx, a as any); break;
          case 'mesh_send_task': text = await meshSendTask(meshCtx, a as any); break;
          case 'mesh_read_chat': text = await meshReadChat(meshCtx, a as any); break;
          case 'mesh_read_debug': text = await meshReadDebug(meshCtx, a as any); break;
          case 'mesh_launch_session': text = await meshLaunchSession(meshCtx, a as any); break;
          case 'mesh_git_status': text = await meshGitStatus(meshCtx, a as any); break;
          case 'mesh_fast_forward_node': text = await meshFastForwardNode(meshCtx, a as any); break;
          case 'mesh_checkpoint': text = await meshCheckpoint(meshCtx, a as any); break;
          case 'mesh_approve': text = await meshApprove(meshCtx, a as any); break;
          case 'mesh_clone_node': text = await meshCloneNode(meshCtx, a as any); break;
          case 'mesh_remove_node': text = await meshRemoveNode(meshCtx, a as any); break;
          case 'mesh_refine_node': text = await meshRefineNode(meshCtx, a as any); break;
          case 'mesh_refine_config_schema': text = await meshRefineConfigSchema(meshCtx); break;
          case 'mesh_validate_refine_config': text = await meshValidateRefineConfig(meshCtx, a as any); break;
          case 'mesh_suggest_refine_config': text = await meshSuggestRefineConfig(meshCtx, a as any); break;
          case 'mesh_refine_plan': text = await meshRefinePlan(meshCtx, a as any); break;
          case 'mesh_cleanup_sessions': text = await meshCleanupSessions(meshCtx, a as any); break;
          case 'mesh_task_history': text = await meshTaskHistory(meshCtx, a as any); break;
          case 'mesh_reconcile_ledger': text = await meshReconcileLedger(meshCtx, a as any); break;
          default: return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
        return { content: [{ type: 'text', text }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true };
      }
    });

    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    process.stderr.write(`[adhdev-mcp] Server running in ${opts.mode} mesh mode — mesh: ${mesh.name} (${mesh.repoIdentity})\n`);
    return;
  }

  // ── Standard Mode ──────────────────────────────

  // Tool availability by mode:
  //   both:  list_sessions, launch_session, read_chat, send_chat, approve, git_status
  //   local: + screenshot (requires P2P / local daemon access)
  const allTools = [
    LIST_DAEMONS_TOOL,
    LIST_SESSIONS_TOOL,
    LAUNCH_SESSION_TOOL,
    STOP_SESSION_TOOL,
    CHECK_PENDING_TOOL,
    READ_CHAT_TOOL,
    READ_CHAT_DEBUG_TOOL,
    SEND_CHAT_TOOL,
    APPROVE_TOOL,
    GIT_STATUS_TOOL,
    GIT_LOG_TOOL,
    GIT_DIFF_TOOL,
    GIT_CHECKPOINT_TOOL,
    GIT_PUSH_TOOL,
    ...(isLocal ? [SCREENSHOT_TOOL] : []),
  ];

  const server = new Server(
    { name: 'adhdev-mcp-server', version: '0.9.66' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, any>;

    try {
      switch (name) {
        case 'list_daemons': {
          const text = await listDaemons(transport, { format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'list_sessions': {
          const text = await listSessions(transport, { format: a.format, daemon_id: a.daemon_id });
          return { content: [{ type: 'text', text }] };
        }
        case 'read_chat': {
          const text = await readChat(transport, a);
          return { content: [{ type: 'text', text }] };
        }
        case 'read_chat_debug': {
          const text = await readChatDebug(transport, a as any);
          return { content: [{ type: 'text', text }] };
        }
        case 'send_chat': {
          const text = await sendChat(transport, { message: a.message, session_id: a.session_id, daemon_id: a.daemon_id });
          return { content: [{ type: 'text', text }] };
        }
        case 'approve': {
          const action = a.action === 'reject' ? 'reject' : 'approve';
          const text = await approve(transport, { action, session_id: a.session_id, daemon_id: a.daemon_id });
          return { content: [{ type: 'text', text }] };
        }
        case 'screenshot': {
          const result = await screenshot(transport, { session_id: a.session_id });
          if (result.type === 'image') {
            return {
              content: [{ type: 'image', data: result.data, mimeType: result.mimeType }],
            };
          }
          return { content: [{ type: 'text', text: result.text }] };
        }
        case 'git_status': {
          const text = await gitStatus(transport, { workspace: a.workspace, include_diff: a.include_diff, daemon_id: a.daemon_id, format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_log': {
          const text = await gitLog(transport, { workspace: a.workspace, limit: a.limit, file: a.file, since: a.since, until: a.until, daemon_id: a.daemon_id, format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_diff': {
          const text = await gitDiff(transport, { workspace: a.workspace, file: a.file, max_lines: a.max_lines, staged: a.staged, daemon_id: a.daemon_id, format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_checkpoint': {
          const text = await gitCheckpoint(transport, { workspace: a.workspace, message: a.message, include_untracked: a.include_untracked, daemon_id: a.daemon_id });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_push': {
          const text = await gitPush(transport, { workspace: a.workspace, remote: a.remote, branch: a.branch, daemon_id: a.daemon_id });
          return { content: [{ type: 'text', text }] };
        }
        case 'launch_session': {
          const text = await launchSession(transport, {
            type: a.type,
            workspace: a.workspace,
            model: a.model,
            daemon_id: a.daemon_id,
          });
          return { content: [{ type: 'text', text }] };
        }
        case 'stop_session': {
          const text = await stopSession(transport, {
            session_id: a.session_id,
            daemon_id: a.daemon_id,
            type: a.type,
          });
          return { content: [{ type: 'text', text }] };
        }
        case 'check_pending': {
          const text = await checkPending(transport, { daemon_id: a.daemon_id, format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }],
        isError: true,
      };
    }
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  process.stderr.write(`[adhdev-mcp] Server running in ${opts.mode} mode.\n`);
}
