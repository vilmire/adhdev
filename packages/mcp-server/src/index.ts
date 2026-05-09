/**
 * @adhdev/mcp-server — CLI entry point
 *
 * Usage:
 *   npx @adhdev/mcp-server                        # local mode (localhost:3847)
 *   npx @adhdev/mcp-server --port 4000            # custom port
 *   npx @adhdev/mcp-server --api-key adk_xxx      # cloud mode
 *   npx @adhdev/mcp-server --mode ipc --repo-mesh mesh_xxx  # cloud daemon IPC mode
 */

import { buildMcpHelpText } from './help.js';
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
  console.error(buildMcpHelpText());
}

startMcpServer(parseArgs(process.argv)).catch((err) => {
  process.stderr.write(`[adhdev-mcp] Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
