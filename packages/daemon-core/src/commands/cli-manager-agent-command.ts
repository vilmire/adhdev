/**
 * DaemonCliManager — the `agent_command` command: send_chat (mesh assignment
 * stamp + the one SessionInputService submit), clear_history, task-scoped stop,
 * and the turn-interrupt probe/action.
 *
 * Split out of cli-manager.ts (file-size gate).
 */
import type { SubmitOutcome } from '@adhdev/mesh-shared';
import { DuplicateMeshDispatchError } from '../mesh/mesh-duplicate-dispatch.js';
import { SessionBusyWithTaskError } from '../mesh/mesh-session-busy-dispatch.js';
import { normalizeInputEnvelope } from '../providers/contracts.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { LOG } from '../logging/logger.js';
import { dispatchMessageId } from '../mesh/mesh-queue-dispatch-evidence.js';
import { evaluateMeshStopTaskScope } from './mesh-stop-task-scope.js';
import {
    mintLegacyMessageId, readMeshContext, readMessageId, readOutboundOrigin, readSendPolicy,
    type AgentCommandArgs,
} from './command-args.js';
import type { DaemonCliManager } from './cli-manager.js';
import type { CommandResult } from './cli-manager-launch.js';

/** The DaemonCliManager members these functions read or call (compiler-checked; no cast). */
export type CliAgentCommandHost = Pick<DaemonCliManager, 'deps' | 'findAdapter' | 'findMeshNodeAdapter' | 'input' | 'stopSession'>;

/** `agent_command`: send_chat / clear_history / stop against a CLI session. */
export async function agentCommand(host: CliAgentCommandHost, args: AgentCommandArgs): Promise<CommandResult> {
    const agentType = args?.agentType || args?.cliType;
    const action = args?.action;
    if (!agentType || !action) throw new Error('agentType and action required');

    // WTCLAIM (B): a mesh dispatch that named a node (meshContext.nodeId)
    // but resolved no explicit session must be scoped to THAT node's
    // session — never routed by findAdapter's provider-only fuzzy fallback,
    // which on a daemon hosting both a base node and a cloned worktree node
    // (same daemonId) could land a worktree task on the base session. Fail
    // closed when no session is bound to the node so the coordinator
    // launches/retries instead of mis-landing the work.
    const meshScopeNodeId = (() => {
        const mc = readMeshContext(args);
        return typeof mc?.nodeId === 'string' ? mc.nodeId.trim() : '';
    })();
    let found: { adapter: CliAdapter; key: string } | null;
    if (meshScopeNodeId && !args?.targetSessionId) {
        found = host.findMeshNodeAdapter(agentType, meshScopeNodeId, args?.dir);
        if (!found) {
            throw new Error(`No mesh worker session bound to node '${meshScopeNodeId}' for agent '${agentType}' on this daemon; refusing provider-only fuzzy match to avoid cross-node dispatch`);
        }
    } else {
        found = host.findAdapter(agentType, {
            dir: args?.dir,
            instanceKey: args?.targetSessionId,
        });
    }
    if (!found) throw new Error(`CLI agent not running: ${agentType}`);
    const { adapter, key } = found;

    if (action === 'send_chat') return agentSendChat(host, args, key);
    if (action === 'clear_history') {
        if (typeof adapter.clearHistory === 'function') adapter.clearHistory();
        return { success: true, cleared: true };
    }
    if (action === 'stop') return agentStopTaskScoped(host, args, adapter, key);
    if (action === 'interrupt_capability') return agentInterruptCapability(adapter, agentType);
    if (action === 'interrupt_turn') return agentInterruptTurn(adapter, agentType);
    throw new Error(`Unknown action: ${action}`);
}

/** CANCEL-STOP-TASK-SCOPE: per-turn task binding, set when the turn was submitted. */
type CliAdapterWithTurnTaskId = CliAdapter & {
    currentTurnTaskId?: string;
};

/**
 * `agent_command send_chat` result from the one `SubmitOutcome` (D2). A refusal
 * THROWS — the mesh dispatch lifecycle (deliverTaskToSession) treats a resolved
 * command as a delivery receipt and a rejection as a dispatch failure, and the
 * router reports a throw as `{success:false, error}`. `status:'queued'` is the
 * driver's authoritative "parked, not yet written" (never a pre-send guess).
 */
function meshSubmitResult(outcome: SubmitOutcome, sessionKey: string): CommandResult {
    switch (outcome.kind) {
        case 'delivered':
            return {
                success: true,
                status: 'generating',
                submitted: outcome.route !== 'agent_queue',
                ...(outcome.route ? { route: outcome.route } : {}),
                ...(outcome.interrupt ? { interrupted: true, interruptKey: outcome.interrupt.keyName, interruptConfidence: outcome.interrupt.confidence } : {}),
            };
        case 'queued':
            return {
                success: true,
                status: 'queued',
                queued: true,
                queuedReason: 'driver_fifo_parked',
                position: outcome.position,
                sent: false,
                submitted: false,
                ...(outcome.interrupt ? { interrupted: true, interruptKey: outcome.interrupt.keyName, interruptConfidence: outcome.interrupt.confidence } : {}),
            };
        case 'duplicate':
            LOG.warn('MeshDispatch', `Suppressed duplicate submission on session ${sessionKey}: messageId ${outcome.of} was already submitted — not re-injecting`);
            return { success: true, status: 'generating', duplicateSuppressed: true, messageId: outcome.of };
        case 'refused': {
            const error = new Error(outcome.message || `send refused: ${outcome.reason}`) as Error & { reason?: string; restored?: boolean };
            error.reason = outcome.reason;
            if (outcome.restored !== undefined) error.restored = outcome.restored;
            throw error;
        }
    }
}

/** `send_chat`: stamp the mesh assignment (when dispatched by a mesh), then the ONE submit. */
async function agentSendChat(host: CliAgentCommandHost, args: AgentCommandArgs, key: string): Promise<CommandResult> {
    // Stamp mesh direct-dispatch assignment on the target
    // instance BEFORE sending the prompt so the completion
    // event has a routing marker by the time it fires.
    // mesh_send_task --direct ships meshContext for plain CLI
    // sessions that were never launched as mesh delegates.
    const meshContext = readMeshContext(args);
    if (meshContext && typeof meshContext === 'object' && typeof meshContext.meshId === 'string' && meshContext.meshId) {
        const targetInstanceId = key;
        let stampResult: { stamped: boolean; reason?: string; holderSessionId?: string; currentTaskId?: string; currentAttemptId?: string } | undefined;
        try {
            stampResult = host.deps.getInstanceManager()?.attachMeshAssignmentToInstance(targetInstanceId, {
                meshId: meshContext.meshId,
                ...(typeof meshContext.nodeId === 'string' && meshContext.nodeId ? { nodeId: meshContext.nodeId } : {}),
                ...(typeof meshContext.taskId === 'string' && meshContext.taskId ? { taskId: meshContext.taskId } : {}),
                // REDRIVE-DUP: carry the dispatch nonce onto the worker session so
                // its generating_started event echoes it back for the coordinator's
                // stale-nonce guard.
                ...(typeof meshContext.dispatchNonce === 'number' ? { dispatchNonce: meshContext.dispatchNonce } : {}),
                // TURN-LEDGER (Stage 5): carry the attempt identity onto the
                // worker session so its lifecycle events echo it back for the
                // coordinator's reducer.
                ...(typeof meshContext.attemptId === 'string' && meshContext.attemptId ? { attemptId: meshContext.attemptId } : {}),
                ...(typeof meshContext.attemptGeneration === 'number' && Number.isInteger(meshContext.attemptGeneration) && meshContext.attemptGeneration >= 0 ? { attemptGeneration: meshContext.attemptGeneration } : {}),
                ...(typeof meshContext.coordinatorDaemonId === 'string' && meshContext.coordinatorDaemonId ? { coordinatorDaemonId: meshContext.coordinatorDaemonId } : {}),
                // SESSION-ISOLATION: the originating coordinator SESSION, so this
                // worker's completion routes back to the exact dispatching session
                // rather than being consumed first-come by any coordinator idle on
                // this daemon (see attachMeshAssignment's coordinatorSessionId).
                ...(typeof meshContext.coordinatorSessionId === 'string' && meshContext.coordinatorSessionId ? { coordinatorSessionId: meshContext.coordinatorSessionId } : {}),
            });
        } catch { /* best-effort — stamping is a routing aid, not a hard requirement */ }
        // DOUBLE-DISPATCH stamp guard: the instance manager refused this stamp because
        // the SAME task is already running on another live session on this daemon.
        // Sending the prompt anyway would double-execute the task — fail closed so the
        // coordinator does not duplicate the work onto a second session.
        if (stampResult && stampResult.stamped === false && stampResult.reason === 'task_already_stamped_on_live_instance') {
            // DUP-CLAIM-REBIND: this refusal is an APPLICATION-LEVEL answer, not a
            // transport failure — the work IS running here, on the session named
            // below. Throw the typed error so the coordinator can rebind its turn
            // ledger onto the real holder instead of cancelling the attempt (which
            // made the holder's genuine completion get rejected as session_mismatch
            // and lost a finished task). The guard already resolved the holder, so
            // it rides along as a field — never something the caller has to parse
            // back out of this message.
            throw new DuplicateMeshDispatchError(
                `Refusing duplicate mesh dispatch: task ${meshContext.taskId} is already being worked by a live session on this daemon`,
                { holderSessionId: stampResult.holderSessionId },
            );
        }
        // SESSION-BUSY stamp guard (preview rc.37): the target session is still
        // working a DIFFERENT task. Submitting now would park this body behind the
        // running turn (executed later as an unaccounted turn 2) and the stamp would
        // have re-pointed the running task's reports at this one — so neither
        // happens: nothing was stamped, nothing is submitted, and the typed refusal
        // makes the dispatcher book a dispatch FAILURE (queue claim → requeue;
        // direct dispatch → dispatch_failed), never a delivery.
        if (stampResult && stampResult.stamped === false && stampResult.reason === 'session_busy_with_task' && stampResult.currentTaskId) {
            throw new SessionBusyWithTaskError({
                currentTaskId: stampResult.currentTaskId,
                ...(stampResult.currentAttemptId ? { currentAttemptId: stampResult.currentAttemptId } : {}),
                ...(typeof meshContext.taskId === 'string' && meshContext.taskId ? { incomingTaskId: meshContext.taskId } : {}),
                sessionId: targetInstanceId,
            });
        }
        // COORDINATOR-SILENT-IDLE (opt-in): the coordinator's mesh policy is
        // 'auto_silent_on_dispatch', so arm a ONE-SHOT transient mute on THIS
        // worker session for the single completion that follows this dispatch.
        // resolveMuted honors it only for an idle snapshot within
        // SILENT_IDLE_PUSH_TTL_MS, so the routine completion push is suppressed
        // while approval/failure/long-running notifications (non-idle status) and
        // a worker that never completes (TTL expiry) are unaffected. Re-armed on
        // every dispatch (fresh armedAt) and one-shot-cleared at the completion
        // emission (emitGeneratingCompleted) so subsequent turns notify normally.
        if (meshContext.silentIdlePush === true) {
            try {
                const workerInst = host.deps.getInstanceManager()?.getInstance(targetInstanceId);
                if (workerInst && typeof workerInst.updateSettings === 'function') {
                    workerInst.updateSettings({
                        silentNextIdlePush: true,
                        silentNextIdlePushArmedAt: Date.now(),
                    });
                }
            } catch { /* best-effort — silent-idle is a notification nicety, never fail the dispatch */ }
        }
    }
    // Wiring-unification D2: ONE submit through the shared SessionInputService.
    // It owns input normalisation, the capability check, the image body
    // build, the busy decision, the messageId dedupe (which replaced the
    // 300 s (session, taskId, content) submission guard) and the ack.
    const meshTaskId = typeof meshContext?.taskId === 'string' && meshContext.taskId.trim() ? meshContext.taskId.trim() : undefined;
    // DISPATCH-SOURCE-TRACE: every agent_command send_chat issuer tags its
    // call site so a duplicate/unexpected inject is attributable from the log.
    const dispatchSource = typeof args?.dispatchSource === 'string' && args.dispatchSource.trim()
        ? args.dispatchSource.trim() : 'untagged';
    const input = normalizeInputEnvelope(args?.input ? { input: args.input } : args);
    const policy = readSendPolicy(args, (flag) => LOG.debug('MeshDispatch', `agent_command send_chat: legacy '${flag}' flag mapped to policy (session ${key})`));
    const messageId = readMessageId(args)
        ?? (meshTaskId ? dispatchMessageId({ id: meshTaskId, ...(typeof meshContext?.dispatchNonce === 'number' ? { dispatchNonce: meshContext.dispatchNonce } : {}) }) : undefined)
        ?? mintLegacyMessageId();
    LOG.info('MeshDispatch', `agent_command send_chat on session ${key}${meshTaskId ? ` task=${meshTaskId}` : ''} messageId=${messageId} policy=${policy.mode} dispatchSource=${dispatchSource}`);
    const outcome = await host.input.submit({
        messageId,
        sessionId: key,
        input,
        origin: readOutboundOrigin(args, meshContext ? 'mesh' : 'api'),
        policy,
        createdAt: Date.now(),
        ...(typeof meshContext?.attemptId === 'string' && meshContext.attemptId ? { meshAttemptRef: meshContext.attemptId } : {}),
    });
    return meshSubmitResult(outcome, key);
}

/** `stop`: a hard session stop, scoped to the cancelled task when one is named. */
async function agentStopTaskScoped(host: CliAgentCommandHost, args: AgentCommandArgs, adapter: CliAdapter, key: string): Promise<CommandResult> {
    // CANCEL-STOP-TASK-SCOPE: a stop carrying meshContext.taskId is scoped to
    // THAT task (mesh_queue_cancel's in-flight halt). stopSession is a HARD
    // stop that removes the whole instance, and sessions are reused — so
    // before killing, confirm this session is actually running the cancelled
    // task. A stale 'assigned' queue row previously let a cancel of task1 kill
    // a session that had since moved on to task2, destroying unrelated work.
    // Unscoped stops (no taskId) and sessions with no resolvable task identity
    // are unaffected; see mesh-stop-task-scope.ts for why those fail open.
    const stopScopeTaskId = (() => {
        const mc = readMeshContext(args);
        return mc && typeof mc === 'object' && typeof mc.taskId === 'string' ? mc.taskId.trim() : '';
    })();
    const stopScope = evaluateMeshStopTaskScope({
        requestedTaskId: stopScopeTaskId || undefined,
        currentTurnTaskId: (adapter as CliAdapterWithTurnTaskId).currentTurnTaskId,
        meshActiveTaskId: (host.deps.getInstanceManager()?.getInstance(key) as
            { getState?: () => { settings?: Record<string, unknown> } } | undefined)
            ?.getState?.()?.settings?.meshActiveTaskId,
    });
    if (!stopScope.allowed) {
        LOG.warn('MeshDispatch', `Refusing task-scoped stop on session ${key}: cancel targets task ${stopScopeTaskId} but the session is running task ${stopScope.sessionTaskId} — not killing unrelated work`);
        return {
            success: false,
            stopped: false,
            reason: 'stop_task_mismatch',
            requestedTaskId: stopScopeTaskId,
            sessionTaskId: stopScope.sessionTaskId,
            error: `Session '${key}' is running task ${stopScope.sessionTaskId}, not the cancelled task ${stopScopeTaskId} — stop refused to avoid killing unrelated work`,
        };
    }
    await host.stopSession(key);
    return { success: true, stopped: true, ...(stopScopeTaskId ? { stoppedTaskId: stopScopeTaskId, stopScope: stopScope.reason } : {}) };
}

/** `interrupt_capability`: read-only probe — can this session's turn be interrupted? */
function agentInterruptCapability(adapter: CliAdapter, agentType: string): CommandResult {
    // Read-only probe: can this session's turn be interrupted? Resolved
    // from the provider's OWN loaded spec, so the answer tracks whichever
    // spec version this session actually booted with. Writes nothing.
    const probe = adapter as unknown as {
        getInterruptCapability?: () => { supported: boolean; keyName?: string; confidence?: string; message?: string; reason?: string };
    };
    if (typeof probe.getInterruptCapability !== 'function') {
        return {
            success: true,
            supported: false,
            reason: 'interrupt_not_implemented',
            message: `Provider '${agentType}' runs on an adapter with no interrupt support.`,
        };
    }
    const cap = probe.getInterruptCapability();
    return { success: true, ...cap };
}

/** `interrupt_turn`: abort the turn in flight (the session survives). */
async function agentInterruptTurn(adapter: CliAdapter, agentType: string): Promise<CommandResult> {
    // Abort the TURN in flight — deliberately distinct from action 'stop'
    // above, which terminates the whole session. Delivery mode 'interrupt'
    // uses this to clear the way for a re-dispatch: the running turn is
    // cancelled and lost, the session survives and returns to idle, and the
    // ordinary queued-send drain then delivers the new prompt as a real turn.
    //
    // Capability is validated inside interruptTurn() against the provider's
    // OWN resolved spec before any byte is written, so a provider with no
    // stop key (or an empty one, e.g. hermes-cli specs/4.0.json) returns
    // ok:false instead of writing nothing and reporting success.
    const interruptible = adapter as unknown as {
        interruptTurn?: () => Promise<
            | { ok: true; keyName: string; bytes: number; confidence: string }
            | { ok: false; reason: string; message: string }
        >;
    };
    if (typeof interruptible.interruptTurn !== 'function') {
        return {
            success: false,
            interrupted: false,
            reason: 'interrupt_not_implemented',
            error: `Provider '${agentType}' runs on an adapter that cannot interrupt a turn.`,
        };
    }
    const outcome = await interruptible.interruptTurn();
    if (!outcome.ok) {
        return { success: false, interrupted: false, reason: outcome.reason, error: outcome.message };
    }
    return {
        success: true,
        interrupted: true,
        keyName: outcome.keyName,
        bytes: outcome.bytes,
        confidence: outcome.confidence,
    };

}
