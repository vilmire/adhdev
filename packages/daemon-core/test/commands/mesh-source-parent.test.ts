import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const sandbox = vi.hoisted(() => {
    const fs = require('node:fs');
    const dir = fs.realpathSync(fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'source-parent-')));
    process.env.HOME = dir;
    process.env.ADHDEV_CONFIG_DIR = require('node:path').join(dir, 'config');
    fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR);
    return dir;
});
import { refineResolveRefsStage } from '../../src/commands/router-refine-sync-stages.js';
import { reattachMeshSourceParent } from '../../src/commands/med-family/mesh-source-parent.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import * as registry from '../../src/config/mesh-config-store.js';
import { getMeshConfigPath, readMeshConfigFromDisk } from '../../src/config/mesh-config-store.js';
import { warmInlineMeshCache, getMeshForCommand } from '../../src/commands/router-inline-mesh-roster.js';
import type { MedFamilyContext } from '../../src/commands/med-family/types.js';
const main = join(sandbox, 'main');
const worktree = join(sandbox, 'candidate');
function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}
mkdirSync(main);
git(main, 'init', '-q', '-b', 'main');
git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Initial');
git(main, 'remote', 'add', 'origin', 'https://example.test/org/repo.git');
git(main, 'worktree', 'add', '-qb', 'candidate', worktree);
let mesh: any;
let router: any;
let ctx: MedFamilyContext;
const args = { meshId: 'mesh_fixture', nodeId: 'node_candidate', parentNodeId: 'node_main', expectedOldParentId: 'node_missing', write: true };
function persist() { writeFileSync(getMeshConfigPath(), JSON.stringify({ meshes: [mesh] })); }
function binding() { return readMeshConfigFromDisk()!.meshes[0].nodes[1].clonedFromNodeId; }
function run(overrides = {}) { return reattachMeshSourceParent(ctx, { ...args, ...overrides }); }
beforeEach(() => {
    vi.restoreAllMocks();
    MeshRuntimeStore.resetForTests();
    MeshRuntimeStore.getInstance().deleteQueue(args.meshId);
    mesh = { id: args.meshId, repoIdentity: 'example.test/org/repo', defaultBranch: 'main', policy: { requireApprovalForPush: true },
        meshHost: { role: 'host', hostDaemonId: 'mach_fixture' }, nodes: [
            { id: 'node_main', workspace: main, daemonId: 'mach_fixture' },
            { id: 'node_candidate', workspace: worktree, repoRoot: worktree, daemonId: 'mach_fixture', isLocalWorktree: true, clonedFromNodeId: 'node_missing',
                policy: { slots: [] }, worktreeBootstrap: { status: 'failed', exitCode: 254 } } ] };
    persist();
    router = { inlineMeshCache: new Map([[mesh.id, structuredClone(mesh)]]), runningRefineJobs: new Map(), runningRefineBatchJobs: new Map(), refineBaseLeases: new Map() };
    ctx = { deps: { statusInstanceId: 'mach_fixture' }, components: () => ({ router }),
        requireMeshHostMutationOwner: vi.fn(async () => null), getMeshForCommand: vi.fn(async () => ({ mesh: router.inlineMeshCache.get(mesh.id), inline: true })),
        getCachedInlineMesh: () => router.inlineMeshCache.get(mesh.id), invalidateAggregateMeshStatus: vi.fn() } as any;
});
afterAll(() => { MeshRuntimeStore.resetForTests(); rmSync(sandbox, { recursive: true, force: true }); });
describe('source parent owner repair', () => {
    it('names the missing explicit parent before Git or publication gates', async () => {
        const result = await refineResolveRefsStage({ getMeshForCommand: async () => ({ mesh }) } as any, mesh.id, args.nodeId, {}, []);
        expect(result).toMatchObject({ kind: 'terminal', result: { code: 'source_parent_not_found', sourceNodeId: 'node_missing', refineStages: [] } });
    });
    it('dry-runs, durably repairs and preserves identity, receipts, queue and refs', async () => {
        const original = structuredClone(mesh), head = git(worktree, 'rev-parse', 'HEAD');
        const bytes = readFileSync(getMeshConfigPath(), 'utf8');
        expect(await run({ write: false })).toMatchObject({ success: true, dryRun: true });
        expect(readFileSync(getMeshConfigPath(), 'utf8')).toBe(bytes);
        const now = new Date().toISOString();
        MeshRuntimeStore.getInstance().insertQueueEntry({ id: 'task_preserved', meshId: mesh.id, status: 'pending', targetNodeId: args.nodeId,
            task: 'Original queue instruction', createdAt: now, updatedAt: now, policy: { keep: true } } as any);
        const queue = MeshRuntimeStore.getInstance().getQueueEntries(mesh.id);
        expect(await run()).toMatchObject({ success: true, durable: true, changed: true });
        expect(binding()).toBe('node_main');
        const saved = readMeshConfigFromDisk()!.meshes[0] as any;
        delete saved.nodes[1].sourceParentReattachment; saved.nodes[1].clonedFromNodeId = 'node_missing';
        expect(saved).toEqual(original);
        expect(router.inlineMeshCache.get(mesh.id).nodes[1].clonedFromNodeId).toBe('node_main');
        expect(MeshRuntimeStore.getInstance().getQueueEntries(mesh.id)).toEqual(queue);
        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(worktree, 'branch', '--show-current')).toBe('candidate');
        expect(await run()).toMatchObject({ success: true, changed: false });
        expect(await run({ expectedOldParentId: 'node_unrelated' })).toMatchObject({ code: 'source_parent_cas_conflict' });
    });
    it('rejects CAS races during async resolution', async () => {
        (ctx.getMeshForCommand as any).mockImplementationOnce(async () => { mesh.nodes[1].clonedFromNodeId = 'node_raced'; persist(); });
        expect(await run()).toMatchObject({ code: 'source_parent_cas_conflict' });
        expect(binding()).toBe('node_raced');
    });
    it('serializes concurrent identical CAS requests into one write', async () => {
        const results = await Promise.all([run(), run()]);
        expect(results.filter(r => r.changed)).toHaveLength(1);
        expect(results.every(r => r.success)).toBe(true);
    });
    it.each([
        ['remote daemon', (m: any) => { m.nodes[0].daemonId = 'mach_other'; }, 'source_parent_remote_owner'],
        ['target remote daemon', (m: any) => { m.nodes[1].daemonId = 'mach_other'; }, 'source_parent_remote_owner'],
        ['wrong default branch', (m: any) => { m.defaultBranch = 'trunk'; }, 'source_parent_wrong_default_branch'],
        ['cycle', (m: any) => { m.nodes[0].clonedFromNodeId = 'node_candidate'; }, 'source_parent_cycle_or_not_base'],
        ['repo identity', (m: any) => { m.repoIdentity = 'example.test/other/repo'; }, 'source_parent_repo_identity_mismatch'],
        ['existing parent', (m: any) => { m.nodes.push({ id: 'node_missing' }); }, 'source_parent_existing_binding'],
        ['host ownership', (m: any) => { m.meshHost.role = 'member'; }, 'source_parent_host_ownership_changed'],
        ['self', (_m: any) => {}, 'source_parent_cycle'],
    ])('rejects %s', async (label, change, code) => {
        change(mesh); persist(); router.inlineMeshCache.set(mesh.id, structuredClone(mesh));
        expect(await run(label === 'self' ? { parentNodeId: args.nodeId } : {})).toMatchObject({ success: false, code });
        expect(binding()).toBe('node_missing');
    });
    it('rejects a different Git common-dir with the same repository identity', async () => {
        const other = join(sandbox, 'other'); mkdirSync(other, { recursive: true }); git(other, 'init', '-q', '-b', 'main');
        mesh.nodes[0].workspace = other; persist(); router.inlineMeshCache.get(mesh.id).nodes[0].workspace = other;
        expect(await run()).toMatchObject({ code: 'source_parent_cross_repo' });
    });
    it('rejects a symlink workspace escape', async () => {
        const alias = join(sandbox, 'alias'); symlinkSync(worktree, alias);
        mesh.nodes[1].workspace = alias; mesh.nodes[1].repoRoot = alias; persist();
        router.inlineMeshCache.get(mesh.id).nodes[1] = structuredClone(mesh.nodes[1]);
        expect(await run()).toMatchObject({ code: 'source_parent_untrusted_path' });
    });
    it('fails closed on a registry writer lock', async () => {
        const lock = `${getMeshConfigPath()}.lock`; mkdirSync(lock);
        try { expect(await run()).toMatchObject({ success: false }); expect(binding()).toBe('node_missing'); }
        finally { rmSync(lock, { recursive: true }); }
    });
    it('does not commit when cache invalidation fails', async () => {
        (ctx.invalidateAggregateMeshStatus as any).mockImplementation(() => { throw new Error('unavailable'); });
        expect(await run()).toMatchObject({ success: false }); expect(binding()).toBe('node_missing');
        expect(router.inlineMeshCache.get(mesh.id).nodes[1].clonedFromNodeId).toBe('node_missing');
    });
    it('does not publish a failed atomic registry write', async () => {
        vi.spyOn(registry, 'saveMeshConfigDurable').mockReturnValueOnce({ ok: false, committed: false, reason: 'atomic_replace_failed' });
        expect(await run()).toMatchObject({ success: false, code: 'source_parent_persistence_failed' });
        expect(binding()).toBe('node_missing');
        expect(router.inlineMeshCache.get(mesh.id).nodes[1].clonedFromNodeId).toBe('node_missing');
    });
    it('reports committed-but-unconfirmed durability with matching cache truth', async () => {
        const save = registry.saveMeshConfigDurable;
        vi.spyOn(registry, 'saveMeshConfigDurable').mockImplementationOnce(config => {
            expect(save(config).ok).toBe(true);
            return { ok: false, committed: true, reason: 'durability_unconfirmed' };
        });
        expect(await run()).toMatchObject({ success: false, changed: true, code: 'source_parent_durability_unconfirmed' });
        expect(binding()).toBe('node_main');
        expect(router.inlineMeshCache.get(mesh.id).nodes[1].clonedFromNodeId).toBe('node_main');
    });
    it('accepts the same effective base root when inline discovery filled repoRoot', async () => {
        router.inlineMeshCache.get(mesh.id).nodes[0].repoRoot = main;
        expect(await run()).toMatchObject({ success: true, changed: true });
    });
    it('refuses a conflicting cached source root', async () => {
        router.inlineMeshCache.get(mesh.id).nodes[0].repoRoot = worktree;
        expect(await run()).toMatchObject({ code: 'source_parent_cache_conflict' });
    });
    it('rejects a conflicting cached binding', async () => {
        router.inlineMeshCache.get(mesh.id).nodes[1].clonedFromNodeId = 'node_raced';
        expect(await run()).toMatchObject({ code: 'source_parent_cache_conflict' });
    });
    it('keeps a durable repair across restart and stale inline replay', async () => {
        const stale = structuredClone(mesh); expect((await run()).success).toBe(true); router.inlineMeshCache.clear();
        const host = { ...router, deps: {}, invalidateAggregateMeshStatus: vi.fn(), meshPolicyDiskSync: { checkedAtMs: 0, mtimeMs: -1 }, removedInlineMeshNodeIds: new Map() };
        expect(warmInlineMeshCache(host as any, mesh.id, stale).nodes[1].clonedFromNodeId).toBe('node_main');
        expect((await getMeshForCommand(host as any, mesh.id, structuredClone(mesh)))!.mesh.nodes[1].clonedFromNodeId).toBe('node_main');
    });
    it.each(['assigned', 'reservation'])('rejects an active %s lease without altering the queue', async kind => {
        const store = MeshRuntimeStore.getInstance();
        const now = new Date().toISOString();
        store.insertQueueEntry({ id: 'task_fixture', meshId: mesh.id, status: kind === 'assigned' ? 'assigned' : 'pending',
            assignedNodeId: kind === 'assigned' ? args.nodeId : undefined, assignedSessionId: 'session_fixture',
            createdAt: now, updatedAt: now, task: 'Preserved task',
            ...(kind === 'reservation' ? { autoLaunch: { nodeId: args.nodeId, providerType: 'codex', status: 'started', updatedAt: now } } : {}),
        } as any);
        const before = store.getQueueEntries(mesh.id);
        expect(await run()).toMatchObject({ code: 'source_parent_active_lease' });
        expect(store.getQueueEntries(mesh.id)).toEqual(before);
        expect(binding()).toBe('node_missing');
    });
    it('enforces authorization before reading or changing registry state', async () => {
        (ctx.requireMeshHostMutationOwner as any).mockResolvedValue({ success: false, code: 'mesh_host_required' });
        expect(await run()).toMatchObject({ code: 'mesh_host_required' });
        expect(ctx.getMeshForCommand).not.toHaveBeenCalled();
        expect(binding()).toBe('node_missing');
    });
    it('refuses replay if the repaired durable registry becomes unreadable', async () => {
        expect((await run()).success).toBe(true);
        writeFileSync(getMeshConfigPath(), '{incomplete');
        const host = { ...router, deps: {}, invalidateAggregateMeshStatus: vi.fn(), meshPolicyDiskSync: { checkedAtMs: 0, mtimeMs: -1 }, removedInlineMeshNodeIds: new Map() };
        expect(() => warmInlineMeshCache(host as any, mesh.id, structuredClone(mesh))).toThrow('source_parent_registry_unavailable');
        expect(router.inlineMeshCache.get(mesh.id).nodes[1].clonedFromNodeId).toBe('node_main');
    });
    it.each(['runningRefineJobs', 'runningRefineBatchJobs', 'refineBaseLeases'])('rejects active %s', async key => {
        router[key].set(key === 'runningRefineBatchJobs' ? mesh.id : `${mesh.id}:node_other`, {});
        expect(await run()).toMatchObject({ code: 'source_parent_refinery_active' });
    });
});
