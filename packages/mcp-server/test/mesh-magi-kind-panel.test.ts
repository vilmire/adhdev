import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInlineMagiPanel, buildMagiFanoutPlan } from '../src/tools/mesh-tools.js';

/**
 * MAGI-KIND-PANEL fan-out behavior. A bare mesh_magi_review({task_kind}) builds its
 * panel from the user-configured kind-panel slots (via buildInlineMagiPanel, the same
 * normalizer inline/named panels use), then plans the fan-out with buildMagiFanoutPlan.
 * These pure tests assert the two behavioral guarantees the feature adds:
 *
 *  (a) a slot's `model` flows through the panel member into the replica plan, so the
 *      per-replica launch can forward it as initialModel (the model axis);
 *  (c) a slot pinned to an OFFLINE node is NOT auto-synthesized around — it becomes an
 *      unavailable member and (if it drops the panel below 2 targets) enoughTargets=false,
 *      i.e. a clear error rather than a silent synthetic fallback.
 *
 * Case (b) — an unconfigured kind → magi_kind_not_configured — is a guard in
 * meshMagiReview directly off getMagiKindPanel(), covered at the config layer by the
 * daemon-core magi-kind-panel-crud-handlers test (empty list → no binding).
 */

// A live mesh node: id + provider priority (buildMagiFanoutPlan derives capability tags
// from policy.providerPriority). userOverrides pins os/arch so tag derivation does not
// fall through to the test process platform.
function node(id: string, providers: string[], platform = 'linux') {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: providers },
        git: { branch: 'main', headCommit: null },
    } as any;
}

test('(a) model flows from a configured slot through the panel into the replica plan', () => {
    // Two configured slots on two live nodes, each carrying a distinct model.
    const slots = [
        { provider: 'claude-cli', nodeId: 'alpha', model: 'opus' },
        { provider: 'codex-cli', nodeId: 'beta', model: 'gpt-5' },
    ];
    const panel = buildInlineMagiPanel(slots, { description: 'kind:rca' });
    // The panel members preserve the model axis.
    assert.equal(panel.members[0].model, 'opus');
    assert.equal(panel.members[1].model, 'gpt-5');

    const plan = buildMagiFanoutPlan(panel, [node('alpha', ['claude-cli']), node('beta', ['codex-cli'])]);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.replicas.length, 2);
    // Every replica carries the model of its member so the launch forwards it as initialModel.
    const byProvider = new Map(plan.replicas.map(r => [r.provider, r.model]));
    assert.equal(byProvider.get('claude-cli'), 'opus');
    assert.equal(byProvider.get('codex-cli'), 'gpt-5');
});

test('(c) a slot pinned to an OFFLINE node is unavailable — no auto-synthesis, not enough targets', () => {
    // One live slot + one slot pinned to a node absent from the live mesh.
    const slots = [
        { provider: 'claude-cli', nodeId: 'alpha' },
        { provider: 'codex-cli', nodeId: 'ghost' }, // 'ghost' is not in the live mesh
    ];
    const panel = buildInlineMagiPanel(slots, { description: 'kind:rca' });
    const plan = buildMagiFanoutPlan(panel, [node('alpha', ['claude-cli'])]);

    // The offline-pinned slot is reported unavailable (not silently replaced).
    assert.equal(plan.unavailableMembers.length, 1);
    assert.equal(plan.unavailableMembers[0].nodeId, 'ghost');
    // Only 1 target resolves → the ≥2 guard fails: the review surfaces a clear error
    // (magi_insufficient_targets) instead of degrading to N=1 or synthesizing a panel.
    assert.equal(plan.enoughTargets, false);
    assert.equal(plan.distinctTargets, 1);
});

test('(a) a fully-live configured kind-panel resolves to ≥2 independent targets', () => {
    const slots = [
        { provider: 'claude-cli', nodeId: 'alpha', model: 'opus' },
        { provider: 'codex-cli', nodeId: 'beta' },
    ];
    const panel = buildInlineMagiPanel(slots);
    const plan = buildMagiFanoutPlan(panel, [node('alpha', ['claude-cli']), node('beta', ['codex-cli'])]);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.distinctProviders, 2);
    assert.equal(plan.distinctNodeTargets, 2);
});
