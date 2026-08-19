import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// GRAPH-ORCHESTRATION Phase G — scheduler dependency-gate MUTATION suite.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :14-25   — taskDependenciesSatisfied is THE one predicate; semantics are exactly
//                "all dependsOn statuses completed && !blockedReason".
//     :781-786 — P3 invariant tests: "Add a mutation test: changing any one surface
//                to inline dependency logic must fail."
//
//   The companion file mesh-scheduler-dependency-gate-invariant.test.ts is the
//   CHARACTERIZATION suite (spy counts + static-regex guard). This file proves the
//   guard has TEETH, in two layers:
//
//     (1) RUNTIME MUTATION — swap the predicate on the shared mesh-work-queue
//         module namespace (the same spy mechanism the invariant test documents:
//         mesh-work-queue ↔ mesh-runtime-store is circular, so a namespace spyOn is
//         the only wrap every importer observes) with "inline dependency logic"
//         mutants. Each mutant must VISIBLY BREAK the pinned behavior — e.g. a
//         dependent whose predecessor is pending becomes claimable — which is
//         exactly what the invariant suite asserts against. We assert the wrong
//         behavior occurs under the mutant (the red characterization), then restore
//         and re-assert the correct behavior on a fresh scenario.
//
//     (2) SOURCE-TEXT MUTATION — read the real surface sources, produce in-memory
//         mutated copies that replace the `taskDependenciesSatisfied(...)` gate call
//         with an inline equivalent, and assert the invariant suite's static guard
//         (the INLINE_FORK_PATTERN regex + the gate-call pin, re-implemented here)
//         FLAGS the mutated copies and PASSES the pristine sources.
//
//   The eager-push surface lives in the mcp-server package (node:test runner, no
//   cross-package module spy), so — exactly as in the invariant suite — it is
//   covered by the source-text layer only; its runtime behavior is pinned by
//   oss/packages/mcp-server/test/mesh-dependson-eager-push-gate.test.ts.

const testTmpDir = path.join(tmpdir(), `adhdev-dep-gate-mutation-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

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
    updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { triggerMeshQueue } from '../../src/mesh/mesh-events.js';
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js';

const NODE_ID = 'node_main';

function meshId(tag: string): string {
    return `mesh_gatemut_${tag}_${randomUUID().slice(0, 8)}`;
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

// ── The mutants: "inline dependency logic" replacements for the one predicate ──
// Each one is a plausible way a surface could stop calling
// `taskDependenciesSatisfied` and recompute readiness on its own — the fork the
// DEPENDSON-GATE-SYMMETRY boundary forbids (design :984-986).
const MUTANTS = {
    /** No dependency check at all — the gate is simply bypassed. */
    alwaysTrue: () => true,
    /** All deps completed, but the system-block half of the predicate is dropped. */
    ignoresBlockedReason: (entry: any, statusById: Map<string, string>) =>
        (Array.isArray(entry.dependsOn) ? entry.dependsOn : [])
            .every((id: string) => statusById.get(id) === 'completed'),
    /** Teaches the gate a skip rule the predicate deliberately does not have (:357-359). */
    skippedSatisfies: (entry: any, statusById: Map<string, string>) =>
        (Array.isArray(entry.dependsOn) ? entry.dependsOn : [])
            .every((id: string) => {
                const s = statusById.get(id);
                return s === 'completed' || s === 'skipped';
            }),
} as const;

function mutatePredicate(mutant: (entry: any, statusById: Map<string, string>) => boolean) {
    return vi.spyOn(wq, 'taskDependenciesSatisfied').mockImplementation(mutant as any);
}

// ── Scenario builders (mirrors the invariant suite's harness) ────────────────

type Scenario = { dep: any; dependent: any };

function setEntry(entry: any, over: Record<string, unknown>) {
    MeshRuntimeStore.getInstance().updateQueueEntry({
        ...entry, ...over, updatedAt: new Date().toISOString(),
    } as any);
}

/** Dependent pending; predecessor NOT completed and NOT a claim candidate. */
function claimScenarioUnmet(id: string): Scenario {
    const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
    // Park the predecessor on a DIFFERENT node so it is neither a pending candidate
    // nor a node-conflict for the claim under test.
    setEntry(dep, { status: 'assigned', assignedNodeId: 'node_other', assignedSessionId: 'other-sess' });
    const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });
    return { dep, dependent };
}

/** Dependent pending with a system block; predecessor completed. */
function claimScenarioBlocked(id: string): Scenario {
    const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
    const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });
    updateTaskStatus(id, dep.id, 'completed');
    setEntry(getQueue(id).find(t => t.id === dependent.id)!, { blockedReason: 'graph_materialization_pending:node-1' });
    return { dep, dependent };
}

/** Dependent pending; predecessor SKIPPED (terminal for graph accounting only). */
function claimScenarioSkipped(id: string): Scenario {
    const dep = enqueueTask(id, 'prerequisite', { taskMode: 'code_change', difficulty: 'medium' });
    const dependent = enqueueTask(id, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id], difficulty: 'medium' });
    setEntry(dep, { status: 'skipped' });
    return { dep, dependent };
}

function setMesh(id: string) {
    meshConfigMocks.getMesh.mockReturnValue({
        id,
        name: 'Gate Mutation Mesh',
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

// ── 1. Runtime mutation layer (design :783) ──────────────────────────────────
//
// Each test applies ONE mutant, drives ONE surface, and asserts the mutant
// produces the behavior the invariant suite FORBIDS — i.e. if this mutant were
// ever real, the characterization suite would go red. The mutant is then
// restored and a FRESH mesh re-asserts the pinned behavior (the suite's green
// baseline), proving the break came from the mutation, not the scenario.

describe('runtime mutation: inlining dependency logic visibly breaks the gate (design :783)', () => {
    describe('mutant: always-true (gate bypassed)', () => {
        it('claim: a dependent with a PENDING predecessor becomes claimable — then is refused again after restore', () => {
            const mutatedId = meshId('rt_always_claim');
            try {
                const { dependent } = claimScenarioUnmet(mutatedId);
                mutatePredicate(MUTANTS.alwaysTrue);
                // RED characterization: the invariant suite (SURFACE claim) pins
                // claimNextTask → null for exactly this scenario.
                const claimed = claimNextTask(mutatedId, NODE_ID, 'mut-sess-1');
                expect(claimed?.id).toBe(dependent.id);
            } finally {
                cleanup(mutatedId);
            }

            vi.restoreAllMocks();
            const restoredId = meshId('rt_always_claim_restored');
            try {
                const { dependent } = claimScenarioUnmet(restoredId);
                expect(claimNextTask(restoredId, NODE_ID, 'mut-sess-2')).toBeNull();
                expect(getQueue(restoredId).find(t => t.id === dependent.id)!.status).toBe('pending');
            } finally {
                cleanup(restoredId);
            }
        });

        it('auto-launch: spawns a session for an unmet dependent — then skips it after restore', async () => {
            const mutatedId = meshId('rt_always_al');
            try {
                setMesh(mutatedId);
                const components = createComponents([]);
                claimScenarioUnmet(mutatedId);
                mutatePredicate(MUTANTS.alwaysTrue);
                await triggerMeshQueue(components, mutatedId);
                // RED characterization: the invariant suite pins 0 launches and
                // autoLaunch.reason === 'dependencies_unsatisfied' here.
                expect(launchCliCalls(components)).toBe(1);
            } finally {
                cleanup(mutatedId);
            }

            vi.restoreAllMocks();
            const restoredId = meshId('rt_always_al_restored');
            try {
                setMesh(restoredId);
                const components = createComponents([]);
                const { dependent } = claimScenarioUnmet(restoredId);
                await triggerMeshQueue(components, restoredId);
                expect(launchCliCalls(components)).toBe(0);
                expect(getQueue(restoredId).find(t => t.id === dependent.id)!.autoLaunch?.reason).toBe('dependencies_unsatisfied');
            } finally {
                cleanup(restoredId);
            }
        });
    });

    describe('mutant: deps completed but blockedReason ignored', () => {
        it('claim: a system-blocked dependent becomes claimable — then is refused again after restore', () => {
            const mutatedId = meshId('rt_noblock_claim');
            try {
                const { dependent } = claimScenarioBlocked(mutatedId);
                mutatePredicate(MUTANTS.ignoresBlockedReason);
                // RED characterization: the invariant suite pins claimNextTask → null
                // for a blockedReason-carrying task whose deps are all completed.
                const claimed = claimNextTask(mutatedId, NODE_ID, 'mut-sess-3');
                expect(claimed?.id).toBe(dependent.id);
            } finally {
                cleanup(mutatedId);
            }

            vi.restoreAllMocks();
            const restoredId = meshId('rt_noblock_claim_restored');
            try {
                claimScenarioBlocked(restoredId);
                expect(claimNextTask(restoredId, NODE_ID, 'mut-sess-4')).toBeNull();
            } finally {
                cleanup(restoredId);
            }
        });

        it('auto-launch: spawns a session for a system-blocked dependent — then skips it after restore', async () => {
            const mutatedId = meshId('rt_noblock_al');
            try {
                setMesh(mutatedId);
                const components = createComponents([]);
                claimScenarioBlocked(mutatedId);
                mutatePredicate(MUTANTS.ignoresBlockedReason);
                await triggerMeshQueue(components, mutatedId);
                expect(launchCliCalls(components)).toBe(1);
            } finally {
                cleanup(mutatedId);
            }

            vi.restoreAllMocks();
            const restoredId = meshId('rt_noblock_al_restored');
            try {
                setMesh(restoredId);
                const components = createComponents([]);
                const { dependent } = claimScenarioBlocked(restoredId);
                await triggerMeshQueue(components, restoredId);
                expect(launchCliCalls(components)).toBe(0);
                expect(getQueue(restoredId).find(t => t.id === dependent.id)!.autoLaunch?.reason).toBe('dependencies_unsatisfied');
            } finally {
                cleanup(restoredId);
            }
        });
    });

    describe('mutant: skipped satisfies a dependency', () => {
        it('claim: a dependent of a SKIPPED predecessor becomes claimable — then is refused again after restore', () => {
            const mutatedId = meshId('rt_skip_claim');
            try {
                const { dependent } = claimScenarioSkipped(mutatedId);
                mutatePredicate(MUTANTS.skippedSatisfies);
                // RED characterization: design :357-359 + the invariant suite pin
                // 'skipped' as NOT satisfying the predicate.
                const claimed = claimNextTask(mutatedId, NODE_ID, 'mut-sess-5');
                expect(claimed?.id).toBe(dependent.id);
            } finally {
                cleanup(mutatedId);
            }

            vi.restoreAllMocks();
            const restoredId = meshId('rt_skip_claim_restored');
            try {
                const { dependent } = claimScenarioSkipped(restoredId);
                expect(claimNextTask(restoredId, NODE_ID, 'mut-sess-6')).toBeNull();
                expect(getQueue(restoredId).find(t => t.id === dependent.id)!.status).toBe('pending');
            } finally {
                cleanup(restoredId);
            }
        });

        it('auto-launch: spawns a session for a dependent of a skipped predecessor — then skips it after restore', async () => {
            const mutatedId = meshId('rt_skip_al');
            try {
                setMesh(mutatedId);
                const components = createComponents([]);
                claimScenarioSkipped(mutatedId);
                mutatePredicate(MUTANTS.skippedSatisfies);
                await triggerMeshQueue(components, mutatedId);
                expect(launchCliCalls(components)).toBe(1);
            } finally {
                cleanup(mutatedId);
            }

            vi.restoreAllMocks();
            const restoredId = meshId('rt_skip_al_restored');
            try {
                setMesh(restoredId);
                const components = createComponents([]);
                const { dependent } = claimScenarioSkipped(restoredId);
                await triggerMeshQueue(components, restoredId);
                expect(launchCliCalls(components)).toBe(0);
                expect(getQueue(restoredId).find(t => t.id === dependent.id)!.autoLaunch?.reason).toBe('dependencies_unsatisfied');
            } finally {
                cleanup(restoredId);
            }
        });
    });
});

// ── 2. Source-text mutation layer (design :783) ──────────────────────────────
//
// The invariant suite's static guard pins every surface's SOURCE: the gate call
// must exist verbatim and no inline dependency-readiness fork may appear. Here
// we prove that guard actually FIRES: in-memory mutated copies of the real
// sources — with the predicate call replaced by an inline equivalent — must be
// flagged, while the pristine sources pass.
//
// These regexes are deliberately re-implemented (not imported — the invariant
// test exports nothing) and must stay byte-identical to the ones in
// mesh-scheduler-dependency-gate-invariant.test.ts.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '../../src');
const MCP_TOOLS_QUEUE = path.resolve(TEST_DIR, '../../../mcp-server/src/tools/mesh-tools-queue.ts');

// Same pattern as the invariant suite: `statusById.get(id) === 'completed'`
// beside a dependsOn scan — readiness computed WITHOUT the predicate.
const INLINE_FORK_PATTERN = /\b(depStatus|statusById|dependencyStatusById)\s*\.get\([^)]*\)\s*={2,3}\s*'completed'/;

interface SurfaceMutation {
    name: string;
    file: string;
    /** The exact gating call that must exist verbatim in the pristine source. */
    gateCall: string;
    /** Variables used to build the inline-fork replacement for this surface. */
    entryVar: string;
    statusMap: string;
    /** How many times the gate call appears in the pristine source. */
    occurrences: number;
}

const SURFACES: SurfaceMutation[] = [
    {
        name: 'queue claim (claimNextQueueTask)',
        file: path.join(SRC_ROOT, 'mesh/mesh-runtime-store.ts'),
        gateCall: 'taskDependenciesSatisfied(candidate, depStatus)',
        entryVar: 'candidate', statusMap: 'depStatus', occurrences: 1,
    },
    {
        name: 'auto-launch candidate filter (maybeAutoLaunchOneQueueSession)',
        file: path.join(SRC_ROOT, 'mesh/mesh-queue-assignment.ts'),
        gateCall: 'taskDependenciesSatisfied(task, statusById)',
        entryVar: 'task', statusMap: 'statusById', occurrences: 1,
    },
    {
        name: 'cloud eager P2P push (mesh_enqueue_task + mesh_enqueue_batch)',
        file: MCP_TOOLS_QUEUE,
        gateCall: 'taskDependenciesSatisfied(task, dependencyStatusById)',
        entryVar: 'task', statusMap: 'dependencyStatusById', occurrences: 2,
    },
];

/** The fork the DEPENDSON-GATE-SYMMETRY boundary forbids: the predicate's logic re-implemented inline. */
function inlineDependencyLogic(entryVar: string, statusMap: string): string {
    return `!${entryVar}.blockedReason && (Array.isArray(${entryVar}.dependsOn) ? ${entryVar}.dependsOn : [])`
        + `.every(id => ${statusMap}.get(id) === 'completed')`;
}

describe('source-text mutation: the static guard flags an inlined or bypassed gate', () => {
    it('pristine sources PASS the guard (baseline — must stay green)', () => {
        for (const surface of SURFACES) {
            const src = fs.readFileSync(surface.file, 'utf8');
            expect(src.split(surface.gateCall).length - 1, `${surface.name}: gate call count`).toBe(surface.occurrences);
            expect(INLINE_FORK_PATTERN.test(src), `${surface.name}: no inline fork`).toBe(false);
            expect(src, `${surface.name}: boundary marker`).toContain('DEPENDSON-GATE-SYMMETRY');
        }
    });

    for (const surface of SURFACES) {
        it(`${surface.name}: replacing the predicate call with inline logic is FLAGGED`, () => {
            const src = fs.readFileSync(surface.file, 'utf8');
            const mutated = src.split(surface.gateCall).join(inlineDependencyLogic(surface.entryVar, surface.statusMap));
            // The mutation actually applied to the real source text.
            expect(mutated).not.toBe(src);
            // Guard pin 1 — "calls taskDependenciesSatisfied at the gate": RED.
            expect(mutated.includes(surface.gateCall)).toBe(false);
            // Guard pin 2 — INLINE_FORK_PATTERN ("must not re-implement dependency
            // readiness inline"): RED.
            expect(INLINE_FORK_PATTERN.test(mutated)).toBe(true);
        });

        it(`${surface.name}: bypassing the gate outright (call → true) is FLAGGED by the gate-call pin`, () => {
            const src = fs.readFileSync(surface.file, 'utf8');
            const mutated = src.split(surface.gateCall).join('true');
            expect(mutated).not.toBe(src);
            // A bare bypass leaves no inline status scan for the regex to catch —
            // the gate-call pin is the one that fires. The two pins complement.
            expect(mutated.includes(surface.gateCall)).toBe(false);
            expect(INLINE_FORK_PATTERN.test(mutated)).toBe(false);
        });
    }
});
