/**
 * @adhdev/mcp-server — CLI entry point
 *
 * Usage:
 *   npx @adhdev/mcp-server                        # local mode (localhost:3847)
 *   npx @adhdev/mcp-server --port 4000            # custom port
 *   npx @adhdev/mcp-server --mode ipc --repo-mesh mesh_xxx  # cloud daemon IPC mode
 */

import { parseArgs } from './cli-args.js';
import { startMcpServer } from './server.js';

export { parseArgs } from './cli-args.js';

startMcpServer(parseArgs(process.argv)).catch((err) => {
  process.stderr.write(`[adhdev-mcp] Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
