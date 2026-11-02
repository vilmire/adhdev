/**
 * Agent-facing transfer verbs (owner decision 2026-11-02 section 6): a coordinator or the assistant
 * can REQUEST a transfer, read the status of its own requests and cancel them. It can never approve:
 * the request becomes an owner decision, or - only when BOTH machines opted in and nothing would be
 * replaced - the daemons approve it themselves (each against its own setting).
 */
import { findWorkspace } from './workspace-lookup.js';
import { getProjectTransferEngine } from './runtime.js';
import { raiseTransferDecision, withdrawTransferDecision } from './agent-decision.js';
import { TERMINAL_STATES, type TransferRecord, type TransferRequester } from './store.js';
import type { ProjectTransferEngine } from './engine.js';

export interface AgentCaller {
  role: 'coordinator' | 'assistant';
  sessionId: string;
  /** Mesh (project) whose owner-decision inbox receives the request. */
  meshId: string;
}

type R = { success: boolean; [k: string]: unknown };
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bad = (code: string, error: string, extra: Record<string, unknown> = {}): R => ({ success: false, code, error, ...extra });

const watched = new WeakSet<ProjectTransferEngine>();

/** One listener per engine: an agent request that ends without the owner closes its pending decision. */
function ensureDecisionWithdrawal(engine: ProjectTransferEngine): void {
  if (watched.has(engine)) return;
  watched.add(engine);
  engine.onTerminal((rec) => {
    if (rec.decision && rec.state !== 'completed') withdrawTransferDecision(rec.decision.meshId, rec.decision.itemId, `transfer_${rec.state}`);
  });
}

const isOwn = (rec: TransferRecord, caller: AgentCaller): boolean =>
  rec.role === 'source' && rec.requestedBy?.role === caller.role && rec.requestedBy.sessionId === caller.sessionId;

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

async function request(engine: ProjectTransferEngine, caller: AgentCaller, a: Record<string, unknown>): Promise<R> {
  const from = findWorkspace(str(a.fromWorkspace));
  if (!from) return bad('WORKSPACE_NOT_REGISTERED', 'fromWorkspace is not a workspace registered on this machine (id, label or path)');
  const toDaemonId = str(a.toDaemonId);
  if (!toDaemonId) return bad('INVALID_TARGET', 'toDaemonId is required');
  const selected = Array.isArray(a.selected) ? a.selected.filter((s): s is string => typeof s === 'string') : [];
  if (!selected.length) return bad('MANIFEST_INVALID', 'selected (paths relative to the source workspace) is required');
  const target = await engine.resolveTargetWorkspace(toDaemonId, str(a.toWorkspace));
  if (!target) return bad('TARGET_WORKSPACE_UNKNOWN', 'the target machine did not recognise toWorkspace (use its workspace id, label or path)');
  const mode = a.targetMode === 'existing_path' ? 'existing_path' : a.targetMode === undefined || a.targetMode === 'new_folder' ? 'new_folder' : null;
  if (!mode) return bad('INVALID_TARGET_MODE', "targetMode must be 'new_folder' or 'existing_path'");
  if (mode === 'new_folder' && !str(a.finalName)) return bad('INVALID_FINAL_NAME', 'finalName (the new folder name) is required');
  const requestedBy: TransferRequester = { role: caller.role, sessionId: caller.sessionId };
  ensureDecisionWithdrawal(engine);
  const created = await engine.create({
    workspaceId: from.id, selected, targetDaemonId: toDaemonId, targetWorkspaceId: target.workspaceId,
    finalName: str(a.finalName), targetMode: mode, ...(mode === 'existing_path' ? { targetDir: str(a.targetDir) } : {}), requestedBy,
  });
  if (!created.ok) return bad(created.code, created.code, created.detail ? { detail: created.detail } : {});
  const rec = created.record;
  // A: both machines opted in AND nothing is replaced -> the daemons approve it themselves.
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

export async function runAgentTransfer(caller: AgentCaller, args: Record<string, unknown>): Promise<R> {
  const engine = getProjectTransferEngine();
  if (!engine) return bad('TRANSFER_UNAVAILABLE', 'This daemon cannot transfer project files');
  const action = str(args.action) || 'status';
  if (action === 'request') return request(engine, caller, args);
  if (action === 'status') {
    const id = str(args.transferId);
    if (id) {
      const rec = engine.get(id);
      return rec && isOwn(rec, caller) ? { success: true, ...agentView(rec) } : bad('NOT_FOUND', 'no such request of yours');
    }
    return { success: true, transfers: engine.list().filter((r) => isOwn(r, caller)).map(agentView) };
  }
  if (action === 'cancel') {
    const rec = engine.get(str(args.transferId));
    if (!rec || !isOwn(rec, caller)) return bad('NOT_FOUND', 'no such request of yours');
    const r = await engine.cancel(rec.id);
    return r.ok ? { success: true, transferId: rec.id, state: 'cancelled' } : bad(r.code, r.code);
  }
  return bad('INVALID_ARGS', "action must be 'request', 'status' or 'cancel'");
}
