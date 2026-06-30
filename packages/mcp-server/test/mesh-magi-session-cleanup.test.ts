import assert from 'node:assert/strict';
import test from 'node:test';

import {
    computeMagiCleanupTargets,
    cleanupMagiAutoLaunchedSessions,
    resolveMagiAutoCleanupMode,
} from '../src/tools/mesh-tools.js';

// ─── computeMagiCleanupTargets: ids are derived ONLY from the replica tasks ──────
// Each replica contributes ITS OWN session ids (autoLaunch.sessionId once completed +
// assignedSessionId) paired with ITS OWN task id as the expected marker. Never an
// external session enumeration.

test('derives auto-launched + assigned session ids per node, paired with the replica task id', () => {
    const tasks = [
        {
            id: 'task-A',
            assignedNodeId: 'node-1',
            assignedSessionId: 'sess-A',
            autoLaunch: { status: 'completed', sessionId: 'sess-A', nodeId: 'node-1' },
        },
        {
            id: 'task-B',
            assignedNodeId: 'node-2',
            assignedSessionId: 'sess-B',
            autoLaunch: { status: 'completed', sessionId: 'sess-B', nodeId: 'node-2' },
        },
    ];
    const targets = computeMagiCleanupTargets(tasks);
    assert.deepEqual(targets.get('node-1')!.sessionIds.sort(), ['sess-A']);
    assert.equal(targets.get('node-1')!.requireAutoLaunchedForTaskIds['sess-A'], 'task-A');
    assert.deepEqual(targets.get('node-2')!.sessionIds.sort(), ['sess-B']);
    assert.equal(targets.get('node-2')!.requireAutoLaunchedForTaskIds['sess-B'], 'task-B');
});

test('autoLaunch.sessionId is only used when its status is completed', () => {
    const tasks = [
        // started (not completed) → autoLaunch.sessionId ignored; only assignedSessionId used
        { id: 'task-A', assignedNodeId: 'node-1', assignedSessionId: 'sess-assigned', autoLaunch: { status: 'started', sessionId: 'sess-launching', nodeId: 'node-1' } },
    ];
    const targets = computeMagiCleanupTargets(tasks);
    assert.deepEqual(targets.get('node-1')!.sessionIds, ['sess-assigned']);
    assert.equal('sess-launching' in targets.get('node-1')!.requireAutoLaunchedForTaskIds, false);
});

test('a reused idle session id still appears as a CANDIDATE (the daemon marker gate filters it, not this layer)', () => {
    // The replica claimed a reused idle session: no autoLaunch (queue did not spin one up).
    const tasks = [
        { id: 'task-A', assignedNodeId: 'node-1', assignedSessionId: 'reused-idle-sess' },
    ];
    const targets = computeMagiCleanupTargets(tasks);
    // It IS a candidate (we cannot tell here), but it is paired with the replica task id so
    // the daemon marker check (record has no autoLaunchedForQueueTaskId) will preserve it.
    assert.deepEqual(targets.get('node-1')!.sessionIds, ['reused-idle-sess']);
    assert.equal(targets.get('node-1')!.requireAutoLaunchedForTaskIds['reused-idle-sess'], 'task-A');
});

test('a replica with no resolvable node id or no candidate session is skipped', () => {
    const tasks = [
        { id: 'task-A' }, // no node, no session
        { id: 'task-B', assignedNodeId: 'node-1' }, // node but no session
        { assignedNodeId: 'node-1', assignedSessionId: 'sess-x' }, // no task id
    ];
    const targets = computeMagiCleanupTargets(tasks);
    assert.equal(targets.size, 0);
});

test('falls back to autoLaunch.nodeId then targetNodeId for the node id', () => {
    const tasks = [
        { id: 'task-A', assignedSessionId: 'sess-A', autoLaunch: { status: 'completed', sessionId: 'sess-A', nodeId: 'node-fallback' } },
        { id: 'task-B', assignedSessionId: 'sess-B', targetNodeId: 'node-target' },
    ];
    const targets = computeMagiCleanupTargets(tasks);
    assert.equal(targets.has('node-fallback'), true);
    assert.equal(targets.has('node-target'), true);
});

test('auto-launched-then-claimed (same session) yields a single de-duplicated candidate', () => {
    const tasks = [
        { id: 'task-A', assignedNodeId: 'node-1', assignedSessionId: 'sess-A', autoLaunch: { status: 'completed', sessionId: 'sess-A', nodeId: 'node-1' } },
    ];
    const targets = computeMagiCleanupTargets(tasks);
    assert.deepEqual(targets.get('node-1')!.sessionIds, ['sess-A']);
});

// ─── (e) terminal gate: a partial (non-terminal) collection NEVER cleans up ──────
// Killing a still-generating replica's session mid-turn would destroy the workflow.

test('(e) cleanupMagiAutoLaunchedSessions is a no-op when the collection is NOT terminal', async () => {
    let transportCalled = false;
    const fakeCtx: any = {
        mesh: { id: 'mesh-1', nodes: [{ id: 'node-1' }], policy: {} },
        transport: { command: async () => { transportCalled = true; return { success: true }; } },
    };
    const result = await cleanupMagiAutoLaunchedSessions(fakeCtx, {
        replicaTasks: [{ id: 'task-A', assignedNodeId: 'node-1', assignedSessionId: 'sess-A', autoLaunch: { status: 'completed', sessionId: 'sess-A', nodeId: 'node-1' } }],
        terminal: false,
        mode: 'stop_and_delete',
    });
    assert.equal(result, null);
    assert.equal(transportCalled, false, 'must not touch any session host on a partial collection');
});

test('cleanupMagiAutoLaunchedSessions is a no-op when mode is preserve', async () => {
    let transportCalled = false;
    const fakeCtx: any = {
        mesh: { id: 'mesh-1', nodes: [{ id: 'node-1' }], policy: {} },
        transport: { command: async () => { transportCalled = true; return { success: true }; } },
    };
    const result = await cleanupMagiAutoLaunchedSessions(fakeCtx, {
        replicaTasks: [{ id: 'task-A', assignedNodeId: 'node-1', assignedSessionId: 'sess-A' }],
        terminal: true,
        mode: 'preserve',
    });
    assert.equal(result, null);
    assert.equal(transportCalled, false);
});

// ─── resolveMagiAutoCleanupMode: per-call override beats policy; policy defaults ON ─

test('resolveMagiAutoCleanupMode: per-call override wins over policy', () => {
    const ctxPreservePolicy: any = { mesh: { policy: { magiSessionCleanup: 'preserve' } } };
    const ctxDefaultPolicy: any = { mesh: { policy: {} } };
    // override true forces ON even when policy says preserve
    assert.equal(resolveMagiAutoCleanupMode(ctxPreservePolicy, true), 'stop_and_delete');
    // override false forces OFF even when policy default is ON
    assert.equal(resolveMagiAutoCleanupMode(ctxDefaultPolicy, false), 'preserve');
    // no override → policy (preserve)
    assert.equal(resolveMagiAutoCleanupMode(ctxPreservePolicy, undefined), 'preserve');
    // no override, default policy → ON
    assert.equal(resolveMagiAutoCleanupMode(ctxDefaultPolicy, undefined), 'stop_and_delete');
});
