/**
 * @adhdev/mcp-server — CLI entry point
 *
 * Usage:
 *   npx @adhdev/mcp-server                        # local mode (localhost:3847)
 *   npx @adhdev/mcp-server --port 4000            # custom port
 *   npx @adhdev/mcp-server --api-key adk_xxx      # cloud mode
 */

import { startMcpServer } from './server.js';

function parseArgs(argv: string[]): {
  mode: 'local' | 'cloud';
  port?: number;
  password?: string;
  apiKey?: string;
  baseUrl?: string;
} {
  const args = argv.slice(2);
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let port: number | undefined;
  let password: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--api-key' || arg === '-k') && args[i + 1]) {
      apiKey = args[++i];
    } else if (arg?.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
    } else if (arg === '--base-url' && args[i + 1]) {
      baseUrl = args[++i];
    } else if (arg === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (arg?.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--password' && args[i + 1]) {
      password = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // Also accept env vars
  if (!apiKey && process.env.ADHDEV_API_KEY) apiKey = process.env.ADHDEV_API_KEY;
  if (!password && process.env.ADHDEV_PASSWORD) password = process.env.ADHDEV_PASSWORD;

  const mode = apiKey ? 'cloud' : 'local';
  return { mode, port, password, apiKey, baseUrl };
}

function printHelp(): void {
  console.error(`
adhdev-mcp — ADHDev MCP Server

Usage:
  adhdev-mcp                         Local mode (requires standalone daemon)
  adhdev-mcp --api-key <key>         Cloud mode (ADHDev cloud API)

Options:
  --port <n>          Standalone daemon port (default: 3847)
  --password <pass>   Standalone daemon password (if set)
  --api-key <key>     ADHDev cloud API key (switches to cloud mode)
  --base-url <url>    Override cloud API base URL
  --help              Show this help

Environment variables:
  ADHDEV_API_KEY      API key (cloud mode)
  ADHDEV_PASSWORD     Daemon password (local mode)

Local mode tools:   list_sessions, launch_session, check_pending, read_chat, send_chat, approve, git_status, screenshot
Cloud mode tools:   list_sessions, launch_session, check_pending, read_chat, send_chat, approve, git_status
`.trim());
}

startMcpServer(parseArgs(process.argv)).catch((err) => {
  process.stderr.write(`[adhdev-mcp] Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
