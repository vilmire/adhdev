import { ADHDEV_DAEMON_AUTH_FILE_ENV, ADHDEV_DAEMON_AUTH_FILE_FLAG } from '@adhdev/daemon-core';

import { buildMcpHelpText } from './help.js';

/**
 * CLI argument parsing for the MCP server entry point.
 *
 * Split out of index.ts so it can be imported without side effects: index.ts
 * calls startMcpServer() at module load, so a test that imported parseArgs from
 * there would boot a real stdio server.
 */

/**
 * A command line that names two toolsets that cannot be combined. Thrown (not
 * `process.exit`) so parseArgs stays side-effect free for tests; index.ts turns
 * it into exit 1.
 */
export class McpCliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpCliArgsError';
  }
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): {
  mode: 'local' | 'ipc';
  port?: number;
  password?: string;
  daemonAuthFile?: string;
  meshId?: string;
  worker?: boolean;
  assistant?: boolean;
} {
  const args = argv.slice(2);
  let port: number | undefined;
  let password: string | undefined;
  // Coordinator / assistant scope credential FILE of a token- or
  // password-gated standalone daemon (daemon-core standalone-mcp-auth.ts).
  let daemonAuthFile: string | undefined;
  let meshId: string | undefined;
  let explicitMode: 'local' | 'ipc' | undefined;
  // WORKER-MCP: `--worker` selects the minimal delegated-worker toolset.
  // Orthogonal to `--mode`, which is the TRANSPORT axis (local | ipc) — the
  // same distinction that makes "mesh mode" a toolset and not a third transport.
  let worker = false;
  // Assistant layer (docs/design/2026-10-07-assistant-layer.md §4.5): the
  // assistant's project/memory/skill toolset. Same toolset axis as --worker.
  let assistant = false;
  // Only an explicit --repo-mesh flag conflicts with --assistant; an inherited
  // ADHDEV_MESH_ID env is dropped below instead (see the precedence note).
  let meshFromFlag = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode' && args[i + 1]) {
      const value = String(args[++i]).trim();
      if (value === 'local' || value === 'ipc') explicitMode = value;
    } else if (arg?.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length).trim();
      if (value === 'local' || value === 'ipc') explicitMode = value;
    } else if (arg === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (arg?.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--password' && args[i + 1]) {
      password = args[++i];
    } else if (arg === ADHDEV_DAEMON_AUTH_FILE_FLAG && args[i + 1]) {
      daemonAuthFile = args[++i];
    } else if (arg?.startsWith(`${ADHDEV_DAEMON_AUTH_FILE_FLAG}=`)) {
      daemonAuthFile = arg.slice(ADHDEV_DAEMON_AUTH_FILE_FLAG.length + 1);
    } else if ((arg === '--repo-mesh' || arg === '--mesh') && args[i + 1]) {
      meshId = args[++i];
      meshFromFlag = true;
    } else if (arg?.startsWith('--repo-mesh=')) {
      meshId = arg.slice('--repo-mesh='.length);
      meshFromFlag = true;
    } else if (arg === '--worker') {
      worker = true;
    } else if (arg === '--assistant') {
      assistant = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // Also accept env vars
  if (!password && env.ADHDEV_PASSWORD) password = env.ADHDEV_PASSWORD;
  if (!daemonAuthFile && env[ADHDEV_DAEMON_AUTH_FILE_ENV]?.trim()) daemonAuthFile = env[ADHDEV_DAEMON_AUTH_FILE_ENV]!.trim();
  if (!meshId && env.ADHDEV_MESH_ID) meshId = env.ADHDEV_MESH_ID;
  if (!explicitMode && env.ADHDEV_MCP_TRANSPORT) {
    const value = env.ADHDEV_MCP_TRANSPORT.trim();
    if (value === 'local' || value === 'ipc') explicitMode = value;
  }

  const mode = explicitMode || (meshId && env.ADHDEV_INLINE_MESH ? 'ipc' : 'local');
  // ★Worker mode WINS over a meshId, and that precedence is a safety property,
  // not a preference. A worker inherits its workspace's config files, so a repo
  // that happens to carry `--repo-mesh` in a committed `.mcp.json` could
  // otherwise hand the worker the full 60-tool coordinator surface — which is
  // the exact inheritance this feature removes. Dropping meshId here makes that
  // unreachable rather than merely unlikely.
  // A worker never takes the coordinator-scope credential: it authenticates
  // with its own session bind, so an auth file it inherited is dropped.
  if (worker) return { mode, port, password, worker: true };
  // --worker > --assistant (checked above): a worker launched with both still
  // gets only the worker toolset. --assistant with an explicit --repo-mesh is
  // contradictory — the assistant drives projects through its own verbs and
  // never holds the coordinator surface — so it is refused rather than
  // silently resolved either way. An env-inherited ADHDEV_MESH_ID is dropped
  // for the same reason worker mode drops it.
  if (assistant) {
    if (meshFromFlag) {
      throw new McpCliArgsError('--assistant cannot be combined with --repo-mesh: the assistant toolset never includes mesh coordinator tools.');
    }
    return { mode, port, password, ...(daemonAuthFile ? { daemonAuthFile } : {}), assistant: true };
  }
  return { mode, port, password, ...(daemonAuthFile ? { daemonAuthFile } : {}), meshId };
}

function printHelp(): void {
  console.error(buildMcpHelpText());
}
