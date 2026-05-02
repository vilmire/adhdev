/**
 * ADHDev MCP Server
 *
 * Exposes IDE agent sessions as MCP tools via stdio transport.
 * Two modes:
 *   local  — talks to standalone daemon at localhost:3847
 *   cloud  — talks to ADHDev cloud API with an API key
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { LocalTransport } from './transports/local.js';
import { CloudTransport } from './transports/cloud.js';

import { LIST_SESSIONS_TOOL, listSessions } from './tools/list-sessions.js';
import { READ_CHAT_TOOL, readChat } from './tools/read-chat.js';
import { SEND_CHAT_TOOL, sendChat } from './tools/send-chat.js';
import { APPROVE_TOOL, approve } from './tools/approve.js';
import { SCREENSHOT_TOOL, screenshot } from './tools/screenshot.js';
import { GIT_STATUS_TOOL, gitStatus } from './tools/git-status.js';
import { LAUNCH_SESSION_TOOL, launchSession } from './tools/launch-session.js';
import { CHECK_PENDING_TOOL, checkPending } from './tools/check-pending.js';

export interface AdhdevMcpServerOptions {
  mode: 'local' | 'cloud';
  // local options
  port?: number;
  password?: string;
  // cloud options
  apiKey?: string;
  baseUrl?: string;
}

export async function startMcpServer(opts: AdhdevMcpServerOptions): Promise<void> {
  const transport =
    opts.mode === 'cloud'
      ? new CloudTransport({ apiKey: opts.apiKey!, baseUrl: opts.baseUrl })
      : new LocalTransport({ port: opts.port, password: opts.password });

  // Verify connectivity before registering tools
  const alive = await transport.ping();
  if (!alive) {
    const hint =
      opts.mode === 'local'
        ? `Make sure the standalone daemon is running (adhdev standalone or npx @adhdev/daemon-standalone).`
        : `Check your API key and network connectivity.`;
    process.stderr.write(`[adhdev-mcp] Cannot reach ${opts.mode} daemon. ${hint}\n`);
    process.exit(1);
  }

  const isLocal = opts.mode === 'local';

  // Tool availability by mode:
  //   both:  list_sessions, launch_session, read_chat, send_chat, approve, git_status
  //   local: + screenshot (requires P2P / local daemon access)
  const allTools = [
    LIST_SESSIONS_TOOL,
    LAUNCH_SESSION_TOOL,
    CHECK_PENDING_TOOL,
    READ_CHAT_TOOL,
    SEND_CHAT_TOOL,
    APPROVE_TOOL,
    GIT_STATUS_TOOL,
    ...(isLocal ? [SCREENSHOT_TOOL] : []),
  ];

  const server = new Server(
    { name: 'adhdev-mcp-server', version: '0.9.59' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, any>;

    try {
      switch (name) {
        case 'list_sessions': {
          const text = await listSessions(transport);
          return { content: [{ type: 'text', text }] };
        }
        case 'read_chat': {
          const text = await readChat(transport, a);
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
          const result = await screenshot(transport, { session_id: a.session_id, daemon_id: a.daemon_id });
          if (result.type === 'image') {
            return {
              content: [{ type: 'image', data: result.data, mimeType: result.mimeType }],
            };
          }
          return { content: [{ type: 'text', text: result.text }] };
        }
        case 'git_status': {
          const text = await gitStatus(transport, { workspace: a.workspace, include_diff: a.include_diff, daemon_id: a.daemon_id });
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
        case 'check_pending': {
          const text = await checkPending(transport, { daemon_id: a.daemon_id });
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
