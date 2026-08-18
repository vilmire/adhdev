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
import { readWorkspaceRefFromSpec, workspaceWorktreeAffinityTag } from './mesh-graph-workspace-identity.js';

export type WorkspaceMaterializeBinding =
    | { kind: 'none' }
    | { kind: 'unresolved'; workspaceRef: string }
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
