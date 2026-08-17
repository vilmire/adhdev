/**
 * ★ DAEMON-AXIS slot concurrency — `maxParallel` is charged per MACHINE, not per NODE.
 *
 * The defect (confirmed against a live mesh_runtime.db): tasks T1/T2/T4 all routed to
 * `claude-cli/opus` with `maxParallel: 1`, but their assigned nodeIds differed
 * (`node_727ddfa5…` / `node_0630ba54…` / `node_3f991ad9…`) because each was a worktree
 * of the same repo on ONE laptop. The cap was counted on `assigned_node_id`, so all
 * three claimed within a second of each other and three opus processes ran against a
 * cap that says one. Branching a worktree silently multiplied a machine resource budget.
 *
 * ★ VACUITY GUARD: every fixture that asserts sharing uses TWO OR MORE DISTINCT nodeIds
 * that resolve to the SAME daemon. A single-node fixture cannot distinguish the node
 * axis from the daemon axis and would pass under the defect.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-daemon-axis-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_local' }),
}));

import {
    __replaceMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    claimNextTask,
    getQueue,
} from '../../src/mesh/mesh-work-queue.js';
import { createMesh } from '../../src/config/mesh-config.js';
import {
    resolveDaemonSiblingNodeIds,
    resolveNodeDaemonKey,
    readonlySlotBudget,
    effectiveSlotCap,
} from '../../src/mesh/mesh-daemon-slot-axis.js';

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

function freshMesh(): string {
    return createMesh({ name: 'm', repoIdentity: `id_${randomUUID().slice(0, 8)}` }).id;
}

// ── The live topology: one laptop (mach_alpha), a base node + two worktree clones,
//    plus a genuinely separate machine (mach_beta).
const BASE = 'node_base';
const WT_1 = 'node_wt_one';
const WT_2 = 'node_wt_two';
const REMOTE = 'node_remote';

const NODES = [
    { id: BASE, daemonId: 'daemon_mach_alpha' },
    // Worktree clones: distinct nodeIds, same owning daemon (id inherited at clone time).
    { id: WT_1, daemonId: 'daemon_mach_alpha', isLocalWorktree: true, clonedFromNodeId: BASE },
    // Second clone declares NO daemonId — it must still resolve through clonedFromNodeId.
    { id: WT_2, isLocalWorktree: true, clonedFromNodeId: BASE },
    // A different physical machine.
    { id: REMOTE, daemonId: 'daemon_mach_beta' },
];

/** Seed `assigned` rows: [nodeId, providerType, model, count]. */
function occupy(meshId: string, rows: Array<[string, string, string | undefined, number]>): void {
    const out: any[] = [];
    let i = 0;
    for (const [nodeId, providerType, model, count] of rows) {
        for (let k = 0; k < count; k++) {
            out.push({
                id: `t_${i++}`,
                meshId,
                message: 'filler',
                status: 'assigned',
                assignedNodeId: nodeId,
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

/** Append one pending task the claim can take. `readonly` drives the reservation. */
function addPending(meshId: string, id: string, opts?: { readonly?: boolean }): void {
    const rows = getQueue(meshId).slice();
    __replaceMeshQueueForTests(meshId, [...rows, {
        id, meshId, message: 'work', status: 'pending',
        ...(opts?.readonly ? { readonly: true, taskMode: 'live_debug_readonly' } : { taskMode: 'code_change' }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as any]);
}

describe('daemon-key resolution', () => {
    it('maps a base node and its worktree clones to ONE daemon key', () => {
        const baseKey = resolveNodeDaemonKey(NODES[0], NODES);
        expect(resolveNodeDaemonKey(NODES[1], NODES)).toBe(baseKey);
        // The clone with no declared daemonId resolves transitively via clonedFromNodeId.
        expect(resolveNodeDaemonKey(NODES[2], NODES)).toBe(baseKey);
    });

    it('★ keeps a DIFFERENT machine on a different key (remote nodes never share a budget)', () => {
        expect(resolveNodeDaemonKey(NODES[3], NODES)).not.toBe(resolveNodeDaemonKey(NODES[0], NODES));
    });

    it('treats interchangeable daemon-id forms as ONE machine (canon identity)', () => {
        const forms = [
            { id: 'n1', daemonId: 'mach_x' },
            { id: 'n2', daemonId: 'daemon_mach_x' },
            { id: 'n3', daemonId: 'standalone_mach_x' },
        ];
        const key = resolveNodeDaemonKey(forms[0], forms);
        // A raw string compare here would split one machine into three budgets and
        // re-open the over-subscription this fix exists to close.
        expect(resolveNodeDaemonKey(forms[1], forms)).toBe(key);
        expect(resolveNodeDaemonKey(forms[2], forms)).toBe(key);
    });

    it('survives a cyclic clonedFromNodeId without hanging', () => {
        const cyclic = [
            { id: 'a', clonedFromNodeId: 'b' },
            { id: 'b', clonedFromNodeId: 'a' },
        ];
        expect(() => resolveNodeDaemonKey(cyclic[0], cyclic)).not.toThrow();
    });
});

describe('sibling node-id resolution', () => {
    it('★ returns every worktree on the daemon, and NOT the remote node', () => {
        const siblings = resolveDaemonSiblingNodeIds(BASE, NODES);
        expect(siblings).toContain(BASE);
        expect(siblings).toContain(WT_1);
        expect(siblings).toContain(WT_2);
        expect(siblings).not.toContain(REMOTE);
    });

    it('is symmetric — asked from a worktree, it still returns the whole daemon', () => {
        expect([...resolveDaemonSiblingNodeIds(WT_1, NODES)].sort())
            .toEqual([...resolveDaemonSiblingNodeIds(BASE, NODES)].sort());
    });

    it('degrades to the single node when the mesh list is unavailable', () => {
        // A degraded read must never WIDEN a cap by dropping the claiming node.
        expect(resolveDaemonSiblingNodeIds(BASE, undefined)).toEqual([BASE]);
        expect(resolveDaemonSiblingNodeIds(BASE, [])).toEqual([BASE]);
    });
});

describe('★ the core contract — N worktrees on one daemon SHARE a maxParallel:1 slot', () => {
    it('★ refuses a second opus claim from a SIBLING WORKTREE node (the live defect)', () => {
        const meshId = freshMesh();
        // One opus task already running on the BASE node.
        occupy(meshId, [[BASE, 'claude-cli', 'opus', 1]]);
        addPending(meshId, 'pending_1');

        // A different node — a worktree of the same repo on the SAME laptop — tries to
        // claim. Under the node-axis cap this saw an empty budget and admitted the
        // claim, which is how three opus processes ran against a cap of one.
        const claimed = claimNextTask(meshId, WT_1, 'sess_wt1', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_1, NODES),
        });
        expect(claimed).toBeNull();
    });

    it('★ refuses the THIRD claim too — the full T1/T2/T4 repro', () => {
        const meshId = freshMesh();
        // T1 on base, T2 on the first worktree: the cap of 1 is already exceeded.
        occupy(meshId, [[BASE, 'claude-cli', 'opus', 1], [WT_1, 'claude-cli', 'opus', 1]]);
        addPending(meshId, 'pending_1');

        // T4 arrives on the second worktree — the one with NO declared daemonId, which
        // must still resolve to this machine through clonedFromNodeId.
        const claimed = claimNextTask(meshId, WT_2, 'sess_wt2', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_2, NODES),
        });
        expect(claimed).toBeNull();
    });

    it('★ a DIFFERENT machine is NOT blocked by this daemon\'s saturation', () => {
        const meshId = freshMesh();
        // Both slots on the alpha laptop are busy…
        occupy(meshId, [[BASE, 'claude-cli', 'opus', 1], [WT_1, 'claude-cli', 'opus', 1]]);
        addPending(meshId, 'pending_1');

        // …but MainPC/MoltBook/Jupiter each have their own CPU, auth file and rate
        // limit. This is a machine axis, NOT a mesh-global one.
        const claimed = claimNextTask(meshId, REMOTE, 'sess_remote', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
            daemonNodeIds: resolveDaemonSiblingNodeIds(REMOTE, NODES),
        });
        expect(claimed).not.toBeNull();
    });

    it('picks up sequentially — a completed task frees the shared slot', () => {
        const meshId = freshMesh();
        // Nothing running: the opus slot is free for whichever worktree asks first.
        occupy(meshId, []);
        addPending(meshId, 'pending_1');

        const claimed = claimNextTask(meshId, WT_1, 'sess_wt1', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_1, NODES),
        });
        expect(claimed).not.toBeNull();
        expect(claimed?.assignedModel).toBe('opus');
    });

    it('a sibling slot on the same daemon keeps its own budget (still per-slot)', () => {
        const meshId = freshMesh();
        // opus saturated across the daemon — sonnet is a DIFFERENT slot and unaffected.
        occupy(meshId, [[BASE, 'claude-cli', 'opus', 1]]);
        addPending(meshId, 'pending_1');

        const claimed = claimNextTask(meshId, WT_1, 'sess_wt1', [], {
            providerType: 'claude-cli',
            assignedModel: 'sonnet',
            slotMaxParallel: 3,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_1, NODES),
        });
        expect(claimed).not.toBeNull();
    });

    it('matches a live sibling assignment across model surface forms', () => {
        const meshId = freshMesh();
        // Spelled the long way on base; the worktree asks with the short alias.
        occupy(meshId, [[BASE, 'claude-cli', 'Claude Opus 4.6 (Thinking)', 1]]);
        addPending(meshId, 'pending_1');

        const claimed = claimNextTask(meshId, WT_1, 'sess_wt1', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_1, NODES),
        });
        expect(claimed).toBeNull();
    });

    it('the PROVIDER cap is shared across the daemon too', () => {
        const meshId = freshMesh();
        // Two claude-cli tasks split across two worktrees exhaust a provider pool of 2.
        occupy(meshId, [[BASE, 'claude-cli', 'sonnet', 1], [WT_1, 'claude-cli', 'sonnet', 1]]);
        addPending(meshId, 'pending_1');

        const claimed = claimNextTask(meshId, WT_2, 'sess_wt2', [], {
            providerType: 'claude-cli',
            assignedModel: 'sonnet',
            providerMaxParallel: 2,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_2, NODES),
        });
        expect(claimed).toBeNull();
    });

    it('omitting daemonNodeIds preserves the prior per-node behavior exactly', () => {
        const meshId = freshMesh();
        occupy(meshId, [[BASE, 'claude-cli', 'opus', 1]]);
        addPending(meshId, 'pending_1');

        // No sibling set resolved (degraded read) → counts the claiming node only, which
        // is what shipped before. Documented as never widening a cap relative to itself.
        const claimed = claimNextTask(meshId, WT_1, 'sess_wt1', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
        });
        expect(claimed).not.toBeNull();
    });
});

describe('★ starvation guard — read-only work cannot hold every slot', () => {
    it('reserves the last slot of a multi-slot budget for write tasks', () => {
        expect(readonlySlotBudget(5)).toBe(4);
        expect(readonlySlotBudget(2)).toBe(1);
        // At a cap of 1, reserving would forbid read-only work outright — strictly
        // worse than today. Both kinds contend and take turns instead.
        expect(readonlySlotBudget(1)).toBe(1);
    });

    it('write tasks always see the full declared cap', () => {
        expect(effectiveSlotCap(5, false)).toBe(5);
        expect(effectiveSlotCap(5, true)).toBe(4);
        // An uncapped slot stays uncapped for both kinds.
        expect(effectiveSlotCap(undefined, true)).toBeUndefined();
        expect(effectiveSlotCap(undefined, false)).toBeUndefined();
    });

    // The next two tests are one experiment split in half: IDENTICAL occupancy (cap 3,
    // two busy → exactly one slot free), differing only in the candidate's task mode.
    // Read-only is refused that last slot; a write task takes it. Keep them in sync.
    it('★ read-only is refused the LAST free slot of the daemon budget', () => {
        const meshId = freshMesh();
        occupy(meshId, [[BASE, 'claude-cli', 'sonnet', 1], [WT_1, 'claude-cli', 'sonnet', 1]]);
        addPending(meshId, 'ro_1', { readonly: true });

        const readonlyClaim = claimNextTask(meshId, WT_2, 'sess_ro', [], {
            providerType: 'claude-cli',
            assignedModel: 'sonnet',
            slotMaxParallel: 3,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_2, NODES),
        });
        // Refused: taking it would leave a write task with no reachable slot.
        expect(readonlyClaim).toBeNull();
    });

    it('★ …while a WRITE task in the identical state still gets it', () => {
        const meshId = freshMesh();
        occupy(meshId, [[BASE, 'claude-cli', 'sonnet', 1], [WT_1, 'claude-cli', 'sonnet', 1]]);
        addPending(meshId, 'w_1');

        const writeClaim = claimNextTask(meshId, WT_2, 'sess_w', [], {
            providerType: 'claude-cli',
            assignedModel: 'sonnet',
            slotMaxParallel: 3,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_2, NODES),
        });
        expect(writeClaim).not.toBeNull();
    });

    it('read-only still runs freely below the reservation threshold', () => {
        const meshId = freshMesh();
        // Cap 3, only one busy → two free, so read-only may take one.
        occupy(meshId, [[BASE, 'claude-cli', 'sonnet', 1]]);
        addPending(meshId, 'ro_1', { readonly: true });

        const claimed = claimNextTask(meshId, WT_1, 'sess_ro', [], {
            providerType: 'claude-cli',
            assignedModel: 'sonnet',
            slotMaxParallel: 3,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_1, NODES),
        });
        expect(claimed).not.toBeNull();
    });

    it('a cap of 1 still admits read-only when idle (no outright ban)', () => {
        const meshId = freshMesh();
        occupy(meshId, []);
        addPending(meshId, 'ro_1', { readonly: true });

        const claimed = claimNextTask(meshId, WT_1, 'sess_ro', [], {
            providerType: 'claude-cli',
            assignedModel: 'opus',
            slotMaxParallel: 1,
            daemonNodeIds: resolveDaemonSiblingNodeIds(WT_1, NODES),
        });
        expect(claimed).not.toBeNull();
    });
});
