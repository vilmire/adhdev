/**
 * Refinery DRY-RUN preflight: submodule gitlink remote-main reachability.
 *
 * Why this exists (2026-08-25/26 incident, twice): `mesh_refine_batch(dry_run)`
 * already KNEW a node touched a submodule (`changeAreas[node].touchesSubmodule`,
 * and it even ordered those nodes last on that signal) — but never asked the one
 * decisive question: "is the gitlink commit reachable from the submodule's
 * origin/<main>?" The dry-run reported "all clear", all ~25 execution gates
 * passed (validation=passed, patch_equivalence=passed), and only THEN the
 * submodule_reachability gate refused the merge. Minutes of gate work spent to
 * learn the merge was never possible.
 *
 * So the plan surfaces (mesh_refine_plan, mesh_refine_node dry-run,
 * mesh_refine_batch dry-run) now run the SAME reachability probe up front —
 * scoped strictly to nodes whose branch touches a submodule gitlink, so the
 * dry-run stays fast and quiet for everything else.
 *
 * ★Fetch discipline: the probe is only as accurate as the local
 * `refs/remotes/origin/<branch>` is fresh. A stale remote-tracking ref yields
 * BOTH false positives (commit already published, reported unreachable — the
 * 2026-08-22 false-block) and false negatives. The dry-run was never purely
 * read-only anyway: the batch planner already `git fetch origin <baseBranch>`es
 * the ROOT repo to resolve its base ref (see batchRefineMeshNodes). A fetch
 * updates remote-tracking refs only — no working tree, no index, no local
 * branch, never a push — so it does not breach the dry-run no-mutation
 * contract, and {@link verifyRemoteBranchContainsCommit} (shared with the
 * execution-time gate) does it best-effort: a failed fetch is 'undeterminable',
 * NEVER read as "unpublished".
 *
 * ★This is a PRE-WARNING, not a moved gate: the execution-time
 * submodule_reachability stage stays exactly where it is — state can change
 * between dry-run and execute, so the final check must still run at merge time.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve as pathResolve } from 'path';

import { meshNodeIdMatches } from '@adhdev/mesh-shared';

import {
    GIT,
    REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
    buildSubmodulePublishRequiredNextStep,
    readChangedGitlinkPaths,
    readTreeObject,
    verifyRemoteBranchContainsCommit,
} from './mesh-refine-gitlink-utils.js';
import type { MeshRefineSubmoduleReachabilityEntry } from './mesh-refine-gitlink-utils.js';
import type { MeshRefineBatchOrderingResult } from './mesh-refine-batch.js';
// Type-only (erased at compile time — same no-cycle discipline mesh-refine-gates.ts uses).
import type { CommandRouterResult } from '../commands/router.js';
import { buildMeshRefineValidationPlan } from './mesh-refine-gates.js';
import { resolveSubmoduleDefaultBranch } from './worktree-bootstrap-config.js';

const execFileAsync = promisify(execFile);

export type MeshRefineSubmodulePreflightVerdict =
    /** The gitlink commit is an ancestor of the submodule's origin/<default>. */
    | 'reachable'
    /** git ANSWERED "not an ancestor" on a successfully fetched ref — publish required. */
    | 'unreachable'
    /** The remote was never successfully consulted (or an operand did not resolve). NOT evidence of "unpublished". */
    | 'undeterminable';

export type MeshRefineSubmodulePreflightEntry = {
    path: string;
    commit?: string;
    verdict: MeshRefineSubmodulePreflightVerdict;
    remoteMainBranch?: string;
    /** The submodule checkout the probe ran in (`<worktreeRoot>/<path>`). */
    probedRepo?: string;
    error?: string;
};

export type MeshRefineSubmoduleReachabilityPreflight = {
    /** 'warning' when at least one touched gitlink is unreachable or undeterminable. */
    status: 'passed' | 'warning';
    checked: number;
    entries: MeshRefineSubmodulePreflightEntry[];
    /**
     * Actionable guidance with the SAME wording the execution-time
     * `submodule_reachability_failed` result carries (built by the shared
     * {@link buildSubmodulePublishRequiredNextStep}) — the point of the preflight
     * is surfacing that message BEFORE the gates run, not inventing a new one.
     */
    nextStep?: string;
    durationMs: number;
};

const runGit = async (cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(GIT, args, {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        windowsHide: true,
    });
    return String(stdout || '');
};

/**
 * Probe every submodule gitlink the branch touches for remote-main reachability.
 * Returns UNDEFINED when the branch touches no submodule at all — the caller then
 * omits the preflight field entirely, keeping the dry-run byte-identical (fast,
 * quiet) for the common non-submodule case.
 *
 * Read-only except for the best-effort `fetch origin <branch>` inside
 * {@link verifyRemoteBranchContainsCommit} (remote-tracking refs only; see the
 * module header for the fetch rationale).
 */
export async function runMeshRefineSubmoduleReachabilityPreflight(args: {
    /** The node's worktree — submodule probes run in ITS checkouts, never the base mirror's. */
    worktreeRoot: string;
    /** Base ref the branch will merge into (e.g. origin/main or a pinned SHA). */
    baseRef: string;
    /** The branch tip. */
    branchRef: string;
    /** Known touched gitlink paths (from change-area analysis); recomputed when omitted. */
    touchedSubmodulePaths?: string[];
}): Promise<MeshRefineSubmoduleReachabilityPreflight | undefined> {
    const startedAt = Date.now();
    const touched = args.touchedSubmodulePaths
        ?? readChangedGitlinkPaths(args.worktreeRoot, args.baseRef, args.branchRef);
    if (touched.length === 0) return undefined;

    const entries: MeshRefineSubmodulePreflightEntry[] = [];
    for (const path of touched) {
        const probedRepo = pathResolve(args.worktreeRoot, path);
        const commit = readTreeObject(args.worktreeRoot, args.branchRef, path);
        if (!commit) {
            entries.push({
                path,
                verdict: 'undeterminable',
                probedRepo,
                error: `No gitlink commit recorded at '${path}' on ${args.branchRef}`,
            });
            continue;
        }
        let remoteMainBranch = 'main';
        try {
            remoteMainBranch = await resolveSubmoduleDefaultBranch({
                submoduleRepoPath: probedRepo,
                superprojectWorkspace: args.worktreeRoot,
                submodulePath: path,
            });
        } catch { /* fall back to 'main' */ }
        const verdict = await verifyRemoteBranchContainsCommit(runGit, probedRepo, commit, remoteMainBranch);
        if (verdict.state === 'contained') {
            entries.push({ path, commit, verdict: 'reachable', remoteMainBranch, probedRepo });
        } else if (verdict.state === 'absent') {
            entries.push({
                path, commit, verdict: 'unreachable', remoteMainBranch, probedRepo,
                error: `Submodule gitlink commit is not reachable from origin/${remoteMainBranch} (publish required before the root branch can merge).`,
            });
        } else {
            entries.push({
                path, commit, verdict: 'undeterminable', remoteMainBranch, probedRepo,
                error: `Reachability against origin/${remoteMainBranch} could not be determined (the submodule remote was not successfully consulted). This is NOT evidence the commit is unpublished.`,
            });
        }
    }

    const blocked = entries.filter(entry => entry.verdict !== 'reachable');
    const summary: MeshRefineSubmoduleReachabilityPreflight = {
        status: blocked.length ? 'warning' : 'passed',
        checked: entries.length,
        entries,
        durationMs: Date.now() - startedAt,
    };
    if (blocked.length) {
        // Reuse the execution-time message builder so the dry-run warning and the
        // execution failure read identically (tri-state preserved: undeterminable
        // entries get the "fix access" instruction, never the push prescription).
        const gateEntries: MeshRefineSubmoduleReachabilityEntry[] = blocked.map(entry => ({
            path: entry.path,
            commit: entry.commit || '',
            reachable: false,
            publishRequired: entry.verdict === 'unreachable',
            ...(entry.verdict === 'undeterminable' ? { remoteMainUndeterminable: true } : {}),
        }));
        summary.nextStep = buildSubmodulePublishRequiredNextStep(gateEntries);
    }
    return summary;
}

/**
 * Base ref for the dry-run plan, mirroring the batch planner's resolveBaseRef:
 * current branch of the repo root → best-effort `fetch origin` →
 * `origin/<branch>` → HEAD fallback. The fetch keeps the base ref (and thereby
 * the diff that decides "does this branch touch a submodule") fresh; it mutates
 * only remote-tracking refs.
 */
export async function resolveRefinePlanBaseRef(repoRoot: string): Promise<string> {
    let baseBranch = 'main';
    try {
        const { stdout } = await execFileAsync(GIT, ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' });
        if (stdout.trim()) baseBranch = stdout.trim();
    } catch { /* fall back to main */ }
    try {
        await execFileAsync(GIT, ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
    } catch { /* offline / no remote — fall through to local refs */ }
    try {
        const { stdout } = await execFileAsync(GIT, ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' });
        if (stdout.trim()) return stdout.trim();
    } catch { /* fall through to HEAD */ }
    try {
        const { stdout } = await execFileAsync(GIT, ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
        if (stdout.trim()) return stdout.trim();
    } catch { /* keep HEAD */ }
    return 'HEAD';
}

/**
 * Single-node convenience wrapper for the plan surfaces (mesh_refine_plan,
 * mesh_refine_node dry-run): resolves the node's repoRoot / branch / baseRef,
 * then runs {@link runMeshRefineSubmoduleReachabilityPreflight}. Returns
 * UNDEFINED when the node cannot be analyzed or touches no submodule — the
 * caller omits the field and the dry-run stays quiet. Never throws on git
 * errors: a preflight that cannot run must not break the dry-run it decorates.
 */
export async function planMeshRefineNodeSubmodulePreflight(args: {
    mesh: any;
    node: any;
    /** Known touched gitlink paths (batch change-area analysis); recomputed when omitted. */
    touchedSubmodulePaths?: string[];
}): Promise<MeshRefineSubmoduleReachabilityPreflight | undefined> {
    const { mesh, node } = args;
    const workspace = typeof node?.workspace === 'string' ? node.workspace : '';
    if (!workspace) return undefined;
    const allNodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    const sourceNode = node.clonedFromNodeId
        ? allNodes.find(n => meshNodeIdMatches(n, node.clonedFromNodeId))
        : allNodes.find(n => !n.isLocalWorktree);
    const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
    if (!repoRoot) return undefined;
    let branch = typeof node.worktreeBranch === 'string' ? node.worktreeBranch : '';
    try {
        const { stdout } = await execFileAsync(GIT, ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8' });
        if (stdout.trim()) branch = stdout.trim();
    } catch { /* use the stored worktreeBranch */ }
    if (!branch) return undefined;
    let branchRef = branch;
    try {
        const { stdout } = await execFileAsync(GIT, ['rev-parse', branch], { cwd: workspace, encoding: 'utf8' });
        branchRef = stdout.trim() || branch;
    } catch { /* use the branch name */ }
    const baseRef = await resolveRefinePlanBaseRef(repoRoot);
    return runMeshRefineSubmoduleReachabilityPreflight({
        worktreeRoot: workspace,
        baseRef,
        branchRef,
        ...(args.touchedSubmodulePaths ? { touchedSubmodulePaths: args.touchedSubmodulePaths } : {}),
    });
}

/**
 * The mesh_refine_batch dry-run result — the pre-2026-08-26 inline shape PLUS
 * the submodule reachability preflight for every node whose change area touches
 * a submodule gitlink. Lives here (not in router-refine.ts) because that file is
 * at its frozen file-size baseline; behavior otherwise unchanged.
 *
 * Per-node verdicts land on `changeAreas[nodeId].submoduleReachabilityPreflight`;
 * nodes with a 'warning' verdict are ALSO listed in the top-level
 * `submodulePreflightWarnings` so a coordinator sees the publish/converge
 * guidance without walking the map.
 */
export async function buildMeshRefineBatchDryRunResult(args: {
    mesh: any;
    orderedNodes: any[];
    ordering: MeshRefineBatchOrderingResult;
}): Promise<CommandRouterResult> {
    const { mesh, orderedNodes, ordering } = args;
    const warnings: string[] = [];
    for (const node of orderedNodes) {
        const area = ordering.changeAreas[node.id];
        // ★Scope: only submodule-touching nodes pay for the probe (one fetch +
        // one ancestry check per touched gitlink); everything else stays free.
        if (!area?.touchesSubmodule || area.error) continue;
        let preflight: MeshRefineSubmoduleReachabilityPreflight | undefined;
        try {
            preflight = await planMeshRefineNodeSubmodulePreflight({
                mesh,
                node,
                touchedSubmodulePaths: area.touchedSubmodulePaths,
            });
        } catch { /* best-effort: a preflight failure never breaks the dry-run */ }
        if (!preflight) continue;
        area.submoduleReachabilityPreflight = preflight;
        if (preflight.status === 'warning') {
            warnings.push(`Node ${area.nodeId}: submodule reachability preflight warns — ${preflight.nextStep || 'see changeAreas for details.'}`);
        }
    }
    return {
        success: true,
        batch: true,
        dryRun: true,
        nodeCount: orderedNodes.length,
        order: ordering.order,
        orderingRationale: ordering.rationale,
        changeAreas: ordering.changeAreas,
        plan: orderedNodes.map(node => ({
            nodeId: node.id,
            workspace: node.workspace,
            validationPlan: buildMeshRefineValidationPlan(mesh, node.workspace),
            mergeWillRun: false,
        })),
        ...(warnings.length ? { submodulePreflightWarnings: warnings } : {}),
        note: 'Dry-run: no validation, rebase, or merge was executed. Re-run with execute=true to converge nodes in this order.',
    };
}
