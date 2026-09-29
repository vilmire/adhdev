import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// Scheduler dependency-gate INVARIANT characterization.
//
//   - taskDependenciesSatisfied is THE one predicate; semantics are exactly
//     "all dependsOn statuses completed".
//   - every scheduling surface must keep calling it, with no local
//     reinterpretation (the DEPENDSON-GATE-SYMMETRY boundary).
//   - inlining dependency logic into any one surface must fail; so must adding
//     condition/gate/workspace/skip checks to a surface.
//
//   This is a CHARACTERIZATION suite: it goes red the moment anyone forks,
//   bypasses, or locally reinterprets the gate. Two layers per surface:
//     (1) RUNTIME SPY — a wrapped taskDependenciesSatisfied records every evaluation;
//         each surface is driven end-to-end and must be observed consulting it.
//         Inlining the same semantics (or bypassing the gate) drops the spy count → red.
//     (2) STRUCTURAL PIN — the surface source must gate through the predicate call,
//         must not re-implement dependency readiness inline, and must not grow
//         graph/run_if/gate/workspace checks of its own.

const testTmpDir = path.join(tmpdir(), `adhdev-dep-gate-invariant-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

// ── The runtime spy: vi.spyOn on the ONE predicate's module namespace ────────
// (A vi.mock wrap loses the claim surface: mesh-work-queue ↔ mesh-runtime-store
// is a circular import, so the store binds the real module during the mock
// factory. A namespace spyOn rewrites the ONE shared namespace object in place,
// which every importer — claim, auto-launch — observes at call time.)
function spyOnPredicate() {
    const spy = vi.spyOn(wq, 'taskDependenciesSatisfied');
    return {
        spy,
        count: () => spy.mock.calls.length,
        sawEntryWithDep: (depId: string) =>
            spy.mock.calls.some(([entry]: any[]) => Array.isArray(entry?.dependsOn) && entry.dependsOn.includes(depId)),
    };
}

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
    getMachineNickname: () => ({ machineId: 'test-machine' } as any).machineNickname ?? null,
}));

const meshConfigMocks = vi.hoisted(() => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: meshConfigMocks.getMesh,
    getMeshByRepo: meshConfigMocks.getMeshByRepo,
    listMeshes: meshConfigMocks.listMeshes,
}));
vi.mock('../../src/detection/cli-detector.js', () => ({
    detectCLI: vi.fn(async () => ({ path: '/usr/bin/codex' })),
}));

import * as wq from '../../src/mesh/mesh-work-queue.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    claimNextTask,
    enqueueTask,
    getQueue,
    taskDependenciesSatisfied,
    updateTaskStatus, __writeTaskStatusForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { triggerMeshQueue } from '../../src/mesh/mesh-events.js';
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js';
import { withMeshRouter } from './helpers/mesh-router-stub.js'

const NODE_ID = 'node_main';

function meshId(tag: string): string {
    return `mesh_gateinv_${tag}_${randomUUID().slice(0, 8)}`;
}

function cleanup(id: string) {
    __clearMeshQueueForTests(id);
    __resetMeshRuntimeStoreForTests();
    __resetAutoLaunchAwaitClaimBackoffForTests();
    meshConfigMocks.getMesh.mockReset();
    meshConfigMocks.listMeshes.mockReset();
    meshConfigMocks.listMeshes.mockReturnValue([]);
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

// ── 1. Predicate semantics pin (design :14-25, :357-359, :784-786) ───────────

describe('taskDependenciesSatisfied semantics — exactly "all deps completed"', () => {
    const entry = (over: any = {}) => ({ dependsOn: ['a', 'b'], ...over });
    const status = (m: Record<string, string>) => new Map(Object.entries(m));

    it('true when every dependsOn id is completed', () => {
        expect(taskDependenciesSatisfied(entry(), status({ a: 'completed', b: 'completed' }))).toBe(true);
        expect(taskDependenciesSatisfied({ dependsOn: [] }, status({}))).toBe(true);
        expect(taskDependenciesSatisfied({}, status({}))).toBe(true);
    });

    it('false when ANY dependency is not completed (pending/assigned/failed/cancelled)', () => {
        for (const st of ['pending', 'assigned', 'failed', 'cancelled']) {
            expect(taskDependenciesSatisfied(entry(), status({ a: 'completed', b: st })), `b=${st}`).toBe(false);
        }
    });

    it('false for a MISSING dependency id (forward reference not yet completed)', () => {
        expect(taskDependenciesSatisfied(entry(), status({ a: 'completed' }))).toBe(false);
    });

    it('only the literal completed status satisfies a dependency', () => {
        // Any other status word — including an unknown one — is not 'completed'.
        expect(taskDependenciesSatisfied(entry(), status({ a: 'completed', b: 'skipped' }))).toBe(false);
    });

    it('tolerates a non-array dependsOn (legacy rows)', () => {
        expect(taskDependenciesSatisfied({ dependsOn: 'oops' as any }, status({}))).toBe(true);
    });
});

// ── 2. Surface: queue claim (claimNextQueueTask) — spy + behavior ────────────

describe('SURFACE claim (claimNextQueueTask) routes through the predicate', () => {
    it('consults the predicate for the pending candidate and refuses while a dependency is unmet', () => {
        const id = meshId('claim_unmet');
        try {
            const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
            // Keep the prerequisite out of the pending candidate set so the dependent is
            // the sole candidate the claim loop evaluates.
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...dep, status: 'assigned', assignedNodeId: NODE_ID, assignedSessionId: 'other-sess',
                updatedAt: new Date().toISOString(),
            } as any);
            const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });

            const pred = spyOnPredicate();
            const claimed = claimNextTask(id, NODE_ID, 'claim-sess-1');

            expect(claimed).toBeNull();
            expect(pred.count()).toBeGreaterThan(0);
            expect(pred.sawEntryWithDep(dep.id)).toBe(true);
            expect(getQueue(id).find(t => t.id === dependent.id)!.status).toBe('pending');
        } finally {
            cleanup(id);
        }
    });

    it('consults the predicate and claims once every dependency is completed', () => {
        const id = meshId('claim_met');
        try {
            const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
            const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });
            __writeTaskStatusForTests(id, dep.id, 'completed');

            const pred = spyOnPredicate();
            const claimed = claimNextTask(id, NODE_ID, 'claim-sess-2');

            expect(pred.count()).toBeGreaterThan(0);
            expect(claimed?.id).toBe(dependent.id);
        } finally {
            cleanup(id);
        }
    });
});

// ── 3. Surface: auto-launch (maybeAutoLaunchOneQueueSession) — spy + behavior ──

function setMesh(id: string) {
    meshConfigMocks.getMesh.mockReturnValue({
        id,
        name: 'Gate Invariant Mesh',
        policy: {},
        nodes: [{ id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } }],
    });
}

function createComponents(cliInstances: any[] = []) {
    return withMeshRouter({
        instanceManager: {
            getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
            getInstance: vi.fn(() => undefined),
        },
        cliManager: {
            adapters: new Map(),
            handleCliCommand: vi.fn(async (command: string) =>
                command === 'launch_cli' ? { success: true, sessionId: `spawned-${randomUUID().slice(0, 6)}` } : { success: true }),
        },
        providerLoader: {
            resolveAlias: vi.fn((t: string) => t),
            isMachineProviderEnabled: vi.fn(() => true),
            setCliDetectionResults: vi.fn(),
            getMeta: vi.fn(() => undefined),
        },
        dispatchMeshCommand: vi.fn(async () => ({ success: true })),
        statusInstanceId: 'daemon-local',
        onStatusChange: vi.fn(),
    } as any);
}

function launchCliCalls(components: any): number {
    return components.cliManager.handleCliCommand.mock.calls.filter((c: any[]) => c[0] === 'launch_cli').length;
}

describe('SURFACE auto-launch (maybeAutoLaunchOneQueueSession) routes through the predicate', () => {
    it('consults the predicate and does not spawn while a dependency is unmet', async () => {
        const id = meshId('al_unmet');
        try {
            setMesh(id);
            const components = createComponents([]);
            const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...dep, status: 'assigned', assignedNodeId: NODE_ID, assignedSessionId: 'other-sess',
                updatedAt: new Date().toISOString(),
            } as any);
            const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });

            const pred = spyOnPredicate();
            await triggerMeshQueue(components, id);

            expect(pred.sawEntryWithDep(dep.id)).toBe(true);
            expect(getQueue(id).find(t => t.id === dependent.id)!.autoLaunch?.reason).toBe('dependencies_unsatisfied');
            expect(launchCliCalls(components)).toBe(0);
        } finally {
            cleanup(id);
        }
    });

    it('consults the predicate and launches once the dependency completes', async () => {
        const id = meshId('al_met');
        try {
            setMesh(id);
            const components = createComponents([]);
            const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
            const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });
            __writeTaskStatusForTests(id, dep.id, 'completed');

            const pred = spyOnPredicate();
            await triggerMeshQueue(components, id);

            expect(pred.sawEntryWithDep(dep.id)).toBe(true);
            expect(getQueue(id).find(t => t.id === dependent.id)!.autoLaunch?.reason).not.toBe('dependencies_unsatisfied');
            expect(launchCliCalls(components)).toBe(1);
        } finally {
            cleanup(id);
        }
    });
});

// ── 4. Structural pins over BOTH scheduling surfaces ─────────────────────────
//
// Pins the STRUCTURE of every surface so that inlining the dependency logic
// or bolting condition/gate/workspace checks onto a surface fails this suite. The former third surface — the mcp-server's cloud
// eager P2P push in mesh-tools-queue.ts — was retired (rc.37 Finding B: it sent
// still-`pending` rows straight to a remote session with no claim and no
// attempt); a pin below keeps the enqueue tools from becoming a scheduling
// surface again.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '../../src');
// The enqueue tools and the view/cancel/requeue tools (mesh-tools-queue-manage.ts,
// split out of mesh-tools-queue.ts) are both read.
const MCP_TOOLS_QUEUE = path.resolve(TEST_DIR, '../../../mcp-server/src/tools/mesh-tools-queue.ts');
const MCP_TOOLS_QUEUE_MANAGE = path.resolve(TEST_DIR, '../../../mcp-server/src/tools/mesh-tools-queue-manage.ts');

interface SurfacePin {
    name: string;
    file: string;
    /** The exact gating call site(s) that must exist verbatim. */
    gateCalls: string[];
    /** Files that must never grow condition/gate/workspace checks. */
    forbidGraphTokens: boolean;
}

const SCHEDULER_SURFACES: SurfacePin[] = [
    {
        name: 'queue claim (claimNextQueueTask)',
        // claimNextQueueTask moved out of mesh-runtime-store.ts into mesh-runtime-store-claim.ts
        // (self-delegate move). Only the path follows it.
        file: path.join(SRC_ROOT, 'mesh/mesh-runtime-store-claim.ts'),
        gateCalls: ['taskDependenciesSatisfied(candidate, depStatus)'],
        forbidGraphTokens: true,
    },
    {
        name: 'auto-launch candidate filter (maybeAutoLaunchOneQueueSession)',
        // maybeAutoLaunchOneQueueSession moved out of mesh-queue-assignment.ts into
        // mesh-queue-autolaunch.ts (pure move). Only the path follows it.
        file: path.join(SRC_ROOT, 'mesh/mesh-queue-autolaunch.ts'),
        gateCalls: ['taskDependenciesSatisfied(task, statusById)'],
        forbidGraphTokens: true,
    },
];

// A forked gate looks like `depStatus.get(id) === 'completed'` beside a dependsOn
// scan — dependency readiness computed WITHOUT the predicate.
const INLINE_FORK_PATTERN = /\b(depStatus|statusById|dependencyStatusById)\s*\.get\([^)]*\)\s*={2,3}\s*'completed'/;
// Concerns that must never be checked by a scheduling surface itself: conditions,
// gate state, workspace state (the retired graph layer's vocabulary).
const GRAPH_TOKEN_PATTERN = /run_if|inputs_from|workspace_ref|coordinator_gate|graph_materialization_pending/;

describe('structural pins: every scheduler surface gates through the one predicate', () => {
    it('enumerates exactly the two known scheduling surfaces', () => {
        expect(SCHEDULER_SURFACES.map(s => s.name)).toEqual([
            'queue claim (claimNextQueueTask)',
            'auto-launch candidate filter (maybeAutoLaunchOneQueueSession)',
        ]);
    });

    for (const surface of SCHEDULER_SURFACES) {
        describe(surface.name, () => {
            it('calls taskDependenciesSatisfied at the gate', () => {
                const src = fs.readFileSync(surface.file, 'utf8');
                for (const call of surface.gateCalls) {
                    expect(src.includes(call), `${path.basename(surface.file)} must gate through \`${call}\``).toBe(true);
                }
            });

            it('imports the shared predicate (no local copy)', () => {
                const src = fs.readFileSync(surface.file, 'utf8');
                expect(
                    /import\s*(?:type\s*)?\{[\s\S]*?\btaskDependenciesSatisfied\b[\s\S]*?\}\s*from\s*'[^']+'/.test(src),
                    `${path.basename(surface.file)} must import taskDependenciesSatisfied, not redefine it`,
                ).toBe(true);
            });

            it('carries the DEPENDSON-GATE-SYMMETRY boundary marker', () => {
                const src = fs.readFileSync(surface.file, 'utf8');
                expect(src).toContain('DEPENDSON-GATE-SYMMETRY');
            });

            it('does NOT re-implement dependency readiness inline (mutation guard)', () => {
                const src = fs.readFileSync(surface.file, 'utf8');
                expect(INLINE_FORK_PATTERN.test(src),
                    `${path.basename(surface.file)} must not inline \`statusById.get(id) === 'completed'\` beside the predicate`).toBe(false);
            });

            if (surface.forbidGraphTokens) {
                it('does NOT grow condition/gate/workspace checks of its own', () => {
                    const src = fs.readFileSync(surface.file, 'utf8');
                    expect(GRAPH_TOKEN_PATTERN.test(src),
                        `${path.basename(surface.file)} must not evaluate run_if/gate/workspace state — readiness is the predicate alone`).toBe(false);
                });
            }
        });
    }

    it('the enqueue tools are NOT a scheduling surface: they never send a task body themselves (rc.37 Finding B)', () => {
        const src = [MCP_TOOLS_QUEUE, MCP_TOOLS_QUEUE_MANAGE].map(file => fs.readFileSync(file, 'utf8')).join('\n');
        // Delivery is only through a claim (tryAssignQueueTask opens the attempt,
        // then sends). A direct send from the enqueue tools bypasses the claim
        // gates, the attempt and the dependency predicate all at once.
        expect(/\bipcDispatchToRemoteAgent\b/.test(src), 'mesh-tools-queue.ts must not dispatch to a remote agent').toBe(false);
        // (agent_command action:'stop' on cancel is legitimate; a SEND is not.)
        expect(src.includes("'send_chat'"), 'mesh-tools-queue.ts must not send a chat body').toBe(false);
        expect(src.includes('taskDependenciesSatisfied('), 'no gate call left to keep in sync — the claim path gates').toBe(false);
    });

    it('the predicate itself is unchanged: no run_if/gate/workspace/skip handling inside it', () => {
        // C-W9a: the predicate moved (verbatim) into the pure leaf mesh-task-predicates.ts.
        const src = fs.readFileSync(path.join(SRC_ROOT, 'mesh/mesh-task-predicates.ts'), 'utf8');
        const fnStart = src.indexOf('export function taskDependenciesSatisfied');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
        // Exactly: every dep completed → true. Nothing else.
        expect(fnBody).not.toContain('blockedReason');
        expect(fnBody).toContain("statusById.get(depId) === 'completed'");
        expect(GRAPH_TOKEN_PATTERN.test(fnBody)).toBe(false);
        expect(fnBody).not.toContain('skipped');
    });
});
