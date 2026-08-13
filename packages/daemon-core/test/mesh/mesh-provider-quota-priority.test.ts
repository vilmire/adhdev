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
 *   - gate-clear candidates are ordered by WEEKLY (7d) remaining headroom,
 *     descending (owner-confirmed: spread the 7-day budget evenly across
 *     provider accounts); unknown-weekly candidates sort last, caller order
 *     preserved within each group;
 *   - when EVERY usable provider is gated the reason is the non-actionable
 *     ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON (a self-resolving WAIT), never the
 *     actionable 'provider_priority_unusable' (a slot configuration error);
 *   - fail-open is unchanged: missing / stale / expired-token / transient
 *     readings are never BLOCKED, only out-ranked.
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
} from '../../src/mesh/mesh-queue-assignment.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON } from '../../src/mesh/mesh-quota-routing.js';

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

async function resolve(node: any) {
    return __resolveUsableProviderForTests(
        makeComponents(), NODE_ID, node, MESH_ID,
        undefined,
        { difficulty: 'difficult' as const, requiredTags: undefined },
        null,
    );
}

beforeEach(() => {
    detectCliMocks.detected.clear();
});

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('resolveUsableProvider — quota gate inside the selection loop', () => {
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

    it('orders gate-clear candidates by WEEKLY remaining headroom, descending', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            // claude-cli wins the static order (difficulty match +100) but only
            // 40% weekly remaining; kimi (general slot) has 90% and must win.
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'kimi', model: 'kimi-code/k3', maxParallel: 2 },
        ], {
            'claude-cli': okQuota('claude-cli', { weekly: { usedPercent: 60, windowMinutes: 10080, resetsAt: null } }),
            kimi: okQuota('kimi', { weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } }),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('kimi');
    });

    it('sorts a measured candidate above an unknown-weekly one even when the unknown is first priority', async () => {
        detectCliMocks.detected.add('claude-cli').add('kimi');
        const node = nodeWith([
            { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
            { provider: 'claude-cli', model: 'opus', maxParallel: 1 },
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
            { provider: 'kimi', model: 'kimi-code/k3', maxParallel: 2 },
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
            { provider: 'kimi', model: 'kimi-code/k3', maxParallel: 2 },
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

    it('keeps provider_priority_unusable actionable for genuine slot/config problems', async () => {
        // No CLI detected at all → configuration problem, actionable.
        const node = nodeWith([
            { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 1 },
        ], {
            'claude-cli': okQuota('claude-cli'),
        });
        const resolved = await resolve(node);
        expect(resolved.providerType).toBeUndefined();
        expect(resolved.reason).toContain('provider_priority_unusable');
        expect(__isActionableSkipReasonForTests(resolved.reason!)).toBe(true);
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
            { provider: 'kimi', model: 'kimi-code/k3', maxParallel: 2 },
        ]);
        const resolved = await resolve(node);
        expect(resolved.providerType).toBe('claude-cli');
    });
});
