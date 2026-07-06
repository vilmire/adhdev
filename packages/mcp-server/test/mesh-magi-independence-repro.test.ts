import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeMagiResponses } from '../src/tools/mesh-tools.js';

// Repro harness for the owner-reported MAGI symptom:
//   "independence not achieved — answering replicas span 1 provider(s) and 1 machine(s)"
//   with 4/5 replicas missing.
//
// These cases feed the REAL synthesizeMagiResponses over inputs modeled on a live
// standalone fan-out (single machine, 4 distinct providers, all answering "main" for
// the default-branch question) and confirm exactly which axis produces the verdict.

function resp(taskId: string, nodeId: string, provider: string, claim: string, evidence: string[]) {
    return {
        source: { taskId, nodeId, provider, ok: true },
        response: {
            claims: [{ claim, stance: 'support' as const, evidence, confidence: 0.9 }],
            top_findings: [],
            open_questions: [],
        },
    };
}

// A dropped/missing replica: ok=false (stale / unparseable / never-answered).
function missing(taskId: string, nodeId: string, provider: string, error: string) {
    return {
        source: { taskId, nodeId, provider, ok: false, error },
        response: { claims: [], top_findings: [], open_questions: [] },
    };
}

test('standalone single-machine, 4 distinct providers, all answer → still NOT independent (machine axis)', () => {
    // The live standalone emulation: one machine (nodeId 'self'), 4 providers, all say "main".
    const out = synthesizeMagiResponses([
        resp('t-agy', 'self', 'antigravity-cli', 'default branch is main', ['git remote show origin: HEAD branch: main']),
        resp('t-her', 'self', 'hermes-cli', 'default branch is main', ['git remote show origin: HEAD branch: main']),
        resp('t-cla', 'self', 'claude-cli', 'default branch is main', ['git symbolic-ref refs/remotes/origin/HEAD']),
        resp('t-cod', 'self', 'codex-cli', 'default branch is main', ['git config branch.main.merge']),
    ]);

    assert.equal(out.replicasAnswered, 4, 'all four replicas answered');
    assert.equal(out.distinctProviders, 4, 'four distinct providers');
    assert.equal(out.distinctNodes, 1, 'single machine → distinctNodes collapses to 1');
    // Even with 4 distinct providers agreeing, the machine axis (=1) trips the banner.
    assert.ok(out.independenceBanner, 'banner fires: machine axis is a hard AND-gate');
    assert.match(out.independenceBanner!, /1 machine\(s\)/);
    assert.match(out.independenceBanner!, /4 provider\(s\)/);
    // The agreeing cluster is demoted to source_coupled (low independence) → needs_verification.
    const cluster = out.clusters[0];
    assert.equal(cluster.category, 'source_coupled');
    assert.equal(cluster.needsVerification, true);
});

test('owner symptom: 5 dispatched, 4 missing, 1 answered → "1 provider(s) and 1 machine(s)"', () => {
    // Genuinely diverse fan-out (5 replicas across machines/providers) but 4 are dropped
    // during collection (stale/unparseable). The verdict is computed ONLY over the
    // answering replicas, so a single survivor reads as 1 provider / 1 machine — exactly
    // the owner's banner — even though the *dispatch* was diverse.
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', 'default branch is main', ['git remote show origin']),
        missing('t2', 'nodeB', 'codex-cli', 'stale: assignment not in live mesh'),
        missing('t3', 'nodeC', 'hermes-cli', 'unparseable_output'),
        missing('t4', 'nodeA', 'antigravity-cli', 'no_session_to_read'),
        missing('t5', 'nodeD', 'gemini-cli', 'replica_missing'),
    ], { replicasExpected: 5 });

    assert.equal(out.replicasExpected, 5);
    assert.equal(out.replicasAnswered, 1, 'only one survived collection');
    assert.equal(out.replicasMissing, 4, 'four dropped → missing');
    assert.equal(out.distinctProviders, 1, 'answering set collapsed to 1 provider');
    assert.equal(out.distinctNodes, 1, 'answering set collapsed to 1 machine');
    assert.ok(out.independenceBanner);
    // Loss-aware banner: because missing (4) >= answered (1), the banner names the
    // collection failure and dropped count rather than implying a mono-source panel.
    assert.match(out.independenceBanner!, /replica-loss\/collection failure/);
    assert.match(out.independenceBanner!, /1 of 5 replica\(s\) answered \(4 missing\/dropped\)/);
    assert.doesNotMatch(out.independenceBanner!, /the answering replicas span/,
        'loss-dominated case must NOT use the low-diversity phrasing');
});

test('low-diversity (not loss): all replicas answered but panel mono-provider → diversity phrasing', () => {
    // Every replica answered; the panel was simply not diverse (2 replicas, same provider,
    // 2 machines). Missing = 0, so the banner keeps the "answering replicas span" phrasing.
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', 'default branch is main', ['git remote show origin']),
        resp('t2', 'nodeB', 'claude-cli', 'default branch is main', ['git symbolic-ref']),
    ], { replicasExpected: 2 });
    assert.equal(out.replicasAnswered, 2);
    assert.equal(out.replicasMissing, 0);
    assert.equal(out.distinctProviders, 1);
    assert.equal(out.distinctNodes, 2);
    assert.ok(out.independenceBanner);
    assert.match(out.independenceBanner!, /the answering replicas span 1 provider\(s\) and 2 machine\(s\)/);
    assert.doesNotMatch(out.independenceBanner!, /replica-loss/);
});

test('genuine independence: distinct providers AND distinct machines, all answering → agreed', () => {
    const out = synthesizeMagiResponses([
        resp('t1', 'nodeA', 'claude-cli', 'default branch is main', ['git remote show origin']),
        resp('t2', 'nodeB', 'codex-cli', 'default branch is main', ['git symbolic-ref']),
    ]);
    assert.equal(out.distinctProviders, 2);
    assert.equal(out.distinctNodes, 2);
    assert.equal(out.independenceBanner, null, 'no banner when both axes ≥ 2');
    assert.equal(out.clusters[0].category, 'agreed');
});
