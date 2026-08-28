import { ALL_MESH_TOOLS } from './tools/mesh-tools.js';
import { ALL_WORKER_TOOLS } from './tools/worker-tools.js';

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
  const workerTools = ALL_WORKER_TOOLS.map(tool => tool.name);
  return `
ADHDev MCP Server

Usage:
  adhdev mcp                                    Local mode (requires standalone daemon)
  adhdev mcp --mode ipc --repo-mesh <mesh_id>   Cloud daemon IPC mesh mode
  adhdev mcp --mode ipc --worker                Delegated-worker mode (daemon-launched; needs a session bind)
  adhdev-mcp --help                             Compatibility bin (same server, legacy package entrypoint)

Options:
  --mode <mode>           Transport: local or ipc
  --port <n>              Standalone or IPC daemon port (defaults: local 3847, ipc 19222)
  --password <pass>       Standalone daemon password (if set)
  --repo-mesh <mesh_id>   Enable mesh mode — exposes only mesh-scoped coordinator tools
  --worker                Enable worker mode — the minimal delegated-worker toolset.
                          Overrides --repo-mesh: a worker never gets coordinator tools.
  --help                  Show this help

Environment variables:
  ADHDEV_PASSWORD     Daemon password (local mode)
  ADHDEV_MESH_ID      Mesh ID (mesh mode)
  ADHDEV_MCP_TRANSPORT Transport: local or ipc
  ADHDEV_WORKER_SESSION_BIND  Worker session bind (worker mode; written by the daemon)
  ADHDEV_WORKER_TASK_TOKEN    Worker task token (worker mode; alternative to the bind)

Standard tools:   ${STANDARD_TOOLS.join(', ')}
Mesh tools:       ${meshTools.join(', ')}
Worker tools:     ${workerTools.join(', ')}, git_status, git_log, git_diff
`.trim();
}
