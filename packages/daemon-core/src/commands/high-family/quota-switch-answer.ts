/**
 * The owner entry point of the Usage-limit CLI switch (mission ac0a8f3a). The owner answers the quota decision
 * card's "Switch to <cli>" option through `mission_decision_answer`; that answer - and nothing else - runs
 * switchQuotaExhaustedSession. Ingress is the decision command's: coordinators, workers, mesh/ws/api sources and
 * MCP credentials never reach it, and the assistant/push relay are limited to "Wait for reset" by
 * quotaOverrideAnswerGuard. This module re-checks the actor anyway (defence in depth), re-reads the queue row so
 * a task that moved on is never switched, and on any failure reopens the decision so nothing looks decided.
 */
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { isLocalAutoLaunchNode } from '../../mesh/mesh-candidacy-predicates.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { parseQuotaSwitchProvider, taskIdFromQuotaOverrideKey } from '../../mesh/mesh-quota-override.js';
import { switchQuotaExhaustedSession } from '../../mesh/mesh-quota-provider-switch.js';
import { answerMissionDecision, type DecisionActor } from '../../mesh/mesh-mission-decisions.js';
import type { HighFamilyContext } from './types.js';

export type OwnerQuotaSwitchOutcome =
    | null // the answer is not a switch option
    | { ok: true; taskId: string; toProvider: string }
    | { ok: false; code: string; error: string; recovery?: string };

export async function applyOwnerQuotaSwitch(
    ctx: Pick<HighFamilyContext, 'execute' | 'deps' | 'getMeshForCommand'>,
    req: { meshId: string; itemId: string },
    actor: DecisionActor,
): Promise<OwnerQuotaSwitchOutcome> {
    const store = MeshRuntimeStore.getInstance();
    const item = store.missionItems().getItem(req.meshId, req.itemId);
    const taskId = taskIdFromQuotaOverrideKey(item?.dedupeKey);
    const decision = item?.decision;
    const answer = decision?.answer;
    const toProvider = parseQuotaSwitchProvider(decision?.options.find(o => o.id === answer?.optionId)?.label);
    if (!item || !taskId || !toProvider) return null;

    const reopen = (outcome: { ok: false; code: string; error: string; recovery?: string }): OwnerQuotaSwitchOutcome => {
        answerMissionDecision({ meshId: req.meshId, itemId: req.itemId, undo: true }, actor);
        return outcome;
    };
    if (!(actor.by === 'owner' && (actor.via === 'dashboard' || actor.via === 'cli'))) {
        return reopen({ ok: false, code: 'quota_switch_owner_only', error: 'only the owner, from the dashboard or CLI, can move a task to another CLI' });
    }
    const task = store.findQueueEntryById(req.meshId, taskId);
    const sessionId = task?.assignedSessionId;
    const fromProvider = task?.assignedProviderType;
    if (!task || task.status !== 'assigned' || !sessionId || !fromProvider || !task.assignedNodeId) {
        return reopen({ ok: false, code: 'quota_switch_task_moved', error: 'the task is no longer assigned to a running session; nothing was stopped' });
    }
    const loader = (ctx.deps as { providerLoader?: { resolve?: (t: string) => unknown } }).providerLoader;
    if (loader?.resolve && !loader.resolve(toProvider)) {
        return reopen({ ok: false, code: 'quota_switch_provider_unknown', error: `${toProvider} is not an installed provider on this machine` });
    }
    const resolved = await ctx.getMeshForCommand(req.meshId, undefined, { preferInline: true });
    const node = resolved?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, task.assignedNodeId!));
    if (!node) return reopen({ ok: false, code: 'quota_switch_node_missing', error: 'the node that ran the task is no longer in the project' });

    // Fail closed: the stop and its absence proof use THIS daemon's session host. A task on a remote member node
    // would be requeued (a new pin, a second writer) while its CLI may still run there.
    if (!isLocalAutoLaunchNode(node)) {
        return reopen({ ok: false, code: 'quota_switch_remote_node', error: 'this task runs on another machine; switching its CLI from here cannot prove the old session stopped',
            recovery: 'Wait for the limit to reset, or stop the session from that machine (or its own dashboard) and requeue the task there.' });
    }

    const control = (ctx.deps as { sessionHostControl?: { listSessions(): Promise<any[]> } | null }).sessionHostControl;
    const result = await switchQuotaExhaustedSession({
        hostHasSession: control ? async id => (await control.listSessions()).some(r => r?.sessionId === id) : undefined,
        cleanupMeshSessions: args => ctx.execute('cleanup_mesh_sessions', { meshId: args.meshId, nodeId: args.nodeId, mode: args.mode, sessionIds: args.sessionIds }, 'internal', { inProcess: true }) as any,
    }, { meshId: req.meshId, nodeId: task.assignedNodeId, node, taskId, sessionId, fromProvider, toProvider, approvedBy: 'owner' });
    if (!result.ok) return reopen({ ok: false, code: result.code, error: result.error, ...(result.recovery ? { recovery: result.recovery } : {}) });
    return { ok: true, taskId, toProvider };
}
