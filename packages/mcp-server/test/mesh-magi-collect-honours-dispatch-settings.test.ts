import assert from 'node:assert/strict';
import test from 'node:test';

import { meshMagiReview, meshMagiCollect } from '../src/tools/mesh-tools.js';
import { createMesh, setMagiKindPanel, getQueue, readLocalRecords, __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

// Same-axis audit D: `mesh_magi_review({ wait:false, auto_cleanup:false })` followed by
// `mesh_magi_collect({ consensus_group_id })` used to DELETE the replica sessions the caller
// asked to keep — the dispatch record kept only taskKind, the wait:false return happened
// before the cleanup step, and collect fell back to the policy default (stop_and_delete).
// The review now persists auto_cleanup / require_independent_evidence on its dispatch record
// and collect honours them (explicit collect args still override).

const ANSWER = JSON.stringify({ claims: [{ claim: 'root cause in resolver', stance: 'support', evidence: ['resolver.ts:10'], confidence: 0.9 }], top_findings: [], open_questions: [] });

function setup() {
    const created = createMesh({ name: 'MAGI collect settings', repoIdentity: 'example/magi-collect' } as any);
    const meshId = created.id;
    const mesh = {
        ...created,
        nodes: [
            { id: 'node-0', workspace: '/w0', repoRoot: '/w0', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
            { id: 'node-1', workspace: '/w1', repoRoot: '/w1', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['codex-cli'] } },
        ],
    };
    setMagiKindPanel('rca', [{ provider: 'claude-cli' }, { provider: 'codex-cli' }], meshId);
    const cleanupCalls: any[] = [];
    const responder = (command: string, args: any) => {
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        if (command === 'read_chat') return { success: true, result: { messages: [{ role: 'assistant', content: ANSWER }] } };
        if (command === 'cleanup_mesh_sessions') { cleanupCalls.push(args); return { success: true, deletedSessionIds: args.sessionIds, stoppedSessionIds: [] }; }
        return { success: true };
    };
    const transport: any = {};
    transport.command = async (c: string, a: any) => (isTurnIpcCommand(c) ? answerTurnIpc(c, a ?? {}) : responder(c, a));
    transport.meshCommand = async (_d: string, c: string, a: any) => responder(c, a);
    const ctx = { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' } as any;
    return { meshId, ctx, cleanupCalls };
}

/** Make every replica of the group a completed row bound to its own session, as a claim would. */
function completeReplicas(meshId: string, groupId: string) {
    const store = MeshRuntimeStore.getInstance();
    const entries = getQueue(meshId)
        .filter((e: any) => e.consensusGroupId === groupId)
        .map((e: any) => store.findQueueEntryById(meshId, e.id) as any);
    assert.ok(entries.length >= 2, `expected ≥2 replicas for ${groupId}, got ${entries.length}`);
    entries.forEach((entry: any, i: number) => {
        entry.assignedNodeId = `node-${i}`;
        entry.assignedSessionId = `sess-replica-${i}`;
        entry.status = 'completed';
        store.updateQueueEntry(entry);
    });
}

function cleanup(meshId: string) {
    __clearMeshQueueForTests(meshId);
    __clearLocalRecordsForTests(meshId);
    __clearMeshPendingEventsForTests(meshId);
}

test('review wait:false + auto_cleanup:false → a later collect does NOT stop/delete the replica sessions', async () => {
    const { meshId, ctx, cleanupCalls } = setup();
    try {
        const review = JSON.parse(await meshMagiReview(ctx, { question: 'why does X fail?', task_kind: 'rca', wait: false, auto_cleanup: false, require_independent_evidence: false } as any));
        assert.equal(review.success, true, JSON.stringify(review));
        assert.equal(review.pollWith.args.auto_cleanup, false);
        const dispatched = readLocalRecords(meshId, { kind: ['magi_dispatched'] } as any)
            .map((r: any) => r.payload ?? r)
            .find((p: any) => p.consensusGroupId === review.consensusGroupId);
        assert.equal(dispatched?.autoCleanup, false, 'the dispatch record carries auto_cleanup');
        assert.equal(dispatched?.requireIndependentEvidence, false, 'the dispatch record carries require_independent_evidence');
        completeReplicas(meshId, review.consensusGroupId);

        const collected = JSON.parse(await meshMagiCollect(ctx, { consensus_group_id: review.consensusGroupId }));
        assert.equal(collected.success, true, JSON.stringify(collected));
        assert.equal(collected.collection.terminal, true);
        assert.equal(cleanupCalls.length, 0, 'collect must honour the review\'s auto_cleanup:false');
        assert.equal(collected.sessionCleanup, undefined);
    } finally { cleanup(meshId); }
});

test('control: review wait:false WITHOUT auto_cleanup → collect cleans up (policy default ON); explicit collect arg overrides the record', async () => {
    const a = setup();
    try {
        const review = JSON.parse(await meshMagiReview(a.ctx, { question: 'why does Y fail?', task_kind: 'rca', wait: false } as any));
        assert.equal(review.success, true, JSON.stringify(review));
        completeReplicas(a.meshId, review.consensusGroupId);
        await meshMagiCollect(a.ctx, { consensus_group_id: review.consensusGroupId });
        assert.equal(a.cleanupCalls.length > 0, true, 'default policy cleans up — proves the probe observes cleanup');
    } finally { cleanup(a.meshId); }

    const b = setup();
    try {
        const review = JSON.parse(await meshMagiReview(b.ctx, { question: 'why does Z fail?', task_kind: 'rca', wait: false, auto_cleanup: false } as any));
        completeReplicas(b.meshId, review.consensusGroupId);
        await meshMagiCollect(b.ctx, { consensus_group_id: review.consensusGroupId, auto_cleanup: true });
        assert.equal(b.cleanupCalls.length > 0, true, 'an explicit collect auto_cleanup:true overrides the dispatch record');
    } finally { cleanup(b.meshId); }
});
