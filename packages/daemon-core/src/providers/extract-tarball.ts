/**
 * Node-native `.tar.gz` extraction — `zlib` gunzip piped into `tar-fs`.
 *
 * Replaces the previous `exec("tar -xzf …")` shell-out. Production Windows
 * daemons were observed failing to spawn the system `tar.exe` even though the
 * binary existed on disk (the daemon process PATH did not include System32,
 * and shell-level PATH fixes did not propagate into the daemon's spawned
 * environment), which aborted every provider channel sync with
 * TRANSPORT_FAILED on fresh installs. Pure-JS extraction removes the
 * external-command dependency entirely; as a side effect it is also not
 * subject to the Windows MAX_PATH limit of the system tar.exe.
 *
 * Note: tar-fs does NOT gunzip — the zlib gunzip stage must stay in the pipe.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import type { Writable } from 'stream';

/**
 * Extract a gzipped tar archive into `destDir` (must already exist).
 * Rejects with a clear error on unreadable/corrupt archives.
 */
export async function extractTarballGz(tarPath: string, destDir: string): Promise<void> {
  // tar-fs ships no type declarations; require() matches the file-local style
  // of the other default I/O helpers and keeps this untyped edge explicit.
  const tarFs = require('tar-fs') as { extract: (dir: string) => Writable };
  await pipeline(fs.createReadStream(tarPath), zlib.createGunzip(), tarFs.extract(destDir));
}
