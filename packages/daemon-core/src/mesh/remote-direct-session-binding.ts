/**
 * Owner-daemon binding of a SESSIONLESS remote direct dispatch to the session that took it.
 *
 * A `mesh_send_task` with no session id lets the worker daemon pick the session; its
 * `agent_command` answer names it (`sessionId`). The owner (the coordinator's daemon)
 * must record that id on the `mesh_direct` attempt (delivered evidence) and on the task
 * row, otherwise the worker's forwarded report is refused as `no_live_task`.
 *
 * The coordinator's MCP server (a long-lived child of the coordinator CLI) may be running
 * OLD code that never adopts the answered session. So the owner daemon does it itself,
 * on the relay path the answer travels through, before the MCP server sees it:
 *
 *   - `bindSessionlessDirectSendAnswer` — right after the relayed `agent_command` answer
 *     comes back: bind the attempt (delivered evidence under the SAME event id the MCP
 *     side uses, so whichever writes second is a ledger duplicate) and, if the row is
 *     already there, its assignedSessionId.
 *   - `resolveBoundDirectSession` — when the MCP later writes the task row
 *     (`direct_dispatch_record`) without a session, read the session the attempt was
 *     bound to.
 *
 * Authority is unchanged: only an OPEN `mesh_direct` attempt THIS daemon owns, for the
 * very task/attempt/node named in the dispatch, still unbound (session = the task-id
 * stand-in), and only from the daemon that owns that node, is ever bound. A named
 * session is never re-pointed and reports are still matched against the owner's records.
 */
import { daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getActiveTurnLedger } from './turn-ledger/active-ledger.js';
import type { TurnLedger } from './turn-ledger/ledger.js';
import type { TurnAttempt } from './turn-ledger/types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export interface SessionlessDirectSendRelay {
    /** The relayed verb (only `agent_command` is considered). */
    command: string;
    /** The relayed args exactly as the MCP server sent them. */
    args: Record<string, unknown> | undefined;
    /** The daemon the verb was relayed to. */
    targetDaemonId: string;
    /** The relay's answer (flat or nested `result` wrappers). */
    result: unknown;
}

export interface SessionlessDirectBindDeps {
    ledger?: TurnLedger | null;
    /** The daemon that owns a node on the owner's roster. */
    nodeDaemonId?: (meshId: string, nodeId: string) => string | undefined;
    now?: () => number;
}

export type SessionlessDirectBindOutcome =
    | { bound: true; sessionId: string }
    | { bound: false; reason: string };

/** The `sessionId` a successful relay answer names, looking through bounded `result` wrappers. */
function answeredSession(result: unknown): string {
    let current: unknown = result;
    for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
        const rec = current as Record<string, unknown>;
        if (rec.success === false) return '';
        const id = trim(rec.sessionId);
        if (id) return id;
        current = rec.result;
    }
    return '';
}

function defaultNodeDaemonId(meshId: string, nodeId: string): string | undefined {
    const node = getMesh(meshId)?.nodes?.find((n: { id?: string }) => n.id === nodeId);
    return typeof node?.daemonId === 'string' ? node.daemonId : undefined;
}

/** The OPEN `mesh_direct` attempt this daemon owns for this dispatch, or a refusal reason. */
function ownedOpenDirectAttempt(
    ledger: TurnLedger,
    meshId: string,
    taskId: string,
    attemptId: string,
): TurnAttempt | string {
    const attempt = ledger.getAttempt(attemptId);
    if (!attempt) return 'attempt_unknown';
    if (attempt.scope !== 'mesh_direct') return 'not_mesh_direct';
    if (attempt.meshId !== meshId || attempt.taskId !== taskId) return 'attempt_mismatch';
    if (!daemonIdsEquivalent(attempt.ownerDaemonId, ledger.selfDaemonId)) return 'not_owner';
    if (attempt.terminal) return 'attempt_terminal';
    return attempt;
}

export function bindSessionlessDirectSendAnswer(
    relay: SessionlessDirectSendRelay,
    deps: SessionlessDirectBindDeps = {},
): SessionlessDirectBindOutcome {
    const no = (reason: string): SessionlessDirectBindOutcome => ({ bound: false, reason });
    try {
        const args = relay.args;
        if (relay.command !== 'agent_command' || !args || typeof args !== 'object') return no('not_agent_command');
        if (args.action !== 'send_chat') return no('not_send_chat');
        // An explicit session always wins: the answer never re-points a named session.
        if (trim(args.targetSessionId) || trim(args.sessionId) || trim(args.session_id)) return no('session_named');
        const mc = args.meshContext && typeof args.meshContext === 'object' ? args.meshContext as Record<string, unknown> : null;
        const meshId = trim(mc?.meshId);
        const taskId = trim(mc?.taskId);
        const attemptId = trim(mc?.attemptId);
        if (!meshId || !taskId || !attemptId) return no('no_dispatch_context');
        const messageId = trim(args.messageId);
        if (messageId && messageId !== taskId) return no('message_task_mismatch');
        const sessionId = answeredSession(relay.result);
        if (!sessionId) return no('no_answered_session');

        const ledger = deps.ledger === undefined ? getActiveTurnLedger() : deps.ledger;
        if (!ledger) return no('no_ledger');
        const found = ownedOpenDirectAttempt(ledger, meshId, taskId, attemptId);
        if (typeof found === 'string') return no(found);
        const attempt = found;
        const generation = mc?.attemptGeneration;
        if (typeof generation === 'number' && generation !== attempt.generation) return no('generation_mismatch');
        const nodeId = trim(mc?.nodeId);
        // eslint-disable-next-line no-restricted-syntax -- node ids are roster keys, not daemon ids.
        if (nodeId && attempt.nodeId && nodeId !== attempt.nodeId) return no('node_mismatch');
        // Only the daemon that owns the dispatched node may name its session.
        const rosterNode = attempt.nodeId || nodeId;
        const ownerOfNode = rosterNode ? (deps.nodeDaemonId ?? defaultNodeDaemonId)(meshId, rosterNode) : undefined;
        if (!ownerOfNode || !daemonIdsEquivalent(ownerOfNode, relay.targetDaemonId)) return no('target_not_node_owner');
        // Unbound = still on the task-id stand-in. Already on this session = idempotent.
        const alreadyBound = sessionIdsEquivalent(attempt.sessionId, sessionId);
        if (!alreadyBound && !sessionIdsEquivalent(attempt.sessionId, taskId)) return no('attempt_bound_to_other_session');

        if (!alreadyBound) {
            const verdict = ledger.observe({
                // Same event id as the MCP side's delivered evidence: whichever lands second is a duplicate.
                eventId: `${taskId}:delivered`,
                at: (deps.now ?? Date.now)(),
                source: 'dispatch',
                sessionId,
                attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
                observedBy: ledger.selfDaemonId,
                kind: 'delivered',
                messageId: taskId,
                outcome: 'delivered',
                via: 'p2p',
            }).verdict;
            if (verdict !== 'applied' && verdict !== 'recorded' && verdict !== 'duplicate') return no(`ledger_${verdict}`);
            if (verdict === 'duplicate') return no('delivered_already_recorded');
        }
        bindTaskRowSession(meshId, taskId, sessionId);
        return { bound: true, sessionId };
    } catch (e: any) {
        LOG.warn('RemoteDirectBinding', `bind failed: ${e?.message ?? String(e)}`);
        return no('error');
    }
}

/** Set the row's session only when it is still unassigned (never overwrite). */
function bindTaskRowSession(meshId: string, taskId: string, sessionId: string): void {
    const store = MeshRuntimeStore.getInstance();
    const row = store.findQueueEntryById(meshId, taskId);
    if (!row || row.assignedSessionId || row.targetSessionId) return;
    store.updateQueueEntry({ ...row, assignedSessionId: sessionId, targetSessionId: sessionId });
}

/**
 * For `direct_dispatch_record`: the session a sessionless direct dispatch's attempt was
 * bound to by {@link bindSessionlessDirectSendAnswer}, or '' (unbound / not ours).
 */
export function resolveBoundDirectSession(
    meshId: string,
    taskId: string,
    attemptId: string,
    deps: { ledger?: TurnLedger | null } = {},
): string {
    try {
        const ledger = deps.ledger === undefined ? getActiveTurnLedger() : deps.ledger;
        if (!ledger || !meshId || !taskId || !attemptId) return '';
        const found = ownedOpenDirectAttempt(ledger, meshId, taskId, attemptId);
        if (typeof found === 'string') return '';
        return sessionIdsEquivalent(found.sessionId, taskId) ? '' : found.sessionId;
    } catch {
        return '';
    }
}
