import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// C-W9b / C-W9a: the daemon-side responders of the mcp-server's store IPC
// (mesh-store-ipc.ts) — run through the SAME registered map the IPC transport
// dispatches (turnLedgerIpcHandlers), against a real temp mesh-runtime.db.

const testTmpDir = path.join(tmpdir(), `adhdev-store-ipc-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import { turnLedgerIpcHandlers, turnLedgerIpcSpecs } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { __resetMeshRuntimeStoreForTests, getQueue } from '../../src/mesh/mesh-work-queue.js';
import { readLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { seedLocalRecord } from '../helpers/local-records.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';

const v = 1;
let meshId: string;

async function call(command: string, args: Record<string, unknown>): Promise<any> {
    const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<unknown>>)[command];
    expect(handler, command).toBeTypeOf('function');
    return handler({ deps: { statusInstanceId: 'daemon-test' } }, args);
}

beforeEach(() => {
    meshId = `mesh_store_ipc_${randomUUID().slice(0, 8)}`;
});

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('registration', () => {
    it('every store command is in the turn IPC map, reachable over local IPC only', () => {
        const names = Object.keys(meshStoreIpcHandlers);
        expect(names.sort()).toEqual([
            'active_work_query', 'direct_dispatch_record', 'graph_audit_record', 'ledger_query', 'mission_list_query',
            'queue_cancel', 'queue_enqueue', 'queue_enqueue_graph', 'queue_query', 'queue_requeue',
            'record_local', 'recovery_context_query', 'tool_call_record',
        ]);
        const byName = new Map(turnLedgerIpcSpecs.map((spec) => [spec.name, spec]));
        for (const name of names) expect(byName.get(name)?.sources, name).toEqual(['ipc', 'standalone']);
    });

    it('a malformed request is refused by the wire decoder, never executed', async () => {
        for (const name of Object.keys(meshStoreIpcHandlers)) {
            const res = await call(name, { v, meshId, bogus: true });
            expect(res.success, name).toBe(false);
        }
    });
});

describe('record_local / ledger_query', () => {
    it('stores the full nested payload locally and serves it back with the summary', async () => {
        const rec = await call('record_local', { v, meshId, kind: 'magi_synthesis', payload: { consensusGroupId: 'g1', synthesis: { notes: ['free text'] } } });
        expect(rec).toMatchObject({ success: true, storedLocally: true });
        const [row] = readLocalRecords(meshId);
        expect(row.id).toBe(rec.eventId);
        expect((row.payload as any).synthesis.notes).toEqual(['free text']);

        seedMeshAttempt({ meshId, taskId: 't-failed', sessionId: 's1', stage: 'failed', terminalReason: 'session_error' });
        const q = await call('ledger_query', { v, meshId, kind: ['task_failed', 'magi_synthesis'], includeSummary: true });
        expect(q.success).toBe(true);
        expect(q.entries.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['magi_synthesis', 'task_failed']));
        expect(q.summary).toMatchObject({ meshId, taskFailed: 1 });
    });
});

describe('queue commands', () => {
    it('queue_enqueue inserts through enqueueTask and records the single-surface decision after the insert', async () => {
        const res = await call('queue_enqueue', {
            v, meshId, message: 'do the thing', options: { difficulty: 'easy', taskMode: 'general' },
            decision: { decision: { decision: 'single', single_reason: 'x' }, decisionMissing: true },
        });
        expect(res.success).toBe(true);
        expect(res.entry).toMatchObject({ meshId, message: 'do the thing', status: 'pending' });
        const decisions = readLocalRecords(meshId, { kind: ['single_enqueue_decision'] });
        expect(decisions).toHaveLength(1);
        expect(decisions[0].taskId).toBe(res.entry.id);

        const listed = await call('queue_query', { v, meshId, statuses: ['pending'] });
        expect(listed.entries.map((e: any) => e.id)).toEqual([res.entry.id]);
        expect((await call('queue_query', { v, meshId, taskId: 'nope' })).entries).toEqual([]);
    });

    it('queue_enqueue surfaces the daemon guard verbatim (no decision row on a refused insert)', async () => {
        const res = await call('queue_enqueue', { v, meshId, message: 'x', options: {}, decision: { decision: { decision: 'single' } } });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/difficulty/);
        expect(readLocalRecords(meshId, { kind: ['single_enqueue_decision'] })).toEqual([]);
    });

    it('queue_cancel returns the row before and after; queue_requeue returns the requeued row', async () => {
        const { entry } = await call('queue_enqueue', { v, meshId, message: 'cancel me', options: { difficulty: 'easy' } });
        const cancelled = await call('queue_cancel', { v, meshId, taskId: entry.id, reason: 'operator' });
        expect(cancelled.before).toMatchObject({ id: entry.id, status: 'pending' });
        expect(cancelled.task).toMatchObject({ id: entry.id, status: 'cancelled' });
        expect((await call('queue_cancel', { v, meshId, taskId: 'missing' }))).toMatchObject({ success: true, task: null, before: null });

        const requeued = await call('queue_requeue', { v, meshId, taskId: entry.id, options: { reason: 'retry', force: true } });
        expect(requeued.success).toBe(true);
        expect(requeued.task?.id).toBe(entry.id);
    });

    it('queue_enqueue_graph (compat) inserts atomically; a refusal is a RESULT with the audit written', async () => {
        const ok = await call('queue_enqueue_graph', {
            v, meshId, mode: 'compat',
            specs: [{ ref: 'a', message: 'first', difficulty: 'easy' }, { ref: 'b', message: 'second', difficulty: 'easy', dependsOn: ['a'] }],
        });
        expect(ok.success).toBe(true);
        expect(ok.ok).toBe(true);
        expect(ok.tasks).toHaveLength(2);
        expect(getQueue(meshId)).toHaveLength(2);

        const refused = await call('queue_enqueue_graph', {
            v, meshId, mode: 'compat', specs: [{ message: 'no difficulty' }],
            audit: { batchId: 'b-1', errorCodes: ['missing_task_difficulty'] },
        });
        expect(refused).toMatchObject({ success: true, ok: false, refusalCode: 'missing_task_difficulty' });
        const audit = readLocalRecords(meshId, { kind: ['graph_enqueue_validation_failed'] });
        expect(audit).toHaveLength(1);
        expect(audit[0].payload).toMatchObject({ code: 'missing_task_difficulty', batchId: 'b-1', taskCount: 1 });
    });
});

describe('direct_dispatch_record / graph_audit_record', () => {
    it('records the direct task row and the decision, each reported separately', async () => {
        const res = await call('direct_dispatch_record', {
            v, meshId, taskId: 't-direct', message: 'direct work',
            task: { assignedNodeId: 'node-a', assignedSessionId: 'sess-a', taskMode: 'general', difficulty: 'easy' },
            decision: { via: 'local_direct', nodeId: 'node-a', decision: { decision: 'direct' } },
        });
        expect(res).toMatchObject({ success: true, taskRecorded: true, decisionRecorded: true });
        expect(getQueue(meshId).map((t) => t.id)).toContain('t-direct');
        expect(readLocalRecords(meshId, { kind: ['direct_dispatch_decision'] })[0]?.taskId).toBe('t-direct');
    });

    it('writes a gate provenance record through the allow-listed recorder', async () => {
        const res = await call('graph_audit_record', { v, meshId, event: 'gate_claimed', fields: { graphId: 'g1', gateId: 'gate-1', action: 'approve', generation: 1 } });
        expect(res).toMatchObject({ success: true, recorded: true });
        expect(readLocalRecords(meshId, { kind: ['graph_gate_claimed'] })).toHaveLength(1);
    });
});

describe('active_work_query / recovery_context_query / tool_call_record / mission_list_query', () => {
    it('computes active work in the daemon, and returns the inputs it used when asked', async () => {
        await call('queue_enqueue', { v, meshId, message: 'pending work', options: { difficulty: 'easy' } });
        seedLocalRecord(meshId, { kind: 'task_dispatched', nodeId: 'n1', sessionId: 's1', payload: { taskId: 't-direct', source: 'direct', via: 'local_direct', message: 'direct' } });
        const res = await call('active_work_query', { v, meshId, nodes: [], includeInputs: true, includeSummary: true });
        expect(res.success).toBe(true);
        expect(res.activeWork.summary.totalActiveCount).toBeGreaterThanOrEqual(1);
        expect(res.records.map((r: any) => r.kind)).toContain('task_dispatched');
        expect(Array.isArray(res.directDispatches)).toBe(true);
        expect(res.summary).toMatchObject({ meshId, taskDispatched: 1 });

        const inputsOnly = await call('active_work_query', { v, meshId, compute: false, includeInputs: true });
        expect(inputsOnly.activeWork).toBeUndefined();
        expect(inputsOnly.records.length).toBeGreaterThan(0);

        const withRuntime = await call('active_work_query', { v, meshId, compute: false, includeSchedulingRuntime: true, mesh: { id: meshId, nodes: [] } });
        expect(withRuntime.schedulingRuntime).toBeTypeOf('object');
    });

    it('recovery_context_query counts the node\'s recent failures from the turn ledger', async () => {
        seedMeshAttempt({ meshId, taskId: 't-f', sessionId: 's-f', nodeId: 'node-f', stage: 'failed', terminalReason: 'session_error' });
        const res = await call('recovery_context_query', { v, meshId, nodeId: 'node-f' });
        expect(res.success).toBe(true);
        expect(res.context.consecutiveNodeFailures).toBe(1);
    });

    it('tool_call_record bumps the per-tool counter; mission_list_query answers the folded projection', async () => {
        const first = await call('tool_call_record', { v, meshId, tool: 'mesh_status', callerRole: 'coordinator' });
        expect(first).toMatchObject({ success: true, rateLimitExceeded: false, callsInWindow: 1, advisory: null });
        const missions = await call('mission_list_query', { v, meshId });
        expect(missions).toMatchObject({ success: true, missions: [], historyFold: null, truncated: false, matched: 0 });
    });
});

describe('router-internal args (live regression 2026-09-25: mesh_send_task → queue_query "bad shape")', () => {
    // The router stamps `_interactionId` onto every command's args before the
    // handler runs. The wire decoders are strict, so the SPEC (what the router
    // actually invokes) must strip it; the raw handler stays strict.
    it('the registered spec decodes a request carrying the router stamp; the raw handler does not', async () => {
        const byName = new Map(turnLedgerIpcSpecs.map((spec) => [spec.name, spec]));
        const spec = byName.get('queue_query');
        expect(spec).toBeDefined();
        const ctx = { deps: { statusInstanceId: 'daemon-test' } } as any;
        const stamped = { v, meshId, _interactionId: 'ix_test_stamp' };
        const viaSpec = await (spec!.run as any)(ctx, stamped);
        expect(viaSpec).toMatchObject({ success: true, entries: [] });
        const raw = await call('queue_query', stamped);
        expect(raw.success).toBe(false);
        expect(String(raw.error)).toContain('bad shape');
    });
});
