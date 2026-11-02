/**
 * Source side of a REMOTE agent transfer request: a coordinator or assistant on another daemon asks THIS
 * machine (which holds the files) for a transfer. The peer can only obtain a transfer record plus an
 * owner decision, never an approval. The sender is the transport-stamped authenticated peer id (the
 * caller's `viaDaemonId`); the payload is a claim that is re-validated here: same-account peer, on the
 * roster of the named mesh, source workspace inside that mesh's scope, secret exclusion by the engine.
 */
import { SAFE_ID } from './agent-ids.js';
import { cancelLocal, requestLocal, statusLocal, str, type AgentCaller, type R } from './agent-core.js';
import { resolveMeshScope } from './workspace-scope.js';
import type { ProjectTransferEngine } from './engine.js';

export const AGENT_PEER_OPS: ReadonlySet<string> = new Set(['agent_request', 'agent_status', 'agent_cancel']);

/** Fields a remote requester may set. Anything else in the payload is ignored. */
const REQUEST_FIELDS = ['fromWorkspace', 'selected', 'toDaemonId', 'toWorkspace', 'targetMode', 'finalName', 'targetDir'] as const;

function reply(r: R): { ok: boolean; code?: string; [k: string]: unknown } {
  const { success, ...rest } = r;
  return { ok: success === true, ...rest };
}

export async function handleAgentPeerOp(engine: ProjectTransferEngine, sender: string, op: string, args: Record<string, any>): Promise<{ ok: boolean; code?: string; [k: string]: unknown }> {
  if (!sender || !engine.isPeerAllowed(sender)) return { ok: false, code: 'PEER_UNAUTHORIZED' };
  const c = args?.caller as { role?: unknown; sessionId?: unknown; meshId?: unknown } | null;
  const role = c?.role;
  const sessionId = typeof c?.sessionId === 'string' ? c.sessionId : '';
  const meshId = typeof c?.meshId === 'string' ? c.meshId : '';
  if ((role !== 'coordinator' && role !== 'assistant') || !SAFE_ID.test(sessionId) || !SAFE_ID.test(meshId)) return { ok: false, code: 'PROTOCOL_ERROR' };
  const caller: AgentCaller = { role, sessionId, meshId, viaDaemonId: sender };
  if (op === 'agent_status') return reply(statusLocal(engine, caller, str(args.transferId)));
  if (op === 'agent_cancel') return reply(await cancelLocal(engine, caller, str(args.transferId)));
  // agent_request: the sender must be on this mesh's roster here; the source is limited to this mesh's workspaces on this machine.
  const scope = resolveMeshScope(meshId, engine.selfId(), sender);
  if (!scope) return { ok: false, code: 'WORKSPACE_NOT_IN_SCOPE', error: 'this machine does not know that project for you' };
  const pick: Record<string, unknown> = {};
  const given = (args?.request ?? {}) as Record<string, unknown>;
  for (const k of REQUEST_FIELDS) if (given[k] !== undefined) pick[k] = given[k];
  return reply(await requestLocal(engine, caller, pick, new Set(scope.workspaces.map((w) => w.id))));
}
