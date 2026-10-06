/**
 * @adhdev/mcp-server — CLI entry point
 *
 * Usage:
 *   npx @adhdev/mcp-server                        # local mode (localhost:3847)
 *   npx @adhdev/mcp-server --port 4000            # custom port
 *   npx @adhdev/mcp-server --mode ipc --repo-mesh mesh_xxx  # cloud daemon IPC mode
 */

import { McpCliArgsError, parseArgs } from './cli-args.js';
import { startMcpServer } from './server.js';

export { parseArgs } from './cli-args.js';

// A function, not a top-level `let`: a module-scope binding named like a
// common local would make esbuild rename that local across the whole vendored
// bundle (churning committed vendor bytes for nothing).
function parseMcpCliArgsOrExit(): ReturnType<typeof parseArgs> {
  try {
    return parseArgs(process.argv);
  } catch (err: any) {
    if (!(err instanceof McpCliArgsError)) throw err;
    process.stderr.write(`[adhdev-mcp] ${err.message}\n`);
    process.exit(1);
  }
}

startMcpServer(parseMcpCliArgsOrExit()).catch((err) => {
  process.stderr.write(`[adhdev-mcp] Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
