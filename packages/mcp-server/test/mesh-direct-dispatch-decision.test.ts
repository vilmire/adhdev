import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask, ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { getLedgerDir, readLedgerEntries } from '@adhdev/daemon-core';
import { __clearDirectDispatchesForTests, __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// GRAPH-MEASUREMENT-DIRECT — the direct dispatch surface's decision record.
//
// ★ WHY THIS FILE EXISTS. The graph-adoption investigation found 0 graphs across 206
// dispatches and could not conclude anything from it, because ~67% of those dispatches
// went out through `mesh_send_task` — whose schema had NO decision field at all. The
// existing `single_enqueue_decision` measurement therefore covered only the enqueue
// minority: its `decision_missing` count was SILENT about the direct majority rather
// than evidence about it, and the adoption mission deadlocked waiting for data the
// system could not produce.
//
// ★ THE FAILURE MODE THESE TESTS EXIST TO PREVENT is adding the schema field and
// stopping there. A field that no ledger write consumes reproduces the same deadlock
// with more ceremony, so every test below asserts on the LEDGER, not on the schema
// (with one deliberate exception: the optionality contract, which is a schema fact).
//
// ★ MEASUREMENT ONLY, deliberately. Nothing here asserts a dispatch is rejected.
// `batch_required`-style enforcement is explicitly out of scope — the coordinator
// prompt warns that enforcing before measuring manufactures fake compliance.

const NODE_LOCAL = 'node-local';
const COORDINATOR_DAEMON = 'daemon-coordinator';

function cleanupMesh(meshId: string): void {
    __clearMeshQueueForTests(meshId);
    __clearDirectDispatchesForTests(meshId);
    __clearMeshLedgerForTests(meshId);
    __clearMeshPendingEventsForTests(meshId);
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
        const path = join(getLedgerDir(), `${safe}${suffix}`);
        if (existsSync(path)) unlinkSync(path);
    }
}

function nextMeshId(): string {
    return `mesh_direct_decision_${randomUUID().slice(0, 8)}`;
}

/**
 * A LOCAL control-plane node hosting one idle mesh-managed session, which routes
 * meshSendTask down the `local_direct` path (the same harness shape as
 * mesh-dispatch-ack-risk-stale.test.ts).
 */
function createLocalIdleCtx(meshId: string, opts: { agentCommandSucceeds?: boolean } = {}) {
    const agentCommandSucceeds = opts.agentCommandSucceeds !== false;
    const idleSession = {
        id: 'sess-idle',
        providerType: 'claude-cli',
        status: 'idle',
        settings: {
            meshNodeFor: meshId,
            meshNodeId: NODE_LOCAL,
            meshCoordinatorDaemonId: COORDINATOR_DAEMON,
        },
    };
    const mesh = {
        id: meshId,
        name: 'Direct Dispatch Decision',
        repoIdentity: 'example/repo',
        policy: {},
        coordinator: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: [{
            id: NODE_LOCAL,
            workspace: '/tmp/local-repo',
            repoRoot: '/tmp/local-repo',
            daemonId: COORDINATOR_DAEMON,
            machineId: 'machine-coordinator',
            userOverrides: {},
            policy: { providerPriority: ['claude-cli'] },
            sessions: [idleSession],
        }],
    };
    const transport = new IpcTransport() as IpcTransport & {
        command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    transport.command = async (command, _args = {}) => {
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [idleSession] } };
        if (command === 'agent_command') return { success: agentCommandSucceeds };
        throw new Error(`unexpected local command: ${command}`);
    };
    transport.meshCommand = async (_daemonId, command) => {
        throw new Error(`unexpected mesh command on local node: ${command}`);
    };
    return {
        ctx: {
            mesh,
            transport,
            localDaemonId: COORDINATOR_DAEMON,
            localMachineId: 'machine-coordinator',
            coordinatorSessionId: 'sess-coord',
        } as any,
    };
}

function directDecisions(meshId: string) {
    return readLedgerEntries(meshId, { kind: ['direct_dispatch_decision'] } as any);
}

async function sendTask(ctx: any, extra: Record<string, unknown> = {}) {
    return JSON.parse(await meshSendTask(ctx, {
        node_id: NODE_LOCAL,
        session_id: 'sess-idle',
        message: 'continue the same investigation',
        difficulty: 'medium',
        ...extra,
    } as any));
}

// ── The core wiring: a direct dispatch lands in the ledger WITH its decision ──────

test('a direct dispatch records its decision in the ledger against the dispatched task', async () => {
    const meshId = nextMeshId();
    cleanupMesh(meshId);
    const { ctx } = createLocalIdleCtx(meshId);
    try {
        const res = await sendTask(ctx, {
            orchestration_decision: {
                decision: 'direct',
                direct_reason: 'same_subject_continuation',
                ready_worker_tasks: 1,
            },
        });
        assert.equal(res.success, true);
        assert.equal(res.source, 'direct');

        // ★ THE ASSERTION THIS WHOLE TASK IS ABOUT: the ledger, not the schema.
        const entries = directDecisions(meshId);
        assert.equal(entries.length, 1, 'a direct dispatch must leave exactly one decision entry');
        const payload = entries[0].payload as any;
        assert.equal(payload.taskId, res.taskId);
        assert.equal(payload.enqueueSurface, 'direct');
        assert.equal(payload.via, 'local_direct');
        assert.equal(payload.nodeId, NODE_LOCAL);
        assert.equal(payload.sessionId, 'sess-idle');
        assert.equal(payload.coordinatorSessionId, 'sess-coord');
        assert.equal(payload.orchestrationDecision.decision, 'direct');
        assert.equal(payload.orchestrationDecision.direct_reason, 'same_subject_continuation');
        assert.equal(payload.orchestrationDecision.ready_worker_tasks, 1);
        // A sanctioned, declared direct is not flagged at all.
        assert.equal(payload.decisionMissing, undefined);
        assert.equal(payload.unsanctionedDirect, undefined);
        assert.equal(res.orchestrationDecisionMissing, undefined);

        // The entry must be joinable by taskId like every other task-lifecycle kind,
        // otherwise the direct rows cannot be correlated with the dispatch they describe.
        assert.equal(entries[0].taskId, res.taskId);
    } finally {
        cleanupMesh(meshId);
    }
});

// ── Backward compatibility: the field is OPTIONAL and its absence is the datapoint ──

test('a legacy call with NO decision field still dispatches, and is recorded as decision_missing', async () => {
    const meshId = nextMeshId();
    cleanupMesh(meshId);
    const { ctx } = createLocalIdleCtx(meshId);
    try {
        const res = await sendTask(ctx);
        // ★ REGRESSION GUARD: every existing mesh_send_task caller omits this field.
        // The dispatch must succeed exactly as before.
        assert.equal(res.success, true);
        assert.equal(res.dispatched, true);
        assert.equal(res.source, 'direct');
        // Omission is measured, not punished.
        assert.equal(res.orchestrationDecisionMissing, true);

        const payload = directDecisions(meshId)[0].payload as any;
        assert.equal(payload.decisionMissing, true);
        assert.equal(payload.orchestrationDecision.decision, 'direct');
        assert.equal(payload.orchestrationDecision.direct_reason, null);
    } finally {
        cleanupMesh(meshId);
    }
});

test('mesh_send_task exposes orchestration_decision and does NOT require it', () => {
    const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_send_task')!;
    const props = (tool.inputSchema as any).properties;
    assert.ok(props.orchestration_decision, 'mesh_send_task must expose orchestration_decision');
    assert.ok(props.orchestrationDecision, 'and its camelCase alias, like every other field here');

    // ★ The optionality is the contract. Requiring it would break every existing caller,
    // and phase E measures rather than enforces.
    assert.deepEqual(
        (tool.inputSchema as any).required,
        ['node_id', 'session_id', 'message', 'difficulty'],
        'orchestration_decision must stay OPTIONAL on the direct surface',
    );

    // The closed direct_reason vocabulary must be discoverable from the field's own
    // description — a caller cannot pick a legal value it has never been shown.
    const doc: string = props.orchestration_decision.description;
    for (const reason of [
        'same_subject_continuation', 'investigation_handoff', 'idle_session_reuse',
        'queue_bypass_urgent', 'new_subject', 'legacy_client', 'operator_override',
    ]) {
        assert.ok(doc.includes(reason), `the direct_reason value '${reason}' must be documented`);
    }
});

// ── Justified vs lazy: the distinction the measurement exists to make ─────────────

test('an unsanctioned direct reason is flagged, and still dispatches', async () => {
    const meshId = nextMeshId();
    cleanupMesh(meshId);
    const { ctx } = createLocalIdleCtx(meshId);
    try {
        // `new_subject` is exactly what the operating rules say must NOT be appended to an
        // existing session — reporting it means the direct dispatch was not sanctioned.
        const res = await sendTask(ctx, {
            orchestration_decision: { decision: 'direct', direct_reason: 'new_subject' },
        });
        // ★ WARN, NEVER BLOCK. Enforcement is explicitly out of scope.
        assert.equal(res.success, true);
        assert.equal(res.dispatched, true);
        assert.equal(res.unsanctionedDirect.code, 'unsanctioned_direct_dispatch');
        assert.equal(res.unsanctionedDirect.reportedReason, 'new_subject');
        assert.match(res.unsanctionedDirectHint, /mesh_enqueue_batch/);

        const payload = directDecisions(meshId)[0].payload as any;
        assert.equal(payload.unsanctionedDirect, 'new_subject');
        assert.equal(payload.orchestrationDecision.direct_reason, 'new_subject');
    } finally {
        cleanupMesh(meshId);
    }
});

test('the sanctioned direct reasons are NOT flagged', async () => {
    // The four cases the coordinator prompt explicitly endorses for mesh_send_task
    // (Workflow 3.a/3.c/3.f and the "Reuse idle sessions" rule). If any of these were
    // flagged, the advisory would fire on correct behavior and coordinators would learn
    // to ignore it.
    for (const reason of [
        'same_subject_continuation', 'investigation_handoff',
        'idle_session_reuse', 'queue_bypass_urgent',
    ]) {
        const meshId = nextMeshId();
        cleanupMesh(meshId);
        const { ctx } = createLocalIdleCtx(meshId);
        try {
            const res = await sendTask(ctx, {
                orchestration_decision: { decision: 'direct', direct_reason: reason },
            });
            assert.equal(res.success, true);
            assert.equal(res.unsanctionedDirect, undefined, `'${reason}' must not be flagged`);
            const payload = directDecisions(meshId)[0].payload as any;
            assert.equal(payload.orchestrationDecision.direct_reason, reason);
            assert.equal(payload.unsanctionedDirect, undefined);
        } finally {
            cleanupMesh(meshId);
        }
    }
});

// ── Aggregation integrity with the enqueue surface ───────────────────────────────

test('the direct decision row is shaped to aggregate with the single-enqueue row', async () => {
    const meshId = nextMeshId();
    cleanupMesh(meshId);
    const { ctx } = createLocalIdleCtx(meshId);
    try {
        const res = await sendTask(ctx, {
            orchestration_decision: { decision: 'direct', direct_reason: 'idle_session_reuse' },
        });
        const payload = directDecisions(meshId)[0].payload as any;
        // The fields a cross-surface reducer joins on must exist under the SAME names as
        // single_enqueue_decision uses, so "dispatches by surface, and how many declared a
        // reason" is one pass over both kinds rather than two bespoke readers.
        for (const field of ['taskId', 'enqueueSurface', 'orchestrationDecision', 'coordinatorSessionId']) {
            assert.ok(field in payload, `shared aggregation field '${field}' must be present`);
        }
        assert.equal(payload.enqueueSurface, 'direct', 'the surface discriminator must be distinguishable');
        assert.equal(payload.orchestrationDecision.decision, 'direct');
        // The single-surface axis must be absent rather than null-filled on a direct row:
        // a direct dispatch never answers "why one step instead of a graph".
        assert.equal(payload.orchestrationDecision.single_reason, null);
        assert.equal(res.success, true);
    } finally {
        cleanupMesh(meshId);
    }
});

// ── Content boundary ─────────────────────────────────────────────────────────────

test('the direct decision payload carries no task message (content boundary)', async () => {
    const meshId = nextMeshId();
    cleanupMesh(meshId);
    const { ctx } = createLocalIdleCtx(meshId);
    try {
        const secret = `do-not-log-${randomUUID()}`;
        await sendTask(ctx, {
            message: secret,
            orchestration_decision: { decision: 'direct', direct_reason: 'same_subject_continuation' },
        });
        // Identifiers, counts and enums only — the WHOLE entry is searched, not just the
        // fields named above.
        assert.equal(
            JSON.stringify(directDecisions(meshId)[0]).includes(secret), false,
            'a task message must never reach a dispatch-decision payload',
        );
    } finally {
        cleanupMesh(meshId);
    }
});

// ── A dispatch that never happened must not be counted as one ────────────────────

test('a refused dispatch records no decision entry', async () => {
    const meshId = nextMeshId();
    cleanupMesh(meshId);
    // agent_command rejects the inject, so no task was actually dispatched.
    const { ctx } = createLocalIdleCtx(meshId, { agentCommandSucceeds: false });
    try {
        const res = await sendTask(ctx, {
            orchestration_decision: { decision: 'direct', direct_reason: 'same_subject_continuation' },
        });
        assert.equal(res.success, false);
        // ★ Counting a refused dispatch would inflate the direct-vs-queue ratio this
        // measurement exists to compute.
        assert.equal(directDecisions(meshId).length, 0);
    } finally {
        cleanupMesh(meshId);
    }
});

test('an untargeted send_task falls through to the QUEUE and records no direct decision', async () => {
    const meshId = nextMeshId();
    cleanupMesh(meshId);
    const { ctx } = createLocalIdleCtx(meshId);
    try {
        // Without a session_id, meshSendTask enqueues a queue task instead of dispatching
        // directly. Recording that as a direct dispatch would corrupt the very ratio the
        // measurement computes — the fall-through is deliberately NOT instrumented here.
        const res = JSON.parse(await meshSendTask(ctx, {
            node_id: NODE_LOCAL,
            message: 'untargeted work',
            difficulty: 'medium',
            orchestration_decision: { decision: 'direct', direct_reason: 'queue_bypass_urgent' },
        } as any));
        assert.equal(res.source, 'queue', 'an untargeted send_task takes the queue path');
        assert.equal(directDecisions(meshId).length, 0);
    } finally {
        cleanupMesh(meshId);
    }
});
