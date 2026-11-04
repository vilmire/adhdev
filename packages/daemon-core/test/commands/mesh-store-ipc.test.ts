import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// C-W9b / C-W9a: the daemon-side responders of the mcp-server's store IPC
// (mesh-store-ipc.ts) — run through the SAME registered map the IPC transport
// dispatches (turnLedgerIpcHandlers), against a real temp mesh-runtime.db.

const testTmpDir = path.join(tmpdir(), `adhdev-store-ipc-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    recoverLocalNodeIdentity: vi.fn(),
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));
vi.mock('../../src/config/mesh-config-routing.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getDifficultyBrains: vi.fn(() => undefined),
}))

import { turnLedgerIpcHandlers, turnLedgerIpcSpecs } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { __resetMeshRuntimeStoreForTests, getQueue, enqueueTask, getQueueEntryById } from '../../src/mesh/mesh-work-queue.js';
import { readLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { seedLocalRecord } from '../helpers/local-records.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';

const v = 1;
let meshId: string;

async function call(command: string, args: Record<string, unknown>): Promise<any> {
    const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<unknown>>)[command];
    expect(handler, command).toBeTypeOf('function');
    return handler({ deps: { statusInstanceId: 'daemon-test' } }, args);
}

beforeEach(() => {
    meshId = `mesh_store_ipc_${randomUUID().slice(0, 8)}`;
});

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('registration', () => {
    it('every store command is in the turn IPC map, reachable over local IPC only', () => {
        const names = Object.keys(meshStoreIpcHandlers);
        expect(names.sort()).toEqual([
            'active_work_query', 'direct_dispatch_record', 'ledger_query', 'light_discard', 'light_land', 'mission_list_query',
            'queue_cancel', 'queue_enqueue', 'queue_enqueue_batch', 'queue_query', 'queue_requeue', 'queue_revise',
            'record_local', 'recovery_context_query', 'tool_call_record',
        ]);
        const byName = new Map(turnLedgerIpcSpecs.map((spec) => [spec.name, spec]));
        for (const name of names) expect(byName.get(name)?.sources, name).toEqual(['ipc', 'standalone']);
    });

    it('a malformed request is refused by the wire decoder, never executed', async () => {
        for (const name of Object.keys(meshStoreIpcHandlers)) {
            const res = await call(name, { v, meshId, bogus: true });
            expect(res.success, name).toBe(false);
        }
    });
});

describe('record_local / ledger_query', () => {
    it('stores the full nested payload locally and serves it back with the summary', async () => {
        const rec = await call('record_local', { v, meshId, kind: 'checkpoint_created', payload: { checkpointId: 'c1', synthesis: { notes: ['free text'] } } });
        expect(rec).toMatchObject({ success: true, storedLocally: true });
        const [row] = readLocalRecords(meshId);
        expect(row.id).toBe(rec.eventId);
        expect((row.payload as any).synthesis.notes).toEqual(['free text']);

        seedMeshAttempt({ meshId, taskId: 't-failed', sessionId: 's1', stage: 'failed', terminalReason: 'session_error' });
        const q = await call('ledger_query', { v, meshId, kind: ['task_failed', 'checkpoint_created'], includeSummary: true });
        expect(q.success).toBe(true);
        expect(q.entries.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['checkpoint_created', 'task_failed']));
        expect(q.summary).toMatchObject({ meshId, taskFailed: 1 });
    });
});

describe('queue commands', () => {
    it('queue_enqueue inserts through enqueueTask', async () => {
        const res = await call('queue_enqueue', {
            v, meshId, message: 'do the thing', options: { difficulty: 'easy', taskMode: 'general' },
        });
        expect(res.success).toBe(true);
        expect(res.entry).toMatchObject({ meshId, message: 'do the thing', status: 'pending' });

        const listed = await call('queue_query', { v, meshId, statuses: ['pending'] });
        expect(listed.entries.map((e: any) => e.id)).toEqual([res.entry.id]);
        expect((await call('queue_query', { v, meshId, taskId: 'nope' })).entries).toEqual([]);
    });

    it('queue_enqueue surfaces the daemon guard verbatim', async () => {
        const res = await call('queue_enqueue', { v, meshId, message: 'x', options: {} });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/difficulty/);
    });

    it('queue_cancel returns the row before and after; queue_requeue returns the requeued row', async () => {
        const { entry } = await call('queue_enqueue', { v, meshId, message: 'cancel me', options: { difficulty: 'easy' } });
        const cancelled = await call('queue_cancel', { v, meshId, taskId: entry.id, reason: 'operator' });
        expect(cancelled.before).toMatchObject({ id: entry.id, status: 'pending' });
        expect(cancelled.task).toMatchObject({ id: entry.id, status: 'cancelled' });
        expect((await call('queue_cancel', { v, meshId, taskId: 'missing' }))).toMatchObject({ success: true, task: null, before: null });

        const requeued = await call('queue_requeue', { v, meshId, taskId: entry.id, options: { reason: 'retry', force: true } });
        expect(requeued.success).toBe(true);
        expect(requeued.task?.id).toBe(entry.id);
    });

    it('queue_enqueue_batch inserts atomically; a refusal is a RESULT carrying its code', async () => {
        const ok = await call('queue_enqueue_batch', {
            v, meshId,
            specs: [{ ref: 'a', message: 'first', difficulty: 'easy' }, { ref: 'b', message: 'second', difficulty: 'easy', dependsOn: ['a'] }],
        });
        expect(ok.success).toBe(true);
        expect(ok.ok).toBe(true);
        expect(ok.tasks).toHaveLength(2);
        expect(getQueue(meshId)).toHaveLength(2);

        const refused = await call('queue_enqueue_batch', { v, meshId, specs: [{ message: 'no difficulty' }] });
        expect(refused).toMatchObject({ success: true, ok: false, refusalCode: 'missing_task_difficulty' });
        expect(getQueue(meshId)).toHaveLength(2);
    });
});

describe('direct_dispatch_record', () => {
    it('records the direct task row', async () => {
        const res = await call('direct_dispatch_record', {
            v, meshId, taskId: 't-direct', message: 'direct work',
            task: { assignedNodeId: 'node-a', assignedSessionId: 'sess-a', taskMode: 'general', difficulty: 'easy' },
        });
        expect(res).toMatchObject({ success: true, taskRecorded: true });
        expect(getQueue(meshId).map((t) => t.id)).toContain('t-direct');
    });
});

describe('active_work_query / recovery_context_query / tool_call_record / mission_list_query', () => {
    it('computes active work in the daemon, and returns the inputs it used when asked', async () => {
        await call('queue_enqueue', { v, meshId, message: 'pending work', options: { difficulty: 'easy' } });
        seedLocalRecord(meshId, { kind: 'task_dispatched', nodeId: 'n1', sessionId: 's1', payload: { taskId: 't-direct', source: 'direct', via: 'local_direct', message: 'direct' } });
        const res = await call('active_work_query', { v, meshId, nodes: [], includeInputs: true, includeSummary: true });
        expect(res.success).toBe(true);
        expect(res.activeWork.summary.totalActiveCount).toBeGreaterThanOrEqual(1);
        expect(res.records.map((r: any) => r.kind)).toContain('task_dispatched');
        expect(Array.isArray(res.directDispatches)).toBe(true);
        expect(res.summary).toMatchObject({ meshId, taskDispatched: 1 });

        const inputsOnly = await call('active_work_query', { v, meshId, compute: false, includeInputs: true });
        expect(inputsOnly.activeWork).toBeUndefined();
        expect(inputsOnly.records.length).toBeGreaterThan(0);

        const withRuntime = await call('active_work_query', { v, meshId, compute: false, includeSchedulingRuntime: true, mesh: { id: meshId, nodes: [] } });
        expect(withRuntime.schedulingRuntime).toBeTypeOf('object');
    });

    it('recovery_context_query counts the node\'s recent failures from the turn ledger', async () => {
        seedMeshAttempt({ meshId, taskId: 't-f', sessionId: 's-f', nodeId: 'node-f', stage: 'failed', terminalReason: 'session_error' });
        const res = await call('recovery_context_query', { v, meshId, nodeId: 'node-f' });
        expect(res.success).toBe(true);
        expect(res.context.consecutiveNodeFailures).toBe(1);
    });

    it('tool_call_record bumps the per-tool counter; mission_list_query answers the folded projection', async () => {
        const first = await call('tool_call_record', { v, meshId, tool: 'mesh_status', callerRole: 'coordinator' });
        expect(first).toMatchObject({ success: true, rateLimitExceeded: false, callsInWindow: 1, advisory: null });
        const missions = await call('mission_list_query', { v, meshId });
        expect(missions).toMatchObject({ success: true, missions: [], historyFold: null, truncated: false, matched: 0 });
    });
});

describe('mission_list_query meshStatusView — structured fields are capability-gated (bundle B)', () => {
    it('adds summary + openItems only when the caller sends structured:true (an older tool gets the legacy rows)', async () => {
        const { upsertStructuredMission } = await import('../../src/mesh/mesh-mission-structured.js');
        upsertStructuredMission(meshId, {
            title: 'Status mission', goal: 'g', summary: 'one line state',
            itemsAdd: [{ kind: 'decision', question: 'Which?', options: [{ label: 'x' }] }, { kind: 'remaining', text: 'r' }],
        });
        const legacy = await call('mission_list_query', { v, meshId, meshStatusView: 'compact' });
        expect(legacy.success).toBe(true);
        expect(legacy.missions[0].summary).toBeUndefined();
        expect(legacy.missions[0].openItems).toBeUndefined();
        const structured = await call('mission_list_query', { v, meshId, meshStatusView: 'compact', structured: true });
        expect(structured.missions[0]).toMatchObject({ summary: 'one line state', openItems: { decision: 1, remaining: 1 } });
        expect(structured.missions[0].goalPreview).toBe('g');
    });
});

describe('router-internal args (live regression 2026-09-25: mesh_send_task → queue_query "bad shape")', () => {
    // The router stamps `_interactionId` onto every command's args before the
    // handler runs. The wire decoders are strict, so the SPEC (what the router
    // actually invokes) must strip it; the raw handler stays strict.
    it('the registered spec decodes a request carrying the router stamp; the raw handler does not', async () => {
        const byName = new Map(turnLedgerIpcSpecs.map((spec) => [spec.name, spec]));
        const spec = byName.get('queue_query');
        expect(spec).toBeDefined();
        const ctx = { deps: { statusInstanceId: 'daemon-test' } } as any;
        const stamped = { v, meshId, _interactionId: 'ix_test_stamp' };
        const viaSpec = await (spec!.run as any)(ctx, stamped);
        expect(viaSpec).toMatchObject({ success: true, entries: [] });
        const raw = await call('queue_query', stamped);
        expect(raw.success).toBe(false);
        expect(String(raw.error)).toContain('bad shape');
    });
});

describe('queue mutations carry THIS daemon\'s mesh role (requireMeshHostQueueOwner is live)', () => {
    // The router injects getMeshForCommand into every LOW context; the mesh
    // record's `meshHost.role` is this daemon's own membership (pairing writes 'member').
    function ctxAs(role: 'host' | 'member' | null) {
        return {
            deps: { statusInstanceId: 'daemon-test' },
            getMeshForCommand: async (id: string) => ({
                mesh: { id, nodes: [], ...(role ? { meshHost: { role, pairing: { status: role === 'member' ? 'paired' : 'not_configured' } } } : {}) },
                inline: false,
                source: 'local_config',
            }),
        };
    }
    async function callAs(role: 'host' | 'member' | null, command: string, args: Record<string, unknown>): Promise<any> {
        const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<unknown>>)[command];
        return handler(ctxAs(role), args);
    }
    const HOST_GUARD = /Mesh Host daemon required to mutate mesh queue/;

    it('★a member daemon\'s enqueue is refused; the host\'s (and a defaulted mesh\'s) is accepted', async () => {
        const member = await callAs('member', 'queue_enqueue', { v, meshId, message: 'on a member', options: { difficulty: 'easy' } });
        expect(member.success).toBe(false);
        expect(member.error).toMatch(HOST_GUARD);
        expect(getQueue(meshId)).toEqual([]);

        const host = await callAs('host', 'queue_enqueue', { v, meshId, message: 'on the host', options: { difficulty: 'easy' } });
        expect(host.success).toBe(true);
        const defaulted = await callAs(null, 'queue_enqueue', { v, meshId, message: 'no meshHost block', options: { difficulty: 'easy' } });
        expect(defaulted.success).toBe(true);
        expect(getQueue(meshId)).toHaveLength(2);
    });

    it('the role is never the caller\'s claim: options.ownerRole is replaced (resolved mesh) or dropped (unresolvable mesh)', async () => {
        const claimHost = await callAs('member', 'queue_enqueue', { v, meshId, message: 'x', options: { difficulty: 'easy', ownerRole: 'host' } });
        expect(claimHost.success).toBe(false);
        expect(claimHost.error).toMatch(HOST_GUARD);
        const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<any>>).queue_enqueue;
        const unresolved = await handler(
            { deps: { statusInstanceId: 'daemon-test' }, getMeshForCommand: async () => null },
            { v, meshId, message: 'y', options: { difficulty: 'easy', ownerRole: 'member' } },
        );
        expect(unresolved.success).toBe(true);
        expect(unresolved.entry).not.toHaveProperty('ownerRole');
    });

    it('cancel / requeue / batch enqueue are refused on a member daemon', async () => {
        const { entry } = await callAs('host', 'queue_enqueue', { v, meshId, message: 'hosted row', options: { difficulty: 'easy' } });
        const cancel = await callAs('member', 'queue_cancel', { v, meshId, taskId: entry.id, reason: 'x' });
        expect(cancel.success).toBe(false);
        expect(cancel.error).toMatch(HOST_GUARD);
        const requeue = await callAs('member', 'queue_requeue', { v, meshId, taskId: entry.id, options: { force: true } });
        expect(requeue.success).toBe(false);
        expect(requeue.error).toMatch(HOST_GUARD);
        expect(getQueue(meshId).map((t) => t.status)).toEqual(['pending']);

        const batch = await callAs('member', 'queue_enqueue_batch', { v, meshId, specs: [{ ref: 'a', message: 'first', difficulty: 'easy' }] });
        expect(batch).toMatchObject({ success: true, ok: false });
        expect(batch.message).toMatch(HOST_GUARD);
        expect(getQueue(meshId)).toHaveLength(1);

        // The host's cancel still works.
        const hostCancel = await callAs('host', 'queue_cancel', { v, meshId, taskId: entry.id, reason: 'x' });
        expect(hostCancel.task).toMatchObject({ status: 'cancelled' });
    });
});


describe('authenticated existing local node identity recovery', () => {
    async function fixture() {
        const { execFileSync } = await import('node:child_process');
        const actual = await vi.importActual<typeof import('../../src/config/mesh-config.js')>('../../src/config/mesh-config.js');
        const root = fs.mkdtempSync(path.join(tmpdir(), 'identity-recovery-'));
        const anchor = path.join(root, 'anchor'), target = path.join(root, 'target');
        fs.mkdirSync(anchor); fs.mkdirSync(testConfigDir, { recursive: true });
        const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { stdio: 'pipe' });
        git(anchor, 'init', '--initial-branch=main');
        fs.writeFileSync(path.join(anchor, 'file.ts'), 'export {};'); git(anchor, 'add', 'file.ts');
        git(anchor, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture');
        execFileSync('git', ['clone', '--no-hardlinks', anchor, target], { stdio: 'pipe' });
        for (const cwd of [anchor, target]) git(cwd, 'remote', ...(cwd === anchor ? ['add', 'origin'] : ['set-url', 'origin']), 'https://example.test/repo.git');
        const node = { id: 'existing', workspace: fs.realpathSync(target), policy: { readOnly: false }, capabilities: ['keep'] };
        const mesh = { id: meshId, repoIdentity: 'example.test/repo', meshHost: { role: 'host', hostDaemonId: 'daemon_mach_local' },
            nodes: [{ id: 'anchor', workspace: fs.realpathSync(anchor), daemonId: 'daemon_mach_local', machineId: 'mach_local', policy: {} }, node] };
        const configPath = path.join(testConfigDir, 'meshes.json');
        const save = () => fs.writeFileSync(configPath, JSON.stringify({ meshes: [mesh] })); save();
        const request = { v: 1 as const, expectedDaemonId: null, expectedMachineId: null, expectedWorkspace: node.workspace, dryRun: true };
        const host = { actor: 'daemon_mach_local', machineId: 'mach_local', refineryRunning: false };
        const repair = (r = request, h = host) => actual.recoverLocalNodeIdentity(meshId, node.id, r, h);
        return { root, target, anchor, node, mesh, configPath, save, request, host, repair, git };
    }
    it('previews without writes, applies exact receipt CAS and preserves node/task IDs, policy and audit', async () => {
        const f = await fixture();
        try {
            const pending = enqueueTask(meshId, 'Keep task history', { difficulty: 'medium', targetNodeId: 'existing' });
            const taskBefore = getQueueEntryById(meshId, pending.id);
            const before = fs.readFileSync(f.configPath, 'utf8');
            const preview = f.repair(); expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
            const applied = f.repair({ ...f.request, dryRun: false, expectedFingerprint: preview.receipt.fingerprint } as any);
            expect(applied.node).toMatchObject({ id: 'existing', daemonId: f.host.actor, machineId: f.host.machineId, policy: { readOnly: false }, capabilities: ['keep'] });
            expect(getQueueEntryById(meshId, pending.id)).toEqual(taskBefore);
            expect((applied.node as any).identityRecoveryHistory).toHaveLength(1);
            expect((applied.node as any).identityRecoveryHistory[0].previous).toEqual({ daemonId: null, machineId: null });
            expect(() => f.repair({ ...f.request, dryRun: false, expectedFingerprint: preview.receipt.fingerprint } as any)).toThrow(/stale_node_identity/);
        } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
    it('refuses foreign identities, wrong repository, stale workspace and fingerprint without writes', async () => {
        const f = await fixture();
        try {
            const before = fs.readFileSync(f.configPath, 'utf8');
            expect(() => f.repair({ ...f.request, expectedWorkspace: f.anchor })).toThrow(/stale_node_workspace/);
            expect(() => f.repair({ ...f.request, dryRun: false, expectedFingerprint: 'a'.repeat(64) } as any)).toThrow(/stale_node_identity_fingerprint/);
            expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
            Object.assign(f.node, { daemonId: 'daemon_mach_foreign' }); f.save();
            expect(() => f.repair({ ...f.request, expectedDaemonId: 'daemon_mach_foreign' } as any)).toThrow(/foreign_node_identity/);
            delete (f.node as any).daemonId; f.save();
            f.git(f.target, 'remote', 'set-url', 'origin', 'https://example.test/foreign.git');
            expect(() => f.repair()).toThrow(/local_repository_mismatch/);
        } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
    it('rejects ambiguous workspace aliases, writable resources, invalid authority and record changes after preview', async () => {
        const f = await fixture();
        try {
            expect(() => f.repair(f.request, { ...f.host, actor: 'daemon_mach_foreign' })).toThrow(/authenticated_local_mesh_host_required/);
            const preview = f.repair();
            const index = path.join(f.target, '.git', 'index');
            fs.renameSync(index, `${index}.old`); fs.copyFileSync(`${index}.old`, index);
            expect(() => f.repair({ ...f.request, dryRun: false, expectedFingerprint: preview.receipt.fingerprint } as any)).toThrow(/stale_node_identity_fingerprint/);
            const nextPreview = f.repair();
            f.node.capabilities.push('changed'); f.save();
            expect(() => f.repair({ ...f.request, dryRun: false, expectedFingerprint: nextPreview.receipt.fingerprint } as any)).toThrow(/stale_node_identity_fingerprint/);
            fs.chmodSync(f.target, 0o777);
            expect(() => f.repair()).toThrow(/local_resource_owner_unproven/);
            fs.chmodSync(f.target, 0o755);
            f.mesh.nodes.push({ ...f.node, id: 'duplicate' } as any); f.save();
            expect(() => f.repair()).toThrow(/ambiguous_node_workspace/);
        } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
    it('authenticated handler refuses denied callers and combined identity grants before repair', async () => {
        await import('../../src/commands/router.js'); // Enter through the normal registry root, not the cyclic leaf.
        const { meshNodeLifecycleHandlers } = await import('../../src/commands/med-family/mesh-node-lifecycle.js');
        const { meshCrudSpecs } = await import('../../src/commands/med-family/mesh-crud.js');
        expect(meshCrudSpecs.find(s => s.name === 'recover_mesh_node_identity')?.sources).toEqual(['ipc', 'standalone']);
        const mocked = await import('../../src/config/mesh-config.js');
        const repair = vi.mocked(mocked.recoverLocalNodeIdentity); repair.mockClear();
        const ctx = { requireMeshHostMutationOwner: vi.fn(async () => ({ success: false, error: 'owner_required' })) } as any;
        const args = { meshId, nodeId: 'existing', identityRecovery: { v: 1, dryRun: true } };
        expect(await meshNodeLifecycleHandlers.recover_mesh_node_identity(ctx, args)).toMatchObject({ success: false, error: 'owner_required' });
        ctx.requireMeshHostMutationOwner.mockResolvedValue(null);
        expect(await meshNodeLifecycleHandlers.recover_mesh_node_identity(ctx, { ...args, daemonId: 'spoof' })).toMatchObject({ success: false, error: 'invalid_node_identity_recovery_envelope' });
        expect(repair).not.toHaveBeenCalled();
    });
    it('refuses a real assigned queue claim without changing its task or identity', async () => {
        const f = await fixture();
        try {
            const pending = enqueueTask(meshId, 'Active writer', { difficulty: 'medium', targetNodeId: 'existing', ownedPaths: ['file.ts'] });
            const { MeshRuntimeStore } = await import('../../src/mesh/mesh-runtime-store.js');
            const store = MeshRuntimeStore.getInstance();
            expect(store.claimNextQueueTask(meshId, 'existing', 'writer', [], { providerType: 'codex-cli', assignedModel: 'gpt-5.4', allowedTaskDifficulties: ['medium'] })?.id).toBe(pending.id);
            const before = fs.readFileSync(f.configPath, 'utf8');
            expect(() => f.repair()).toThrow(/active_claims/);
            expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
            expect(getQueueEntryById(meshId, pending.id)?.status).toBe('assigned');
        } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
    it('refuses active claims, direct attempts and unsettled Refinery but ignores unrelated mesh work', async () => {
        const f = await fixture();
        try {
            expect(() => f.repair(f.request, { ...f.host, refineryRunning: true })).toThrow(/refinery_active/);
            seedLocalRecord(meshId, { kind: 'task_dispatched', nodeId: 'existing', payload: { source: 'refine_mesh_node_async_job', refineJob: { jobId: 'job' } } });
            expect(() => f.repair()).toThrow(/refinery_active/);
            seedLocalRecord(meshId, { kind: 'task_completed', nodeId: 'existing', payload: { refineJob: { jobId: 'job' } } });
            seedMeshAttempt({ meshId: 'unrelated', taskId: 'other', sessionId: 'other', stage: 'generating' });
            expect(f.repair().dryRun).toBe(true);
            seedMeshAttempt({ meshId, taskId: 'active', sessionId: 'active', stage: 'generating' });
            expect(() => f.repair()).toThrow(/active_claims/);
        } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
});
