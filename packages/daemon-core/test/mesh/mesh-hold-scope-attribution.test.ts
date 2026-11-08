import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config/config.js', () => ({ getConfigDir: () => '/nonexistent', getMachineId: () => 'this-machine', loadConfig: () => ({ machineId: 'this-machine' }) }));
import '../../src/mesh/mesh-runtime-store.js';
import { evaluateTaskOwnedPathsAdmission } from '../../src/mesh/mesh-runtime-store-claim.js';
import { queueHoldContext } from '../../src/mesh/mesh-queue-hold.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue-types.js';

const decl = (p: string) => ({ paths: [{ path: p, subtree: false }] });
// An attested writer in its OWN worktree on another machine (this host cannot re-read that disk, so the stored scope stands).
const lightScope = (p: string, machineId = 'other-machine') => ({
    version: 1 as const, repoIdentity: 'repo', machineId, nodeId: 'n1', worktree: '/lw/c05f97b1/c8b231ee', worktreeIdentity: '1:2', gitDir: '/lw/g', commonGitDir: '/base/.git',
    gitResources: { index: '/lw/g/index', refs: '/base/.git/refs', hooks: '/base/.git/hooks', config: '/base/.git/config' },
    phase: 'source' as const, resources: [{ path: `/lw/c05f97b1/c8b231ee/${p}`, subtree: false }], declaration: decl(p).paths,
});
const writer = (extra: Partial<MeshWorkQueueEntry> = {}): MeshWorkQueueEntry => ({
    id: 'c8b231ee', meshId: 'm', message: 'light write', status: 'assigned', taskMode: 'code_change', light: true, lightWorkspaceId: 'c05f97b1',
    ownedPaths: decl('prefex-core/src/runtime.rs'), ownershipScope: lightScope('prefex-core/src/runtime.rs'), origin: 'coordinator', createdAt: '', updatedAt: '', ...extra,
} as MeshWorkQueueEntry);
const candidate = (p: string): MeshWorkQueueEntry => ({
    id: '81ff5c9c', meshId: 'm', message: 'probe', status: 'pending', taskMode: 'code_change', ownedPaths: decl(p), origin: 'coordinator', createdAt: '', updatedAt: '',
} as MeshWorkQueueEntry);
const sharedWriter = (extra: Partial<MeshWorkQueueEntry> = {}) => writer({ light: undefined, lightWorkspaceId: undefined, ...extra });
const host = (rows: MeshWorkQueueEntry[]) => ({ assignedRowsMeshWide: () => rows.map(r => ({ payload: JSON.stringify(r) })) }) as any;

describe('hold/admission attribution for a scoped writer in its own worktree (live 2026-11-07)', () => {
    it('does not hold an unattested task with disjoint paths behind a writer attested in its own worktree', () => {
        const r = evaluateTaskOwnedPathsAdmission(host([writer()]), 'm', candidate('docs/evidence/probe.md'));
        expect(r).toEqual({ allowed: true, conflicts: [] });
    });
    it('does not hold even a logically overlapping path behind a light writer: it works in its own private worktree', () => {
        const r = evaluateTaskOwnedPathsAdmission(host([writer()]), 'm', candidate('prefex-core/src/runtime.rs'));
        expect(r).toEqual({ allowed: true, conflicts: [] });
    });
    it('names the held task, not the blocker, when the held task is the one without a scope', () => {
        const ctx = queueHoldContext(candidate('docs/evidence/probe.md'), 'owned_paths_conflict', [sharedWriter()]);
        expect(ctx.detail.unknownField).toBe('ownershipScope');
        expect(ctx.detail.resolution).toMatch(/^this task has no host-attested ownershipScope/);
        expect(ctx.detail.resolution).not.toMatch(/attestActiveOwnership/);
    });
    it('says the blocker scope cannot be re-verified when it has one (not that it has none)', () => {
        const local = sharedWriter({ ownershipScope: lightScope('prefex-core/src/runtime.rs', 'this-machine') }); // worktree path does not exist here
        const held = { ...candidate('docs/evidence/probe.md'), ownershipScope: lightScope('docs/evidence/probe.md', 'other-machine') } as MeshWorkQueueEntry;
        const ctx = queueHoldContext(held, 'owned_paths_conflict', [local]);
        expect(ctx.detail.resolution).toMatch(/can no longer re-verify it/);
        expect(ctx.detail.resolution).not.toMatch(/has no host-attested/);
    });
    it('hold context never names a light writer (private worktree) as a blocker, overlapping path or not', () => {
        const none = queueHoldContext(candidate('docs/evidence/probe.md'), 'owned_paths_conflict', [writer()]);
        expect(none.blockingTaskIds).toEqual([]);
        const hit = queueHoldContext(candidate('prefex-core/src/runtime.rs'), 'owned_paths_conflict', [writer()]);
        expect(hit.blockingTaskIds).toEqual([]);
    });
    it('keeps the physical check against a scoped writer in a shared (non-light) checkout', () => {
        const shared = writer({ light: undefined, lightWorkspaceId: undefined });
        const r = evaluateTaskOwnedPathsAdmission(host([shared]), 'm', candidate('docs/evidence/probe.md'));
        expect(r.allowed).toBe(false);
        const ctx = queueHoldContext(candidate('docs/evidence/probe.md'), 'owned_paths_conflict', [shared]);
        expect(ctx.blockingTaskIds).toEqual(['c8b231ee']);
    });
});

// Path-ownership gate is opt-in (default 'off'); this suite pins the legacy mesh-wide fence.
import { setPathOwnershipGateForTests as __setGate } from '../../src/mesh/mesh-path-ownership-gate.js'
import { beforeEach as __gateBefore, afterEach as __gateAfter } from 'vitest'
__gateBefore(() => __setGate('mesh_wide'))
__gateAfter(() => __setGate(undefined))
