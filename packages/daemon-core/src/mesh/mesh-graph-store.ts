/**
 * GRAPH-ORCHESTRATION Phase A — minimal persistence store for the graph
 * control-plane tables (design :98-191).
 *
 * ★ PHASE-A SCOPE (updated in phases B/C2): this is ROW CRUD ONLY — typed insert/read
 * plus the narrow row-level updates the phase-B transition runner, the phase-C2
 * gate claim/release/sweep (mesh-graph-gates.ts), and the phase-D workspace saga
 * need (node state, the materialization CAS, spec patch, graph status rollup,
 * outbox delivery marks, gate lease/release writes, workspace lease/state
 * writes). There is deliberately NO state machine here: transition DECISIONS
 * live in mesh-graph-transition-runner.ts (B), mesh-graph-gates.ts (C2), and
 * mesh-graph-workspace-saga.ts (D). Nothing in the scheduler reads these
 * tables.
 *
 * The store is bound to the MeshRuntimeStore's existing better-sqlite3 handle
 * (MeshRuntimeStore.graphStore()) so phase-B graph writes can join the ONE
 * queue transaction under the existing mesh queue lock (design :311-334).
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import type {
    MeshGraphGateRow,
    MeshGraphGateState,
    MeshGraphNodeState,
    MeshGraphOutboxRow,
    MeshGraphOutboxStatus,
    MeshGraphStatus,
    MeshGraphWorkspaceIntentRow,
    MeshGraphWorkspaceSagaState,
    MeshTaskGraphEdgeRow,
    MeshTaskGraphNodeRow,
    MeshTaskGraphRow,
    MeshTaskOutputRow,
} from './mesh-graph-types.js';

export class MeshGraphStore {
    constructor(private readonly db: DatabaseHandle) {}

    // ── mesh_task_graphs ─────────────────────────────────────────────────────

    insertGraph(row: MeshTaskGraphRow): void {
        this.db.prepare(`
            INSERT INTO mesh_task_graphs (
                graph_id, mesh_id, batch_id, mission_id, source_coordinator_session_id,
                enqueue_surface, schema_version, status, task_count, gate_count,
                workspace_count, dependency_edge_count, plan_digest, policy_json,
                created_at, activated_at, terminal_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.graphId, row.meshId, row.batchId, row.missionId ?? null,
            row.sourceCoordinatorSessionId ?? null, row.enqueueSurface, row.schemaVersion,
            row.status, row.taskCount, row.gateCount, row.workspaceCount,
            row.dependencyEdgeCount, row.planDigest ?? null, row.policyJson,
            row.createdAt, row.activatedAt ?? null, row.terminalAt ?? null, row.updatedAt,
        );
    }

    getGraph(graphId: string): MeshTaskGraphRow | null {
        const r = this.db.prepare(`SELECT * FROM mesh_task_graphs WHERE graph_id = ?`).get(graphId) as any;
        return r ? mapGraphRow(r) : null;
    }

    /** Idempotency lookup behind UNIQUE(mesh_id, batch_id) (design :118-120). */
    getGraphByBatchId(meshId: string, batchId: string): MeshTaskGraphRow | null {
        const r = this.db.prepare(
            `SELECT * FROM mesh_task_graphs WHERE mesh_id = ? AND batch_id = ?`
        ).get(meshId, batchId) as any;
        return r ? mapGraphRow(r) : null;
    }

    /**
     * Phase-E graph listing for the graph view / metrics (design :759-775). Newest
     * first so a view without an explicit graph id shows current work. `statuses`
     * narrows to e.g. the in-flight set.
     */
    listGraphsByMesh(meshId: string, opts?: { statuses?: readonly MeshGraphStatus[]; limit?: number }): MeshTaskGraphRow[] {
        const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
        const statuses = opts?.statuses;
        if (statuses && statuses.length > 0) {
            const placeholders = statuses.map(() => '?').join(',');
            const rows = this.db.prepare(
                `SELECT * FROM mesh_task_graphs WHERE mesh_id = ? AND status IN (${placeholders})
                 ORDER BY created_at DESC LIMIT ?`
            ).all(meshId, ...statuses, limit) as any[];
            return rows.map(mapGraphRow);
        }
        const rows = this.db.prepare(
            `SELECT * FROM mesh_task_graphs WHERE mesh_id = ? ORDER BY created_at DESC LIMIT ?`
        ).all(meshId, limit) as any[];
        return rows.map(mapGraphRow);
    }

    /** Exact size of the same mesh/status window exposed by listGraphsByMesh. */
    countGraphsByMesh(meshId: string, opts?: { statuses?: readonly MeshGraphStatus[] }): number {
        const statuses = opts?.statuses;
        if (statuses && statuses.length > 0) {
            const placeholders = statuses.map(() => '?').join(',');
            const row = this.db.prepare(
                `SELECT COUNT(*) AS count FROM mesh_task_graphs WHERE mesh_id = ? AND status IN (${placeholders})`
            ).get(meshId, ...statuses) as { count: number };
            return row.count;
        }
        const row = this.db.prepare(
            `SELECT COUNT(*) AS count FROM mesh_task_graphs WHERE mesh_id = ?`
        ).get(meshId) as { count: number };
        return row.count;
    }

    /**
     * Phase-E: replace the graph's normalized policy document. Used at plan-commit
     * time to attach the enqueue-decision provenance record next to the persisted
     * `on_dependency_failure` (design :697-710, :733-738). Deliberately a whole-
     * document write — the policy is normalized once at commit and never patched
     * field-by-field afterwards.
     */
    updateGraphPolicyJson(graphId: string, policyJson: string, nowIso: string): void {
        this.db.prepare(
            `UPDATE mesh_task_graphs SET policy_json = ?, updated_at = ? WHERE graph_id = ?`
        ).run(policyJson, nowIso, graphId);
    }

    /** Phase-B rollup: graph status transition once every node reached a terminal-equivalent state. */
    updateGraphStatus(graphId: string, status: MeshGraphStatus, nowIso: string, terminal = false): void {
        this.db.prepare(`
            UPDATE mesh_task_graphs
            SET status = ?, updated_at = ?, terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END
            WHERE graph_id = ?
        `).run(status, nowIso, terminal ? 1 : 0, nowIso, graphId);
    }

    // ── mesh_task_graph_nodes ────────────────────────────────────────────────

    insertNode(row: MeshTaskGraphNodeRow): void {
        this.db.prepare(`
            INSERT INTO mesh_task_graph_nodes (
                graph_id, node_id, mesh_id, ref, kind, queue_task_id, state,
                base_spec_json, materialization_version, materialized_digest,
                skip_reason, failure_reason, created_at, updated_at, state_changed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.graphId, row.nodeId, row.meshId, row.ref ?? null, row.kind,
            row.queueTaskId ?? null, row.state, row.baseSpecJson,
            row.materializationVersion, row.materializedDigest ?? null,
            row.skipReason ?? null, row.failureReason ?? null,
            row.createdAt, row.updatedAt, row.stateChangedAt ?? null,
        );
    }

    getNode(graphId: string, nodeId: string): MeshTaskGraphNodeRow | null {
        const r = this.db.prepare(
            `SELECT * FROM mesh_task_graph_nodes WHERE graph_id = ? AND node_id = ?`
        ).get(graphId, nodeId) as any;
        return r ? mapNodeRow(r) : null;
    }

    /** Reverse lookup from a queue row to its backing graph node (phase B transition runner). */
    findNodeByQueueTaskId(meshId: string, queueTaskId: string): MeshTaskGraphNodeRow | null {
        const r = this.db.prepare(
            `SELECT * FROM mesh_task_graph_nodes WHERE mesh_id = ? AND queue_task_id = ?`
        ).get(meshId, queueTaskId) as any;
        return r ? mapNodeRow(r) : null;
    }

    /**
     * Terminal/state transition for one node (phase B step 4). Plain row write — the
     * TRANSITION DECISION lives in the transition runner, not here.
     */
    updateNodeState(
        graphId: string,
        nodeId: string,
        state: MeshGraphNodeState,
        nowIso: string,
        opts?: { skipReason?: string; failureReason?: string },
    ): void {
        this.db.prepare(`
            UPDATE mesh_task_graph_nodes
            SET state = ?, skip_reason = COALESCE(?, skip_reason),
                failure_reason = COALESCE(?, failure_reason),
                updated_at = ?, state_changed_at = ?
            WHERE graph_id = ? AND node_id = ?
        `).run(state, opts?.skipReason ?? null, opts?.failureReason ?? null, nowIso, nowIso, graphId, nodeId);
    }

    /**
     * Phase-B materialization CAS (design :332-334): the update lands ONLY when the
     * node's current materialization_version equals `expectedVersion`, so a replayed
     * completion event — which regenerates the same digest from the same version —
     * loses the race and performs no duplicate transition. Returns true when this
     * call won the compare-and-set.
     */
    advanceNodeMaterializationCAS(
        graphId: string,
        nodeId: string,
        expectedVersion: number,
        patch: { state: MeshGraphNodeState; materializedDigest: string },
        nowIso: string,
    ): boolean {
        const r = this.db.prepare(`
            UPDATE mesh_task_graph_nodes
            SET state = ?, materialization_version = ?, materialized_digest = ?,
                updated_at = ?, state_changed_at = ?
            WHERE graph_id = ? AND node_id = ? AND materialization_version = ?
        `).run(patch.state, expectedVersion + 1, patch.materializedDigest, nowIso, nowIso, graphId, nodeId, expectedVersion);
        return r.changes > 0;
    }

    /**
     * Pre-assignment spec patch (design :285, :334). Bumps materialization_version so
     * any digest computed from the pre-patch spec can never clear a block again.
     * The `task_already_claimed` guard lives in the transition runner — this is the row write.
     */
    updateNodeBaseSpec(graphId: string, nodeId: string, baseSpecJson: string, nowIso: string): void {
        this.db.prepare(`
            UPDATE mesh_task_graph_nodes
            SET base_spec_json = ?, materialization_version = materialization_version + 1, updated_at = ?
            WHERE graph_id = ? AND node_id = ?
        `).run(baseSpecJson, nowIso, graphId, nodeId);
    }

    listNodes(graphId: string): MeshTaskGraphNodeRow[] {
        const rows = this.db.prepare(
            `SELECT * FROM mesh_task_graph_nodes WHERE graph_id = ? ORDER BY created_at ASC`
        ).all(graphId) as any[];
        return rows.map(mapNodeRow);
    }

    // ── mesh_task_graph_edges ────────────────────────────────────────────────

    insertEdge(row: MeshTaskGraphEdgeRow): void {
        this.db.prepare(`
            INSERT INTO mesh_task_graph_edges (
                graph_id, mesh_id, from_node_id, to_node_id, kind,
                condition_json, omit_on_skip, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.graphId, row.meshId, row.fromNodeId, row.toNodeId, row.kind,
            row.conditionJson ?? null, row.omitOnSkip ? 1 : 0, row.createdAt,
        );
    }

    listEdges(graphId: string): MeshTaskGraphEdgeRow[] {
        const rows = this.db.prepare(
            `SELECT * FROM mesh_task_graph_edges WHERE graph_id = ? ORDER BY created_at ASC`
        ).all(graphId) as any[];
        return rows.map(mapEdgeRow);
    }

    // ── mesh_task_outputs ────────────────────────────────────────────────────

    /** Append-only: a later evidence arrival is a NEW (task_id, version) row. */
    insertOutput(row: MeshTaskOutputRow): void {
        this.db.prepare(`
            INSERT INTO mesh_task_outputs (
                task_id, version, mesh_id, graph_id, node_id, attempt,
                status, envelope_json, digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.taskId, row.version, row.meshId, row.graphId ?? null, row.nodeId ?? null,
            row.attempt, row.status, row.envelopeJson, row.digest, row.createdAt,
        );
    }

    getOutput(taskId: string, version: number): MeshTaskOutputRow | null {
        const r = this.db.prepare(
            `SELECT * FROM mesh_task_outputs WHERE task_id = ? AND version = ?`
        ).get(taskId, version) as any;
        return r ? mapOutputRow(r) : null;
    }

    getLatestOutput(taskId: string): MeshTaskOutputRow | null {
        const r = this.db.prepare(
            `SELECT * FROM mesh_task_outputs WHERE task_id = ? ORDER BY version DESC LIMIT 1`
        ).get(taskId) as any;
        return r ? mapOutputRow(r) : null;
    }

    // ── mesh_graph_gates ─────────────────────────────────────────────────────

    insertGate(row: MeshGraphGateRow): void {
        this.db.prepare(`
            INSERT INTO mesh_graph_gates (
                gate_id, graph_id, node_id, mesh_id, ref, state, action, instructions,
                eligible_coordinator_session_id, lease_owner_session_id, lease_generation,
                fencing_token, lease_expires_at, deadline_at, on_timeout,
                release_outcome, release_evidence_json, release_evidence_digest,
                release_idempotency_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.gateId, row.graphId, row.nodeId, row.meshId, row.ref ?? null, row.state,
            row.action, row.instructions ?? null, row.eligibleCoordinatorSessionId ?? null,
            row.leaseOwnerSessionId ?? null, row.leaseGeneration, row.fencingToken ?? null,
            row.leaseExpiresAt ?? null, row.deadlineAt ?? null, row.onTimeout,
            row.releaseOutcome ?? null, row.releaseEvidenceJson ?? null,
            row.releaseEvidenceDigest ?? null, row.releaseIdempotencyKey ?? null,
            row.createdAt, row.updatedAt,
        );
    }

    getGate(gateId: string): MeshGraphGateRow | null {
        const r = this.db.prepare(`SELECT * FROM mesh_graph_gates WHERE gate_id = ?`).get(gateId) as any;
        return r ? mapGateRow(r) : null;
    }

    /** Reverse lookup from a graph node (kind `coordinator_gate`) to its gate row (phase C2). */
    findGateByNodeId(graphId: string, nodeId: string): MeshGraphGateRow | null {
        const r = this.db.prepare(
            `SELECT * FROM mesh_graph_gates WHERE graph_id = ? AND node_id = ?`
        ).get(graphId, nodeId) as any;
        return r ? mapGateRow(r) : null;
    }

    listGatesByGraph(graphId: string): MeshGraphGateRow[] {
        const rows = this.db.prepare(
            `SELECT * FROM mesh_graph_gates WHERE graph_id = ? ORDER BY created_at ASC`
        ).all(graphId) as any[];
        return rows.map(mapGateRow);
    }

    /** Phase-C2 timeout sweep: gates of one mesh, optionally narrowed to states (e.g. awaiting/claimed). */
    listGatesByMesh(meshId: string, states?: readonly string[]): MeshGraphGateRow[] {
        if (states && states.length > 0) {
            const placeholders = states.map(() => '?').join(',');
            const rows = this.db.prepare(
                `SELECT * FROM mesh_graph_gates WHERE mesh_id = ? AND state IN (${placeholders}) ORDER BY created_at ASC`
            ).all(meshId, ...states) as any[];
            return rows.map(mapGateRow);
        }
        const rows = this.db.prepare(
            `SELECT * FROM mesh_graph_gates WHERE mesh_id = ? ORDER BY created_at ASC`
        ).all(meshId) as any[];
        return rows.map(mapGateRow);
    }

    /**
     * Row write for phase C2 (claim / release / deadline sweep). `undefined`
     * fields are left unchanged; explicit `null` clears a nullable field. The
     * optional generation CAS rejects a stale fenced writer: the update lands
     * only while the row still carries `cas.leaseGeneration`.
     */
    patchGate(
        gateId: string,
        patch: {
            state?: MeshGraphGateState;
            leaseOwnerSessionId?: string | null;
            leaseGeneration?: number;
            fencingToken?: string | null;
            leaseExpiresAt?: string | null;
            deadlineAt?: string | null;
            releaseOutcome?: string | null;
            releaseEvidenceJson?: string | null;
            releaseEvidenceDigest?: string | null;
            releaseIdempotencyKey?: string | null;
        },
        nowIso: string,
        cas?: { leaseGeneration: number },
    ): boolean {
        const current = this.getGate(gateId);
        if (!current) return false;
        if (cas && current.leaseGeneration !== cas.leaseGeneration) return false;
        const next = {
            state: patch.state ?? current.state,
            leaseOwnerSessionId: patch.leaseOwnerSessionId === undefined ? current.leaseOwnerSessionId ?? null : patch.leaseOwnerSessionId,
            leaseGeneration: patch.leaseGeneration ?? current.leaseGeneration,
            fencingToken: patch.fencingToken === undefined ? current.fencingToken ?? null : patch.fencingToken,
            leaseExpiresAt: patch.leaseExpiresAt === undefined ? current.leaseExpiresAt ?? null : patch.leaseExpiresAt,
            deadlineAt: patch.deadlineAt === undefined ? current.deadlineAt ?? null : patch.deadlineAt,
            releaseOutcome: patch.releaseOutcome === undefined ? current.releaseOutcome ?? null : patch.releaseOutcome,
            releaseEvidenceJson: patch.releaseEvidenceJson === undefined ? current.releaseEvidenceJson ?? null : patch.releaseEvidenceJson,
            releaseEvidenceDigest: patch.releaseEvidenceDigest === undefined ? current.releaseEvidenceDigest ?? null : patch.releaseEvidenceDigest,
            releaseIdempotencyKey: patch.releaseIdempotencyKey === undefined ? current.releaseIdempotencyKey ?? null : patch.releaseIdempotencyKey,
        };
        const r = this.db.prepare(`
            UPDATE mesh_graph_gates
            SET state = ?, lease_owner_session_id = ?, lease_generation = ?, fencing_token = ?,
                lease_expires_at = ?, deadline_at = ?, release_outcome = ?,
                release_evidence_json = ?, release_evidence_digest = ?,
                release_idempotency_key = ?, updated_at = ?
            WHERE gate_id = ? AND lease_generation = ?
        `).run(
            next.state, next.leaseOwnerSessionId, next.leaseGeneration, next.fencingToken,
            next.leaseExpiresAt, next.deadlineAt, next.releaseOutcome,
            next.releaseEvidenceJson, next.releaseEvidenceDigest,
            next.releaseIdempotencyKey, nowIso,
            gateId, current.leaseGeneration,
        );
        return r.changes > 0;
    }

    // ── mesh_graph_workspace_intents ─────────────────────────────────────────

    insertWorkspaceIntent(row: MeshGraphWorkspaceIntentRow): void {
        this.db.prepare(`
            INSERT INTO mesh_graph_workspace_intents (
                graph_id, workspace_ref, mesh_id, source_node_id, base_revision,
                branch_identity, desired_path, saga_state, owner_tag, lease_owner,
                lease_generation, fencing_token, lease_expires_at, created_node_id,
                created_worktree_path, cleanup_on_graph_failure, last_error,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.graphId, row.workspaceRef, row.meshId, row.sourceNodeId ?? null,
            row.baseRevision ?? null, row.branchIdentity ?? null, row.desiredPath ?? null,
            row.sagaState, row.ownerTag ?? null, row.leaseOwner ?? null, row.leaseGeneration,
            row.fencingToken ?? null, row.leaseExpiresAt ?? null, row.createdNodeId ?? null,
            row.createdWorktreePath ?? null, row.cleanupOnGraphFailure ? 1 : 0,
            row.lastError ?? null, row.createdAt, row.updatedAt,
        );
    }

    getWorkspaceIntent(graphId: string, workspaceRef: string): MeshGraphWorkspaceIntentRow | null {
        const r = this.db.prepare(
            `SELECT * FROM mesh_graph_workspace_intents WHERE graph_id = ? AND workspace_ref = ?`
        ).get(graphId, workspaceRef) as any;
        return r ? mapWorkspaceIntentRow(r) : null;
    }

    listWorkspaceIntents(graphId: string): MeshGraphWorkspaceIntentRow[] {
        const rows = this.db.prepare(
            `SELECT * FROM mesh_graph_workspace_intents WHERE graph_id = ? ORDER BY created_at ASC`
        ).all(graphId) as any[];
        return rows.map(mapWorkspaceIntentRow);
    }

    listWorkspaceIntentsByMesh(meshId: string, states?: readonly MeshGraphWorkspaceSagaState[]): MeshGraphWorkspaceIntentRow[] {
        if (states && states.length > 0) {
            const placeholders = states.map(() => '?').join(',');
            const rows = this.db.prepare(
                `SELECT * FROM mesh_graph_workspace_intents WHERE mesh_id = ? AND saga_state IN (${placeholders}) ORDER BY created_at ASC`
            ).all(meshId, ...states) as any[];
            return rows.map(mapWorkspaceIntentRow);
        }
        const rows = this.db.prepare(
            `SELECT * FROM mesh_graph_workspace_intents WHERE mesh_id = ? ORDER BY created_at ASC`
        ).all(meshId) as any[];
        return rows.map(mapWorkspaceIntentRow);
    }

    /**
     * Intents whose saga lease is missing or expired. The D worker claims these
     * with a higher fencing generation (design :506-507).
     */
    listExpiredWorkspaceLeases(meshId: string, nowIso: string): MeshGraphWorkspaceIntentRow[] {
        const rows = this.db.prepare(`
            SELECT * FROM mesh_graph_workspace_intents
            WHERE mesh_id = ?
              AND saga_state IN ('declared', 'preparing', 'compensating')
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            ORDER BY created_at ASC
        `).all(meshId, nowIso) as any[];
        return rows.map(mapWorkspaceIntentRow);
    }

    listWorkspaceIntentsByCreatedNodeId(meshId: string, createdNodeId: string): MeshGraphWorkspaceIntentRow[] {
        const rows = this.db.prepare(
            `SELECT * FROM mesh_graph_workspace_intents WHERE mesh_id = ? AND created_node_id = ?`
        ).all(meshId, createdNodeId) as any[];
        return rows.map(mapWorkspaceIntentRow);
    }

    /**
     * Lease CAS. Succeeds when the row is unleased, expired, or already owned
     * by `leaseOwner`. A live foreign lease is left untouched. Same-owner
     * refresh keeps the generation; a takeover increments it (design :506-507).
     */
    claimWorkspaceIntentLease(
        graphId: string,
        workspaceRef: string,
        leaseOwner: string,
        fencingToken: string,
        leaseExpiresAt: string,
        nowIso: string,
    ): { claimed: boolean; generation: number; fencingToken?: string; refreshed: boolean } {
        const current = this.getWorkspaceIntent(graphId, workspaceRef);
        if (!current) return { claimed: false, generation: 0, refreshed: false };
        const expired = !current.leaseExpiresAt || current.leaseExpiresAt <= nowIso;
        const sameOwner = current.leaseOwner === leaseOwner;
        if (current.leaseOwner && !expired && !sameOwner) {
            return { claimed: false, generation: current.leaseGeneration, fencingToken: current.fencingToken, refreshed: false };
        }
        if (sameOwner && !expired) {
            const r = this.db.prepare(`
                UPDATE mesh_graph_workspace_intents
                SET lease_expires_at = ?, updated_at = ?
                WHERE graph_id = ? AND workspace_ref = ? AND lease_generation = ? AND lease_owner = ?
            `).run(leaseExpiresAt, nowIso, graphId, workspaceRef, current.leaseGeneration, leaseOwner);
            return {
                claimed: r.changes > 0,
                generation: current.leaseGeneration,
                fencingToken: current.fencingToken,
                refreshed: r.changes > 0,
            };
        }
        const nextGen = current.leaseGeneration + 1;
        const r = this.db.prepare(`
            UPDATE mesh_graph_workspace_intents
            SET lease_owner = ?, lease_generation = ?, fencing_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE graph_id = ? AND workspace_ref = ? AND lease_generation = ?
              AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
        `).run(leaseOwner, nextGen, fencingToken, leaseExpiresAt, nowIso, graphId, workspaceRef, current.leaseGeneration, nowIso, leaseOwner);
        return { claimed: r.changes > 0, generation: nextGen, fencingToken, refreshed: false };
    }

    /**
     * Row write for D. `undefined` fields are left unchanged; `null` lastError
     * clears. The optional generation CAS rejects a stale fenced writer.
     */
    patchWorkspaceIntent(
        graphId: string,
        workspaceRef: string,
        patch: {
            sagaState?: MeshGraphWorkspaceSagaState;
            ownerTag?: string | null;
            createdNodeId?: string | null;
            createdWorktreePath?: string | null;
            lastError?: string | null;
            baseRevision?: string | null;
            branchIdentity?: string | null;
            leaseOwner?: string | null;
            fencingToken?: string | null;
            leaseExpiresAt?: string | null;
        },
        nowIso: string,
        cas?: { leaseGeneration: number },
    ): boolean {
        const current = this.getWorkspaceIntent(graphId, workspaceRef);
        if (!current) return false;
        if (cas && current.leaseGeneration !== cas.leaseGeneration) return false;
        const next = {
            sagaState: patch.sagaState ?? current.sagaState,
            ownerTag: patch.ownerTag === undefined ? current.ownerTag ?? null : patch.ownerTag,
            createdNodeId: patch.createdNodeId === undefined ? current.createdNodeId ?? null : patch.createdNodeId,
            createdWorktreePath: patch.createdWorktreePath === undefined ? current.createdWorktreePath ?? null : patch.createdWorktreePath,
            lastError: patch.lastError === undefined ? current.lastError ?? null : patch.lastError,
            baseRevision: patch.baseRevision === undefined ? current.baseRevision ?? null : patch.baseRevision,
            branchIdentity: patch.branchIdentity === undefined ? current.branchIdentity ?? null : patch.branchIdentity,
            leaseOwner: patch.leaseOwner === undefined ? current.leaseOwner ?? null : patch.leaseOwner,
            fencingToken: patch.fencingToken === undefined ? current.fencingToken ?? null : patch.fencingToken,
            leaseExpiresAt: patch.leaseExpiresAt === undefined ? current.leaseExpiresAt ?? null : patch.leaseExpiresAt,
        };
        const r = this.db.prepare(`
            UPDATE mesh_graph_workspace_intents
            SET saga_state = ?, owner_tag = ?, created_node_id = ?, created_worktree_path = ?,
                last_error = ?, base_revision = ?, branch_identity = ?, lease_owner = ?,
                fencing_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE graph_id = ? AND workspace_ref = ? AND lease_generation = ?
        `).run(
            next.sagaState, next.ownerTag, next.createdNodeId, next.createdWorktreePath,
            next.lastError, next.baseRevision, next.branchIdentity, next.leaseOwner,
            next.fencingToken, next.leaseExpiresAt, nowIso,
            graphId, workspaceRef, current.leaseGeneration,
        );
        return r.changes > 0;
    }

    // ── mesh_graph_outbox ────────────────────────────────────────────────────

    /**
     * Insert an outbox event. Phase-B callers must invoke this INSIDE the same
     * SQLite transaction as the graph state change it notifies about
     * (design :185-190); draining after commit is also phase B.
     */
    insertOutboxEvent(row: MeshGraphOutboxRow): void {
        this.db.prepare(`
            INSERT INTO mesh_graph_outbox (
                id, mesh_id, graph_id, kind, payload, status,
                attempt_count, next_attempt_at_ms, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.id, row.meshId, row.graphId ?? null, row.kind, row.payload, row.status,
            row.attemptCount, row.nextAttemptAtMs ?? null, row.createdAt, row.updatedAt,
        );
    }

    listPendingOutboxEvents(meshId: string): MeshGraphOutboxRow[] {
        const rows = this.db.prepare(
            `SELECT * FROM mesh_graph_outbox WHERE mesh_id = ? AND status = 'pending' ORDER BY created_at ASC`
        ).all(meshId) as any[];
        return rows.map(mapOutboxRow);
    }

    /**
     * Every outbox row for a mesh regardless of delivery status — the graph's own
     * event stream, used for audit/replay views and by the phase-C1 telemetry
     * assertions. `listPendingOutboxEvents` is the drain path; this is the reader.
     */
    listOutboxEvents(meshId: string, graphId?: string): MeshGraphOutboxRow[] {
        const rows = graphId
            ? this.db.prepare(
                `SELECT * FROM mesh_graph_outbox WHERE mesh_id = ? AND graph_id = ? ORDER BY created_at ASC`
            ).all(meshId, graphId) as any[]
            : this.db.prepare(
                `SELECT * FROM mesh_graph_outbox WHERE mesh_id = ? ORDER BY created_at ASC`
            ).all(meshId) as any[];
        return rows.map(mapOutboxRow);
    }

    /** Phase-B drain bookkeeping: terminal delivery state for one outbox row. */
    markOutboxEventStatus(
        id: string,
        status: MeshGraphOutboxStatus,
        nowIso: string,
        opts?: { incrementAttempt?: boolean; nextAttemptAtMs?: number },
    ): void {
        this.db.prepare(`
            UPDATE mesh_graph_outbox
            SET status = ?, updated_at = ?,
                attempt_count = attempt_count + ?,
                next_attempt_at_ms = COALESCE(?, next_attempt_at_ms)
            WHERE id = ?
        `).run(status, nowIso, opts?.incrementAttempt ? 1 : 0, opts?.nextAttemptAtMs ?? null, id);
    }
}

// ── Row mappers (snake_case columns → camelCase rows) ────────────────────────

function mapGraphRow(r: any): MeshTaskGraphRow {
    return {
        graphId: r.graph_id,
        meshId: r.mesh_id,
        batchId: r.batch_id,
        missionId: r.mission_id ?? undefined,
        sourceCoordinatorSessionId: r.source_coordinator_session_id ?? undefined,
        enqueueSurface: r.enqueue_surface,
        schemaVersion: r.schema_version,
        status: r.status,
        taskCount: r.task_count,
        gateCount: r.gate_count,
        workspaceCount: r.workspace_count,
        dependencyEdgeCount: r.dependency_edge_count,
        planDigest: r.plan_digest ?? undefined,
        policyJson: r.policy_json,
        createdAt: r.created_at,
        activatedAt: r.activated_at ?? undefined,
        terminalAt: r.terminal_at ?? undefined,
        updatedAt: r.updated_at,
    };
}

function mapNodeRow(r: any): MeshTaskGraphNodeRow {
    return {
        graphId: r.graph_id,
        nodeId: r.node_id,
        meshId: r.mesh_id,
        ref: r.ref ?? undefined,
        kind: r.kind,
        queueTaskId: r.queue_task_id ?? undefined,
        state: r.state,
        baseSpecJson: r.base_spec_json,
        materializationVersion: r.materialization_version,
        materializedDigest: r.materialized_digest ?? undefined,
        skipReason: r.skip_reason ?? undefined,
        failureReason: r.failure_reason ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        stateChangedAt: r.state_changed_at ?? undefined,
    };
}

function mapEdgeRow(r: any): MeshTaskGraphEdgeRow {
    return {
        graphId: r.graph_id,
        meshId: r.mesh_id,
        fromNodeId: r.from_node_id,
        toNodeId: r.to_node_id,
        kind: r.kind,
        conditionJson: r.condition_json ?? undefined,
        omitOnSkip: r.omit_on_skip === 1,
        createdAt: r.created_at,
    };
}

function mapOutputRow(r: any): MeshTaskOutputRow {
    return {
        taskId: r.task_id,
        version: r.version,
        meshId: r.mesh_id,
        graphId: r.graph_id ?? undefined,
        nodeId: r.node_id ?? undefined,
        attempt: r.attempt,
        status: r.status,
        envelopeJson: r.envelope_json,
        digest: r.digest,
        createdAt: r.created_at,
    };
}

function mapGateRow(r: any): MeshGraphGateRow {
    return {
        gateId: r.gate_id,
        graphId: r.graph_id,
        nodeId: r.node_id,
        meshId: r.mesh_id,
        ref: r.ref ?? undefined,
        state: r.state,
        action: r.action,
        instructions: r.instructions ?? undefined,
        eligibleCoordinatorSessionId: r.eligible_coordinator_session_id ?? undefined,
        leaseOwnerSessionId: r.lease_owner_session_id ?? undefined,
        leaseGeneration: r.lease_generation,
        fencingToken: r.fencing_token ?? undefined,
        leaseExpiresAt: r.lease_expires_at ?? undefined,
        deadlineAt: r.deadline_at ?? undefined,
        onTimeout: r.on_timeout,
        releaseOutcome: r.release_outcome ?? undefined,
        releaseEvidenceJson: r.release_evidence_json ?? undefined,
        releaseEvidenceDigest: r.release_evidence_digest ?? undefined,
        releaseIdempotencyKey: r.release_idempotency_key ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function mapWorkspaceIntentRow(r: any): MeshGraphWorkspaceIntentRow {
    return {
        graphId: r.graph_id,
        workspaceRef: r.workspace_ref,
        meshId: r.mesh_id,
        sourceNodeId: r.source_node_id ?? undefined,
        baseRevision: r.base_revision ?? undefined,
        branchIdentity: r.branch_identity ?? undefined,
        desiredPath: r.desired_path ?? undefined,
        sagaState: r.saga_state,
        ownerTag: r.owner_tag ?? undefined,
        leaseOwner: r.lease_owner ?? undefined,
        leaseGeneration: r.lease_generation,
        fencingToken: r.fencing_token ?? undefined,
        leaseExpiresAt: r.lease_expires_at ?? undefined,
        createdNodeId: r.created_node_id ?? undefined,
        createdWorktreePath: r.created_worktree_path ?? undefined,
        cleanupOnGraphFailure: r.cleanup_on_graph_failure === 1,
        lastError: r.last_error ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function mapOutboxRow(r: any): MeshGraphOutboxRow {
    return {
        id: r.id,
        meshId: r.mesh_id,
        graphId: r.graph_id ?? undefined,
        kind: r.kind,
        payload: r.payload,
        status: r.status,
        attemptCount: r.attempt_count,
        nextAttemptAtMs: r.next_attempt_at_ms ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
