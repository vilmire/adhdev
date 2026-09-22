/**
 * BASE preflight for the Refinery — run as the refine pipeline's first stage,
 * before sync_base and before every validation gate.
 *
 * ## The failure class this removes
 *
 * A refine job's gates run against the branch worktree, but the merge lands in
 * the SOURCE repo (the base checkout). When that base repo is unusable, every
 * gate still runs to completion and the job only fails at the very end, in the
 * merge stage. Measured 2026-09-22, four times in one day, all the same class:
 *
 *   1. Base had 3 stash entries          → `mesh_fast_forward_node` refused with
 *                                          `stash_entries_present`.
 *   2. Base worktree dirty (2 vendor
 *      sourcemaps)                       → a 3-node batch ran 3 x 35 gates to
 *                                          completion, then `merge_failed:
 *                                          "Your local changes would be
 *                                          overwritten"`. Node 1 could not
 *                                          advance the base, so nodes 2 and 3
 *                                          failed in cascade.
 *   3. Base committed without `git fetch` → root push missing + oss diverged →
 *                                          `base_moved` plus a validation
 *                                          failure, again cascading. (Only the
 *                                          DIVERGENCE is caught here — see
 *                                          collectRootFindings on why a base
 *                                          merely ahead of origin is normal.)
 *
 * In every case the answer was knowable in milliseconds, BEFORE any gate ran —
 * and in every case it was instead paid for with minutes of gate runtime across
 * several nodes.
 *
 * ## Why this is a separate module rather than more code in the router
 *
 * `router-refine.ts` sits on the file-size gate's frozen baseline, and the same
 * verdict is consumed from two places (the per-node pipeline stage and the batch
 * dry-run warning). Extracting it also makes the verdict independently testable
 * without standing up a router.
 *
 * ## Relationship to the checks that already exist
 *
 * Nothing here is a new POLICY — all three axes are already enforced somewhere,
 * just too late to be cheap:
 *
 *   - dirty / stash: `mesh-fast-forward.ts`'s `collectPushPreflightBlockers`
 *     already refuses exactly these, with these code names. This module reads
 *     the same `GitRepoStatus` fields and reuses the same vocabulary so a
 *     coordinator does not have to learn a second dialect for one condition.
 *   - stale / diverged base: the refine pipeline's own `base_cas` stage already
 *     detects it (`mesh-refine-base-cas.ts`) — but only immediately before the
 *     merge, i.e. after every gate has run. This module asks the same question
 *     before the gates.
 *
 * ## Where this runs, and why it is NOT on the accept path
 *
 * The blocking check is the refine pipeline's FIRST STAGE
 * (`refineBasePreflightStage` in router-refine.ts) — before `sync_base` and
 * before every validation gate.
 *
 * It was originally written as an accept-path refusal, which was wrong: accept
 * is contractually sub-250ms and node-count independent
 * (IPC-ACCEPT-ASYNC-BOUNDARY), and this probe measured ~55ms locally — enough to
 * blow that budget under concurrent load, which it demonstrably did (the
 * 'returns before long validation completes...' regression test in
 * mesh-refine-validation.test.ts, green on baseline, red with the check on the
 * accept path).
 *
 * Moving it into the pipeline costs nothing that matters: what the incidents
 * actually burned was the GATE RUN, and the stage still precedes every gate. The
 * batch case improves too — the first node's stage blocks in milliseconds, and
 * the chain abort (mesh-refine-batch-chain-abort.ts) then skips every remaining
 * node without a single gate.
 *
 * ## The probe is also split by COST
 *
 *   - dirty + stash are local reads and always run. They are what caught
 *     incidents 1 and 2, the two that burned full gate runs.
 *   - divergence needs a `git fetch` and is opt-in (`refreshUpstream`), used on
 *     the batch dry-run/plan path, which already fetches for ordering.
 *
 * See {@link RefineAcceptPreflightOptions} for why deferring the divergence axis
 * loses nothing: `base_cas` still refuses a moved base before the merge.
 *
 * `forceFresh` is always set: a TTL-cached snapshot from a concurrent
 * `mesh_status` probe cannot answer a gating question.
 */
import type { GitRepoStatus } from '../git/git-types.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { runGit } from '../git/git-executor.js';

/** Which axis made the base unusable. One code per remedy, not per symptom. */
export type RefineAcceptPreflightCode =
    /** Base worktree has staged/modified/deleted/renamed changes, or conflicts. */
    | 'base_worktree_dirty'
    /** Base repo (or a submodule) has stash entries. */
    | 'base_stash_entries_present'
    /**
     * Base and origin have both moved — neither is an ancestor of the other.
     *
     * ★Note there is deliberately no `base_ahead_of_origin`: a base holding
     * unpushed commits is the Refinery's normal steady state (it merges locally
     * and pushes afterwards, or not at all under push approval). See
     * collectRootFindings for the full reasoning.
     */
    | 'base_diverged_from_origin';

/** One repository's contribution to the verdict. */
export interface RefineAcceptPreflightRepoFinding {
    /** 'root' for the superproject, otherwise the submodule path ('oss', ...). */
    scope: string;
    /** Absolute path to the checkout this finding was measured in. */
    repoPath: string;
    code: RefineAcceptPreflightCode;
    /** Up to MAX_REPORTED_FILES offending paths — see `fileCount` for the true total. */
    files: string[];
    /** Total offending files, which may exceed `files.length`. */
    fileCount: number;
    /** Stash entries, when `code === 'base_stash_entries_present'`. */
    stashCount?: number;
    /** Most recent stash subject, when there is one. */
    latestStash?: string;
    /** Local HEAD, when the finding is on the ahead/diverged axis. */
    localHead?: string;
    /** origin/<branch> head, when the finding is on the ahead/diverged axis. */
    originHead?: string;
    ahead?: number;
    behind?: number;
    /** Human-readable remedy for THIS finding. */
    remedy: string;
}

export interface RefineAcceptPreflightVerdict {
    /** True when nothing blocks — the refine may proceed. */
    ok: boolean;
    /**
     * True when the base could not be inspected at all (no repo, git failure).
     * Treated as NON-blocking: see `assessRefineAcceptPreflight`'s contract.
     */
    indeterminate: boolean;
    findings: RefineAcceptPreflightRepoFinding[];
    /** Primary code, chosen by {@link chooseRefineAcceptPreflightCode}. */
    code?: RefineAcceptPreflightCode;
    /** Fully-rendered, coordinator-actionable message. Empty when `ok`. */
    message: string;
    /** Wall-clock cost of the probe. */
    durationMs: number;
}

/**
 * Cap on per-finding file names. A dirty base is usually dirty in a handful of
 * files; when it is dirty in hundreds, listing them all would bury the remedy
 * under a wall of paths. `fileCount` always carries the true total so the
 * message can say "and N more" rather than silently truncating.
 */
const MAX_REPORTED_FILES = 10;

/**
 * Budget for the probe. Bounds the git reads so an unresponsive repository
 * degrades to `indeterminate` rather than stalling the refine pipeline.
 */
const PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * ★Whether to refresh the upstream (i.e. run `git fetch`) as part of the probe.
 *
 * This is OFF by default, and the reason is cost rather than importance:
 *
 *   - The DIRTY and STASH axes are local reads and always run, in the pipeline's
 *     first stage. They are what caught incidents 1 and 2 — the two that actually
 *     burned 3 nodes x 35 gates.
 *   - The DIVERGENCE axis needs a `git fetch` (measured ~185ms on a trivial local
 *     repo, unbounded against a real remote), so it is opt-in and runs where a
 *     fetch is already being paid for: the batch dry-run/plan path, which is
 *     synchronous and already fetches to compute change-area ordering.
 *
 * Nothing is lost by deferring divergence: the pipeline's own `base_cas` stage
 * fetches and refuses on a moved base before the merge, exactly as it does today.
 * The preflight's job is to make the CHEAP failures cheap, not to duplicate a
 * check that already exists downstream.
 */
export interface RefineAcceptPreflightOptions {
    /** The SOURCE repo the merge will land in — not the branch worktree. */
    repoRoot: string;
    timeoutMs?: number;
    /**
     * Run `git fetch` so the ahead/behind divergence axis can be evaluated.
     * Defaults false — see the note above on why this axis is opt-in.
     */
    refreshUpstream?: boolean;
}

/**
 * Inspect the base repo (and its submodules) and decide whether a refine job
 * can usefully be accepted.
 *
 * ★Fails OPEN, deliberately. If the base cannot be inspected — not a git repo,
 * git unavailable, fetch timed out — the verdict is `indeterminate` and NOT a
 * block. This check exists to convert a slow, expensive failure into a fast,
 * cheap one; it must never become a new way for refine to be unavailable. A base
 * problem that survives an indeterminate verdict is still caught downstream by
 * `base_cas` and the merge stage exactly as it is today.
 *
 * `untracked` is deliberately NOT a blocker. It is the one dirty-state axis that
 * does not block a merge: git refuses to overwrite a tracked file it would have
 * to modify, but untracked files that no incoming commit touches are simply left
 * alone. `mesh-fast-forward.ts` blocks on them because a fast-forward is meant to
 * leave the tree pristine; a refine merge has no such requirement, and blocking
 * on untracked here would reject a base that every observed incident had in a
 * perfectly mergeable state. (Incident 2's blocker was MODIFIED tracked vendor
 * sourcemaps, not untracked files.)
 */
export async function assessRefineAcceptPreflight(
    params: RefineAcceptPreflightOptions,
): Promise<RefineAcceptPreflightVerdict> {
    const startedAt = Date.now();
    const { repoRoot } = params;
    const timeoutMs = params.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;

    let status: GitRepoStatus;
    try {
        status = await getGitRepoStatus(repoRoot, {
            includeSubmodules: true,
            // ★Off by default — a fetch is the expensive axis. See
            // RefineAcceptPreflightOptions for why deferring it loses nothing.
            refreshUpstream: params.refreshUpstream === true,
            // Live state only: a TTL-cached snapshot from a concurrent mesh_status
            // probe cannot answer a gating question.
            forceFresh: true,
            timeoutMs,
        });
    } catch {
        return indeterminate(startedAt);
    }

    if (!status.isGitRepo) return indeterminate(startedAt);

    const findings: RefineAcceptPreflightRepoFinding[] = [];
    findings.push(...collectRootFindings(status, repoRoot));
    findings.push(...collectSubmoduleFindings(status));

    // Name the offending files. `GitRepoStatus` carries COUNTS for the dirty axes
    // (only conflicts come with paths), and a count alone reproduces the very
    // failure mode this module exists to end — "the base is dirty" without saying
    // where. One extra porcelain read per blocked refine is a price worth paying
    // on a path that is, by definition, already refusing.
    await attachDirtyFileNames(findings, timeoutMs);

    if (findings.length === 0) {
        return { ok: true, indeterminate: false, findings: [], message: '', durationMs: Date.now() - startedAt };
    }

    const code = chooseRefineAcceptPreflightCode(findings);
    return {
        ok: false,
        indeterminate: false,
        findings,
        code,
        message: renderRefineAcceptPreflightMessage(findings),
        durationMs: Date.now() - startedAt,
    };
}

/**
 * Fill in `files` / `fileCount` for dirty findings, and the newest stash subject
 * for stash findings, by reading each offending checkout directly.
 *
 * Best-effort throughout: a finding whose detail cannot be read keeps the counts
 * it already has from `GitRepoStatus`. The BLOCK is decided by the status probe
 * above and never by this function — enrichment failing must not turn a real
 * blocker into a pass, nor a pass into a blocker.
 */
async function attachDirtyFileNames(
    findings: RefineAcceptPreflightRepoFinding[],
    timeoutMs: number,
): Promise<void> {
    await Promise.all(findings.map(async (finding) => {
        if (finding.code === 'base_worktree_dirty') {
            try {
                // `--porcelain` (v1) is deliberate: its `XY <path>` prefix is a fixed
                // 3-char cut, whereas v2 needs field-splitting per record type.
                // `--untracked-files=no` matches the blocking rule — untracked files
                // are not blockers, so they must not be listed as the reason either.
                const out = await runGit(finding.repoPath, ['status', '--porcelain', '--untracked-files=no'], { timeoutMs });
                const paths = (out.stdout || '')
                    .split('\n')
                    .map(line => line.slice(3).trim())
                    .filter(Boolean);
                if (paths.length > 0) {
                    finding.fileCount = paths.length;
                    finding.files = paths.slice(0, MAX_REPORTED_FILES);
                }
            } catch { /* keep the count-only finding */ }
            return;
        }
        if (finding.code === 'base_stash_entries_present') {
            try {
                const out = await runGit(finding.repoPath, ['stash', 'list', '-1', '--pretty=%gd: %s'], { timeoutMs });
                const latest = (out.stdout || '').split('\n')[0]?.trim();
                if (latest) finding.latestStash = latest;
            } catch { /* the count alone is already actionable */ }
        }
    }));
}

function indeterminate(startedAt: number): RefineAcceptPreflightVerdict {
    return { ok: true, indeterminate: true, findings: [], message: '', durationMs: Date.now() - startedAt };
}

/**
 * Root-repo findings. Dirtiness and stash are independent axes and a base can
 * be blocked on both at once, so each is reported as its own finding rather than
 * collapsed into a first-match-wins verdict — the remedies differ (`git
 * commit/stash` vs `git stash pop/drop`) and a coordinator that fixes only the
 * one it was told about would come straight back.
 */
function collectRootFindings(status: GitRepoStatus, repoPath: string): RefineAcceptPreflightRepoFinding[] {
    const findings: RefineAcceptPreflightRepoFinding[] = [];

    // Axis 1 — dirty tracked state. `untracked` is excluded on purpose (see the
    // function header of assessRefineAcceptPreflight).
    const dirtyCount = status.staged + status.modified + status.deleted + status.renamed;
    if (dirtyCount > 0 || status.hasConflicts) {
        const files = Array.isArray(status.conflictFiles) ? status.conflictFiles.slice(0, MAX_REPORTED_FILES) : [];
        findings.push({
            scope: 'root',
            repoPath,
            code: 'base_worktree_dirty',
            files,
            fileCount: status.hasConflicts ? Math.max(dirtyCount, files.length) : dirtyCount,
            remedy: 'Commit, stash, or discard the changes in the base checkout, then re-run refine.',
        });
    }

    // Axis 2 — stash entries.
    if (status.stashCount > 0) {
        findings.push({
            scope: 'root',
            repoPath,
            code: 'base_stash_entries_present',
            files: [],
            fileCount: 0,
            stashCount: status.stashCount,
            remedy: 'Resolve the stash entries in the base checkout (git stash pop / git stash drop), then re-run refine.',
        });
    }

    // Axis 3 — base vs origin. Only meaningful when the upstream was actually
    // refreshed: `upstreamStatus !== 'fresh'` means ahead/behind were computed
    // against a possibly-stale remote ref, which is precisely the reading that
    // made incident 3 invisible. Reporting a block on numbers we do not trust
    // would trade a missed detection for a false one, so an unrefreshed upstream
    // simply yields no finding on this axis.
    //
    // ★ONLY DIVERGENCE BLOCKS — a base merely AHEAD of origin does not.
    //
    // This was initially written to block plain-ahead too (incident 3 involved a
    // base with unpushed commits), and that was wrong. The Refinery merges into the
    // LOCAL base and pushes afterwards — and under `requireApprovalForPush` it does
    // not push at all — so a base holding commits origin has not seen is the
    // DESIGNED steady state, not a fault. mesh-refine-base-cas.ts states this
    // explicitly: "the local base routinely accumulates commits the pin has never
    // seen. That gap is the NORMAL steady state." Blocking on it would have refused
    // every refine on any mesh with push approval enabled.
    //
    // What actually broke in incident 3 was DIVERGENCE — local commits AND remote
    // commits with neither side an ancestor of the other — which no later stage can
    // reconcile automatically and which really does doom every node in the batch.
    // Plain-ahead is left to the existing machinery: sync_base rebases onto the base,
    // and base_cas re-checks it immediately before the merge.
    if (status.upstream && status.upstreamStatus === 'fresh' && status.ahead > 0 && status.behind > 0) {
        findings.push({
            scope: 'root',
            repoPath,
            code: 'base_diverged_from_origin',
            files: [],
            fileCount: 0,
            localHead: status.headCommit ?? undefined,
            ahead: status.ahead,
            behind: status.behind,
            remedy: `Base has diverged from ${status.upstream} (${status.ahead} local / ${status.behind} remote commit(s)); neither side is an ancestor of the other, so no rebase-and-retry can reconcile it. Resolve manually, then re-run refine.`,
        });
    }

    return findings;
}

/**
 * Submodule findings.
 *
 * Only the dirty axis is available here: `GitSubmoduleStatus` reports `dirty` /
 * `outOfSync` but carries no ahead/behind or stash counts, so a submodule's
 * relationship to ITS origin is out of scope for this check. That is a real
 * limit and not a silent one — incident 3's oss divergence is caught by the
 * pipeline's own submodule reachability gate, which measures exactly that.
 *
 * `outOfSync` alone (clean tree, gitlink merely points elsewhere) is NOT
 * reported: it is the ordinary state of a base checkout between a submodule
 * pointer bump and a `git submodule update`, it does not block a merge, and
 * `mesh-fast-forward.ts` explicitly tolerates it under the same reasoning.
 */
function collectSubmoduleFindings(status: GitRepoStatus): RefineAcceptPreflightRepoFinding[] {
    const submodules = Array.isArray(status.submodules) ? status.submodules : [];
    const findings: RefineAcceptPreflightRepoFinding[] = [];
    for (const submodule of submodules) {
        if (!submodule.dirty) continue;
        findings.push({
            scope: submodule.path,
            repoPath: submodule.repoPath || submodule.path,
            code: 'base_worktree_dirty',
            files: [],
            fileCount: 0,
            remedy: `Commit, stash, or discard the uncommitted changes in the '${submodule.path}' submodule of the base checkout, then re-run refine.`,
        });
    }
    return findings;
}

/**
 * The primary code when several axes block at once.
 *
 * Ordered by how much work the remedy is, cheapest first: a dirty tree or a
 * stash is a local, one-command fix, whereas a diverged base needs a human
 * decision. Naming the cheap blocker first means a coordinator that fixes one
 * thing and retries makes progress, rather than being sent to resolve a
 * divergence while a stray modified file would have blocked it anyway.
 */
export function chooseRefineAcceptPreflightCode(
    findings: RefineAcceptPreflightRepoFinding[],
): RefineAcceptPreflightCode | undefined {
    const order: RefineAcceptPreflightCode[] = [
        'base_worktree_dirty',
        'base_stash_entries_present',
        'base_diverged_from_origin',
    ];
    for (const code of order) {
        if (findings.some(f => f.code === code)) return code;
    }
    return findings[0]?.code;
}

/**
 * Render the verdict as the message a coordinator acts on.
 *
 * Deliberately names the repository, the files and the SHAs rather than
 * reporting "base is dirty": the four incidents this check comes from each cost
 * a round of investigation precisely because the failure said what was wrong
 * without saying where.
 */
export function renderRefineAcceptPreflightMessage(findings: RefineAcceptPreflightRepoFinding[]): string {
    const lines: string[] = [
        'Refine was refused BEFORE running any gates: the base checkout the merge would land in is not in a mergeable state.',
    ];
    for (const finding of findings) {
        const where = finding.scope === 'root' ? 'root repo' : `submodule '${finding.scope}'`;
        const detail: string[] = [];
        if (finding.fileCount > 0) {
            detail.push(`${finding.fileCount} file(s)`);
            if (finding.files.length > 0) {
                const shown = finding.files.join(', ');
                const more = finding.fileCount - finding.files.length;
                detail.push(more > 0 ? `[${shown}, +${more} more]` : `[${shown}]`);
            }
        }
        if (finding.stashCount !== undefined) {
            detail.push(`${finding.stashCount} stash entry/entries`);
            if (finding.latestStash) detail.push(`latest: ${finding.latestStash}`);
        }
        if (finding.ahead !== undefined && finding.ahead > 0) detail.push(`ahead ${finding.ahead}`);
        if (finding.behind !== undefined && finding.behind > 0) detail.push(`behind ${finding.behind}`);
        if (finding.localHead) detail.push(`local ${finding.localHead.slice(0, 7)}`);
        if (finding.originHead) detail.push(`origin ${finding.originHead.slice(0, 7)}`);
        lines.push(
            `  - [${finding.code}] ${where} (${finding.repoPath})`
            + (detail.length ? `: ${detail.join(' ')}` : '')
            + `\n      → ${finding.remedy}`,
        );
    }
    lines.push('No gates were run and nothing was dispatched, so nothing needs to be undone.');
    return lines.join('\n');
}

/**
 * The refusal result shape.
 *
 * `success: false` with no `async`/`jobId`: the coordinator must be able to tell
 * this apart from an accepted job at a glance, because the remedy is the
 * opposite one — act now, rather than wait for a terminal event.
 */
export function buildRefineAcceptPreflightRefusal(params: {
    verdict: RefineAcceptPreflightVerdict;
    meshId: string;
    /** Node id for single-node refine; omitted for a batch. */
    nodeId?: string;
}): { success: false;[key: string]: unknown } {
    const { verdict, meshId, nodeId } = params;
    return {
        success: false,
        code: verdict.code ?? 'base_preflight_blocked',
        error: verdict.message,
        basePreflight: {
            blocked: true,
            code: verdict.code,
            findings: verdict.findings,
            durationMs: verdict.durationMs,
        },
        meshId,
        ...(nodeId ? { nodeId, targetNodeId: nodeId } : {}),
        convergenceStatus: 'blocked_review',
        retryable: true,
        nextStep: 'Fix the base checkout as described, then re-run refine. Nothing was dispatched.',
    };
}

/**
 * Resolve the SOURCE repo a worktree node's merge will land in.
 *
 * Mirrors the resolution already used by `recordRefineAcceptBaseDivergence` and
 * the batch planner: a cloned worktree names its origin node via
 * `clonedFromNodeId`, and anything else falls back to the mesh's first
 * non-worktree node. Returns undefined when neither resolves, which the caller
 * must treat as "cannot check" rather than "nothing wrong".
 */
export function resolveRefineBaseRepoRoot(params: {
    node: any;
    nodes: any[];
    nodeIdMatches: (candidate: any, id: string) => boolean;
}): string | undefined {
    const { node, nodes, nodeIdMatches } = params;
    const sourceNode = node?.clonedFromNodeId
        ? nodes.find((n: any) => nodeIdMatches(n, node.clonedFromNodeId))
        : nodes.find((n: any) => !n?.isLocalWorktree);
    const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
    return typeof repoRoot === 'string' && repoRoot.trim() ? repoRoot.trim() : undefined;
}

/**
 * The dry-run counterpart: same verdict, rendered as a WARNING rather than a
 * refusal.
 *
 * A dry-run's product is the plan, and a plan is still worth having on a dirty
 * base — but a coordinator that reads a clean plan and then calls execute would
 * walk straight into the refusal. Surfacing the same finding here turns that
 * into something it can fix first.
 */
export function buildRefineAcceptPreflightWarning(verdict: RefineAcceptPreflightVerdict): Record<string, unknown> {
    return {
        basePreflightWarning: {
            code: verdict.code,
            findings: verdict.findings,
            message: verdict.message,
            wouldBlockExecute: true,
            durationMs: verdict.durationMs,
        },
    };
}
