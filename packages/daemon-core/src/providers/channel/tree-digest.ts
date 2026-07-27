/**
 * TypeScript port of the canonical provider-tree digest
 * `adhdev-provider-tree-sha256-v1`.
 *
 * Reference implementation: adhdev-providers/scripts/lib/provider-channels.mjs
 * (`computeProviderTreeDigest`), specified in
 * adhdev-providers/docs/provider-channels.md. The digest is NOT a tarball
 * hash — it is computed over the provider's git-tracked file tree:
 *
 *   input = for each file, sorted by repo-root-relative POSIX path
 *           (JS default sort — UTF-16 code-unit order):
 *             relative path (UTF-8) + NUL
 *             decimal byte length of content (ASCII) + NUL
 *             raw file content bytes
 *   bundleDigest = 'sha256:' + lowercase hex sha256(input)
 *
 * The runtime cannot run `git ls-files` inside a downloaded tarball, so this
 * port reconstructs the same input from a staged extraction: the staging
 * layout MUST mirror the repo-root-relative tree (e.g. `cli/claude-cli/...`)
 * and contain exactly the tracked files. Any extra or missing file changes
 * the digest and fails closed, which is exactly the verification property we
 * need — transport byte determinism is irrelevant.
 *
 * Fail-closed rules (matching the reference):
 * - empty tree → error
 * - any non-regular entry (symlink, socket, ...) → error
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ProviderChannelError } from './contract.js';

export const TREE_DIGEST_ALGORITHM = 'adhdev-provider-tree-sha256-v1';

/**
 * Compute `adhdev-provider-tree-sha256-v1` over the regular files rooted at
 * `rootDir`. Relative paths are emitted POSIX-style ('/' separators) so the
 * digest is platform-independent.
 *
 * @throws ProviderChannelError code 'ENTRY_TREE_INVALID' on empty trees or
 *         non-regular entries.
 */
export function computeProviderTreeDigest(rootDir: string, providerType?: string): string {
  const relPaths: string[] = [];
  collectRegularFiles(rootDir, rootDir, relPaths, providerType);

  if (relPaths.length === 0) {
    throw new ProviderChannelError(
      'ENTRY_TREE_INVALID',
      `provider tree at ${rootDir} is empty — cannot compute ${TREE_DIGEST_ALGORITHM}`,
      providerType,
    );
  }

  // JS default sort: UTF-16 code-unit order — identical to the reference
  // implementation's `paths.sort()`.
  relPaths.sort();

  const hash = createHash('sha256');
  for (const relPath of relPaths) {
    const absPath = path.join(rootDir, ...relPath.split('/'));
    const bytes = fs.readFileSync(absPath);
    hash.update(relPath, 'utf8');
    hash.update('\0');
    hash.update(String(bytes.length), 'utf8');
    hash.update('\0');
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function collectRegularFiles(
  rootDir: string,
  dir: string,
  out: string[],
  providerType?: string,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e: any) {
    throw new ProviderChannelError(
      'ENTRY_TREE_INVALID',
      `cannot read provider tree dir ${dir}: ${e?.message || e}`,
      providerType,
    );
  }

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRegularFiles(rootDir, abs, out, providerType);
      continue;
    }
    if (!entry.isFile()) {
      // Symlinks and other non-regular entries make the local tree diverge
      // from the git-tracked set the digest was computed over — fail closed.
      throw new ProviderChannelError(
        'ENTRY_TREE_INVALID',
        `non-regular entry in provider tree: ${abs} — refusing to verify`,
        providerType,
      );
    }
    const rel = path.relative(rootDir, abs).split(path.sep).join('/');
    out.push(rel);
  }
}
