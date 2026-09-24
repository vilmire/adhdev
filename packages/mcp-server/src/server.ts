/**
 * ADHDev MCP Server
 *
 * Exposes IDE agent sessions as MCP tools via stdio transport.
 * Two modes:
 *   local  — talks to standalone daemon at localhost:3847
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
import { IpcTransport } from './transports/ipc.js';
import type { CommandTransport } from './transports/mode.js';

import { LIST_SESSIONS_TOOL, listSessions } from './tools/list-sessions.js';
import { LIST_DAEMONS_TOOL, listDaemons } from './tools/list-daemons.js';
import { READ_CHAT_TOOL, readChat } from './tools/read-chat.js';
import { READ_CHAT_DEBUG_TOOL, readChatDebug } from './tools/read-chat-debug.js';
import { SPEC_DEBUG_TOOL, specDebug } from './tools/spec-debug.js';
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
  ALL_MESH_TOOLS, MESH_PLAN_ONBOARDING_TOOL, MESH_CREATE_TOOL, MESH_ADD_NODE_TOOL, MESH_NOTIFY_WORKER_TOOL,
  // Standard mode publishes these three mesh-bootstrap tools outside mesh mode,
  // so it dispatches them directly rather than through the mesh registry.
  meshPlanOnboarding, meshCreate, meshAddNode,
  // Flag-gated, so it is not an entry in either dispatch table — see below.
  meshNotifyWorker,
} from './tools/mesh-tools.js';
import type { MeshContext } from './tools/mesh-tools.js';
import { resolveMeshToolHandler } from './tools/mesh-tool-dispatch.js';
import { runMeshToolWithPendingEvents } from './tools/mesh-pending-events-attach.js';
import { validateMeshToolArgs, unknownToolArgsError, enumValueError } from './tools/validate-tool-args.js';
import { annotateAll } from './tools/tool-annotations.js';
import {
  resolveWorkerModeTools, readWorkerCredentials, reportCompletion, progressUpdate, peerContextPull, drainMailbox,
} from './tools/worker-tools.js';
import type { WorkerTool } from '@adhdev/mesh-shared';

/**
 * Version reported in the MCP `initialize` response (`serverInfo.version`).
 *
 * ★Keep this a fixed literal. Do NOT set it to the real package version, and do
 * NOT read it at runtime from package.json. This build is vendored verbatim into
 * two committed bundles (packages/daemon-cloud/vendor/mcp-server and
 * oss/packages/daemon-standalone/vendor/mcp-server) that a drift gate compares
 * against HEAD. Any value tracking the release version makes every version bump
 * rewrite those bundles, and version-bump.sh cannot commit them before the gate
 * runs — a structural deadlock that blocked the root half of the 1.0.42 release
 * twice. (The oss half had already shipped: oss/scripts/version-bump.sh does not
 * run check:vendor, so it sails through the same stage-then-check pattern. The
 * two scripts are not symmetric despite the root script's comment.)
 *
 * Nothing consumes this value: MCP negotiates on `protocolVersion`, not on
 * serverInfo, and no code in this repo reads it. The evidence is that the
 * standard-mode literal sat at 0.9.66 for ~50 releases without anyone noticing.
 * A placeholder is honest about that; a real-looking number would only invite
 * someone to trust it again.
 *
 * A runtime package.json lookup is doubly wrong: the vendored package.json is
 * synthesized by vendor-runtime-deps.mjs with no `version` field (it would
 * resolve to undefined), and it would re-embed the version in the vendor bytes,
 * reintroducing the exact drift this constant removes.
 */
const MCP_SERVER_VERSION = '0.0.0-vendored';

export interface AdhdevMcpServerOptions {
  mode: 'local' | 'ipc';
  // local options
  port?: number;
  password?: string;
  // mesh mode (optional — restricts tools to mesh-scoped set)
  meshId?: string;
  // worker mode (optional — the MINIMAL delegated-worker toolset). Mutually
  // exclusive with meshId, and index.ts enforces that by dropping meshId.
  worker?: boolean;
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
  const transport: CommandTransport =
    opts.mode === 'ipc'
      ? new IpcTransport({ port: opts.port })
      : new LocalTransport({ port: opts.port, password: opts.password });

  // Verify connectivity before registering tools
  const alive = await transport.ping();
  if (!alive) {
    const hint =
      opts.mode === 'local'
        ? `Make sure the standalone daemon is running (adhdev standalone or npx @adhdev/daemon-standalone).`
        : `Make sure the cloud daemon is running with local IPC enabled (adhdev daemon).`;
    process.stderr.write(`[adhdev-mcp] Cannot reach ${opts.mode} daemon. ${hint}\n`);
    process.exit(1);
  }

  const isLocal = opts.mode === 'local';

  // ── Worker Mode ───────────────────────────────
  //
  // Checked BEFORE mesh mode. A delegated worker gets `report_completion` /
  // `progress_update` plus read-only git inspection of its own workspace — and
  // nothing from the coordinator surface. No mesh tools, and no
  // `coordinator://system-prompt` resource (note this block registers no
  // resource capability at all).
  if (opts.worker) {
    const credentials = readWorkerCredentials();
    if (!credentials.bind && !credentials.token) {
      // FAIL CLOSED (design §3 step 4). A worker server that booted without a
      // credential could not attribute anything it was told, so the useful
      // failure is a loud one at startup — not a tool that accepts a report and
      // silently drops it because it has no identity to file it under.
      process.stderr.write(
        '[adhdev-mcp] Worker mode requires ADHDEV_WORKER_SESSION_BIND (or ADHDEV_WORKER_TASK_TOKEN) in the MCP server env. '
        + 'This is written by the daemon when it launches a delegated worker.\n',
      );
      process.exit(1);
    }

    // F1: the advertised list is derived from `WORKER_TOOLS` (@adhdev/mesh-shared)
    // — ListTools order is the tuple's order, and resolveWorkerModeTools throws
    // at startup if any tuple entry lacks a schema or any schema is not in the
    // tuple. The same tuple renders the footer every dispatched task carries.
    const workerTools = resolveWorkerModeTools();
    const workerToolByName = new Map<string, { inputSchema?: { properties?: Record<string, unknown> } }>(
      workerTools.map(tool => [tool.name, tool]),
    );

    const server = new Server(
      { name: 'adhdev-mcp-server', version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: workerTools }));

    // E-T0 (design §7.1): every worker tool response — whichever tool was
    // called — gets any pending urgent mailbox memo appended before it goes
    // back over stdio. This is the piggyback: no new delivery channel, just
    // one extra daemon round-trip riding on a response that was going out
    // anyway. Applied here, wrapping the WHOLE switch, rather than inside each
    // case — the design is explicit that it applies to "whichever tool" the
    // worker calls, not just the reporting tools, and a single wrap point is
    // the only way to guarantee that without repeating it five times.
    async function withMailboxPiggyback(
      response: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
    ): Promise<typeof response> {
      const mailboxText = await drainMailbox(transport, credentials);
      if (!mailboxText) return response;
      const content = [...response.content];
      const last = content[content.length - 1];
      if (last && last.type === 'text') {
        content[content.length - 1] = { ...last, text: last.text + mailboxText };
      } else {
        content.push({ type: 'text', text: mailboxText.trimStart() });
      }
      return { ...response, content };
    }

    // Keyed by the contract tuple's member type, so a WORKER_TOOLS entry with no
    // handler is a compile error rather than a runtime "Unknown tool".
    type WorkerToolResponse = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    const asResponse = (result: { text: string; isError?: boolean }): WorkerToolResponse =>
      ({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) });
    const workerHandlers: Record<WorkerTool, (a: Record<string, any>) => Promise<WorkerToolResponse>> = {
      report_completion: async (a) => asResponse(await reportCompletion(transport, credentials, a)),
      progress_update: async (a) => asResponse(await progressUpdate(transport, credentials, a)),
      peer_context_pull: async (a) => asResponse(await peerContextPull(transport, credentials, a)),
      git_status: async (a) => asResponse({ text: await gitStatus(transport, { workspace: a.workspace, include_diff: a.include_diff, format: a.format }) }),
      git_log: async (a) => asResponse({ text: await gitLog(transport, { workspace: a.workspace, limit: a.limit, file: a.file, since: a.since, until: a.until, format: a.format }) }),
      git_diff: async (a) => asResponse({ text: await gitDiff(transport, { workspace: a.workspace, file: a.file, max_lines: a.max_lines, staged: a.staged, format: a.format }) }),
    };

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a = (args ?? {}) as Record<string, any>;

      const workerTool = workerToolByName.get(name);
      if (workerTool) {
        const unknownArgsError = unknownToolArgsError(name, workerTool.inputSchema?.properties, a)
          ?? enumValueError(name, workerTool.inputSchema?.properties, a);
        if (unknownArgsError) return withMailboxPiggyback({ content: [{ type: 'text', text: unknownArgsError }], isError: true });
      }

      try {
        const handler = Object.prototype.hasOwnProperty.call(workerHandlers, name)
          ? workerHandlers[name as WorkerTool]
          : undefined;
        if (!handler) {
          return withMailboxPiggyback({ content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
        }
        return withMailboxPiggyback(await handler(a));
      } catch (err: any) {
        return withMailboxPiggyback({ content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true });
      }
    });

    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    process.stderr.write(`[adhdev-mcp] Server running in ${opts.mode} WORKER mode — ${workerTools.length} tools.\n`);
    return;
  }

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

    // Priority 2: Local ~/.adhdev/meshes.json
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
      process.stderr.write(`[adhdev-mcp] Mesh '${opts.meshId}' not found in local config. Use 'adhdev mesh list' to see available meshes.\n`);
      process.exit(1);
    }

    let localDaemonId: string | undefined;
    let localMachineId: string | undefined;
    let coordinatorHostname: string | undefined = os.hostname();

    if (transport instanceof LocalTransport || transport instanceof IpcTransport) {
      try {
        const { loadConfig } = await import('@adhdev/daemon-core');
        const cfg = loadConfig();
        if (cfg.machineId) localMachineId = cfg.machineId;
        else if (cfg.registeredMachineId) localMachineId = cfg.registeredMachineId;
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

    // (3) Session-anchored routing: the daemon injects this coordinator CLI session's own
    // runtime id via ADHDEV_COORDINATOR_SESSION_ID at launch. Carrying it on MeshContext lets
    // every dispatch stamp the originating coordinator session so the worker's completion
    // routes back to the right session (multi-coordinator). Absent → daemon-level fallback.
    const coordinatorSessionId = typeof process.env.ADHDEV_COORDINATOR_SESSION_ID === 'string' && process.env.ADHDEV_COORDINATOR_SESSION_ID.trim()
      ? process.env.ADHDEV_COORDINATOR_SESSION_ID.trim()
      : undefined;

    const meshCtx: MeshContext = { mesh, transport, ...(localDaemonId ? { localDaemonId } : {}), ...(localMachineId ? { localMachineId } : {}), ...(coordinatorHostname ? { coordinatorHostname } : {}), ...(coordinatorSessionId ? { coordinatorSessionId } : {}) };

    const coordinatorPrompt = await buildMeshModeCoordinatorPrompt(mesh);

    const server = new Server(
      { name: 'adhdev-mcp-server', version: MCP_SERVER_VERSION },
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

    // E-T0 (design §7.1): `mesh_notify_worker` is published ONLY when the
    // worker-MCP flag is on, so a flag-off coordinator's ListTools response is
    // byte-identical to before E-T0 existed (the promise every worker-MCP phase
    // has kept since Phase A). ★That flag now defaults ON (2026-09-18 owner
    // approval — runtime-defaults.ts), so this tool is published by default and
    // the byte-identical response is what an explicit ADHDEV_WORKER_MCP=off
    // yields. `isWorkerMcpEnabled` is a pure env-flag read — see its doc comment
    // in daemon-core's index.ts for why mcp-server is allowed to import it
    // directly rather than going through a transport command.
    const { isWorkerMcpEnabled } = await import('@adhdev/daemon-core');
    const meshTools = isWorkerMcpEnabled()
      ? [...ALL_MESH_TOOLS, ...annotateAll([MESH_NOTIFY_WORKER_TOOL])]
      : ALL_MESH_TOOLS;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: meshTools }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a = (args ?? {}) as Record<string, any>;
      // Reject mistyped/unknown parameters before dispatch (see
      // validate-tool-args.ts — silently ignoring `session_id` for
      // `session_ids` once deleted a live worker session).
      const unknownArgsError = validateMeshToolArgs(name, a);
      if (unknownArgsError) return { content: [{ type: 'text', text: unknownArgsError }], isError: true };
      // ★Dispatch via the type-enforced registry (mesh-tool-dispatch.ts), not a
      // hand-maintained switch. A canonical tool with no handler is now a
      // compile error rather than a published tool that answers
      // "Unknown tool" at runtime.
      try {
        let run: () => Promise<string>;
        if (name === 'mesh_notify_worker') {
          // Flag-gated rather than alias-shaped: its behaviour depends on a
          // runtime env read, so it cannot be a fixed entry in either table.
          run = async () => isWorkerMcpEnabled()
            ? await meshNotifyWorker(meshCtx, a as any)
            : JSON.stringify({ success: false, error: 'worker_mcp_disabled' });
        } else {
          const handler = resolveMeshToolHandler(name);
          if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
          run = () => handler(meshCtx, a);
        }
        // Coordinator notices ride EVERY mesh tool response as
        // `pendingCoordinatorEvents` (a tool that drained itself is left as is).
        const text = await runMeshToolWithPendingEvents(meshCtx, run);
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
  const allTools = annotateAll([
    LIST_DAEMONS_TOOL,
    LIST_SESSIONS_TOOL,
    LAUNCH_SESSION_TOOL,
    STOP_SESSION_TOOL,
    CHECK_PENDING_TOOL,
    READ_CHAT_TOOL,
    READ_CHAT_DEBUG_TOOL,
    SPEC_DEBUG_TOOL,
    SEND_CHAT_TOOL,
    APPROVE_TOOL,
    GIT_STATUS_TOOL,
    GIT_LOG_TOOL,
    GIT_DIFF_TOOL,
    GIT_CHECKPOINT_TOOL,
    GIT_PUSH_TOOL,
    // Mesh bootstrap: create a mesh + register its first node from an MCP-only agent.
    // Exposed in standard mode precisely because this is the no-mesh-yet context —
    // mesh mode refuses to boot without an existing meshId (see the mesh-mode block above).
    MESH_PLAN_ONBOARDING_TOOL,
    MESH_CREATE_TOOL,
    MESH_ADD_NODE_TOOL,
    ...(isLocal ? [SCREENSHOT_TOOL] : []),
  ]);

  const server = new Server(
    { name: 'adhdev-mcp-server', version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  const standardToolByName = new Map<string, { inputSchema?: { properties?: Record<string, unknown> } }>(
    allTools.map(tool => [tool.name, tool]),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, any>;

    // Same unknown-parameter + enum-value gate as mesh mode (see validate-tool-args.ts).
    const standardTool = standardToolByName.get(name);
    if (standardTool) {
      const unknownArgsError = unknownToolArgsError(name, standardTool.inputSchema?.properties, a)
        ?? enumValueError(name, standardTool.inputSchema?.properties, a);
      if (unknownArgsError) return { content: [{ type: 'text', text: unknownArgsError }], isError: true };
    }

    try {
      switch (name) {
        case 'list_daemons': {
          const text = await listDaemons(transport, { format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'list_sessions': {
          const text = await listSessions(transport, { format: a.format });
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
        case 'spec_debug': {
          const text = await specDebug(transport, a as any);
          return { content: [{ type: 'text', text }] };
        }
        case 'send_chat': {
          const text = await sendChat(transport, { message: a.message, session_id: a.session_id, message_id: a.message_id, delivery_mode: a.delivery_mode });
          return { content: [{ type: 'text', text }] };
        }
        case 'approve': {
          const action = a.action === 'reject' ? 'reject' : 'approve';
          const text = await approve(transport, { action, session_id: a.session_id });
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
          const text = await gitStatus(transport, { workspace: a.workspace, include_diff: a.include_diff, format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_log': {
          const text = await gitLog(transport, { workspace: a.workspace, limit: a.limit, file: a.file, since: a.since, until: a.until, format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_diff': {
          const text = await gitDiff(transport, { workspace: a.workspace, file: a.file, max_lines: a.max_lines, staged: a.staged, format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_checkpoint': {
          const text = await gitCheckpoint(transport, { workspace: a.workspace, message: a.message, include_untracked: a.include_untracked });
          return { content: [{ type: 'text', text }] };
        }
        case 'git_push': {
          const text = await gitPush(transport, { workspace: a.workspace, remote: a.remote, branch: a.branch });
          return { content: [{ type: 'text', text }] };
        }
        case 'launch_session': {
          const text = await launchSession(transport, {
            type: a.type,
            workspace: a.workspace,
            model: a.model,
          });
          return { content: [{ type: 'text', text }] };
        }
        case 'stop_session': {
          const text = await stopSession(transport, {
            session_id: a.session_id,
            type: a.type,
          });
          return { content: [{ type: 'text', text }] };
        }
        case 'check_pending': {
          const text = await checkPending(transport, { format: a.format });
          return { content: [{ type: 'text', text }] };
        }
        case 'mesh_create': {
          const text = await meshCreate(transport, a as any);
          return { content: [{ type: 'text', text }] };
        }
        case 'mesh_plan_onboarding': {
          const text = await meshPlanOnboarding(transport, a as any);
          return { content: [{ type: 'text', text }] };
        }
        case 'mesh_add_node': {
          const text = await meshAddNode(transport, a as any);
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
