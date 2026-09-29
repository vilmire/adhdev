/**
 * Coordinator repair of a pending graph node: patching the permitted base-spec keys
 * (run_if / on_false / inputs_from / workspace_ref) and retrying the node, plus the
 * re-materialization of every pending node bound to a workspace that was repaired.
 * A node's message, routing, permissions, task mode and model stay immutable.
 */
import { newMeshGraphOutboxId, type MeshTaskGraphNodeRow, type MeshGraphNodeState, type MeshTaskGraphRow } from './mesh-graph-types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { safeParseJson, settleDownstreamNode, type SettleOutcome } from './mesh-graph-transition-runner.js';
import { resolveWorkspaceRefForMaterialize } from './mesh-graph-workspace-bind.js';
import { drainMeshGraphOutbox } from './mesh-graph-outbox.js';
import { parseInputBindings } from './mesh-graph-input-binding.js';

/**
 * Pre-assignment node patch guard (design :285, :332-334): a coordinator may patch a
 * STILL-PENDING node's spec (selector/size policy), but an assigned task is
 * immutable — a patch attempt after assignment fails with `task_already_claimed`.
 * The patch bumps materialization_version so digests computed from the pre-patch
 * spec can never win a later CAS.
 */
export function patchPendingGraphNodeBaseSpec(graphId: string, nodeId: string, baseSpecJson: string): MeshTaskGraphNodeRow {
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() => {
        const graphStore = store.graphStore();
        const node = graphStore.getNode(graphId, nodeId);
        if (!node) {
            throw new Error(`graph_node_not_found: no node '${nodeId}' in graph '${graphId}'`);
        }
        if (node.queueTaskId) {
            const entry = store.findQueueEntryById(node.meshId, node.queueTaskId);
            if (entry && entry.status !== 'pending') {
                throw new Error(
                    `task_already_claimed: graph node '${nodeId}' backs queue task '${node.queueTaskId}' `
                    + `which is '${entry.status}' — an assigned/completed task is immutable (design :334)`,
                );
            }
        }
        graphStore.updateNodeBaseSpec(graphId, nodeId, baseSpecJson, new Date().toISOString());
        return graphStore.getNode(graphId, nodeId)!;
    });
}

/**
 * Phase D activation: after a workspace intent becomes `ready`, retry identity
 * materialization for still-declared/blocked worker nodes that name that
 * workspace_ref. Uses the same CAS / graph-block rules as the terminal path.
 * Does not evaluate inputs_from / run_if (C1).
 */
export function rematerializePendingGraphNodesForWorkspace(graphId: string, workspaceRef: string): string[] {
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date().toISOString();
    const result = store.transaction(() => {
        const graphStore = store.graphStore();
        const graph = graphStore.getGraph(graphId);
        if (!graph) return { meshId: null as string | null, materialized: [] as string[] };
        const nodes = graphStore.listNodes(graphId);
        const edges = graphStore.listEdges(graphId);
        const byId = new Map(nodes.map(n => [n.nodeId, n]));
        const materialized: string[] = [];
        for (const target of nodes) {
            if (target.kind !== 'worker_task' || !target.queueTaskId) continue;
            if (target.state !== 'declared' && target.state !== 'blocked') continue;
            const spec = safeParseJson(target.baseSpecJson);
            const bind = resolveWorkspaceRefForMaterialize(graphStore, graphId, spec);
            if (bind.kind === 'none' || bind.workspaceRef !== workspaceRef) continue;
            const outcome = settleDownstreamNode(store, target, edges, byId, nowIso);
            if (outcome.kind === 'materialized') {
                materialized.push(target.nodeId);
                graphStore.insertOutboxEvent({
                    id: newMeshGraphOutboxId(),
                    meshId: graph.meshId,
                    graphId,
                    kind: 'graph_node_materialized',
                    payload: JSON.stringify({
                        graphId, nodeId: target.nodeId, ref: target.ref,
                        taskId: target.queueTaskId, reason: 'workspace_ready',
                    }),
                    status: 'pending',
                    attemptCount: 0,
                    createdAt: nowIso,
                    updatedAt: nowIso,
                });
            }
        }
        if (materialized.length > 0) {
            graphStore.insertOutboxEvent({
                id: newMeshGraphOutboxId(),
                meshId: graph.meshId,
                graphId,
                kind: 'queue_wake',
                payload: JSON.stringify({ meshId: graph.meshId, reason: 'workspace_ready', graphId }),
                status: 'pending',
                attemptCount: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
            });
        }
        return { meshId: graph.meshId, materialized };
    });
    if (result.meshId) {
        try { drainMeshGraphOutbox(result.meshId); } catch { /* drain is best-effort */ }
    }
    return result.materialized;
}

// ── Coordinator node patch + retry (M-GRAPH-INPUTS-LATE-REJECT) ──────────────

/**
 * The spec keys a coordinator patch may touch (design :294-299).
 *
 * Declared HERE rather than imported from `mesh-graph-gates`, which already
 * imports this module — `MESH_GATE_RELEASE_PATCH_KEYS` is re-exported from this
 * constant so the gate-release path and the node-patch path cannot drift apart
 * while the dependency direction stays one-way.
 */
export const MESH_NODE_PATCH_KEYS = ['run_if', 'on_false', 'inputs_from', 'workspace_ref'] as const;

export interface PatchGraphNodeAndRetryInput {
    meshId: string;
    graphId?: string;
    /** Node id or `ref` of the node to patch. */
    node: string;
    /** Keys merged into the node's base spec; only {@link MESH_NODE_PATCH_KEYS} are permitted. */
    baseSpecPatch: Record<string, unknown>;
}

export interface PatchGraphNodeAndRetryResult {
    graphId: string;
    nodeId: string;
    ref?: string;
    queueTaskId?: string;
    materializationVersion: number;
    /** State after the retry settle. */
    state: MeshGraphNodeState;
    /** The retry's outcome, so the caller learns IN THIS CALL whether the patch actually worked. */
    outcome: SettleOutcome;
    /** The queue row's block after the retry; absent means the task is claimable again. */
    blockedReason?: string;
}

/**
 * Patch a still-pending graph node's spec and immediately RE-SETTLE it.
 *
 * ★ WHY THIS EXISTS: `blockWithMaterializationError` has always documented the
 * contract "the coordinator may then patch the node's selector/size policy
 * (bumping the generation) and retry", and `patchPendingGraphNodeBaseSpec`
 * implemented it — with a passing regression test. But that function had NO
 * production caller and no tool wrapping it, so the contract was reachable only
 * from a unit test that imported it directly. Live, a node blocked on
 * `materialization_error:*` was unrecoverable: the only patch surface was
 * the gate release (`mesh_graph_gate` action=release), which demands a CLAIMED GATE and a DIRECT gate
 * edge, so a plain `inputs_from` node with no gate could not be patched at all.
 * The graph re-settle loop does retry such a node on every later upstream
 * terminal, but it re-reads the SAME baked spec and so fails identically
 * forever. This is the missing write surface, not new recovery logic.
 *
 * Invariants preserved verbatim from the gate-release patch path:
 *   - only {@link MESH_NODE_PATCH_KEYS} may be patched — message, routing,
 *     permissions, task mode and model stay immutable by policy;
 *   - an ASSIGNED/terminal task is immutable (`task_already_claimed`);
 *   - the write bumps `materialization_version`, so any digest computed from the
 *     pre-patch spec can never win a later CAS.
 *
 * The retry runs in the SAME transaction as the patch: a patch that cannot be
 * settled leaves the node exactly as the caller found it, rather than silently
 * banking a spec change whose effect is unknown until some later trigger.
 */
export function patchGraphNodeAndRetry(input: PatchGraphNodeAndRetryInput): PatchGraphNodeAndRetryResult {
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date().toISOString();

    for (const key of Object.keys(input.baseSpecPatch ?? {})) {
        if (!(MESH_NODE_PATCH_KEYS as readonly string[]).includes(key)) {
            throw new Error(
                `node_patch_forbidden: key '${key}' is outside the permitted patch surface `
                + `(${MESH_NODE_PATCH_KEYS.join(', ')}) — a node's message, routing, permissions, task mode and model are immutable`,
            );
        }
    }
    // Validate the REPLACEMENT bindings before writing them: patching one
    // malformed spec in for another would just re-block the node, and the caller
    // would have to discover that from the retry outcome instead of the error.
    if (input.baseSpecPatch?.inputs_from !== undefined) {
        parseInputBindings({ inputs_from: input.baseSpecPatch.inputs_from });
    }

    const result = store.transaction((): PatchGraphNodeAndRetryResult => {
        const graphStore = store.graphStore();
        const graphs = input.graphId
            ? [graphStore.getGraph(input.graphId)].filter((g): g is MeshTaskGraphRow => !!g)
            : graphStore.listGraphsByMesh(input.meshId);
        if (input.graphId && graphs.length === 0) {
            throw new Error(`graph_not_found: no graph '${input.graphId}' on this mesh`);
        }

        let target: MeshTaskGraphNodeRow | undefined;
        let graph: MeshTaskGraphRow | undefined;
        const ambiguous: string[] = [];
        // ★ WHY RAW `===` AND NOT `meshNodeIdMatches()` (canon-identity rule,
        // eslint.config.mjs). `MeshTaskGraphNodeRow.nodeId` is a GRAPH-ROW id
        // minted by `newMeshGraphNodeId()` and living in one SQLite table — a
        // different namespace from mesh NETWORK node ids. The row type carries no
        // `id` / `node_id` field, and these ids never take the `mach_` /
        // `daemon_mach_` / `standalone_mach_` forms the rule guards against; the
        // rule matches on the property NAME `nodeId` alone, so it cannot tell the
        // two namespaces apart. eslint-suppressions.README.md already classifies
        // every `mesh-graph-*` site as this same "task-graph ids" class, and no
        // mesh-graph module uses the helper.
        //
        // This is not a stylistic preference: `meshNodeIdMatches(node, id)` takes
        // a `MeshNodeIdentified`, and `MeshTaskGraphNodeRow` is NOT assignable to
        // it — passing one is a TS2345 compile error. The type system draws the
        // same namespace boundary this comment does.
        //
        // `input.node` is compared as the caller typed it precisely BECAUSE it may
        // be either a node id or a `ref`; telling those apart is this loop's job,
        // and the id-only test below is what makes an id hit unambiguous while a
        // ref hit stays subject to the cross-graph ambiguity check
        // (`mesh-graph-node-patch.test.ts` pins both).
        for (const g of graphs) {
            if (g.meshId !== input.meshId) continue;
            for (const n of graphStore.listNodes(g.graphId)) {
                // eslint-disable-next-line no-restricted-syntax -- graph-row id (newMeshGraphNodeId), not a mesh node id: different namespace, no mach_/daemon_mach_ forms, and MeshTaskGraphNodeRow is not even assignable to MeshNodeIdentified
                if (n.nodeId !== input.node && n.ref !== input.node) continue;
                // An exact node-id match is unambiguous by construction; a REF is
                // only unique within one graph, so a bare ref that matches several
                // live graphs must be refused rather than silently picking one.
                // eslint-disable-next-line no-restricted-syntax -- graph-row id, same namespace argument as above; must test `nodeId` ONLY (never `ref`) so an id hit short-circuits while a ref hit stays ambiguity-checked
                if (n.nodeId === input.node) { target = n; graph = g; ambiguous.length = 0; break; }
                if (target) { ambiguous.push(`${g.graphId}:${n.nodeId}`); continue; }
                target = n; graph = g; ambiguous.push(`${g.graphId}:${n.nodeId}`);
            }
            // eslint-disable-next-line no-restricted-syntax -- graph-row id, same namespace argument; re-tests the id-only hit to stop scanning further graphs once an unambiguous id match is found
            if (target && target.nodeId === input.node) break;
        }
        if (!target || !graph) {
            throw new Error(
                `graph_node_not_found: no node with id or ref '${input.node}'`
                + (input.graphId ? ` in graph '${input.graphId}'` : ' in any graph on this mesh')
                + ' — use mesh_graph_view to list node ids and refs',
            );
        }
        if (ambiguous.length > 1) {
            throw new Error(
                `ambiguous_node_ref: ref '${input.node}' matches ${ambiguous.length} nodes (${ambiguous.join(', ')}) — `
                + 'pass graph_id, or the exact node id',
            );
        }
        if (target.kind !== 'worker_task') {
            throw new Error(
                `node_not_patchable: node '${target.nodeId}' is a '${target.kind}', not a worker task — `
                + 'gate nodes are driven by mesh_graph_gate (claim / release / abandon)',
            );
        }
        // Same immutability rule as the gate-release patch path.
        if (target.queueTaskId) {
            const entry = store.findQueueEntryById(target.meshId, target.queueTaskId);
            if (entry && entry.status !== 'pending') {
                throw new Error(
                    `task_already_claimed: graph node '${target.nodeId}' backs queue task '${target.queueTaskId}' `
                    + `which is '${entry.status}' — an assigned/completed task is immutable (design :334)`,
                );
            }
        }

        const rawSpec = safeParseJson(target.baseSpecJson);
        const mergedSpec = {
            ...(rawSpec && typeof rawSpec === 'object' ? rawSpec as Record<string, unknown> : {}),
            ...input.baseSpecPatch,
        };
        graphStore.updateNodeBaseSpec(graph.graphId, target.nodeId, JSON.stringify(mergedSpec), nowIso);

        // Re-read so the retry sees the bumped generation and the new spec — a
        // settle run against the stale in-memory row would compute a digest the
        // CAS then rejects.
        const patched = graphStore.getNode(graph.graphId, target.nodeId)!;
        // eslint-disable-next-line no-restricted-syntax -- both sides are graph-row ids read from the SAME graphStore inside the SAME transaction (listNodes + getNode on one graphId), so they are byte-identical by construction: no serialization boundary sits between them where a form could drift
        const nodes = graphStore.listNodes(graph.graphId).map(n => (n.nodeId === patched.nodeId ? patched : n));
        const byId = new Map(nodes.map(n => [n.nodeId, n]));
        const edges = graphStore.listEdges(graph.graphId);

        // ★ The retry. `settleDownstreamNode` never throws: an outcome of `error`
        // means the patch did not fix it and the node stays blocked with the NEW
        // reason, which is precisely what the caller needs to see.
        const outcome = settleDownstreamNode(store, patched, edges, byId, nowIso);
        const entryAfter = patched.queueTaskId
            ? store.findQueueEntryById(patched.meshId, patched.queueTaskId)
            : undefined;
        const fresh = graphStore.getNode(graph.graphId, patched.nodeId)!;
        return {
            graphId: graph.graphId,
            nodeId: fresh.nodeId,
            ...(fresh.ref ? { ref: fresh.ref } : {}),
            ...(fresh.queueTaskId ? { queueTaskId: fresh.queueTaskId } : {}),
            materializationVersion: fresh.materializationVersion,
            state: fresh.state,
            outcome,
            ...(entryAfter?.blockedReason ? { blockedReason: entryAfter.blockedReason } : {}),
        };
    });

    // A successful retry can make the row claimable; wake the queue the same way
    // every other materialization path does, outside the transaction.
    if (result.outcome.kind === 'materialized') {
        try { drainMeshGraphOutbox(input.meshId); } catch { /* drain is best-effort */ }
    }
    return result;
}
