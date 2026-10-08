import { ASSISTANT_SESSION_ID_ENV, ASSISTANT_TOOLS, WORKER_TOOLS } from '@adhdev/mesh-shared';

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
  // F1: the worker list is the contract tuple itself, not a hand-maintained copy.
  const workerTools: readonly string[] = WORKER_TOOLS;
  const assistantTools: readonly string[] = ASSISTANT_TOOLS;
  return `
ADHDev MCP Server

Usage:
  adhdev mcp                                    Local mode (requires standalone daemon)
  adhdev mcp --mode ipc --repo-mesh <mesh_id>   Cloud daemon IPC mesh mode
  adhdev mcp --mode ipc --worker                Delegated-worker mode (daemon-launched; needs a session bind)
  adhdev mcp --assistant                        Assistant mode (project / memory / skill tools)
  adhdev-mcp --help                             Compatibility bin (same server, legacy package entrypoint)

Options:
  --mode <mode>           Transport: local or ipc
  --port <n>              Standalone or IPC daemon port (defaults: local 3847, ipc 19222)
  --password <pass>       Standalone daemon password (if set)
  --daemon-auth-file <p>  Standalone daemon's per-boot MCP credential file (local mode;
                          stamped by the daemon into the coordinator/assistant launch)
  --repo-mesh <mesh_id>   Enable mesh mode — exposes only mesh-scoped coordinator tools
  --worker                Enable worker mode — the minimal delegated-worker toolset.
                          Overrides --repo-mesh: a worker never gets coordinator tools.
  --assistant             Enable assistant mode — the assistant's project, memory and skill tools.
                          --worker wins over it; combining it with --repo-mesh is an error.
  --help                  Show this help

Environment variables:
  ADHDEV_PASSWORD     Daemon password (local mode)
  ADHDEV_DAEMON_AUTH_FILE     Same as --daemon-auth-file (ignored in worker mode)
  ADHDEV_MESH_ID      Mesh ID (mesh mode)
  ADHDEV_MCP_TRANSPORT Transport: local or ipc
  ADHDEV_WORKER_SESSION_BIND  Worker session bind (worker mode; written by the daemon)
  ADHDEV_WORKER_TASK_TOKEN    Worker task token (worker mode; alternative to the bind)
  ${ASSISTANT_SESSION_ID_ENV} Assistant session id (assistant mode; written by the daemon, optional)

Standard tools:   ${STANDARD_TOOLS.join(', ')}
Mesh tools:       ${meshTools.join(', ')}
Worker tools:     ${workerTools.join(', ')}
Assistant tools:  ${assistantTools.join(', ')}
`.trim();
}
