import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testTmpDir = join(tmpdir(), `adhdev-route-preview-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'preview-test-machine' }),
}));

const detectCliMocks = vi.hoisted(() => ({ detected: new Set<string>() }));
vi.mock('../../src/detection/cli-detector.js', () => ({
    detectCLI: async (id: string) => detectCliMocks.detected.has(id)
        ? { id, installed: true, path: `/mock/${id}` }
        : null,
}));

import { __resolveUsableProviderForTests } from '../../src/mesh/mesh-queue-assignment.js';
import { buildNodeRoutePreview } from '../../src/mesh/mesh-route-preview.js';
import { __replaceMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

const NOW = 2_000_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MESH_ID = 'mesh_preview';
const NODE_ID = 'node_preview';

function makeComponents() {
    return {
        providerLoader: {
            resolveAlias: (type: string) => type,
            isMachineProviderEnabled: () => true,
            setCliDetectionResults: () => {},
        },
    } as any;
}

function quota(provider: string, args: {
    weeklyRemaining?: number;
    weeklyResetsAt?: number;
    sessionRemaining?: number;
    status?: string;
    updatedAt?: number;
    failureKind?: string;
} = {}) {
    const weeklyRemaining = args.weeklyRemaining ?? 50;
    const sessionRemaining = args.sessionRemaining ?? 50;
    return {
        provider,
        status: args.status ?? 'ok',
        session: args.status && args.status !== 'ok'
            ? null
            : { usedPercent: 100 - sessionRemaining, windowMinutes: 300, resetsAt: NOW + 5 * 60 * MIN },
        weekly: args.status && args.status !== 'ok'
            ? null
            : { usedPercent: 100 - weeklyRemaining, windowMinutes: 10080, resetsAt: args.weeklyResetsAt ?? NOW + 3 * DAY },
        updatedAt: args.updatedAt ?? NOW,
        error: args.status && args.status !== 'ok' ? args.failureKind ?? 'probe failed' : null,
        ...(args.failureKind ? { metadata: { failureKind: args.failureKind } } : {}),
    };
}

function nodeWith(slots: any[], quotaFacts?: Record<string, any>, providerEnablement?: Record<string, any>) {
    return {
        id: NODE_ID,
        workspace: '/preview',
        userOverrides: {},
        policy: { slots },
        nodeFacts: {
            schemaVersion: 1,
            reportedAt: NOW,
            ...(quotaFacts ? { quota: quotaFacts } : {}),
            ...(providerEnablement ? { providerEnablement } : {}),
        },
    };
}

function preview(node: any, difficulty: 'easy' | 'medium' | 'difficult' | 'freeform' = 'difficult') {
    return buildNodeRoutePreview({
        meshId: MESH_ID,
        nodeId: NODE_ID,
        node,
        meshNodes: [node],
        task: { difficulty },
        quotaFactsContext: { nodes: [node] },
        now: NOW,
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    detectCliMocks.detected.clear();
});

afterEach(() => {
    vi.useRealTimers();
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('mesh route preview', () => {
    it('predicts the same winner as the production provider resolver, including a Stage 3 reversal', async () => {
        detectCliMocks.detected.add('fitness-first').add('quota-first');
        const node = nodeWith([
            { provider: 'fitness-first', model: 'model-a', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'quota-first', model: 'model-b', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'fitness-first': quota('fitness-first', {
                weeklyRemaining: 100,
                weeklyResetsAt: NOW + 7 * DAY,
                sessionRemaining: 100,
            }),
            'quota-first': quota('quota-first', {
                weeklyRemaining: 20,
                weeklyResetsAt: NOW + MIN,
                sessionRemaining: 100,
            }),
        });

        const predicted = preview(node);
        const actual = await __resolveUsableProviderForTests(
            makeComponents(), NODE_ID, node, MESH_ID, undefined,
            { difficulty: 'difficult' }, null, { nodes: [node] },
        );

        expect(predicted.predictedWinner?.providerType).toBe(actual.providerType);
        expect(predicted.stages.fitness[0]).toMatchObject({ providerType: 'fitness-first', total: 131 });
        expect(predicted.stages.quota).toMatchObject({
            fitnessWinner: 'fitness-first',
            winner: 'quota-first',
            reordered: true,
            displacedFitnessWinner: 'fitness-first',
        });
    });

    it('keeps higher difficulty tiers out of the admitted tier for a medium task', () => {
        const node = nodeWith([
            { provider: 'medium-provider', model: 'medium-model', difficulty: ['medium'] },
            { provider: 'difficult-provider', model: 'difficult-model', difficulty: ['difficult'] },
        ]);

        const result = preview(node, 'medium');
        expect(result.stages.difficultyFloor.admittedSlots.map(slot => slot.providerType)).toEqual(['medium-provider']);
        expect(result.stages.difficultyFloor.excludedSlots).toEqual([
            expect.objectContaining({ providerType: 'difficult-provider', reason: 'higher_difficulty_tier_deferred' }),
        ]);
        expect(result.stages.quota.fitnessOrder).toEqual(['medium-provider']);
    });

    it('scores the freeform difficulty axis as zero for graded and ungraded slots', () => {
        const node = nodeWith([
            { provider: 'graded', difficulty: ['difficult'] },
            { provider: 'ungraded' },
        ]);
        const result = preview(node, 'freeform');
        expect(result.stages.fitness.map(slot => slot.difficulty)).toEqual([0, 0]);
    });

    it('explains stale, no-data, and opted-out zero quota bonuses', () => {
        const node = nodeWith([
            { provider: 'stale', difficulty: ['difficult'] },
            { provider: 'no-data', difficulty: ['difficult'] },
            { provider: 'opted-out', difficulty: ['difficult'] },
        ], {
            // 'stale' now means "every measured window is past its OWN reset"
            // (2026-08-24 window-boundary validity) — a merely wall-clock-old
            // reading whose windows are still running keeps its bonus, so the
            // stale fixture must place the reset boundaries in the past.
            stale: {
                ...quota('stale', { updatedAt: NOW - 2 * 60 * MIN }),
                session: { usedPercent: 50, windowMinutes: 300, resetsAt: NOW - 30 * MIN },
                weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: NOW - 10 * MIN },
            },
            'no-data': quota('no-data', { status: 'unavailable', failureKind: 'no-data' }),
        }, {
            stale: { enabled: true, quotaEnabled: true },
            'no-data': { enabled: true, quotaEnabled: true },
            'opted-out': { enabled: true, quotaEnabled: false },
        });

        const byProvider = new Map(preview(node).quotaDiagnostics.map(entry => [entry.providerType, entry]));
        expect(byProvider.get('stale')?.bonus).toMatchObject({ value: 0, zeroReason: 'stale' });
        expect(byProvider.get('no-data')?.bonus).toMatchObject({ value: 0, zeroReason: 'no-data' });
        expect(byProvider.get('opted-out')?.bonus).toMatchObject({ value: 0, zeroReason: 'opted-out' });
    });

    it('distinguishes the unique fresh quota-exhausted hard block from other fail-open errors', () => {
        const node = nodeWith([
            { provider: 'hard-blocked', difficulty: ['difficult'] },
            { provider: 'fails-open', difficulty: ['difficult'] },
        ], {
            'hard-blocked': quota('hard-blocked', { status: 'error', failureKind: 'quota-exhausted' }),
            'fails-open': quota('fails-open', { status: 'error', failureKind: 'network' }),
        });

        const byProvider = new Map(preview(node).quotaDiagnostics.map(entry => [entry.providerType, entry]));
        expect(byProvider.get('hard-blocked')?.gate).toMatchObject({ outcome: 'hard-block' });
        expect(byProvider.get('fails-open')?.gate).toMatchObject({ outcome: 'fail-open' });
    });

    it('uses capacity as the first slot-order key and exposes the physical cap snapshot', () => {
        const node = nodeWith([
            { provider: 'busy', model: 'busy-model', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'idle', model: 'idle-model', difficulty: ['difficult'], maxParallel: 1 },
        ]);
        const stamp = new Date(NOW).toISOString();
        __replaceMeshQueueForTests(MESH_ID, [{
            id: 'busy-task', meshId: MESH_ID, message: 'busy', status: 'assigned',
            assignedNodeId: NODE_ID, assignedProviderType: 'busy', assignedModel: 'busy-model',
            assignedSessionId: 'busy-session', createdAt: stamp, updatedAt: stamp,
        }] as any);

        const result = preview(node);
        expect(result.stages.fitness.map(slot => slot.providerType)).toEqual(['idle', 'busy']);
        expect(result.stages.fitness[0].capacitySortKey).toBe(1);
        expect(result.stages.fitness[1]).toMatchObject({
            providerType: 'busy',
            capacitySortKey: 0,
            capacity: { available: false, slotCap: 1 },
        });
    });

    it('does not apply the durable five-entry array cap to in-memory preview details', () => {
        const slots = Array.from({ length: 7 }, (_, index) => ({
            provider: `provider-${index}`,
            difficulty: ['difficult'],
        }));
        const result = preview(nodeWith(slots));
        expect(result.stages.fitness).toHaveLength(7);
        expect(result.stages.quota.fitnessOrder).toHaveLength(7);
    });
});

/**
 * These cases exist because the preview used to report a Stage 3 reversal
 * WITHOUT reporting why: `fitnessWinner` named the loser, `selectionRank: 0`
 * sat on it, `gate.outcome` said 'clear' for both, and the risk numbers the
 * sort actually compared were computed and discarded. Two
 * independent investigations read that output and disagreed about whether the
 * reversal was a bug. The assertions below pin the evidence, not the ordering
 * — the ordering is owned by the reversal case above and by
 * mesh-quota-routing.test.ts.
 */
describe('mesh route preview — reordering evidence', () => {
    function reversalNode() {
        detectCliMocks.detected.add('fitness-first').add('quota-first');
        return nodeWith([
            { provider: 'fitness-first', model: 'model-a', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'quota-first', model: 'model-b', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'fitness-first': quota('fitness-first', {
                weeklyRemaining: 100,
                weeklyResetsAt: NOW + 7 * DAY,
                sessionRemaining: 100,
            }),
            'quota-first': quota('quota-first', {
                weeklyRemaining: 20,
                weeklyResetsAt: NOW + MIN,
                sessionRemaining: 100,
            }),
        });
    }

    it('exposes the ranking numbers that decided the reversal, per candidate', () => {
        const result = preview(reversalNode());
        const byProvider = new Map(result.quotaDiagnostics.map(entry => [entry.providerType, entry]));

        const loser = byProvider.get('fitness-first');
        const winner = byProvider.get('quota-first');
        // Both cleared the gate — which is exactly why 'clear' alone never
        // identified the winner, and why `ranking` has to.
        expect(loser?.gate.outcome).toBe('clear');
        expect(winner?.gate.outcome).toBe('clear');

        // quota-first: 20% remaining, weekly window all but elapsed → nearly
        // all of that remainder evaporates at the imminent reset.
        expect(winner?.ranking?.axis).toBe('weekly');
        expect(winner?.ranking?.remainingPercent).toBe(20);
        expect(winner!.ranking!.risk).toBeGreaterThan(19);
        expect(winner?.ranking).not.toHaveProperty('confidence');
        expect(winner?.ranking).not.toHaveProperty('rankedRisk');
        expect(winner?.ranking?.clearOrderIndex).toBe(0);

        // fitness-first: a full remainder whose window has just reset scores
        // ~0 — there is plenty of time left to spend it.
        expect(loser?.ranking?.remainingPercent).toBe(100);
        expect(loser!.ranking!.risk).toBe(0);
        expect(loser?.ranking?.clearOrderIndex).toBe(1);

        // The decision in one comparison: the reversal is the raw risk gap.
        expect(winner!.ranking!.risk!).toBeGreaterThan(loser!.ranking!.risk!);
    });

    it('shows a stale reading winning at full risk with no confidence discount fields', () => {
        detectCliMocks.detected.add('fresh-claude').add('stale-codex');
        const node = nodeWith([
            { provider: 'fresh-claude', difficulty: ['difficult'] },
            { provider: 'stale-codex', difficulty: ['difficult'] },
        ], {
            'fresh-claude': quota('fresh-claude', {
                weeklyRemaining: 20,
                weeklyResetsAt: NOW + MIN,
                sessionRemaining: 20,
            }),
            'stale-codex': quota('stale-codex', {
                weeklyRemaining: 80,
                weeklyResetsAt: NOW + 5 * DAY,
                sessionRemaining: 20,
                updatedAt: NOW - 145 * MIN,
            }),
        });

        const result = preview(node);
        const byProvider = new Map(result.quotaDiagnostics.map(entry => [entry.providerType, entry]));
        expect(result.stages.fitness[0].providerType).toBe('fresh-claude');
        expect(result.stages.quota.winner).toBe('stale-codex');
        expect(byProvider.get('stale-codex')!.ranking!.risk!)
            .toBeGreaterThan(byProvider.get('fresh-claude')!.ranking!.risk!);
        expect(byProvider.get('stale-codex')?.ranking).not.toHaveProperty('confidence');
        expect(byProvider.get('stale-codex')?.ranking).not.toHaveProperty('rankedRisk');
    });

    it('names the input order as input, and states the axis it ranked on', () => {
        const stage = preview(reversalNode()).stages.quota;
        expect(stage.fitnessOrderHead).toBe('fitness-first');
        expect(stage.fitnessWinner).toBe(stage.fitnessOrderHead); // alias, same value
        expect(stage.winner).toBe('quota-first');
        expect(stage.note).toContain('INPUT order');
        // quota-first sits at 20% weekly, at/below the 40% headroom threshold,
        // so the weekly axis governs and the 5h axis stays off.
        expect(stage.sessionAxisActive).toBe(false);
        expect(stage.axis).toBe('weekly');
        expect(preview(reversalNode()).stages.fitness[0]).toMatchObject({
            providerType: 'fitness-first',
            selectionRank: 0,
            fitnessInputRank: 0,
        });
    });

    it('reports the session axis when every weekly reading has headroom to spare', () => {
        detectCliMocks.detected.add('roomy-a').add('roomy-b');
        const node = nodeWith([
            { provider: 'roomy-a', model: 'model-a', difficulty: ['difficult'] },
            { provider: 'roomy-b', model: 'model-b', difficulty: ['difficult'] },
        ], {
            // Both far above the 40% weekly-headroom threshold → session axis.
            'roomy-a': quota('roomy-a', { weeklyRemaining: 90, sessionRemaining: 80 }),
            'roomy-b': quota('roomy-b', { weeklyRemaining: 95, sessionRemaining: 60 }),
        });

        const result = preview(node);
        expect(result.stages.quota.sessionAxisActive).toBe(true);
        expect(result.stages.quota.axis).toBe('session');
        for (const entry of result.quotaDiagnostics) {
            expect(entry.ranking?.axis).toBe('session');
        }
    });
});
