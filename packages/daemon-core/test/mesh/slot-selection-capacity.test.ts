/**
 * SATURATED-SLOT STARVATION — a second provider configured for the same difficulty
 * must actually be selected.
 *
 * Live defect: a node configured with
 *   { provider: 'claude-cli', model: 'opus',        difficulty: ['difficult'], maxParallel: 1 }
 *   { provider: 'kimi',       model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 }
 * never once ran a difficult task on kimi. Both slots score the same +100
 * difficulty match, so the stable sort put claude-cli first purely by ARRAY ORDER,
 * and resolveUsableProvider returns the first slot whose CLI is detected without
 * ever consulting capacity. When the opus slot was saturated the node was skipped
 * wholesale (SLOT MODEL GUARD 'wait' / max_provider_parallel_reached) instead of
 * falling through to the idle kimi slot — so kimi was unreachable whether opus was
 * free OR busy.
 *
 * The fix makes capacity the primary sort key. These tests pin it on a node with
 * TWO DIFFERENT PROVIDERS (a single-provider node would prove nothing: the
 * provider-cap is summed per provider, so both slots would rise and fall together).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-slot-capacity-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import {
    __replaceMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { createMesh } from '../../src/config/mesh-config.js';
import { __orderSlotsForProviderSelectionForTests } from '../../src/mesh/mesh-queue-assignment.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

function freshMesh(): string {
    return createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
}

/** The owner's real node: opus and kimi BOTH declare difficulty:['difficult']. */
const NODE_ID = 'node_two_providers';
const TWO_PROVIDER_NODE = {
    id: NODE_ID,
    policy: {
        slots: [
            { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'high', difficulty: ['medium'], maxParallel: 3 },
            { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'kimi', model: 'kimi-code/k3', thinkingLevel: 'high', difficulty: ['difficult'], maxParallel: 2 },
        ],
    },
};

const DIFFICULT = { difficulty: 'difficult' as const };

/**
 * Occupy assigned tasks on (node, provider) so its cap is consumed. Seeds the
 * queue directly with `assigned` rows — exactly what activeProviderAssignedCount
 * counts (status 'assigned' + assignedNodeId + assignedProviderType).
 */
function saturate(meshId: string, occupancy: Record<string, number>, model?: string): void {
    const rows: any[] = [];
    for (const [providerType, n] of Object.entries(occupancy)) {
        for (let i = 0; i < n; i++) {
            rows.push({
                id: `task_${providerType}_${i}`,
                meshId,
                message: `filler ${providerType} ${i}`,
                status: 'assigned',
                assignedNodeId: NODE_ID,
                assignedProviderType: providerType,
                ...(model ? { assignedModel: model } : {}),
                assignedSessionId: `sess_${providerType}_${i}`,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
        }
    }
    __replaceMeshQueueForTests(meshId, rows);
}

describe('provider selection orders slots by capacity, then fitness', () => {
    it('both difficult slots are equally fit — so array order alone must not decide', () => {
        const meshId = freshMesh();
        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, TWO_PROVIDER_NODE, DIFFICULT);
        // With everything idle the best-fit slots are the two difficulty matches.
        // (claude-cli/opus first here is fine — it is only a preference, not a trap,
        // because a saturated opus now yields; see the next test.)
        expect(order.slice(0, 2).map(s => s.provider).sort()).toEqual(['claude-cli', 'kimi']);
        expect(order[order.length - 1].difficulty).toEqual(['medium']);
    });

    it('★ a SATURATED claude-cli yields to the idle kimi slot (the live defect)', () => {
        const meshId = freshMesh();
        // claude-cli's cap is summed across its slots: 3 (medium) + 1 (opus) = 4.
        saturate(meshId, { 'claude-cli': 4 });

        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, TWO_PROVIDER_NODE, DIFFICULT);

        // Pre-fix this was 'claude-cli' — and because selection returns the first
        // detected slot, the node was then skipped instead of running on kimi.
        expect(order[0].provider).toBe('kimi');
        expect(order[0].model).toBe('kimi-code/k3');
    });

    it('kimi does NOT jump the queue while the opus slot still has headroom', () => {
        const meshId = freshMesh();
        // Load the SONNET slot only (its own cap is 3). The opus slot has run nothing,
        // so it keeps winning: capacity is a tie-break among equally-fit slots, not a
        // preference flip.
        //
        // Models are stamped explicitly because caps are now per SLOT, not per provider:
        // three UNSTAMPED claude-cli rows would count against every claude-cli slot
        // (the conservative legacy-row rule) and would legitimately exhaust opus's
        // cap of 1 — a different scenario from the one this test is about.
        saturate(meshId, { 'claude-cli': 3 }, 'sonnet');

        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, TWO_PROVIDER_NODE, DIFFICULT);
        expect(order[0].provider).toBe('claude-cli');
        expect(order[0].model).toBe('opus');
    });

    it('★ loading the opus slot alone hands the difficult task to kimi', () => {
        const meshId = freshMesh();
        // ONE opus task exhausts the opus slot (maxParallel: 1) even though the sonnet
        // slot and the claude-cli pool both have room. This is the owner's intent:
        // "opus runs one task on this machine", sibling headroom must not leak into it.
        saturate(meshId, { 'claude-cli': 1 }, 'opus');

        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, TWO_PROVIDER_NODE, DIFFICULT);
        expect(order[0].provider).toBe('kimi');
    });

    it('when EVERY slot is saturated the order is unchanged (wait semantics preserved)', () => {
        const meshId = freshMesh();
        saturate(meshId, { 'claude-cli': 4, kimi: 2 });

        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, TWO_PROVIDER_NODE, DIFFICULT);
        // No slot has headroom → capacity key is inert and pure fitness decides,
        // exactly as before the fix, so the downstream guard still reaches 'wait'.
        expect(order[0].provider).toBe('claude-cli');
        expect(order[0].model).toBe('opus');
        expect(order[order.length - 1].difficulty).toEqual(['medium']);
    });

    it('an uncapped slot is always considered available', () => {
        const meshId = freshMesh();
        const uncapped = {
            id: NODE_ID,
            policy: {
                slots: [
                    { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'] }, // no maxParallel
                    { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'], maxParallel: 2 },
                ],
            },
        };
        saturate(meshId, { 'claude-cli': 9 });
        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, uncapped, DIFFICULT);
        expect(order[0].provider).toBe('claude-cli'); // uncapped → never saturated
    });
});
