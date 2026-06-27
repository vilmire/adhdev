import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';

const execFileAsync = promisify(execFile);

// Fix (4): on win32 a bare `git` handed to execFile is resolved by libuv's spawn search,
// which appends only .com/.exe (no PATHEXT) and searches only the inherited PATH — so a
// `git.cmd`/`git.exe` that `where` finds is missed and the spawn ENOENTs. resolveWin32Executable
// (the same helper the validation/bootstrap spawn path already uses) resolves it to an absolute
// path once at module load. No-op on non-win32 (returns 'git' verbatim) — no quoting/shell risk.
const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git';

/**
 * Change-area analysis for one worktree node, used to order sibling nodes for
 * batch refinement so that nodes least likely to conflict merge first.
 *
 * The heuristic is deliberately git-only and side-effect-free: it inspects the
 * commits the node's branch adds on top of the base (`base..branch`) and records
 *   - whether any submodule gitlink path is touched (high-conflict signal: the
 *     batch must rebase later siblings onto the advanced submodule main), and
 *   - the set of changed top-level paths (so siblings touching disjoint trees can
 *     be ordered ahead of ones that overlap).
 */
export interface MeshRefineBatchNodeChangeArea {
    nodeId: string;
    workspace: string;
    branch: string;
    /** Top-level path segments changed by the branch vs. base (e.g. 'oss', 'packages'). */
    changedTopLevelPaths: string[];
    /** Full changed file list (bounded) for overlap detection. */
    changedFiles: string[];
    /** Submodule gitlink paths touched by the branch (subset of changedTopLevelPaths). */
    touchedSubmodulePaths: string[];
    /** True when the branch touches at least one submodule gitlink. */
    touchesSubmodule: boolean;
    /** Number of commits the branch is ahead of base; 0 means nothing to merge. */
    aheadCount: number;
    /** Non-fatal analysis error (e.g. base/branch unresolved); ordering falls back to neutral. */
    error?: string;
}

export interface MeshRefineBatchOrderingResult {
    /** Node IDs in the order they should be refined. */
    order: string[];
    /** Per-node change areas, keyed by node id, for plan transparency. */
    changeAreas: Record<string, MeshRefineBatchNodeChangeArea>;
    /** Human-readable explanation of why the order was chosen. */
    rationale: string[];
}

const MAX_CHANGED_FILES = 500;

function topLevel(path: string): string {
    const slash = path.indexOf('/');
    return slash === -1 ? path : path.slice(0, slash);
}

/**
 * Resolve the set of submodule gitlink paths declared in a repo's .gitmodules,
 * relative to the repo root. Used to classify which changed paths are submodule
 * pointer bumps vs. ordinary file edits.
 */
async function resolveSubmodulePaths(repoRoot: string): Promise<Set<string>> {
    try {
        const { stdout } = await execFileAsync(
            GIT,
            ['config', '--file', '.gitmodules', '--get-regexp', 'path'],
            { cwd: repoRoot, encoding: 'utf8' },
        );
        const paths = new Set<string>();
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Format: "submodule.<name>.path <path>"
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx === -1) continue;
            const value = trimmed.slice(spaceIdx + 1).trim();
            if (value) paths.add(value);
        }
        return paths;
    } catch {
        // No .gitmodules (or git error) → repo has no submodules to classify.
        return new Set();
    }
}

/**
 * Analyze one worktree node's change area against its merge base.
 *
 * @param baseRef  ref that the node will merge into (e.g. 'origin/main' or a SHA)
 * @param branchRef the node's branch tip
 * @param diffCwd  repo to run the diff in (the worktree itself is authoritative for
 *                 `branch` resolution, but the diff `base..branch` is symmetric, so
 *                 the worktree cwd works for both refs once base is a reachable SHA).
 */
export async function analyzeMeshRefineNodeChangeArea(args: {
    nodeId: string;
    workspace: string;
    branch: string;
    baseRef: string;
    branchRef: string;
    diffCwd: string;
    submodulePaths: Set<string>;
}): Promise<MeshRefineBatchNodeChangeArea> {
    const { nodeId, workspace, branch, baseRef, branchRef, diffCwd, submodulePaths } = args;
    const base: MeshRefineBatchNodeChangeArea = {
        nodeId,
        workspace,
        branch,
        changedTopLevelPaths: [],
        changedFiles: [],
        touchedSubmodulePaths: [],
        touchesSubmodule: false,
        aheadCount: 0,
    };
    try {
        // Use the merge-base so we compare only the node's own commits, not changes
        // that already landed on base via a sibling earlier in the batch.
        let mergeBase = baseRef;
        try {
            const { stdout } = await execFileAsync(GIT, ['merge-base', baseRef, branchRef], { cwd: diffCwd, encoding: 'utf8' });
            const resolved = stdout.trim();
            if (resolved) mergeBase = resolved;
        } catch { /* fall back to baseRef directly */ }

        const { stdout: countStdout } = await execFileAsync(
            GIT,
            ['rev-list', '--count', `${mergeBase}..${branchRef}`],
            { cwd: diffCwd, encoding: 'utf8' },
        );
        base.aheadCount = Number.parseInt(countStdout.trim(), 10) || 0;

        const { stdout: nameStdout } = await execFileAsync(
            GIT,
            ['diff', '--name-only', `${mergeBase}..${branchRef}`],
            { cwd: diffCwd, encoding: 'utf8' },
        );
        const files = nameStdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, MAX_CHANGED_FILES);
        base.changedFiles = files;
        const topSet = new Set<string>();
        const submoduleSet = new Set<string>();
        for (const file of files) {
            const top = topLevel(file);
            topSet.add(top);
            // A changed path is a submodule touch if the file path IS a declared
            // submodule path (gitlink bumps surface as the submodule path itself).
            if (submodulePaths.has(file) || submodulePaths.has(top)) {
                submoduleSet.add(submodulePaths.has(file) ? file : top);
            }
        }
        base.changedTopLevelPaths = [...topSet].sort();
        base.touchedSubmodulePaths = [...submoduleSet].sort();
        base.touchesSubmodule = submoduleSet.size > 0;
        return base;
    } catch (e: any) {
        base.error = e?.message || String(e);
        return base;
    }
}

/**
 * Order nodes for batch refinement to minimize cross-sibling conflicts.
 *
 * Heuristic (deterministic, stable):
 *   1. Nodes that do NOT touch any submodule come first — they cannot advance the
 *      submodule main, so they never force a later submodule rebase.
 *   2. Within each group, fewer touched top-level paths first (smaller blast radius).
 *   3. Tie-break by node id for determinism.
 *
 * Submodule-touching siblings are intrinsically serial: each one that merges
 * advances oss main, so the next must rebase. Ordering them last keeps the
 * non-submodule merges (which never need a submodule rebase) clean and up front.
 */
export function orderMeshRefineBatchNodes(
    changeAreas: MeshRefineBatchNodeChangeArea[],
): MeshRefineBatchOrderingResult {
    const areaById: Record<string, MeshRefineBatchNodeChangeArea> = {};
    for (const area of changeAreas) areaById[area.nodeId] = area;

    const ranked = [...changeAreas].sort((a, b) => {
        const aSub = a.touchesSubmodule ? 1 : 0;
        const bSub = b.touchesSubmodule ? 1 : 0;
        if (aSub !== bSub) return aSub - bSub;
        const aBreadth = a.changedTopLevelPaths.length;
        const bBreadth = b.changedTopLevelPaths.length;
        if (aBreadth !== bBreadth) return aBreadth - bBreadth;
        return a.nodeId.localeCompare(b.nodeId);
    });

    const rationale: string[] = [];
    const nonSub = ranked.filter(a => !a.touchesSubmodule).map(a => a.nodeId);
    const sub = ranked.filter(a => a.touchesSubmodule).map(a => a.nodeId);
    if (nonSub.length) {
        rationale.push(`Non-submodule nodes first (no submodule-main advance, conflict-free ordering): ${nonSub.join(', ')}`);
    }
    if (sub.length) {
        rationale.push(`Submodule-touching nodes last, serialized (each merge advances submodule main, forcing rebase of the next): ${sub.join(', ')}`);
    }
    for (const area of ranked) {
        if (area.error) rationale.push(`Node ${area.nodeId}: change-area analysis degraded (${area.error}); placed with neutral priority.`);
    }

    return { order: ranked.map(a => a.nodeId), changeAreas: areaById, rationale };
}
