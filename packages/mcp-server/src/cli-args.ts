import { buildMcpHelpText } from './help.js';

/**
 * CLI argument parsing for the MCP server entry point.
 *
 * Split out of index.ts so it can be imported without side effects: index.ts
 * calls startMcpServer() at module load, so a test that imported parseArgs from
 * there would boot a real stdio server.
 */

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): {
  mode: 'local' | 'ipc';
  port?: number;
  password?: string;
  meshId?: string;
  worker?: boolean;
} {
  const args = argv.slice(2);
  let port: number | undefined;
  let password: string | undefined;
  let meshId: string | undefined;
  let explicitMode: 'local' | 'ipc' | undefined;
  // WORKER-MCP: `--worker` selects the minimal delegated-worker toolset.
  // Orthogonal to `--mode`, which is the TRANSPORT axis (local | ipc) — the
  // same distinction that makes "mesh mode" a toolset and not a third transport.
  let worker = false;

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
    } else if ((arg === '--repo-mesh' || arg === '--mesh') && args[i + 1]) {
      meshId = args[++i];
    } else if (arg?.startsWith('--repo-mesh=')) {
      meshId = arg.slice('--repo-mesh='.length);
    } else if (arg === '--worker') {
      worker = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // Also accept env vars
  if (!password && env.ADHDEV_PASSWORD) password = env.ADHDEV_PASSWORD;
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
  if (worker) return { mode, port, password, worker: true };
  return { mode, port, password, meshId };
}

function printHelp(): void {
  console.error(buildMcpHelpText());
}
