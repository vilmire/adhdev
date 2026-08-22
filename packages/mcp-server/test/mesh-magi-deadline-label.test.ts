import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { meshMagiCollect, synthesizeMagiResponses } from '../src/tools/mesh-tools.js';
import { enqueueTask, getLedgerDir } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';

// ─── MAGI-DEADLINE-MISLABEL ───────────────────────────────────────────────────
//
// A live 3-replica fan-out measured kimi taking 16m09s to answer against the then
// 180s deadline: collect force-finalized it as `unparseable_output` (indistinguishable
// from a replica that genuinely produced bad output) 13 minutes before it actually
// answered with a fully-evidenced rootCause JSON. The coordinator read the label as
// "kimi failed to produce valid output" and reported "0 valid replicas" to the owner,
// when the true state was "2/3 answered, 1/3 hadn't answered yet".
//
// These tests exercise the REAL collect path end-to-end (meshMagiCollect, wait=false
// so timeoutMs=0 and the very first pass is `force`), confirming:
//   (B1) a replica whose session produced NO parseable JSON before the deadline is
//        labeled `replica_deadline_exceeded`, NOT `unparseable_output`.
//   (B2) a replica whose session produced a schema-invalid JSON (real content, wrong
//        shape) is still labeled `schema_invalid:*` — untouched by this fix, because
//        that is a genuine content defect, not a timing artifact.
//   (B3) the independenceBanner names the deadline-exceeded vs genuinely-failed split
//        so the coordinator knows whether to re-collect or swap the panel.

const MESH_ID = 'mesh-magi-deadline-label-test';

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

function buildCtx(meshId: string, readChatResponder: (args: any) => any) {
    const mesh = {
        id: meshId, name: 'Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
        defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [{ id: 'node-0', workspace: '/w', repoRoot: '/w', daemonId: 'daemon-A', machineId: 'machine-A', isLocalWorktree: true, userOverrides: {}, policy: {} }],
    };
    const responder = (command: string, args: any) => {
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        if (command === 'read_chat') return { success: true, result: readChatResponder(args) };
        if (command === 'resolve_action') return { success: true };
        return { success: true };
    };
    const transport: any = {};
    transport.command = async (c: string, a: any) => responder(c, a);
    transport.meshCommand = async (_d: string, c: string, a: any) => responder(c, a);
    return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' } as any };
}

function seedReplica(meshId: string, groupId: string, taskId: string, sessionId: string): void {
    const t = enqueueTask(meshId, 'MAGI question', {
        id: taskId, readonly: true, taskMode: 'live_debug_readonly', consensusGroupId: groupId,
        difficulty: 'medium',
    } as any);
    // Stamp assignment directly on the store entry (bypassing the real claim path, which
    // needs a live idle session) so the row is a `completed` replica WITH a bound
    // session/node — the precondition tryResolveReplica needs to attempt a read_chat.
    const store = MeshRuntimeStore.getInstance();
    const entry = store.findQueueEntryById(meshId, t.id) as any;
    entry.assignedNodeId = 'node-0';
    entry.assignedSessionId = sessionId;
    entry.assignedProviderType = 'kimi';
    entry.status = 'completed';
    store.updateQueueEntry(entry);
}

test('B1: a replica with NO parseable JSON at the deadline is labeled replica_deadline_exceeded, not unparseable_output', async () => {
    cleanupMesh(MESH_ID);
    try {
        const groupId = 'cg-deadline-pending';
        // The session's transcript carries only prose — no JSON at all — mirroring "kimi
        // hadn't finished writing its answer yet" at the moment collect gave up waiting.
        const { ctx } = buildCtx(MESH_ID, () => ({
            messages: [{ role: 'assistant', content: 'Still investigating the root cause, one moment...' }],
        }));
        seedReplica(MESH_ID, groupId, `${groupId}-r1`, 'sess-pending');

        const raw = await meshMagiCollect(ctx, { consensus_group_id: groupId, task_kind: 'claim_audit' });
        const out = JSON.parse(raw);

        assert.equal(out.success, true);
        const replica = out.synthesis.replicas.find((r: any) => r.taskId === `${groupId}-r1`);
        assert.ok(replica, 'replica present in synthesis');
        assert.equal(replica.ok, false);
        assert.equal(replica.error, 'replica_deadline_exceeded', 'must NOT be unparseable_output — the replica may still be generating');
        assert.notEqual(replica.error, 'unparseable_output');
    } finally {
        cleanupMesh(MESH_ID);
    }
});

// ─── recoverability: a deadline-exceeded replica's answer, once it lands, IS picked up
// by a LATER mesh_magi_collect — because collectMagiResponses re-reads the task's live
// transcript fresh every call (finalized/provisional maps are function-local, not
// persisted), and force-finalizing a replica never mutates its queue row or session.
// This is exactly the mission's "does a later mesh_magi_collect recover the kimi
// answer" question, verified rather than assumed.

test('recoverability: a replica force-finalized as replica_deadline_exceeded is RECOVERED by a later mesh_magi_collect once its answer lands', async () => {
    cleanupMesh(MESH_ID);
    try {
        const groupId = 'cg-recoverable';
        let answerLanded = false;
        const { ctx } = buildCtx(MESH_ID, () => answerLanded
            ? { messages: [{ role: 'assistant', content: JSON.stringify({ claims: [{ claim: 'root cause found', stance: 'support', evidence: ['file.ts:42'], confidence: 0.9 }], top_findings: [], open_questions: [] }) }] }
            : { messages: [{ role: 'assistant', content: 'Still investigating, one moment...' }] });
        seedReplica(MESH_ID, groupId, `${groupId}-r1`, 'sess-recoverable');

        // First collect: deadline hits before the answer is ready.
        const firstRaw = await meshMagiCollect(ctx, { consensus_group_id: groupId, task_kind: 'claim_audit' });
        const first = JSON.parse(firstRaw);
        const firstReplica = first.synthesis.replicas.find((r: any) => r.taskId === `${groupId}-r1`);
        assert.equal(firstReplica.ok, false);
        assert.equal(firstReplica.error, 'replica_deadline_exceeded');

        // The replica's session now has its real answer (simulating kimi finishing 13
        // minutes later) — nothing about the task row changed, only the transcript.
        answerLanded = true;
        const secondRaw = await meshMagiCollect(ctx, { consensus_group_id: groupId, task_kind: 'claim_audit' });
        const second = JSON.parse(secondRaw);
        const secondReplica = second.synthesis.replicas.find((r: any) => r.taskId === `${groupId}-r1`);
        assert.equal(secondReplica.ok, true, 're-collecting after the answer lands recovers it — it is NOT permanently lost');
        assert.equal(second.synthesis.replicasAnswered, 1);
    } finally {
        cleanupMesh(MESH_ID);
    }
});

test('B2: a replica whose answer FAILS the kind schema is still labeled schema_invalid:*, not replica_deadline_exceeded', async () => {
    cleanupMesh(MESH_ID);
    try {
        const groupId = 'cg-schema-invalid';
        // Real JSON content for kind=rca, but missing the required rootCause/mechanism
        // fields — a genuine content defect the replica actually produced, not a timing gap.
        const { ctx } = buildCtx(MESH_ID, () => ({
            messages: [{ role: 'assistant', content: JSON.stringify({ evidence: ['file.ts:1'], confidence: 0.5 }) }],
        }));
        seedReplica(MESH_ID, groupId, `${groupId}-r1`, 'sess-badschema');

        const raw = await meshMagiCollect(ctx, { consensus_group_id: groupId, task_kind: 'rca' });
        const out = JSON.parse(raw);

        const replica = out.synthesis.replicas.find((r: any) => r.taskId === `${groupId}-r1`);
        assert.ok(replica);
        assert.equal(replica.ok, false);
        assert.match(replica.error, /^schema_invalid:/);
    } finally {
        cleanupMesh(MESH_ID);
    }
});

// ─── B3: independenceBanner names the deadline-exceeded vs genuinely-failed split ──

function resp(taskId: string, nodeId: string, provider: string, claim: string, evidence: string[]) {
    return {
        source: { taskId, nodeId, provider, ok: true },
        response: { claims: [{ claim, stance: 'support' as const, evidence, confidence: 0.9 }], top_findings: [], open_questions: [] },
    };
}
function missing(taskId: string, nodeId: string, provider: string, error: string) {
    return { source: { taskId, nodeId, provider, ok: false, error }, response: { claims: [], top_findings: [], open_questions: [] } };
}

test('B3: banner distinguishes "still pending" (replica_deadline_exceeded) from genuinely failed drops', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', 'default branch is main', ['git remote show origin']),
        missing('t2', 'nodeB', 'codex-cli', 'replica_deadline_exceeded'),
        missing('t3', 'nodeC', 'hermes-cli', 'replica_deadline_exceeded'),
    ], { replicasExpected: 3 });

    assert.ok(out.independenceBanner);
    assert.match(out.independenceBanner!, /still pending past the deadline/);
    assert.match(out.independenceBanner!, /re-collect/);
    assert.doesNotMatch(out.independenceBanner!, /panel swap/);
});

test('B3: banner names a panel-swap recommendation when drops are genuine failures, not pending', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', 'default branch is main', ['git remote show origin']),
        missing('t2', 'nodeB', 'codex-cli', 'stale: assignment not in live mesh'),
        missing('t3', 'nodeC', 'hermes-cli', 'no_session_to_read'),
    ], { replicasExpected: 3 });

    assert.ok(out.independenceBanner);
    assert.match(out.independenceBanner!, /genuinely failed\/unparseable\/stale/);
    assert.match(out.independenceBanner!, /panel swap/);
    assert.doesNotMatch(out.independenceBanner!, /still pending past the deadline/);
});

test('B3: banner names BOTH groups when the drops are a mix of pending and genuinely failed', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', 'default branch is main', ['git remote show origin']),
        missing('t2', 'nodeB', 'codex-cli', 'replica_deadline_exceeded'),
        missing('t3', 'nodeC', 'hermes-cli', 'stale: assignment not in live mesh'),
    ], { replicasExpected: 3 });

    assert.ok(out.independenceBanner);
    assert.match(out.independenceBanner!, /1 still pending past the deadline/);
    assert.match(out.independenceBanner!, /1 genuinely failed\/unparseable\/stale/);
});
