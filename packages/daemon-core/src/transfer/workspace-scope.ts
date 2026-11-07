/**
 * Which registered workspaces may an AGENT move files out of / into? Only the workspaces of the
 * nodes of the agent's own mesh on that machine - never any workspace that merely happens to be
 * registered there. Used by agent transfer requests (source side) and by the `resolve_workspace`
 * peer op (target side). Fail closed: a mesh this daemon does not know has an empty scope.
 */
import * as path from 'node:path';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { expandPath } from '../config/workspaces.js';
import { readMeshNodeDaemonId } from '../mesh/mesh-node-identity.js';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { remoteProjectScopeFor } from './remote-project-scope.js';
import type { WorkspaceMatch } from './workspace-lookup.js';

export interface MeshScope { workspaces: WorkspaceMatch[] }

/**
 * `machineDaemonId`: the machine whose workspaces are wanted. `viaDaemonId`: a remote asker that must
 * itself be on the mesh roster (null for a local caller). Returns null for an unknown mesh or an asker off the roster.
 */
export type MeshScopeResolver = (meshId: string, machineDaemonId: string, viaDaemonId?: string | null) => MeshScope | null;

export const MESH_NODE_WORKSPACE_PREFIX = 'mesh-node:';
export function meshNodeWorkspaceId(meshId: string, nodeId: string): string { return `${MESH_NODE_WORKSPACE_PREFIX}${meshId}:${nodeId}`; }

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? v as Record<string, unknown> : null);

/** Scope of one mesh record on one machine: its nodes there, matched to registered workspaces by path. */
export function meshScopeFromEntry(mesh: unknown, machineDaemonId: string, viaDaemonId?: string | null): MeshScope | null {
  const m = rec(mesh);
  const nodes = Array.isArray(m?.nodes) ? (m!.nodes as unknown[]).map(rec).filter((n): n is Record<string, unknown> => !!n) : [];
  if (!nodes.length) return null;
  if (viaDaemonId) {
    let onRoster = nodes.some((n) => { const d = readMeshNodeDaemonId(n); return !!d && daemonIdsEquivalent(d, viaDaemonId); });
    if (!onRoster) {
      try {
        const st = resolveMeshHostStatus(m as never, { localDaemonId: machineDaemonId });
        onRoster = !st.hostSynthesized && !!st.hostDaemonId && daemonIdsEquivalent(st.hostDaemonId, viaDaemonId);
      } catch { onRoster = false; }
    }
    if (!onRoster) return null;
  }
  // A node with no daemonId is the mesh host's own node (standalone-created meshes never stamp one).
  // That is only provably THIS machine for a local caller on the daemon that hosts the mesh; for a
  // peer-served request, or on a member daemon, it could be any machine, so it is skipped.
  let anonymousNodesAreOurs: boolean | null = null;
  const anonymousOurs = (): boolean => {
    if (anonymousNodesAreOurs !== null) return anonymousNodesAreOurs;
    anonymousNodesAreOurs = false;
    if (viaDaemonId) return false;
    try {
      const st = resolveMeshHostStatus(m as never, { localDaemonId: machineDaemonId });
      anonymousNodesAreOurs = st.role === 'host' && !!st.hostDaemonId && daemonIdsEquivalent(st.hostDaemonId, machineDaemonId);
    } catch { anonymousNodesAreOurs = false; }
    return anonymousNodesAreOurs;
  };
  const nodeFolders = new Map<string, Record<string, unknown>>();
  for (const n of nodes) {
    const d = readMeshNodeDaemonId(n);
    if (d ? !daemonIdsEquivalent(d, machineDaemonId) : !anonymousOurs()) continue;
    if (typeof n.workspace === 'string' && n.workspace.trim()) {
      const p = path.resolve(expandPath(n.workspace));
      if (!nodeFolders.has(p)) nodeFolders.set(p, n);
    }
  }
  const out: WorkspaceMatch[] = [];
  const matched = new Set<string>();
  for (const w of loadConfig().workspaces ?? []) {
    const p = path.resolve(expandPath(w.path));
    if (nodeFolders.has(p)) { out.push({ id: w.id, path: p, label: w.label }); matched.add(p); }
  }
  // Node folders that are not registered workspaces (e.g. daemon-managed remote-project checkouts) get a
  // stable synthetic id so they can still be a transfer source/target.
  const meshId = typeof m?.id === 'string' ? m.id : '';
  if (meshId) {
    for (const [p, n] of nodeFolders) {
      if (matched.has(p) || typeof n.id !== 'string' || !n.id) continue;
      const label = [n.label, n.name].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? path.basename(p);
      out.push({ id: meshNodeWorkspaceId(meshId, n.id), path: p, label });
    }
  }
  return { workspaces: out };
}

const defaultResolver: MeshScopeResolver = (meshId, machine, via) => {
  if (!meshId) return null;
  let mesh: unknown;
  try { mesh = getMesh(meshId); } catch { return null; }
  if (mesh) return meshScopeFromEntry(mesh, machine, via);
  // A member that attached the host's project as a remote project has no mesh record, only a host
  // record plus the managed checkouts; the host (or a local caller) may use exactly those.
  const remote = remoteProjectScopeFor(meshId, via);
  return remote.length ? { workspaces: remote } : null;
};

let resolver: MeshScopeResolver = defaultResolver;
export function resolveMeshScope(meshId: string, machineDaemonId: string, viaDaemonId?: string | null): MeshScope | null { return resolver(meshId, machineDaemonId, viaDaemonId); }
export function setMeshScopeResolverForTest(fn: MeshScopeResolver | null): void { resolver = fn ?? defaultResolver; }

/** Exact id or exact label only (never a path) among the scope's workspaces. */
export function matchScopedWorkspace(scope: MeshScope, query: string): WorkspaceMatch | null {
  const q = query.trim();
  if (!q) return null;
  const byId = scope.workspaces.find((w) => w.id === q);
  if (byId) return byId;
  const byLabel = scope.workspaces.filter((w) => w.label === q);
  return byLabel.length === 1 ? byLabel[0]! : null;
}
