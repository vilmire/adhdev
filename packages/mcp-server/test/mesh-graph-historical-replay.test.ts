import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import {
    meshEnqueueBatch,
    meshEnqueueTask,
    meshSendTask,
} from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { getQueue, updateTaskStatus, taskDependenciesSatisfied } from '@adhdev/daemon-core';

// GRAPH-ORCHESTRATION Phase G — historical replay + backward compatibility.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :839-840  replay the two historical request shapes: 14 task rows, same
//               messages, targets, dependency behavior, and terminal outcomes
//     :935-950  backward compatibility — old batches keep queue semantics,
//               mesh_enqueue_task / mesh_send_task unchanged, old clients
//               tolerate additive response fields, unknown v2 fields must fail
//               with graph_schema_unsupported (:947)
//
// The two batches below are recorded v1 coordinator-era fixtures: plain
// `depends_on` chains, no graph blocks. They are replayed through the CURRENT
// admission code and every recorded conclusion must hold identically.

const NODE_MAC = 'node_mac_base';

function nextMeshId(): string {
    return `mesh_replay_${randomUUID().slice(0, 8)}`;
}

function recordingLocalTransport() {
    const commands: Array<{ cmd: string; args: any }> = [];
    return {
        commands,
        command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
        getStatus: async () => ({ sessions: [] }),
    } as any;
}

function recordingIpcTransport() {
    const commands: Array<{ cmd: string; args: any }> = [];
    const meshCommands: Array<{ daemonId: string; cmd: string; args: any }> = [];
    const t = {
        commands,
        meshCommands,
        command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
        meshCommand: async (daemonId: string, cmd: string, args: any) => {
            meshCommands.push({ daemonId, cmd, args });
            return { success: true, sessions: [] };
        },
        getStatus: async () => ({ sessions: [] }),
    } as any;
    Object.setPrototypeOf(t, IpcTransport.prototype);
    return t;
}

function makeCtx(meshId: string, transport: any, coordinatorSessionId = 'sess-coord') {
    return {
        mesh: {
            id: meshId,
            nodes: [{
                id: NODE_MAC,
                workspace: '/repo/mac',
                daemonId: 'daemon_mac',
                // A provider priority lets the eager P2P push reach agent_command,
                // so the replay can observe exactly which tasks were dispatched.
                policy: { providerPriority: ['claude-cli'] },
            }],
        },
        transport,
        coordinatorSessionId,
    } as any;
}

// ── Recorded fixtures: the two historical v1 batches, 14 task rows total ─────
//
// `expectedClaimable[i]` is the set of refs that became claimable after the
// i-th completion in `completionOrder` (claimable = status 'pending' AND the
// unchanged queue dependency predicate satisfied). This IS the recorded
// dispatch order of the original runs.

interface LegacyTaskSpec {
    ref: string;
    message: string;
    difficulty: string;
    depends_on?: string[];
    target_node_id?: string;
}

interface LegacyBatchFixture {
    name: string;
    tasks: LegacyTaskSpec[];
    roots: string[];
    completionOrder: string[];
    expectedClaimable: string[][];
}

// Historical batch 1 — the incident-fix chain (6 tasks).
const LEGACY_BATCH_1: LegacyBatchFixture = {
    name: 'incident-fix',
    tasks: [
        { ref: 'investigate', message: 'Investigate the flaky login timeout — read the auth handler and report the root cause', difficulty: 'medium' },
        { ref: 'repro', message: 'Write a minimal reproduction script for the login timeout', difficulty: 'easy' },
        { ref: 'fix', message: 'Fix the login timeout in the session refresh path', difficulty: 'medium', depends_on: ['investigate', 'repro'] },
        { ref: 'verify', message: 'Verify the fix with the reproduction script and the auth test suite', difficulty: 'medium', depends_on: ['fix'] },
        { ref: 'docs', message: 'Update the changelog entry for the login timeout fix', difficulty: 'easy', depends_on: ['fix'] },
        { ref: 'notify', message: 'Post the incident summary to the team channel', difficulty: 'easy', depends_on: ['verify'] },
    ],
    roots: ['investigate', 'repro'],
    completionOrder: ['investigate', 'repro', 'fix', 'docs', 'verify', 'notify'],
    expectedClaimable: [
        ['repro'],
        ['fix'],
        ['docs', 'verify'],
        ['verify'],
        ['notify'],
        [],
    ],
};

// Historical batch 2 — the release pipeline (8 tasks). `publish` was pinned to
// the Mac base node in the original run; the pin must survive verbatim.
const LEGACY_BATCH_2: LegacyBatchFixture = {
    name: 'release-pipeline',
    tasks: [
        { ref: 'scan', message: 'Scan the release branch for secrets and license violations', difficulty: 'easy' },
        { ref: 'lint', message: 'Run the full lint suite on the release branch', difficulty: 'easy' },
        { ref: 'build', message: 'Build the release artifacts for all supported platforms', difficulty: 'medium' },
        { ref: 'unit_test', message: 'Run the unit test suite against the release build', difficulty: 'medium', depends_on: ['build'] },
        { ref: 'e2e', message: 'Run the end-to-end suite against a staged release build', difficulty: 'medium', depends_on: ['build', 'scan'] },
        { ref: 'package', message: 'Package the signed installers from the release build', difficulty: 'medium', depends_on: ['unit_test'] },
        { ref: 'publish', message: 'Publish the signed installers to the release channel', difficulty: 'medium', depends_on: ['package', 'e2e'], target_node_id: NODE_MAC },
        { ref: 'announce', message: 'Announce the release in the changelog and the team channel', difficulty: 'easy', depends_on: ['publish'] },
    ],
    roots: ['scan', 'lint', 'build'],
    completionOrder: ['scan', 'lint', 'build', 'unit_test', 'e2e', 'package', 'publish', 'announce'],
    expectedClaimable: [
        ['lint', 'build'],
        ['build'],
        ['unit_test', 'e2e'],
        ['e2e', 'package'],
        ['package'],
        ['publish'],
        ['announce'],
        [],
    ],
};

async function replayLegacyBatch(fixture: LegacyBatchFixture) {
    const meshId = nextMeshId();
    const transport = recordingIpcTransport();
    const ctx = makeCtx(meshId, transport);

    const res = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: fixture.tasks.map(t => ({
            ref: t.ref,
            message: t.message,
            difficulty: t.difficulty,
            ...(t.depends_on ? { depends_on: t.depends_on } : {}),
            ...(t.target_node_id ? { target_node_id: t.target_node_id } : {}),
        })),
    } as any));

    // ── Same response an old client consumed; additive fields tolerated ──
    // (design :942 — the response parses and every legacy field is present).
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(res.source, 'queue');
    assert.equal(res.atomic, true);
    assert.equal(res.enqueued, fixture.tasks.length);
    assert.equal(res.tasks.length, fixture.tasks.length);
    for (const t of res.tasks) {
        assert.ok(t.ref, 'legacy per-task ref echo');
        assert.ok(t.taskId, 'legacy per-task id echo');
        assert.equal(t.status, 'pending');
    }
    // design :937-938 — a v1 batch creates NO graph; graph fields are additive
    // and stay absent on the old path.
    assert.equal(res.graphId, undefined, 'a static batch must not manufacture a graph');
    assert.equal(res.batchId, undefined);
    assert.equal(res.graphHeldTasks, undefined);
    // Only dependents are deferred from the eager push; every root is pushed.
    assert.equal(
        res.eagerPushDeferred,
        fixture.tasks.length - fixture.roots.length,
        'dependents deferred, roots pushed — the recorded dispatch split',
    );
    const pushedMessages = transport.meshCommands
        .filter(c => c.cmd === 'agent_command')
        .map(c => c.args?.message);
    assert.deepEqual(
        pushedMessages.sort(),
        fixture.roots.map(r => fixture.tasks.find(t => t.ref === r)!.message).sort(),
        'exactly the root messages were dispatched, and no dependent was',
    );

    // ── Same rows: messages, targets, dependency wiring ──
    const refById = new Map<string, string>(res.tasks.map((t: any) => [t.taskId, t.ref]));
    const idByRef = new Map<string, string>(res.tasks.map((t: any) => [t.ref, t.taskId]));
    const queue = getQueue(meshId);
    assert.equal(queue.length, fixture.tasks.length);
    for (const spec of fixture.tasks) {
        const row = queue.find(t => t.id === idByRef.get(spec.ref))!;
        assert.ok(row, `row for '${spec.ref}' exists`);
        assert.equal(row.message, spec.message, 'message preserved verbatim');
        assert.equal(row.status, 'pending');
        assert.equal(row.blockedReason, undefined, `task '${spec.ref}' must not carry a graph block`);
        assert.deepEqual(
            [...(row.dependsOn ?? [])].sort(),
            (spec.depends_on ?? []).map(r => idByRef.get(r)!).sort(),
            `depends_on wiring of '${spec.ref}' preserved as task ids`,
        );
        assert.equal(
            row.targetNodeId,
            spec.target_node_id,
            spec.target_node_id ? `target pin of '${spec.ref}' preserved` : `task '${spec.ref}' stays unpinned`,
        );
    }

    // ── Same dependency behavior + terminal outcomes ──
    // Walk the recorded completion order. At each step: exactly the recorded
    // set is claimable (pending + dependency predicate satisfied), completing a
    // task never requeues or duplicates a row, and completed rows stay terminal.
    const claimableRefs = () => {
        const statusById = new Map(getQueue(meshId).map(t => [t.id, t.status] as const));
        return getQueue(meshId)
            .filter(t => t.status === 'pending' && taskDependenciesSatisfied(t, statusById))
            .map(t => refById.get(t.id)!)
            .sort();
    };
    assert.deepEqual(claimableRefs(), [...fixture.roots].sort(), 'initial dispatch set = the roots');

    fixture.completionOrder.forEach((ref, i) => {
        // A dependent whose predecessors are still pending must NOT be claimable.
        const spec = fixture.tasks.find(t => t.ref === ref)!;
        for (const depRef of spec.depends_on ?? []) {
            const depRow = getQueue(meshId).find(t => t.id === idByRef.get(depRef))!;
            assert.equal(depRow.status, 'completed', `fixture order broken: '${depRef}' must complete before '${ref}'`);
        }
        assert.ok(claimableRefs().includes(ref), `'${ref}' must be claimable at its recorded step`);

        updateTaskStatus(meshId, idByRef.get(ref)!, 'completed');
        const after = getQueue(meshId);
        assert.equal(after.length, fixture.tasks.length, 'completion never requeues or duplicates a row');
        const doneRow = after.find(t => t.id === idByRef.get(ref))!;
        assert.equal(doneRow.status, 'completed');
        // Dependents become claimable WITHOUT any requeue: the same row simply
        // stops being refused by the unchanged predicate.
        assert.deepEqual(
            claimableRefs(),
            [...fixture.expectedClaimable[i]!].sort(),
            `claimable set after completing '${ref}'`,
        );
    });

    // Terminal outcomes: every recorded row completed, nothing left behind.
    for (const row of getQueue(meshId)) {
        assert.equal(row.status, 'completed', `terminal outcome of '${refById.get(row.id)}'`);
    }
    return { meshId, res };
}

// ── 1. The 14-task historical replay ─────────────────────────────────────────

test('replay: historical batch 1 (6 tasks, incident-fix chain) reproduces identical behavior', async () => {
    await replayLegacyBatch(LEGACY_BATCH_1);
});

test('replay: historical batch 2 (8 tasks, release pipeline) reproduces identical behavior', async () => {
    await replayLegacyBatch(LEGACY_BATCH_2);
});

// ── 2. Single enqueue + direct send unchanged (design :942-943) ──────────────

test('compat: mesh_enqueue_task and mesh_send_task still work with legacy args', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());

    const enqueued = JSON.parse(await meshEnqueueTask(ctx, {
        message: 'single legacy enqueue',
        difficulty: 'medium',
    } as any));
    assert.equal(enqueued.success, true, JSON.stringify(enqueued));
    assert.equal(enqueued.source, 'queue');
    assert.ok(enqueued.taskId);
    const queuedRow = getQueue(meshId).find(t => t.id === enqueued.taskId)!;
    assert.equal(queuedRow.message, 'single legacy enqueue');
    assert.equal(queuedRow.status, 'pending');

    // No session_id → the untargeted queue-pull fallback, as before.
    const sent = JSON.parse(await meshSendTask(ctx, {
        node_id: NODE_MAC,
        message: 'direct legacy send',
        difficulty: 'medium',
    } as any));
    assert.equal(sent.success, true, JSON.stringify(sent));
    assert.equal(sent.source, 'queue');
    const sentRow = getQueue(meshId).find(t => t.id === sent.taskId)!;
    assert.equal(sentRow.message, 'direct legacy send');
});

// ── 3. Unknown v2 fields vs the old-daemon contract (design :947) ────────────

test('compat: unknown v2 fields on a batch task — current behavior pinned (design :947 DEFECT)', async () => {
    const meshId = nextMeshId();
    const ctx = makeCtx(meshId, recordingLocalTransport());

    // Control: a KNOWN v2 field fails loudly when it cannot be honored —
    // admission does know how to reject v2 requests it cannot serve.
    const knownField = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{ ref: 'gated', message: 'known v2 field, missing gate', difficulty: 'easy', gated_by: ['land'] }],
    } as any));
    assert.equal(knownField.success, false);
    assert.equal(knownField.code, 'unknown_gate_ref');
    assert.equal(getQueue(meshId).length, 0, 'a rejected plan leaves no rows behind');

    // DEFECT: design :947 — "Unknown v2 fields sent to an old daemon must fail
    // with graph_schema_unsupported, not silently degrade into static tasks."
    // The string `graph_schema_unsupported` exists NOWHERE in oss/ (verified by
    // grep). Unknown v2 fields are silently DROPPED instead:
    //   - readGraphTaskFields (mcp-server/src/tools/mesh-tools-graph.ts:109-127)
    //     copies only a whitelist of six known v2 fields;
    //   - requestUsesGraphV2 (daemon-core/src/mesh/mesh-graph-plan.ts:162-166)
    //     checks only that same whitelist;
    //   - normalizeEnqueueTaskArgs (mcp-server/src/tools/mesh-tools-queue.ts:214-315)
    //     never rejects unknown keys.
    // Net effect, pinned below: a task carrying unknown v2 fields takes the
    // compatibility path and enqueues as a plain static task — the exact
    // silent degradation the design forbids. There is also no daemon
    // capability negotiation anywhere in the admission path.
    const degraded = JSON.parse(await meshEnqueueBatch(ctx, {
        tasks: [{
            ref: 'modern',
            message: 'task carrying fields a v1 daemon cannot understand',
            difficulty: 'easy',
            graph_schema_version: 3,
            sub_graphs: [{ ref: 'child', message: 'nested work' }],
        }],
    } as any));
    assert.equal(degraded.success, true, 'DEFECT: silently accepted instead of graph_schema_unsupported');
    assert.equal(degraded.code, undefined, 'DEFECT: no capability error is surfaced');
    assert.equal(degraded.graphId, undefined, 'the unknown fields did not even take the graph path');
    const rows = getQueue(meshId);
    assert.equal(rows.length, 1, 'DEFECT: a plain static task was enqueued — the silent degradation');
    assert.equal(rows[0]!.message, 'task carrying fields a v1 daemon cannot understand');
    assert.equal(rows[0]!.dependsOn, undefined, 'the nested sub-graph was silently discarded');
});
