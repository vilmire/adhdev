import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFile: vi.fn((_file, _args, _options, callback) => callback(null, 'SECRET-OUTPUT', '')) };
});
vi.mock('../../src/mesh/mesh-record.js', () => ({ meshRecord: vi.fn(() => ({})) }));

import { meshRecord } from '../../src/mesh/mesh-record.js';
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';
import { recordRefineGateProgress } from '../../src/mesh/mesh-refine-progress.js';
import { buildMeshAsyncRefineJobs } from '../../src/mesh/mesh-refine-status.js';
import type { MeshLedgerEntry } from '../../src/mesh/mesh-ledger.js';

const roots: string[] = [];
afterEach(() => {
    vi.clearAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entry(kind: string, timestamp: string, payload: Record<string, unknown>): MeshLedgerEntry {
    return { id: `${kind}-${timestamp}`, meshId: 'm1', timestamp, kind, nodeId: 'n1', payload } as MeshLedgerEntry;
}
const dispatched = entry('task_dispatched', '2026-11-12T10:00:00.000Z', {
    source: 'refine_mesh_node_async_job',
    refineJob: { jobId: 'job1', status: 'accepted', meshId: 'm1', nodeId: 'n1', startedAt: '2026-11-12T10:00:00.000Z' },
});
function progress(at: string, gate: string, started: number, total: number) {
    return entry('refine_progress', at, {
        source: 'refine_mesh_node_async_job',
        refineJob: { jobId: 'job1', status: 'running', meshId: 'm1', nodeId: 'n1' },
        progress: { phase: 'gate_started', gateLabel: gate, gatesStarted: started, gatesTotal: total, at },
    });
}

describe('buildMeshAsyncRefineJobs progress projection', () => {
    it('no progress record stays accepted', () => {
        const [job] = buildMeshAsyncRefineJobs({ ledgerEntries: [dispatched] });
        expect(job.status).toBe('accepted');
        expect(job.currentGate).toBeUndefined();
        expect(job.lastProgressAt).toBeUndefined();
    });

    it('progress records make the job running with the newest gate', () => {
        const [job] = buildMeshAsyncRefineJobs({ ledgerEntries: [
            dispatched,
            progress('2026-11-12T10:01:00.000Z', 'typecheck', 1, 14),
            progress('2026-11-12T10:03:00.000Z', 'test:daemon-core', 9, 14),
        ] });
        expect(job.status).toBe('running');
        expect(job.currentGate).toBe('test:daemon-core');
        expect(job.gatesStarted).toBe(9);
        expect(job.gatesTotal).toBe(14);
        expect(job.lastProgressAt).toBe('2026-11-12T10:03:00.000Z');
        expect(job.instruction).toContain('lastProgressAt');
        expect(job.instruction).toContain('currentGate');
    });

    it.each([['task_completed', 'completed'], ['task_failed', 'failed']] as const)('%s after progress wins (%s)', (kind, status) => {
        const [job] = buildMeshAsyncRefineJobs({ ledgerEntries: [
            dispatched,
            progress('2026-11-12T10:01:00.000Z', 'typecheck', 1, 14),
            entry(kind, '2026-11-12T10:05:00.000Z', {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId: 'job1', status, meshId: 'm1', nodeId: 'n1' },
            }),
        ] });
        expect(job.status).toBe(status);
    });

    it('a late progress record never reopens a terminal job', () => {
        const [job] = buildMeshAsyncRefineJobs({ ledgerEntries: [
            dispatched,
            entry('task_completed', '2026-11-12T10:05:00.000Z', {
                source: 'refine_mesh_node_async_job', refineJob: { jobId: 'job1', status: 'completed' },
            }),
            progress('2026-11-12T10:06:00.000Z', 'late', 2, 3),
        ] });
        expect(job.status).toBe('completed');
    });
});

describe('gate progress emission', () => {
    it('a 3-gate job records 3 content-free progress records in order', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'refine-progress-rec-'));
        roots.push(workspace);
        const mesh = { policy: { refineConfig: { version: 1, validation: {
            bootstrap: 'skip',
            commands: [
                { id: 'lint', command: 'node', args: ['a.js'] },
                { id: 'types', command: 'node', args: ['b.js'] },
                { command: 'node', args: ['c.js'] },
            ],
        } } } };
        const ctx = { meshId: 'm1', jobId: 'job1' };
        const summary = await runMeshRefineValidationGate(mesh, workspace, {
            onCommandStart: info => recordRefineGateProgress(ctx, 'n1', info),
        });
        expect(summary.status).toBe('passed');
        const calls = vi.mocked(meshRecord).mock.calls;
        expect(calls).toHaveLength(3);
        const progresses = calls.map(c => (c[2] as any).payload.progress);
        expect(progresses.map(p => p.gatesStarted)).toEqual([1, 2, 3]);
        expect(progresses.every(p => p.gatesTotal === 3)).toBe(true);
        expect(progresses.slice(0, 2).map(p => p.gateLabel)).toEqual(['lint', 'types']);
        expect(calls.every(c => c[1] === 'refine_progress' && (c[3] as any)?.local === true)).toBe(true);
        expect(JSON.stringify(calls)).not.toContain('SECRET-OUTPUT');
    });
});
