import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPresetMagiPanelForKind, MAGI_KIND_PRESETS } from '../src/tools/mesh-tools.js';

// A live mesh node: id + provider priority list (the resolver enumerates every
// (node, provider) pair off policy.providerPriority). userOverrides pins os/arch so
// the capability-tag derivation does not fall through to the test process platform.
function node(id: string, providers: string[], platform = 'linux') {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: providers },
        git: { branch: 'main', headCommit: null },
    } as any;
}

// ─── Determinism ───────────────────────────────────────────────

test('deterministic — same live mesh + same kind → identical members', () => {
    const nodes = [
        node('alpha', ['claude-cli', 'codex-cli'], 'win32'),
        node('beta', ['gemini-cli', 'hermes-cli'], 'darwin'),
    ];
    const a = buildPresetMagiPanelForKind('design', nodes, {});
    const b = buildPresetMagiPanelForKind('design', nodes, {});
    assert.deepEqual(a.members, b.members);
});

// ─── Diversity: distinct provider AND distinct node, targetK respected ──

test('diversity — picks distinct providers AND distinct nodes up to targetK', () => {
    // 4 nodes, 4 distinct providers → design (targetK 4) should pick all four,
    // each a distinct (node, provider) pair.
    const nodes = [
        node('n1', ['claude-cli'], 'win32'),
        node('n2', ['codex-cli'], 'darwin'),
        node('n3', ['gemini-cli'], 'linux'),
        node('n4', ['hermes-cli'], 'linux'),
    ];
    const panel = buildPresetMagiPanelForKind('design', nodes, {});
    assert.equal(panel.members.length, 4);
    const providers = new Set(panel.members.map(m => m.provider));
    const nodeIds = new Set(panel.members.map(m => m.nodeId));
    assert.equal(providers.size, 4, 'all distinct providers');
    assert.equal(nodeIds.size, 4, 'all distinct nodes');
});

test('diversity — prefers a NEW provider on a fresh node over reusing a seen provider', () => {
    // claim_audit targetK 3. Two nodes each advertise claude-cli + codex-cli, plus a
    // third node with gemini-cli. The greedy diverse pass should bring in gemini-cli
    // (a new provider) rather than a 3rd claude/codex replica.
    const nodes = [
        node('n1', ['claude-cli', 'codex-cli'], 'win32'),
        node('n2', ['claude-cli', 'codex-cli'], 'darwin'),
        node('n3', ['gemini-cli'], 'linux'),
    ];
    const panel = buildPresetMagiPanelForKind('claim_audit', nodes, {});
    assert.equal(panel.members.length, 3);
    const providers = new Set(panel.members.map(m => m.provider));
    assert.ok(providers.has('gemini-cli'), 'the scarce 3rd provider is included');
    assert.equal(providers.size, 3, '3 distinct providers chosen');
    assert.equal(new Set(panel.members.map(m => m.nodeId)).size, 3, '3 distinct nodes chosen');
});

// ─── BUG FIX: a node's 2nd-priority provider is selectable ─────

test('bugfix — a provider that is NOT first in a node priority list is still routable', () => {
    // Single node, codex-cli is the SECOND priority. The old planner tag-routed path only
    // advertised the FIRST provider (claude-cli), so codex-cli on this node was invisible.
    // The preset resolver enumerates per-provider, so BOTH pairs are candidates.
    const nodes = [node('solo', ['claude-cli', 'codex-cli'], 'win32')];
    const panel = buildPresetMagiPanelForKind('claim_audit', nodes, {});
    // Two distinct providers on the SAME node → minK (2) satisfied without a second node.
    assert.equal(panel.members.length, 2);
    assert.deepEqual(new Set(panel.members.map(m => m.provider)), new Set(['claude-cli', 'codex-cli']));
    assert.ok(panel.members.every(m => m.nodeId === 'solo'));
});

// ─── single-provider degrade: spread across distinct nodes ─────

test('degrade — single provider across multiple nodes spreads onto distinct nodes', () => {
    const nodes = [
        node('n1', ['claude-cli'], 'win32'),
        node('n2', ['claude-cli'], 'darwin'),
        node('n3', ['claude-cli'], 'linux'),
    ];
    const panel = buildPresetMagiPanelForKind('claim_audit', nodes, {});
    // claim_audit targetK 3 → all three nodes, same provider, distinct nodes.
    assert.equal(panel.members.length, 3);
    assert.equal(new Set(panel.members.map(m => m.provider)).size, 1, 'one provider (only one available)');
    assert.equal(new Set(panel.members.map(m => m.nodeId)).size, 3, 'spread across 3 distinct nodes');
});

// ─── insufficient: only one independent pair → < minK ──────────

test('insufficient — exactly one (node, provider) pair returns fewer than minK members', () => {
    const nodes = [node('only', ['claude-cli'], 'win32')];
    const panel = buildPresetMagiPanelForKind('claim_audit', nodes, {});
    assert.ok(panel.members.length < MAGI_KIND_PRESETS.claim_audit.minK);
    assert.equal(panel.members.length, 1);
});

test('insufficient — empty mesh returns zero members', () => {
    const panel = buildPresetMagiPanelForKind('rca', [], {});
    assert.equal(panel.members.length, 0);
});

// ─── fragile provider: ≤1 replica per node, spread across nodes ─

test('fragile — antigravity-cli is capped at one pick per node and spread across nodes', () => {
    // Two nodes each offer antigravity-cli plus another provider. With design targetK 4,
    // antigravity-cli must appear at most once PER node (it never doubles up on one node),
    // and the panel still pulls in the non-fragile providers.
    const nodes = [
        node('n1', ['antigravity-cli', 'claude-cli'], 'win32'),
        node('n2', ['antigravity-cli', 'codex-cli'], 'darwin'),
    ];
    const panel = buildPresetMagiPanelForKind('design', nodes, {});
    // No node carries two antigravity-cli members.
    const fragileByNode = new Map<string, number>();
    for (const m of panel.members) {
        if (m.provider === 'antigravity-cli') fragileByNode.set(m.nodeId!, (fragileByNode.get(m.nodeId!) ?? 0) + 1);
    }
    for (const [, count] of fragileByNode) assert.ok(count <= 1, 'fragile provider ≤1 per node');
    // The non-fragile providers are present (diversity not starved by the fragile cap).
    const providers = new Set(panel.members.map(m => m.provider));
    assert.ok(providers.has('claude-cli') || providers.has('codex-cli'), 'a non-fragile provider is included');
});

// ─── per-kind targetK applied ──────────────────────────────────

test('targetK — design fans wider than freeform on the same rich mesh', () => {
    const nodes = [
        node('n1', ['claude-cli'], 'win32'),
        node('n2', ['codex-cli'], 'darwin'),
        node('n3', ['gemini-cli'], 'linux'),
        node('n4', ['hermes-cli'], 'linux'),
    ];
    const design = buildPresetMagiPanelForKind('design', nodes, {});
    const freeform = buildPresetMagiPanelForKind('freeform', nodes, {});
    assert.equal(design.members.length, MAGI_KIND_PRESETS.design.targetK); // 4
    assert.equal(freeform.members.length, MAGI_KIND_PRESETS.freeform.targetK); // 2
    assert.ok(design.members.length > freeform.members.length);
});

test('targetK — rca caps at 3 even when more targets are available', () => {
    const nodes = [
        node('n1', ['claude-cli'], 'win32'),
        node('n2', ['codex-cli'], 'darwin'),
        node('n3', ['gemini-cli'], 'linux'),
        node('n4', ['hermes-cli'], 'linux'),
    ];
    const panel = buildPresetMagiPanelForKind('rca', nodes, {});
    assert.equal(panel.members.length, MAGI_KIND_PRESETS.rca.targetK); // 3
});

// ─── opts.n propagates to per-member replica count ─────────────

test('opts.n — sets the per-member replica count on every emitted member', () => {
    const nodes = [
        node('n1', ['claude-cli'], 'win32'),
        node('n2', ['codex-cli'], 'darwin'),
    ];
    const panel = buildPresetMagiPanelForKind('freeform', nodes, { n: 2 });
    assert.ok(panel.members.length >= 2);
    assert.ok(panel.members.every(m => m.n === 2));
});
