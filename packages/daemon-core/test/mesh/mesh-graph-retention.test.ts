// ---------------------------------------------------------------------------
// lifecycle retention Slice 3 — terminal-graph seven-table cascade (30d) +
// delivered/failed outbox sweep (14d), both OBSERVE-mode by default.
//
// What these tests actually defend, and why each case exists:
//
//   ★ The graph schema has NO FOREIGN KEYS (mesh-graph-schema.ts is
//     additive-only; FKs cannot be retrofitted onto live DBs). So a cascade that
//     forgets a table produces no error and no constraint violation — just rows
//     nothing can ever reach again. The "every table reaches zero" case below is
//     written as a per-table assertion for exactly that reason: a missed table is
//     otherwise completely silent.
//
//   ★ Deletion is irreversible, so the shipped default is observe mode. The
//     observe case pins that the selection runs in full while nothing is
//     deleted — that is the whole safety property of the first landing.
//
// ISOLATION: a per-run TEMP config root (vi.mock of config.js getConfigDir), so
// nothing here ever touches the real ~/.adhdev runtime DB.
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-graph-retention-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { MeshRuntimeStore, pruneMeshRuntimeRetention } from '../../src/mesh/mesh-runtime-store.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import type { MeshGraphStore } from '../../src/mesh/mesh-graph-store.js';
import {
    DEFAULT_GRAPH_RETENTION_MS,
    DEFAULT_GRAPH_OUTBOX_RETENTION_MS,
    resolveGraphRetentionMs,
    resolveGraphOutboxRetentionMs,
    resolveGraphRetentionEnforce,
} from '../../src/mesh/mesh-retention-config.js';
import type {
    MeshGraphStatus,
    MeshGraphOutboxStatus,
    MeshGraphWorkspaceSagaState,
} from '../../src/mesh/mesh-graph-types.js';

const MESH = 'mesh_graph_retention_test';
const DAY_MS = 24 * 60 * 60 * 1000;

const GRAPH_TABLES = [
    'mesh_task_graphs',
    'mesh_task_graph_nodes',
    'mesh_task_graph_edges',
    'mesh_task_outputs',
    'mesh_graph_gates',
    'mesh_graph_workspace_intents',
    'mesh_graph_outbox',
] as const;

const ENV_VARS = [
    'MESH_GRAPH_RETENTION_MS',
    'MESH_GRAPH_OUTBOX_RETENTION_MS',
    'MESH_GRAPH_RETENTION_ENFORCE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const ancient = () => iso(90 * DAY_MS);
const recent = () => iso(60 * 1000);

let store: MeshRuntimeStore;
let graphStore: MeshGraphStore;

/** Raw row count — the only way to prove a table was (or was not) cascaded. */
function count(table: string, graphId?: string): number {
    const db = (store as any).db;
    const r = graphId
        ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE graph_id = ?`).get(graphId)
        : db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return r.n as number;
}

/**
 * Seeds ONE graph with a row in every one of the seven tables, so any cascade
 * gap shows up as a nonzero leftover in the table that was missed.
 */
function seedGraph(opts: {
    status: MeshGraphStatus;
    terminalAt: string | undefined;
    /** Distinguishes fixtures; also the queue task id used for the output row. */
    id?: string;
    outboxStatus?: MeshGraphOutboxStatus;
    outboxUpdatedAt?: string;
    sagaState?: MeshGraphWorkspaceSagaState;
    leaseExpiresAt?: string;
}): string {
    const suffix = opts.id ?? randomUUID().slice(0, 8);
    const graphId = `graph_${suffix}`;
    const nodeId = `node_${suffix}`;
    const taskId = `task_${suffix}`;
    const createdAt = ancient();

    graphStore.insertGraph({
        graphId, meshId: MESH, batchId: `batch_${suffix}`, enqueueSurface: 'batch',
        schemaVersion: 2, status: opts.status, taskCount: 1, gateCount: 1,
        workspaceCount: 1, dependencyEdgeCount: 1, policyJson: '{}',
        createdAt, terminalAt: opts.terminalAt, updatedAt: createdAt,
    });
    graphStore.insertNode({
        graphId, nodeId, meshId: MESH, kind: 'worker_task', queueTaskId: taskId,
        state: 'completed', baseSpecJson: '{}', materializationVersion: 1,
        createdAt, updatedAt: createdAt,
    });
    // A second node so the edge has two distinct endpoints.
    graphStore.insertNode({
        graphId, nodeId: `${nodeId}_b`, meshId: MESH, kind: 'worker_task',
        state: 'completed', baseSpecJson: '{}', materializationVersion: 1,
        createdAt, updatedAt: createdAt,
    });
    graphStore.insertEdge({
        graphId, meshId: MESH, fromNodeId: nodeId, toNodeId: `${nodeId}_b`,
        kind: 'requires', omitOnSkip: false, createdAt,
    });
    graphStore.insertOutput({
        taskId, version: 1, meshId: MESH, graphId, nodeId, attempt: 1,
        status: 'completed', envelopeJson: '{}', digest: `d_${suffix}`, createdAt,
    });
    graphStore.insertGate({
        gateId: `gate_${suffix}`, graphId, nodeId, meshId: MESH, state: 'released',
        action: 'approval', leaseGeneration: 1, onTimeout: 'hold',
        createdAt, updatedAt: createdAt,
    });
    graphStore.insertWorkspaceIntent({
        graphId, workspaceRef: 'ws', meshId: MESH,
        sagaState: opts.sagaState ?? 'compensated', leaseGeneration: 1,
        leaseExpiresAt: opts.leaseExpiresAt,
        cleanupOnGraphFailure: false, createdAt, updatedAt: createdAt,
    });
    graphStore.insertOutboxEvent({
        id: `obx_${suffix}`, meshId: MESH, graphId, kind: 'graph_completed',
        payload: '{}', status: opts.outboxStatus ?? 'delivered', attemptCount: 1,
        createdAt, updatedAt: opts.outboxUpdatedAt ?? createdAt,
    });
    return graphId;
}

/** A terminal graph well past the window, with no holds — the happy path. */
const seedPrunable = (id?: string) =>
    seedGraph({ status: 'completed', terminalAt: ancient(), id });

beforeEach(() => {
    for (const k of ENV_VARS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    __resetMeshRuntimeStoreForTests();
    MeshRuntimeStore.resetForTests?.();
    store = MeshRuntimeStore.getInstance();
    graphStore = store.graphStore();
});

afterEach(() => {
    for (const k of ENV_VARS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    __resetMeshRuntimeStoreForTests();
});

afterEach(() => {
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('pruneTerminalGraphs — non-terminal graphs are never collected', () => {
    // Each of these is excluded for a DIFFERENT reason, and none may be inferred
    // as finished from age: see the doc comment on pruneTerminalGraphs.
    it.each([
        ['preparing', 'rows are still being added pre-materialization'],
        ['active', 'a failed node under the block policy leaves the graph active'],
        ['waiting_gate', 'gates have no auto-release, so this can be old and still live'],
        ['compensation_required', 'a real worktree is still on disk; the intent row is its only ledger'],
    ] as const)('keeps a %s graph even when ancient (%s)', (status) => {
        const graphId = seedGraph({ status, terminalAt: undefined });
        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });
        expect(r.graphs).toBe(0);
        for (const t of GRAPH_TABLES) expect(count(t, graphId)).toBeGreaterThan(0);
    });

    it('keeps a graph whose status is terminal but whose terminal_at was never set', () => {
        // terminal_at is the primary gate: only the rollup path (updateGraphStatus
        // with terminal=true) sets it, so a row whose status was touched outside
        // that path must not be treated as rolled-up.
        const graphId = seedGraph({ status: 'completed', terminalAt: undefined });
        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });
        expect(r.graphs).toBe(0);
        expect(count('mesh_task_graphs', graphId)).toBe(1);
    });

    it('keeps a terminal graph that is still INSIDE the window', () => {
        const graphId = seedGraph({ status: 'completed', terminalAt: recent() });
        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });
        expect(r.graphs).toBe(0);
        expect(count('mesh_task_graphs', graphId)).toBe(1);
    });
});

describe('pruneTerminalGraphs — cascade completeness', () => {
    it('deletes the graph from ALL SEVEN tables, leaving no orphan', () => {
        const graphId = seedPrunable();
        for (const t of GRAPH_TABLES) expect(count(t, graphId)).toBeGreaterThan(0);

        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });

        // Per-table, because there are no FKs: a forgotten table is silent.
        for (const t of GRAPH_TABLES) {
            expect(count(t, graphId), `${t} still holds rows for a pruned graph`).toBe(0);
        }
        expect(r).toMatchObject({
            graphs: 1, nodes: 2, edges: 1, outputs: 1,
            gates: 1, workspaceIntents: 1, outbox: 1,
            skippedGraphs: 0, enforced: true,
        });
    });

    it('leaves an unrelated live graph completely untouched', () => {
        const dead = seedPrunable('dead');
        const live = seedGraph({ status: 'active', terminalAt: undefined, id: 'live' });

        graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });

        for (const t of GRAPH_TABLES) {
            expect(count(t, dead)).toBe(0);
            expect(count(t, live)).toBeGreaterThan(0);
        }
    });

    it('handles more graphs than one bind-parameter chunk (500)', () => {
        for (let i = 0; i < 520; i++) seedPrunable(`bulk${i}`);
        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });
        expect(r.graphs).toBe(520);
        for (const t of GRAPH_TABLES) expect(count(t)).toBe(0);
    });
});

describe('pruneTerminalGraphs — anchors that must survive', () => {
    it('NEVER touches mesh_task_outputs rows with a NULL graph_id', () => {
        // persistOutputVersion writes an output for every terminal commit,
        // including the legacy node-less path where graph_id is NULL. Those rows
        // are unreachable from any graph, so a graph cascade must not collect
        // them — their retention is a separate slice.
        graphStore.insertOutput({
            taskId: 'legacy_task', version: 1, meshId: MESH, attempt: 1,
            status: 'completed', envelopeJson: '{}', digest: 'd_legacy',
            createdAt: ancient(),
        });
        seedPrunable();

        graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });

        expect(graphStore.getLatestOutput('legacy_task')?.version).toBe(1);
        const db = (store as any).db;
        const orphans = db.prepare(
            `SELECT COUNT(*) AS n FROM mesh_task_outputs WHERE graph_id IS NULL`
        ).get().n as number;
        expect(orphans).toBe(1);
    });

    it('skips a graph WHOLE when it still has a pending outbox row', () => {
        // The graph still owes a notification, and there is no periodic re-drain
        // to retire it — deleting the graph would drop the event with no trace.
        const graphId = seedGraph({
            status: 'completed', terminalAt: ancient(), outboxStatus: 'pending',
        });
        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });

        expect(r.graphs).toBe(0);
        expect(r.skippedGraphs).toBe(1);
        for (const t of GRAPH_TABLES) expect(count(t, graphId)).toBeGreaterThan(0);
    });

    it('skips a graph whose workspace intent is compensation_required', () => {
        // Workspace safety refused the removal, so a worktree is still on disk.
        const graphId = seedGraph({
            status: 'completed', terminalAt: ancient(),
            sagaState: 'compensation_required',
        });
        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });

        expect(r.graphs).toBe(0);
        expect(r.skippedGraphs).toBe(1);
        expect(count('mesh_graph_workspace_intents', graphId)).toBe(1);
    });

    it('skips a graph holding an UNEXPIRED workspace lease, but not an expired one', () => {
        const held = seedGraph({
            status: 'completed', terminalAt: ancient(), id: 'held',
            leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
        const stale = seedGraph({
            status: 'completed', terminalAt: ancient(), id: 'stale',
            leaseExpiresAt: iso(60 * 60 * 1000),
        });

        const r = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });

        expect(r.skippedGraphs).toBe(1);
        expect(count('mesh_task_graphs', held)).toBe(1);
        expect(count('mesh_task_graphs', stale)).toBe(0);
    });

    it('lets a task id be reused after its whole output version chain is pruned', () => {
        // mesh_task_outputs is PRIMARY KEY(task_id, version). If a cascade left
        // any version behind, the next output for a recycled task id would hit a
        // PK collision instead of starting a fresh chain at v1.
        const graphId = seedPrunable('reuse');
        const taskId = 'task_reuse';
        graphStore.insertOutput({
            taskId, version: 2, meshId: MESH, graphId, nodeId: 'node_reuse',
            attempt: 2, status: 'completed', envelopeJson: '{}', digest: 'd2',
            createdAt: ancient(),
        });
        expect(graphStore.getLatestOutput(taskId)?.version).toBe(2);

        graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });
        expect(graphStore.getLatestOutput(taskId)).toBeNull();

        const fresh = seedPrunable('reuse');
        expect(fresh).toBe(graphId);
        expect(graphStore.getLatestOutput(taskId)?.version).toBe(1);
    });
});

describe('pruneTerminalOutbox — cross-graph sweep', () => {
    it('collects delivered/failed rows past the window', () => {
        for (const status of ['delivered', 'failed'] as const) {
            graphStore.insertOutboxEvent({
                id: `obx_${status}`, meshId: MESH, kind: 'k', payload: '{}',
                status, attemptCount: 1, createdAt: ancient(), updatedAt: ancient(),
            });
        }
        const n = graphStore.pruneTerminalOutbox(DEFAULT_GRAPH_OUTBOX_RETENTION_MS, { enforce: true });
        expect(n).toBe(2);
        expect(count('mesh_graph_outbox')).toBe(0);
    });

    it('NEVER collects a pending row, at any age', () => {
        // Undelivered work the drain still owes; no periodic re-drain exists to
        // retire it, so age says nothing about whether it is still needed.
        graphStore.insertOutboxEvent({
            id: 'obx_pending', meshId: MESH, kind: 'k', payload: '{}',
            status: 'pending', attemptCount: 0,
            createdAt: iso(365 * DAY_MS), updatedAt: iso(365 * DAY_MS),
        });
        const n = graphStore.pruneTerminalOutbox(DEFAULT_GRAPH_OUTBOX_RETENTION_MS, { enforce: true });
        expect(n).toBe(0);
        expect(count('mesh_graph_outbox')).toBe(1);
    });

    it('keeps a recently-touched failed row — failed doubles as retry backoff', () => {
        // markOutboxEventStatus writes attempt_count/next_attempt_at_ms alongside
        // 'failed', so a row under active retry has a recent updated_at and the
        // age gate is what keeps it safe.
        graphStore.insertOutboxEvent({
            id: 'obx_retrying', meshId: MESH, kind: 'k', payload: '{}',
            status: 'failed', attemptCount: 3, nextAttemptAtMs: Date.now() + 30_000,
            createdAt: ancient(), updatedAt: recent(),
        });
        const n = graphStore.pruneTerminalOutbox(DEFAULT_GRAPH_OUTBOX_RETENTION_MS, { enforce: true });
        expect(n).toBe(0);
        expect(count('mesh_graph_outbox')).toBe(1);
    });

    it('reaches rows with a NULL graph_id, which the graph cascade cannot', () => {
        graphStore.insertOutboxEvent({
            id: 'obx_null_graph', meshId: MESH, kind: 'k', payload: '{}',
            status: 'delivered', attemptCount: 1, createdAt: ancient(), updatedAt: ancient(),
        });
        expect(graphStore.pruneTerminalOutbox(DEFAULT_GRAPH_OUTBOX_RETENTION_MS, { enforce: true })).toBe(1);
    });
});

describe('observe mode (the shipped default)', () => {
    it('deletes NOTHING while reporting exactly what it would delete', () => {
        const graphId = seedPrunable();
        graphStore.insertOutboxEvent({
            id: 'obx_loose', meshId: MESH, kind: 'k', payload: '{}',
            status: 'delivered', attemptCount: 1, createdAt: ancient(), updatedAt: ancient(),
        });

        const observed = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS);
        expect(observed.enforced).toBe(false);
        expect(observed).toMatchObject({
            graphs: 1, nodes: 2, edges: 1, outputs: 1,
            gates: 1, workspaceIntents: 1, outbox: 1,
        });
        expect(graphStore.pruneTerminalOutbox(DEFAULT_GRAPH_OUTBOX_RETENTION_MS)).toBe(2);

        // Nothing moved.
        for (const t of GRAPH_TABLES) expect(count(t, graphId)).toBeGreaterThan(0);
        expect(count('mesh_graph_outbox')).toBe(2);

        // And the observed counts are the counts enforce actually removes.
        const enforced = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS, { enforce: true });
        expect(enforced.enforced).toBe(true);
        for (const k of ['graphs', 'nodes', 'edges', 'outputs', 'gates', 'workspaceIntents', 'outbox'] as const) {
            expect(enforced[k], k).toBe(observed[k]);
        }
    });

    it('still applies every exception filter, so observed counts are not inflated', () => {
        seedGraph({ status: 'completed', terminalAt: ancient(), outboxStatus: 'pending' });
        const observed = graphStore.pruneTerminalGraphs(DEFAULT_GRAPH_RETENTION_MS);
        expect(observed.graphs).toBe(0);
        expect(observed.skippedGraphs).toBe(1);
    });
});

describe('pruneMeshRuntimeRetention wiring', () => {
    it('runs the graph sweep in observe mode by default and reports its counts', () => {
        const graphId = seedPrunable();
        const result = pruneMeshRuntimeRetention();

        expect(result.graph.enforced).toBe(false);
        expect(result.graph.graphs).toBe(1);
        // Observe mode ⇒ the rows are all still there.
        for (const t of GRAPH_TABLES) expect(count(t, graphId)).toBeGreaterThan(0);
    });

    it('actually deletes once MESH_GRAPH_RETENTION_ENFORCE is set', () => {
        const graphId = seedPrunable();
        process.env.MESH_GRAPH_RETENTION_ENFORCE = '1';

        const result = pruneMeshRuntimeRetention();

        expect(result.graph.enforced).toBe(true);
        expect(result.graph.graphs).toBe(1);
        for (const t of GRAPH_TABLES) expect(count(t, graphId)).toBe(0);
    });

    it('is idempotent — a second sweep with nothing left is a no-op', () => {
        seedPrunable();
        process.env.MESH_GRAPH_RETENTION_ENFORCE = '1';
        expect(pruneMeshRuntimeRetention().graph.graphs).toBe(1);
        expect(pruneMeshRuntimeRetention().graph.graphs).toBe(0);
    });
});

describe('retention config resolvers', () => {
    it('default to 30d graph / 14d outbox', () => {
        expect(resolveGraphRetentionMs()).toBe(DEFAULT_GRAPH_RETENTION_MS);
        expect(DEFAULT_GRAPH_RETENTION_MS).toBe(30 * DAY_MS);
        expect(resolveGraphOutboxRetentionMs()).toBe(DEFAULT_GRAPH_OUTBOX_RETENTION_MS);
        expect(DEFAULT_GRAPH_OUTBOX_RETENTION_MS).toBe(14 * DAY_MS);
    });

    it.each([
        ['MESH_GRAPH_RETENTION_MS', resolveGraphRetentionMs, DEFAULT_GRAPH_RETENTION_MS],
        ['MESH_GRAPH_OUTBOX_RETENTION_MS', resolveGraphOutboxRetentionMs, DEFAULT_GRAPH_OUTBOX_RETENTION_MS],
    ] as const)('%s accepts the clamp bounds and rejects everything outside them', (envVar, resolve, fallback) => {
        // Inclusive bounds are accepted.
        process.env[envVar] = String(1 * DAY_MS);
        expect(resolve()).toBe(1 * DAY_MS);
        process.env[envVar] = String(90 * DAY_MS);
        expect(resolve()).toBe(90 * DAY_MS);

        // Just outside, and unparsable, both fall back to the default rather
        // than clamping to the bound — a mis-set env must not silently become
        // an aggressive window.
        for (const bad of [String(1 * DAY_MS - 1), String(90 * DAY_MS + 1), '0', '-1', 'abc', '']) {
            process.env[envVar] = bad;
            expect(resolve(), `env=${JSON.stringify(bad)}`).toBe(fallback);
        }
    });

    it('enforce is off unless explicitly 1/true', () => {
        expect(resolveGraphRetentionEnforce()).toBe(false);
        for (const on of ['1', 'true', 'TRUE', ' true ']) {
            process.env.MESH_GRAPH_RETENTION_ENFORCE = on;
            expect(resolveGraphRetentionEnforce(), on).toBe(true);
        }
        for (const off of ['0', 'false', 'yes', 'on', '']) {
            process.env.MESH_GRAPH_RETENTION_ENFORCE = off;
            expect(resolveGraphRetentionEnforce(), off).toBe(false);
        }
    });
});
