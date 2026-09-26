import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshListPendingApprovals, meshSendTask, meshViewQueue } from '../src/tools/mesh-tools.js';
import { answerTurnIpc, armTestTurnLedger, closeOpenTestAttempts, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { heldMeshStatusResponse } from './helpers/held-node-state.js';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';

// AUDIT FIX (owner principle 2026-09-26, held-node-state audit): mesh_status was
// already converted to answer remote nodes' sessions/build from the coordinator
// daemon's held runtime (mesh-status-held-runtime.test.ts). This file pins the
// SAME contract for mesh_view_queue and mesh_list_pending_approvals — their
// node/session decoration must answer from held state with ZERO per-daemon
// get_status_metadata / meshCommand call when the coordinator daemon holds
// runtime for the remote node, and must fall back to the legacy live probe for
// an older daemon that predates the `nodeRuntimeHeld` marker.

armTestTurnLedger('daemon-coord');

const OBSERVED_AT = Date.parse('2026-09-27T09:00:00.000Z');

function buildMesh(meshId: string) {
    return {
        id: meshId,
        name: 'Held Queue/Approvals',
        repoIdentity: 'example/repo',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: [
            { id: 'node-0', daemonId: 'daemon-coord', machineId: 'machine-coord', workspace: '/ws/node-0', repoRoot: '/ws/node-0', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
            { id: 'node-1', daemonId: 'daemon-peer-a', machineId: 'machine-peer-a', workspace: '/ws/node-1', repoRoot: '/ws/node-1', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
        ],
    };
}

const heldSession = {
    id: 'sess-daemon-peer-a', providerType: 'claude-cli', status: 'idle',
    activeChat: { status: 'idle' }, settings: { userHidden: false },
};

function heldRuntimeFor(node: any): any {
    return {
        source: 'member_push',
        observedAt: OBSERVED_AT,
        refreshing: false,
        daemonId: node.daemonId,
        daemonBuild: { commit: 'feedface00112233', commitShort: 'feedfac', version: '1.0.60-rc.2', track: 'preview' },
        sessions: [heldSession],
    };
}

function buildCtx(meshId: string, opts: { held: boolean }) {
    const mesh = buildMesh(meshId);
    const directCommands: Array<{ command: string; args: any }> = [];
    const meshCommands: Array<{ daemonId: string; command: string; args: any }> = [];
    const transport: any = new IpcTransport();
    transport.command = async (command: string, args: any = {}) => {
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        directCommands.push({ command, args });
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'mesh_status') {
            return heldMeshStatusResponse(mesh, () => ({ isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'fresh', ahead: 0, behind: 0 }), {
                localDaemonId: 'daemon-coord',
                observedAt: OBSERVED_AT,
                ...(opts.held ? { runtimeFor: heldRuntimeFor } : {}),
            });
        }
        if (command === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: 'sess-coord', providerType: 'claude-cli', status: 'idle' }] } };
        }
        return { success: true };
    };
    transport.meshCommand = async (daemonId: string, command: string, args: any = {}) => {
        meshCommands.push({ daemonId, command, args });
        if (command === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: 'live-fallback', providerType: 'claude-cli', status: 'idle' }] } };
        }
        return { success: true };
    };
    const ctx = { mesh, transport, localDaemonId: 'daemon-coord', localMachineId: 'machine-coord', coordinatorHostname: 'coord' };
    return { ctx, mesh, directCommands, meshCommands };
}

function cleanup(meshId: string): void {
    __clearMeshQueueForTests(meshId);
    closeOpenTestAttempts();
    __clearLocalRecordsForTests(meshId);
    __clearMeshPendingEventsForTests(meshId);
}

test('mesh_view_queue answers remote node sessions from held runtime — no meshCommand call', async () => {
    const meshId = `mesh-view-queue-held-${Date.now()}`;
    const { ctx, meshCommands } = buildCtx(meshId, { held: true });
    try {
        const result = JSON.parse(await meshViewQueue(ctx as any, { view: 'active', verbose: true }));
        assert.equal(result.success !== false, true, JSON.stringify(result));
        assert.deepEqual(meshCommands, [], 'no remote get_status_metadata call for the held node');
    } finally {
        cleanup(meshId);
    }
});

test('mesh_view_queue falls back to a live probe when the coordinator daemon does not hold runtime (older daemon)', async () => {
    const meshId = `mesh-view-queue-live-fallback-${Date.now()}`;
    const { ctx, meshCommands } = buildCtx(meshId, { held: false });
    try {
        await meshViewQueue(ctx as any, { view: 'active', verbose: true });
        assert.equal(meshCommands.some((c) => c.command === 'get_status_metadata' && c.daemonId === 'daemon-peer-a'), true, 'legacy live probe still runs for an older daemon');
    } finally {
        cleanup(meshId);
    }
});

test('mesh_list_pending_approvals answers from held runtime — no meshCommand call', async () => {
    const meshId = `mesh-pending-approvals-held-${Date.now()}`;
    const { ctx, meshCommands } = buildCtx(meshId, { held: true });
    try {
        const result = JSON.parse(await meshListPendingApprovals(ctx as any, {}));
        assert.equal(Array.isArray(result.approvals), true, JSON.stringify(result));
        assert.deepEqual(meshCommands, [], 'no remote get_status_metadata call for the held node');
    } finally {
        cleanup(meshId);
    }
});

test('mesh_list_pending_approvals falls back to a live probe when the coordinator daemon does not hold runtime', async () => {
    const meshId = `mesh-pending-approvals-live-fallback-${Date.now()}`;
    const { ctx, meshCommands } = buildCtx(meshId, { held: false });
    try {
        await meshListPendingApprovals(ctx as any, {});
        assert.equal(meshCommands.some((c) => c.command === 'get_status_metadata' && c.daemonId === 'daemon-peer-a'), true, 'legacy live probe still runs for an older daemon');
    } finally {
        cleanup(meshId);
    }
});

test('mesh_send_task session preflight (explicit session_id) answers from held runtime for a remote node — no meshCommand call', async () => {
    const meshId = `mesh-send-task-preflight-held-${Date.now()}`;
    const { ctx, meshCommands } = buildCtx(meshId, { held: true });
    try {
        const result = JSON.parse(await meshSendTask(ctx as any, {
            node_id: 'node-1',
            session_id: 'sess-daemon-peer-a',
            message: 'hello from held-runtime preflight test',
            task_mode: 'worker_managed',
            difficulty: 'easy',
        } as any));
        // The dispatch itself may or may not succeed depending on relay-safety
        // classification (verifiedSession is not populated here) — what this test
        // pins is that the EXPLICIT-SESSION LOOKUP that runs before dispatch
        // (readNodeRuntime) never had to make a live meshCommand call.
        assert.equal(meshCommands.filter((c) => c.command === 'get_status_metadata').length, 0, JSON.stringify({ result, meshCommands }));
    } finally {
        cleanup(meshId);
    }
});
