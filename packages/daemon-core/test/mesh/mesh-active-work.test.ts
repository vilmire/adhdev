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

    it('does not mark direct work stale when exact session is live in activeSessionDetails', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch()],
            nodes: [{
                id: 'node-1',
                activeSessionDetails: [{ id: 'session-1', providerType: 'codex-cli', status: 'generating' }],
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
        expect(result.summary.staleDirectCount).toBe(0);
    });

    it('does not treat ledger-only direct dispatch to an idle session as active work', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch()],
            nodes: [{
                id: 'node-1',
                sessions: [{ id: 'session-1', providerType: 'codex-cli', status: 'idle' }],
            }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.staleDirectWork[0]).toMatchObject({
            taskId: 'task-1',
            status: 'idle',
            staleReason: 'direct task dispatch has no provider acknowledgement, transcript append, or active runtime transition',
        });
        expect(result.summary.totalActiveCount).toBe(0);
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

describe('buildMeshActiveWork — direct dispatch acknowledgement gap (Bug: direct task not acknowledged by live session)', () => {
    it('dispatch to a live idle session without terminal event is stale (session never started generating)', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch()],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', providerType: 'codex-cli', status: 'idle' }] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.staleDirectWork[0]).toMatchObject({
            taskId: 'task-1',
            status: 'idle',
            staleReason: 'direct task dispatch has no provider acknowledgement, transcript append, or active runtime transition',
        });
        expect(result.summary.totalActiveCount).toBe(0);
        expect(result.summary.staleDirectCount).toBe(1);
    });

    it('dispatch with dispatchedToIdleSession=true to an idle session is stale', () => {
        const dispatchWithIdleFlag = dispatch({
            payload: {
                source: 'direct',
                via: 'local_direct',
                taskId: 'task-idle-flag',
                message: 'do the work',
                dispatchedToIdleSession: true,
            },
        });
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatchWithIdleFlag],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', providerType: 'codex-cli', status: 'idle' }] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.staleDirectWork[0].staleReason).toContain('no provider acknowledgement');
    });

    it('dispatch to a live generating session without dispatchedToIdleSession is counted as active (fresh session)', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch()],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', providerType: 'codex-cli', status: 'generating' }] }],
        });

        expect(result.activeWork).toHaveLength(1);
        expect(result.staleDirectWork).toHaveLength(0);
        expect(result.activeWork[0]).toMatchObject({ status: 'generating', staleReason: undefined });
    });

    it('dispatch to a node that is no longer in the live mesh is stale', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch({ nodeId: 'node-gone' })],
            nodes: [{ id: 'node-1', sessions: [] }],
        });

        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.staleDirectWork[0].staleReason).toContain('no longer in the live mesh');
        expect(result.summary.staleDirectCount).toBe(1);
    });

    it('stale direct entries are not counted as active work and expose actionable recovery evidence', () => {
        const staleDispatch = dispatch({ nodeId: 'node-gone' });
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [staleDispatch],
            nodes: [],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.staleDirectWork[0].taskId).toBe('task-1');
        expect(result.staleDirectWork[0].staleReason).toBeDefined();
        expect(result.summary.totalActiveCount).toBe(0);
        expect(result.staleDirectWorkNote).toMatch(/historical/i);
    });

    it('completed direct task is in terminalDirectWork and not counted as stale', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch(), completed()],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', status: 'idle' }] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(0);
        expect(result.terminalDirectWork).toHaveLength(1);
        expect(result.terminalDirectWork[0]).toMatchObject({ terminal: true, terminalKind: 'task_completed' });
    });
});
