/**
 * GRAPH-ORCHESTRATION Phase D — delayed workspace_ref resolution for
 * materialization. The transition runner (B) calls this to bind a ready
 * workspace or stay blocked; it does NOT evaluate inputs_from / run_if
 * (those remain C1).
 *
 * Design :468-473: a task using an unresolved workspace_ref stays pending
 * with a graph-owned block and without a target. Once the saga records a
 * live node id, materialization binds targetNodeId + worktree=<branch> tag.
 */

import type { MeshGraphStore } from './mesh-graph-store.js';
import type { MeshGraphWorkspaceSagaState } from './mesh-graph-types.js';
import { readWorkspaceRefFromSpec, workspaceWorktreeAffinityTag } from './mesh-graph-workspace-identity.js';

/**
 * Saga states from which the intent can NEVER reach `ready` again
 * (mesh-graph-workspace-saga.ts :14-16 — `failed`, `compensated`,
 * `compensation_required` have no outgoing transition).
 *
 * This set is the whole point of the `dead` verdict below: `unresolved` means
 * "not ready YET" and is answered by waiting, while these mean "not ready
 * EVER" and waiting is the wrong answer forever. Collapsing the two — which is
 * what a bare `sagaState !== 'ready'` test does — parks every node that named a
 * dead workspace in `pending` for the life of the graph.
 */
const TERMINAL_SAGA_STATES: readonly MeshGraphWorkspaceSagaState[] = [
    'failed',
    'compensated',
    'compensation_required',
];

export function isTerminalWorkspaceSagaState(state: MeshGraphWorkspaceSagaState | undefined): boolean {
    return state !== undefined && TERMINAL_SAGA_STATES.includes(state);
}

export type WorkspaceMaterializeBinding =
    | { kind: 'none' }
    | { kind: 'unresolved'; workspaceRef: string }
    | { kind: 'dead'; workspaceRef: string; sagaState: MeshGraphWorkspaceSagaState; lastError?: string }
    | { kind: 'ready'; workspaceRef: string; nodeId: string; worktreeTag?: string };

export function resolveWorkspaceRefForMaterialize(
    graphStore: MeshGraphStore,
    graphId: string,
    baseSpec: unknown,
): WorkspaceMaterializeBinding {
    const workspaceRef = readWorkspaceRefFromSpec(baseSpec);
    if (!workspaceRef) return { kind: 'none' };
    const intent = graphStore.getWorkspaceIntent(graphId, workspaceRef);
    const nodeId = typeof intent?.createdNodeId === 'string' ? intent.createdNodeId.trim() : '';
    // A terminal saga is reported BEFORE the readiness test, so a dead intent is
    // never mistaken for one that is merely still preparing. Note `compensated`
    // may still carry a createdNodeId (the id the tree HAD before it was
    // removed) — binding to it would target a path that no longer exists, so
    // the terminal check must come first regardless of the recorded node id.
    if (intent && isTerminalWorkspaceSagaState(intent.sagaState)) {
        return {
            kind: 'dead',
            workspaceRef,
            sagaState: intent.sagaState,
            ...(intent.lastError ? { lastError: intent.lastError } : {}),
        };
    }
    if (!intent || intent.sagaState !== 'ready' || !nodeId) {
        return { kind: 'unresolved', workspaceRef };
    }
    const branch = typeof intent.branchIdentity === 'string' && intent.branchIdentity.trim()
        ? intent.branchIdentity.trim()
        : undefined;
    return {
        kind: 'ready',
        workspaceRef,
        nodeId,
        ...(branch ? { worktreeTag: workspaceWorktreeAffinityTag(branch) } : {}),
    };
}

export function mergeWorktreeAffinityTag(existing: string[] | undefined, tag: string | undefined): string[] | undefined {
    if (!tag) return existing;
    const tags = Array.isArray(existing) ? existing.filter(t => typeof t === 'string' && t.trim()) : [];
    if (!tags.includes(tag)) tags.push(tag);
    return tags;
}
