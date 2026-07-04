import { describe, expect, it } from 'vitest';
import { buildMeshActiveWork, buildMeshActiveWorkSummary, classifyStaleDirectForPrune, PRUNABLE_ORPHAN_STALE_REASONS } from '../../src/mesh/mesh-active-work.js';
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

    // Regression: a mesh node can arrive with its id under any of three
    // serialization forms (`id` / `nodeId` / `node_id`). The live-session match
    // in sessionStatusFromNodes must resolve all three identically — comparing
    // only `node.id` would drop a node delivered in `nodeId` or `node_id` form,
    // misclassifying its live direct task as stale (same bug class as the queue
    // target_node_id routing fix). All three must keep the task in activeWork.
    for (const idForm of ['id', 'nodeId', 'node_id'] as const) {
        it(`matches a live session when the node id arrives in '${idForm}' form`, () => {
            const result = buildMeshActiveWork({
                meshId: 'mesh-1',
                ledgerEntries: [dispatch()],
                nodes: [{
                    [idForm]: 'node-1',
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
    }

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

    it('direct dispatch to idle session with session-matched task_completed (no taskId in terminal) is terminal, not stale', () => {
        // Reproduces Bug 1: session processed the direct dispatch via short-generating path
        // (task completed < 1s so UI debounce suppressed generating_started), and the
        // task_completed ledger entry was written with no taskId (no queue task involved).
        // terminalMatchesDispatch must match by sessionId when taskId is absent.
        const sessionMatchedCompleted: MeshLedgerEntry = {
            id: 'completed-session-match',
            meshId: 'mesh-1',
            kind: 'task_completed',
            timestamp: '2026-05-26T00:00:30.000Z',
            nodeId: 'node-1',
            sessionId: 'session-1',
            providerType: 'codex-cli',
            payload: {
                event: 'agent:generating_completed',
                // No taskId — this is the short-generating suppression path where there
                // was no queue task, so completedTaskForLedger is null.
                completionDiagnostic: { reason: 'short_generating_suppressed', shortDurationMs: 450 },
            },
        };

        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch(), sessionMatchedCompleted],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', status: 'idle' }] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(0);
        expect(result.terminalDirectWork).toHaveLength(1);
        expect(result.terminalDirectWork[0]).toMatchObject({
            taskId: 'task-1',
            terminal: true,
            terminalKind: 'task_completed',
            status: 'idle',
        });
        expect(result.summary.staleDirectCount).toBe(0);
    });

    it('does not mistake a task_completed with a different queue-taskId as matching a direct dispatch', () => {
        // If the task_completed has a taskId from a different queue task, it must NOT match
        // the direct dispatch's taskId. Both must stay non-stale but via separate matching paths.
        const wrongTaskCompleted: MeshLedgerEntry = {
            id: 'completed-wrong-task',
            meshId: 'mesh-1',
            kind: 'task_completed',
            timestamp: '2026-05-26T00:00:30.000Z',
            nodeId: 'node-1',
            sessionId: 'session-1',
            providerType: 'codex-cli',
            payload: { taskId: 'different-queue-task-id' },
        };
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch(), wrongTaskCompleted],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', status: 'idle' }] }],
        });
        // The terminal entry has a taskId that doesn't match 'task-1', so sessionId fallback
        // is blocked. The dispatch has no terminal match → is stale (idle, unacknowledged).
        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.terminalDirectWork).toHaveLength(0);
    });

    it('direct dispatch with dispatchedToIdleSession=true is terminal when followed by session-matched task_completed', () => {
        // Regression: models the exact sequence for task 501d7d38.
        // Direct dispatch was sent to an idle session (dispatchedToIdleSession: true).
        // The session completed and wrote a task_completed entry (no taskId, matched by sessionId).
        // buildMeshActiveWork must classify this as terminalDirectWork, not staleDirectWork.
        const directDispatch: MeshLedgerEntry = {
            id: 'dispatch-idle',
            meshId: 'mesh-1',
            kind: 'task_dispatched',
            timestamp: '2026-06-01T04:48:16.281Z',
            nodeId: 'node-1',
            sessionId: 'session-idle-1',
            providerType: 'hermes-cli',
            payload: {
                source: 'direct',
                via: 'mesh_send_task',
                taskId: '501d7d38-2135-4818-9a57-aa688ff38a22',
                message: 'verify the preview result',
                dispatchedToIdleSession: true,
            },
        };
        const idleCompletion: MeshLedgerEntry = {
            id: 'completed-idle-session',
            meshId: 'mesh-1',
            kind: 'task_completed',
            timestamp: '2026-06-01T04:50:00.000Z',
            nodeId: 'node-1',
            sessionId: 'session-idle-1',
            providerType: 'hermes-cli',
            payload: {
                event: 'agent:generating_completed',
                completionMarker: 'turn:cli-turn:1',
                // No taskId: direct tasks are not in the queue, so completedTaskForLedger is null
            },
        };

        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [directDispatch, idleCompletion],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-idle-1', status: 'idle' }] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(0);
        expect(result.terminalDirectWork).toHaveLength(1);
        expect(result.terminalDirectWork[0]).toMatchObject({
            taskId: '501d7d38-2135-4818-9a57-aa688ff38a22',
            terminal: true,
            terminalKind: 'task_completed',
            status: 'idle',
        });
        expect(result.summary.staleDirectCount).toBe(0);
        expect(result.summary.staleDirectUnacknowledgedCount).toBeUndefined();
    });

    it('genuine unacknowledged direct dispatch (no terminal, no generating transition) remains stale', () => {
        // Safety: a direct dispatch to an idle session where no task_completed was ever written
        // must still surface as staleDispatchUnacknowledged=true, not be silently lost.
        const directDispatch: MeshLedgerEntry = {
            id: 'dispatch-unacked',
            meshId: 'mesh-1',
            kind: 'task_dispatched',
            timestamp: '2026-06-01T04:00:00.000Z',
            nodeId: 'node-1',
            sessionId: 'session-unacked',
            providerType: 'hermes-cli',
            payload: {
                source: 'direct',
                via: 'mesh_send_task',
                taskId: 'task-never-acked',
                message: 'this was never processed',
                dispatchedToIdleSession: true,
            },
        };

        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [directDispatch],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-unacked', status: 'idle' }] }],
        });

        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(1);
        expect(result.staleDirectWork[0].staleDispatchUnacknowledged).toBe(true);
        expect(result.staleDirectWork[0].staleReason).toContain('no provider acknowledgement');
        expect(result.summary.staleDirectCount).toBe(1);
        expect(result.summary.staleDirectUnacknowledgedCount).toBe(1);
    });
});

describe('classifyStaleDirectForPrune — staleDirect prune safety', () => {
    it('classifies orphaned node/session reasons as prunable_orphan', () => {
        for (const reason of PRUNABLE_ORPHAN_STALE_REASONS) {
            expect(classifyStaleDirectForPrune({ staleReason: reason })).toBe('prunable_orphan');
        }
    });

    it('always preserves fresh unacknowledged dispatches even if they carry an orphan-looking reason', () => {
        expect(classifyStaleDirectForPrune({
            staleReason: 'direct task session is not present in live session records',
            staleDispatchUnacknowledged: true,
        })).toBe('preserve_unacknowledged');
    });

    it('preserves the "no provider acknowledgement" reason (recoverable, not an orphan)', () => {
        expect(classifyStaleDirectForPrune({
            staleReason: 'direct task dispatch has no provider acknowledgement, transcript append, or active runtime transition',
        })).toBe('preserve_active');
    });

    it('preserves active records with no staleReason', () => {
        expect(classifyStaleDirectForPrune({})).toBe('preserve_active');
        expect(classifyStaleDirectForPrune({ staleReason: undefined })).toBe('preserve_active');
    });

    it('only prunes terminal records when includeTerminal is set', () => {
        expect(classifyStaleDirectForPrune({ terminal: true })).toBe('preserve_active');
        expect(classifyStaleDirectForPrune({ terminal: true }, { includeTerminal: true })).toBe('prunable_terminal');
    });

    it('unacknowledged takes precedence over terminal', () => {
        expect(classifyStaleDirectForPrune(
            { terminal: true, staleDispatchUnacknowledged: true },
            { includeTerminal: true },
        )).toBe('preserve_unacknowledged');
    });
});

// ─── F5: classifyDirectDispatch parity across the MeshRuntimeStore and ledger paths ──
// The stale/unacknowledged predicate was inlined in all three dispatch-classification
// blocks and had drifted. After extracting classifyDirectDispatch(), the previously
// UNTESTED MeshRuntimeStore (directDispatches) path must classify an equivalent dispatch
// identically to the ledger path. These tests pin that parity.
describe('buildMeshActiveWork directDispatches path — classifier parity (F5)', () => {
    function directDispatch(overrides: Record<string, unknown> = {}) {
        return {
            taskId: 'task-1',
            meshId: 'mesh-1',
            nodeId: 'node-1',
            sessionId: 'session-1',
            providerType: 'codex-cli',
            message: 'do the work',
            taskMode: null,
            via: 'mesh_send_task',
            status: 'dispatched',
            dispatchedToIdleSession: false,
            dispatchedAt: '2026-05-26T00:00:00.000Z',
            updatedAt: '2026-05-26T00:00:00.000Z',
            ...overrides,
        } as any;
    }

    it('an acked dispatch to a live generating session is active (generating)', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [],
            directDispatches: [directDispatch({ status: 'acked' })],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', providerType: 'codex-cli', status: 'generating' }] }],
        });
        expect(result.activeWork).toHaveLength(1);
        expect(result.activeWork[0]).toMatchObject({ taskId: 'task-1', source: 'direct', status: 'generating' });
        expect(result.staleDirectWork).toHaveLength(0);
    });

    it('a dispatched task to a live idle session is stale + unacknowledged (parity with ledger path)', () => {
        const nodes = [{ id: 'node-1', sessions: [{ id: 'session-1', providerType: 'codex-cli', status: 'idle' }] }];

        const viaStore = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [],
            directDispatches: [directDispatch()],
            nodes,
        });
        const viaLedger = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch()],
            nodes,
        });

        // Both data sources must reach the same verdict via the shared classifier.
        for (const result of [viaStore, viaLedger]) {
            expect(result.activeWork).toHaveLength(0);
            expect(result.staleDirectWork).toHaveLength(1);
            expect(result.staleDirectWork[0].status).toBe('idle');
            expect(result.staleDirectWork[0].staleReason).toBeTruthy();
            expect(result.staleDirectWork[0].staleDispatchUnacknowledged).toBe(true);
        }
    });

    it('a completed direct dispatch is terminal (not active, not stale)', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [],
            directDispatches: [directDispatch({ status: 'completed' })],
            nodes: [{ id: 'node-1', sessions: [{ id: 'session-1', status: 'idle' }] }],
        });
        expect(result.activeWork).toHaveLength(0);
        expect(result.staleDirectWork).toHaveLength(0);
        expect(result.terminalDirectWork).toHaveLength(1);
        expect(result.terminalDirectWork[0]).toMatchObject({ taskId: 'task-1', status: 'idle', terminal: true });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL-Q1-REALTIME — a resolved approval must not pin the node to awaiting_approval
// ─────────────────────────────────────────────────────────────────────────────
describe('buildMeshActiveWork — approval level state supersession', () => {
    function approvalNeeded(overrides: Partial<MeshLedgerEntry> = {}): MeshLedgerEntry {
        return {
            id: overrides.id ?? 'approval-1',
            meshId: overrides.meshId ?? 'mesh-1',
            kind: 'task_approval_needed',
            timestamp: overrides.timestamp ?? '2026-05-26T00:00:30.000Z',
            nodeId: overrides.nodeId ?? 'node-1',
            sessionId: overrides.sessionId ?? 'session-1',
            providerType: overrides.providerType ?? 'codex-cli',
            payload: { taskId: 'task-1', ...(overrides.payload ?? {}) },
        };
    }

    it('shows awaiting_approval when only an approval-needed terminal exists (unresolved)', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            ledgerEntries: [dispatch(), approvalNeeded()],
            nodes: undefined,
        });
        // Not a real terminal — surfaces as active work with awaiting_approval status.
        expect(result.terminalDirectWork).toHaveLength(0);
        const rec = result.activeWork.find(r => r.taskId === 'task-1');
        expect(rec?.status).toBe('awaiting_approval');
    });

    it('supersedes an earlier approval-needed with a later task_completed (no stale awaiting_approval)', () => {
        const result = buildMeshActiveWork({
            meshId: 'mesh-1',
            // approval at :30 THEN completion at :01:00 for the same dispatch/session.
            ledgerEntries: [dispatch(), approvalNeeded(), completed()],
            nodes: undefined,
            includeTerminalDirect: true,
        });
        // The completion wins: the record is terminal (idle), NOT stuck on awaiting_approval.
        expect(result.activeWork.some(r => r.status === 'awaiting_approval')).toBe(false);
        const terminal = result.terminalDirectWork.find(r => r.taskId === 'task-1');
        expect(terminal).toMatchObject({ status: 'idle', terminal: true, terminalKind: 'task_completed' });
    });
});
