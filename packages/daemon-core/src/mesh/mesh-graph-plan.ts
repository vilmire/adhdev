/**
 * GRAPH-ORCHESTRATION Phase E — the batch v2 PLAN COMMIT: turn one validated
 * `mesh_enqueue_batch` request into the graph control-plane rows (graph, nodes,
 * edges, gates, workspace intents) in the SAME transaction that inserts the
 * worker queue placeholders.
 *
 * Source of truth: docs/design/2026-08-18-graph-orchestration-full.md
 *   :566-592  — Batch v2 API and compatibility surface. `tasks` and every current
 *               alias are RETAINED; v2 adds top-level `batch_id`, `workspaces`,
 *               `gates`, `on_dependency_failure`, `orchestration_decision`, plus
 *               per-task `inputs_from`, `run_if`, `on_false`, `on_upstream_skip`
 *               and `workspace_ref`. `gates` is a SEPARATE array — refs share one
 *               graph namespace across `tasks`, `gates` and `workspaces`.
 *   :576-583  — ★ THE OLD REQUEST PATH STAYS GREEN. A request with only static
 *               tasks takes the compatibility path: every queue row is inserted
 *               exactly as today, static message/target/`dependsOn` unchanged, and
 *               ** no graph-owned block is added merely because a task has
 *               dependencies **. The response keeps its existing fields and only
 *               ADDS `graphId`/`batchId`/persisted ref.
 *   :585-588  — `atomic: true` means DB PLAN ATOMICITY only. Workspace preparation
 *               is a compensated saga reported separately as
 *               `workspacePreparation: pending|ready|failed`; git side effects are
 *               never inside the SQLite transaction.
 *   :118-120  — `UNIQUE(mesh_id, batch_id)` + plan digest: the same batch_id with
 *               the same digest REPLAYS (idempotent), a different digest CONFLICTS.
 *   :103-183  — the row shapes this module writes.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * It writes rows; it does not run the state machine. Materialization, condition
 * evaluation, gate opening, block clearing and failure derivation stay in the
 * phase B/C1/C2/C3 modules, which are imported for their CONTRACTS only:
 *
 *   - a gate's downstream hold is written by the runner's
 *     `coordinatorGateBlockReason` when the gate OPENS, not here at declare time;
 *   - a node whose inputs are not yet settled is held by the runner's
 *     `graphMaterializationBlockReason` — this module applies it ONLY to advanced
 *     nodes (bindings / conditions / gate-fed / workspace_ref), never to a plain
 *     `depends_on` node, which is exactly the compatibility rule at :580.
 *
 * ★ The one structural invariant of this file: EVERY queue row it blocks must be
 * a row whose advanced feature makes it un-runnable until the graph settles it.
 * A static task must leave this module in precisely the state the pre-graph batch
 * path left it in.
 */

import { createHash } from 'crypto';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { canonicalJson } from './mesh-graph-input-binding.js';
import {
    MESH_GRAPH_GATE_ACTIONS,
    MESH_GRAPH_GATE_TIMEOUT_POLICIES,
    MESH_GRAPH_ON_UPSTREAM_SKIP_POLICIES,
    MESH_GRAPH_SCHEMA_VERSION,
    newMeshGraphGateId,
    newMeshGraphId,
    newMeshGraphNodeId,
    type MeshGraphEdgeKind,
    type MeshGraphEnqueueSurface,
    type MeshGraphGateAction,
    type MeshGraphGateTimeoutPolicy,
    type MeshGraphOnUpstreamSkip,
    type MeshTaskGraphEdgeRow,
    type MeshTaskGraphNodeRow,
    type MeshTaskGraphRow,
} from './mesh-graph-types.js';
import {
    parseOnDependencyFailurePolicy,
    serializeGraphPolicy,
} from './mesh-graph-derived-failure.js';
import { graphMaterializationBlockReason } from './mesh-graph-transition-runner.js';
import { declareWorkspaceIntents, type GraphWorkspaceDeclaration } from './mesh-graph-workspace-saga.js';
import { enqueueTaskGraph, type MeshTaskGraphEntrySpec, type MeshWorkQueueEntry } from './mesh-work-queue.js';

/** Structured validation failure — the caller surfaces `code` verbatim to the LLM. */
export class MeshGraphPlanError extends Error {
    constructor(readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
        super(`${code}: ${message}`);
        this.name = 'MeshGraphPlanError';
    }
}

/** design :568-570 — per-task graph fields layered on top of the existing task spec. */
export interface MeshGraphTaskPlanSpec extends MeshTaskGraphEntrySpec {
    /** Selected predecessor outputs (C1). Presence makes the node ADVANCED. */
    inputs_from?: unknown;
    /** Declarative condition (C1). Presence makes the node ADVANCED. */
    run_if?: unknown;
    /** Only `skip` is defined (C1 fails closed on anything else). */
    on_false?: unknown;
    /** Per-incoming-edge skip policy (design :361-366). */
    on_upstream_skip?: MeshGraphOnUpstreamSkip | string;
    /** Delayed worktree binding (D). Presence makes the node ADVANCED. */
    workspace_ref?: string;
    /** Refs of gate entries that must be RELEASED before this task materializes. */
    gated_by?: string[];
}

/** design :572 — gates are their own array; their refs share the task ref namespace. */
export interface MeshGraphGatePlanSpec {
    ref: string;
    action?: MeshGraphGateAction | string;
    instructions?: string;
    depends_on?: string[];
    eligible_coordinator_session_id?: string;
    lease_seconds?: number;
    deadline_seconds?: number;
    /** design :431-432 — hold | cancel_downstream | fail_graph. There is NO auto_release. */
    on_timeout?: MeshGraphGateTimeoutPolicy | string;
}

export interface MeshGraphPlanRequest {
    meshId: string;
    tasks: MeshGraphTaskPlanSpec[];
    gates?: MeshGraphGatePlanSpec[];
    workspaces?: GraphWorkspaceDeclaration[];
    /** Client idempotency key (design :108, :118-120). A server UUID when omitted. */
    batchId?: string;
    missionId?: string;
    onDependencyFailure?: unknown;
    sourceCoordinatorSessionId?: string;
    enqueueSurface?: MeshGraphEnqueueSurface;
    /** design :697-710 — the coordinator's own planning record, stored verbatim on the graph policy. */
    orchestrationDecision?: Record<string, unknown>;
}

export interface MeshGraphPlanResult {
    graphId: string;
    batchId: string;
    tasks: MeshWorkQueueEntry[];
    /** Parallel to `tasks`: the graph node id backing each queue row. */
    nodeIdByIndex: string[];
    gates: Array<{ ref: string; gateId: string; nodeId: string; action: MeshGraphGateAction }>;
    workspaces: Array<{ ref: string; sagaState: string; branchIdentity?: string }>;
    dependencyEdgeCount: number;
    planDigest: string;
    /** True when an identical batchId+digest plan already existed and was returned unchanged. */
    replayed: boolean;
    /** design :585-588 — DB atomicity never implies the git worktree is ready. */
    workspacePreparation: 'not_requested' | 'pending';
    /** Node ids this commit deliberately held with the graph materialization block. */
    heldNodeIds: string[];
}

/**
 * True when an entry needs the graph state machine to settle it before it may
 * run — i.e. its final message/target is NOT yet known at insert time.
 *
 * ★ This predicate IS the old-path compatibility guarantee (design :576-583).
 * `depends_on` alone is deliberately absent: a plain dependency is handled by the
 * unchanged `taskDependenciesSatisfied` queue predicate, so adding a graph block
 * for it would change old-path behavior.
 */
export function isAdvancedGraphTask(spec: MeshGraphTaskPlanSpec): boolean {
    return spec.inputs_from !== undefined
        || spec.run_if !== undefined
        || (typeof spec.workspace_ref === 'string' && spec.workspace_ref.trim().length > 0)
        || (Array.isArray(spec.gated_by) && spec.gated_by.length > 0);
}

/** True when the request uses any v2-only surface — i.e. it is NOT an old-path batch. */
export function requestUsesGraphV2(req: Pick<MeshGraphPlanRequest, 'tasks' | 'gates' | 'workspaces'>): boolean {
    if (Array.isArray(req.gates) && req.gates.length > 0) return true;
    if (Array.isArray(req.workspaces) && req.workspaces.length > 0) return true;
    return (req.tasks ?? []).some(isAdvancedGraphTask);
}

function normalizeRef(value: unknown, label: string): string {
    const ref = typeof value === 'string' ? value.trim() : '';
    if (!ref) throw new MeshGraphPlanError('invalid_graph_ref', `${label} requires a non-empty ref`);
    return ref;
}

function pickEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
    code: string,
    label: string,
): T {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    throw new MeshGraphPlanError(code, `${label} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`);
}

/**
 * The normalized-plan digest (design :118-120). Covers everything that changes
 * what the plan MEANS — refs, messages, wiring, gate policy, workspaces — so a
 * retry of the identical request replays and a changed request conflicts.
 */
export function computeMeshGraphPlanDigest(req: MeshGraphPlanRequest): string {
    const normalized = {
        tasks: (req.tasks ?? []).map(t => ({
            ref: typeof t.ref === 'string' ? t.ref.trim() : null,
            message: t.message,
            depends_on: [...(t.dependsOn ?? [])].sort(),
            gated_by: [...(t.gated_by ?? [])].sort(),
            inputs_from: t.inputs_from ?? null,
            run_if: t.run_if ?? null,
            on_false: t.on_false ?? null,
            on_upstream_skip: t.on_upstream_skip ?? null,
            workspace_ref: t.workspace_ref ?? null,
            target_node_id: t.targetNodeId ?? null,
            task_mode: t.taskMode ?? null,
            difficulty: t.difficulty ?? null,
        })),
        gates: (req.gates ?? []).map(g => ({
            ref: g.ref,
            action: g.action ?? 'custom',
            depends_on: [...(g.depends_on ?? [])].sort(),
            on_timeout: g.on_timeout ?? 'hold',
            lease_seconds: g.lease_seconds ?? null,
            deadline_seconds: g.deadline_seconds ?? null,
        })),
        workspaces: (req.workspaces ?? []).map(w => ({
            ref: w.ref,
            source_node_id: w.source_node_id ?? null,
            base_revision: w.base_revision ?? null,
            desired_path: w.desired_path ?? null,
            cleanup_on_graph_failure: w.cleanup_on_graph_failure === true,
        })),
        on_dependency_failure: parseOnDependencyFailurePolicy(req.onDependencyFailure),
    };
    return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

/**
 * Commit one batch-v2 plan.
 *
 * Ordering inside the single transaction:
 *   1. idempotency check on (mesh_id, batch_id) — replay or conflict (design :118-120);
 *   2. ref namespace + wiring validation (BEFORE any insert, so a bad plan writes nothing);
 *   3. `enqueueTaskGraph` inserts every worker queue row — the UNCHANGED old path,
 *      including its own cycle/difficulty/guardrail validation;
 *   4. graph + node + edge + gate rows;
 *   5. graph-owned blocks on ADVANCED nodes only (design :576-583).
 *
 * Workspace intents are declared after the commit: they own git side effects and
 * are a compensated saga, never part of DB atomicity (design :585-588).
 */
export function commitMeshGraphPlan(req: MeshGraphPlanRequest): MeshGraphPlanResult {
    const store = MeshRuntimeStore.getInstance();
    const tasks = Array.isArray(req.tasks) ? req.tasks : [];
    if (tasks.length === 0) {
        throw new MeshGraphPlanError('empty_task_graph', 'a graph plan requires at least one task');
    }
    const gates = Array.isArray(req.gates) ? req.gates : [];
    const workspaces = Array.isArray(req.workspaces) ? req.workspaces : [];
    const policy = { on_dependency_failure: parseOnDependencyFailurePolicy(req.onDependencyFailure) };
    const planDigest = computeMeshGraphPlanDigest(req);
    const batchId = typeof req.batchId === 'string' && req.batchId.trim() ? req.batchId.trim() : newMeshGraphId();
    const nowIso = new Date().toISOString();

    // ── Ref namespace (design :572-574): tasks, gates and workspaces share ONE
    //    namespace, so a gate can never collide with a task ref. ──
    const taskRefs = new Map<string, number>();
    tasks.forEach((t, i) => {
        const ref = typeof t.ref === 'string' ? t.ref.trim() : '';
        if (!ref) return;
        if (taskRefs.has(ref)) {
            throw new MeshGraphPlanError('duplicate_task_ref', `ref '${ref}' is used by more than one task in this batch`);
        }
        taskRefs.set(ref, i);
    });
    const gateRefs = new Map<string, number>();
    gates.forEach((g, i) => {
        const ref = normalizeRef(g.ref, `gates[${i}]`);
        if (taskRefs.has(ref) || gateRefs.has(ref)) {
            throw new MeshGraphPlanError(
                'duplicate_graph_ref',
                `ref '${ref}' is declared more than once — tasks, gates and workspaces share ONE ref namespace`,
            );
        }
        gateRefs.set(ref, i);
    });
    const workspaceRefs = new Set<string>();
    workspaces.forEach((w, i) => {
        const ref = normalizeRef(w.ref, `workspaces[${i}]`);
        if (taskRefs.has(ref) || gateRefs.has(ref) || workspaceRefs.has(ref)) {
            throw new MeshGraphPlanError(
                'duplicate_graph_ref',
                `ref '${ref}' is declared more than once — tasks, gates and workspaces share ONE ref namespace`,
            );
        }
        workspaceRefs.add(ref);
    });

    // A gate ref may NOT appear in a task's `depends_on`: gate ordering is declared
    // with `gated_by`, which produces a `gate` edge the C2 settle guard honours.
    // Silently projecting a gate into the queue's dependsOn would make the gate
    // look satisfiable by the ordinary dependency predicate — exactly the
    // side-step C2 forbids.
    tasks.forEach((t, i) => {
        for (const dep of t.dependsOn ?? []) {
            if (gateRefs.has(dep)) {
                throw new MeshGraphPlanError(
                    'gate_ref_in_depends_on',
                    `task ${t.ref ? `'${t.ref}'` : `#${i}`} lists gate ref '${dep}' in depends_on — use gated_by to declare a gate edge `
                    + '(a gate is an intentional stop, never an ordinary queue dependency)',
                );
            }
        }
        for (const gateRef of t.gated_by ?? []) {
            if (!gateRefs.has(gateRef)) {
                throw new MeshGraphPlanError(
                    'unknown_gate_ref',
                    `task ${t.ref ? `'${t.ref}'` : `#${i}`} is gated_by '${gateRef}', which is not a gate in this batch`
                    + (gateRefs.size ? ` (gates: ${[...gateRefs.keys()].join(', ')})` : ''),
                );
            }
        }
        const ws = typeof t.workspace_ref === 'string' ? t.workspace_ref.trim() : '';
        if (ws && !workspaceRefs.has(ws)) {
            throw new MeshGraphPlanError(
                'unknown_workspace_ref',
                `task ${t.ref ? `'${t.ref}'` : `#${i}`} names workspace_ref '${ws}', which is not declared in this batch`,
            );
        }
    });
    gates.forEach((g, i) => {
        for (const dep of g.depends_on ?? []) {
            if (!taskRefs.has(dep) && !gateRefs.has(dep)) {
                throw new MeshGraphPlanError(
                    'unknown_gate_dependency',
                    `gate '${g.ref}' depends on '${dep}', which is not a task or gate ref in this batch`,
                );
            }
        }
        // Validate the enums up front so a bad policy never reaches an insert.
        pickEnum(g.action, MESH_GRAPH_GATE_ACTIONS, 'custom', 'invalid_gate_action', `gates[${i}].action`);
        pickEnum(g.on_timeout, MESH_GRAPH_GATE_TIMEOUT_POLICIES, 'hold', 'invalid_gate_on_timeout', `gates[${i}].on_timeout`);
    });
    tasks.forEach((t, i) => {
        pickEnum(t.on_upstream_skip, MESH_GRAPH_ON_UPSTREAM_SKIP_POLICIES, 'skip', 'invalid_on_upstream_skip', `tasks[${i}].on_upstream_skip`);
    });

    const result = store.transaction((): MeshGraphPlanResult => {
        const graphStore = store.graphStore();

        // ── 1. Idempotency (design :118-120) ─────────────────────────────────
        const existing = graphStore.getGraphByBatchId(req.meshId, batchId);
        if (existing) {
            if (existing.planDigest !== planDigest) {
                throw new MeshGraphPlanError(
                    'batch_id_conflict',
                    `batch_id '${batchId}' already exists on this mesh with a DIFFERENT plan digest — `
                    + 'reuse of a batch id is only idempotent for an identical plan',
                    { graphId: existing.graphId },
                );
            }
            const existingNodes = graphStore.listNodes(existing.graphId);
            const workerNodes = existingNodes.filter(n => n.kind === 'worker_task');
            const replayTasks = workerNodes
                .map(n => (n.queueTaskId ? store.findQueueEntryById(req.meshId, n.queueTaskId) : null))
                .filter((e): e is MeshWorkQueueEntry => !!e);
            return {
                graphId: existing.graphId,
                batchId,
                tasks: replayTasks,
                nodeIdByIndex: workerNodes.map(n => n.nodeId),
                gates: graphStore.listGatesByGraph(existing.graphId).map(g => ({
                    ref: g.ref ?? g.gateId, gateId: g.gateId, nodeId: g.nodeId, action: g.action,
                })),
                workspaces: graphStore.listWorkspaceIntents(existing.graphId).map(w => ({
                    ref: w.workspaceRef, sagaState: w.sagaState, branchIdentity: w.branchIdentity,
                })),
                dependencyEdgeCount: existing.dependencyEdgeCount,
                planDigest,
                replayed: true,
                workspacePreparation: existing.workspaceCount > 0 ? 'pending' : 'not_requested',
                heldNodeIds: [],
            };
        }

        // ── 2. Worker queue rows — the UNCHANGED old path (design :578) ───────
        // enqueueTaskGraph performs its own ref resolution, cycle detection,
        // difficulty assert and guardrail validation; it nests as a savepoint in
        // this transaction, so any throw rolls the whole plan back.
        const queueSpecs: MeshTaskGraphEntrySpec[] = tasks.map(t => {
            // The graph-only fields are stripped: the queue row keeps exactly the
            // shape it has today. Graph semantics live on the node's base spec.
            const {
                inputs_from: _inputsFrom, run_if: _runIf, on_false: _onFalse,
                on_upstream_skip: _onUpstreamSkip, workspace_ref: _workspaceRef,
                gated_by: _gatedBy, ...queueSpec
            } = t;
            return {
                ...queueSpec,
                missionId: queueSpec.missionId ?? req.missionId,
                ...(req.sourceCoordinatorSessionId ? { sourceCoordinatorSessionId: req.sourceCoordinatorSessionId } : {}),
            };
        });
        const inserted = enqueueTaskGraph(req.meshId, queueSpecs);

        // ── 3. Graph + node rows ─────────────────────────────────────────────
        const graphId = newMeshGraphId();
        const nodeIdByIndex = tasks.map(() => newMeshGraphNodeId());
        const gateNodeIdByRef = new Map<string, string>();
        const gateIdByRef = new Map<string, string>();
        gates.forEach(g => {
            gateNodeIdByRef.set(g.ref.trim(), newMeshGraphNodeId());
            gateIdByRef.set(g.ref.trim(), newMeshGraphGateId());
        });
        const nodeIdByRef = new Map<string, string>();
        tasks.forEach((t, i) => {
            const ref = typeof t.ref === 'string' ? t.ref.trim() : '';
            if (ref) nodeIdByRef.set(ref, nodeIdByIndex[i]);
        });
        for (const [ref, nodeId] of gateNodeIdByRef) nodeIdByRef.set(ref, nodeId);

        const edges: MeshTaskGraphEdgeRow[] = [];
        const addEdge = (fromNodeId: string, toNodeId: string, kind: MeshGraphEdgeKind, omitOnSkip: boolean) => {
            edges.push({ graphId, meshId: req.meshId, fromNodeId, toNodeId, kind, omitOnSkip, createdAt: nowIso });
        };

        tasks.forEach((t, i) => {
            const nodeId = nodeIdByIndex[i];
            const ref = typeof t.ref === 'string' ? t.ref.trim() : undefined;
            // The node's base spec is the IMMUTABLE plan (design :130): the base
            // message plus the declarative graph semantics. It is what the C1/C2/D
            // settle path re-reads on every materialization attempt.
            const baseSpec: Record<string, unknown> = { message: t.message };
            if (t.inputs_from !== undefined) baseSpec.inputs_from = t.inputs_from;
            if (t.run_if !== undefined) baseSpec.run_if = t.run_if;
            if (t.on_false !== undefined) baseSpec.on_false = t.on_false;
            if (typeof t.workspace_ref === 'string' && t.workspace_ref.trim()) {
                baseSpec.workspace_ref = t.workspace_ref.trim();
            }
            const node: MeshTaskGraphNodeRow = {
                graphId,
                nodeId,
                meshId: req.meshId,
                ...(ref ? { ref } : {}),
                kind: 'worker_task',
                queueTaskId: inserted[i].id,
                state: 'declared',
                baseSpecJson: JSON.stringify(baseSpec),
                materializationVersion: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
            };
            graphStore.insertNode(node);
        });

        gates.forEach((g, i) => {
            const ref = g.ref.trim();
            const nodeId = gateNodeIdByRef.get(ref)!;
            const gateSpec: Record<string, unknown> = {};
            if (typeof g.lease_seconds === 'number' && g.lease_seconds > 0) gateSpec.lease_seconds = g.lease_seconds;
            if (typeof g.deadline_seconds === 'number' && g.deadline_seconds > 0) gateSpec.deadline_seconds = g.deadline_seconds;
            graphStore.insertNode({
                graphId,
                nodeId,
                meshId: req.meshId,
                ref,
                kind: 'coordinator_gate',
                state: 'declared',
                baseSpecJson: JSON.stringify(gateSpec),
                materializationVersion: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
            });
            graphStore.insertGate({
                gateId: gateIdByRef.get(ref)!,
                graphId,
                nodeId,
                meshId: req.meshId,
                ref,
                state: 'declared',
                action: pickEnum(g.action, MESH_GRAPH_GATE_ACTIONS, 'custom', 'invalid_gate_action', `gates[${i}].action`),
                instructions: typeof g.instructions === 'string' ? g.instructions : undefined,
                eligibleCoordinatorSessionId: typeof g.eligible_coordinator_session_id === 'string'
                    ? g.eligible_coordinator_session_id
                    : undefined,
                leaseGeneration: 0,
                onTimeout: pickEnum(g.on_timeout, MESH_GRAPH_GATE_TIMEOUT_POLICIES, 'hold', 'invalid_gate_on_timeout', `gates[${i}].on_timeout`),
                createdAt: nowIso,
                updatedAt: nowIso,
            });
        });

        // ── 4. Edges ─────────────────────────────────────────────────────────
        // A task's `depends_on` maps to `requires` edges — but ONLY for refs
        // inside this batch. A dependency on a pre-existing queue task id has no
        // node in this graph; it stays a pure queue dependency, honoured by the
        // unchanged scheduler predicate.
        tasks.forEach((t, i) => {
            const omitOnSkip = pickEnum(
                t.on_upstream_skip, MESH_GRAPH_ON_UPSTREAM_SKIP_POLICIES, 'skip',
                'invalid_on_upstream_skip', `tasks[${i}].on_upstream_skip`,
            ) === 'omit_dependency';
            for (const dep of t.dependsOn ?? []) {
                const fromNodeId = nodeIdByRef.get(dep);
                if (!fromNodeId) continue;
                addEdge(fromNodeId, nodeIdByIndex[i], 'requires', omitOnSkip);
            }
            // ★ A binding that reads a GATE ref becomes a `gate` edge, NOT a
            // `requires`/`conditional` one (gate-ref binding deadlock). Reading a
            // gate outcome is the DESIGNED usage — design P3 is literally "gate
            // outcome drives run_if and conditional skip" — but the ordering it
            // implies is gate ordering, and only the `gate` edge expresses that:
            //   * `settleDownstreamNode` demands every non-`gate` incoming source
            //     reach `completed`, and a released gate node terminates at
            //     `released`. A `requires`/`conditional` edge out of a gate is
            //     therefore UNSATISFIABLE — the downstream node deferred forever,
            //     silently, with no error. That was the deadlock.
            //   * Such an edge is also the exact side-step :288-292 forbids for
            //     `depends_on`: a gate must never look like an ordinary dependency
            //     that completion alone can satisfy.
            // Collected here and emitted below through the SAME path as `gated_by`,
            // so binding a gate ref implies its gate edge even when `gated_by` is
            // omitted — otherwise the node would have no gate ordering at all and
            // could materialize and read the outcome BEFORE the release commits.
            const gateRefsForNode = new Set<string>((t.gated_by ?? []).map(r => r.trim()).filter(Boolean));

            // A `run_if` reading an upstream ref is a CONDITIONAL edge (design
            // :141): control flow, not an execution prerequisite.
            for (const sourceRef of collectRunIfSourceRefs(t.run_if)) {
                const fromNodeId = nodeIdByRef.get(sourceRef);
                if (!fromNodeId || fromNodeId === nodeIdByIndex[i]) continue;
                if (gateNodeIdByRef.has(sourceRef)) { gateRefsForNode.add(sourceRef); continue; }
                if (edges.some(e => e.fromNodeId === fromNodeId && e.toNodeId === nodeIdByIndex[i])) continue;
                addEdge(fromNodeId, nodeIdByIndex[i], 'conditional', omitOnSkip);
            }
            // An `inputs_from` binding requires its source to have COMPLETED —
            // that is a genuine execution prerequisite, so it is a `requires` edge.
            for (const sourceRef of collectInputSourceRefs(t.inputs_from)) {
                const fromNodeId = nodeIdByRef.get(sourceRef);
                if (!fromNodeId || fromNodeId === nodeIdByIndex[i]) continue;
                if (gateNodeIdByRef.has(sourceRef)) { gateRefsForNode.add(sourceRef); continue; }
                if (edges.some(e => e.fromNodeId === fromNodeId && e.toNodeId === nodeIdByIndex[i] && e.kind === 'requires')) continue;
                addEdge(fromNodeId, nodeIdByIndex[i], 'requires', omitOnSkip);
            }
            // `gated_by` (and any gate ref bound above) → a `gate` edge, the one
            // edge kind the C2 settle guard treats as an intentional stop (never
            // satisfiable by completion). The runner feeds the released gate's
            // outcome envelope into the binding scope (gateOutcomeOutputForNode),
            // so the binding still resolves off this single edge.
            for (const gateRef of gateRefsForNode) {
                const fromNodeId = gateNodeIdByRef.get(gateRef);
                if (!fromNodeId) continue;
                addEdge(fromNodeId, nodeIdByIndex[i], 'gate', false);
            }
        });
        gates.forEach(g => {
            const toNodeId = gateNodeIdByRef.get(g.ref.trim())!;
            for (const dep of g.depends_on ?? []) {
                const fromNodeId = nodeIdByRef.get(dep);
                if (!fromNodeId) continue;
                addEdge(fromNodeId, toNodeId, 'requires', false);
            }
        });
        for (const edge of edges) graphStore.insertEdge(edge);

        graphStore.insertGraph({
            graphId,
            meshId: req.meshId,
            batchId,
            missionId: req.missionId,
            sourceCoordinatorSessionId: req.sourceCoordinatorSessionId,
            enqueueSurface: req.enqueueSurface ?? 'batch',
            schemaVersion: MESH_GRAPH_SCHEMA_VERSION,
            status: 'active',
            taskCount: tasks.length,
            gateCount: gates.length,
            workspaceCount: workspaces.length,
            dependencyEdgeCount: edges.length,
            planDigest,
            // ★ E-2: `on_dependency_failure` is now PERSISTED on the graph row
            // (C3 only validated and echoed it). The C3 derived-failure path reads
            // it back through parseGraphPolicy/projectGraphPublicPolicy.
            policyJson: serializeGraphPolicy(policy),
            createdAt: nowIso,
            activatedAt: nowIso,
            updatedAt: nowIso,
        } satisfies MeshTaskGraphRow);
        if (req.orchestrationDecision) {
            // Stored alongside the policy rather than inside it: parseGraphPolicy is
            // strict about its own fields, and the decision record is provenance,
            // not runtime policy. Written as a second key on the same JSON document.
            const merged = JSON.stringify({
                ...JSON.parse(serializeGraphPolicy(policy)),
                orchestration_decision: req.orchestrationDecision,
            });
            graphStore.updateGraphPolicyJson(graphId, merged, nowIso);
        }

        // ── 5. Graph-owned blocks — ADVANCED nodes ONLY (design :576-583) ─────
        // ★ A static `depends_on` task is NOT blocked here. That is the old-path
        // compatibility rule; breaking it would make every legacy batch's roots
        // unclaimable until a graph settle ran.
        const heldNodeIds: string[] = [];
        tasks.forEach((t, i) => {
            if (!isAdvancedGraphTask(t)) return;
            const nodeId = nodeIdByIndex[i];
            const entry = store.findQueueEntryById(req.meshId, inserted[i].id);
            if (!entry || entry.status !== 'pending' || entry.blockedReason) return;
            entry.blockedReason = graphMaterializationBlockReason(nodeId, 0);
            store.updateQueueEntry(entry);
            graphStore.updateNodeState(graphId, nodeId, 'blocked', nowIso);
            heldNodeIds.push(nodeId);
        });

        return {
            graphId,
            batchId,
            tasks: inserted,
            nodeIdByIndex,
            gates: gates.map(g => ({
                ref: g.ref.trim(),
                gateId: gateIdByRef.get(g.ref.trim())!,
                nodeId: gateNodeIdByRef.get(g.ref.trim())!,
                action: pickEnum(g.action, MESH_GRAPH_GATE_ACTIONS, 'custom', 'invalid_gate_action', 'gate action'),
            })),
            workspaces: [],
            dependencyEdgeCount: edges.length,
            planDigest,
            replayed: false,
            workspacePreparation: workspaces.length > 0 ? 'pending' : 'not_requested',
            heldNodeIds,
        };
    });

    // ── Workspace intents: OUTSIDE the plan transaction (design :585-588) ─────
    // Declaring an intent is a DB write, but the saga it starts owns git side
    // effects; keeping it separate keeps the "atomic means DB plan only" promise
    // honest and lets a declare failure leave a committed, inspectable plan.
    if (!result.replayed && workspaces.length > 0) {
        try {
            const declared = declareWorkspaceIntents({
                graphId: result.graphId,
                meshId: req.meshId,
                workspaces,
            });
            result.workspaces = declared.map(w => ({
                ref: w.workspaceRef, sagaState: w.sagaState, branchIdentity: w.branchIdentity,
            }));
        } catch (e: any) {
            LOG.warn('MeshGraph', `Workspace intent declaration failed for graph ${result.graphId}: ${e?.message || e}`);
        }
    }
    return result;
}

/** Refs a `run_if` condition reads, so the plan can wire conditional edges. */
function collectRunIfSourceRefs(runIf: unknown, depth = 0): string[] {
    if (!runIf || typeof runIf !== 'object' || depth > 8) return [];
    const out: string[] = [];
    const node = runIf as Record<string, unknown>;
    if (typeof node.from === 'string' && node.from.trim()) out.push(node.from.trim());
    for (const key of ['all', 'any', 'not', 'conditions']) {
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) out.push(...collectRunIfSourceRefs(item, depth + 1));
        } else if (child && typeof child === 'object') {
            out.push(...collectRunIfSourceRefs(child, depth + 1));
        }
    }
    return [...new Set(out)];
}

/** Refs an `inputs_from` array binds from. Shape errors are left to C1's strict parser. */
function collectInputSourceRefs(inputsFrom: unknown): string[] {
    if (!Array.isArray(inputsFrom)) return [];
    const out: string[] = [];
    for (const item of inputsFrom) {
        if (item && typeof item === 'object' && typeof (item as { from?: unknown }).from === 'string') {
            const from = (item as { from: string }).from.trim();
            if (from) out.push(from);
        }
    }
    return [...new Set(out)];
}
