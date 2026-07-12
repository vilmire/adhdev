import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMagiFanoutPlan } from '../src/tools/mesh-tools.js';

// A node carrying a git HEAD commit (GitRepoStatus.headCommit) + provider policy.
function node(id: string, provider: string, headCommit: string | undefined, platform = 'linux') {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: [provider] },
        git: { branch: 'main', headCommit: headCommit ?? null },
    } as any;
}

const REF = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const SUB_REF = 'cccccccccccccccccccccccccccccccccccccccc';
const SUB_OLD = 'dddddddddddddddddddddddddddddddddddddddd';

// A node on a given root HEAD carrying submodule gitlink telemetry
// (GitSubmoduleStatus[] — path + commit).
function subNode(
    id: string,
    provider: string,
    headCommit: string,
    submodules: Array<{ path: string; commit: string }>,
    platform = 'linux',
) {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: [provider] },
        git: { branch: 'main', headCommit, submodules },
    } as any;
}

test('git-stale member (HEAD differs from referenceCommit) is excluded by default', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF });

    assert.equal(plan.referenceCommit, REF);
    // b is git-stale → excluded; only a remains as a target.
    assert.equal(plan.staleSlots.length, 1);
    assert.equal(plan.staleSlots[0].nodeId, 'b');
    assert.equal(plan.staleSlots[0].gitStale, true);
    assert.equal(plan.staleSlots[0].excluded, true);
    assert.equal(plan.replicas.length, 1);
    assert.equal(plan.distinctTargets, 1);
    // Post-exclusion the ≥2-target guard fails — caller must error, not degrade to N=1.
    assert.equal(plan.enoughTargets, false);

    // Per-slot resolution carries the gitStale boolean + headCommit (review response surface).
    const resA = plan.slotResolutions.find(m => m.slotIndex === 0)!;
    const resB = plan.slotResolutions.find(m => m.slotIndex === 1)!;
    assert.equal(resA.gitStale, false);
    assert.equal(resA.headCommit, REF);
    assert.equal(resB.gitStale, true);
    assert.equal(resB.headCommit, OLD);
});

test('include_stale=true includes the git-stale member (becomes a valid 2-target panel)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF, includeStale: true });

    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.includedStaleSlots.length, 1);
    assert.equal(plan.includedStaleSlots[0].nodeId, 'b');
    assert.equal(plan.replicas.length, 2);
    assert.equal(plan.distinctTargets, 2);
    assert.equal(plan.enoughTargets, true);
});

test('a 3-member panel stays ≥2 after one git-stale exclusion', () => {
    const slots = [
        { nodeId: 'a', provider: 'claude-cli' },
        { nodeId: 'b', provider: 'codex-cli' },
        { nodeId: 'c', provider: 'hermes-cli' },
    ];
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', REF, 'darwin'), node('c', 'hermes-cli', OLD, 'linux')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF });

    assert.equal(plan.staleSlots.length, 1);
    assert.equal(plan.staleSlots[0].nodeId, 'c');
    assert.equal(plan.distinctTargets, 2);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 2);
});

test('no referenceCommit → staleness is not computed, nothing excluded', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});

    assert.equal(plan.referenceCommit, undefined);
    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
    assert.ok(plan.slotResolutions.every(m => m.gitStale === false));
});

test('a node with no known HEAD commit is never proven stale (not excluded)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    // b has no git headCommit → cannot be proven stale → stays included even with a reference.
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', undefined, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF });

    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
});

// ─── Fix B: stale-gate fallback via node drift counters (no referenceCommit) ───

// Same node shape, but carrying upstream drift counters (GitCompactSummary.behind/ahead).
function driftNode(id: string, provider: string, behind: number, ahead = 0, platform = 'linux') {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: [provider] },
        // No headCommit on purpose: the coordinator carries no reference commit, so staleness
        // can only be judged from the node's own drift from its upstream.
        git: { branch: 'main', headCommit: null, behind, ahead },
    } as any;
}

test('no referenceCommit: a behind>0 node is git-stale via drift fallback (default-excluded)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    // a is clean (behind 0), b is behind 3 — and there is NO coordinator reference commit.
    const nodes = [driftNode('a', 'claude-cli', 0, 0, 'win32'), driftNode('b', 'codex-cli', 3, 0, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});

    assert.equal(plan.referenceCommit, undefined);
    // b is provably on different code than its upstream → git-stale → excluded.
    assert.equal(plan.staleSlots.length, 1);
    assert.equal(plan.staleSlots[0].nodeId, 'b');
    assert.equal(plan.staleSlots[0].gitStale, true);
    assert.equal(plan.staleSlots[0].excluded, true);
    assert.equal(plan.replicas.length, 1);
    assert.equal(plan.enoughTargets, false);
});

test('no referenceCommit: an ahead>0 node is also git-stale via drift fallback', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [driftNode('a', 'claude-cli', 0, 0, 'win32'), driftNode('b', 'codex-cli', 0, 2, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.staleSlots.length, 1);
    assert.equal(plan.staleSlots[0].nodeId, 'b');
});

test('no referenceCommit: include_stale=true keeps the drifted member', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [driftNode('a', 'claude-cli', 0, 0, 'win32'), driftNode('b', 'codex-cli', 3, 0, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { includeStale: true });
    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.includedStaleSlots.length, 1);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 2);
});

test('no referenceCommit + no drift telemetry: nothing is proven stale (regression guard)', () => {
    // The original "no referenceCommit → nothing excluded" guarantee must hold when nodes
    // carry NO drift counters — we never exclude on missing telemetry.
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
});

test('tag-routed member prefers a fresh candidate over a stale one', () => {
    // Two darwin codex-cli nodes: one fresh, one stale. A tag-routed member should
    // resolve to the fresh candidate and not be flagged stale.
    const slots = [
        { nodeId: 'win', provider: 'claude-cli' },
        { capabilityTags: ['os=darwin'], provider: 'codex-cli' },
    ];
    const nodes = [
        node('win', 'claude-cli', REF, 'win32'),
        node('macStale', 'codex-cli', OLD, 'darwin'),
        node('macFresh', 'codex-cli', REF, 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF });
    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    const tagRouted = plan.slotResolutions.find(m => m.slotIndex === 1)!;
    assert.equal(tagRouted.gitStale, false);
    assert.equal(tagRouted.headCommit, REF);
});

// ─── Extended base fingerprint: root HEAD + submodule gitlinks ───
// Two nodes on the SAME root HEAD but a different oss/adhdev-providers submodule
// pointer are NOT the same base (the submodule carries the actual fix code).

test('same root HEAD, different submodule gitlink → git-stale (excluded by default)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const refSubs = [{ path: 'oss', commit: SUB_REF }];
    const nodes = [
        subNode('a', 'claude-cli', REF, [{ path: 'oss', commit: SUB_REF }], 'win32'),
        // b: identical root HEAD, but its oss submodule points at an OLD commit.
        subNode('b', 'codex-cli', REF, [{ path: 'oss', commit: SUB_OLD }], 'darwin'),
    ];
    // Reference base = coordinator (node a) fingerprint. Emulate the handler's
    // resolveMagiReferenceSubmoduleKey by passing the sorted key here.
    const referenceSubmoduleKey = refSubs.map(s => `${s.path}@${s.commit}`).join(',');
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF, referenceSubmoduleKey });

    assert.equal(plan.staleSlots.length, 1);
    assert.equal(plan.staleSlots[0].nodeId, 'b');
    assert.equal(plan.staleSlots[0].gitStale, true);
    assert.equal(plan.staleSlots[0].excluded, true);
    // Its HEAD matches the reference — the exclusion is purely the submodule drift.
    assert.equal(plan.staleSlots[0].headCommit, REF);
    assert.match(plan.staleSlots[0].reason ?? '', /submodule/);
    assert.equal(plan.enoughTargets, false);
});

test('same root HEAD + same submodule gitlink → fresh (not excluded)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const referenceSubmoduleKey = `oss@${SUB_REF}`;
    const nodes = [
        subNode('a', 'claude-cli', REF, [{ path: 'oss', commit: SUB_REF }], 'win32'),
        subNode('b', 'codex-cli', REF, [{ path: 'oss', commit: SUB_REF }], 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF, referenceSubmoduleKey });

    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
    assert.ok(plan.slotResolutions.every(m => m.gitStale === false));
});

test('submodule gitlink key is order-independent (sorted before compare)', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    // Reference lists two submodules in one order; node b lists them reversed — same base.
    const referenceSubmoduleKey = [`docs@${SUB_OLD}`, `oss@${SUB_REF}`].sort().join(',');
    const nodes = [
        subNode('a', 'claude-cli', REF, [{ path: 'oss', commit: SUB_REF }, { path: 'docs', commit: SUB_OLD }], 'win32'),
        subNode('b', 'codex-cli', REF, [{ path: 'docs', commit: SUB_OLD }, { path: 'oss', commit: SUB_REF }], 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF, referenceSubmoduleKey });

    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
});

test('same root HEAD + differing submodule, but include_stale=true → included', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const referenceSubmoduleKey = `oss@${SUB_REF}`;
    const nodes = [
        subNode('a', 'claude-cli', REF, [{ path: 'oss', commit: SUB_REF }], 'win32'),
        subNode('b', 'codex-cli', REF, [{ path: 'oss', commit: SUB_OLD }], 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF, referenceSubmoduleKey, includeStale: true });

    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.includedStaleSlots.length, 1);
    assert.equal(plan.includedStaleSlots[0].nodeId, 'b');
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 2);
});

test('candidate lacks submodule telemetry → falls back to root-HEAD-only (not silently excluded)', () => {
    // Coordinator advertises submodules; candidate b carries NO submodule telemetry.
    // We must NOT diff submodule keys against a node that reports none — b is compared
    // on root HEAD only, so a matching HEAD keeps it fresh (never exclude on missing data).
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const referenceSubmoduleKey = `oss@${SUB_REF}`;
    const nodes = [
        subNode('a', 'claude-cli', REF, [{ path: 'oss', commit: SUB_REF }], 'win32'),
        // b: same root HEAD, no submodules array at all.
        node('b', 'codex-cli', REF, 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF, referenceSubmoduleKey });

    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
});

test('reference lacks submodule telemetry → submodule drift is not diffed (root-HEAD-only)', () => {
    // Coordinator carries no submodule key. Even if a candidate reports a submodule, with
    // no reference to compare against we stay on root-HEAD-only — pre-fingerprint behavior.
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const nodes = [
        subNode('a', 'claude-cli', REF, [{ path: 'oss', commit: SUB_REF }], 'win32'),
        subNode('b', 'codex-cli', REF, [{ path: 'oss', commit: SUB_OLD }], 'darwin'),
    ];
    // No referenceSubmoduleKey passed → both nodes fresh on matching root HEAD.
    const plan = buildMagiFanoutPlan(slots as any, nodes, { referenceCommit: REF });

    assert.equal(plan.staleSlots.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
});
