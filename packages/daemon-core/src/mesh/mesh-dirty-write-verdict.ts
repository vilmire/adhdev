/**
 * Dirty-workspace rule for WRITE dispatches — fixed per node type, no policy knob
 * (docs/design/2026-10-07-mesh-workspace-policy.md §B).
 *
 * One write task per node means an idle node's dirt is LEFTOVER, not a concurrent
 * edit:
 *   - base node      — almost always the user's own edits (the coordinator's checkout
 *                      included). A write dispatch is refused; per-dispatch escape
 *                      hatch: direct send `allow_stale_node`.
 *   - worktree node  — the previous task's uncommitted output on THAT branch (or a
 *                      bootstrap by-product). Expected state for a follow-up on the
 *                      same branch (review → fix, a retry) → `branch_continuation`;
 *                      contamination for anything else → refused.
 *
 * | node     | dirty? | task                                   | verdict             |
 * |----------|--------|----------------------------------------|---------------------|
 * | any      | no / readonly task                       | —     | proceed             |
 * | base     | yes    | write                                  | refuse              |
 * | worktree | yes    | write bound to it (target / worktree=) | branch_continuation |
 * | worktree | yes    | write, unbound or another branch       | refuse              |
 *
 * The claim path (mesh-runtime-store-claim.ts via nodeGitGate), auto-launch
 * (mesh-queue-autolaunch.ts) and the direct send tool (mcp-server
 * mesh-tools-send-task.ts) all decide through this module, so the three can never
 * drift apart. The daemon never commits on its own behalf to clean a tree.
 *
 * Pure leaf: no daemon/config imports, so the DB-layer claim store can use it.
 */
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeMeshNodeId } from '@adhdev/mesh-shared';
import { isTaskReadonly } from './mesh-task-predicates.js';

export type DirtyWriteVerdict = 'proceed' | 'branch_continuation' | 'refuse';

/** The node facts the verdict needs, resolved by the caller from the node record. */
export interface DirtyWriteGate {
    /** Positive git telemetry that the node's working tree is dirty (fail-open: absent = clean). */
    dirty: boolean;
    /** Set only for a worktree node (`isLocalWorktree === true` with a branch). */
    worktreeBranch?: string;
    /** The node's id, for `targetNodeId` binding. */
    nodeId?: string;
}

/** The task facts the verdict needs. */
export interface DirtyWriteTask {
    readonly?: boolean;
    taskMode?: string;
    targetNodeId?: string;
    requiredTags?: unknown;
}

/** Dirty working tree per the node's git telemetry (health 'dirty' or git.dirty). */
export function isDirtyNode(node: any): boolean {
    return node?.health === 'dirty' || node?.git?.dirty === true;
}

/** A worktree node's branch, or undefined for a base node. */
export function readWorktreeNodeBranch(node: any): string | undefined {
    if (node?.isLocalWorktree !== true) return undefined;
    const branch = typeof node?.worktreeBranch === 'string' ? node.worktreeBranch.trim() : '';
    return branch || undefined;
}

/** Resolve the gate facts from a node record. */
export function readDirtyWriteGate(node: any): DirtyWriteGate {
    const worktreeBranch = readWorktreeNodeBranch(node);
    const nodeId = normalizeMeshNodeId(node) || undefined;
    return {
        dirty: isDirtyNode(node),
        ...(worktreeBranch ? { worktreeBranch } : {}),
        ...(nodeId ? { nodeId } : {}),
    };
}

/** True when the task is bound to this worktree: pinned to the node, or `worktree=<branch>` required. */
export function isTaskBoundToWorktree(gate: DirtyWriteGate, task: DirtyWriteTask): boolean {
    if (!gate.worktreeBranch) return false;
    const target = typeof task.targetNodeId === 'string' ? task.targetNodeId.trim() : '';
    if (target && gate.nodeId && (daemonIdsEquivalent(target, gate.nodeId) || meshNodeIdMatches({ id: target }, gate.nodeId))) {
        return true;
    }
    const wanted = `worktree=${gate.worktreeBranch}`;
    return Array.isArray(task.requiredTags)
        && task.requiredTags.some(tag => typeof tag === 'string' && tag.trim() === wanted);
}

/** The verdict from already-resolved gate facts (the claim store's form). */
export function dirtyWriteVerdict(gate: DirtyWriteGate, task: DirtyWriteTask): DirtyWriteVerdict {
    if (!gate.dirty || isTaskReadonly(task)) return 'proceed';
    if (!gate.worktreeBranch) return 'refuse';
    return isTaskBoundToWorktree(gate, task) ? 'branch_continuation' : 'refuse';
}

/** The verdict for a node record and a task — the shared entry point. */
export function resolveDirtyWriteVerdict(node: any, task: DirtyWriteTask): DirtyWriteVerdict {
    return dirtyWriteVerdict(readDirtyWriteGate(node), task);
}

/** Refusal wording that names WHY (base edits vs an unbound task on a dirty worktree). */
export function describeDirtyWriteRefusal(gate: DirtyWriteGate, nodeLabel: string): string {
    return gate.worktreeBranch
        ? `node ${nodeLabel} is a dirty worktree; task not bound to branch ${gate.worktreeBranch} (pin it with required_tags ["worktree=${gate.worktreeBranch}"] or target the node)`
        : `node ${nodeLabel} is a dirty base node (uncommitted user edits)`;
}

/**
 * One line appended to a `branch_continuation` task's message so the worker knows
 * the leftovers are its branch's own unfinished work and must be committed.
 */
export function buildBranchContinuationNotice(branch: string, changedFileCount?: number): string {
    const count = typeof changedFileCount === 'number' && changedFileCount > 0 ? `${changedFileCount} ` : '';
    return `[Workspace] Branch ${branch} has ${count}uncommitted change(s) left by earlier work on this branch — continue from them and commit before you finish (Refinery refuses to merge a branch worktree with uncommitted changes).`;
}
