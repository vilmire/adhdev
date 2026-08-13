import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
    meshMagiCollect,
    sessionSharedWithAnotherReplica,
    synthesizeMagiResponses,
} from '../src/tools/mesh-tools.js';
import { enqueueTask, getLedgerDir, getMeshMission, updateTaskStatus, upsertMeshMission } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';

// ─── FIX#1 — collect cross-wire (tangle): shared-session fail-closed ────────────────────────

test('FIX#1: two replicas on DISTINCT sessions are not flagged as shared', () => {
    const tasks = [
        { id: 't1', assignedSessionId: 'sess-A', assignedNodeId: 'node-0' },
        { id: 't2', assignedSessionId: 'sess-B', assignedNodeId: 'node-1' },
    ];
    assert.equal(sessionSharedWithAnotherReplica(tasks[0], tasks), false);
    assert.equal(sessionSharedWithAnotherReplica(tasks[1], tasks), false);
});

test('FIX#1: two replicas sharing ONE session on the same node ARE flagged (cross-wire)', () => {
    const tasks = [
        { id: 't1', assignedSessionId: 'sess-shared', assignedNodeId: 'node-0' },
        { id: 't2', assignedSessionId: 'sess-shared', assignedNodeId: 'node-0' },
    ];
    assert.equal(sessionSharedWithAnotherReplica(tasks[0], tasks), true);
    assert.equal(sessionSharedWithAnotherReplica(tasks[1], tasks), true);
});

test('FIX#1: identical session id on DIFFERENT nodes is NOT a real share (session ids are node-local)', () => {
    const tasks = [
        { id: 't1', assignedSessionId: 'sess-1', assignedNodeId: 'node-0' },
        { id: 't2', assignedSessionId: 'sess-1', assignedNodeId: 'node-1' },
    ];
    assert.equal(sessionSharedWithAnotherReplica(tasks[0], tasks), false);
    assert.equal(sessionSharedWithAnotherReplica(tasks[1], tasks), false);
});

test('FIX#1: a replica with no assigned session is never flagged', () => {
    const tasks = [
        { id: 't1', assignedSessionId: undefined, assignedNodeId: 'node-0' },
        { id: 't2', assignedSessionId: 'sess-X', assignedNodeId: 'node-0' },
    ];
    assert.equal(sessionSharedWithAnotherReplica(tasks[0], tasks), false);
});

// ─── FIX#2c — synthesis under-clustering: cross-format / cross-wording merge ─────────────────

function resp(taskId: string, nodeId: string, provider: string, claims: any[]) {
    return { source: { taskId, nodeId, provider, ok: true }, response: { claims, top_findings: [], open_questions: [] } };
}

test('FIX#2c: same file:line cited with different path prefixes merges into one cluster', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'bug in the path resolver', stance: 'support', evidence: ['resolver.ts:128'], confidence: 0.8 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'an entirely different wording of the same defect', stance: 'support', evidence: ['src/utils/resolver.ts:128'], confidence: 0.8 }]),
    ]);
    // basename:line normalization makes `resolver.ts:128` and `src/utils/resolver.ts:128` merge.
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].members.length, 2);
});

test('FIX#2c: same source cited as a bare URL vs a prose-embedded URL merges into one cluster', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'the doc says X', stance: 'support', evidence: ['https://example.com/design/doc'], confidence: 0.7 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'a quite differently worded conclusion', stance: 'support', evidence: ['see https://example.com/design/doc/ (the design doc)'], confidence: 0.7 }]),
    ]);
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].members.length, 2);
});

test('FIX#2c: relaxed jaccard (0.4) merges modestly-differently-worded same-conclusion claims', () => {
    // Token sets share {race, condition, queue} (3) of 7 distinct → jaccard ≈ 0.43, which falls
    // in (0.4, 0.5): it merges at the relaxed 0.4 but would NOT have merged at the old 0.5.
    // Distinct (non-overlapping) evidence so ONLY the lexical threshold can drive the merge.
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'race condition queue drain dropped', stance: 'support', evidence: ['q.ts:1'], confidence: 0.8 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'race condition queue missing task', stance: 'support', evidence: ['other.ts:9'], confidence: 0.8 }]),
    ]);
    assert.equal(out.clusters.length, 1, 'cross-wording claims should merge at jaccard 0.4');
});

test('FIX#2c: genuinely unrelated claims (zero shared tokens) still stay separate at 0.4', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'unique finding only A saw', stance: 'support', evidence: ['z.ts:1'], confidence: 0.6 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'a completely different observation about config', stance: 'support', evidence: ['c.ts:9'], confidence: 0.6 }]),
    ]);
    assert.equal(out.clusters.length, 2);
    assert.ok(out.clusters.every(c => c.category === 'singleton'));
});

// ─── FIX#3 — inline MAGI mission auto-closes when all replicas terminal ───────────────────────

const MESH_ID = 'mesh-magi-autoclose-test';

function cleanupMesh(meshId: string): void {
    __clearMeshQueueForTests(meshId);
    __clearMeshLedgerForTests(meshId);
    __clearMeshPendingEventsForTests(meshId);
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
        const path = join(getLedgerDir(), `${safe}${suffix}`);
        if (existsSync(path)) unlinkSync(path);
    }
}

function buildCtx(meshId: string) {
    const mesh = {
        id: meshId, name: 'Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
        defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [{ id: 'node-0', workspace: '/w', repoRoot: '/w', daemonId: 'daemon-A', machineId: 'machine-A', isLocalWorktree: true, userOverrides: {}, policy: {} }],
    };
    const responder = (command: string) => {
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        return { success: true };
    };
    const transport: any = {};
    transport.command = async (c: string) => responder(c);
    transport.meshCommand = async (_d: string, c: string) => responder(c);
    return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' } as any };
}

// Seed two MAGI replica tasks that are terminal WITHOUT a bound session (status='completed',
// no assignedSessionId) so collect finalizes them immediately as no_session_to_read — no
// transport read needed, collected.terminal === true, which is what FIX#3 keys on. enqueueTask
// fills the required row fields (createdAt etc.); we then flip status to completed.
function seedTerminalReplicas(meshId: string, groupId: string, missionId: string): void {
    for (const r of ['r1', 'r2']) {
        const t = enqueueTask(meshId, 'MAGI question', {
            id: `${groupId}-${r}`, readonly: true, taskMode: 'live_debug_readonly', consensusGroupId: groupId, missionId,
            difficulty: 'medium',
        } as any);
        updateTaskStatus(meshId, t.id, 'completed');
    }
}

test('FIX#3: collect-terminal transitions the inline MAGI mission active→completed', async () => {
    cleanupMesh(MESH_ID);
    try {
        const { ctx } = buildCtx(MESH_ID);
        const mission = upsertMeshMission(MESH_ID, { title: 'MAGI: investigate X', status: 'active' });
        const groupId = 'cg-complete';
        seedTerminalReplicas(MESH_ID, groupId, mission.id);

        const raw = await meshMagiCollect(ctx, { consensus_group_id: groupId });
        const out = JSON.parse(raw);
        assert.equal(out.collection.terminal, true, 'all replicas terminal');

        const after = getMeshMission(MESH_ID, mission.id);
        assert.ok(after);
        assert.equal(after!.status, 'completed', 'inline MAGI mission auto-closed');
    } finally {
        cleanupMesh(MESH_ID);
    }
});

test('FIX#3 guard (b): an ABANDONED mission is NOT clobbered to completed', async () => {
    cleanupMesh(MESH_ID);
    try {
        const { ctx } = buildCtx(MESH_ID);
        const mission = upsertMeshMission(MESH_ID, { title: 'MAGI: abandoned run', status: 'abandoned' });
        const groupId = 'cg-abandoned';
        seedTerminalReplicas(MESH_ID, groupId, mission.id);

        await meshMagiCollect(ctx, { consensus_group_id: groupId });

        const after = getMeshMission(MESH_ID, mission.id);
        assert.equal(after!.status, 'abandoned', 'abandoned mission left untouched');
    } finally {
        cleanupMesh(MESH_ID);
    }
});

test('FIX#3 guard (b): a PAUSED mission is NOT clobbered to completed', async () => {
    cleanupMesh(MESH_ID);
    try {
        const { ctx } = buildCtx(MESH_ID);
        const mission = upsertMeshMission(MESH_ID, { title: 'MAGI: paused run', status: 'paused' });
        const groupId = 'cg-paused';
        seedTerminalReplicas(MESH_ID, groupId, mission.id);

        await meshMagiCollect(ctx, { consensus_group_id: groupId });

        const after = getMeshMission(MESH_ID, mission.id);
        assert.equal(after!.status, 'paused', 'paused mission left untouched');
    } finally {
        cleanupMesh(MESH_ID);
    }
});

test('FIX#3: idempotent — re-collecting an already-completed mission is a no-op', async () => {
    cleanupMesh(MESH_ID);
    try {
        const { ctx } = buildCtx(MESH_ID);
        const mission = upsertMeshMission(MESH_ID, { title: 'MAGI: idempotent run', status: 'active' });
        const groupId = 'cg-idem';
        seedTerminalReplicas(MESH_ID, groupId, mission.id);

        await meshMagiCollect(ctx, { consensus_group_id: groupId });
        assert.equal(getMeshMission(MESH_ID, mission.id)!.status, 'completed');
        // Second collect must not throw and must keep it completed.
        await meshMagiCollect(ctx, { consensus_group_id: groupId });
        assert.equal(getMeshMission(MESH_ID, mission.id)!.status, 'completed');
    } finally {
        cleanupMesh(MESH_ID);
    }
});
