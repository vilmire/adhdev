import { describe, expect, it } from 'vitest';
import {
    classifyWorkspaceCompensationSafety,
    WORKSPACE_DELETE_REFUSALS,
    type WorkspaceInspectReport,
} from '../../src/mesh/mesh-graph-workspace-safety.js';

// GRAPH-ORCHESTRATION Phase D — compensation safety classifier (design :994-995).
// Pure function: each refusal is pinned so a later "just delete it" edit goes red.

const OWNED: WorkspaceInspectReport = {
    pathExists: true,
    observedOwnerTag: 'tag-1',
    dirty: false,
    ahead: false,
    stashed: false,
    sessionBound: false,
};

describe('workspace compensation safety classifier (design :994-995)', () => {
    it('pins the refusal vocabulary', () => {
        expect([...WORKSPACE_DELETE_REFUSALS]).toEqual([
            'dirty', 'ahead', 'stashed', 'session_bound', 'unowned', 'ambiguous',
            'assigned_task', 'dependent_graph_ref',
        ]);
    });

    it('allows delete only for a clean, owned, unoccupied worktree', () => {
        const snap = classifyWorkspaceCompensationSafety({ expectedOwnerTag: 'tag-1', inspect: OWNED });
        expect(snap.deletable).toBe(true);
        expect(snap.refusals).toEqual([]);
    });

    it('treats an already-gone path as the idempotent success path', () => {
        const snap = classifyWorkspaceCompensationSafety({
            expectedOwnerTag: 'tag-1',
            inspect: { pathExists: false, dirty: false, ahead: false, stashed: false, sessionBound: false },
        });
        expect(snap.deletable).toBe(true);
        expect(snap.evidence.alreadyGone).toBe(true);
    });

    it.each([
        ['dirty', { dirty: true }, 'dirty'],
        ['ahead', { ahead: true, aheadCount: 2 }, 'ahead'],
        ['stashed', { stashed: true, stashCount: 1 }, 'stashed'],
        ['session-bound', { sessionBound: true, sessionIds: ['sess-1'] }, 'session_bound'],
        ['unowned (mismatch)', { observedOwnerTag: 'other' }, 'unowned'],
        ['unowned (missing tag)', { observedOwnerTag: undefined }, 'unowned'],
        ['ambiguous inspect failure', { inspectFailed: true, inspectError: 'git died' }, 'ambiguous'],
        ['ambiguous explicit', { ambiguous: true, ambiguityReason: 'two worktrees' }, 'ambiguous'],
        ['session inventory unknown', { sessionInventoryUnknown: true }, 'ambiguous'],
        ['assigned task', { assignedTaskIds: ['task-1'] }, 'assigned_task'],
        ['dependent graph ref', { dependentGraphRefs: [{ graphId: 'g2', workspaceRef: 'other' }] }, 'dependent_graph_ref'],
    ] as const)('refuses to delete a %s worktree', (_label, override, refusal) => {
        const snap = classifyWorkspaceCompensationSafety({
            expectedOwnerTag: 'tag-1',
            inspect: { ...OWNED, ...override },
        });
        expect(snap.deletable, `expected ${_label} to be non-deletable`).toBe(false);
        expect(snap.refusals).toContain(refusal);
    });
});
