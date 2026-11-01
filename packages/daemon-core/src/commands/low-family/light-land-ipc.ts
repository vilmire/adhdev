/**
 * LIGHT-TASK IPC commands (mesh host only): `light_land` (mesh_light_land) and `light_discard`
 * (mesh_light_discard). Registered with the other mesh-store IPC handlers.
 */
import { randomUUID } from 'node:crypto';
import { getMachineId } from '../../config/config.js';
import { admitLightBaseNode } from '../../mesh/light-task-admission.js';
import { applyLightResultsToCheckout, markLightResultsLanded, outsideOwned, prepareLightLandBatch, removeLightLandBatch, validateLightLandRequest, type LightLandCandidate } from '../../mesh/light-land.js';
import { removeLightWorkspace } from '../../mesh/light-workspace.js';
import { getLightWorkspace, setLightWorkspaceState } from '../../mesh/mesh-light-workspace-store.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { runWithRefineExecutionSlot } from '../../mesh/mesh-refine-concurrency.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { withQueueLock } from '../../mesh/mesh-work-queue.js';
import type { MeshWorkQueueEntry } from '../../mesh/mesh-work-queue-types.js';
import { executeMeshRefineNodeSynchronously } from '../router-refine.js';
import type { DaemonCommandRouter } from '../router.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

const fail = (code: string, error: string, extra: Record<string, unknown> = {}) => ({ success: false as const, code, error, ...extra });
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function resolveHost(ctx: LowFamilyContext, meshId: string) {
    const record = await ctx.getMeshForCommand?.(meshId, undefined, { preferInline: true });
    const self = ctx.deps.statusInstanceId;
    if (!record?.mesh) return { error: fail('mesh_not_found', `mesh '${meshId}' not found`) };
    const status = resolveMeshHostStatus(record.mesh, { localDaemonId: self });
    if (status.role !== 'host') return { error: fail('mesh_host_required', 'light landing runs on the mesh host only') };
    return { mesh: record.mesh, self };
}

function persistRow(task: MeshWorkQueueEntry): void {
    withQueueLock(task.meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const fresh = store.findQueueEntryById(task.meshId, task.id);
        if (!fresh) return;
        fresh.lightResult = task.lightResult;
        store.updateQueueEntry(fresh);
    });
}

function summarize(c: LightLandCandidate) {
    const r = c.task.lightResult!;
    return { taskId: c.task.id, landing: r.landing, touchedPaths: r.touchedPaths, outsideOwned: outsideOwned(c.task), applyCheck: r.applyCheck?.head.status, branch: r.branch };
}

const lightLand: LowFamilyHandler = async (ctx, args) => {
    const meshId = text(args?.meshId);
    const taskIds: string[] = Array.isArray(args?.taskIds) ? args.taskIds.filter((t: unknown): t is string => typeof t === 'string' && !!t.trim()).map((t: string) => t.trim()) : [];
    if (!meshId || !taskIds.length) return fail('bad_request', 'meshId and taskIds are required');
    const mode = args?.mode === 'apply_to_checkout' ? 'apply_to_checkout' : 'refine';
    const dryRun = args?.dryRun === true;
    try {
        const host = await resolveHost(ctx, meshId);
        if ('error' in host && host.error) return host.error;
        if (mode === 'apply_to_checkout' && args?.callerIsCoordinator === true) {
            return fail('apply_mode_requires_interactive_caller', 'a mesh coordinator does not edit its checkout; use mode "refine" (the interactive MCP session applies its own results)');
        }
        const store = MeshRuntimeStore.getInstance();
        const v = validateLightLandRequest(store.db, { taskIds, acceptPathsOutsideOwned: args?.acceptPathsOutsideOwned === true }, id => store.findQueueEntryById(meshId, id));
        if (!v.ok) return fail(v.refusal.code, `${v.refusal.code}: task ${v.refusal.taskId}${v.refusal.detail ? ` — ${v.refusal.detail}` : ''}`, { taskId: v.refusal.taskId });
        const admission = admitLightBaseNode(host.mesh, host.self, v.candidates[0].task.lightBaseNodeId);
        const dbh = store.db;

        if (mode === 'apply_to_checkout') {
            if (dryRun) return { success: true, dryRun: true, mode, plan: v.candidates.map(summarize) };
            const res = await applyLightResultsToCheckout(admission.checkoutRoot, v.candidates);
            if (!res.ok) return fail('light_apply_failed', `apply_to_checkout stopped at task ${res.failed?.taskId}: ${res.failed?.reason}`, { applied: res.applied, failed: res.failed });
            markLightResultsLanded(dbh, v.candidates, 'apply_to_checkout', persistRow);
            for (const c of v.candidates) await removeLightWorkspace({ path: c.ws.path, checkoutRoot: admission.checkoutRoot, config: admission.config, db: dbh, workspaceId: c.ws.workspaceId, submodules: Object.keys(c.ws.submoduleBases) });
            return { success: true, mode, applied: res.applied, note: 'Changes are applied and staged in your checkout, NOT committed. Verify and commit them yourself.' };
        }

        const batchId = randomUUID();
        const prep = await prepareLightLandBatch({ db: dbh, meshId, batchId, checkoutRoot: admission.checkoutRoot, config: admission.config, candidates: v.candidates });
        const landCtx = { db: dbh, checkoutRoot: admission.checkoutRoot, config: admission.config };
        const landedCandidates = v.candidates.filter(c => prep.landed.includes(c.task.id));
        if (prep.conflict && (!args?.partial || !landedCandidates.length || dryRun)) {
            const plan = { plan: v.candidates.map(summarize), landable: prep.landed, conflict: prep.conflict };
            await removeLightLandBatch(prep, landCtx);
            if (dryRun) return { success: true, dryRun: true, mode, ...plan, partialNeeded: true };
            return fail('light_land_conflict', `task ${prep.conflict.taskId} conflicts with the current base (${prep.conflict.paths.join(', ')}); resolve it in its session (mesh_send_task rebase delta) or pass partial=true to land the ${prep.landed.length} task(s) before it`, plan);
        }
        if (dryRun) {
            await removeLightLandBatch(prep, landCtx);
            return { success: true, dryRun: true, mode, plan: v.candidates.map(summarize), landable: prep.landed };
        }

        const router = ctx.components().router as DaemonCommandRouter;
        const sourceNode = host.mesh.nodes.find((n: any) => n.workspace === admission.checkoutRoot) ?? host.mesh.nodes[0];
        const nodeId = `light-land-${batchId.slice(0, 8)}`;
        const node = { id: nodeId, workspace: prep.handle.path, isLocalWorktree: true, clonedFromNodeId: sourceNode?.id, daemonId: sourceNode?.daemonId, machineId: getMachineId() };
        const mesh = { ...host.mesh, nodes: [...host.mesh.nodes, node] };
        const result: any = await runWithRefineExecutionSlot(`light-land ${batchId.slice(0, 8)} (mesh ${meshId})`, () => executeMeshRefineNodeSynchronously(
            router, meshId, nodeId,
            { ...(Array.isArray(args?.approvedPublishShas) ? { approvedPublishShas: args.approvedPublishShas } : {}) },
            {
                mesh, node, sourceNode, repoRoot: admission.checkoutRoot,
                target: { profile: 'fast', cleanup: async () => { await removeLightLandBatch(prep, landCtx); return { success: true, removed: true }; } },
            },
        ));
        const merged = result?.success === true;
        if (merged) {
            markLightResultsLanded(dbh, landedCandidates, 'refine', persistRow);
            for (const c of landedCandidates) await removeLightWorkspace({ path: c.ws.path, checkoutRoot: admission.checkoutRoot, config: admission.config, db: dbh, workspaceId: c.ws.workspaceId, submodules: Object.keys(c.ws.submoduleBases) });
        } else {
            await removeLightLandBatch(prep, landCtx); // the results (their branches + patches) stay for a retry
        }
        return { ...result, mode, landedTaskIds: merged ? prep.landed : [], ...(prep.conflict ? { skippedAfterConflict: prep.conflict } : {}) };
    } catch (e: any) {
        return fail('light_land_failed', e?.message || String(e));
    }
};

const lightDiscard: LowFamilyHandler = async (ctx, args) => {
    const meshId = text(args?.meshId);
    const taskIds: string[] = Array.isArray(args?.taskIds) ? args.taskIds.filter((t: unknown): t is string => typeof t === 'string' && !!t.trim()) : [];
    if (!meshId || !taskIds.length) return fail('bad_request', 'meshId and taskIds are required');
    try {
        const host = await resolveHost(ctx, meshId);
        if ('error' in host && host.error) return host.error;
        const store = MeshRuntimeStore.getInstance();
        const discarded: string[] = [];
        for (const id of taskIds) {
            const task = store.findQueueEntryById(meshId, id);
            const ws = task?.lightWorkspaceId ? getLightWorkspace(store.db, task.lightWorkspaceId) : undefined;
            if (!task?.light || !ws) continue;
            if (task.lightResult?.landing === 'landed') continue;
            setLightWorkspaceState(store.db, ws.workspaceId, 'discarded');
            await removeLightWorkspace({ path: ws.path, checkoutRoot: ws.repoRoot, db: store.db, workspaceId: ws.workspaceId, submodules: Object.keys(ws.submoduleBases), deleteBranches: true });
            if (task.lightResult) { task.lightResult = { ...task.lightResult, landing: 'discarded' }; persistRow(task); }
            discarded.push(id);
        }
        return { success: true, discarded };
    } catch (e: any) { return fail('light_discard_failed', e?.message || String(e)); }
};

export const lightLandIpcHandlers: Record<string, LowFamilyHandler> = { light_land: lightLand, light_discard: lightDiscard };
