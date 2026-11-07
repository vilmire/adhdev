/**
 * Mission 3347bee5 — an assigned writer without a host-attested scope is an unknown
 * physical writer and holds every other write task. The CAS path attaches the proof
 * without stopping it; isolated work then runs in parallel, shared paths stay blocked,
 * and every unproven shape stays fail-closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ dir: '', mesh: undefined as any, trigger: vi.fn(async () => ({})), sessions: new Map<string, string>() }));
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => state.dir, getMachineId: () => 'host-machine', loadConfig: () => ({ machineId: 'host-machine' }) }));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: () => state.mesh, getMeshByRepo: () => undefined, listMeshes: () => [] }));
vi.mock('../../src/mesh/mesh-queue-assignment.js', async original => ({ ...await original<any>(), triggerMeshQueue: state.trigger }));
import { TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, getQueueEntryById, recordDirectDispatchTask, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { attestActiveTaskOwnership } from '../../src/mesh/mesh-active-ownership.js';
import { decodeQueueReviseRequest } from '@adhdev/mesh-shared';

const meshId = 'active-own-mesh';
const claim = { providerType: 'codex-cli', assignedModel: 'gpt-5.4', allowedTaskDifficulties: ['medium', 'difficult'] as const };
let wsA: string; let wsB: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const row = (id: string) => getQueueEntryById(meshId, id)!;
const proof = (workspace: string) => ({ workspace, machineId: 'host-machine', repoIdentity: 'repo' });
const ctx = () => ({ deps: { statusInstanceId: 'daemon-host', instanceManager: { getInstance: (sid: string) => state.sessions.has(sid) ? { workingDir: state.sessions.get(sid) } : undefined } }, components: () => ({}) }) as any;
const host = (over: Record<string, unknown> = {}) => ({ actor: 'daemon-host', repoIdentity: 'repo', machineId: 'host-machine', nodeId: 'node-a', workspace: wsA, sessionWorkspace: wsA, ...over });
/** An active writer with declared paths but no scope: a legacy / unattested direct dispatch. */
function unscopedWriter(id = 'running', ownedPaths: string[] | null = ['src/**']) {
    recordDirectDispatchTask(meshId, 'Running work', { id, difficulty: 'medium', assignedNodeId: 'node-a', assignedSessionId: 'sess-a', ...(ownedPaths ? { ownedPaths } : {}) } as any);
    state.sessions.set('sess-a', wsA);
    return row(id);
}
const pending = (message: string, targetNodeId: string, ownedPaths: string[] | undefined) => enqueueTask(meshId, message, { difficulty: 'medium', targetNodeId, ...(ownedPaths ? { ownedPaths } : {}) });
const tryClaim = (nodeId: string, sessionId: string, workspace: string) =>
    MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, nodeId, sessionId, [], { ...claim, physicalContext: proof(workspace) });

beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'active-own-')); __resetMeshRuntimeStoreForTests(); state.sessions.clear(); state.trigger.mockClear();
    wsA = join(state.dir, 'a'); mkdirSync(wsA); wsB = join(state.dir, 'b');
    git(wsA, 'init', '-q', '-b', 'main'); mkdirSync(join(wsA, 'src')); writeFileSync(join(wsA, 'src', 'a.ts'), 'export {};'); writeFileSync(join(wsA, 'src', 'b.ts'), 'export {};');
    git(wsA, 'add', '.'); git(wsA, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'F');
    git(wsA, 'worktree', 'add', '-q', '-b', 'second', wsB);
    state.mesh = { id: meshId, repoIdentity: 'repo', meshHost: { role: 'host', hostDaemonId: 'daemon-host' }, nodes: [
        { id: 'node-a', daemonId: 'daemon-host', workspace: wsA }, { id: 'node-b', daemonId: 'daemon-host', workspace: wsB },
    ] };
});
afterEach(() => { __resetMeshRuntimeStoreForTests(); rmSync(state.dir, { recursive: true, force: true }); });

describe('attach the missing scope to a running writer', () => {
    it('before: the unscoped writer blocks isolated work and the hold says how to fix it; after: the isolated task runs, a shared path stays blocked', () => {
        const running = unscopedWriter();
        const isolated = pending('Isolated work in the other worktree', 'node-b', ['src/b.ts']);
        const shared = pending('Same checkout, same subtree', 'node-a', ['src/a.ts']);
        // BEFORE (measured): of 2 runnable-looking tasks, 0 can start.
        expect(tryClaim('node-b', 'sess-b', wsB)).toBeNull();
        expect(tryClaim('node-a', 'sess-a2', wsA)).toBeNull();
        const hold = row(isolated.id).hold!;
        expect(hold.blockingTaskIds).toEqual([running.id]);
        expect(hold.detail.unknownField).toBe('ownershipScope');
        expect(hold.detail.resolution).toContain('attestActiveOwnership');
        expect(hold.detail.resolution).toContain(running.id);

        const attested = attestActiveTaskOwnership(meshId, running.id, running.revision ?? 0, host());
        expect(attested.ownershipScope?.worktree).toContain('/a');
        expect(attested.revision).toBe((running.revision ?? 0) + 1);
        expect(attested.status).toBe('assigned');
        expect(attested.assignedSessionId).toBe('sess-a');
        expect(attested.revisionHistory?.at(-1)).toMatchObject({ actor: 'daemon-host', revision: running.revision ?? 0 });

        // AFTER (measured): the isolated task starts; the colliding one is still blocked.
        expect(tryClaim('node-b', 'sess-b', wsB)?.id).toBe(isolated.id);
        expect(tryClaim('node-a', 'sess-a2', wsA)).toBeNull();
        expect(row(shared.id).status).toBe('pending');
        // Same node: the per-node busy gate names the running task.
        expect(row(shared.id).hold).toMatchObject({ blockingTaskIds: [running.id] });
        // Another node entry for the same physical checkout: the ownership gate names the colliding path.
        symlinkSync(wsA, join(state.dir, 'alias'));
        state.mesh.nodes.push({ id: 'node-alias', daemonId: 'daemon-host', workspace: join(state.dir, 'alias') });
        const aliased = pending('Same checkout through another node entry', 'node-alias', ['src/a.ts']);
        expect(tryClaim('node-alias', 'sess-alias', join(state.dir, 'alias'))).toBeNull();
        const aliasHold = row(aliased.id).hold!;
        expect(aliasHold).toMatchObject({ reason: 'owned_paths_conflict', blockingTaskIds: [running.id] });
        expect(aliasHold.detail.overlappingPaths?.[0]).toMatchObject({ taskId: running.id, ownedPath: 'src/a.ts' });
    });

    it('survives a daemon restart: the scope is persisted and still fences the shared checkout', () => {
        const running = unscopedWriter();
        attestActiveTaskOwnership(meshId, running.id, running.revision ?? 0, host());
        pending('Shared', 'node-a', ['src/a.ts']);
        __resetMeshRuntimeStoreForTests();
        expect(row(running.id).ownershipScope).toBeDefined();
        expect(tryClaim('node-a', 'sess-a2', wsA)).toBeNull();
        pending('Isolated', 'node-b', ['src/b.ts']);
        expect(tryClaim('node-b', 'sess-b', wsB)).not.toBeNull();
    });

    it('refuses a stale revision and never replaces an existing scope (update race)', () => {
        const running = unscopedWriter();
        const first = attestActiveTaskOwnership(meshId, running.id, running.revision ?? 0, host());
        expect(() => attestActiveTaskOwnership(meshId, running.id, running.revision ?? 0, host())).toThrow(/stale_revision/);
        expect(() => attestActiveTaskOwnership(meshId, running.id, first.revision ?? 0, host())).toThrow(/ownership_already_attested/);
        expect(row(running.id).ownershipScope).toEqual(first.ownershipScope);
        // A concurrent edit that bumps the revision first wins; the late attest changes nothing.
        const second = unscopedWriter('second', ['src/b.ts']);
        const bumped = row(second.id); MeshRuntimeStore.getInstance().updateQueueEntry(bumped);
        expect(() => attestActiveTaskOwnership(meshId, second.id, second.revision ?? 0, host())).toThrow(/stale_revision/);
        expect(row(second.id).ownershipScope).toBeUndefined();
    });

    it('stays fail-closed for unknown shapes: undeclared paths, wrong session checkout, remote or unpinned node, pending or readonly rows', () => {
        const undeclared = unscopedWriter('undeclared', null);
        expect(() => attestActiveTaskOwnership(meshId, undeclared.id, undeclared.revision ?? 0, host())).toThrow(/ownedpaths_undeclared/);
        expect(row(undeclared.id).ownershipScope).toBeUndefined();
        // Session restarted into a different worktree: the roster checkout must not be attested for it.
        const moved = unscopedWriter('moved');
        expect(() => attestActiveTaskOwnership(meshId, moved.id, moved.revision ?? 0, host({ sessionWorkspace: wsB }))).toThrow(/active_workspace_unproven/);
        expect(() => attestActiveTaskOwnership(meshId, moved.id, moved.revision ?? 0, host({ sessionWorkspace: undefined }))).toThrow(/active_workspace_unproven/);
        expect(() => attestActiveTaskOwnership(meshId, moved.id, moved.revision ?? 0, host({ nodeId: 'node-b', workspace: wsB, sessionWorkspace: wsB }))).toThrow(/local_pinned_physical_context_required/);
        expect(() => attestActiveTaskOwnership(meshId, moved.id, moved.revision ?? 0, host({ nodeId: undefined, workspace: undefined }))).toThrow(/local_pinned_physical_context_required/);
        expect(() => attestActiveTaskOwnership(meshId, moved.id, moved.revision ?? 0, host({ actor: '' }))).toThrow(/authenticated_host_required/);
        const queued = pending('Queued', 'node-a', ['src/a.ts']);
        expect(() => attestActiveTaskOwnership(meshId, queued.id, 0, host())).toThrow(/assigned_required/);
        expect(() => attestActiveTaskOwnership(meshId, 'absent', 0, host())).toThrow(/task_not_found/);
        // None of the refusals attached anything, so isolated work is still blocked.
        pending('Isolated', 'node-b', ['src/b.ts']);
        expect(tryClaim('node-b', 'sess-b', wsB)).toBeNull();
    });

    it('is reachable from the host handler, which reads the live session checkout, and reschedules', async () => {
        const running = unscopedWriter();
        const call = (patch: object, expectedRevision = running.revision ?? 0) => meshStoreIpcHandlers.queue_revise(ctx(), { v: TURN_IPC_PROTOCOL_VERSION, meshId, taskId: running.id, expectedRevision, patch }) as Promise<any>;
        state.sessions.set('sess-a', wsB);
        expect(await call({ attestActiveOwnership: true })).toMatchObject({ success: false });
        expect(row(running.id).ownershipScope).toBeUndefined();
        state.sessions.set('sess-a', wsA);
        const ok = await call({ attestActiveOwnership: true });
        expect(ok).toMatchObject({ success: true });
        expect(row(running.id).ownershipScope).toBeDefined();
        expect(state.trigger).toHaveBeenCalled();
        expect(await call({ attestActiveOwnership: true }, ok.task.revision)).toMatchObject({ success: false });
    });

    it('a dry-run attest, built exactly as the MCP tool builds it, validates every gate and saves nothing', async () => {
        const running = unscopedWriter();
        state.sessions.set('sess-a', wsA);
        // Same construction as mcp-server meshQueueRevise → queueRevise → dispatch (v + camelCase fields, dry_run → dryRun).
        const args = { task_id: running.id, expected_revision: running.revision ?? 0, patch: { attestActiveOwnership: true as const }, dry_run: true };
        const wire = { v: TURN_IPC_PROTOCOL_VERSION, meshId, taskId: args.task_id, expectedRevision: args.expected_revision, patch: args.patch, ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}) };
        const dry = await meshStoreIpcHandlers.queue_revise(ctx(), wire) as any;
        expect(dry).toMatchObject({ success: true });
        expect(dry.task.ownershipScope).toBeDefined();
        expect(row(running.id).ownershipScope).toBeUndefined();
        expect(row(running.id).revision ?? 0).toBe(running.revision ?? 0);
        state.trigger.mockClear();
        const real = await meshStoreIpcHandlers.queue_revise(ctx(), { ...wire, dryRun: false }) as any;
        expect(real).toMatchObject({ success: true });
        expect(row(running.id).ownershipScope).toBeDefined();
        expect(state.trigger).toHaveBeenCalled();
    });

    it('wire decoding accepts the attest patch only alone', () => {
        const base = { v: TURN_IPC_PROTOCOL_VERSION, meshId, taskId: 't', expectedRevision: 1 };
        expect(decodeQueueReviseRequest({ ...base, patch: { attestActiveOwnership: true } })).not.toBeNull();
        expect(decodeQueueReviseRequest({ ...base, patch: { attestActiveOwnership: true, message: 'x' } })).toBeNull();
        // The hold text recommends a dry run first: it must decode (live 2026-11-07 "request failed decode (bad shape)").
        expect(decodeQueueReviseRequest({ ...base, dryRun: true, patch: { attestActiveOwnership: true } })).not.toBeNull();
        expect(decodeQueueReviseRequest({ ...base, dryRun: false, patch: { attestActiveOwnership: true } })).not.toBeNull();
        expect(decodeQueueReviseRequest({ ...base, deferScheduling: true, patch: { attestActiveOwnership: true } })).toBeNull();
        expect(decodeQueueReviseRequest({ ...base, dryRun: 'true', patch: { attestActiveOwnership: true } })).toBeNull();
        expect(decodeQueueReviseRequest({ ...base, patch: { attestActiveOwnership: false } })).toBeNull();
    });
});

describe('hold explanations for missing ownership information', () => {
    it('a write task with no owned_paths says what to declare instead of an unexplained hold', () => {
        const writer = unscopedWriter();
        attestActiveTaskOwnership(meshId, writer.id, writer.revision ?? 0, host());
        const undeclared = pending('No declaration', 'node-b', undefined);
        expect(tryClaim('node-b', 'sess-b', wsB)).toBeNull();
        const hold = row(undeclared.id).hold!;
        expect(hold.reason).toBe('ownership_unproven');
        expect(hold.detail.unknownField).toBe('ownedPaths');
        expect(hold.detail.resolution).toMatch(/owned_paths/);
        expect(hold.detail.resolution).toContain('mesh_queue_revise');
    });
});
