/**
 * Reproduction + lifecycle for the SLOT MODEL GUARD, through the assignment
 * path's own slot ranking and live capacity computation.
 *
 * Mirrors the real production config (node vilmire-Jupiter):
 *   mesh difficultyBrains = null → DEFAULT_DIFFICULTY_BRAINS
 *   node.policy.slots = [{ provider: 'claude-cli', model: 'sonnet' }]
 *
 * Before the fix, a 'difficult' task resolved to model 'opus' and launched with
 * `--model opus` on that node — a model no slot declares.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-slot-model-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { enqueueTask, getQueue, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { createMesh } from '../../src/config/mesh-config.js';
import { resolveNodeCapabilitySlots } from '../../src/mesh/mesh-node-slots.js';
import {
    decideSlotForModel,
    SLOT_MODEL_BUSY_SKIP_REASON,
    SLOT_MODEL_ABSENT_SKIP_REASON,
} from '../../src/mesh/slot-model-enforcement.js';
import {
    __decideSlotForModelForTests,
    __isActionableSkipReasonForTests,
} from '../../src/mesh/mesh-queue-assignment.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

/** The production node: a single claude-cli/sonnet slot, no opus anywhere. */
const SONNET_ONLY_NODE = {
    id: 'node_sonnet_only',
    policy: { slots: [{ provider: 'claude-cli', model: 'sonnet', difficulty: ['medium', 'easy'] }] },
};

describe('slot-constrained launch model (production repro)', () => {
    it('enqueue stamps the undeclared opus preset onto a sonnet-only node task', () => {
        const meshId = createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
        enqueueTask(meshId, 'redesign the scheduler', { difficulty: 'difficult' });
        const [task] = getQueue(meshId);

        // Preset wins at enqueue — expected and unchanged.
        expect(task.model).toBe('opus');

        // And the node it will land on declares only sonnet.
        const slots = resolveNodeCapabilitySlots(SONNET_ONLY_NODE);
        expect(slots.map(s => s.model)).toEqual(['sonnet']);
        expect(slots.some(s => s.model === 'opus')).toBe(false);
    });

    it('★ opus is never launched on a node whose slots do not declare it', () => {
        const meshId = createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
        enqueueTask(meshId, 'redesign the scheduler', { difficulty: 'difficult' });
        const [task] = getQueue(meshId);

        const slots = resolveNodeCapabilitySlots(SONNET_ONLY_NODE);

        // The pre-fix expression from mesh-queue-assignment.ts: the explicit
        // task.model wins and the slot only fills blanks → the undeclared model.
        const preFixModel = (typeof task.model === 'string' && task.model.trim())
            ? task.model.trim()
            : slots[0].model;
        expect(preFixModel).toBe('opus'); // ← documents the defect

        // With the guard, this node cannot run the task at all — and critically it
        // is NOT silently downgraded to sonnet.
        const d = decideSlotForModel({
            requestedModel: preFixModel,
            slots: slots.map(slot => ({ slot, available: true })),
        });
        expect(d.outcome).toBe('notify');
        if (d.outcome === 'notify') expect(d.reason).toBe(SLOT_MODEL_ABSENT_SKIP_REASON);
    });
});

describe('assignment path decision (real node shapes)', () => {
    const meshId = () => createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;

    it('vilmire-Jupiter (sonnet only) → notify, never a substituted launch', () => {
        const d = __decideSlotForModelForTests(meshId(), 'node_sonnet_only', SONNET_ONLY_NODE, {
            model: 'opus', difficulty: 'difficult',
        });
        expect(d.outcome).toBe('notify');
    });

    it('M1-Server routes difficult to its declared antigravity opus slot → run', () => {
        const m1Server = {
            id: 'node_m1',
            policy: {
                slots: [
                    { provider: 'claude-cli', model: 'sonnet', difficulty: ['easy', 'medium'] },
                    { provider: 'antigravity-cli', model: 'Claude Sonnet 4.6 (Thinking)', difficulty: ['medium', 'easy'] },
                    { provider: 'antigravity-cli', model: 'Claude Opus 4.6 (Thinking)', difficulty: ['difficult'] },
                ],
            },
        };
        // The preset's bare 'opus' matches the display-form slot → runs, using the
        // slot's own declared model string.
        const d = __decideSlotForModelForTests(meshId(), 'node_m1', m1Server, { model: 'opus', difficulty: 'difficult' });
        expect(d.outcome).toBe('run');
        if (d.outcome === 'run') expect(d.model).toBe('Claude Opus 4.6 (Thinking)');
    });

    it('a codex-cli slot with no declared model → notify for a concrete model', () => {
        const node = { id: 'node_codex', policy: { slots: [{ provider: 'codex-cli', difficulty: ['difficult'] }] } };
        const d = __decideSlotForModelForTests(meshId(), 'node_codex', node, { model: 'opus', difficulty: 'difficult' });
        expect(d.outcome).toBe('notify');
    });

    it('an easy task on the sonnet slot runs normally (no false blocking)', () => {
        const d = __decideSlotForModelForTests(meshId(), 'node_sonnet_only', SONNET_ONLY_NODE, {
            model: 'sonnet', difficulty: 'easy',
        });
        expect(d.outcome).toBe('run');
        if (d.outcome === 'run') expect(d.model).toBe('sonnet');
    });
});

/**
 * ★ The owner's central distinction: 'busy' is transient and must NOT page,
 * 'absent' is permanent and MUST page. A task must never sit silently pending
 * forever.
 */
describe('busy waits quietly, absent pages the coordinator', () => {
    it('the busy reason is NOT actionable → the task waits without paging', () => {
        expect(__isActionableSkipReasonForTests(SLOT_MODEL_BUSY_SKIP_REASON)).toBe(false);
    });

    it('the absent reason IS actionable → the coordinator is paged', () => {
        expect(__isActionableSkipReasonForTests(SLOT_MODEL_ABSENT_SKIP_REASON)).toBe(true);
    });

    // "Never stranded": every non-run outcome is covered by exactly one of the
    // two reasons, and each is handled — waiting self-resolves, absence pages.
    // So there is no outcome that is both un-runnable and un-signalled.
    it('every non-run outcome either self-resolves or pages — never silent', () => {
        const declaring = { provider: 'claude-cli', model: 'opus', maxParallel: 1 } as any;
        const notDeclaring = { provider: 'claude-cli', model: 'sonnet' } as any;

        const busy = decideSlotForModel({ requestedModel: 'opus', slots: [{ slot: declaring, available: false }] });
        const absent = decideSlotForModel({ requestedModel: 'opus', slots: [{ slot: notDeclaring, available: true }] });

        expect(busy.outcome).toBe('wait');
        expect(absent.outcome).toBe('notify');

        // wait → self-resolving, so deliberately not actionable
        if (busy.outcome === 'wait') expect(__isActionableSkipReasonForTests(busy.reason)).toBe(false);
        // notify → cannot self-resolve, so it MUST be actionable
        if (absent.outcome === 'notify') expect(__isActionableSkipReasonForTests(absent.reason)).toBe(true);
    });
});

/**
 * The queue's core function per the owner: a busy slot is waited on, and the task
 * runs on THAT slot once it goes idle — not on a substitute, not on another node.
 */
describe('a waiting task claims its slot once it frees', () => {
    const declaringSlot = { provider: 'claude-cli', model: 'opus', maxParallel: 1 } as any;

    it('waits while the slot is at cap, then runs on the SAME slot when idle', () => {
        const busy = decideSlotForModel({
            requestedModel: 'opus',
            slots: [{ slot: declaringSlot, available: false }],
        });
        expect(busy.outcome).toBe('wait');
        if (busy.outcome === 'wait') expect(busy.busySlots).toEqual([declaringSlot]);

        // The slot goes idle — same node, same slot, nothing else changed.
        const freed = decideSlotForModel({
            requestedModel: 'opus',
            slots: [{ slot: declaringSlot, available: true }],
        });
        expect(freed.outcome).toBe('run');
        if (freed.outcome === 'run') {
            expect(freed.slot).toBe(declaringSlot);
            expect(freed.model).toBe('opus');
        }
    });

    it('the decision is a pure function of capacity — waiting never mutates state', () => {
        const slots = [{ slot: declaringSlot, available: false }];
        const a = decideSlotForModel({ requestedModel: 'opus', slots });
        const b = decideSlotForModel({ requestedModel: 'opus', slots });
        expect(a).toEqual(b); // re-evaluating on the next 4s reconcile tick is stable
    });
});
