import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase A — scheduler dependency-gate INVARIANT characterization.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :14-25   — taskDependenciesSatisfied is THE one predicate; semantics are exactly
//                "all dependsOn statuses completed && !blockedReason".
//     :71-97   — every scheduling surface must keep calling it, with no local
//                reinterpretation (the DEPENDSON-GATE-SYMMETRY boundary).
//     :779-786 — P3 invariant tests: enumerate claim / auto-launch / eager-push and
//                spy/assert every surface calls the predicate; inlining dependency
//                logic into any one surface must fail.
//     :984-986 — forbidden: modifying/wrapping/bypassing the predicate, or adding
//                run_if/gate/workspace/output/skip checks to the surfaces separately.
//
//   This is a CHARACTERIZATION suite: it pins the invariant as it exists TODAY so
//   that phases B–D go red the moment anyone forks, bypasses, or locally reinterprets
//   the gate. Two layers per surface:
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
        sawBlockedEntry: () =>
            spy.mock.calls.some(([entry]: any[]) => typeof entry?.blockedReason === 'string' && entry.blockedReason.length > 0),
    };
}

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
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { triggerMeshQueue } from '../../src/mesh/mesh-events.js';
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js';

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

describe('taskDependenciesSatisfied semantics — exactly "all deps completed && !blockedReason"', () => {
    const entry = (over: any = {}) => ({ dependsOn: ['a', 'b'], ...over });
    const status = (m: Record<string, string>) => new Map(Object.entries(m));

    it('true when every dependsOn id is completed and there is no system block', () => {
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

    it('skipped does NOT satisfy a dependency (design :357-359)', () => {
        // A conditionally skipped graph node is terminal for graph accounting but is
        // deliberately NOT 'completed' for the queue predicate — the graph layer must
        // rewrite the projection instead of teaching the scheduler a skip rule.
        expect(taskDependenciesSatisfied(entry(), status({ a: 'completed', b: 'skipped' }))).toBe(false);
    });

    it('any blockedReason blocks, even with every dependency completed (design :16-25)', () => {
        for (const block of ['graph_materialization_pending:n1', 'coordinator_gate:g1', 'policy_hold']) {
            expect(taskDependenciesSatisfied(entry({ blockedReason: block }), status({ a: 'completed', b: 'completed' })), block).toBe(false);
        }
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
            updateTaskStatus(id, dep.id, 'completed');

            const pred = spyOnPredicate();
            const claimed = claimNextTask(id, NODE_ID, 'claim-sess-2');

            expect(pred.count()).toBeGreaterThan(0);
            expect(claimed?.id).toBe(dependent.id);
        } finally {
            cleanup(id);
        }
    });

    it('consults the predicate and refuses a system-blocked task even with deps completed', () => {
        const id = meshId('claim_blocked');
        try {
            const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
            const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });
            updateTaskStatus(id, dep.id, 'completed');
            // A graph-owned system block (the shape B–D will use) must be refused by the
            // UNCHANGED predicate — no new claim-side check may be added for it.
            MeshRuntimeStore.getInstance().updateQueueEntry({
                ...getQueue(id).find(t => t.id === dependent.id)!,
                blockedReason: 'graph_materialization_pending:node-1',
                updatedAt: new Date().toISOString(),
            } as any);

            const pred = spyOnPredicate();
            const claimed = claimNextTask(id, NODE_ID, 'claim-sess-3');

            expect(claimed).toBeNull();
            expect(pred.sawBlockedEntry()).toBe(true);
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
    return {
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
    } as any;
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
            updateTaskStatus(id, dep.id, 'completed');

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

// ── 4. Structural pins over ALL THREE surfaces (incl. eager push) ────────────
//
// The eager-push gate lives in the mcp-server package (mesh-tools-queue.ts), whose
// node:test runner cannot module-spy. Its BEHAVIOR is already pinned by
// oss/packages/mcp-server/test/mesh-dependson-eager-push-gate.test.ts and
// mesh-enqueue-batch.test.ts; here we pin the STRUCTURE of every surface so that
// inlining the dependency logic (design :783 mutation test) or bolting graph
// checks onto a surface (design :984-986) fails this suite.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '../../src');
const MCP_TOOLS_QUEUE = path.resolve(TEST_DIR, '../../../mcp-server/src/tools/mesh-tools-queue.ts');

interface SurfacePin {
    name: string;
    file: string;
    /** The exact gating call site(s) that must exist verbatim. */
    gateCalls: string[];
    /** Files that must never grow graph-layer checks (design :92-96, :984-986). */
    forbidGraphTokens: boolean;
}

const SCHEDULER_SURFACES: SurfacePin[] = [
    {
        name: 'queue claim (claimNextQueueTask)',
        file: path.join(SRC_ROOT, 'mesh/mesh-runtime-store.ts'),
        gateCalls: ['taskDependenciesSatisfied(candidate, depStatus)'],
        // The runtime store legitimately hosts the phase-B graph store too, so only
        // the gate call + no-inline-fork are pinned here, not token absence.
        forbidGraphTokens: false,
    },
    {
        name: 'auto-launch candidate filter (maybeAutoLaunchOneQueueSession)',
        file: path.join(SRC_ROOT, 'mesh/mesh-queue-assignment.ts'),
        gateCalls: ['taskDependenciesSatisfied(task, statusById)'],
        forbidGraphTokens: true,
    },
    {
        name: 'cloud eager P2P push (mesh_enqueue_task + mesh_enqueue_batch)',
        file: MCP_TOOLS_QUEUE,
        gateCalls: ['taskDependenciesSatisfied(task, dependencyStatusById)'],
        forbidGraphTokens: true,
    },
];

// A forked gate looks like `depStatus.get(id) === 'completed'` beside a dependsOn
// scan — dependency readiness computed WITHOUT the predicate.
const INLINE_FORK_PATTERN = /\b(depStatus|statusById|dependencyStatusById)\s*\.get\([^)]*\)\s*={2,3}\s*'completed'/;
// Graph-layer concerns that must never be checked by a scheduling surface itself
// (design :984-986): conditions, gate state, workspace state, graph blocks.
const GRAPH_TOKEN_PATTERN = /run_if|inputs_from|workspace_ref|coordinator_gate|graph_materialization_pending/;

describe('structural pins: every scheduler surface gates through the one predicate (design :71-97)', () => {
    it('enumerates exactly the three known scheduling surfaces', () => {
        expect(SCHEDULER_SURFACES.map(s => s.name)).toEqual([
            'queue claim (claimNextQueueTask)',
            'auto-launch candidate filter (maybeAutoLaunchOneQueueSession)',
            'cloud eager P2P push (mesh_enqueue_task + mesh_enqueue_batch)',
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

            it('does NOT re-implement dependency readiness inline (mutation guard, design :783)', () => {
                const src = fs.readFileSync(surface.file, 'utf8');
                expect(INLINE_FORK_PATTERN.test(src),
                    `${path.basename(surface.file)} must not inline \`statusById.get(id) === 'completed'\` beside the predicate`).toBe(false);
            });

            if (surface.forbidGraphTokens) {
                it('does NOT grow run_if/gate/workspace/graph checks of its own (design :984-986)', () => {
                    const src = fs.readFileSync(surface.file, 'utf8');
                    expect(GRAPH_TOKEN_PATTERN.test(src),
                        `${path.basename(surface.file)} must not evaluate graph/run_if/gate/workspace state — a not-ready task stays pending with a system block and the UNCHANGED predicate refuses it`).toBe(false);
                });
            }
        });
    }

    it('eager push gates BOTH the single and batch enqueue paths', () => {
        const src = fs.readFileSync(MCP_TOOLS_QUEUE, 'utf8');
        const occurrences = src.split('taskDependenciesSatisfied(task, dependencyStatusById)').length - 1;
        expect(occurrences).toBe(2);
    });

    it('the predicate itself is unchanged: no graph/run_if/gate/workspace/skip handling inside it', () => {
        const src = fs.readFileSync(path.join(SRC_ROOT, 'mesh/mesh-work-queue.ts'), 'utf8');
        const fnStart = src.indexOf('export function taskDependenciesSatisfied');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
        // Exactly: block → false; every dep completed → true. Nothing else.
        expect(fnBody).toContain('if (entry.blockedReason) return false;');
        expect(fnBody).toContain("statusById.get(depId) === 'completed'");
        expect(GRAPH_TOKEN_PATTERN.test(fnBody)).toBe(false);
        expect(fnBody).not.toContain('skipped');
    });
});
