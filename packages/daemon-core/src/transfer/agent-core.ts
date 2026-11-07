/**
 * Source-side core of the agent transfer verbs (owner decision 2026-11-02 section 6): request / status /
 * cancel of the caller's OWN requests. Runs on the machine that holds the files - for a request that
 * came from another daemon, `caller.viaDaemonId` is that daemon (transport-stamped, never payload).
 * An agent can never approve: the request becomes an owner decision, or - only when BOTH machines
 * opted in and nothing would be replaced - the daemons approve it themselves (each against its own setting).
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { findWorkspace } from './workspace-lookup.js';
import { raiseTransferDecision, withdrawTransferDecision } from './agent-decision.js';
import { TERMINAL_STATES, type TransferRecord, type TransferRequester } from './store.js';
import type { ProjectTransferEngine } from './engine.js';

export interface AgentCaller {
  role: 'coordinator' | 'assistant';
  sessionId: string;
  /** Mesh (project) whose owner-decision inbox receives the request. */
  meshId: string;
  /** Set when the request was forwarded by another daemon (the authenticated sender). */
  viaDaemonId?: string;
}

export type R = { success: boolean; [k: string]: unknown };
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export const bad = (code: string, error: string, extra: Record<string, unknown> = {}): R => ({ success: false, code, error, ...extra });

const watched = new WeakSet<ProjectTransferEngine>();

/** One listener per engine: an agent request that ends without the owner closes its pending decision. */
function ensureDecisionWithdrawal(engine: ProjectTransferEngine): void {
  if (watched.has(engine)) return;
  watched.add(engine);
  engine.onTerminal((rec) => {
    if (rec.decision && rec.state !== 'completed') withdrawTransferDecision(rec.decision.meshId, rec.decision.itemId, `transfer_${rec.state}`);
  });
}

/** Requester identity must match on role, session AND the daemon it came through. */
export const isOwn = (rec: TransferRecord, caller: AgentCaller): boolean => {
  const r = rec.requestedBy;
  if (rec.role !== 'source' || !r || r.role !== caller.role || r.sessionId !== caller.sessionId) return false;
  if (!r.viaDaemonId || !caller.viaDaemonId) return !r.viaDaemonId && !caller.viaDaemonId;
  return daemonIdsEquivalent(r.viaDaemonId, caller.viaDaemonId);
};

/** What an agent may see of its own request: state and counts, never the replaced file names. */
export function agentView(rec: TransferRecord): Record<string, unknown> {
  const files = rec.selection.entries.filter((e) => e.kind === 'file').length;
  return {
    transferId: rec.id, state: rec.state, ...(rec.errorCode ? { errorCode: rec.errorCode } : {}),
    files, totalBytes: rec.totalBytes, bytesDone: rec.bytesDone, excluded: rec.selection.excluded.length,
    targetMode: rec.selection.targetMode ?? 'new_folder',
    ...(rec.overwrite ? { newFiles: rec.overwrite.newFiles.length, replacedFiles: rec.overwrite.replaced.length } : {}),
    ...(rec.publishedName ? { publishedName: rec.publishedName } : {}),
    approved: !!rec.localApproval && rec.peerApproved === true,
    ...(rec.path ? { path: rec.path } : {}),
    awaitingOwner: !TERMINAL_STATES.has(rec.state) && !rec.localApproval,
    createdAt: rec.createdAt, previewExpiresAt: rec.previewExpiresAt,
  };
}

/**
 * `allowedSourceWorkspaceIds`: the workspaces of the caller's own mesh on THIS machine. A source
 * workspace outside it (or an unknown one - same answer, no probing) is refused.
 */
export async function requestLocal(engine: ProjectTransferEngine, caller: AgentCaller, a: Record<string, unknown>, allowedSourceWorkspaceIds: ReadonlySet<string> | null): Promise<R> {
  // Shape first: a malformed request gets the same answer whatever the source name is, so it cannot
  // be used to tell an in-scope workspace from an out-of-scope one.
  const toDaemonId = str(a.toDaemonId);
  if (!toDaemonId) return bad('INVALID_TARGET', 'toDaemonId is required');
  const selected = Array.isArray(a.selected) ? a.selected.filter((s): s is string => typeof s === 'string') : [];
  if (!selected.length) return bad('MANIFEST_INVALID', 'selected (paths relative to the source workspace) is required');
  const mode = a.targetMode === 'existing_path' ? 'existing_path' : a.targetMode === undefined || a.targetMode === 'new_folder' ? 'new_folder' : null;
  if (!mode) return bad('INVALID_TARGET_MODE', "targetMode must be 'new_folder' or 'existing_path'");
  if (mode === 'new_folder' && !str(a.finalName)) return bad('INVALID_FINAL_NAME', 'finalName (the new folder name) is required');
  const from = findWorkspace(str(a.fromWorkspace), engine.selfId());
  if (!from || !allowedSourceWorkspaceIds?.has(from.id)) return bad('WORKSPACE_NOT_IN_SCOPE', 'fromWorkspace is not a workspace of this project on that machine (use its workspace id or label)');
  const target = await engine.resolveTargetWorkspace(toDaemonId, str(a.toWorkspace), caller.meshId);
  if (!target) return bad('WORKSPACE_NOT_IN_SCOPE', 'toWorkspace is not a workspace of this project on the target machine (use its workspace id or label)');
  const requestedBy: TransferRequester = { role: caller.role, sessionId: caller.sessionId, ...(caller.viaDaemonId ? { viaDaemonId: caller.viaDaemonId } : {}) };
  ensureDecisionWithdrawal(engine);
  const created = await engine.create({
    workspaceId: from.id, selected, targetDaemonId: toDaemonId, targetWorkspaceId: target.workspaceId,
    finalName: str(a.finalName), targetMode: mode, ...(mode === 'existing_path' ? { targetDir: str(a.targetDir) } : {}), requestedBy,
  });
  if (!created.ok) return bad(created.code, created.code, created.detail ? { detail: created.detail } : {});
  const rec = created.record;
  // Both machines opted in AND nothing is replaced -> the daemons approve it themselves (each against its own setting).
  if (await engine.tryAgentAutoApprove(rec.id, created.peerAllowsAgentAutoApprove === true)) {
    return { success: true, ...agentView(engine.get(rec.id) ?? rec), autoApproved: true };
  }
  const labels = { from: from.label || 'this machine', to: target.label || 'target machine' };
  const decision = raiseTransferDecision(caller.meshId, rec, labels, engine.relayAllowed());
  if ('error' in decision) {
    await engine.cancel(rec.id);
    return bad('DECISION_UNAVAILABLE', decision.error);
  }
  engine.setDecision(rec.id, { meshId: caller.meshId, itemId: decision.itemId });
  return { success: true, ...agentView(engine.get(rec.id) ?? rec), autoApproved: false, decisionItemId: decision.itemId, note: 'Waiting for the owner to approve in the dashboard (To-do). You cannot approve it yourself.' };
}

export function statusLocal(engine: ProjectTransferEngine, caller: AgentCaller, transferId: string): R {
  if (transferId) {
    const rec = engine.get(transferId);
    return rec && isOwn(rec, caller) ? { success: true, ...agentView(rec) } : bad('NOT_FOUND', 'no such request of yours');
  }
  return { success: true, transfers: engine.list().filter((r) => isOwn(r, caller)).map(agentView) };
}

export async function cancelLocal(engine: ProjectTransferEngine, caller: AgentCaller, transferId: string): Promise<R> {
  const rec = engine.get(transferId);
  if (!rec || !isOwn(rec, caller)) return bad('NOT_FOUND', 'no such request of yours');
  const r = await engine.cancel(rec.id);
  return r.ok ? { success: true, transferId: rec.id, state: 'cancelled' } : bad(r.code, r.code);
}
