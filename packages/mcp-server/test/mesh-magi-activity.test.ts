import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeMagiResponses } from '../src/tools/mesh-tools.js';
import {
    buildMeshMagiActivity,
    summarizeMeshMagiActivity,
    getMeshMagiActivityByGroup,
    RECENT_MAGI_CAP,
} from '@adhdev/daemon-core';

// ─── deltaA: cross-replica git skew in synthesis ──

function gresp(taskId: string, nodeId: string, provider: string, branch: string | null, extra: { ahead?: number; behind?: number } = {}) {
    return {
        source: { taskId, nodeId, provider, ok: true, git: { branch, ahead: extra.ahead ?? 0, behind: extra.behind ?? 0 } },
        response: { claims: [{ claim: 'shared claim', stance: 'support' as const, evidence: ['a.ts:1'], confidence: 0.7 }], top_findings: [], open_questions: [] },
    };
}

test('gitSkew: all replicas on the same branch with no divergence is not skewed', () => {
    const out = synthesizeMagiResponses([
        gresp('t1', 'nodeA', 'claude-cli', 'main'),
        gresp('t2', 'nodeB', 'codex-cli', 'main'),
    ]);
    assert.equal(out.gitSkew.skewed, false);
    assert.equal(out.gitSkew.distinctBranches, 1);
    assert.deepEqual(out.gitSkew.branches, ['main']);
    assert.equal(out.gitSkew.divergentReplicas, 0);
    // Per-replica source identity (incl. git ref) is exposed for the dashboard.
    assert.equal(out.replicas.length, 2);
    assert.equal(out.replicas[0].git?.branch, 'main');
});

test('gitSkew: replicas spanning different branches is flagged skewed', () => {
    const out = synthesizeMagiResponses([
        gresp('t1', 'nodeA', 'claude-cli', 'main'),
        gresp('t2', 'nodeB', 'codex-cli', 'feat/x'),
    ]);
    assert.equal(out.gitSkew.skewed, true);
    assert.equal(out.gitSkew.distinctBranches, 2);
    assert.deepEqual(out.gitSkew.branches, ['feat/x', 'main']);
    assert.ok(out.gitSkew.note && out.gitSkew.note.includes('branches'));
});

test('gitSkew: a replica diverging from upstream (behind>0) is flagged even on one branch', () => {
    const out = synthesizeMagiResponses([
        gresp('t1', 'nodeA', 'claude-cli', 'main'),
        gresp('t2', 'nodeB', 'codex-cli', 'main', { behind: 3 }),
    ]);
    assert.equal(out.gitSkew.skewed, true);
    assert.equal(out.gitSkew.distinctBranches, 1);
    assert.equal(out.gitSkew.divergentReplicas, 1);
});

test('gitSkew: replicas with no captured git ref produce a non-skewed default', () => {
    const out = synthesizeMagiResponses([
        { source: { taskId: 't1', nodeId: 'a', provider: 'claude-cli', ok: true }, response: { claims: [{ claim: 'c', stance: 'support', evidence: ['a:1'], confidence: 0.6 }], top_findings: [], open_questions: [] } },
        { source: { taskId: 't2', nodeId: 'b', provider: 'codex-cli', ok: true }, response: { claims: [{ claim: 'c', stance: 'support', evidence: ['a:1'], confidence: 0.6 }], top_findings: [], open_questions: [] } },
    ]);
    assert.equal(out.gitSkew.skewed, false);
    assert.equal(out.gitSkew.distinctBranches, 0);
});

// ─── deltaE: persisted synthesis activity (ledger) ──

function ledgerEntry(kind: string, payload: Record<string, unknown>, timestamp: string) {
    return { id: `e_${timestamp}_${kind}`, meshId: 'm1', timestamp, kind: kind as any, payload };
}

function synthesisPayload(groupId: string, needsVerification: number, agreed: number) {
    return {
        source: 'magi',
        consensusGroupId: groupId,
        panel: 'design-review',
        question: 'why does X happen?',
        synthesis: {
            replicasExpected: 3,
            replicasAnswered: 2,
            replicasMissing: 1,
            distinctProviders: 2,
            distinctNodes: 2,
            independenceBanner: null,
            clusters: [],
            needsVerification: Array.from({ length: needsVerification }, (_, i) => ({ claim: `nv-${i}`, category: 'contested' })),
            agreed: Array.from({ length: agreed }, (_, i) => ({ claim: `ag-${i}`, category: 'agreed' })),
            openQuestions: ['q1'],
            gitSkew: { skewed: true, distinctBranches: 2, branches: ['feat/x', 'main'], divergentReplicas: 0 },
        },
    };
}

test('buildMeshMagiActivity reconstructs a group and getMeshMagiActivityByGroup retrieves it', () => {
    const entries = [
        ledgerEntry('magi_dispatched', { source: 'magi', consensusGroupId: 'magi_g1', panel: 'design-review', question: 'q', replicaCount: 3 }, '2026-06-29T10:00:00.000Z'),
        ledgerEntry('magi_synthesis', synthesisPayload('magi_g1', 4, 2), '2026-06-29T10:05:00.000Z'),
    ];
    const activity = buildMeshMagiActivity({ meshId: 'm1', ledgerEntries: entries as any });
    assert.equal(activity.length, 1);
    const g = activity[0];
    assert.equal(g.consensusGroupId, 'magi_g1');
    assert.equal(g.status, 'synthesized');
    assert.equal(g.needsVerificationCount, 4);
    assert.equal(g.agreedCount, 2);
    assert.equal(g.replicaCount, 3);
    assert.equal(g.answered, 2);
    assert.equal(g.missing, 1);
    assert.ok(g.gitSkew && g.gitSkew.skewed === true);
    // needsVerification preview is bounded and carries claim+category.
    assert.ok(Array.isArray(g.needsVerification) && g.needsVerification.length === 4);
    assert.equal(g.needsVerification![0].category, 'contested');

    const byGroup = getMeshMagiActivityByGroup(entries as any, 'magi_g1');
    assert.ok(byGroup);
    assert.equal(byGroup!.consensusGroupId, 'magi_g1');
    assert.equal(getMeshMagiActivityByGroup(entries as any, 'nope'), undefined);
});

test('buildMeshMagiActivity keeps a dispatched-only group as running', () => {
    const entries = [
        ledgerEntry('magi_dispatched', { source: 'magi', consensusGroupId: 'magi_run', panel: 'p', question: 'q', replicaCount: 2 }, '2026-06-29T10:00:00.000Z'),
    ];
    const activity = buildMeshMagiActivity({ ledgerEntries: entries as any });
    assert.equal(activity.length, 1);
    assert.equal(activity[0].status, 'running');
});

test('summarizeMeshMagiActivity always keeps running groups and folds stale synthesized ones', () => {
    // One running group + many synthesized groups spread over a >6h window. The
    // synthesized groups older than 6h before the newest activity must be folded out.
    const entries: any[] = [
        ledgerEntry('magi_dispatched', { source: 'magi', consensusGroupId: 'magi_running', replicaCount: 2 }, '2026-06-29T18:00:00.000Z'),
    ];
    // 10 synthesized groups, one per hour from 02:00 to 11:00 — newest synthesized at 11:00,
    // running anchors newest at 18:00 so everything before 12:00 is stale.
    for (let h = 2; h <= 11; h++) {
        const ts = `2026-06-29T${String(h).padStart(2, '0')}:00:00.000Z`;
        entries.push(ledgerEntry('magi_synthesis', synthesisPayload(`magi_s${h}`, 1, 1), ts));
    }
    const activity = buildMeshMagiActivity({ ledgerEntries: entries });
    const fold = summarizeMeshMagiActivity(activity);

    // Running group is always present and listed first.
    assert.equal(fold.byStatus.running, 1);
    assert.equal(fold.groups[0].status, 'running');
    // All synthesized groups are stale relative to the 18:00 anchor → folded out.
    assert.equal(fold.byStatus.synthesized ?? 0, 0);
    assert.ok(fold.staleSynthesized >= 1);
    // Bounded: never more than RECENT_MAGI_CAP synthesized + the running groups.
    assert.ok(fold.groups.length <= RECENT_MAGI_CAP + 1);
});

test('summarizeMeshMagiActivity caps recent synthesized groups to RECENT_MAGI_CAP', () => {
    // Many synthesized groups within a tight (fresh) window → capped to RECENT_MAGI_CAP.
    const entries: any[] = [];
    for (let i = 0; i < RECENT_MAGI_CAP + 4; i++) {
        const ts = `2026-06-29T12:${String(i).padStart(2, '0')}:00.000Z`;
        entries.push(ledgerEntry('magi_synthesis', synthesisPayload(`magi_f${i}`, 1, 1), ts));
    }
    const activity = buildMeshMagiActivity({ ledgerEntries: entries });
    const fold = summarizeMeshMagiActivity(activity);
    assert.equal(fold.groups.length, RECENT_MAGI_CAP);
    assert.equal(fold.byStatus.synthesized, RECENT_MAGI_CAP);
    assert.equal(fold.staleSynthesized, 4);
});
