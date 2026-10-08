/**
 * Per-boot coordinator-scope credential for the MCP servers this standalone
 * daemon launches (contract: daemon-core standalone-mcp-auth.ts).
 *
 * The token is random per boot and lives in memory (StandaloneHttpApi
 * `internalAuthToken`). It is also written, mode 0600, to a file under the
 * daemon's config dir, and the coordinator / assistant MCP launch is told the
 * file's PATH through `ADHDEV_COORDINATOR_MCP_AUTH_FILE` — the same process-env
 * channel that already carries `ADHDEV_COORDINATOR_MCP_PORT`. The launch config
 * therefore never holds a secret, and an MCP server that outlives a daemon
 * restart (session-host restore) picks the next boot's token up from the same
 * path, because it re-reads the file on every request.
 *
 * The file is keyed by port so two standalone daemons sharing a config dir on
 * purpose do not overwrite each other's token.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function standaloneMcpAuthFilePath(configDir: string, port: number): string {
  return path.join(configDir, 'run', `standalone-mcp-auth-${port}`);
}

export function mintStandaloneMcpInternalToken(): string {
  return `adi_${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * Write `token` to `filePath` with owner-only permissions. Written to a
 * sibling temp file first and renamed, so a reader never sees a partial token.
 */
export function writeStandaloneMcpAuthFile(filePath: string, token: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best-effort (e.g. Windows) */ }
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort (e.g. Windows) */ }
  fs.renameSync(tmp, filePath);
}
