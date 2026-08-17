/**
 * DYNAMIC PROVIDER PRIORITY BY QUOTA — the quota gate lives INSIDE the
 * provider-selection loop.
 *
 * Previously the auto-launch drain resolved ONE (node, provider) pair and
 * applied evaluateProviderQuotaGate to it afterwards: a gated provider skipped
 * the whole NODE and the task moved to the next node, even when the node had a
 * second provider with quota to spare. The gate now runs inside
 * resolveUsableProvider (via rankProvidersByQuotaGate):
 *
 *   - every usable (detected) candidate is evaluated, not just the first;
 *   - a quota-gated first choice falls through to the node's NEXT provider;
 *   - gate-clear candidates are ordered by weekly EXPIRY RISK, descending
 *     (remaining × elapsed window fraction — an unused remainder evaporates
 *     at the window reset); remaining desc breaks risk ties, unknown-weekly
 *     candidates sort last, caller order preserved within each group;
 *   - when EVERY usable provider is gated the reason is the non-actionable
 *     ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON (a self-resolving WAIT), never the
 *     actionable 'provider_priority_unusable' (a slot configuration error);
 *   - fail-open is unchanged: missing / stale / unmarked transient readings
 *     are never BLOCKED, only out-ranked; fresh retained windows remain facts.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-provider-quota-priority-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

// CLI detection is exercised end-to-end elsewhere; here the "installed" set is
// the test's control surface for which providers are usable.
const detectCliMocks = vi.hoisted(() => ({ detected: new Set<string>() }));
vi.mock('../../src/detection/cli-detector.js', () => ({
    detectCLI: async (id: string) => detectCliMocks.detected.has(id)
        ? { id, installed: true, path: `/mock/${id}` }
        : null,
}));

import {
    __resolveUsableProviderForTests,
    __isActionableSkipReasonForTests,
    __recordTaskDispatchedLedgerForTests,
    __markAutoLaunchForTests,
    __resetDifficultyFloorReportsForTests,
    DIFFICULTY_FLOOR_REPORT_AFTER_MS,
} from '../../src/mesh/mesh-queue-assignment.js';
import { __replaceMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON } from '../../src/mesh/mesh-quota-routing.js';
import { buildAutoLaunchRoutingDecision } from '../../src/mesh/mesh-routing-decision.js';
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js';
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js';

const NODE_ID = 'node_quota_priority';
const MESH_ID = 'mesh_quota_priority';
const MIN = 60 * 1000;

function makeComponents() {
    return {
        providerLoader: {
            resolveAlias: (t: string) => t,
            isMachineProviderEnabled: () => true,
            setCliDetectionResults: () => {},
        },
    } as any;
}

function nodeWith(slots: any[], quota?: Record<string, any>) {
    return {
        id: NODE_ID,
        policy: { slots },
        ...(quota ? { nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), quota } } : {}),
    };
}

function okQuota(provider: string, over: Record<string, any> = {}) {
    return {
        provider,
        status: 'ok',
        session: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
        updatedAt: Date.now() - MIN,
        error: null,
        ...over,
    };
}

function exhaustedQuota(provider: string, over: Record<string, any> = {}) {
    return okQuota(provider, {
        status: 'error',
        session: null,
        weekly: null,
        error: 'usage limit reached (HTTP 403) — quota refreshes at the next reset',
        metadata: { source: 'oauth', failureKind: 'quota-exhausted' },
        ...over,
    });
}

async function resolve(node: any, quotaFactsContext?: { nodes?: any[] }, difficulty: 'easy' | 'medium' | 'difficult' | 'freeform' = 'difficult') {
    return __resolveUsableProviderForTests(
        makeComponents(), NODE_ID, node, MESH_ID,
        undefined,
        { difficulty, requiredTags: undefined },
        null,
        quotaFactsContext,
    );
}

beforeEach(() => {
    detectCliMocks.detected.clear();
});

afterEach(() => {
    vi.useRealTimers();
    __resetDifficultyFloorReportsForTests();
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('resolveUsableProvider — quota gate inside the selection loop', () => {
    it('logs an explicitly resolved sonnet slot score and identity, not the node-best opus score', () => {
        const node = nodeWith([
            { provider: 'claude-cli', model: 'sonnet', difficulty: ['medium'], maxParallel: 3 },
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ]);
        const decision = buildAutoLaunchRoutingDecision({
            node, meshId: MESH_ID, task: { difficulty: 'difficult' },
            resolved: {
                providerType: 'claude-cli', model: 'sonnet',
                slot: node.policy.slots[0],
            },
            skippedCandidates: [],
            requiredTagsResult: { required: [], satisfied: true, missing: [] },
            effectiveModel: 'sonnet',
        });
        __recordTaskDispatchedLedgerForTests({
            meshId: MESH_ID, nodeId: NODE_ID, sessionId: 'sonnet-session', providerType: 'claude-cli',
            task: { id: 'sonnet-task', meshId: MESH_ID, message: 'hard task', status: 'assigned' } as any,
            transport: 'local', routingDecision: decision,
        }, 'sonnet-delivery');

        const entry = readLedgerEntries(MESH_ID, { kind: ['task_dispatched'] })
            .find(candidate => candidate.taskId === 'sonnet-task');
        const routing = (entry?.payload as any)?.routingDecision;
        expect(routing.fitnessScore).toBe(1);
        expect(routing.fitnessScore).not.toBe(101);
        expect(routing.selectedSlot).toEqual({ providerType: 'claude-cli', model: 'sonnet' });
    });

    it('routes to available codex when opus is full, even when claude has higher quota-expiry risk', async () => {
        detectCliMocks.detected.add('claude-cli').add('codex-cli');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'sonnet', difficulty: ['medium'], maxParallel: 4 },
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'codex-cli', model: 'gpt-5.6-sol', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'claude-cli': okQuota('claude-cli', { weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: Date.now() + 2 * 60 * MIN } }),
            'codex-cli': okQuota('codex-cli', { weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: Date.now() + 5 * 24 * 60 * MIN } }),
        });
        __replaceMeshQueueForTests(MESH_ID, [{
            id: 'busy-opus', meshId: MESH_ID, message: 'busy', status: 'assigned',
            assignedNodeId: NODE_ID, assignedProviderType: 'claude-cli', assignedModel: 'opus',
            assignedSessionId: 'busy-opus-session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }] as any);

        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('codex-cli');
        expect(resolved.model).toBe('gpt-5.6-sol');
    });

    it('keeps quota-risk ranking inside the lowest sufficient difficulty tier', async () => {
        detectCliMocks.detected.add('claude-cli').add('codex-cli');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'sonnet', difficulty: ['medium'], maxParallel: 1 },
            { provider: 'codex-cli', model: 'gpt-5.6-sol', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'claude-cli': okQuota('claude-cli', { weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: Date.now() + 5 * 24 * 60 * MIN } }),
            'codex-cli': okQuota('codex-cli', { weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: Date.now() + 2 * 60 * MIN } }),
        });

        const resolved = await resolve(node, undefined, 'medium');
        expect(resolved.providerType).toBe('claude-cli');
        expect(resolved.model).toBe('sonnet');
    });

    it('keeps a difficult task pending when every difficult slot is full instead of selecting sonnet', async () => {
        detectCliMocks.detected.add('claude-cli').add('codex-cli');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'sonnet', difficulty: ['medium'], maxParallel: 4 },
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'codex-cli', model: 'gpt-5.6-sol', difficulty: ['difficult'], maxParallel: 1 },
        ]);
        const now = new Date().toISOString();
        __replaceMeshQueueForTests(MESH_ID, [
            { id: 'busy-opus', meshId: MESH_ID, message: 'busy', status: 'assigned', assignedNodeId: NODE_ID, assignedProviderType: 'claude-cli', assignedModel: 'opus', assignedSessionId: 'opus-session', createdAt: now, updatedAt: now },
            { id: 'busy-codex', meshId: MESH_ID, message: 'busy', status: 'assigned', assignedNodeId: NODE_ID, assignedProviderType: 'codex-cli', assignedModel: 'gpt-5.6-sol', assignedSessionId: 'codex-session', createdAt: now, updatedAt: now },
        ] as any);

        const resolved = await resolve(node);
        expect(resolved.providerType).toBeUndefined();
        expect(resolved.reason).toBe('task_difficulty_floor_wait:difficult');
        expect(__isActionableSkipReasonForTests(resolved.reason!)).toBe(false);
    });

    it('reports a continuous difficulty-floor wait once after ten minutes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
        __replaceMeshQueueForTests(MESH_ID, [{
            id: 'floor-timeout-task', meshId: MESH_ID, message: 'hard task', status: 'pending', difficulty: 'difficult',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }] as any);

        __markAutoLaunchForTests(MESH_ID, 'floor-timeout-task', {
            status: 'skipped', reason: 'task_difficulty_floor_wait:difficult', nodeId: NODE_ID,
        });
        expect(drainPendingMeshCoordinatorEvents(MESH_ID, 'test-machine')).toHaveLength(0);

        vi.advanceTimersByTime(DIFFICULTY_FLOOR_REPORT_AFTER_MS);
        __markAutoLaunchForTests(MESH_ID, 'floor-timeout-task', {
            status: 'skipped', reason: 'task_difficulty_floor_wait:difficult', nodeId: NODE_ID,
        });
        const [event] = drainPendingMeshCoordinatorEvents(MESH_ID, 'test-machine') as any[];
        expect(event?.metadataEvent).toEqual(expect.objectContaining({
            source: 'mesh_queue_difficulty_floor_timeout',
            taskId: 'floor-timeout-task',
            reason: 'task_difficulty_floor_timeout',
        }));
        expect(event?.coordinatorMessage).toContain('explicit task-scoped downgrade');

        __resetDifficultyFloorReportsForTests(); // simulate daemon restart: durable marker still dedupes
        __markAutoLaunchForTests(MESH_ID, 'floor-timeout-task', {
            status: 'skipped', reason: 'task_difficulty_floor_wait:difficult', nodeId: NODE_ID,
        });
        expect(drainPendingMeshCoordinatorEvents(MESH_ID, 'test-machine')).toHaveLength(0);
    });

    it('applies the same bounded report to an all-provider quota wait', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
        __replaceMeshQueueForTests(MESH_ID, [{
            id: 'quota-timeout-task', meshId: MESH_ID, message: 'hard task', status: 'pending', difficulty: 'difficult',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }] as any);
        const reason = `${ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON}: claude-cli exhausted`;

        __markAutoLaunchForTests(MESH_ID, 'quota-timeout-task', { status: 'skipped', reason, nodeId: NODE_ID });
        vi.advanceTimersByTime(DIFFICULTY_FLOOR_REPORT_AFTER_MS);
        __markAutoLaunchForTests(MESH_ID, 'quota-timeout-task', { status: 'skipped', reason, nodeId: NODE_ID });

        const [event] = drainPendingMeshCoordinatorEvents(MESH_ID, 'test-machine') as any[];
        expect(event?.metadataEvent).toEqual(expect.objectContaining({
            taskId: 'quota-timeout-task', reason: 'task_difficulty_floor_timeout', difficulty: 'difficult',
        }));
    });

    it('persists bounded intra-node losers and the quota-risk snapshot in the task ledger', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            kimi: okQuota('kimi', { weekly: { usedPercent: 60, windowMinutes: 10080, resetsAt: Date.now() + 5 * 24 * 60 * MIN } }),
            'claude-cli': okQuota('claude-cli', { weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: Date.now() + 2 * 60 * MIN } }),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('claude-cli');
        const decision = buildAutoLaunchRoutingDecision({
            node, meshId: MESH_ID, task: { difficulty: 'difficult' }, resolved: resolved as any,
            skippedCandidates: [],
            requiredTagsResult: { required: [], satisfied: true, missing: [] },
            effectiveModel: 'opus',
        });
        __recordTaskDispatchedLedgerForTests({
            meshId: MESH_ID, nodeId: NODE_ID, sessionId: 'quota-session', providerType: 'claude-cli',
            task: { id: 'quota-diagnostic-task', meshId: MESH_ID, message: 'hard task', status: 'assigned' } as any,
            transport: 'local', routingDecision: decision,
        }, 'quota-delivery');

        const entry = readLedgerEntries(MESH_ID, { kind: ['task_dispatched'] })
            .find(candidate => candidate.taskId === 'quota-diagnostic-task');
        const routing = (entry?.payload as any)?.routingDecision;
        expect(routing.quotaRiskSnapshot).toEqual([
            expect.objectContaining({ providerType: 'claude-cli', risk: expect.any(Number) }),
            expect.objectContaining({ providerType: 'kimi', risk: expect.any(Number) }),
        ]);
        expect(routing.intraNodeLosers).toEqual([
            expect.objectContaining({ providerType: 'kimi', model: 'kimi-code/k3', fitnessScore: expect.any(Number), quotaRisk: expect.any(Number), reason: 'lower_quota_rank' }),
        ]);
        expect(Buffer.byteLength(JSON.stringify(routing), 'utf8')).toBeLessThan(2_000);
    });

    it('routes a facts-less worktree clone from exhausted kimi to healthy codex using its source node facts', async () => {
        detectCliMocks.detected.add('kimi').add('codex-cli');
        const source = {
            ...nodeWith([], {
                kimi: okQuota('kimi', { weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null } }),
                'codex-cli': okQuota('codex-cli', { weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } }),
            }),
            id: 'base-node',
        };
        const clone = {
            ...nodeWith([
                { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
                { provider: 'codex-cli', model: 'gpt-5.4', difficulty: ['difficult'], maxParallel: 1 },
            ]),
            clonedFromNodeId: source.id,
        };

        const resolved = await resolve(clone, { nodes: [source, clone] });
        expect(resolved.providerType).toBe('codex-cli');
        expect(resolved.model).toBe('gpt-5.4');
    });

    it('routes away from fresh exhausted last-good windows after a transient probe error', async () => {
        detectCliMocks.detected.add('kimi').add('codex-cli');
        const node = nodeWith([
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
            { provider: 'codex-cli', model: 'gpt-5.4', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            kimi: okQuota('kimi', {
                status: 'error',
                error: 'token expired',
                weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null },
                metadata: { source: 'oauth', failureKind: 'expired-token', lastGoodWindows: true },
            }),
            'codex-cli': okQuota('codex-cli', { weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } }),
        });

        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('codex-cli');
        expect(resolved.model).toBe('gpt-5.4');
    });

    // ★The core behaviour that was impossible before: the first-priority
    // provider is quota-exhausted, so selection must fall through to the same
    // node's SECOND provider instead of skipping the whole node.
    it('falls through to the node\'s next provider when the first choice is quota-exhausted', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
        ], {
            'claude-cli': exhaustedQuota('claude-cli'),
            kimi: okQuota('kimi'),
        });
        const resolved = await resolve(node);
        expect(resolved.reason).toBeUndefined();
        expect(resolved.providerType).toBe('kimi');
        expect(resolved.model).toBe('kimi-code/k3');
    });

    it('orders gate-clear candidates by WEEKLY remaining when the reset time is equal', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const sameReset = Date.now() + 5 * 24 * 60 * MIN;
        const node = nodeWith([
            // Both providers are difficult-capable; kimi has 90% and must win
            // the risk tie (equal reset ⇒ risk is proportional to remaining).
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
        ], {
            'claude-cli': okQuota('claude-cli', { weekly: { usedPercent: 60, windowMinutes: 10080, resetsAt: sameReset } }),
            kimi: okQuota('kimi', { weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: sameReset } }),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('kimi');
    });

    // ★The core of the expiry-risk delta, end to end through provider
    // selection: the static first priority loses when its larger remainder is
    // in no danger while a smaller remainder is hours from evaporating.
    it('spends the soon-EXPIRING remainder first, even when it is the lower static priority', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            // kimi wins the static order (difficulty match +100): 40% weekly
            // remaining but 5 days to spend it.
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
            // claude-cli is equally difficult-capable: only 20% remains, but it evaporates
            // in 2 hours — the certain loss is spent first.
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            kimi: okQuota('kimi', { weekly: { usedPercent: 60, windowMinutes: 10080, resetsAt: Date.now() + 5 * 24 * 60 * MIN } }),
            'claude-cli': okQuota('claude-cli', { weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: Date.now() + 2 * 60 * MIN } }),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('claude-cli');
    });

    it('sorts a measured candidate above an unknown-weekly one even when the unknown is first priority', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            // kimi reports nothing (quota tracking off / unknown) → sorts last
            // but stays gate-CLEAR; claude-cli is measured with headroom.
            'claude-cli': okQuota('claude-cli', { weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null } }),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('claude-cli');
    });

    it('still picks the unknown-weekly provider when every measured provider is gated (fail-open is not a block)', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
        ], {
            'claude-cli': exhaustedQuota('claude-cli'),
            // kimi: no quota entry — never blocked by data it does not have.
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('kimi');
    });

    it('reports ALL-gated under its own NON-actionable reason, never provider_priority_unusable', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
        ], {
            'claude-cli': exhaustedQuota('claude-cli'),
            kimi: exhaustedQuota('kimi'),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBeUndefined();
        expect(resolved.reason).toContain(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON);
        expect(resolved.reason).not.toContain('provider_priority_unusable');
        // WAIT semantics: the quota window resets on its own, so the skip must
        // NOT page the coordinator — the task stays pending and the 4s
        // reconcile retries.
        expect(__isActionableSkipReasonForTests(resolved.reason!)).toBe(false);
    });

    it('keeps a classified task pending when its sufficient provider is unavailable', async () => {
        // A missing provider may recover; the bounded floor-wait reporter pages later.
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'claude-cli': okQuota('claude-cli'),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBeUndefined();
        expect(resolved.reason).toBe('task_difficulty_floor_unavailable:difficult');
        expect(__isActionableSkipReasonForTests(resolved.reason!)).toBe(false);
    });

    it('FAIL-OPEN regression guard: a fresh expired-token error does NOT block the provider', async () => {
        // The fail-open provider is the ONLY usable candidate: if the gate
        // wrongly blocked it, the result would be the all-gated reason.
        // (With a measured competitor present it may legitimately lose the
        // weekly-remaining SORT — out-ranked is not blocked.)
        detectCliMocks.detected.add('claude-cli');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'claude-cli': exhaustedQuota('claude-cli', { metadata: { source: 'oauth', failureKind: 'expired-token' } }),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('claude-cli');
    });

    it('FAIL-OPEN regression guard: a STALE quota-exhausted reading does NOT block the provider', async () => {
        detectCliMocks.detected.add('claude-cli');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'claude-cli': exhaustedQuota('claude-cli', { updatedAt: Date.now() - 45 * MIN }),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('claude-cli');
    });

    it('preserves the static order when no candidate reports quota (pre-feature behaviour)', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
        ]);
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('claude-cli');
    });
});
