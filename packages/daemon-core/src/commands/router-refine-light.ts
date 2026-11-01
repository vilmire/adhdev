/**
 * LIGHT-TASK landing through the refinery (design §11.1): the land workspace is presented to the unchanged
 * pipeline as a synthetic branch-worktree node. Only resolve_refs (this file), the validation profile and
 * the cleanup stage differ — base lease, preflight, dirty gate, sync_base, patch equivalence, submodule
 * reachability/publish approval, merge and the public-push guard are the node pipeline's own.
 */
import type { RefineCommandArgs } from '../mesh/mesh-refine-publication-contract.js';
import type { RefineStageOutcome } from '../mesh/mesh-refine-gates.js';
import type { RefineLightTarget } from '../mesh/refine-light-target.js';
import type { DaemonCommandRouter } from './router.js';
import { refineResolveRefsTail } from './router-refine-sync-stages.js';

export interface LightRefineLaunch {
    mesh: any;
    /** Synthetic worktree node: `{ id, workspace: <land workspace>, isLocalWorktree: true, ... }` */
    node: any;
    /** The base node (coordinator checkout). */
    sourceNode: any;
    repoRoot: string;
    target: RefineLightTarget;
}

export async function refineResolveLightRefsStage(
    self: DaemonCommandRouter, meshId: string, nodeId: string, args: RefineCommandArgs,
    refineStages: Array<Record<string, unknown>>, light: LightRefineLaunch,
): Promise<RefineStageOutcome> {
    const out = await refineResolveRefsTail(self, { meshId, nodeId, args, refineStages, mesh: light.mesh, node: light.node, sourceNode: light.sourceNode, repoRoot: light.repoRoot });
    if (out.kind === 'continue') out.ctx.lightTarget = light.target;
    return out;
}

