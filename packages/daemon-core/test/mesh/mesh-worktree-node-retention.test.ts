// ---------------------------------------------------------------------------
// lifecycle retention Slice 2 — safe automatic removal of converged local
// worktree nodes: per-exclusion reason codes, two-tick proof, grace boundary,
// durable lease, restart safety, partial-failure recovery, already-missing
// path, session/queue races, submodules, merged-branch control, dry-run
// default + idempotent plan, retention config resolvers.
//
// ISOLATION: every durable write (retention state file, ledger) goes under a
// per-run TEMP config root (vi.mock of config.js getConfigDir) — nothing ever
// touches the real ~/.adhdev. All git/session/queue data is injected; no real
// git or session host is involved.
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-worktree-retention-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-host-machine' }),
}));

import {
    acquireWorktreeRetentionLease,
    releaseWorktreeRetentionLease,
    runWorktreeNodeRetentionTick,
    getWorktreeNodeRetentionMetrics,
    __resetWorktreeNodeRetentionMetricsForTests,
    __deleteWorktreeNodeRetentionStateForTests,
    type WorktreeRetentionDeps,
    type WorktreeRetentionTickOptions,
    type WorktreeRetentionPlanEntry,
} from '../../src/mesh/mesh-worktree-retention.js';
import {
    DEFAULT_WORKTREE_NODE_RETENTION_GRACE_MS,
    DEFAULT_WORKTREE_NODE_RETENTION_LEASE_MS,
    resolveWorktreeNodeRetentionGraceMs,
    resolveWorktreeNodeRetentionLeaseMs,
} from '../../src/mesh/mesh-retention-config.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js';

const MESH_ID = 'mesh_retention_test';
const HOUR_MS = 60 * 60 * 1000;
const GRACE = 48 * HOUR_MS;
const NOW = 1_800_000_000_000;
const LOCAL_DAEMON = 'test-host-machine';

const BASE_NODE = {
    id: 'node-base',
    workspace: '/repo/base',
    repoRoot: '/repo/base',
    daemonId: LOCAL_DAEMON,
    isLocalWorktree: false,
};

function worktreeNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'node-wt-1',
        workspace: '/wt/one',
        isLocalWorktree: true,
        worktreeBranch: 'feat/thing',
        clonedFromNodeId: 'node-base',
        daemonId: LOCAL_DAEMON,
        ...overrides,
    };
}

function makeMesh(nodes: Array<Record<string, unknown>>): any {
    return { id: MESH_ID, name: MESH_ID, nodes: [BASE_NODE, ...nodes] };
}

interface FakeCalls {
    precheck: Array<Record<string, unknown>>;
    cleanup: Array<Record<string, unknown>>;
    convergence: Array<Record<string, unknown>>;
    sessionCleanup: Array<Record<string, unknown>>;
    removedNodes: Array<[string, string]>;
}

function makeDeps(overrides: Partial<WorktreeRetentionDeps> = {}, calls?: FakeCalls): WorktreeRetentionDeps {
    return {
        precheckLocalWorktreeRemovable: async (args) => {
            calls?.precheck.push(args as Record<string, unknown>);
            return { ok: true };
        },
        cleanupLocalWorktreeNode: async (args) => {
            calls?.cleanup.push(args as Record<string, unknown>);
            return { success: true, removedPath: (args.node as any).workspace, repoRoot: '/repo/base', branchRefDeleted: true, branchRefReason: 'merged' };
        },
        getWorktreeForceCleanupConvergence: async (args) => {
            calls?.convergence.push(args as Record<string, unknown>);
            return { allow: true, status: 'merged_to_default_ref', source: 'git_merge_base', ref: 'origin/main' };
        },
        listSessions: async () => [],
        cleanupMeshSessions: async (args) => {
            calls?.sessionCleanup.push(args as Record<string, unknown>);
            return { success: true };
        },
        ...overrides,
    };
}

function makeCalls(): FakeCalls {
    return { precheck: [], cleanup: [], convergence: [], sessionCleanup: [], removedNodes: [] };
}

function makeOpts(mesh: any, overrides: Partial<WorktreeRetentionTickOptions> = {}, calls?: FakeCalls): WorktreeRetentionTickOptions {
    return {
        mesh,
        nowMs: NOW,
        tickId: 'tick-1',
        sessions: [],
        queueEntries: [],
        directDispatches: [],
        ledgerEntries: [],
        runGit: async () => '',
        existsSync: () => true,
        removeNodeFromMesh: (meshId, nodeId) => { calls?.removedNodes.push([meshId, nodeId]); return true; },
        graceMs: GRACE,
        localDaemonId: LOCAL_DAEMON,
        processCwd: '/elsewhere/daemon-home',
        ...overrides,
    };
}

function entryFor(result: { entries: WorktreeRetentionPlanEntry[] }, nodeId: string): WorktreeRetentionPlanEntry {
    const entry = result.entries.find(e => e.nodeId === nodeId);
    if (!entry) throw new Error(`no plan entry for ${nodeId}; got ${result.entries.map(e => e.nodeId).join(',')}`);
    return entry;
}

function refineLedgerEntry(kind: string, nodeId: string, payload: Record<string, unknown>): any {
    return { id: randomUUID(), meshId: MESH_ID, timestamp: new Date(NOW).toISOString(), kind, nodeId, payload };
}

const ENV_VARS = ['MESH_WORKTREE_NODE_RETENTION_GRACE_MS', 'MESH_WORKTREE_NODE_RETENTION_LEASE_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const v of ENV_VARS) { savedEnv[v] = process.env[v]; delete process.env[v]; }
    __resetWorktreeNodeRetentionMetricsForTests();
    __deleteWorktreeNodeRetentionStateForTests();
});

afterEach(() => {
    for (const v of ENV_VARS) {
        if (savedEnv[v] === undefined) delete process.env[v];
        else process.env[v] = savedEnv[v];
    }
});

// ─── retention config resolvers ──────────────────────────────────────────────
describe('retention config resolvers', () => {
    it('defaults: grace 48h, lease 10min', () => {
        expect(DEFAULT_WORKTREE_NODE_RETENTION_GRACE_MS).toBe(48 * HOUR_MS);
        expect(resolveWorktreeNodeRetentionGraceMs()).toBe(48 * HOUR_MS);
        expect(DEFAULT_WORKTREE_NODE_RETENTION_LEASE_MS).toBe(10 * 60 * 1000);
        expect(resolveWorktreeNodeRetentionLeaseMs()).toBe(10 * 60 * 1000);
    });
    it('grace: env override honored inside clamp, clamped outside, 0 disables', () => {
        process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS = String(2 * HOUR_MS);
        expect(resolveWorktreeNodeRetentionGraceMs()).toBe(2 * HOUR_MS);
        process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS = String(30 * 60 * 1000); // below 1h floor
        expect(resolveWorktreeNodeRetentionGraceMs()).toBe(48 * HOUR_MS);
        process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS = String(365 * 24 * HOUR_MS); // above 30d ceiling
        expect(resolveWorktreeNodeRetentionGraceMs()).toBe(48 * HOUR_MS);
        process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS = '0';
        expect(resolveWorktreeNodeRetentionGraceMs()).toBe(0);
        process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS = 'not-a-number';
        expect(resolveWorktreeNodeRetentionGraceMs()).toBe(48 * HOUR_MS);
    });
    it('lease: env override honored inside clamp only', () => {
        process.env.MESH_WORKTREE_NODE_RETENTION_LEASE_MS = String(5 * 60 * 1000);
        expect(resolveWorktreeNodeRetentionLeaseMs()).toBe(5 * 60 * 1000);
        process.env.MESH_WORKTREE_NODE_RETENTION_LEASE_MS = String(30 * 1000); // below 1min floor
        expect(resolveWorktreeNodeRetentionLeaseMs()).toBe(10 * 60 * 1000);
    });
});

// ─── hard exclusions (one reason-coded test per contract exclusion) ──────────
describe('hard exclusions', () => {
    it('base / non-worktree nodes are never candidates', async () => {
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()])));
        expect(entryFor(result, 'node-base').reasonCode).toBe('not_local_worktree');
        expect(entryFor(result, 'node-base').candidate).toBe(false);
    });
    it('coordinator identity node is excluded', async () => {
        const node = worktreeNode({ isCoordinator: true });
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([node])));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('coordinator_identity');
    });
    it('evidence/retention worktrees are excluded (branch namespace + marker)', async () => {
        const byBranch = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode({ worktreeBranch: 'evidence/run-42' })])));
        expect(entryFor(byBranch, 'node-wt-1').reasonCode).toBe('evidence_retention_worktree');
        const byMarker = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode({ retentionWorktree: true })])));
        expect(entryFor(byMarker, 'node-wt-1').reasonCode).toBe('evidence_retention_worktree');
    });
    it('remote-daemon worktrees are excluded (only the owner retains them)', async () => {
        const node = worktreeNode({ daemonId: 'other-machine-9' });
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([node])));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('remote_node');
    });
    it('current-process cwd (or a parent of it) blocks removal', async () => {
        const cwdInside = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), { processCwd: '/wt/one/sub/dir' }));
        expect(entryFor(cwdInside, 'node-wt-1').reasonCode).toBe('process_cwd_reference');
        const cwdExact = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), { processCwd: '/wt/one' }));
        expect(entryFor(cwdExact, 'node-wt-1').reasonCode).toBe('process_cwd_reference');
    });
    it('dirty / conflicted worktree (precheck refusal) is excluded with the precheck code', async () => {
        const deps = makeDeps({
            precheckLocalWorktreeRemovable: async () => ({ ok: false, code: 'mesh_worktree_cleanup_dirty', error: 'Refusing to remove dirty worktree', recoveryHint: 'commit' }),
        });
        const result = await runWorktreeNodeRetentionTick(deps, makeOpts(makeMesh([worktreeNode()])));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('mesh_worktree_cleanup_dirty');
    });
    it('ahead / unmerged branch → convergence_unproven', async () => {
        const deps = makeDeps({
            getWorktreeForceCleanupConvergence: async () => ({ allow: false, error: 'worktree HEAD is not contained in checked refs: origin/main' }),
        });
        const result = await runWorktreeNodeRetentionTick(deps, makeOpts(makeMesh([worktreeNode()])));
        const entry = entryFor(result, 'node-wt-1');
        expect(entry.reasonCode).toBe('convergence_unproven');
        expect(entry.convergence?.allow).toBe(false);
    });
    it('missing or stale upstream proof → convergence_unproven', async () => {
        const deps = makeDeps({
            getWorktreeForceCleanupConvergence: async () => ({ allow: false, error: 'no default/main refs were available for convergence verification' }),
        });
        const result = await runWorktreeNodeRetentionTick(deps, makeOpts(makeMesh([worktreeNode()])));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('convergence_unproven');
    });
    it('stash present → stash_present', async () => {
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            runGit: async (args) => (args[0] === 'stash' ? 'stash@{0}: WIP on feat/thing\n' : ''),
        }));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('stash_present');
    });
    it('submodule drift (+ gitlink mismatch) → submodule_drift; clean submodule passes', async () => {
        const drift = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            runGit: async (args) => (args[0] === 'submodule' ? '+abc123 vendor/lib (heads/main)\n' : ''),
        }));
        expect(entryFor(drift, 'node-wt-1').reasonCode).toBe('submodule_drift');
        const clean = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            runGit: async (args) => (args[0] === 'submodule' ? ' abc123 vendor/lib (heads/main)\n' : ''),
        }));
        expect(entryFor(clean, 'node-wt-1').reasonCode).toBe('candidate');
    });
    it('git probe failure is fail-closed → probe_failed', async () => {
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            runGit: async () => { throw new Error('git exploded'); },
        }));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('probe_failed');
    });
    it('live/starting session attached to the node → live_session; stopped records do not block', async () => {
        const live = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            sessions: [{ sessionId: 's-live', workspace: '/wt/one', lifecycle: 'running' }],
        }));
        expect(entryFor(live, 'node-wt-1').reasonCode).toBe('live_session');
        const starting = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            sessions: [{ sessionId: 's-start', workspace: '/wt/one', lifecycle: 'starting' }],
        }));
        expect(entryFor(starting, 'node-wt-1').reasonCode).toBe('live_session');
        const boundByMeta = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            sessions: [{ sessionId: 's-meta', workspace: '/somewhere/else', lifecycle: 'running', meta: { meshNodeId: 'node-wt-1' } }],
        }));
        expect(entryFor(boundByMeta, 'node-wt-1').reasonCode).toBe('live_session');
        const stopped = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            sessions: [{ sessionId: 's-done', workspace: '/wt/one', lifecycle: 'stopped' }],
        }));
        expect(entryFor(stopped, 'node-wt-1').reasonCode).toBe('candidate');
    });
    it('unavailable session inventory is fail-closed → live_session', async () => {
        const deps = makeDeps({ listSessions: async () => { throw new Error('host down'); } });
        const result = await runWorktreeNodeRetentionTick(deps, makeOpts(makeMesh([worktreeNode()]), { sessions: undefined }));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('live_session');
    });
    it('queue references: pending-targeted, assigned, and direct dispatch each block', async () => {
        const pending = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            queueEntries: [{ id: 't1', status: 'pending', targetNodeId: 'node-wt-1' } as any],
        }));
        expect(entryFor(pending, 'node-wt-1').reasonCode).toBe('queue_reference');
        const assigned = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            queueEntries: [{ id: 't2', status: 'assigned', assignedNodeId: 'node-wt-1' } as any],
        }));
        expect(entryFor(assigned, 'node-wt-1').reasonCode).toBe('queue_reference');
        const direct = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            directDispatches: [{ taskId: 'd1', nodeId: 'node-wt-1', status: 'dispatched' } as any],
        }));
        expect(entryFor(direct, 'node-wt-1').reasonCode).toBe('queue_reference');
        const terminalQueue = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), {
            queueEntries: [{ id: 't3', status: 'completed', targetNodeId: 'node-wt-1' } as any],
        }));
        expect(entryFor(terminalQueue, 'node-wt-1').reasonCode).toBe('candidate');
    });
    it('Refinery in-flight (accepted/running job) → review_inflight', async () => {
        const ledgerEntries = [refineLedgerEntry('task_dispatched', 'node-wt-1', {
            source: 'refine_mesh_node_async_job',
            refineJob: { jobId: 'job-1', status: 'accepted', nodeId: 'node-wt-1' },
        })];
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), { ledgerEntries }));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('review_inflight');
    });
    it('latest terminal refine result blocked_review → blocked_review', async () => {
        const ledgerEntries = [refineLedgerEntry('task_completed', 'node-wt-1', {
            source: 'refine_mesh_node_async_job',
            refineJob: { jobId: 'job-2', status: 'completed', nodeId: 'node-wt-1' },
            finalBranchConvergenceState: { status: 'blocked_review' },
        })];
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), { ledgerEntries }));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('blocked_review');
    });
    it('grace = 0 disables retention for every node', async () => {
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(makeMesh([worktreeNode()]), { graceMs: 0, execute: true }));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('retention_disabled');
        expect(entryFor(result, 'node-wt-1').execution).toBeUndefined();
    });
});

// ─── two-tick proof + grace boundary ─────────────────────────────────────────
describe('two-tick proof and grace boundary', () => {
    it('requires two DISTINCT ticks AND the grace window before autoEligible', async () => {
        const deps = makeDeps();
        const mesh = makeMesh([worktreeNode()]);
        const t1 = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }));
        expect(entryFor(t1, 'node-wt-1').auto?.passCount).toBe(1);
        expect(entryFor(t1, 'node-wt-1').auto?.autoEligible).toBe(false);
        // Same tickId re-run is idempotent — no extra pass counted.
        const t1again = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW + 1000 }));
        expect(entryFor(t1again, 'node-wt-1').auto?.passCount).toBe(1);
        // Second distinct tick, grace not yet elapsed.
        const t2 = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + HOUR_MS }));
        expect(entryFor(t2, 'node-wt-1').auto?.passCount).toBe(2);
        expect(entryFor(t2, 'node-wt-1').auto?.autoEligible).toBe(false);
        // One ms before the boundary: still not eligible.
        const beforeBoundary = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-3', nowMs: NOW + GRACE - 1 }));
        expect(entryFor(beforeBoundary, 'node-wt-1').auto?.autoEligible).toBe(false);
        // Exactly at the boundary (now - firstPassAt >= grace): eligible.
        const atBoundary = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-4', nowMs: NOW + GRACE }));
        expect(entryFor(atBoundary, 'node-wt-1').auto?.autoEligible).toBe(true);
    });
    it('auto execute removes only after two ticks + grace; never before', async () => {
        const calls = makeCalls();
        const deps = makeDeps({}, calls);
        const mesh = makeMesh([worktreeNode()]);
        const t1 = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW, execute: true }, calls));
        expect(entryFor(t1, 'node-wt-1').execution).toBeUndefined();
        expect(calls.removedNodes).toHaveLength(0);
        const t2 = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true }, calls));
        const entry = entryFor(t2, 'node-wt-1');
        expect(entry.execution?.success).toBe(true);
        expect(entry.execution?.removed).toBe(true);
        expect(calls.removedNodes).toEqual([[MESH_ID, 'node-wt-1']]);
    });
    it('a lapse (failing check) resets the proof', async () => {
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }));
        // Lapse: node goes dirty on the next pass.
        const dirtyDeps = makeDeps({
            precheckLocalWorktreeRemovable: async () => ({ ok: false, code: 'mesh_worktree_cleanup_dirty', error: 'dirty', recoveryHint: 'commit' }),
        });
        await runWorktreeNodeRetentionTick(dirtyDeps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + HOUR_MS }));
        // Clean again: proof must restart at pass 1.
        const t3 = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(mesh, { tickId: 'tick-3', nowMs: NOW + 2 * HOUR_MS }));
        expect(entryFor(t3, 'node-wt-1').auto?.passCount).toBe(1);
    });
    it('dry-run with recordPasses:false is observational (does not advance the proof)', async () => {
        const deps = makeDeps();
        const mesh = makeMesh([worktreeNode()]);
        const observed = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'peek-1', nowMs: NOW, recordPasses: false }));
        expect(entryFor(observed, 'node-wt-1').auto?.passCount).toBe(0);
        const t1 = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }));
        expect(entryFor(t1, 'node-wt-1').auto?.passCount).toBe(1);
    });
    it('restart safety: the proof survives via the durable state file', async () => {
        const deps = makeDeps();
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }));
        const statePath = join(getLedgerDir(), 'worktree-node-retention-state.json');
        expect(fs.existsSync(statePath)).toBe(true);
        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        expect(persisted.nodes[`${MESH_ID}::node-wt-1`].firstPassAt).toBe(NOW);
        expect(persisted.nodes[`${MESH_ID}::node-wt-1`].passCount).toBe(1);
        // "Restart": a fresh tick reads the proof from disk (no in-memory state).
        const t2 = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true }));
        expect(entryFor(t2, 'node-wt-1').execution?.success).toBe(true);
    });
});

// ─── durable lease / concurrency ─────────────────────────────────────────────
describe('durable lease', () => {
    it('second owner cannot acquire while a lease is unexpired; expired lease is reclaimable', () => {
        expect(acquireWorktreeRetentionLease({ meshId: MESH_ID, nodeId: 'n1', owner: 'A', nowMs: NOW, leaseMs: 10 * 60 * 1000 })).toBe(true);
        expect(acquireWorktreeRetentionLease({ meshId: MESH_ID, nodeId: 'n1', owner: 'B', nowMs: NOW + 1000, leaseMs: 10 * 60 * 1000 })).toBe(false);
        expect(acquireWorktreeRetentionLease({ meshId: MESH_ID, nodeId: 'n1', owner: 'B', nowMs: NOW + 10 * 60 * 1000 + 1, leaseMs: 10 * 60 * 1000 })).toBe(true);
        releaseWorktreeRetentionLease({ meshId: MESH_ID, nodeId: 'n1', owner: 'B' });
        expect(acquireWorktreeRetentionLease({ meshId: MESH_ID, nodeId: 'n1', owner: 'C', nowMs: NOW + 10 * 60 * 1000 + 2, leaseMs: 10 * 60 * 1000 })).toBe(true);
    });
    it('an unexpired foreign lease blocks execution with lease_held', async () => {
        const mesh = makeMesh([worktreeNode()]);
        const deps = makeDeps();
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }));
        // Foreign owner grabs the lease before the executing tick (long-lived:
        // still unexpired at the +48h tick).
        expect(acquireWorktreeRetentionLease({ meshId: MESH_ID, nodeId: 'node-wt-1', owner: 'other-owner', nowMs: NOW, leaseMs: 100 * HOUR_MS })).toBe(true);
        const calls = makeCalls();
        const t2 = await runWorktreeNodeRetentionTick(makeDeps({}, calls), makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true }, calls));
        const entry = entryFor(t2, 'node-wt-1');
        expect(entry.auto?.leaseHeld).toBe(true);
        expect(entry.auto?.autoEligible).toBe(false);
        expect(calls.removedNodes).toHaveLength(0);
    });
});

// ─── execution semantics ─────────────────────────────────────────────────────
describe('execution', () => {
    async function proveEligible(calls: FakeCalls): Promise<{ mesh: any; deps: WorktreeRetentionDeps }> {
        const deps = makeDeps({}, calls);
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }, calls));
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: false }, calls));
        return { mesh, deps };
    }
    it('never forces; merged branch ref deletion is delegated to the existing cleanup', async () => {
        const calls = makeCalls();
        const { mesh, deps } = await proveEligible(calls);
        const t = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-3', nowMs: NOW + GRACE + 1, execute: true }, calls));
        const entry = entryFor(t, 'node-wt-1');
        expect(entry.execution?.success).toBe(true);
        expect(entry.execution?.branchRefDeleted).toBe(true);
        for (const call of calls.cleanup) expect(call.force).toBeUndefined();
        for (const call of calls.precheck) expect(call.force).toBeUndefined();
        // Stopped-session records are cleaned best-effort; live sessions were excluded by the plan.
        expect(calls.sessionCleanup[0]?.mode).toBe('delete_stopped');
        // State record dropped after terminal removal.
        const persisted = JSON.parse(fs.readFileSync(join(getLedgerDir(), 'worktree-node-retention-state.json'), 'utf8'));
        expect(persisted.nodes[`${MESH_ID}::node-wt-1`]).toBeUndefined();
    });
    it('preserved (unmerged) branch ref is surfaced, never deleted silently', async () => {
        const calls = makeCalls();
        const deps = makeDeps({
            cleanupLocalWorktreeNode: async (args) => {
                calls.cleanup.push(args as Record<string, unknown>);
                return { success: true, removedPath: '/wt/one', branchRefDeleted: false, branchRefReason: 'branch_not_merged_preserved: convergence_unverified' };
            },
        }, calls);
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }, calls));
        const t = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true }, calls));
        const entry = entryFor(t, 'node-wt-1');
        expect(entry.execution?.success).toBe(true);
        expect(entry.execution?.branchRefDeleted).toBe(false);
        expect(entry.execution?.branchRefReason).toContain('preserved');
    });
    it('plan→execute race: re-precheck refusal aborts removal (session/queue race guard)', async () => {
        const calls = makeCalls();
        let precheckCalls = 0;
        const deps = makeDeps({
            precheckLocalWorktreeRemovable: async (args) => {
                calls.precheck.push(args as Record<string, unknown>);
                precheckCalls++;
                // Plan-time prechecks pass; the execute-time re-precheck sees a dirty tree.
                return precheckCalls <= 1
                    ? { ok: true as const }
                    : { ok: false as const, code: 'mesh_worktree_cleanup_dirty', error: 'became dirty between plan and execute', recoveryHint: 'retry' };
            },
        }, calls);
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }, calls));
        precheckCalls = 0; // reset: next tick's plan call is #1 again
        const t = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true }, calls));
        const entry = entryFor(t, 'node-wt-1');
        expect(entry.execution?.success).toBe(false);
        expect(entry.execution?.code).toBe('mesh_worktree_cleanup_dirty');
        expect(entry.reasonCode).toBe('execution_precheck_refused');
        expect(calls.removedNodes).toHaveLength(0);
        expect(calls.cleanup).toHaveLength(0);
        // Lease was released — a later pass can retry.
        expect(acquireWorktreeRetentionLease({ meshId: MESH_ID, nodeId: 'node-wt-1', owner: 'someone', nowMs: NOW + GRACE + 1, leaseMs: 1000 })).toBe(true);
    });
    it('partial failure: membership removal failure keeps the node retryable; next pass recovers', async () => {
        const calls = makeCalls();
        const deps = makeDeps({}, calls);
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }, calls));
        let failMembership = true;
        const opts = (tickId: string, nowMs: number) => makeOpts(mesh, {
            tickId, nowMs, execute: true,
            removeNodeFromMesh: () => !failMembership,
        }, calls);
        const failed = await runWorktreeNodeRetentionTick(deps, opts('tick-2', NOW + GRACE));
        const failedEntry = entryFor(failed, 'node-wt-1');
        expect(failedEntry.execution?.success).toBe(false);
        expect(failedEntry.execution?.code).toBe('execution_membership_not_removed');
        // Recover on a later pass (proof record preserved).
        failMembership = false;
        const recovered = await runWorktreeNodeRetentionTick(deps, opts('tick-3', NOW + GRACE + HOUR_MS));
        expect(entryFor(recovered, 'node-wt-1').execution?.success).toBe(true);
    });
    it('residue (directory bytes left behind) is non-gating and surfaced', async () => {
        const calls = makeCalls();
        const deps = makeDeps({
            cleanupLocalWorktreeNode: async (args) => {
                calls.cleanup.push(args as Record<string, unknown>);
                return { success: true, removedPath: '/wt/one', residue: true, residueWarning: 'leftover residue', branchRefDeleted: true };
            },
        }, calls);
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }, calls));
        const t = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true }, calls));
        const entry = entryFor(t, 'node-wt-1');
        expect(entry.execution?.success).toBe(true);
        expect(entry.execution?.residue).toBe(true);
        expect(calls.removedNodes).toEqual([[MESH_ID, 'node-wt-1']]);
    });
    it('already-missing worktree path: skips git probes, still requires convergence proof, removes registration', async () => {
        const calls = makeCalls();
        const runGit = vi.fn(async () => '');
        const deps = makeDeps({
            cleanupLocalWorktreeNode: async (args) => {
                calls.cleanup.push(args as Record<string, unknown>);
                return { success: true, skipped: true, removedPath: '/wt/one', reason: 'worktree_path_missing' };
            },
            // Metadata-only proof (externally recorded merge convergence).
            getWorktreeForceCleanupConvergence: async () => ({ allow: true, status: 'merged_to_main', source: 'node_branch_convergence' }),
        }, calls);
        const node = worktreeNode({ branchConvergence: { status: 'merged_to_main' } });
        const mesh = makeMesh([node]);
        const base = { existsSync: () => false, runGit };
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW, ...base }, calls));
        const t = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true, ...base }, calls));
        const entry = entryFor(t, 'node-wt-1');
        expect(entry.execution?.success).toBe(true);
        expect(entry.execution?.skipped).toBe(true);
        expect(runGit).not.toHaveBeenCalled();
    });
    it('missing path WITHOUT recorded convergence proof is still excluded', async () => {
        const deps = makeDeps({
            getWorktreeForceCleanupConvergence: async () => ({ allow: false, error: 'could not resolve worktree HEAD: path gone' }),
        });
        const mesh = makeMesh([worktreeNode()]);
        const result = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { existsSync: () => false }));
        expect(entryFor(result, 'node-wt-1').reasonCode).toBe('convergence_unproven');
    });
    it('manual mode executes current candidates without the two-tick wait', async () => {
        const calls = makeCalls();
        const deps = makeDeps({}, calls);
        const mesh = makeMesh([worktreeNode()]);
        const t = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'manual-1', nowMs: NOW, execute: true, executeMode: 'manual' }, calls));
        expect(entryFor(t, 'node-wt-1').execution?.success).toBe(true);
        expect(calls.removedNodes).toEqual([[MESH_ID, 'node-wt-1']]);
    });
    it('cleanup failure is reported per-node and removes nothing', async () => {
        const calls = makeCalls();
        const deps = makeDeps({
            cleanupLocalWorktreeNode: async () => ({ success: false as const, code: 'mesh_worktree_cleanup_failed', error: 'git worktree remove failed', recoveryHint: 'inspect' }),
        }, calls);
        const mesh = makeMesh([worktreeNode()]);
        await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }, calls));
        const t = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-2', nowMs: NOW + GRACE, execute: true }, calls));
        const entry = entryFor(t, 'node-wt-1');
        expect(entry.execution?.success).toBe(false);
        expect(entry.execution?.code).toBe('mesh_worktree_cleanup_failed');
        expect(calls.removedNodes).toHaveLength(0);
    });
});

// ─── plan shape / dry-run parity / metrics ───────────────────────────────────
describe('plan shape, dry-run parity, metrics', () => {
    it('dry-run by default: identical reason-coded plan, zero destructive calls', async () => {
        const calls = makeCalls();
        const deps = makeDeps({}, calls);
        const mesh = makeMesh([worktreeNode()]);
        const plan = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW, recordPasses: false }, calls));
        expect(plan.dryRun).toBe(true);
        expect(entryFor(plan, 'node-wt-1').reasonCode).toBe('candidate');
        expect(entryFor(plan, 'node-base').reasonCode).toBe('not_local_worktree');
        expect(calls.cleanup).toHaveLength(0);
        expect(calls.removedNodes).toHaveLength(0);
        // Idempotent: re-planning yields the same codes.
        const plan2 = await runWorktreeNodeRetentionTick(deps, makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW, recordPasses: false }, calls));
        expect(plan2.entries.map(e => [e.nodeId, e.reasonCode])).toEqual(plan.entries.map(e => [e.nodeId, e.reasonCode]));
    });
    it('onlyNodeId restricts the plan', async () => {
        const mesh = makeMesh([worktreeNode(), worktreeNode({ id: 'node-wt-2', workspace: '/wt/two' })]);
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(mesh, { onlyNodeId: 'node-wt-2' }));
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].nodeId).toBe('node-wt-2');
    });
    it('summary + metrics are content-free counts', async () => {
        __resetWorktreeNodeRetentionMetricsForTests();
        const mesh = makeMesh([worktreeNode()]);
        const result = await runWorktreeNodeRetentionTick(makeDeps(), makeOpts(mesh, { tickId: 'tick-1', nowMs: NOW }));
        expect(result.summary.scanned).toBe(2);
        expect(result.summary.candidates).toBe(1);
        expect(result.summary.skipped).toBe(1);
        expect(result.summary.byReason).toEqual({ candidate: 1, not_local_worktree: 1 });
        const m = getWorktreeNodeRetentionMetrics();
        expect(m.ticks).toBe(1);
        expect(m.nodesScanned).toBe(2);
        expect(m.candidates).toBe(1);
        expect(m.skips).toBe(1);
        expect(m.removed).toBe(0);
    });
});
