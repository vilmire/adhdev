/**
 * Escalation of long quota holds to the owner (owner request 2026-11-01): a task held by the quota reserve
 * gate for longer than ADHDEV_QUOTA_HOLD_DECISION_AFTER_MS (default 10 min) raises ONE owner decision in
 * the ordinary inbox (To do drawer + decision push + the assistant's decision nudge, which reads the same
 * store). A coordinator or assistant can ask for it sooner through `mesh_queue_revise` with
 * `patch.requestQuotaOverride` (`requestQuotaOverrideDecision`); neither can grant it.
 *
 * Called from the queue trigger each tick, so it must be cheap when nothing is held: the provider probe
 * for "another usable provider" runs once per task, only when the decision is actually raised.
 */
import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { queueTaskHoldView } from './mesh-queue-hold.js';
import {
    hasQuotaOverride,
    isQuotaGateHoldReason,
    providerPinOf,
    quotaHoldDecisionAfterMs,
    quotaOverrideDecisionKey,
    raiseQuotaOverrideDecision,
    taskIdFromQuotaOverrideKey,
    withdrawQuotaOverrideDecision,
    type RaisedQuotaDecision,
} from './mesh-quota-override.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { resolveUsableProvider } from './mesh-autolaunch-usable-provider.js';
import { quotaFactsContextForLiveRouting } from './mesh-quota-sources.js';
import { isLocalAutoLaunchNode } from './mesh-candidacy-predicates.js';

type AlternativeFinder = (task: MeshWorkQueueEntry) => Promise<string[]>;

/** Other providers that could run the task right now if its provider pin were dropped. */
export function usableAlternativeFinder(components: DaemonComponents, meshId: string, mesh: any): AlternativeFinder {
    return async (task) => {
        const pin = providerPinOf(task);
        if (!pin || !mesh) return [];
        const tags = (task.requiredTags ?? []).filter(tag => !tag.startsWith('provider='));
        const nodes: any[] = (Array.isArray(mesh.nodes) ? mesh.nodes : [])
            .filter((n: any) => !task.targetNodeId || meshNodeIdMatches(n, task.targetNodeId));
        const found = new Set<string>();
        for (const node of nodes) {
            try {
                const r = await resolveUsableProvider(
                    components, node.id, node, meshId, tags,
                    { difficulty: (task as any).difficulty, requiredTags: tags, routingPreferences: task.routingPreferences },
                    mesh.policy?.quotaRouting ?? null,
                    quotaFactsContextForLiveRouting(mesh, isLocalAutoLaunchNode, components.providerLoader),
                );
                if (r.providerType && r.providerType !== pin) found.add(r.providerType);
            } catch { /* a node we cannot probe offers no alternative */ }
        }
        return [...found];
    };
}

const attempted = new Map<string, number>();
const RETRY_AFTER_MS = 60_000;

export function resetQuotaEscalationForTests(): void { attempted.clear(); }

function recentlyAttempted(key: string, now: number): boolean {
    const at = attempted.get(key);
    return at !== undefined && now - at < RETRY_AFTER_MS;
}

function existingDecision(meshId: string, taskId: string) {
    return MeshRuntimeStore.getInstance().missionItems()
        .findDecisionByKey(meshId, `k:${quotaOverrideDecisionKey(taskId)}`, ['open', 'answered']);
}

export interface QuotaEscalationDeps {
    now?: number;
    afterMs?: number;
    findAlternatives?: AlternativeFinder;
}

/** Raise decisions for long quota holds and withdraw those whose task is no longer quota-held. */
export async function escalateQuotaHeldTasks(
    components: DaemonComponents | null,
    meshId: string,
    mesh: any,
    deps: QuotaEscalationDeps = {},
): Promise<string[]> {
    const store = MeshRuntimeStore.getInstance();
    const now = deps.now ?? Date.now();
    const afterMs = deps.afterMs ?? quotaHoldDecisionAfterMs();
    const pending = store.getQueueEntries(meshId, ['pending']);
    const raised: string[] = [];

    for (const open of store.missionItems().listByKindStates(meshId, 'decision', ['open'])) {
        const taskId = taskIdFromQuotaOverrideKey(open.dedupeKey);
        if (!taskId) continue;
        const task = pending.find(t => t.id === taskId);
        if (!task || !task.hold || !isQuotaGateHoldReason(task.hold.reason)) withdrawQuotaOverrideDecision(meshId, open.id, 'task_no_longer_quota_held');
    }

    const find = deps.findAlternatives ?? (components ? usableAlternativeFinder(components, meshId, mesh) : async () => []);
    for (const task of pending) {
        const view = queueTaskHoldView(task, pending, now);
        if (!view || !isQuotaGateHoldReason(view.reason) || view.ageMs < afterMs || hasQuotaOverride(task)) continue;
        const key = `${meshId}:${task.id}`;
        if (recentlyAttempted(key, now) || existingDecision(meshId, task.id)) continue;
        attempted.set(key, now);
        const result = raiseQuotaOverrideDecision(meshId, task, view.reason, { alternatives: await find(task) });
        if ('error' in result) { LOG.debug('MeshQueue', `quota-hold decision for ${task.id}: ${result.error}`); continue; }
        if (!result.deduped) raised.push(result.itemId);
    }
    return raised;
}

export type QuotaOverrideRequestResult =
    | (RaisedQuotaDecision & { ok: true })
    | { ok: false; code: string; error: string };

/**
 * A coordinator/assistant asks the owner for a one-task override now. It only RAISES the decision:
 * nothing here writes `quotaGateOverride`.
 */
export async function requestQuotaOverrideDecision(
    components: DaemonComponents | null,
    meshId: string,
    taskId: string,
    mesh: any,
    deps: Pick<QuotaEscalationDeps, 'findAlternatives'> = {},
): Promise<QuotaOverrideRequestResult> {
    const task = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
    if (!task) return { ok: false, code: 'task_not_found', error: `no queue task '${taskId}'` };
    if (task.status !== 'pending') return { ok: false, code: 'pending_required', error: 'only a pending task can ask for a quota override' };
    if (!task.hold || !isQuotaGateHoldReason(task.hold.reason)) {
        return { ok: false, code: 'not_quota_held', error: 'the task is not held by the quota gate right now — nothing to override' };
    }
    if (hasQuotaOverride(task)) return { ok: false, code: 'already_overridden', error: 'the owner already allowed this task to run despite the quota reserve' };
    const find = deps.findAlternatives ?? (components ? usableAlternativeFinder(components, meshId, mesh) : async () => []);
    const result = raiseQuotaOverrideDecision(meshId, task, task.hold.reason, { alternatives: await find(task) });
    if ('error' in result) return { ok: false, code: 'nothing_to_decide', error: result.error };
    return { ok: true, ...result };
}
