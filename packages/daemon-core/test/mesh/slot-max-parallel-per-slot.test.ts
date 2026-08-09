/**
 * PER-SLOT maxParallel — a slot is an independent unit, not a share of a provider pool.
 *
 * Owner intent: `{ provider: 'claude-cli', model: 'opus', maxParallel: 1 }` means opus
 * runs at most ONE task on this machine, ever. Sibling headroom must not flow into it —
 * the whole point of pinning opus to 1 is cost and rate-limit control.
 *
 * The defect: resolveProviderMaxParallel SUMS caps across a provider's slots, so
 * opus(1) + sonnet(3) became a single claude-cli pool of 4 and opus could run up to 4
 * concurrently whenever the sonnet slot was idle.
 *
 * ★ VACUITY: every fixture here has TWO SLOTS ON THE SAME PROVIDER with different
 * models. A single-provider-single-slot fixture cannot distinguish summed from
 * per-slot accounting and would pass under the defect.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-slot-cap-${randomUUID().slice(0, 8)}`);
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
    claimNextTask,
    getQueue,
} from '../../src/mesh/mesh-work-queue.js';
import { createMesh } from '../../src/config/mesh-config.js';
import {
    __orderSlotsForProviderSelectionForTests,
    __slotHasCapacityForTests,
} from '../../src/mesh/mesh-queue-assignment.js';
import { resolveSlotMaxParallel, resolveProviderMaxParallel } from '../../src/repo-mesh-types.js';
import { isModelAllowedBySlot } from '../../src/mesh/slot-model-enforcement.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

function freshMesh(): string {
    return createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
}

const NODE_ID = 'node_owner';
/** The owner's real profile: opus pinned to 1, sonnet allowed 3, kimi 2, easy uncapped. */
const OWNER_SLOTS = [
    { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'high', difficulty: ['medium'], maxParallel: 3 },
    { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high', difficulty: ['difficult'], maxParallel: 1 },
    { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'medium', difficulty: ['easy'] },
    { provider: 'kimi', model: 'kimi-code/k3', thinkingLevel: 'high', difficulty: ['difficult'], maxParallel: 2 },
];
const OWNER_NODE = { id: NODE_ID, policy: { slots: OWNER_SLOTS } };

const OPUS_SLOT = OWNER_SLOTS[1];
const SONNET_SLOT = OWNER_SLOTS[0];
const KIMI_SLOT = OWNER_SLOTS[3];

/** Seed `assigned` rows: [providerType, model, count]. */
function occupy(meshId: string, rows: Array<[string, string | undefined, number]>): void {
    const out: any[] = [];
    let i = 0;
    for (const [providerType, model, count] of rows) {
        for (let k = 0; k < count; k++) {
            out.push({
                id: `t_${i++}`,
                meshId,
                message: 'filler',
                status: 'assigned',
                assignedNodeId: NODE_ID,
                assignedProviderType: providerType,
                ...(model ? { assignedModel: model } : {}),
                assignedSessionId: `s_${i}`,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
        }
    }
    __replaceMeshQueueForTests(meshId, out);
}

describe('resolveSlotMaxParallel — per-slot, not summed', () => {
    it('returns each slot\'s OWN cap, while the provider axis still sums', () => {
        expect(resolveSlotMaxParallel(OWNER_SLOTS, 'claude-cli', 'opus', isModelAllowedBySlot)).toBe(1);
        expect(resolveSlotMaxParallel(OWNER_SLOTS, 'claude-cli', 'sonnet', isModelAllowedBySlot)).toBe(3);
        // The provider pool is still the sum (3 + 1; the uncapped easy slot adds nothing).
        expect(resolveProviderMaxParallel(OWNER_SLOTS, 'claude-cli')).toBe(4);
    });

    it('matches a model across surface forms (canon identity, not raw string)', () => {
        expect(resolveSlotMaxParallel(OWNER_SLOTS, 'claude-cli', 'claude-opus-4-6', isModelAllowedBySlot)).toBe(1);
        expect(resolveSlotMaxParallel(OWNER_SLOTS, 'claude-cli', 'Claude Opus 4.6 (Thinking)', isModelAllowedBySlot)).toBe(1);
    });

    it('is undefined for a slot with no declared cap (uncapped stays uncapped)', () => {
        const uncapped = [{ provider: 'claude-cli', model: 'haiku' }];
        expect(resolveSlotMaxParallel(uncapped, 'claude-cli', 'haiku', isModelAllowedBySlot)).toBeUndefined();
    });
});

describe('★ per-slot capacity gating', () => {
    it('★ opus SATURATED while sonnet is idle → opus waits (the owner\'s intent)', () => {
        const meshId = freshMesh();
        // One opus task running. Under the old summed cap this read as 1/4 used, so a
        // second opus launch was admitted — up to four concurrent opus tasks.
        occupy(meshId, [['claude-cli', 'opus', 1]]);

        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, OPUS_SLOT)).toBe(false);
        // ...and the sibling sonnet slot is unaffected: its own budget is untouched.
        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, SONNET_SLOT)).toBe(true);
    });

    it('sonnet fills its own 3 without ever blocking opus', () => {
        const meshId = freshMesh();
        occupy(meshId, [['claude-cli', 'sonnet', 3]]);
        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, SONNET_SLOT)).toBe(false);
        // opus has run nothing, so its own slot is free — but the PROVIDER pool (4) has
        // one slot left, so opus may still start. Both axes are satisfied.
        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, OPUS_SLOT)).toBe(true);
    });

    it('the provider pool still bounds the total (stricter of the two wins)', () => {
        const meshId = freshMesh();
        // 3 sonnet + 1 opus = 4 = the claude-cli pool. opus\'s own slot is also full.
        occupy(meshId, [['claude-cli', 'sonnet', 3], ['claude-cli', 'opus', 1]]);
        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, OPUS_SLOT)).toBe(false);
        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, SONNET_SLOT)).toBe(false);
        // A different provider is untouched by claude-cli's exhaustion.
        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, KIMI_SLOT)).toBe(true);
    });

    it('an uncapped slot stays available regardless of load', () => {
        const meshId = freshMesh();
        const node = { id: NODE_ID, policy: { slots: [{ provider: 'kimi', model: 'k' }] } };
        occupy(meshId, [['kimi', 'k', 9]]);
        expect(__slotHasCapacityForTests(meshId, NODE_ID, node, node.policy.slots[0])).toBe(true);
    });

    it('a legacy row with NO assignedModel counts against every slot of its provider', () => {
        const meshId = freshMesh();
        // Claimed by an older daemon: provider known, model unknown. Ignoring it would
        // admit a second opus past the cap of 1 — so it must count conservatively.
        occupy(meshId, [['claude-cli', undefined, 1]]);
        expect(__slotHasCapacityForTests(meshId, NODE_ID, OWNER_NODE, OPUS_SLOT)).toBe(false);
    });
});

describe('coherence with capacity-ordered provider selection (kimi regression)', () => {
    const DIFFICULT = { difficulty: 'difficult' as const };

    it('★ a saturated opus slot yields to kimi — per-slot capacity keeps the sort honest', () => {
        const meshId = freshMesh();
        // ONE opus task. Under provider-summed capacity claude-cli reads 1/4 = available,
        // so the sort would rank opus first again and kimi would never be selected.
        occupy(meshId, [['claude-cli', 'opus', 1]]);

        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, OWNER_NODE, DIFFICULT);
        expect(order[0].provider).toBe('kimi');
    });

    it('opus still wins when nothing is running (capacity is a tie-break, not a flip)', () => {
        const meshId = freshMesh();
        occupy(meshId, []);
        const order = __orderSlotsForProviderSelectionForTests(meshId, NODE_ID, OWNER_NODE, DIFFICULT);
        expect(order[0].provider).toBe('claude-cli');
        expect(order[0].model).toBe('opus');
    });
});

describe('atomic claim enforces the per-slot cap (the authoritative gate)', () => {
    // The checks above are pre-launch heuristics; THIS is where over-subscription is
    // actually prevented, so it needs its own coverage — a concurrent claim that
    // skipped the pre-check must still be refused here.
    it('★ refuses a second opus claim while one opus assignment is live', () => {
        const meshId = freshMesh();
        occupy(meshId, [['claude-cli', 'opus', 1]]);
        // Add a pending task the claim could take.
        const rows = getQueue(meshId).slice();
        __replaceMeshQueueForTests(meshId, [...rows, {
            id: 'pending_1', meshId, message: 'hard work', status: 'pending',
            // read-only: exempt from the one-WRITE-task-per-node invariant, which is a
            // different gate and would otherwise mask what these tests measure.
            readonly: true, taskMode: 'live_debug_readonly',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as any]);

        const claimed = claimNextTask(meshId, NODE_ID, 'sess_new', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
        });
        expect(claimed).toBeNull();
    });

    it('admits a SONNET claim while opus is saturated (independent budgets)', () => {
        const meshId = freshMesh();
        occupy(meshId, [['claude-cli', 'opus', 1]]);
        const rows = getQueue(meshId).slice();
        __replaceMeshQueueForTests(meshId, [...rows, {
            id: 'pending_1', meshId, message: 'ordinary work', status: 'pending',
            readonly: true, taskMode: 'live_debug_readonly',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as any]);

        const claimed = claimNextTask(meshId, NODE_ID, 'sess_new', [], {
            providerType: 'claude-cli',
            assignedModel: 'sonnet',
            slotMaxParallel: 3,
        });
        expect(claimed).not.toBeNull();
        // The claim records which model it runs, so the NEXT claim can count per slot.
        expect(claimed?.assignedModel).toBe('sonnet');
    });

    it('matches the live assignment across model surface forms', () => {
        const meshId = freshMesh();
        // Live row spelled the long way; the new claim asks with the short alias.
        occupy(meshId, [['claude-cli', 'Claude Opus 4.6 (Thinking)', 1]]);
        const rows = getQueue(meshId).slice();
        __replaceMeshQueueForTests(meshId, [...rows, {
            id: 'pending_1', meshId, message: 'hard work', status: 'pending',
            // read-only: exempt from the one-WRITE-task-per-node invariant, which is a
            // different gate and would otherwise mask what these tests measure.
            readonly: true, taskMode: 'live_debug_readonly',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as any]);

        const claimed = claimNextTask(meshId, NODE_ID, 'sess_new', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
        });
        expect(claimed).toBeNull(); // one slot, not two separate budgets
    });
});
