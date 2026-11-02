/**
 * Agent-facing transfer verbs (owner decision 2026-11-02 section 6): a coordinator or the assistant
 * can REQUEST a transfer, read the status of its own requests and cancel them. It can never approve.
 * The files may live on THIS machine or on another machine of the mesh (`fromDaemonId`): then the
 * request is forwarded over the authenticated mesh channel to the source daemon, which creates the
 * transfer and raises the owner decision itself (agent-peer.ts).
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getProjectTransferEngine } from './runtime.js';
import { bad, cancelLocal, requestLocal, statusLocal, str, type AgentCaller, type R } from './agent-core.js';
import type { ProjectTransferEngine } from './engine.js';

export type { AgentCaller } from './agent-core.js';
export { agentView } from './agent-core.js';

/** What the caller may export from THIS machine (workspace ids of its own mesh here). null = nothing. */
export interface AgentScope { sourceWorkspaceIds: ReadonlySet<string> | null }

const REQUEST_FIELDS = ['fromWorkspace', 'selected', 'toDaemonId', 'toWorkspace', 'targetMode', 'finalName', 'targetDir'] as const;
const VIEW_KEYS = ['transferId', 'state', 'errorCode', 'files', 'totalBytes', 'bytesDone', 'excluded', 'targetMode', 'newFiles', 'replacedFiles', 'publishedName', 'approved', 'path', 'awaitingOwner', 'createdAt', 'previewExpiresAt', 'autoApproved', 'decisionItemId', 'note'] as const;

/** Remote replies are re-projected to the known scalar view fields: nothing else reaches the agent. */
function cleanView(v: unknown): Record<string, unknown> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of VIEW_KEYS) {
    const x = o[k];
    if (typeof x === 'string') out[k] = x.slice(0, 300);
    else if (typeof x === 'number' || typeof x === 'boolean') out[k] = x;
  }
  return out;
}

/** transferId -> source machine, for requests this daemon forwarded (so status/cancel route without repeating it). */
const forwarded = new Map<string, string>();
const fwdKey = (c: AgentCaller, id: string): string => `${c.role}:${c.sessionId}:${id}`;

async function viaPeer(engine: ProjectTransferEngine, peer: string, op: 'agent_request' | 'agent_status' | 'agent_cancel', caller: AgentCaller, args: Record<string, unknown>): Promise<R> {
  const reply = await engine.forwardAgentOp(peer, op, { role: caller.role, sessionId: caller.sessionId, meshId: caller.meshId }, args);
  if (!reply.ok) return bad(String(reply.code ?? 'PEER_REFUSED'), String(reply.error ?? reply.code ?? 'PEER_REFUSED'));
  if (Array.isArray(reply.transfers)) return { success: true, transfers: reply.transfers.slice(0, 100).map(cleanView), machine: peer };
  const view = cleanView(reply);
  if (op === 'agent_request' && typeof view.transferId === 'string') {
    forwarded.set(fwdKey(caller, view.transferId), peer);
    if (forwarded.size > 500) forwarded.delete(forwarded.keys().next().value as string);
  }
  return { success: true, ...view, sourceMachine: peer };
}

export async function runAgentTransfer(caller: AgentCaller, args: Record<string, unknown>, scope: AgentScope): Promise<R> {
  const engine = getProjectTransferEngine();
  if (!engine) return bad('TRANSFER_UNAVAILABLE', 'This daemon cannot transfer project files');
  const action = str(args.action) || 'status';
  if (action !== 'request' && action !== 'status' && action !== 'cancel') return bad('INVALID_ARGS', "action must be 'request', 'status' or 'cancel'");
  const id = str(args.transferId);
  let peer = str(args.fromDaemonId) || (id ? forwarded.get(fwdKey(caller, id)) ?? '' : '');
  if (peer && daemonIdsEquivalent(peer, engine.selfId())) peer = '';
  if (peer) {
    if (action === 'request') {
      const request: Record<string, unknown> = {};
      for (const k of REQUEST_FIELDS) if (args[k] !== undefined) request[k] = args[k];
      return viaPeer(engine, peer, 'agent_request', caller, { request });
    }
    if (action === 'cancel' && !id) return bad('NOT_FOUND', 'no such request of yours');
    return viaPeer(engine, peer, action === 'status' ? 'agent_status' : 'agent_cancel', caller, { transferId: id });
  }
  if (action === 'request') return requestLocal(engine, caller, args, scope.sourceWorkspaceIds);
  if (action === 'status') return statusLocal(engine, caller, id);
  return cancelLocal(engine, caller, id);
}
