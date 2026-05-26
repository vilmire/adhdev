import { describe, expect, it } from 'vitest';
import { buildMeshActiveWork, buildMeshActiveWorkSummary } from '../../src/mesh/mesh-active-work.js';
import type { MeshLedgerEntry } from '../../src/mesh/mesh-ledger.js';

function dispatch(overrides: Partial<MeshLedgerEntry> = {}): MeshLedgerEntry {
    return {
        id: overrides.id ?? 'dispatch-1',
        meshId: overrides.meshId ?? 'mesh-1',
        kind: 'task_dispatched',
        timestamp: overrides.timestamp ?? '2026-05-26T00:00:00.000Z',
        nodeId: overrides.nodeId ?? 'node-1',
        sessionId: overrides.sessionId ?? 'session-1',
        providerType: overrides.providerType ?? 'codex-cli',
        payload: {
            source: 'direct',
            via: 'mesh_send_task',
            taskId: 'task-1',
            message: 'do the work',
            ...(overrides.payload ?? {}),
        },
    };
}

function completed(overrides: Partial<MeshLedgerEntry> = {}): MeshLedgerEntry {
    return {
        id: overrides.id ?? 'completed-1',
        meshId: overrides.meshId ?? 'mesh-1',
        kind: 'task_completed',
        timestamp: overrides.timestamp ?? '2026-05-26T00:01:00.000Z',
        nodeId: overrides.nodeId ?? 'node-1',
        sessionId: overrides.sessionId ?? 'session-1',
        providerType: overrides.providerType ?? 'codex-cli',
        payload: {
            taskId: 'task-1',
            ...(overrides.payload ?? {}),
        },
    };
}

describe('buildMeshActiveWork direct task classification', () => {
    it('keeps a live assigned/generating direct task in activeWork', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch()],
            nodes: [{
                id: 'node-1',
                sessions: [{ id: 'session-1', providerType: 'codex-cli', status: 'generating' }],
            }],
        });

        expect(result.activeWork).toHaveLength(1);
        expect(result.activeWork[0]).toMatchObject({
            taskId: 'task-1',
            source: 'direct',
            status: 'generating',
            nodeId: 'node-1',
            sessionId: 'session-1',
        });
        expect(result.staleDirectWork).toHaveLength(0);
    });

    it('puts missing-session direct work in staleDirectWork for recovery evidence', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch()],
            nodes: [{ id: 'node-1', sessions: [] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.staleDirectWork[0].staleReason).toBe('direct task session is not present in live session records');
        expect(result.summary.staleDirectCount).toBe(1);
    });

    it('surfaces completed direct tasks as terminalDirectWork without counting them active by default', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch(), completed()],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', status: 'idle' }] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(0);
        expect(result.terminalDirectWork).toHaveLength(1);
        expect(result.terminalDirectWork[0]).toMatchObject({
            taskId: 'task-1',
            status: 'idle',
            terminal: true,
            terminalKind: 'task_completed',
        });
        expect(result.summary.totalActiveCount).toBe(0);
    });
});

describe('buildMeshActiveWork — staleDirectNote / staleDirectWorkNote', () => {
    it('staleDirectWorkNote is present when stale records exist', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch({ nodeId: 'node-gone' })],
            nodes: [],
        });

        expect(result.staleDirectWorkNote).toBeDefined();
        expect(typeof result.staleDirectWorkNote).toBe('string');
        expect(result.staleDirectWorkNote).toMatch(/historical/i);
    });

    it('staleDirectWorkNote is absent when no stale records exist', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [],
            nodes: [],
        });

        expect(result.staleDirectWorkNote).toBeUndefined();
    });

    it('summary.staleDirectNote is set when staleDirectCount > 0', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch({ nodeId: 'node-gone' })],
            nodes: [],
        });

        expect(result.summary.staleDirectNote).toBeDefined();
        expect(result.summary.staleDirectNote).toMatch(/historical/i);
    });

    it('summary.staleDirectNote is absent when staleDirectCount is 0', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [],
            nodes: [],
        });
        expect(result.summary.staleDirectNote).toBeUndefined();
    });

    it('buildMeshActiveWorkSummary staleDirectNote set for stale items in passed array', () => {
        const summary = buildMeshActiveWorkSummary([
            { taskId: 't1', source: 'direct', status: 'assigned', taskTitle: 'x', taskSummary: 'x', createdAt: '', updatedAt: '', elapsedMs: 0, staleReason: 'node gone' },
            { taskId: 't2', source: 'queue', status: 'pending', taskTitle: 'y', taskSummary: 'y', createdAt: '', updatedAt: '', elapsedMs: 0 },
        ]);
        expect(summary.staleDirectCount).toBe(1);
        expect(summary.staleDirectNote).toBeDefined();
        expect(summary.staleDirectNote).toMatch(/historical/i);
    });
});
