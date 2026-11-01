/**
 * LIGHT-TASK dispatcher (design §6). The queue tick calls `dispatchLightTasks` once per drain;
 * it is the ONLY path that launches a worker for a `light` row (regular claim and regular
 * auto-launch both skip light rows — see light-claim-rule.ts / mesh-queue-autolaunch.ts):
 *
 *   cap -> owned_paths overlap -> provider/quota routing (resolveAutoLaunchPlan, base node)
 *   -> prepareLightWorkspace -> launch_cli {dir: workspace} -> pin row to the new session
 *   -> the usual tryAssignQueueTask (turn-ledger attempt, hard ceiling, dispatch body).
 */
import { meshNodeIdMatches, LIGHT_HOLD, readText } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import { assertMaintenanceAdmission, assertMaintenanceNode } from '../maintenance/cooperative-gate.js';
import { isNewWorkHeld } from '../maintenance/new-work-hold.js';
import { resolveMeshPolicy } from '../repo-mesh-types.js';
import { resolveMaxLightParallelTasks } from '../repo-mesh-policy-resolve.js';
import { getMachineId } from '../config/config.js';
import { admitLightBaseNode } from './light-task-admission.js';
import { takeLightCheckoutFingerprint } from './light-checkout-fingerprint.js';
import { LightWorkspaceError, prepareLightWorkspace, removeLightWorkspace } from './light-workspace.js';
import { countLiveLightWorkspaces, setLightWorkspaceFingerprint } from './mesh-light-workspace-store.js';
import { getMeshWithCache } from './mesh-queue-mesh-view.js';
import { resolveAutoLaunchPlan } from './mesh-queue-autolaunch.js';
import { tryAssignQueueTask, waitForLocalSessionReady } from './mesh-queue-assignment.js';
import { recordQueueTaskHold } from './mesh-queue-hold-store.js';
import { evaluateTaskOwnedPathsAdmission } from './mesh-runtime-store-claim.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { commitTaskTerminal } from './mesh-task-terminal.js';
import { getQueue, meshTaskNotBeforeReady, meshTaskPriorityRank, taskDependenciesSatisfied, withQueueLock } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

/** Retry the workspace preparation once after this delay; a second failure blocks the task. */
export const LIGHT_PREPARE_RETRY_MS = 3 * 60_000;
/** Concurrent workspaces allowed beyond the parallel cap (results waiting to land). */
export const LIGHT_WORKSPACE_SLACK = 5;

const inFlight = new Set<string>();
const prepareFailures = new Map<string, { count: number; retryAt: number }>();

export function __resetLightDispatchForTests(): void { inFlight.clear(); prepareFailures.clear(); }

/** Rows that currently occupy a light slot: launched (workspace attached) and not terminal. */
export function activeLightRows(meshId: string): MeshWorkQueueEntry[] {
    return getQueue(meshId, { status: ['pending', 'assigned'] }).filter(t => t.light && t.lightWorkspaceId);
}

function pinRowToLightSession(meshId: string, taskId: string, patch: { lightWorkspaceId: string; targetSessionId: string; targetNodeId: string; ownershipScope?: MeshWorkQueueEntry['ownershipScope'] }): boolean {
    return withQueueLock(meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const fresh = store.findQueueEntryById(meshId, taskId);
        if (!fresh || fresh.status !== 'pending') return false;
        Object.assign(fresh, patch);
        delete fresh.hold;
        store.updateQueueEntry(fresh);
        return true;
    });
}

/** Mark a pending light row unlaunchable: first failure holds + retries later, the second blocks it. */
function noteLightPrepareFailure(meshId: string, task: MeshWorkQueueEntry, step: string, error: string): void {
    const key = `${meshId}::${task.id}`;
    const prev = prepareFailures.get(key);
    const count = (prev?.count ?? 0) + 1;
    LOG.warn('LightTask', `task ${task.id}: ${step}: ${error}`);
    if (count >= 2) {
        prepareFailures.delete(key);
        commitTaskTerminal({ meshId, taskId: task.id, status: 'blocked', source: 'queue_policy', reason: `${LIGHT_HOLD.PREPARE_FAILED}:${step}` });
        return;
    }
    prepareFailures.set(key, { count, retryAt: Date.now() + LIGHT_PREPARE_RETRY_MS });
    recordQueueTaskHold(meshId, task.id, `${LIGHT_HOLD.PREPARE_FAILED}:${step}`);
}

async function dispatchOne(components: DaemonComponents, meshId: string, mesh: any, task: MeshWorkQueueEntry): Promise<boolean> {
    const admission = (() => {
        try { return admitLightBaseNode(mesh, getMachineId() ?? undefined, task.lightBaseNodeId); } catch (e: any) { noteLightPrepareFailure(meshId, task, 'admission', e?.message || String(e)); return null; }
    })();
    if (!admission) return false;
    const node = (mesh.nodes ?? []).find((n: any) => meshNodeIdMatches(n, admission.lightBaseNodeId));
    const nodeId = admission.lightBaseNodeId;

    // Routing first (cheap, no side effects): a quota-gated/unusable provider just waits.
    let skipReason: string | undefined;
    const plan = await resolveAutoLaunchPlan(components, meshId, mesh, task as any, node, nodeId, false, [], (_n, reason) => { skipReason = reason; });
    if (!plan) { recordQueueTaskHold(meshId, task.id, skipReason || 'provider_unusable', nodeId); return false; }

    let handle;
    try {
        handle = await prepareLightWorkspace({
            meshId, taskId: task.id, checkoutRoot: admission.checkoutRoot, config: admission.config, db: MeshRuntimeStore.getInstance().db,
            ...(task.ownedPaths && mesh.repoIdentity ? { ownership: { paths: task.ownedPaths, repoIdentity: mesh.repoIdentity, machineId: getMachineId() ?? '', nodeId } } : {}),
        });
    } catch (e: any) {
        if (e instanceof LightWorkspaceError && e.code === 'light_workspace_disk_low') { recordQueueTaskHold(meshId, task.id, LIGHT_HOLD.DISK_LOW, nodeId); return false; }
        noteLightPrepareFailure(meshId, task, e instanceof LightWorkspaceError ? e.code : 'prepare', e?.message || String(e));
        return false;
    }
    prepareFailures.delete(`${meshId}::${task.id}`);

    const cleanup = () => removeLightWorkspace({ path: handle.path, checkoutRoot: admission.checkoutRoot, config: admission.config, db: MeshRuntimeStore.getInstance().db, workspaceId: handle.workspaceId, submodules: Object.keys(handle.submoduleBases), deleteBranches: true }).catch(() => undefined);
    try {
        assertMaintenanceAdmission([meshId]);
        assertMaintenanceNode(meshId, nodeId);
        // Shared-checkout detector baseline (design §8): compared again when the result is captured.
        // Stored in the daemon DB, never in/near the workspace: the worker must not be able to rewrite its own baseline.
        try { setLightWorkspaceFingerprint(MeshRuntimeStore.getInstance().db, handle.workspaceId, await takeLightCheckoutFingerprint(admission.checkoutRoot, admission.config.linkNodeModules, Object.keys(handle.submoduleBases))); }
        catch (e: any) { LOG.warn('LightTask', `fingerprint baseline for ${task.id} not taken: ${e?.message || e}`); }
        const launch: any = await components.router.execute('launch_cli', {
            cliType: plan.effectiveProviderType,
            dir: handle.path,
            settings: { ...plan.launchSettings, lightWorkspaceId: handle.workspaceId },
            ...(plan.effectiveModel ? { initialModel: plan.effectiveModel } : {}),
            ...(plan.effectiveThinkingLevel ? { initialThinkingLevel: plan.effectiveThinkingLevel } : {}),
            ...plan.launchProvenance,
        }, 'mesh', { inProcess: true });
        const sessionId = readText(launch?.sessionId) || readText(launch?.id) || readText(launch?.runtimeSessionId);
        if (!launch?.success || !sessionId) {
            await cleanup();
            noteLightPrepareFailure(meshId, task, 'launch', launch?.error || 'launch_cli_failed');
            return false;
        }
        const pinned = pinRowToLightSession(meshId, task.id, {
            lightWorkspaceId: handle.workspaceId, targetSessionId: sessionId, targetNodeId: nodeId,
            ...(handle.ownershipScope ? { ownershipScope: handle.ownershipScope } : {}),
        });
        if (!pinned) { await cleanup(); return false; } // cancelled / claimed elsewhere while preparing
        await waitForLocalSessionReady(components, sessionId);
        tryAssignQueueTask(components, meshId, nodeId, sessionId, plan.effectiveProviderType, plan.buildRoutingDecision(), undefined, 'light_dispatch');
        return true;
    } catch (e: any) {
        await cleanup();
        noteLightPrepareFailure(meshId, task, 'launch', e?.message || String(e));
        return false;
    }
}

/** One drain pass: start as many pending light rows as the caps allow. Returns how many were started. */
export async function dispatchLightTasks(components: DaemonComponents, meshId: string, mesh?: any): Promise<number> {
    try { assertMaintenanceAdmission([meshId]); } catch { return 0; }
    if (isNewWorkHeld({ meshId })) return 0;
    const pending = getQueue(meshId, { status: ['pending'] }).filter(t => t.light && !t.lightWorkspaceId);
    if (!pending.length) return 0;
    const m = mesh ?? getMeshWithCache(components, meshId);
    if (!m) return 0;
    const store = MeshRuntimeStore.getInstance();
    const graph = store.getQueueSchedulingGraph(meshId);
    const statusById = new Map(graph.map(t => [t.id, t.status] as const));
    const graphById = new Map(graph.map(t => [t.id, t] as const));
    const cap = resolveMaxLightParallelTasks(resolveMeshPolicy(m.policy).maxParallelTasks);
    let started = 0;
    for (const task of pending.sort((a, b) => meshTaskPriorityRank(b.priority) - meshTaskPriorityRank(a.priority))) {
        const key = `${meshId}::${task.id}`;
        if (inFlight.has(key)) continue;
        if (!taskDependenciesSatisfied(task, statusById, graphById) || !meshTaskNotBeforeReady(task)) continue;
        const retry = prepareFailures.get(key);
        if (retry && Date.now() < retry.retryAt) continue;
        if (activeLightRows(meshId).length + inFlight.size >= cap) { recordQueueTaskHold(meshId, task.id, LIGHT_HOLD.CAP, undefined, true); continue; }
        if (countLiveLightWorkspaces(store.db) >= cap + LIGHT_WORKSPACE_SLACK) { recordQueueTaskHold(meshId, task.id, LIGHT_HOLD.LIMIT, undefined, true); continue; }
        if (!evaluateTaskOwnedPathsAdmission(store, meshId, task).allowed) { recordQueueTaskHold(meshId, task.id, 'owned_paths_conflict', undefined, true); continue; }
        inFlight.add(key);
        try { if (await dispatchOne(components, meshId, m, task)) started++; }
        catch (e: any) { LOG.warn('LightTask', `dispatch ${task.id} failed: ${e?.message || e}`); }
        finally { inFlight.delete(key); }
    }
    return started;
}
