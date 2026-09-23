import assert from 'node:assert/strict';
import test from 'node:test';

import { TURN_IPC_COMMANDS, TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';

import {
    TurnIpcCommandError,
    classifyTransportFailure,
    ledgerQuery,
    meshIndexQuery,
    meshRecord,
    missionListQuery,
    operatorStatus,
    toolCallRecord,
    turnCancel,
    turnObserve,
    turnQuery,
    recordLocal,
    queueQuery,
    queueEnqueue,
    queueEnqueueGraph,
    queueCancel,
    activeWorkQuery,
    recoveryContextQuery,
} from '../src/ipc/turn-commands.js';

/**
 * C-W6 pre-work: contract + client tests for the six IPC commands
 * (docs/design/2026-09-23-wiring-unification.md §5 C2). This file exercises
 * the CLIENT ONLY — there is no responder yet (that lands with C-W6 proper in
 * daemon-core), so every "success" case here uses a fake CommandTransport
 * that plays the daemon's role by returning a pre-built response shape.
 */

// Minimal fake matching CommandTransport's structural shape
// (`transports/mode.ts` — LocalTransport | IpcTransport, both `async
// command(type, args)`). Not importing either real class: they open sockets /
// hit fetch in their constructors and this file tests the client's own
// dispatch/decode/error-mapping logic, not the transport implementations.
function fakeTransport(handler: (type: string, args: Record<string, unknown>) => unknown) {
    return {
        async command(type: string, args: Record<string, unknown> = {}) {
            return handler(type, args);
        },
    } as any;
}

function throwingTransport(error: unknown) {
    return {
        async command() {
            throw error;
        },
    } as any;
}

test('TURN_IPC_COMMANDS has exactly twenty-three names (the C2 six + mission_* + C-W8 note_* + C-W9b tool_call_record/ledger_query/mission_list_query + the C-W9a store commands)', () => {
    assert.equal(TURN_IPC_COMMANDS.length, 23);
    assert.deepEqual(
        [...TURN_IPC_COMMANDS].sort(),
        [
            'active_work_query', 'direct_dispatch_record', 'graph_audit_record',
            'ledger_query', 'mesh_index_query', 'mesh_record', 'mission_list_query', 'mission_query', 'mission_upsert',
            'note_forget', 'note_upsert', 'operator_status',
            'queue_cancel', 'queue_enqueue', 'queue_enqueue_graph', 'queue_query', 'queue_requeue',
            'record_local', 'recovery_context_query',
            'tool_call_record', 'turn_cancel', 'turn_observe', 'turn_query',
        ],
    );
});

test('turnObserve: sends v:1 + evidence, decodes a valid response', async () => {
    let sentType = '';
    let sentArgs: Record<string, unknown> = {};
    const transport = fakeTransport((type, args) => {
        sentType = type;
        sentArgs = args;
        return { verdict: 'applied', attemptRef: { attemptId: 'a1', generation: 0 }, outcome: 'completed' };
    });
    const evidence = {
        eventId: 'ev-1', at: 1000, source: 'mcp_probe', sessionId: 's1', observedBy: 'daemon-1',
        kind: 'cancel', reason: 'operator_cancel',
    } as const;
    const res = await turnObserve(transport, { evidence: evidence as any });
    assert.equal(sentType, 'turn_observe');
    assert.equal((sentArgs as any).v, TURN_IPC_PROTOCOL_VERSION);
    assert.deepEqual((sentArgs as any).evidence, evidence);
    assert.equal(res.verdict, 'applied');
    assert.equal(res.attemptRef.attemptId, 'a1');
});

test('turnObserve: a decode failure (malformed daemon response) throws TurnIpcCommandError', async () => {
    const transport = fakeTransport(() => ({ verdict: 'not-a-real-verdict' }));
    const evidence = {
        eventId: 'ev-1', at: 1000, source: 'mcp_probe', sessionId: 's1', observedBy: 'daemon-1',
        kind: 'cancel', reason: 'operator_cancel',
    } as const;
    await assert.rejects(
        () => turnObserve(transport, { evidence: evidence as any }),
        (err: unknown) => {
            assert.ok(err instanceof TurnIpcCommandError);
            assert.equal(err.command, 'turn_observe');
            assert.match(err.message, /failed decode/);
            return true;
        },
    );
});

test('meshRecord: round trip through the client', async () => {
    const transport = fakeTransport((type, args) => {
        assert.equal(type, 'mesh_record');
        assert.equal((args as any).meshId, 'm1');
        return { eventId: 'ev-9', seq: 5 };
    });
    const res = await meshRecord(transport, { meshId: 'm1', ledgerKind: 'task_completed', payload: { taskId: 't1' } });
    assert.deepEqual(res, { eventId: 'ev-9', seq: 5 });
});

test('turnCancel: round trip', async () => {
    const transport = fakeTransport(() => ({ attemptRef: { attemptId: 'a1', generation: 2 }, verdict: 'applied' }));
    const res = await turnCancel(transport, { attemptId: 'a1', reason: 'operator_cancel' });
    assert.equal(res.verdict, 'applied');
});

test('operatorStatus: round trip (fire-and-forget acknowledgement)', async () => {
    const transport = fakeTransport(() => ({ accepted: true }));
    const res = await operatorStatus(transport, { taskId: 't1', status: 'completed', reason: 'refine_terminal' });
    assert.deepEqual(res, { accepted: true });
});

test('turnQuery: round trip with rows', async () => {
    const transport = fakeTransport(() => ({
        attempts: [{ attemptId: 'a1', generation: 0, sessionId: 's1', state: 'generating', acceptedAt: 1000 }],
        events: [],
    }));
    const res = await turnQuery(transport, { meshId: 'm1' });
    assert.equal(res.attempts.length, 1);
});

test('meshIndexQuery: round trip with rows', async () => {
    const transport = fakeTransport(() => ({
        rows: [{ writer: 'w1', seq: 1, meshId: 'm1', eventId: 'ev-1', kind: 'adhdev.mesh.ledger', atMs: 1000, payload: { taskId: 't1' } }],
    }));
    const res = await meshIndexQuery(transport, { meshId: 'm1', writer: 'fleet' });
    assert.equal(res.rows.length, 1);
});

// ─── C-W9b: tool_call_record / ledger_query / mission_list_query ────────────

test('toolCallRecord: sends v:1 + request, decodes a valid response', async () => {
    let sentType = '';
    let sentArgs: Record<string, unknown> = {};
    const transport = fakeTransport((type, args) => {
        sentType = type;
        sentArgs = args;
        return { rateLimitExceeded: true, callsInWindow: 41, advisory: 'slow down' };
    });
    const res = await toolCallRecord(transport, { meshId: 'm1', tool: 'mesh_status', callerRole: 'coordinator', sessionId: 's1' });
    assert.equal(sentType, 'tool_call_record');
    assert.equal((sentArgs as any).v, TURN_IPC_PROTOCOL_VERSION);
    assert.equal((sentArgs as any).tool, 'mesh_status');
    assert.equal(res.rateLimitExceeded, true);
    assert.equal(res.callsInWindow, 41);
    assert.equal(res.advisory, 'slow down');
});

test('ledgerQuery: round trip with entries and an optional summary', async () => {
    const transport = fakeTransport(() => ({
        entries: [{ id: 'e1', meshId: 'm1', timestamp: '2026-09-24T00:00:00.000Z', kind: 'task_dispatched', payload: { taskId: 't1' } }],
        summary: {
            meshId: 'm1', totalEntries: 1, taskDispatched: 1, taskCompleted: 0, taskFailed: 0, taskStalled: 0,
            sessionLaunched: 0, checkpointCreated: 0, lastActivityAt: null, recentFailures: 0,
        },
    }));
    const res = await ledgerQuery(transport, { meshId: 'm1', tail: 10, includeSummary: true });
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].kind, 'task_dispatched');
    assert.equal(res.summary?.totalEntries, 1);
});

test('missionListQuery: round trip with a verbose mission row', async () => {
    const transport = fakeTransport(() => ({
        missions: [{
            id: 'mission-1', meshId: 'm1', title: 'Ship it', goal: 'ship the thing', status: 'active',
            tasks: { total: 1, pending: 1, assigned: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null },
        }],
        historyFold: null,
        truncated: false,
        matched: 1,
    }));
    const res = await missionListQuery(transport, { meshId: 'm1', verbose: true });
    assert.equal(res.missions.length, 1);
    assert.equal(res.matched, 1);
    assert.equal(res.historyFold, null);
});

// ─── error mapping ───────────────────────────────────────────────────────────

test('classifyTransportFailure: IpcTransport connection-failure messages map to daemon_required', () => {
    const cases = [
        'Cannot connect to daemon IPC at ws://127.0.0.1:19222/ipc',
        'Daemon IPC connection closed: ws://127.0.0.1:19222/ipc',
        'WebSocket is not available in this Node runtime; Node 20+ is required for daemon IPC mode',
        'Failed to create IPC connection: ECONNREFUSED',
    ];
    for (const message of cases) {
        const err = classifyTransportFailure('turn_query', new Error(message));
        assert.equal(err.code, 'daemon_required', `expected daemon_required for: ${message}`);
    }
});

test('classifyTransportFailure: LocalTransport fetch-failure messages map to daemon_required', () => {
    const cases = [
        'Status fetch failed: 503',
        'Command turn_observe failed: 502 Bad Gateway',
    ];
    for (const message of cases) {
        const err = classifyTransportFailure('turn_observe', new Error(message));
        assert.equal(err.code, 'daemon_required', `expected daemon_required for: ${message}`);
    }
});

test('classifyTransportFailure: describeFetchFailure\'s renamed timeout message maps to daemon_required (the original .name does not survive into .message)', () => {
    // transports/local.ts describeFetchFailure: a TimeoutError/AbortError is
    // rewritten into this exact phrase before it ever reaches the caller —
    // matching literal "timeouterror"/"aborterror" text would never fire.
    const timeout = new Error('Command turn_observe timed out after 15s (standalone daemon did not respond)');
    const err = classifyTransportFailure('turn_observe', timeout);
    assert.equal(err.code, 'daemon_required');
});

test('classifyTransportFailure: IpcConnectionLoadGuard rejections map to ipc_busy / rate_limited, not daemon_required', () => {
    const busy = classifyTransportFailure('turn_query', new Error('Too many in-flight commands on this connection (max 32). ipc_busy'));
    assert.equal(busy.code, 'ipc_busy');
    const limited = classifyTransportFailure('turn_query', new Error("Rate limit exceeded for 'turn_query' on this connection. rate_limited"));
    assert.equal(limited.code, 'rate_limited');
});

test('classifyTransportFailure: an unrecognized message falls back to turn_ledger_unavailable, not daemon_required', () => {
    const err = classifyTransportFailure('mesh_record', new Error('some semantic validation error the daemon returned'));
    assert.equal(err.code, 'turn_ledger_unavailable');
});

test('turnObserve: a thrown connection failure surfaces as TurnIpcCommandError(daemon_required), not a bare Error', async () => {
    const transport = throwingTransport(new Error('Cannot connect to daemon IPC at ws://127.0.0.1:19222/ipc'));
    const evidence = {
        eventId: 'ev-1', at: 1000, source: 'mcp_probe', sessionId: 's1', observedBy: 'daemon-1',
        kind: 'cancel', reason: 'operator_cancel',
    } as const;
    await assert.rejects(
        () => turnObserve(transport, { evidence: evidence as any }),
        (err: unknown) => {
            assert.ok(err instanceof TurnIpcCommandError);
            assert.equal(err.code, 'daemon_required');
            assert.equal(err.command, 'turn_observe');
            return true;
        },
    );
});

// ─── C-W9a store commands (client side) ──────────────────────────────────────

test('recordLocal: blank / whitespace optional ids are OMITTED, not sent (the contract only accepts identifiers)', async () => {
    let sentArgs: Record<string, unknown> = {};
    const transport = fakeTransport((_type, args) => {
        sentArgs = args;
        return { eventId: 'e1', timestamp: 'T', storedLocally: true, published: false };
    });
    const res = await recordLocal(transport, { meshId: 'm1', kind: 'task_dispatched', nodeId: 'n1', sessionId: '', providerType: 'has space', taskId: null, payload: { message: 'free text' } });
    assert.equal(res.storedLocally, true);
    assert.deepEqual(sentArgs, { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'm1', kind: 'task_dispatched', nodeId: 'n1', payload: { message: 'free text' } });
});

test('queueQuery / queueEnqueue / queueCancel: rows are JSON passthroughs keyed by id + status', async () => {
    const row = { id: 't1', status: 'pending', message: 'x' };
    assert.deepEqual((await queueQuery(fakeTransport(() => ({ entries: [row] })), { meshId: 'm1' })).entries, [row]);
    assert.deepEqual((await queueEnqueue(fakeTransport(() => ({ entry: row })), { meshId: 'm1', message: 'x' })).entry, row);
    const cancelled = await queueCancel(fakeTransport(() => ({ task: { ...row, status: 'cancelled' }, before: row })), { meshId: 'm1', taskId: 't1' });
    assert.equal(cancelled.before?.status, 'pending');
    // A daemon guard refusal (enqueue validation) surfaces as the typed error with its message.
    await assert.rejects(
        queueEnqueue(fakeTransport(() => ({ success: false, error: 'mesh task difficulty is required' })), { meshId: 'm1', message: 'x' }),
        (e: any) => e instanceof TurnIpcCommandError && /difficulty is required/.test(e.message),
    );
});

test('queueEnqueueGraph: a refusal is an ok:false RESULT whose fields survive the envelope unwrap', async () => {
    // The daemon answers `{ success: true, ok: false, refusalCode, message }` — `code`/`error`
    // would be eaten by the envelope unwrap, which is why the contract does not use them.
    const res = await queueEnqueueGraph(
        fakeTransport(() => ({ success: true, ok: false, refusalCode: 'unknown_dependency', message: 'unknown_dependency: …' })),
        { meshId: 'm1', mode: 'compat', specs: [{ message: 'a' }] },
    );
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.refusalCode, 'unknown_dependency');
});

test('activeWorkQuery / recoveryContextQuery decode their computed views', async () => {
    const aw = await activeWorkQuery(fakeTransport(() => ({ activeWork: { activeWork: [], summary: { totalActiveCount: 0 } }, records: [], directDispatches: [] })), { meshId: 'm1', includeInputs: true });
    assert.deepEqual(aw.records, []);
    const rc = await recoveryContextQuery(fakeTransport(() => ({ context: { consecutiveNodeFailures: 2, advice: 'retry' } })), { meshId: 'm1', nodeId: 'n1' });
    assert.equal((rc.context as any).consecutiveNodeFailures, 2);
});
