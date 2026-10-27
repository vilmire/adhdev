/**
 * Refinery ↔ contract versioning (Cut A consumer (b); design §10(b), §15; AC13; RN-02).
 *
 *   - Admission (provisional): right after the base preflight, every STRICT
 *     completed result riding this node is assessed for `integration_admission`;
 *     a held/needs-revalidation result stops the job before any gate runs.
 *   - Landing (final use): immediately before the only base-mutating stage the
 *     pipeline acquires RN-02 use guards scoped to the results' namespace +
 *     pinned units, rechecks `integration_landing` at that linearization point
 *     and records the external intent. A proposal changing one of those units
 *     cannot be accepted while the guard is active/unknown. Success finishes the
 *     guard; a failure or throw makes the outcome UNKNOWN, which is reconciled
 *     only by checking the actual target branch — never by a timer.
 *
 * A node with no strict results takes neither stage (compat-open): every
 * existing Refinery gate and its terminal-once/security guards are untouched.
 */

import { execFileSync } from 'node:child_process';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { RefineContext, RefineStageOutcome } from '../mesh/mesh-refine-gates.js';
import { recordMeshRefineStage } from '../mesh/mesh-refine-gates.js';
import {
    contractBeginLanding, contractFinishLanding, contractRefineAdmission, contractStrictTasksForNode, getContractCtx, type ContractRefineTaskRef,
} from '../mesh/contract-runtime.js';
import { sanitizedGitEnv } from '../mesh/contract/contract-git-source.js';
import { reconcileUnknownUseGuard } from '../mesh/contract/contract-use-guards.js';

function strictTasks(ctx: RefineContext): ContractRefineTaskRef[] {
    return contractStrictTasksForNode(ctx.meshId, (assigned) => !!assigned && meshNodeIdMatches({ id: assigned }, ctx.nodeId));
}

function heldResult(ctx: RefineContext, stage: string, held: Array<{ taskId: string; state: string }>): RefineStageOutcome {
    recordMeshRefineStage(ctx.refineStages, stage, 'failed', Date.now(), { held: held.length });
    return {
        kind: 'terminal',
        result: {
            success: false,
            code: 'contract_results_held',
            convergenceStatus: 'blocked_review',
            retryable: true,
            error: `${held.length} strict contract result(s) on this branch are not usable for integration under the current contract head `
                + `(${held.map(h => `${h.taskId}:${h.state}`).slice(0, 8).join(', ')}). Revalidate (contract assess) or replace them, then refine again.`,
            branch: ctx.branch,
            into: ctx.baseBranch,
            refineStages: ctx.refineStages,
            finalBranchConvergenceState: { branch: ctx.branch, baseBranch: ctx.baseBranch, merged: false, removed: false, status: 'blocked_review' },
        },
    };
}

export function refineContractAdmissionStage(ctx: RefineContext): RefineStageOutcome {
    const tasks = strictTasks(ctx);
    if (!tasks.length) return { kind: 'continue', ctx };
    const { held } = contractRefineAdmission(tasks);
    if (held.length) return heldResult(ctx, 'contract_admission', held);
    recordMeshRefineStage(ctx.refineStages, 'contract_admission', 'passed', Date.now(), { results: tasks.length });
    return { kind: 'continue', ctx };
}

/** RN-02 probe: did the guarded branch head actually land on the target base? */
export function probeRefineLanding(externalRef: Record<string, string> | null): 'landed' | 'not_landed' | 'indeterminate' {
    const repoRoot = externalRef?.repoRoot;
    const head = externalRef?.branchHead;
    const base = externalRef?.baseBranch;
    if (!repoRoot || !head || !base || !/^[0-9a-f]{40,64}$/.test(head) || base.startsWith('-')) return 'indeterminate';
    try {
        execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', head, base], {
            env: sanitizedGitEnv(), stdio: 'ignore', windowsHide: true, timeout: 15_000,
        });
        return 'landed';
    } catch (e: any) {
        return e && e.status === 1 ? 'not_landed' : 'indeterminate';
    }
}

export async function withContractLandingGuard(ctx: RefineContext, run: () => Promise<RefineStageOutcome>): Promise<RefineStageOutcome> {
    const tasks = strictTasks(ctx);
    if (!tasks.length) return run();
    const externalRef = { repoRoot: ctx.repoRoot, baseBranch: ctx.baseBranch, branch: ctx.branch, branchHead: ctx.branchHead };
    const { guards, held } = contractBeginLanding(tasks, externalRef);
    if (held.length) return heldResult(ctx, 'contract_landing', held);
    recordMeshRefineStage(ctx.refineStages, 'contract_landing', 'passed', Date.now(), { guards: guards.length });
    let outcome: RefineStageOutcome;
    try {
        outcome = await run();
    } catch (e) {
        contractFinishLanding(guards, 'unknown', externalRef);
        reconcileGuards(guards);
        throw e;
    }
    const succeeded = outcome.kind === 'terminal' && outcome.result?.success === true;
    if (succeeded) {
        contractFinishLanding(guards, 'published', externalRef);
    } else {
        // A failed merge stage may still have moved the base (e.g. a push that lost its
        // answer): settle the guard from the actual target branch, not from the reply.
        contractFinishLanding(guards, 'unknown', externalRef);
        reconcileGuards(guards);
    }
    return outcome;
}

function reconcileGuards(guards: readonly string[]): void {
    const ctx = getContractCtx();
    if (!ctx) return;
    for (const g of guards) {
        try { reconcileUnknownUseGuard(ctx, g, probeRefineLanding); } catch { /* stays unknown — boot reconciliation retries */ }
    }
}
