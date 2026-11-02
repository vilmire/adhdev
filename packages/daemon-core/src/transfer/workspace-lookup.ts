/** Resolve a workspace the daemon knows by id, label or path (agent transfer requests name workspaces loosely). */
import * as path from 'node:path';
import { loadConfig } from '../config/config.js';
import { expandPath } from '../config/workspaces.js';

export interface WorkspaceMatch { id: string; path: string; label?: string }

export type WorkspaceLookup = (query: string) => WorkspaceMatch | null;

const defaultLookup: WorkspaceLookup = (query) => {
  const q = query.trim();
  if (!q) return null;
  const all = loadConfig().workspaces ?? [];
  const byId = all.find((w) => w.id === q);
  if (byId) return { id: byId.id, path: path.resolve(expandPath(byId.path)), label: byId.label };
  const byLabel = all.filter((w) => w.label === q);
  if (byLabel.length === 1) return { id: byLabel[0]!.id, path: path.resolve(expandPath(byLabel[0]!.path)), label: byLabel[0]!.label };
  const abs = path.resolve(expandPath(q));
  const byPath = all.find((w) => path.resolve(expandPath(w.path)) === abs);
  return byPath ? { id: byPath.id, path: abs, label: byPath.label } : null;
};

let lookup: WorkspaceLookup = defaultLookup;
export function findWorkspace(query: string): WorkspaceMatch | null { return lookup(query); }
export function setWorkspaceLookupForTest(fn: WorkspaceLookup | null): void { lookup = fn ?? defaultLookup; }
