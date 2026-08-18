/**
 * GRAPH-ORCHESTRATION Phase D — compensation safety classification.
 *
 * Design :493-506, :832-833, :994-995.
 *
 * Compensation may delete a worktree ONLY when every check below passes.
 * If any check fails — or the inspector cannot tell — the worktree is left
 * in place, the intent/graph become `compensation_required`, and the
 * coordinator is notified with the evidence. Classification is a pure
 * function over an inspection report so tests can pin each refusal without
 * touching a real checkout.
 *
 * ★ Never delete a dirty, ahead, stashed, session-bound, unowned, or
 *   ambiguous worktree during compensation.
 */

export const WORKSPACE_DELETE_REFUSALS = [
    'dirty',
    'ahead',
    'stashed',
    'session_bound',
    'unowned',
    'ambiguous',
    'assigned_task',
    'dependent_graph_ref',
] as const;

export type WorkspaceDeleteRefusal = typeof WORKSPACE_DELETE_REFUSALS[number];

/** Facts gathered OUTSIDE any SQLite transaction. */
export interface WorkspaceInspectReport {
    pathExists: boolean;
    /** Owner tag read from the worktree (git config) or node metadata. */
    observedOwnerTag?: string;
    dirty: boolean;
    /** Commits present that are not contained in the recorded base revision. */
    ahead: boolean;
    aheadCount?: number;
    stashed: boolean;
    stashCount?: number;
    /** Live/starting/generating/waiting/idle sessions on the created node. */
    sessionBound: boolean;
    sessionIds?: string[];
    /** Session inventory could not be verified — fail closed. */
    sessionInventoryUnknown?: boolean;
    sessionInventoryError?: string;
    assignedTaskIds?: string[];
    dependentGraphRefs?: Array<{ graphId: string; workspaceRef: string }>;
    inspectFailed?: boolean;
    inspectError?: string;
    ambiguous?: boolean;
    ambiguityReason?: string;
}

export interface WorkspaceSafetyInput {
    expectedOwnerTag?: string;
    inspect: WorkspaceInspectReport;
}

export interface WorkspaceSafetySnapshot {
    /** True only when every refusal is absent. A missing worktree is vacuously deletable. */
    deletable: boolean;
    refusals: WorkspaceDeleteRefusal[];
    evidence: Record<string, unknown>;
}

/**
 * Pure classifier. A missing path is not a refusal — compensation of an
 * already-gone worktree is the idempotent success path (design :504).
 */
export function classifyWorkspaceCompensationSafety(input: WorkspaceSafetyInput): WorkspaceSafetySnapshot {
    const refusals: WorkspaceDeleteRefusal[] = [];
    const evidence: Record<string, unknown> = {};
    const report = input.inspect;

    if (report.inspectFailed) {
        refusals.push('ambiguous');
        evidence.inspectFailed = true;
        if (report.inspectError) evidence.inspectError = report.inspectError;
    }
    if (report.ambiguous) {
        if (!refusals.includes('ambiguous')) refusals.push('ambiguous');
        if (report.ambiguityReason) evidence.ambiguityReason = report.ambiguityReason;
    }

    // Already-gone is the idempotent success path. Session/owner probes do not
    // apply once there is no directory left to delete.
    if (!report.pathExists && refusals.length === 0) {
        return { deletable: true, refusals: [], evidence: { pathExists: false, alreadyGone: true } };
    }

    if (report.sessionInventoryUnknown) {
        if (!refusals.includes('ambiguous')) refusals.push('ambiguous');
        evidence.sessionInventoryUnknown = true;
        if (report.sessionInventoryError) evidence.sessionInventoryError = report.sessionInventoryError;
    }

    if (report.pathExists) {
        const expected = typeof input.expectedOwnerTag === 'string' ? input.expectedOwnerTag.trim() : '';
        const observed = typeof report.observedOwnerTag === 'string' ? report.observedOwnerTag.trim() : '';
        if (!expected || !observed || expected !== observed) {
            refusals.push('unowned');
            evidence.expectedOwnerTag = expected || null;
            evidence.observedOwnerTag = observed || null;
        }
    }

    if (report.dirty) {
        refusals.push('dirty');
        evidence.dirty = true;
    }
    if (report.ahead) {
        refusals.push('ahead');
        evidence.ahead = true;
        if (typeof report.aheadCount === 'number') evidence.aheadCount = report.aheadCount;
    }
    if (report.stashed) {
        refusals.push('stashed');
        evidence.stashed = true;
        if (typeof report.stashCount === 'number') evidence.stashCount = report.stashCount;
    }
    if (report.sessionBound) {
        refusals.push('session_bound');
        evidence.sessionBound = true;
        if (report.sessionIds?.length) evidence.sessionIds = report.sessionIds;
    }
    if (report.assignedTaskIds && report.assignedTaskIds.length > 0) {
        refusals.push('assigned_task');
        evidence.assignedTaskIds = report.assignedTaskIds;
    }
    if (report.dependentGraphRefs && report.dependentGraphRefs.length > 0) {
        refusals.push('dependent_graph_ref');
        evidence.dependentGraphRefs = report.dependentGraphRefs;
    }

    evidence.pathExists = report.pathExists;
    return { deletable: refusals.length === 0, refusals, evidence };
}
