import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// WORKSPACE-SAGA-BOOTSTRAP regression suite.
//
// The defect: worktrees created by `mesh_clone_node` ran the repo's
// `.adhdev/worktree_bootstrap` commands, but worktrees created by the batch
// `workspaces` / `workspace_ref` preparation saga did NOT. Live evidence
// (daemon log, 2026-09-02): five `worktree_bootstrap_complete` events, all from
// clone; ZERO for the four saga-prepared worktrees, whose logs go straight from
// worktree creation to `[WorkerMcp] config written` → `[CLI] Spawning`.
//
// The two paths are:
//   clone — commands/med-family/mesh-crud.ts `clone_mesh_node`
//           → createWorktree, then submodule init + runMeshWorktreeBootstrap
//   saga  — mesh/mesh-graph-workspace-ports.ts `defaultCreateWorktree`
//           → createWorktree + owner tag, and (pre-fix) nothing else
//
// These tests assert the fix on the saga side, the ORDER (bootstrap finishes
// before the worktree is published/finalized, i.e. before any worker launch),
// that `required: true` is no longer silent, and — the guard that protects the
// rest — that the clone path is unchanged and does not double-run.

const testTmpDir = path.join(tmpdir(), `adhdev-gws-bootstrap-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
const realGitRoots: string[] = [];

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
}));

const meshConfigMocks = vi.hoisted(() => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    addNode: vi.fn(),
    updateNode: vi.fn(),
    removeNode: vi.fn(),
    migrateProviderRolesToSlots: vi.fn(),
}));
vi.mock('../../src/config/mesh-config.js', () => meshConfigMocks);

import {
    createDefaultWorkspaceSagaPorts,
    type WorkspaceSagaPorts,
} from '../../src/mesh/mesh-graph-workspace-ports.js';
import { deriveWorkspaceOwnerTag } from '../../src/mesh/mesh-graph-workspace-identity.js';
import { declareWorkspaceIntents, runWorkspaceSagaTick } from '../../src/mesh/mesh-graph-workspace-saga.js';
import { graphMaterializationBlockReason } from '../../src/mesh/mesh-graph-transition-runner.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    getQueue,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshTaskGraphNodeRow } from '../../src/mesh/mesh-graph-types.js';
import type { WorkspaceInspectReport } from '../../src/mesh/mesh-graph-workspace-safety.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const root of realGitRoots.splice(0)) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * A real git repo whose `.adhdev/worktree_bootstrap.json` runs a node one-liner
 * that appends to a marker file. The marker is the observable: its existence
 * proves the bootstrap commands actually ran in the worktree, and its content
 * proves how many times and in which cwd.
 */
function initRepoWithBootstrap(opts: { required?: boolean; failing?: boolean; enabled?: boolean } = {}): string {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'adhdev-gwsb-repo-')));
    realGitRoots.push(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'ADHDev Test'], { cwd: repo });
    fs.mkdirSync(path.join(repo, '.adhdev'), { recursive: true });

    // Appends "<cwd>\n" to BOOTSTRAP_RAN in the worktree it runs in, then exits
    // 0 (or 1 when we want a failing bootstrap).
    const script = opts.failing
        ? 'require("fs").appendFileSync("BOOTSTRAP_RAN", process.cwd()+"\\n"); process.exit(1)'
        : 'require("fs").appendFileSync("BOOTSTRAP_RAN", process.cwd()+"\\n")';
    fs.writeFileSync(path.join(repo, '.adhdev', 'worktree_bootstrap.json'), JSON.stringify({
        version: 1,
        enabled: opts.enabled ?? true,
        runOnClone: true,
        required: opts.required ?? true,
        commands: [{ command: 'node', args: ['-e', script], category: 'custom', timeoutMs: 30000 }],
    }, null, 2));

    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
    return repo;
}

function mockMeshFor(repo: string, meshId: string) {
    meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        name: 'bootstrap-test',
        nodes: [{ id: 'base', workspace: repo, repoRoot: repo }],
    });
}

function markerLines(worktreePath: string): string[] {
    const marker = path.join(worktreePath, 'BOOTSTRAP_RAN');
    if (!fs.existsSync(marker)) return [];
    return fs.readFileSync(marker, 'utf-8').split('\n').filter(Boolean);
}

// ── 1. The defect itself: saga-created worktrees must be bootstrapped ────────

describe('saga worktree creation runs the repo worktree_bootstrap', () => {
    it('defaultCreateWorktree runs the bootstrap commands inside the new worktree', async () => {
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        const repo = initRepoWithBootstrap();
        mockMeshFor(repo, meshId);

        const graphId = `graph_${randomUUID().slice(0, 8)}`;
        const workspaceRef = 'ws_unit10';
        const ports = createDefaultWorkspaceSagaPorts();
        const created = await ports.createWorktree({
            meshId,
            graphId,
            workspaceRef,
            sourceNodeId: 'base',
            baseRevision: 'main',
            branchIdentity: `graph-${graphId.slice(0, 8)}-${workspaceRef}`,
            ownerTag: deriveWorkspaceOwnerTag(graphId, workspaceRef),
            idempotencyKey: `graph-ws-clone:${graphId}:${workspaceRef}`,
        });

        // PRE-FIX: no marker at all — this is the exact live symptom (zero
        // worktree_bootstrap_complete events for saga-prepared worktrees).
        const lines = markerLines(created.worktreePath);
        expect(lines).toHaveLength(1);
        expect(fs.realpathSync(lines[0])).toBe(fs.realpathSync(created.worktreePath));

        // The outcome is reported back to the saga, not swallowed.
        expect(created.bootstrap?.status).toBe('ready');
        expect(created.bootstrap?.required).toBe(true);
    }, 60000);

    it('the bootstrap has ALREADY completed when createWorktree resolves (worker launch cannot race it)', async () => {
        // The live log shows MCP config + CLI spawn immediately after worktree
        // preparation, so a bootstrap started but not awaited would hand a worker
        // a half-built tree. Pin that createWorktree does not resolve early.
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        const repo = initRepoWithBootstrap();
        mockMeshFor(repo, meshId);

        const graphId = `graph_${randomUUID().slice(0, 8)}`;
        const workspaceRef = 'ws_order';
        const ports = createDefaultWorkspaceSagaPorts();
        const created = await ports.createWorktree({
            meshId, graphId, workspaceRef, sourceNodeId: 'base', baseRevision: 'main',
            branchIdentity: `graph-${graphId.slice(0, 8)}-${workspaceRef}`,
            ownerTag: deriveWorkspaceOwnerTag(graphId, workspaceRef),
            idempotencyKey: `graph-ws-clone:${graphId}:${workspaceRef}`,
        });

        // Synchronously right after the await — no timers, no flush.
        expect(markerLines(created.worktreePath)).toHaveLength(1);
        expect(created.bootstrap?.status).toBe('ready');
    }, 60000);

    it('an already-owned worktree is not re-bootstrapped (npm install is expensive; double-run is real damage)', async () => {
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        const repo = initRepoWithBootstrap();
        mockMeshFor(repo, meshId);

        const graphId = `graph_${randomUUID().slice(0, 8)}`;
        const workspaceRef = 'ws_idem';
        const ports = createDefaultWorkspaceSagaPorts();
        const req = {
            meshId, graphId, workspaceRef, sourceNodeId: 'base', baseRevision: 'main',
            branchIdentity: `graph-${graphId.slice(0, 8)}-${workspaceRef}`,
            ownerTag: deriveWorkspaceOwnerTag(graphId, workspaceRef),
            idempotencyKey: `graph-ws-clone:${graphId}:${workspaceRef}`,
        };
        const first = await ports.createWorktree(req);
        expect(markerLines(first.worktreePath)).toHaveLength(1);

        // Re-issuing the same request finds the owned worktree and short-circuits.
        const second = await ports.createWorktree({ ...req, desiredPath: first.worktreePath });
        expect(second.alreadyExisted).toBe(true);
        expect(markerLines(first.worktreePath)).toHaveLength(1);
        expect(second.bootstrap).toBeUndefined();
    }, 60000);

    it('a disabled bootstrap config is a legitimate outcome, not a failure', async () => {
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        const repo = initRepoWithBootstrap({ enabled: false });
        mockMeshFor(repo, meshId);

        const graphId = `graph_${randomUUID().slice(0, 8)}`;
        const workspaceRef = 'ws_disabled';
        const ports = createDefaultWorkspaceSagaPorts();
        const created = await ports.createWorktree({
            meshId, graphId, workspaceRef, sourceNodeId: 'base', baseRevision: 'main',
            branchIdentity: `graph-${graphId.slice(0, 8)}-${workspaceRef}`,
            ownerTag: deriveWorkspaceOwnerTag(graphId, workspaceRef),
            idempotencyKey: `graph-ws-clone:${graphId}:${workspaceRef}`,
        });
        expect(created.bootstrap?.status).toBe('disabled');
        expect(markerLines(created.worktreePath)).toHaveLength(0);
    }, 60000);
});

// ── 2. `required: true` must stop being silent ───────────────────────────────

describe('required bootstrap failure is surfaced, not swallowed', () => {
    it('a failing REQUIRED bootstrap is reported on the clone result and logged at error level', async () => {
        const { LOG } = await import('../../src/logging/logger.js');
        const errors: string[] = [];
        vi.spyOn(LOG, 'error').mockImplementation((_c: string, msg: string) => { errors.push(msg); });

        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        const repo = initRepoWithBootstrap({ failing: true, required: true });
        mockMeshFor(repo, meshId);

        const graphId = `graph_${randomUUID().slice(0, 8)}`;
        const workspaceRef = 'ws_required_fail';
        const ports = createDefaultWorkspaceSagaPorts();
        const created = await ports.createWorktree({
            meshId, graphId, workspaceRef, sourceNodeId: 'base', baseRevision: 'main',
            branchIdentity: `graph-${graphId.slice(0, 8)}-${workspaceRef}`,
            ownerTag: deriveWorkspaceOwnerTag(graphId, workspaceRef),
            idempotencyKey: `graph-ws-clone:${graphId}:${workspaceRef}`,
        });

        expect(created.bootstrap?.status).toBe('failed');
        expect(created.bootstrap?.required).toBe(true);
        // PRE-FIX this path produced no log line of any level.
        expect(errors.join('\n')).toMatch(/REQUIRED/);
    }, 60000);

    it('a failing NON-required bootstrap warns instead of erroring', async () => {
        const { LOG } = await import('../../src/logging/logger.js');
        const errors: string[] = [];
        const warns: string[] = [];
        vi.spyOn(LOG, 'error').mockImplementation((_c: string, msg: string) => { errors.push(msg); });
        vi.spyOn(LOG, 'warn').mockImplementation((_c: string, msg: string) => { warns.push(msg); });

        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        const repo = initRepoWithBootstrap({ failing: true, required: false });
        mockMeshFor(repo, meshId);

        const graphId = `graph_${randomUUID().slice(0, 8)}`;
        const workspaceRef = 'ws_optional_fail';
        const ports = createDefaultWorkspaceSagaPorts();
        const created = await ports.createWorktree({
            meshId, graphId, workspaceRef, sourceNodeId: 'base', baseRevision: 'main',
            branchIdentity: `graph-${graphId.slice(0, 8)}-${workspaceRef}`,
            ownerTag: deriveWorkspaceOwnerTag(graphId, workspaceRef),
            idempotencyKey: `graph-ws-clone:${graphId}:${workspaceRef}`,
        });

        expect(created.bootstrap?.status).toBe('failed');
        expect(created.bootstrap?.required).toBe(false);
        expect(errors).toHaveLength(0);
        expect(warns.join('\n')).toMatch(/worktree bootstrap failed/);
    }, 60000);
});

// ── 3. Clone-path regression guard — the protective shell ────────────────────
//
// The saga fix must not touch the clone path, which works today. Both paths now
// reach the same runMeshWorktreeBootstrap, so this pins that the clone path
// still runs it exactly ONCE per worktree and via its own call site.

describe('clone path is unchanged (regression guard)', () => {
    it('clone_mesh_node still owns its own bootstrap call — the saga fix did not move or duplicate it', async () => {
        const crudSrc = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'commands', 'med-family', 'mesh-crud.ts'),
            'utf-8',
        );
        // Exactly one invocation site inside finishWorktreeSetup for the clone,
        // plus the separate rerun-bootstrap command handler. Two total; if the
        // saga fix had "helpfully" routed clone through the ports layer, or
        // added a second call, this count changes.
        const invocations = crudSrc.match(/await runMeshWorktreeBootstrap\(/g) ?? [];
        expect(invocations).toHaveLength(2);
        // And the ports layer must NOT be imported by the clone path — the two
        // paths stay independent; sharing happens at runMeshWorktreeBootstrap.
        expect(crudSrc).not.toMatch(/mesh-graph-workspace-ports/);
    });

    it('the clone path bootstraps a real worktree exactly once and the saga path does not run for it', async () => {
        // End-to-end on the clone-side helper contract: submodule init + bootstrap
        // is driven from finishWorktreeSetup, so a worktree created through the
        // git helper directly (as clone does) plus one runMeshWorktreeBootstrap
        // call produces exactly one marker line — never two.
        const { runMeshWorktreeBootstrap } = await import('../../src/mesh/worktree-bootstrap-config.js');
        const { createWorktree } = await import('../../src/git/git-worktree.js');

        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        const repo = initRepoWithBootstrap();
        mockMeshFor(repo, meshId);
        const mesh = meshConfigMocks.getMesh();

        const cloned = await createWorktree({
            repoRoot: repo,
            branch: 'clone-path-branch',
            baseBranch: 'main',
            meshName: 'bootstrap-test',
            syncBaseFromRemote: false,
        });
        expect(markerLines(cloned.worktreePath)).toHaveLength(0);

        const state = await runMeshWorktreeBootstrap(mesh, cloned.worktreePath);
        expect(state.status).toBe('ready');
        expect(markerLines(cloned.worktreePath)).toHaveLength(1);
    }, 60000);
});

// ── 4. Saga-level: a required bootstrap failure must block publication ───────
//
// The ports layer reports the outcome; prepareClaimedIntent is what must act on
// it. Without this the worktree would still be published 'complete' and become
// an ordinary dispatch target — which is the whole harm: a worker launched into
// a tree whose `npm install` failed.

function seedGraphWithWorkspace(meshId: string, workspaceRef: string) {
    const task = enqueueTask(meshId, 'work that needs a prepared workspace', {
        taskMode: 'code_change', difficulty: 'medium',
    } as any);
    const gs = MeshRuntimeStore.getInstance().graphStore();
    const graphId = randomUUID();
    const nodeId = randomUUID();
    const now = new Date().toISOString();
    gs.insertGraph({
        graphId, meshId, batchId: randomUUID(), enqueueSurface: 'batch', schemaVersion: 2,
        status: 'preparing', taskCount: 1, gateCount: 0, workspaceCount: 1, dependencyEdgeCount: 0,
        policyJson: '{}', createdAt: now, updatedAt: now,
    });
    const nodeRow: MeshTaskGraphNodeRow = {
        graphId, nodeId, meshId, ref: 'unit', kind: 'worker_task', queueTaskId: task.id,
        state: 'declared',
        baseSpecJson: JSON.stringify({ message: 'work', workspace_ref: workspaceRef }),
        materializationVersion: 0, createdAt: now, updatedAt: now,
    };
    gs.insertNode(nodeRow);
    const entry = getQueue(meshId).find(t => t.id === task.id)!;
    MeshRuntimeStore.getInstance().updateQueueEntry({
        ...entry, blockedReason: graphMaterializationBlockReason(nodeId, 0), updatedAt: now,
    } as any);
    declareWorkspaceIntents({
        graphId, meshId,
        workspaces: [{
            ref: workspaceRef,
            source_node_id: 'local-base',
            purpose: 'bootstrap-gate-test',
            base_revision: 'main',
            cleanup_on_graph_failure: true,
        }],
    });
    return { graphId, workspaceRef };
}

/** Minimal ports whose createWorktree reports a caller-chosen bootstrap outcome. */
function portsReportingBootstrap(bootstrap: { status: string; required: boolean; error?: string } | undefined): {
    ports: WorkspaceSagaPorts;
    registrations: Array<{ nodeId: string; bootstrapStatus: string }>;
} {
    const registrations: Array<{ nodeId: string; bootstrapStatus: string }> = [];
    const noInspect: WorkspaceInspectReport = {
        pathExists: false, dirty: false, ahead: false, stashed: false, sessionBound: false,
    };
    const ports: WorkspaceSagaPorts = {
        nowMs: () => Date.now(),
        resolveBaseRevision: async () => 'main',
        createWorktree: async req => ({
            nodeId: `node_ws_${req.workspaceRef}`,
            worktreePath: `/tmp/fake-ws/${req.graphId}/${req.workspaceRef}`,
            ownerTag: req.ownerTag,
            ...(bootstrap ? { bootstrap } : {}),
        }),
        findOwnedWorktree: async () => null,
        inspectWorktree: async () => noInspect,
        removeWorktree: async () => ({ removed: true }),
        listLiveSessionsOnNode: async () => ({ sessionIds: [], unknown: false }),
        listAssignedTasksOnNode: async () => [],
        registerNode: async req => {
            registrations.push({ nodeId: req.nodeId, bootstrapStatus: req.bootstrapStatus });
            return true;
        },
        unregisterNode: async () => true,
    };
    return { ports, registrations };
}

describe('saga honours the bootstrap outcome before publishing a workspace', () => {
    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
    });

    it('a REQUIRED bootstrap failure fails preparation and never publishes the node as ready', async () => {
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        try {
            const { graphId, workspaceRef } = seedGraphWithWorkspace(meshId, 'ws_required_gate');
            const { ports, registrations } = portsReportingBootstrap({
                status: 'failed', required: true, error: 'npm ci exited 1',
            });

            const tick = await runWorkspaceSagaTick(meshId, ports);
            const step = tick.steps[0];
            expect(step.sagaState).toBe('failed');
            expect(step.error).toMatch(/worktree_bootstrap_failed/);
            expect(step.error).toMatch(/npm ci exited 1/);

            // Never advertised as a usable dispatch target.
            expect(registrations.some(r => r.bootstrapStatus === 'complete')).toBe(false);

            const intent = MeshRuntimeStore.getInstance().graphStore().getWorkspaceIntent(graphId, workspaceRef)!;
            expect(intent.sagaState).toBe('failed');
            // The created identity is still persisted so the tree is recoverable,
            // not orphaned on disk.
            expect(intent.createdWorktreePath).toBeTruthy();
        } finally {
            __clearMeshQueueForTests(meshId);
            __resetMeshRuntimeStoreForTests();
        }
    });

    it('a NON-required bootstrap failure still reaches ready — the repo opted out of the gate', async () => {
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        try {
            seedGraphWithWorkspace(meshId, 'ws_optional_gate');
            const { ports, registrations } = portsReportingBootstrap({
                status: 'failed', required: false, error: 'optional step failed',
            });
            const tick = await runWorkspaceSagaTick(meshId, ports);
            expect(tick.steps[0].sagaState).toBe('ready');
            expect(registrations.some(r => r.bootstrapStatus === 'complete')).toBe(true);
        } finally {
            __clearMeshQueueForTests(meshId);
            __resetMeshRuntimeStoreForTests();
        }
    });

    it('ports that report no bootstrap at all (test fakes) keep the pre-existing behaviour', async () => {
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        try {
            seedGraphWithWorkspace(meshId, 'ws_no_report');
            const { ports, registrations } = portsReportingBootstrap(undefined);
            const tick = await runWorkspaceSagaTick(meshId, ports);
            expect(tick.steps[0].sagaState).toBe('ready');
            expect(registrations.some(r => r.bootstrapStatus === 'complete')).toBe(true);
        } finally {
            __clearMeshQueueForTests(meshId);
            __resetMeshRuntimeStoreForTests();
        }
    });

    it('a ready bootstrap publishes the node exactly as before (running → complete)', async () => {
        const meshId = `mesh_gwsb_${randomUUID().slice(0, 8)}`;
        try {
            seedGraphWithWorkspace(meshId, 'ws_ready');
            const { ports, registrations } = portsReportingBootstrap({ status: 'ready', required: true });
            const tick = await runWorkspaceSagaTick(meshId, ports);
            expect(tick.steps[0].sagaState).toBe('ready');
            expect(registrations.map(r => r.bootstrapStatus)).toEqual(['running', 'complete']);
        } finally {
            __clearMeshQueueForTests(meshId);
            __resetMeshRuntimeStoreForTests();
        }
    });
});
