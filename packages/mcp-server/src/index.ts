/**
 * @adhdev/mcp-server — CLI entry point
 *
 * Usage:
 *   npx @adhdev/mcp-server                        # local mode (localhost:3847)
 *   npx @adhdev/mcp-server --port 4000            # custom port
 *   npx @adhdev/mcp-server --api-key adk_xxx      # cloud mode
 *   npx @adhdev/mcp-server --mode ipc --repo-mesh mesh_xxx  # cloud daemon IPC mode
 */

import { startMcpServer } from './server.js';

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): {
  mode: 'local' | 'cloud' | 'ipc';
  port?: number;
  password?: string;
  apiKey?: string;
  baseUrl?: string;
  meshId?: string;
} {
  const args = argv.slice(2);
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let port: number | undefined;
  let password: string | undefined;
  let meshId: string | undefined;
  let explicitMode: 'local' | 'cloud' | 'ipc' | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--api-key' || arg === '-k') && args[i + 1]) {
      apiKey = args[++i];
    } else if (arg?.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
    } else if (arg === '--base-url' && args[i + 1]) {
      baseUrl = args[++i];
    } else if (arg === '--mode' && args[i + 1]) {
      const value = String(args[++i]).trim();
      if (value === 'local' || value === 'cloud' || value === 'ipc') explicitMode = value;
    } else if (arg?.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length).trim();
      if (value === 'local' || value === 'cloud' || value === 'ipc') explicitMode = value;
    } else if (arg === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (arg?.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--password' && args[i + 1]) {
      password = args[++i];
    } else if ((arg === '--repo-mesh' || arg === '--mesh') && args[i + 1]) {
      meshId = args[++i];
    } else if (arg?.startsWith('--repo-mesh=')) {
      meshId = arg.slice('--repo-mesh='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // Also accept env vars
  if (!apiKey && env.ADHDEV_API_KEY) apiKey = env.ADHDEV_API_KEY;
  if (!password && env.ADHDEV_PASSWORD) password = env.ADHDEV_PASSWORD;
  if (!meshId && env.ADHDEV_MESH_ID) meshId = env.ADHDEV_MESH_ID;
  if (!explicitMode && env.ADHDEV_MCP_TRANSPORT) {
    const value = env.ADHDEV_MCP_TRANSPORT.trim();
    if (value === 'local' || value === 'cloud' || value === 'ipc') explicitMode = value;
  }

  const mode = explicitMode || (apiKey ? 'cloud' : (meshId && env.ADHDEV_INLINE_MESH ? 'ipc' : 'local'));
  return { mode, port, password, apiKey, baseUrl, meshId };
}

function printHelp(): void {
  console.error(`
adhdev-mcp — ADHDev MCP Server

Usage:
  adhdev-mcp                                    Local mode (requires standalone daemon)
  adhdev-mcp --api-key <key>                    Cloud mode (ADHDev cloud API)
  adhdev-mcp --mode ipc --repo-mesh <mesh_id>   Cloud daemon IPC mesh mode
  adhdev-mcp --repo-mesh <mesh_id>              Mesh mode (coordinator-scoped tools)

Options:
  --mode <mode>           Transport: local, cloud, or ipc
  --port <n>              Standalone or IPC daemon port (defaults: local 3847, ipc 19222)
  --password <pass>       Standalone daemon password (if set)
  --api-key <key>         ADHDev cloud API key (switches to cloud mode)
  --base-url <url>        Override cloud API base URL
  --repo-mesh <mesh_id>   Enable mesh mode — exposes only mesh-scoped coordinator tools
  --help                  Show this help

Environment variables:
  ADHDEV_API_KEY      API key (cloud mode)
  ADHDEV_PASSWORD     Daemon password (local mode)
  ADHDEV_MESH_ID      Mesh ID (mesh mode)
  ADHDEV_MCP_TRANSPORT Transport: local, cloud, or ipc

Standard tools:   list_daemons, list_sessions, launch_session, stop_session, check_pending, read_chat, send_chat, approve, git_status, git_log, git_diff, git_checkpoint, git_push, screenshot
Mesh tools:       mesh_status, mesh_list_nodes, mesh_send_task, mesh_read_chat, mesh_launch_session, mesh_git_status, mesh_checkpoint, mesh_approve, mesh_clone_node, mesh_remove_node
`.trim());
}

startMcpServer(parseArgs(process.argv)).catch((err) => {
  process.stderr.write(`[adhdev-mcp] Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
