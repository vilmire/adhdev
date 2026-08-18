import { describe, expect, it, afterEach } from 'vitest';
import { vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

// GRAPH-ORCHESTRATION Phase A — additive graph control-plane schema.
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md §"Persistent model"
//   (:98-191). These tests pin the Phase-A contract:
//     1. All seven graph tables (+indexes) are created on the EXISTING runtime SQLite DB.
//     2. The migration is ADDITIVE (no existing table/column touched) and idempotent.
//     3. The mesh-graph-store row CRUD round-trips every table.
//     4. The state enums match the design exactly (incl. NO gate auto-release).
//   No graph behavior (runner/materializer/gates/saga) exists yet — that is B–D.

const testTmpDir = join(tmpdir(), `adhdev-graph-schema-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
const runtimeRequire = createRequire(import.meta.url);

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import {
    MESH_GRAPH_STATUSES,
    MESH_GRAPH_SCHEMA_VERSION,
    MESH_GRAPH_ENQUEUE_SURFACES,
    MESH_GRAPH_NODE_KINDS,
    MESH_GRAPH_NODE_STATES,
    MESH_GRAPH_EDGE_KINDS,
    MESH_GRAPH_ON_UPSTREAM_SKIP_POLICIES,
    MESH_GRAPH_GATE_STATES,
    MESH_GRAPH_GATE_ACTIONS,
    MESH_GRAPH_GATE_TIMEOUT_POLICIES,
    MESH_GRAPH_ON_DEPENDENCY_FAILURE_POLICIES,
    MESH_GRAPH_WORKSPACE_SAGA_STATES,
    MESH_GRAPH_OUTBOX_STATUSES,
    newMeshGraphId,
    newMeshGraphNodeId,
    newMeshGraphGateId,
    newMeshGraphOutboxId,
} from '../../src/mesh/mesh-graph-types.js';

const GRAPH_TABLES = [
    'mesh_task_graphs',
    'mesh_task_graph_nodes',
    'mesh_task_graph_edges',
    'mesh_task_outputs',
    'mesh_graph_gates',
    'mesh_graph_workspace_intents',
    'mesh_graph_outbox',
] as const;

function dbPath(): string {
    return join(testConfigDir, 'mesh-ledger', 'mesh-runtime.db');
}

function tableNames(db: any): string[] {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[])
        .map(r => r.name);
}

function indexNames(db: any, table: string): string[] {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`).all(table) as any[])
        .map(r => r.name);
}

function meshId(): string {
    return `mesh_graph_schema_${randomUUID().slice(0, 8)}`;
}

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('graph schema migration (design :98-191)', () => {
    it('creates all seven graph tables and their indexes on a fresh store', () => {
        const store = MeshRuntimeStore.getInstance();
        const tables = tableNames((store as any).db);
        for (const t of GRAPH_TABLES) expect(tables, `missing table ${t}`).toContain(t);
        // Pre-existing runtime tables are still there — nothing was dropped/recreated.
        for (const t of ['mesh_queue', 'mesh_event_ledger', 'mesh_turn_outbox']) {
            expect(tables, `pre-existing table ${t} must survive`).toContain(t);
        }
        // Spot-check the indexes that the design's access patterns need.
        expect(indexNames((store as any).db, 'mesh_task_graphs')).toContain('idx_mesh_task_graphs_mesh_status');
        expect(indexNames((store as any).db, 'mesh_graph_outbox')).toContain('idx_mesh_graph_outbox_due');
        expect(indexNames((store as any).db, 'mesh_task_graph_nodes')).toContain('idx_mesh_task_graph_nodes_queue_task');
    });

    it('applies additively to a pre-existing runtime DB without touching existing rows', () => {
        // Simulate a live pre-Phase-A install: a runtime DB that already has queue data
        // and NONE of the graph tables.
        const ledgerDir = join(testConfigDir, 'mesh-ledger');
        mkdirSync(ledgerDir, { recursive: true });
        const Database = runtimeRequire('better-sqlite3') as any;
        const legacy = new Database(dbPath());
        legacy.exec(`
            CREATE TABLE mesh_queue (
                id TEXT PRIMARY KEY,
                mesh_id TEXT NOT NULL,
                status TEXT NOT NULL,
                target_node_id TEXT,
                target_session_id TEXT,
                assigned_node_id TEXT,
                assigned_session_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
        `);
        legacy.prepare(`INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`)
            .run('legacy-task-1', 'mesh_legacy', 'pending', new Date().toISOString(), new Date().toISOString(), JSON.stringify({ id: 'legacy-task-1', message: 'pre-existing work' }));
        legacy.close();

        // Open the store → migrate() runs → graph tables must appear, queue row intact.
        const store = MeshRuntimeStore.getInstance();
        const tables = tableNames((store as any).db);
        for (const t of GRAPH_TABLES) expect(tables, `missing table ${t} on existing DB`).toContain(t);
        const row = (store as any).db.prepare(`SELECT payload FROM mesh_queue WHERE id = 'legacy-task-1'`).get() as any;
        expect(row).toBeTruthy();
        expect(JSON.parse(row.payload).message).toBe('pre-existing work');

        // Idempotent: a second open (re-running the whole migration) is a no-op.
        __resetMeshRuntimeStoreForTests();
        const reopened = MeshRuntimeStore.getInstance();
        for (const t of GRAPH_TABLES) expect(tableNames((reopened as any).db)).toContain(t);
        expect((reopened as any).db.prepare(`SELECT COUNT(*) c FROM mesh_queue`).get().c).toBe(1);
    });

    it('does not alter the pre-existing mesh_queue columns (additive only)', () => {
        const store = MeshRuntimeStore.getInstance();
        const cols = (store as any).db.prepare(`PRAGMA table_info(mesh_queue)`).all().map((c: any) => c.name);
        expect(cols).toEqual([
            'id', 'mesh_id', 'status', 'target_node_id', 'target_session_id',
            'assigned_node_id', 'assigned_session_id', 'created_at', 'updated_at', 'payload',
        ]);
    });
});

describe('graph store row CRUD (design :103-190)', () => {
    it('round-trips graph, nodes, edges, outputs, gate, workspace intent, and outbox event', () => {
        const id = meshId();
        const store = MeshRuntimeStore.getInstance();
        const graphs = store.graphStore();
        const now = new Date().toISOString();
        // Distinct, increasing timestamps — list* accessors order by created_at ASC,
        // so same-instant ties would make row order nondeterministic.
        const t1 = new Date(Date.now() + 1).toISOString();
        const t2 = new Date(Date.now() + 2).toISOString();

        const graphId = newMeshGraphId();
        graphs.insertGraph({
            graphId, meshId: id, batchId: 'batch-1', missionId: 'mission-1',
            sourceCoordinatorSessionId: 'coord-1', enqueueSurface: 'batch',
            schemaVersion: MESH_GRAPH_SCHEMA_VERSION, status: 'preparing',
            taskCount: 2, gateCount: 1, workspaceCount: 1, dependencyEdgeCount: 1,
            planDigest: 'sha256:plan', policyJson: '{"on_dependency_failure":"block"}',
            createdAt: now, updatedAt: now,
        });
        const g = graphs.getGraph(graphId)!;
        expect(g.status).toBe('preparing');
        expect(g.taskCount).toBe(2);
        expect(graphs.getGraphByBatchId(id, 'batch-1')!.graphId).toBe(graphId);

        const nodeA = newMeshGraphNodeId();
        const nodeB = newMeshGraphNodeId();
        graphs.insertNode({
            graphId, nodeId: nodeA, meshId: id, ref: 'investigate', kind: 'worker_task',
            queueTaskId: 'task-a', state: 'materialized', baseSpecJson: '{"message":"find the bug"}',
            materializationVersion: 1, materializedDigest: 'sha256:a', createdAt: now, updatedAt: now,
        });
        const gateNodeId = newMeshGraphNodeId();
        graphs.insertNode({
            graphId, nodeId: gateNodeId, meshId: id, ref: 'land', kind: 'coordinator_gate',
            state: 'declared', baseSpecJson: '{"action":"refinery"}',
            materializationVersion: 0, createdAt: t1, updatedAt: now,
        });
        const nodes = graphs.listNodes(graphId);
        expect(nodes.map(n => n.ref)).toEqual(['investigate', 'land']);
        expect(graphs.getNode(graphId, gateNodeId)!.queueTaskId).toBeUndefined();

        graphs.insertEdge({
            graphId, meshId: id, fromNodeId: nodeA, toNodeId: nodeB, kind: 'requires',
            omitOnSkip: false, createdAt: now,
        });
        graphs.insertEdge({
            graphId, meshId: id, fromNodeId: nodeB, toNodeId: gateNodeId, kind: 'gate',
            conditionJson: '{"op":"eq"}', omitOnSkip: true, createdAt: t2,
        });
        const edges = graphs.listEdges(graphId);
        expect(edges).toHaveLength(2);
        expect(edges[1]).toMatchObject({ kind: 'gate', omitOnSkip: true });

        graphs.insertOutput({
            taskId: 'task-a', version: 1, meshId: id, graphId, nodeId: nodeA, attempt: 1,
            status: 'completed', envelopeJson: '{"final_summary":"done"}', digest: 'sha256:v1', createdAt: now,
        });
        // Later side-effect evidence is a NEW immutable version, never a mutation (design :166-167).
        graphs.insertOutput({
            taskId: 'task-a', version: 2, meshId: id, graphId, nodeId: nodeA, attempt: 1,
            status: 'completed', envelopeJson: '{"final_summary":"done","artifacts":{"commits":[{"sha":"abc"}]}}',
            digest: 'sha256:v2', createdAt: now,
        });
        expect(graphs.getOutput('task-a', 1)!.digest).toBe('sha256:v1');
        expect(graphs.getLatestOutput('task-a')!.version).toBe(2);

        const gateId = newMeshGraphGateId();
        graphs.insertGate({
            gateId, graphId, nodeId: gateNodeId, meshId: id, ref: 'land', state: 'awaiting_coordinator',
            action: 'refinery', instructions: 'Land after verifying patch equivalence.',
            leaseGeneration: 0, onTimeout: 'hold', createdAt: now, updatedAt: now,
        });
        const gate = graphs.getGate(gateId)!;
        expect(gate).toMatchObject({ state: 'awaiting_coordinator', action: 'refinery', onTimeout: 'hold' });

        graphs.insertWorkspaceIntent({
            graphId, workspaceRef: 'fix_workspace', meshId: id, sourceNodeId: 'local-base',
            baseRevision: 'main', branchIdentity: `graph-${graphId}-fix_workspace`,
            sagaState: 'declared', leaseGeneration: 0, cleanupOnGraphFailure: true,
            createdAt: now, updatedAt: now,
        });
        const intent = graphs.getWorkspaceIntent(graphId, 'fix_workspace')!;
        expect(intent).toMatchObject({ sagaState: 'declared', cleanupOnGraphFailure: true });

        const outboxId = newMeshGraphOutboxId();
        graphs.insertOutboxEvent({
            id: outboxId, meshId: id, graphId, kind: 'graph_gate_awaiting',
            payload: '{"gateId":"g"}', status: 'pending', attemptCount: 0,
            createdAt: now, updatedAt: now,
        });
        const pending = graphs.listPendingOutboxEvents(id);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ id: outboxId, kind: 'graph_gate_awaiting', status: 'pending' });
    });

    it('enforces UNIQUE(mesh_id, batch_id) for idempotent batch retries (design :118)', () => {
        const id = meshId();
        const graphs = MeshRuntimeStore.getInstance().graphStore();
        const now = new Date().toISOString();
        const base = {
            meshId: id, batchId: 'dup-batch', enqueueSurface: 'batch' as const,
            schemaVersion: MESH_GRAPH_SCHEMA_VERSION, status: 'preparing' as const,
            taskCount: 1, gateCount: 0, workspaceCount: 0, dependencyEdgeCount: 0,
            policyJson: '{}', createdAt: now, updatedAt: now,
        };
        graphs.insertGraph({ ...base, graphId: newMeshGraphId() });
        expect(() => graphs.insertGraph({ ...base, graphId: newMeshGraphId() })).toThrow(/UNIQUE/i);
        // Same batch key under a DIFFERENT mesh is a different graph (mesh_id scoping).
        graphs.insertGraph({ ...base, graphId: newMeshGraphId(), meshId: meshId() });
    });

    it('enforces PRIMARY KEY(task_id, version) — output versions are immutable (design :166-167)', () => {
        const id = meshId();
        const graphs = MeshRuntimeStore.getInstance().graphStore();
        const now = new Date().toISOString();
        const row = {
            taskId: 'task-x', version: 1, meshId: id, attempt: 1, status: 'completed',
            envelopeJson: '{}', digest: 'sha256:x', createdAt: now,
        };
        graphs.insertOutput(row);
        expect(() => graphs.insertOutput(row)).toThrow(/PRIMARY KEY|UNIQUE/i);
    });

    it('queue writes and graph writes share ONE SQLite transaction handle (design :311-334 substrate)', () => {
        const id = meshId();
        const store = MeshRuntimeStore.getInstance();
        // The graph store must participate in the runtime store's transaction(): a
        // rollback must erase BOTH the queue task and the graph row.
        try {
            store.transaction(() => {
                enqueueTask(id, 'atomic work', { difficulty: 'easy' });
                store.graphStore().insertGraph({
                    graphId: newMeshGraphId(), meshId: id, batchId: 'b-rollback',
                    enqueueSurface: 'batch', schemaVersion: MESH_GRAPH_SCHEMA_VERSION,
                    status: 'preparing', taskCount: 1, gateCount: 0, workspaceCount: 0,
                    dependencyEdgeCount: 0, policyJson: '{}',
                    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                });
                throw new Error('simulated post-write failure');
            });
        } catch { /* expected */ }
        expect(store.graphStore().getGraphByBatchId(id, 'b-rollback')).toBeNull();
        const tables = tableNames((store as any).db);
        expect(tables).toContain('mesh_task_graphs');
        const queueCount = (store as any).db
            .prepare(`SELECT COUNT(*) c FROM mesh_queue WHERE mesh_id = ?`).get(id).c;
        expect(queueCount).toBe(0);
    });
});

describe('graph state enums (design §Persistent model)', () => {
    it('pins the design state machines exactly', () => {
        expect([...MESH_GRAPH_STATUSES]).toEqual([
            'preparing', 'active', 'waiting_gate', 'completed', 'failed', 'cancelled', 'compensation_required',
        ]);
        expect([...MESH_GRAPH_NODE_STATES]).toEqual([
            'declared', 'blocked', 'materialized', 'awaiting_coordinator', 'released',
            'skipped', 'completed', 'failed', 'cancelled', 'expired',
        ]);
        expect([...MESH_GRAPH_NODE_KINDS]).toEqual(['worker_task', 'coordinator_gate']);
        expect([...MESH_GRAPH_EDGE_KINDS]).toEqual(['requires', 'gate', 'conditional']);
        expect([...MESH_GRAPH_ENQUEUE_SURFACES]).toEqual(['batch', 'single', 'send_task', 'legacy_import']);
        expect([...MESH_GRAPH_GATE_STATES]).toEqual([
            'declared', 'awaiting_coordinator', 'claimed', 'released', 'expired', 'cancelled',
        ]);
        expect([...MESH_GRAPH_GATE_ACTIONS]).toEqual([
            'refinery', 'approval', 'ci_wait', 'publish', 'deploy', 'custom',
        ]);
        expect([...MESH_GRAPH_ON_DEPENDENCY_FAILURE_POLICIES]).toEqual(['block', 'cancel']);
        expect([...MESH_GRAPH_ON_UPSTREAM_SKIP_POLICIES]).toEqual(['skip', 'omit_dependency']);
        expect([...MESH_GRAPH_OUTBOX_STATUSES]).toEqual(['pending', 'delivered', 'failed']);
        expect(MESH_GRAPH_SCHEMA_VERSION).toBe(2);
    });

    it('has NO gate auto-release policy (design :432)', () => {
        expect([...MESH_GRAPH_GATE_TIMEOUT_POLICIES]).toEqual(['hold', 'cancel_downstream', 'fail_graph']);
        expect(MESH_GRAPH_GATE_TIMEOUT_POLICIES).not.toContain('auto_release');
    });

    it('workspace saga states cover the compensation lifecycle (design :479-507)', () => {
        for (const s of ['declared', 'preparing', 'ready', 'failed', 'compensating', 'compensated', 'compensation_required']) {
            expect(MESH_GRAPH_WORKSPACE_SAGA_STATES).toContain(s);
        }
    });

    it('graph id generators produce unique ids', () => {
        const ids = new Set([newMeshGraphId(), newMeshGraphId(), newMeshGraphNodeId(), newMeshGraphGateId(), newMeshGraphOutboxId()]);
        expect(ids.size).toBe(5);
    });
});
