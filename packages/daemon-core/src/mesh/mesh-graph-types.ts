/**
 * GRAPH-ORCHESTRATION Phase A — graph control-plane types, state enums, and IDs.
 *
 * Source of truth: docs/design/2026-08-18-graph-orchestration-full.md
 * ("Persistent model", ~:98-191; gate states :393-400; timeout policy :425-434;
 * failure policy :513-565; skip semantics :336-369).
 *
 * ★ PHASE-A SCOPE: this module is TYPES ONLY. No transition runner, no
 * materializer, no gate/workspace/condition behavior — those are phases B–D.
 * Nothing in the scheduler (claim / auto-launch / eager push) reads these
 * tables or types; the dependency-gate predicate `taskDependenciesSatisfied`
 * is deliberately untouched and remains the one scheduler choke point.
 */

import { randomUUID } from 'crypto';

// ── Graph lifecycle (design :113) ────────────────────────────────────────────

export const MESH_GRAPH_STATUSES = [
    'preparing',
    'active',
    'waiting_gate',
    'completed',
    'failed',
    'cancelled',
    'compensation_required',
] as const;
export type MeshGraphStatus = typeof MESH_GRAPH_STATUSES[number];

/** design :112 — v2 is the graph-orchestration schema; legacy metadata was 1. */
export const MESH_GRAPH_SCHEMA_VERSION = 2;

/** design :111 — how the graph entered the system. */
export const MESH_GRAPH_ENQUEUE_SURFACES = [
    'batch',
    'single',
    'send_task',
    'legacy_import',
] as const;
export type MeshGraphEnqueueSurface = typeof MESH_GRAPH_ENQUEUE_SURFACES[number];

// ── Graph nodes (design :122-137) ────────────────────────────────────────────

/** design :127 — gates are graph control nodes, never ordinary queue tasks. */
export const MESH_GRAPH_NODE_KINDS = ['worker_task', 'coordinator_gate'] as const;
export type MeshGraphNodeKind = typeof MESH_GRAPH_NODE_KINDS[number];

/** design :129. */
export const MESH_GRAPH_NODE_STATES = [
    'declared',
    'blocked',
    'materialized',
    'awaiting_coordinator',
    'released',
    'skipped',
    'completed',
    'failed',
    'cancelled',
    'expired',
] as const;
export type MeshGraphNodeState = typeof MESH_GRAPH_NODE_STATES[number];

// ── Graph edges (design :139-143) ────────────────────────────────────────────

export const MESH_GRAPH_EDGE_KINDS = ['requires', 'gate', 'conditional'] as const;
export type MeshGraphEdgeKind = typeof MESH_GRAPH_EDGE_KINDS[number];

/**
 * design :361-366 — what happens to a downstream edge when its source node is
 * skipped. `skip` (default) propagates a safe skip; `omit_dependency` removes
 * the edge from the downstream queue projection so the unchanged queue
 * predicate never learns a "skipped satisfies dependency" rule.
 */
export const MESH_GRAPH_ON_UPSTREAM_SKIP_POLICIES = ['skip', 'omit_dependency'] as const;
export type MeshGraphOnUpstreamSkip = typeof MESH_GRAPH_ON_UPSTREAM_SKIP_POLICIES[number];

// ── Coordinator gates (design :371-439) ──────────────────────────────────────

/** design :395-400 — declared → awaiting_coordinator → claimed → released, with expired/cancelled sides. */
export const MESH_GRAPH_GATE_STATES = [
    'declared',
    'awaiting_coordinator',
    'claimed',
    'released',
    'expired',
    'cancelled',
] as const;
export type MeshGraphGateState = typeof MESH_GRAPH_GATE_STATES[number];

/** design :390 — metadata labels only; the daemon never executes gate actions. */
export const MESH_GRAPH_GATE_ACTIONS = [
    'refinery',
    'approval',
    'ci_wait',
    'publish',
    'deploy',
    'custom',
] as const;
export type MeshGraphGateAction = typeof MESH_GRAPH_GATE_ACTIONS[number];

/**
 * design :431-432 — deadline-expiry policy. There is deliberately NO
 * `auto_release`: an expired gate can never release itself.
 */
export const MESH_GRAPH_GATE_TIMEOUT_POLICIES = ['hold', 'cancel_downstream', 'fail_graph'] as const;
export type MeshGraphGateTimeoutPolicy = typeof MESH_GRAPH_GATE_TIMEOUT_POLICIES[number];

// ── Failure policy (design :513-565) ─────────────────────────────────────────

/**
 * design :522-549 — `block` (default) derives the block from current
 * predecessor statuses (retry success unblocks automatically); `cancel` is an
 * explicit destructive terminal cascade.
 */
export const MESH_GRAPH_ON_DEPENDENCY_FAILURE_POLICIES = ['block', 'cancel'] as const;
export type MeshGraphOnDependencyFailure = typeof MESH_GRAPH_ON_DEPENDENCY_FAILURE_POLICIES[number];

// ── Workspace saga (design :441-511) ─────────────────────────────────────────

/**
 * design :479-507 — worktree preparation is an idempotent saga with
 * owned-resource compensation; it is NEVER claimed to be atomic with SQLite.
 */
export const MESH_GRAPH_WORKSPACE_SAGA_STATES = [
    'declared',
    'preparing',
    'ready',
    'failed',
    'compensating',
    'compensated',
    'compensation_required',
] as const;
export type MeshGraphWorkspaceSagaState = typeof MESH_GRAPH_WORKSPACE_SAGA_STATES[number];

// ── Transactional outbox (design :185-190) ───────────────────────────────────

/**
 * Graph notifications and queue wakeups are inserted in the SAME SQLite
 * transaction as the state change and drained after commit (design :185-190),
 * preventing "state committed but coordinator never notified" and "queue woken
 * before materialization committed" races.
 */
export const MESH_GRAPH_OUTBOX_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type MeshGraphOutboxStatus = typeof MESH_GRAPH_OUTBOX_STATUSES[number];

// ── Graph IDs ────────────────────────────────────────────────────────────────

/** design :107 — stable UUID for one accepted graph. Plain strings, branded by name only. */
export type MeshGraphId = string;
export type MeshGraphNodeId = string;
export type MeshGraphGateId = string;
export type MeshGraphOutboxId = string;

export function newMeshGraphId(): MeshGraphId {
    return randomUUID();
}

export function newMeshGraphNodeId(): MeshGraphNodeId {
    return randomUUID();
}

export function newMeshGraphGateId(): MeshGraphGateId {
    return randomUUID();
}

export function newMeshGraphOutboxId(): MeshGraphOutboxId {
    return randomUUID();
}

// ── Store row interfaces (camelCase mirrors of the DDL in mesh-graph-schema) ──

/** design :103-120. `UNIQUE(mesh_id, batch_id)` makes client retries idempotent. */
export interface MeshTaskGraphRow {
    graphId: MeshGraphId;
    meshId: string;
    /** Client idempotency key when supplied; otherwise a server UUID (design :108). */
    batchId: string;
    missionId?: string;
    sourceCoordinatorSessionId?: string;
    enqueueSurface: MeshGraphEnqueueSurface;
    schemaVersion: number;
    status: MeshGraphStatus;
    taskCount: number;
    gateCount: number;
    workspaceCount: number;
    dependencyEdgeCount: number;
    /** Normalized-plan digest: same batch_id + same digest replays, different digest conflicts (design :118-120). */
    planDigest?: string;
    /** Failure/timeout/materialization limits after normalization (design :115). */
    policyJson: string;
    createdAt: string;
    activatedAt?: string;
    terminalAt?: string;
    updatedAt: string;
}

/** design :122-137. Unlike legacy batch refs, `ref` is RETAINED and rides every graph event. */
export interface MeshTaskGraphNodeRow {
    graphId: MeshGraphId;
    nodeId: MeshGraphNodeId;
    meshId: string;
    ref?: string;
    kind: MeshGraphNodeKind;
    /** Preallocated for worker nodes; NULL for gates (design :128). */
    queueTaskId?: string;
    state: MeshGraphNodeState;
    /** Normalized immutable spec, including base message and bindings (design :130). */
    baseSpecJson: string;
    /** Compare-and-set generation (design :131). */
    materializationVersion: number;
    /** Digest of final message/target/dependency projection (design :132). */
    materializedDigest?: string;
    skipReason?: string;
    failureReason?: string;
    createdAt: string;
    updatedAt: string;
    stateChangedAt?: string;
}

/** design :139-143. The graph tables are the full DAG; queue `dependsOn` is only its execution projection. */
export interface MeshTaskGraphEdgeRow {
    graphId: MeshGraphId;
    meshId: string;
    fromNodeId: MeshGraphNodeId;
    toNodeId: MeshGraphNodeId;
    kind: MeshGraphEdgeKind;
    /** Condition metadata for `conditional` edges (run_if); NULL otherwise. */
    conditionJson?: string;
    /** Whether a skipped source may be omitted from the downstream projection (design :142). */
    omitOnSkip: boolean;
    createdAt: string;
}

/**
 * design :145-171 — one immutable, versioned completion envelope per successful
 * task attempt. Later side-effect evidence is a NEW immutable version, never a
 * mutation; downstream nodes record the exact source version/digest consumed.
 */
export interface MeshTaskOutputRow {
    taskId: string;
    version: number;
    meshId: string;
    graphId?: MeshGraphId;
    nodeId?: MeshGraphNodeId;
    attempt: number;
    status: string;
    /** The normalized completion envelope JSON (design :149-163). */
    envelopeJson: string;
    digest: string;
    createdAt: string;
}

/** design :173-177 and the gate contract :373-439. */
export interface MeshGraphGateRow {
    gateId: MeshGraphGateId;
    graphId: MeshGraphId;
    /** The graph node (kind `coordinator_gate`) this gate backs. */
    nodeId: MeshGraphNodeId;
    meshId: string;
    ref?: string;
    state: MeshGraphGateState;
    action: MeshGraphGateAction;
    instructions?: string;
    eligibleCoordinatorSessionId?: string;
    leaseOwnerSessionId?: string;
    /** Monotonically increasing claim generation; stale generations are rejected on release (design :407-417). */
    leaseGeneration: number;
    /** Opaque fencing token handed out at claim and required at release. */
    fencingToken?: string;
    leaseExpiresAt?: string;
    deadlineAt?: string;
    onTimeout: MeshGraphGateTimeoutPolicy;
    releaseOutcome?: string;
    releaseEvidenceJson?: string;
    releaseEvidenceDigest?: string;
    releaseIdempotencyKey?: string;
    createdAt: string;
    updatedAt: string;
}

/** design :179-183 and the workspace saga :441-511. The graph, not a coordinator transcript, owns prepared workspaces. */
export interface MeshGraphWorkspaceIntentRow {
    graphId: MeshGraphId;
    workspaceRef: string;
    meshId: string;
    /** Source/base node the worktree is prepared from. */
    sourceNodeId?: string;
    baseRevision?: string;
    /** Deterministic branch/name derived from graph id + workspace ref (design :467). */
    branchIdentity?: string;
    desiredPath?: string;
    sagaState: MeshGraphWorkspaceSagaState;
    /** Ownership stamp for compensation safety checks (design :497-504). */
    ownerTag?: string;
    leaseOwner?: string;
    leaseGeneration: number;
    fencingToken?: string;
    leaseExpiresAt?: string;
    createdNodeId?: string;
    createdWorktreePath?: string;
    /** Compensation policy: clean up the owned worktree when the graph fails (design :454). */
    cleanupOnGraphFailure: boolean;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
}

/** design :185-190. */
export interface MeshGraphOutboxRow {
    id: MeshGraphOutboxId;
    meshId: string;
    graphId?: MeshGraphId;
    /** e.g. graph_gate_awaiting, queue_wake — drained by the daemon after commit. */
    kind: string;
    payload: string;
    status: MeshGraphOutboxStatus;
    attemptCount: number;
    nextAttemptAtMs?: number;
    createdAt: string;
    updatedAt: string;
}
