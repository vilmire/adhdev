/**
 * One resolver for "workspace id -> folder on THIS machine" shared by every transfer entry point:
 * a registered workspace id as before, or a synthetic `mesh-node:<meshId>:<nodeId>` id naming an
 * unregistered node folder (daemon-managed remote-project checkout) of a mesh this machine belongs to.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { expandPath } from '../config/workspaces.js';
import { MESH_NODE_WORKSPACE_PREFIX, meshScopeFromEntry } from './workspace-scope.js';
import type { WorkspaceMatch } from './workspace-lookup.js';

function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

export function resolveMeshNodeWorkspaceById(id: string, selfDaemonId: string): WorkspaceMatch | null {
  if (!id.startsWith(MESH_NODE_WORKSPACE_PREFIX) || !selfDaemonId) return null;
  const rest = id.slice(MESH_NODE_WORKSPACE_PREFIX.length);
  // Mesh/node ids may contain ':' themselves: try every split.
  for (let i = rest.indexOf(':'); i > 0; i = rest.indexOf(':', i + 1)) {
    let mesh: unknown;
    try { mesh = getMesh(rest.slice(0, i)); } catch { continue; }
    if (!mesh) continue;
    const hit = meshScopeFromEntry(mesh, selfDaemonId)?.workspaces.find((w) => w.id === id);
    return hit && isDir(hit.path) ? hit : null;
  }
  return null;
}

export function resolveTransferWorkspaceById(id: string, selfDaemonId: string): WorkspaceMatch | null {
  const q = id.trim();
  if (!q) return null;
  const w = (loadConfig().workspaces ?? []).find((x) => x.id === q);
  if (w) return { id: w.id, path: path.resolve(expandPath(w.path)), label: w.label };
  return resolveMeshNodeWorkspaceById(q, selfDaemonId);
}
