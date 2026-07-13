import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMagiFanoutPlan } from '../src/tools/mesh-tools.js';

// A node carrying an explicit health scalar + provider policy. `health` mirrors what a
// fresh mesh_status probe / status report stamps onto the node (RepoMeshNodeHealth).
function node(id: string, provider: string, health: string | undefined, platform = 'linux') {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: [provider] },
        ...(health !== undefined ? { health } : {}),
    } as any;
}

// A node whose health is only derivable from its git telemetry (no explicit health scalar) —
// exercises the resolveEffectiveMeshNodeHealth git-derivation fallback.
function gitNode(id: string, provider: string, git: Record<string, unknown>, platform = 'linux') {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: [provider] },
        git,
    } as any;
}

test('a degraded node is excluded from the fan-out (never dispatched)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', 'online', 'win32'), node('b', 'codex-cli', 'degraded', 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});

    // b is degraded → excluded; only a remains as a target.
    assert.equal(plan.unhealthySlots.length, 1);
    assert.equal(plan.unhealthySlots[0].nodeId, 'b');
    assert.equal(plan.unhealthySlots[0].health, 'degraded');
    assert.equal(plan.replicas.length, 1);
    assert.equal(plan.distinctTargets, 1);
    // Post-exclusion the ≥2-target guard fails — caller must error, not degrade to N=1.
    assert.equal(plan.enoughTargets, false);

    // Per-slot resolution carries the unhealthy boolean + health (review response surface).
    const resA = plan.slotResolutions.find(m => m.slotIndex === 0)!;
    const resB = plan.slotResolutions.find(m => m.slotIndex === 1)!;
    assert.equal(resA.unhealthy, false);
    assert.equal(resA.health, 'online');
    assert.equal(resB.unhealthy, true);
    assert.equal(resB.health, 'degraded');
    assert.equal(resB.excluded, true);
});

test('an offline node is excluded (same gate as degraded)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', 'online', 'win32'), node('b', 'codex-cli', 'offline', 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});

    assert.equal(plan.unhealthySlots.length, 1);
    assert.equal(plan.unhealthySlots[0].nodeId, 'b');
    assert.equal(plan.unhealthySlots[0].health, 'offline');
    assert.equal(plan.enoughTargets, false);
});

test('a dirty node is not launch-ready and is excluded', () => {
    // isLaunchableNode blocks anything other than online/unknown; dirty parks in pending too.
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', 'online', 'win32'), node('b', 'codex-cli', 'dirty', 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.unhealthySlots.length, 1);
    assert.equal(plan.unhealthySlots[0].health, 'dirty');
    assert.equal(plan.enoughTargets, false);
});

test("'unknown' and 'online' health pass; absent health passes (never exclude on missing telemetry)", () => {
    const slots = [
        { nodeId: 'a', provider: 'claude-cli' },
        { nodeId: 'b', provider: 'codex-cli' },
        { nodeId: 'c', provider: 'hermes-cli' },
    ];
    const nodes = [
        node('a', 'claude-cli', 'online', 'win32'),
        node('b', 'codex-cli', 'unknown', 'darwin'),
        node('c', 'hermes-cli', undefined, 'linux'), // no health telemetry at all
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.unhealthySlots.length, 0);
    assert.equal(plan.distinctTargets, 3);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 3);
    assert.ok(plan.slotResolutions.every(m => m.unhealthy === false));
});

test('a 3-member panel stays ≥2 after one degraded exclusion (quorum still met)', () => {
    const slots = [
        { nodeId: 'a', provider: 'claude-cli' },
        { nodeId: 'b', provider: 'codex-cli' },
        { nodeId: 'c', provider: 'hermes-cli' },
    ];
    const nodes = [
        node('a', 'claude-cli', 'online', 'win32'),
        node('b', 'codex-cli', 'online', 'darwin'),
        node('c', 'hermes-cli', 'degraded', 'linux'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.unhealthySlots.length, 1);
    assert.equal(plan.unhealthySlots[0].nodeId, 'c');
    assert.equal(plan.distinctTargets, 2);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 2);
});

test('tag-routed slot prefers a healthy candidate over a degraded one', () => {
    // Two darwin codex-cli nodes: one online, one degraded. A tag-routed member should
    // resolve to the healthy candidate and not be excluded.
    const slots = [
        { nodeId: 'win', provider: 'claude-cli' },
        { capabilityTags: ['os=darwin'], provider: 'codex-cli' },
    ];
    const nodes = [
        node('win', 'claude-cli', 'online', 'win32'),
        node('macDegraded', 'codex-cli', 'degraded', 'darwin'),
        node('macOnline', 'codex-cli', 'online', 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.unhealthySlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    const tagRouted = plan.slotResolutions.find(m => m.slotIndex === 1)!;
    assert.equal(tagRouted.unhealthy, false);
    assert.equal(tagRouted.health, 'online');
});

test('tag-routed slot with ONLY degraded candidates is excluded', () => {
    const slots = [
        { nodeId: 'win', provider: 'claude-cli' },
        { capabilityTags: ['os=darwin'], provider: 'codex-cli' },
    ];
    const nodes = [
        node('win', 'claude-cli', 'online', 'win32'),
        node('macA', 'codex-cli', 'degraded', 'darwin'),
        node('macB', 'codex-cli', 'offline', 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.unhealthySlots.length, 1);
    assert.equal(plan.unhealthySlots[0].slotIndex, 1);
    assert.equal(plan.enoughTargets, false);
});

test('health derived from git telemetry (no explicit health scalar) also gates', () => {
    // b carries no `health` scalar, only git telemetry that resolves to degraded
    // (not a git repo) via deriveMeshNodeHealthFromGit.
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [
        gitNode('a', 'claude-cli', { isGitRepo: true, branch: 'main' }, 'win32'),
        gitNode('b', 'codex-cli', { isGitRepo: false }, 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.unhealthySlots.length, 1);
    assert.equal(plan.unhealthySlots[0].nodeId, 'b');
    assert.equal(plan.unhealthySlots[0].health, 'degraded');
    assert.equal(plan.enoughTargets, false);
    // a resolves to online from its clean git telemetry.
    const resA = plan.slotResolutions.find(m => m.slotIndex === 0)!;
    assert.equal(resA.unhealthy, false);
    assert.equal(resA.health, 'online');
});

test('a healthy panel is unaffected — regression guard (no health telemetry anywhere)', () => {
    // The pre-gate behavior must hold exactly when nodes carry NO health/git telemetry.
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', undefined, 'win32'), node('b', 'codex-cli', undefined, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.unhealthySlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
    assert.equal(plan.replicas.length, 2);
});
