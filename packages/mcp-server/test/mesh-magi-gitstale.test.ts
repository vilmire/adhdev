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

test('git-stale member (HEAD differs from referenceCommit) is excluded by default', () => {
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, { referenceCommit: REF });

    assert.equal(plan.referenceCommit, REF);
    // b is git-stale → excluded; only a remains as a target.
    assert.equal(plan.staleMembers.length, 1);
    assert.equal(plan.staleMembers[0].nodeId, 'b');
    assert.equal(plan.staleMembers[0].gitStale, true);
    assert.equal(plan.staleMembers[0].excluded, true);
    assert.equal(plan.replicas.length, 1);
    assert.equal(plan.distinctTargets, 1);
    // Post-exclusion the ≥2-target guard fails — caller must error, not degrade to N=1.
    assert.equal(plan.enoughTargets, false);

    // Per-member resolution carries the gitStale boolean + headCommit (panel_list surface).
    const resA = plan.memberResolutions.find(m => m.memberIndex === 0)!;
    const resB = plan.memberResolutions.find(m => m.memberIndex === 1)!;
    assert.equal(resA.gitStale, false);
    assert.equal(resA.headCommit, REF);
    assert.equal(resB.gitStale, true);
    assert.equal(resB.headCommit, OLD);
});

test('include_stale=true includes the git-stale member (becomes a valid 2-target panel)', () => {
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, { referenceCommit: REF, includeStale: true });

    assert.equal(plan.staleMembers.length, 0);
    assert.equal(plan.includedStaleMembers.length, 1);
    assert.equal(plan.includedStaleMembers[0].nodeId, 'b');
    assert.equal(plan.replicas.length, 2);
    assert.equal(plan.distinctTargets, 2);
    assert.equal(plan.enoughTargets, true);
});

test('a 3-member panel stays ≥2 after one git-stale exclusion', () => {
    const panel = { members: [
        { nodeId: 'a', provider: 'claude-cli' },
        { nodeId: 'b', provider: 'codex-cli' },
        { nodeId: 'c', provider: 'hermes-cli' },
    ] };
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', REF, 'darwin'), node('c', 'hermes-cli', OLD, 'linux')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, { referenceCommit: REF });

    assert.equal(plan.staleMembers.length, 1);
    assert.equal(plan.staleMembers[0].nodeId, 'c');
    assert.equal(plan.distinctTargets, 2);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 2);
});

test('no referenceCommit → staleness is not computed, nothing excluded', () => {
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, {});

    assert.equal(plan.referenceCommit, undefined);
    assert.equal(plan.staleMembers.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
    assert.ok(plan.memberResolutions.every(m => m.gitStale === false));
});

test('a node with no known HEAD commit is never proven stale (not excluded)', () => {
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    // b has no git headCommit → cannot be proven stale → stays included even with a reference.
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', undefined, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, { referenceCommit: REF });

    assert.equal(plan.staleMembers.length, 0);
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
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    // a is clean (behind 0), b is behind 3 — and there is NO coordinator reference commit.
    const nodes = [driftNode('a', 'claude-cli', 0, 0, 'win32'), driftNode('b', 'codex-cli', 3, 0, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, {});

    assert.equal(plan.referenceCommit, undefined);
    // b is provably on different code than its upstream → git-stale → excluded.
    assert.equal(plan.staleMembers.length, 1);
    assert.equal(plan.staleMembers[0].nodeId, 'b');
    assert.equal(plan.staleMembers[0].gitStale, true);
    assert.equal(plan.staleMembers[0].excluded, true);
    assert.equal(plan.replicas.length, 1);
    assert.equal(plan.enoughTargets, false);
});

test('no referenceCommit: an ahead>0 node is also git-stale via drift fallback', () => {
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    const nodes = [driftNode('a', 'claude-cli', 0, 0, 'win32'), driftNode('b', 'codex-cli', 0, 2, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, {});
    assert.equal(plan.staleMembers.length, 1);
    assert.equal(plan.staleMembers[0].nodeId, 'b');
});

test('no referenceCommit: include_stale=true keeps the drifted member', () => {
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    const nodes = [driftNode('a', 'claude-cli', 0, 0, 'win32'), driftNode('b', 'codex-cli', 3, 0, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, { includeStale: true });
    assert.equal(plan.staleMembers.length, 0);
    assert.equal(plan.includedStaleMembers.length, 1);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 2);
});

test('no referenceCommit + no drift telemetry: nothing is proven stale (regression guard)', () => {
    // The original "no referenceCommit → nothing excluded" guarantee must hold when nodes
    // carry NO drift counters — we never exclude on missing telemetry.
    const panel = { members: [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }] };
    const nodes = [node('a', 'claude-cli', REF, 'win32'), node('b', 'codex-cli', OLD, 'darwin')];
    const plan = buildMagiFanoutPlan(panel as any, nodes, {});
    assert.equal(plan.staleMembers.length, 0);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctTargets, 2);
});

test('tag-routed member prefers a fresh candidate over a stale one', () => {
    // Two darwin codex-cli nodes: one fresh, one stale. A tag-routed member should
    // resolve to the fresh candidate and not be flagged stale.
    const panel = { members: [
        { nodeId: 'win', provider: 'claude-cli' },
        { capabilityTags: ['os=darwin'], provider: 'codex-cli' },
    ] };
    const nodes = [
        node('win', 'claude-cli', REF, 'win32'),
        node('macStale', 'codex-cli', OLD, 'darwin'),
        node('macFresh', 'codex-cli', REF, 'darwin'),
    ];
    const plan = buildMagiFanoutPlan(panel as any, nodes, { referenceCommit: REF });
    assert.equal(plan.staleMembers.length, 0);
    assert.equal(plan.enoughTargets, true);
    const tagRouted = plan.memberResolutions.find(m => m.memberIndex === 1)!;
    assert.equal(tagRouted.gitStale, false);
    assert.equal(tagRouted.headCommit, REF);
});
