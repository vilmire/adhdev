/**
 * GRAPH-ORCHESTRATION Phase A — additive graph control-plane schema.
 *
 * Source of truth: docs/design/2026-08-18-graph-orchestration-full.md
 * ("Persistent model", ~:98-191).
 *
 * ★ ADDITIVE ONLY (design :100-101): every statement is CREATE TABLE/INDEX
 * IF NOT EXISTS. No existing column or table is altered, so applying this to
 * a live runtime DB is a no-risk no-op apart from creating the new tables.
 * Every table is mesh_id-scoped (design :100). Idempotent: safe to run on
 * every boot, matching the rest of MeshRuntimeStore.migrate().
 *
 * ★ PHASE-A SCOPE: schema only. No graph behavior (transition runner,
 * materializer, gate leases, workspace saga) is implemented here — B–D.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import { migrateLegacyDependencyFailedQueueBlocks } from './mesh-graph-derived-failure.js';

export function migrateMeshGraphSchema(db: DatabaseHandle): void {
    db.exec(`
        -- design :103-120 — one row per accepted graph. UNIQUE(mesh_id, batch_id)
        -- makes client retries idempotent: a repeated request with the same
        -- normalized-plan digest returns the existing graph; the same key with a
        -- different digest fails with batch_id_conflict (enforced in phase E).
        CREATE TABLE IF NOT EXISTS mesh_task_graphs (
            graph_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            mission_id TEXT,
            source_coordinator_session_id TEXT,
            enqueue_surface TEXT NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 2,
            status TEXT NOT NULL DEFAULT 'preparing',
            task_count INTEGER NOT NULL DEFAULT 0,
            gate_count INTEGER NOT NULL DEFAULT 0,
            workspace_count INTEGER NOT NULL DEFAULT 0,
            dependency_edge_count INTEGER NOT NULL DEFAULT 0,
            plan_digest TEXT,
            policy_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            activated_at TEXT,
            terminal_at TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE (mesh_id, batch_id)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_task_graphs_mesh_status
            ON mesh_task_graphs(mesh_id, status);
        CREATE INDEX IF NOT EXISTS idx_mesh_task_graphs_mission
            ON mesh_task_graphs(mesh_id, mission_id);

        -- design :122-137 — persistent node identity; the batch-local ref is
        -- RETAINED here (unlike legacy batches) and included in every graph
        -- event. queue_task_id is preallocated for worker nodes, NULL for gates.
        CREATE TABLE IF NOT EXISTS mesh_task_graph_nodes (
            graph_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            ref TEXT,
            kind TEXT NOT NULL,
            queue_task_id TEXT,
            state TEXT NOT NULL DEFAULT 'declared',
            base_spec_json TEXT NOT NULL DEFAULT '{}',
            materialization_version INTEGER NOT NULL DEFAULT 0,
            materialized_digest TEXT,
            skip_reason TEXT,
            failure_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            state_changed_at TEXT,
            PRIMARY KEY (graph_id, node_id),
            UNIQUE (graph_id, ref)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_task_graph_nodes_mesh
            ON mesh_task_graph_nodes(mesh_id, state);
        CREATE INDEX IF NOT EXISTS idx_mesh_task_graph_nodes_queue_task
            ON mesh_task_graph_nodes(queue_task_id);

        -- design :139-143 — the full DAG. The queue row's dependsOn is only the
        -- execution projection of active worker-to-worker edges; this table is
        -- the superset the projection is derived from.
        CREATE TABLE IF NOT EXISTS mesh_task_graph_edges (
            graph_id TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            from_node_id TEXT NOT NULL,
            to_node_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            condition_json TEXT,
            omit_on_skip INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            PRIMARY KEY (graph_id, from_node_id, to_node_id, kind)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_task_graph_edges_to
            ON mesh_task_graph_edges(graph_id, to_node_id);
        CREATE INDEX IF NOT EXISTS idx_mesh_task_graph_edges_mesh
            ON mesh_task_graph_edges(mesh_id);

        -- design :145-171 — one immutable, versioned completion envelope per
        -- successful task attempt. Later side-effect evidence is a NEW version
        -- (PRIMARY KEY(task_id, version)), never an in-place mutation.
        CREATE TABLE IF NOT EXISTS mesh_task_outputs (
            task_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            mesh_id TEXT NOT NULL,
            graph_id TEXT,
            node_id TEXT,
            attempt INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            envelope_json TEXT NOT NULL,
            digest TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (task_id, version)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_task_outputs_mesh
            ON mesh_task_outputs(mesh_id);
        CREATE INDEX IF NOT EXISTS idx_mesh_task_outputs_graph_node
            ON mesh_task_outputs(graph_id, node_id);

        -- design :173-177 + gate contract :373-439 — persistent, leased
        -- coordinator gates. lease_generation is monotonically increasing; the
        -- fencing token makes a stale claimant's release rejectable. There is
        -- no auto-release path: on_timeout ∈ {hold, cancel_downstream, fail_graph}.
        CREATE TABLE IF NOT EXISTS mesh_graph_gates (
            gate_id TEXT PRIMARY KEY,
            graph_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            ref TEXT,
            state TEXT NOT NULL DEFAULT 'declared',
            action TEXT NOT NULL,
            instructions TEXT,
            eligible_coordinator_session_id TEXT,
            lease_owner_session_id TEXT,
            lease_generation INTEGER NOT NULL DEFAULT 0,
            fencing_token TEXT,
            lease_expires_at TEXT,
            deadline_at TEXT,
            on_timeout TEXT NOT NULL DEFAULT 'hold',
            release_outcome TEXT,
            release_evidence_json TEXT,
            release_evidence_digest TEXT,
            release_idempotency_key TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_graph_gates_graph
            ON mesh_graph_gates(graph_id);
        CREATE INDEX IF NOT EXISTS idx_mesh_graph_gates_mesh_state
            ON mesh_graph_gates(mesh_id, state);

        -- design :179-183 + workspace saga :441-511 — the graph (not a
        -- coordinator transcript) owns prepared workspaces. Compensation is an
        -- idempotent saga with owned-resource checks; never claimed to be
        -- atomic with git/filesystem side effects.
        CREATE TABLE IF NOT EXISTS mesh_graph_workspace_intents (
            graph_id TEXT NOT NULL,
            workspace_ref TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            source_node_id TEXT,
            base_revision TEXT,
            branch_identity TEXT,
            desired_path TEXT,
            saga_state TEXT NOT NULL DEFAULT 'declared',
            owner_tag TEXT,
            lease_owner TEXT,
            lease_generation INTEGER NOT NULL DEFAULT 0,
            fencing_token TEXT,
            lease_expires_at TEXT,
            created_node_id TEXT,
            created_worktree_path TEXT,
            cleanup_on_graph_failure INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (graph_id, workspace_ref)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_graph_workspace_intents_mesh
            ON mesh_graph_workspace_intents(mesh_id, saga_state);

        -- design :185-190 — transactional outbox. Graph notifications and queue
        -- wakeups are inserted in the SAME SQLite transaction as the state
        -- change; the daemon drains them after commit. This prevents "state
        -- committed but coordinator never notified" and "queue woken before
        -- materialization committed" races.
        CREATE TABLE IF NOT EXISTS mesh_graph_outbox (
            id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            graph_id TEXT,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_attempt_at_ms INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_graph_outbox_due
            ON mesh_graph_outbox(status, next_attempt_at_ms);
        CREATE INDEX IF NOT EXISTS idx_mesh_graph_outbox_mesh
            ON mesh_graph_outbox(mesh_id, status);
        CREATE INDEX IF NOT EXISTS idx_mesh_graph_outbox_graph
            ON mesh_graph_outbox(graph_id, status);
    `);

    // C3 (design :561-564): clear only exact `dependency_failed:<taskId>`
    // blockedReason markers. Other system holds are left untouched. The first
    // upgraded view derives the same user-visible reason from current statuses.
    migrateLegacyDependencyFailedQueueBlocks(db);
}
