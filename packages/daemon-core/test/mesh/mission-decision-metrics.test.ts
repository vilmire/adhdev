import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testConfigDir = join(tmpdir(), `adhdev-decision-metrics-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => { if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { answerMissionDecision, processDecisionDeadlines } from '../../src/mesh/mesh-mission-decisions.js';
import { computeDecisionMetrics } from '../../src/mesh/mesh-mission-decision-metrics.js';
import { INFERRED_DECISION_CONTEXT } from '../../src/mesh/coordinator-inferred-decision.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

let meshId = '';
beforeEach(() => { meshId = `metrics-${randomUUID().slice(0, 8)}`; });
afterEach(() => {
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

function ask(question: string, extra: Record<string, unknown> = {}, missionId?: string) {
    const r = upsertStructuredMission(meshId, {
        ...(missionId ? { id: missionId } : { title: 'M', goal: 'g' }),
        itemsAdd: [{ kind: 'decision', question, options: [{ label: 'one' }, { label: 'two' }], recommended: 'a', ...extra }],
    }, { actor: 'coordinator' });
    return { missionId: r.record.id, itemId: r.result.itemResults[0].id!, deduped: r.result.itemResults[0].deduped };
}

describe('computeDecisionMetrics', () => {
    it('counts answers by channel, recommended, undo of assistant answers, dedupe hits and auto-applied', () => {
        const a = ask('Q1?');
        const b = ask('Q2?', {}, a.missionId);
        const c = ask('Q3?', { dueAt: new Date(Date.now() - 1000).toISOString(), onDue: 'apply_recommended' }, a.missionId);
        expect(ask('Q1?', {}, a.missionId).deduped).toBe(true);

        answerMissionDecision({ meshId, itemId: a.itemId, optionId: 'a' }, { by: 'owner', via: 'dashboard' });
        answerMissionDecision({ meshId, itemId: b.itemId, optionId: 'b', interpretedFrom: 'the second' }, { by: 'owner', via: 'assistant' });
        answerMissionDecision({ meshId, itemId: b.itemId, undo: true }, { by: 'owner', via: 'dashboard' });
        answerMissionDecision({ meshId, itemId: b.itemId, optionId: 'a', interpretedFrom: 'first' }, { by: 'owner', via: 'assistant' });
        expect(processDecisionDeadlines(meshId).autoApplied).toEqual([c.itemId]);

        const m = computeDecisionMetrics(meshId, 7 * 86_400_000);
        expect(m.answersByVia).toMatchObject({ dashboard: 1, assistant: 2 });
        expect(m.dedupeHitsSinceStart).toBeGreaterThanOrEqual(1);
        expect(m.undone).toBe(1);
        expect(m.assistantAnswersUndone).toBe(1);
        expect(m.assistantAnswers).toBe(2);
        expect(m.autoApplied).toBe(1);
        expect(m.answeredWithRecommended).toBe(2);
        expect(m.open).toBe(0);
        expect(m.turnaroundMs.count).toBe(2);
        expect(m.turnaroundMs.medianMs).not.toBeNull();
    });

    it('counts items carried over by closing a mission', () => {
        const r = upsertStructuredMission(meshId, {
            title: 'Closing', goal: 'g',
            itemsAdd: [{ kind: 'remaining', text: 'left over A' }, { kind: 'remaining', text: 'left over B' }],
        }, { actor: 'coordinator' });
        upsertStructuredMission(meshId, { id: r.record.id, status: 'completed' }, { actor: 'coordinator' });
        expect(computeDecisionMetrics(meshId, 86_400_000).carriedOver).toBe(2);
    });

    it('counts decisions inferred from plain text; registering the same question twice is deduped (carry-over mission)', () => {
        const input = { toCarryOver: true, itemsAdd: [{ kind: 'decision', question: 'Which one should I use?', context: INFERRED_DECISION_CONTEXT, options: [{ label: 'x' }, { label: 'y' }] }] };
        const first = upsertStructuredMission(meshId, input, { actor: 'daemon' });
        const second = upsertStructuredMission(meshId, input, { actor: 'daemon' });
        expect(first.result.itemResults[0].deduped).toBeUndefined();
        expect(second.result.itemResults[0].deduped).toBe(true);
        const m = computeDecisionMetrics(meshId, 86_400_000);
        expect(m.inferredFromPlainText).toBe(1);
        expect(m.dedupeHitsSinceStart).toBeGreaterThanOrEqual(1);
        expect(m.open).toBe(1);
    });

    it('a window that excludes everything reports zeros', () => {
        const a = ask('Q?');
        answerMissionDecision({ meshId, itemId: a.itemId, optionId: 'a' }, { by: 'owner', via: 'cli' });
        const m = computeDecisionMetrics(meshId, 1000, Date.now() + 3_600_000);
        expect(m.answersByVia).toEqual({});
        expect(m.turnaroundMs.count).toBe(0);
    });
});
