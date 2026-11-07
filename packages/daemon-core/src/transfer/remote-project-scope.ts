/**
 * Transfer scope of a REMOTE-PROJECT mesh on a member daemon. A member keeps no mesh record, only a
 * host record and the managed checkouts under `<configDir>/remote-projects/<key>`. A checkout belongs
 * to a mesh only if key == hash(meshId, identity of its origin) - re-derived, never trusted by name.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import { githubRemote } from '../assistant/remote-project-checkout.js';
import { remoteProjectKey } from '../assistant/remote-project-key.js';
import { listMeshHostRecords, readMeshHostRecord } from '../mesh/mesh-host-memory.js';
import type { WorkspaceMatch } from './workspace-lookup.js';

export const REMOTE_PROJECT_WORKSPACE_PREFIX = 'remote-project:';
export const REMOTE_PROJECT_KEY_RE = /^[0-9a-f]{24}$/;

function originUrl(dir: string): string | null {
  try {
    const out = execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch { return null; }
}

/** Remote-project checkouts of `meshId` on this daemon. Empty when not a remote project of that host. */
export function remoteProjectScopeFor(meshId: string, viaDaemonId?: string | null): WorkspaceMatch[] {
  const record = meshId ? readMeshHostRecord(meshId) : null;
  if (!record) return [];
  if (viaDaemonId && !daemonIdsEquivalent(viaDaemonId, record.hostDaemonId)) return [];
  let root: string;
  try {
    const st = fs.lstatSync(path.join(getConfigDir(), 'remote-projects'));
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    root = path.join(fs.realpathSync(getConfigDir()), 'remote-projects');
  } catch { return []; }
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out: WorkspaceMatch[] = [];
  for (const key of names) {
    if (!REMOTE_PROJECT_KEY_RE.test(key)) continue; // skips *.lock / *.pending
    const dir = path.join(root, key);
    try { const st = fs.lstatSync(dir); if (st.isSymbolicLink() || !st.isDirectory()) continue; } catch { continue; }
    const url = originUrl(dir);
    const identity = url ? githubRemote(url)?.identity : undefined;
    if (!identity || remoteProjectKey(meshId, identity) !== key) continue;
    // The identity is lowercased for the key; the label keeps the repository name as the origin spells it
    // ("Prefex", not "prefex"), because callers name the target by that label.
    const repoName = /\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url!)?.[1] ?? identity.split('/').pop();
    out.push({ id: REMOTE_PROJECT_WORKSPACE_PREFIX + key, path: dir, label: repoName });
  }
  return out;
}

/** Local-caller lookup of a `remote-project:<key>` id across every host-recorded mesh. */
export function resolveRemoteProjectWorkspaceById(id: string): WorkspaceMatch | null {
  if (!id.startsWith(REMOTE_PROJECT_WORKSPACE_PREFIX)) return null;
  if (!REMOTE_PROJECT_KEY_RE.test(id.slice(REMOTE_PROJECT_WORKSPACE_PREFIX.length))) return null;
  for (const r of listMeshHostRecords()) {
    const hit = remoteProjectScopeFor(r.meshId, null).find((w) => w.id === id);
    if (hit) return hit;
  }
  return null;
}
