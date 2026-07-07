import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAGI_MAX_REPLICAS,
    buildMagiFanoutPlan,
    parseMagiResponse,
    synthesizeMagiResponses,
} from '../src/tools/mesh-tools.js';

// ─── parseMagiResponse ──────────────────────────

test('parseMagiResponse parses a raw common-schema JSON object', () => {
    const text = JSON.stringify({
        claims: [{ claim: 'X is the root cause', stance: 'support', evidence: ['a.ts:10'], confidence: 0.9 }],
        top_findings: ['finding one'],
        open_questions: ['q1'],
    });
    const parsed = parseMagiResponse(text);
    assert.ok(parsed);
    assert.equal(parsed!.claims.length, 1);
    assert.equal(parsed!.claims[0].stance, 'support');
    assert.deepEqual(parsed!.top_findings, ['finding one']);
});

test('parseMagiResponse extracts JSON embedded in prose / code fence', () => {
    const text = 'Here is my analysis.\n```json\n' + JSON.stringify({
        claims: [{ claim: 'leak in resolver', stance: 'support', evidence: [], confidence: 0.7 }],
        top_findings: [],
        open_questions: [],
    }) + '\n```\nThat is all.';
    const parsed = parseMagiResponse(text);
    assert.ok(parsed);
    assert.equal(parsed!.claims[0].claim, 'leak in resolver');
});

test('parseMagiResponse coerces invalid stance to uncertain and clamps confidence', () => {
    const parsed = parseMagiResponse(JSON.stringify({
        claims: [{ claim: 'c', stance: 'maybe', evidence: ['x'], confidence: 5 }],
        top_findings: [],
        open_questions: [],
    }));
    assert.ok(parsed);
    assert.equal(parsed!.claims[0].stance, 'uncertain');
    assert.equal(parsed!.claims[0].confidence, 1);
});

test('parseMagiResponse returns null for non-JSON / empty', () => {
    assert.equal(parseMagiResponse('no json here'), null);
    assert.equal(parseMagiResponse(''), null);
    assert.equal(parseMagiResponse('{}'), null);
});

// ─── synthesizeMagiResponses ────────────────────

function resp(taskId: string, nodeId: string, provider: string, claims: any[], openQuestions: string[] = []) {
    return {
        source: { taskId, nodeId, provider, ok: true },
        response: { claims, top_findings: [], open_questions: openQuestions },
    };
}

test('agreed: same claim across distinct providers + machines with evidence is high-independence', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'race condition in queue drain', stance: 'support', evidence: ['queue.ts:42'], confidence: 0.8 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'race condition in the queue drain path', stance: 'support', evidence: ['queue.ts:42'], confidence: 0.7 }]),
    ]);
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].category, 'agreed');
    assert.equal(out.clusters[0].needsVerification, false);
    assert.equal(out.agreed.length, 1);
    assert.equal(out.independenceBanner, null);
});

test('singleton: a claim raised by exactly one agent is routed to needs_verification', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'unique finding only A saw', stance: 'support', evidence: ['z.ts:1'], confidence: 0.6 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'a completely different observation about config', stance: 'support', evidence: ['c.ts:9'], confidence: 0.6 }]),
    ]);
    assert.equal(out.clusters.length, 2);
    assert.ok(out.clusters.every(c => c.category === 'singleton'));
    assert.equal(out.needsVerification.length, 2);
});

test('contested: a split stance is surfaced as needs_verification', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'the daemon is stale', stance: 'support', evidence: ['d.ts:3'], confidence: 0.9 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'the daemon is stale', stance: 'oppose', evidence: ['d.ts:3'], confidence: 0.9 }]),
    ]);
    assert.equal(out.clusters.length, 1);
    assert.ok(out.clusters[0].category === 'contested' || out.clusters[0].category === 'dissent');
    assert.equal(out.needsVerification.length, 1);
});

test('dissent: a minority oppose against a supported majority', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'fix requires a code change', stance: 'support', evidence: ['x.ts:1'], confidence: 0.8 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'fix requires a code change', stance: 'support', evidence: ['x.ts:1'], confidence: 0.8 }]),
        resp('t3', 'nodeC', 'hermes-cli', [{ claim: 'fix requires a code change', stance: 'oppose', evidence: ['x.ts:1'], confidence: 0.8 }]),
    ]);
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].category, 'dissent');
    assert.equal(out.clusters[0].stance.support, 2);
    assert.equal(out.clusters[0].stance.oppose, 1);
    assert.equal(out.needsVerification.length, 1);
});

test('source_coupled: agreement on a single provider/machine is discounted', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'memory leak in cache', stance: 'support', evidence: ['m.ts:5'], confidence: 0.8 }]),
        resp('t2', 'nodeA', 'claude-cli', [{ claim: 'memory leak in the cache', stance: 'support', evidence: ['m.ts:5'], confidence: 0.8 }]),
    ]);
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].category, 'source_coupled');
    assert.equal(out.clusters[0].needsVerification, true);
    assert.ok(out.independenceBanner && out.independenceBanner.includes('independence not achieved'));
});

test('require_independent_evidence routes an evidence-less high-confidence agreement to needs_verification', () => {
    const withEvidenceReq = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'the API is broken', stance: 'support', evidence: [], confidence: 0.9 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'the API is broken', stance: 'support', evidence: [], confidence: 0.9 }]),
    ], { requireIndependentEvidence: true });
    assert.equal(withEvidenceReq.clusters[0].needsVerification, true);
    assert.ok(withEvidenceReq.clusters[0].reasons.some(r => r.includes('evidence')));

    const withoutReq = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'the API is broken', stance: 'support', evidence: [], confidence: 0.9 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'the API is broken', stance: 'support', evidence: [], confidence: 0.9 }]),
    ], { requireIndependentEvidence: false });
    assert.equal(withoutReq.clusters[0].needsVerification, false);
});

test('missing replicas: a failed source is counted and excluded from clusters', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'finding', stance: 'support', evidence: ['a.ts:1'], confidence: 0.7 }]),
        { source: { taskId: 't2', nodeId: 'nodeB', provider: 'codex-cli', ok: false, error: 'timeout' }, response: { claims: [], top_findings: [], open_questions: [] } },
    ], { replicasExpected: 2 });
    assert.equal(out.replicasExpected, 2);
    assert.equal(out.replicasAnswered, 1);
    assert.equal(out.replicasMissing, 1);
});

test('shared file:line evidence merges claims with different wording', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'the resolver returns a bad path', stance: 'support', evidence: ['resolver.ts:128'], confidence: 0.8 }]),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'execFile throws EINVAL on the cmd', stance: 'support', evidence: ['resolver.ts:128'], confidence: 0.8 }]),
    ]);
    // Same file:line evidence forces a single cluster even though wording differs.
    assert.equal(out.clusters.length, 1);
});

test('openQuestions are unioned and deduped across responses', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', [{ claim: 'c1', stance: 'support', evidence: ['a:1'], confidence: 0.5 }], ['shared q', 'q from A']),
        resp('t2', 'nodeB', 'codex-cli', [{ claim: 'c1', stance: 'support', evidence: ['a:1'], confidence: 0.5 }], ['shared q', 'q from B']),
    ]);
    assert.deepEqual([...out.openQuestions].sort(), ['q from A', 'q from B', 'shared q']);
});

// ─── buildMagiFanoutPlan ────────────────────────

function node(id: string, provider: string, platform = 'linux') {
    return {
        id,
        workspace: `/ws/${id}`,
        userOverrides: { platform, arch: 'x64' },
        policy: { providerPriority: [provider] },
    } as any;
}

test('buildMagiFanoutPlan expands slots to replicas and assesses diversity', () => {
    const slots = [
        { nodeId: 'win32-main', provider: 'claude-cli' },
        { nodeId: 'mac-coord', provider: 'codex-cli' },
        { nodeId: 'moltbot', provider: 'hermes-cli' },
    ];
    const nodes = [node('win32-main', 'claude-cli', 'win32'), node('mac-coord', 'codex-cli', 'darwin'), node('moltbot', 'hermes-cli', 'linux')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, { defaultN: 1 });
    assert.equal(plan.replicas.length, 3);
    assert.equal(plan.distinctProviders, 3);
    assert.equal(plan.distinctNodeTargets, 3);
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.coupled, false);
    // Each replica hard-filters on its provider tag.
    assert.ok(plan.replicas.every(r => r.requiredTags.includes(`provider=${r.provider}`)));
});

test('buildMagiFanoutPlan flags a single-provider/single-node panel as coupled', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli', n: 2 }];
    const plan = buildMagiFanoutPlan(slots as any, [node('a', 'claude-cli')], { defaultN: 1 });
    assert.equal(plan.replicas.length, 2);
    assert.equal(plan.coupled, true);
    // One node × one provider → one distinct target → insufficient.
    assert.equal(plan.enoughTargets, false);
});

test('buildMagiFanoutPlan marks unavailable slots and excludes them', () => {
    const slots = [
        { nodeId: 'present', provider: 'claude-cli' },
        { nodeId: 'ghost', provider: 'codex-cli' },
    ];
    const plan = buildMagiFanoutPlan(slots as any, [node('present', 'claude-cli')], {});
    assert.equal(plan.replicas.length, 1);
    assert.equal(plan.unavailableSlots.length, 1);
    assert.equal(plan.unavailableSlots[0].nodeId, 'ghost');
    assert.equal(plan.enoughTargets, false);
});

test('buildMagiFanoutPlan clamps total replicas to the guard cap and reports the drop', () => {
    const slots = [
        { nodeId: 'a', provider: 'claude-cli', n: 10 },
        { nodeId: 'b', provider: 'codex-cli', n: 10 },
    ];
    const plan = buildMagiFanoutPlan(slots as any, [node('a', 'claude-cli'), node('b', 'codex-cli')], {});
    assert.equal(plan.totalRequested, 20);
    assert.equal(plan.totalAfterCap, MAGI_MAX_REPLICAS);
    assert.equal(plan.droppedReplicas, 20 - MAGI_MAX_REPLICAS);
});

test('buildMagiFanoutPlan global n override applies when slot.n / defaultN absent', () => {
    const slots = [{ nodeId: 'a', provider: 'claude-cli' }, { nodeId: 'b', provider: 'codex-cli' }];
    const plan = buildMagiFanoutPlan(slots as any, [node('a', 'claude-cli'), node('b', 'codex-cli')], { n: 2 });
    assert.equal(plan.replicas.length, 4);
});

test('buildMagiFanoutPlan resolves a tag-routed slot against node capability tags', () => {
    const slots = [{ capabilityTags: ['os=darwin'], provider: 'codex-cli' }, { nodeId: 'w', provider: 'claude-cli' }];
    const nodes = [node('mac', 'codex-cli', 'darwin'), node('w', 'claude-cli', 'win32')];
    const plan = buildMagiFanoutPlan(slots as any, nodes, {});
    assert.equal(plan.enoughTargets, true);
    assert.equal(plan.unavailableSlots.length, 0);
});
