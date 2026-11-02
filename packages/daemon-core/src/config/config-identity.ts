/**
 * Opaque identity of a config directory ("whose meshes.json is this?").
 *
 * A daemon and an MCP server on the same machine may resolve DIFFERENT config
 * dirs (ADHDEV_CONFIG_DIR in one shell but not in the daemon's, a preview
 * wrapper pinning another track's dir). Mesh topology writes always run in the
 * daemon, but everything the MCP reads in-process (meshes.json lookup, machine
 * id) follows ITS dir — so a coordinator pointed at a daemon of another config
 * dir silently splits topology across two stores. Both sides compute this
 * digest of the realpath'd dir; the daemon reports it, the MCP compares. A
 * digest, not the path: the value crosses the mesh relay and must not leak the
 * filesystem layout.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { getConfigDir } from './config.js';

export function configDirIdentity(dir?: string): string {
    const raw = dir ?? getConfigDir();
    let resolved = raw;
    try { resolved = realpathSync(raw); } catch { /* not created yet: compare the literal path */ }
    return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}
