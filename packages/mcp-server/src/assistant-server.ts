/**
 * Assistant mode — the fourth server.ts branch (`adhdev mcp --assistant`),
 * kept in its own file so server.ts does not grow
 * (docs/design/2026-10-07-assistant-layer.md §4.5 "mcp-server").
 *
 * Publishes exactly `ASSISTANT_TOOLS` (@adhdev/mesh-shared), in tuple order,
 * each calling its `ASSISTANT_TOOL_VERBS` daemon verb with the caller's
 * `assistantSessionId`. No mesh tools and no coordinator prompt resource.
 *
 * Unlike worker mode there is no fail-closed credential check: an MCP-only
 * assistant (Claude Desktop and the like) has no daemon-launched session, so
 * `ADHDEV_ASSISTANT_SESSION_ID` is optional. It is routing/ownership only.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isAssistantTool } from '@adhdev/mesh-shared';

import type { CommandTransport } from './transports/mode.js';
import {
  attachAssistantEvents,
  callAssistantTool,
  readAssistantSessionIdFromEnv,
  resolveAssistantModeTools,
  type AssistantModeTool,
} from './tools/assistant-tools.js';
import { enumValueError, missingRequiredToolArgsError, unknownToolArgsError } from './tools/validate-tool-args.js';

type AssistantToolResponse = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Argument gate shared by the server and its tests: unknown key → bad enum value → missing required. */
export function assistantToolArgsError(tool: AssistantModeTool, args: Record<string, unknown>): string | null {
  const properties = tool.inputSchema.properties;
  return unknownToolArgsError(tool.name, properties, args)
    ?? enumValueError(tool.name, properties, args)
    ?? missingRequiredToolArgsError(tool.name, tool.inputSchema, args);
}

/**
 * Handle one CallTool request. Exported so the parity test can drive it with a
 * fake transport instead of a stdio server.
 */
export async function handleAssistantToolCall(
  transport: Pick<CommandTransport, 'command'>,
  tools: readonly AssistantModeTool[],
  assistantSessionId: string | undefined,
  name: string,
  rawArgs: Record<string, unknown> | undefined,
): Promise<AssistantToolResponse> {
  const args = rawArgs ?? {};
  const tool = tools.find(t => t.name === name);
  if (!tool || !isAssistantTool(name)) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const argsError = assistantToolArgsError(tool, args);
  if (argsError) return { content: [{ type: 'text', text: argsError }], isError: true };
  try {
    const result = await callAssistantTool(transport, name, args, assistantSessionId);
    // MCP-only relay delivery rides every tool response (§4.5).
    const text = await attachAssistantEvents(transport, assistantSessionId, result.text);
    return { content: [{ type: 'text', text }], ...(result.isError ? { isError: true } : {}) };
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true };
  }
}

export async function startAssistantServer(opts: {
  transport: CommandTransport;
  mode: 'local' | 'ipc';
  serverVersion: string;
}): Promise<void> {
  const tools = resolveAssistantModeTools();
  const assistantSessionId = readAssistantSessionIdFromEnv();

  const server = new Server(
    { name: 'adhdev-mcp-server', version: opts.serverVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => handleAssistantToolCall(
    opts.transport,
    tools,
    assistantSessionId,
    req.params.name,
    req.params.arguments as Record<string, unknown> | undefined,
  ));

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[adhdev-mcp] Server running in ${opts.mode} ASSISTANT mode — ${tools.length} tools`
      + `${assistantSessionId ? '' : ' (no ADHDEV_ASSISTANT_SESSION_ID: MCP-only assistant)'}.\n`,
  );
}
