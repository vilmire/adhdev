import { ALL_MESH_TOOLS } from './tools/mesh-tools.js';

const STANDARD_TOOLS = [
  'list_daemons',
  'list_sessions',
  'launch_session',
  'stop_session',
  'check_pending',
  'read_chat',
  'read_chat_debug',
  'send_chat',
  'approve',
  'git_status',
  'git_log',
  'git_diff',
  'git_checkpoint',
  'git_push',
  'screenshot',
];

export function buildMcpHelpText(): string {
  const meshTools = ALL_MESH_TOOLS.map(tool => tool.name);
  return `
ADHDev MCP Server

Usage:
  adhdev mcp                                    Local mode (requires standalone daemon)
  adhdev mcp --api-key <key>                    Cloud mode (ADHDev cloud API)
  adhdev mcp --mode ipc --repo-mesh <mesh_id>   Cloud daemon IPC mesh mode
  adhdev-mcp --help                             Compatibility bin (same server, legacy package entrypoint)

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

Standard tools:   ${STANDARD_TOOLS.join(', ')}
Mesh tools:       ${meshTools.join(', ')}
`.trim();
}
