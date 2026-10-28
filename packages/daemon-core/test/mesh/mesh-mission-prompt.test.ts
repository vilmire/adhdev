import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Structured missions, bundle B (design 2026-10-28 §7, §5.3): the coordinator-prompt mission section.
const testConfigDir = join(tmpdir(), `adhdev-mission-prompt-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { CARRY_OVER_MISSION_TITLE } from '@adhdev/mesh-shared';
import { listMeshMissionsForTool } from '../../src/mesh/mesh-missions.js';
import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import {
    MISSION_BLOCK_CHAR_CAP,
    MISSION_MIGRATION_HINT,
    acknowledgeAnsweredDecisions,
    buildMissionPromptSection,
} from '../../src/mesh/mesh-mission-prompt.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js';
import { __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();

beforeEach(() => { meshId = `mission-prompt-${randomUUID().slice(0, 8)}`; });
afterEach(() => {
    __clearMeshQueueForTests(meshId);
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

function write(input: Parameters<typeof upsertStructuredMission>[1], actor: 'coordinator' | 'daemon' = 'coordinator') {
    return upsertStructuredMission(meshId, input, { actor });
}

/** What bundle C will do: record an owner answer on an open decision. */
function answerDecision(itemId: string, answer: { optionId?: string; text?: string; at?: string; via?: string }) {
    const items = store().missionItems();
    const item = items.getItem(meshId, itemId)!;
    items.updateItem(meshId, itemId, {
        state: 'answered',
        decision: { ...item.decision!, answer: { by: 'owner', via: (answer.via ?? 'assistant') as any, at: answer.at ?? new Date().toISOString(), ...(answer.optionId ? { optionId: answer.optionId } : {}), ...(answer.text ? { text: answer.text } : {}) } },
    });
}

function missionWithDecisions() {
    const r = write({
        title: 'Ship budget feature',
        goal: 'LONG-GOAL-TEXT-THAT-MUST-NOT-APPEAR '.repeat(10),
        summary: 'Backend merged; waiting on the budget default and the npmrc call.',
        itemsAdd: [
            { kind: 'remaining', text: 'wire the dashboard card' },
            { kind: 'remaining', text: 'update CHANGELOG' },
            { kind: 'live_check', text: 'verify on win32', machine: 'win32' },
            { kind: 'decision', question: 'Budget default?', options: [{ label: 'temp value' }, { label: 'final value' }], recommended: 'a', urgency: 'blocking' },
            { kind: 'decision', question: 'Keep the npmrc as-is?', options: [{ label: 'yes' }, { label: 'no' }] },
        ],
    });
    return r.record.id;
}

describe('buildMissionPromptSection — structured rendering', () => {
    it('renders title, summary, open counts, open decisions (blocking marked, recommended shown) and not the goal', () => {
        missionWithDecisions();
        const section = buildMissionPromptSection(meshId);
        expect(section).toContain('## Active Mission');
        expect(section).toContain('Ship budget feature');
        expect(section).toContain('Summary: Backend merged; waiting on the budget default');
        expect(section).toContain('Open: 2 remaining, 1 live_check, 2 decision (1 blocking)');
        expect(section).toMatch(/\? mi_\w+ \[blocking\] Budget default\? \(rec a: temp value\)/);
        expect(section).toMatch(/\? mi_\w+ Keep the npmrc as-is\?/);
        expect(section).not.toContain('LONG-GOAL-TEXT');
        expect(section).toContain('never answer one yourself');
        // the blocking decision is listed before the normal one
        expect(section.indexOf('Budget default?')).toBeLessThan(section.indexOf('Keep the npmrc'));
    });

    it('falls back to the start of the goal when there is no summary', () => {
        write({ title: 'Legacy-ish', goal: 'Split the monolith into packages', itemsAdd: [{ kind: 'remaining', text: 'x' }] });
        const section = buildMissionPromptSection(meshId);
        expect(section).toContain('Goal: Split the monolith into packages');
    });

    it('keeps each mission block within the 600-char cap with a deterministic "+N more"', () => {
        const itemsAdd = Array.from({ length: 12 }, (_, i) => ({
            kind: 'decision',
            question: `Question number ${i} about something fairly long that eats the budget quickly`,
            options: [{ label: 'option label one' }, { label: 'option label two' }],
            recommended: 'a',
        }));
        write({ title: 'Many decisions', summary: 'S'.repeat(300), itemsAdd });
        const a = buildMissionPromptSection(meshId);
        const b = buildMissionPromptSection(meshId);
        expect(a).toBe(b); // deterministic
        const block = a.split('\n').slice(1, -1).join('\n'); // header + footer removed → one mission block
        expect(block.length).toBeLessThanOrEqual(MISSION_BLOCK_CHAR_CAP);
        expect(block).toMatch(/\+\d+ more/);
        const shown = (block.match(/\? mi_/g) ?? []).length;
        const more = Number(/\+(\d+) more/.exec(block)![1]);
        expect(shown + more).toBe(12); // nothing silently lost
    });

    it('cap holds even with the worst-case inputs (long title, long summary, answered + open decisions)', () => {
        const id = write({
            title: 'T'.repeat(200),
            summary: 'S'.repeat(300),
            itemsAdd: [
                { kind: 'decision', question: 'Q'.repeat(300), options: [{ label: 'L'.repeat(60) }], recommended: 'a', urgency: 'blocking' },
                { kind: 'decision', question: 'second', options: [] },
            ],
        }).record.id;
        const first = store().missionItems().listItems(meshId, id, { kinds: ['decision'] })[0];
        answerDecision(first.id, { optionId: 'a', text: 'x'.repeat(300) });
        const section = buildMissionPromptSection(meshId);
        const block = section.split('\n').slice(1, -1).join('\n');
        expect(block.length).toBeLessThanOrEqual(MISSION_BLOCK_CHAR_CAP);
    });
});

describe('decision deadlines', () => {
    it('shows when a decision auto-applies or is merely due, compactly', () => {
        write({ title: 'Due', summary: 's', itemsAdd: [
            { kind: 'decision', question: 'Auto?', options: [{ label: 'yes' }, { label: 'no' }], recommended: 'a', due_at: '2026-10-30T09:00:00Z', on_due: 'apply_recommended' },
            { kind: 'decision', question: 'Remind?', options: [{ label: 'yes' }], recommended: 'a', due_at: '2026-11-02T09:00:00Z' },
            { kind: 'decision', question: 'Plain?', options: [{ label: 'yes' }], due_at: '2026-11-05T09:00:00Z' },
        ] });
        const section = buildMissionPromptSection(meshId);
        expect(section).toContain('Auto? (rec a: yes; auto-applies 10-30)');
        expect(section).toContain('Remind? (rec a: yes; due 11-02)');
        expect(section).toContain('Plain? (due 11-05)');
        const block = section.split('\n').slice(1, -1).join('\n');
        expect(block.length).toBeLessThanOrEqual(MISSION_BLOCK_CHAR_CAP);
    });
});

describe('carry-over mission in the prompt', () => {
    it('drops the boilerplate Goal line: title + [carry-over] + open items only', () => {
        const m = write({ title: 'Doomed2', itemsAdd: [{ kind: 'remaining', text: 'left' }] });
        write({ id: m.record.id, status: 'completed' });
        const section = buildMissionPromptSection(meshId);
        const carry = section.split('\n').filter(l => l.includes('[carry-over]') || l.startsWith('  '));
        expect(section).toContain('[carry-over]');
        expect(section).not.toMatch(/Goal:/);
        expect(section).not.toContain('Open items carried over');
        expect(carry.join('\n')).toContain('Open: 1 remaining');
    });

    it('is omitted while it has no open items and shown (labelled) once it does', () => {
        write({ title: 'Normal mission', summary: 's', itemsAdd: [{ kind: 'remaining', text: 'a' }] });
        // The carry-over mission exists (created by a close) but is empty → not listed.
        const closing = write({ title: 'Doomed', itemsAdd: [{ kind: 'remaining', text: 'left over' }] });
        write({ id: closing.record.id, status: 'completed' }); // moves 'left over' → carry-over
        const section = buildMissionPromptSection(meshId);
        expect(section).toContain('[carry-over]');
        expect(section).toContain(CARRY_OVER_MISSION_TITLE);
        expect(section).toContain('Open: 1 remaining');
        expect(section).not.toContain('Doomed'); // closed missions are not active

        // Drop the carried item → the carry-over mission has nothing open → it disappears.
        const carryId = store().missionItems().findCarryOverMissionId(meshId)!;
        const carried = store().missionItems().listItems(meshId, carryId, { states: ['open'] });
        store().missionItems().updateItem(meshId, carried[0].id, { state: 'dropped' });
        expect(buildMissionPromptSection(meshId)).not.toContain('[carry-over]');
    });

    it('a mesh whose only active mission is an empty carry-over mission renders no section at all', () => {
        const m = write({ title: 'gone', itemsAdd: [{ kind: 'remaining', text: 'a' }] }).record.id;
        write({ id: m, status: 'completed' });
        const carryId = store().missionItems().findCarryOverMissionId(meshId)!;
        for (const i of store().missionItems().listItems(meshId, carryId, { states: ['open'] })) {
            store().missionItems().updateItem(meshId, i.id, { state: 'dropped' });
        }
        expect(buildMissionPromptSection(meshId)).toBe('');
    });
});

describe('answered decisions — shown once, then gone after acknowledgement', () => {
    it('shows "answered" lines with the answer + channel, repeated builds are identical (pure), and the coordinator write acks them', () => {
        const missionId = missionWithDecisions();
        const decisions = store().missionItems().listItems(meshId, missionId, { kinds: ['decision'] });
        answerDecision(decisions[0].id, { optionId: 'b', via: 'push' });
        answerDecision(decisions[1].id, { text: 'keep it as is', via: 'assistant' });

        const s1 = buildMissionPromptSection(meshId);
        expect(s1).toMatch(/✓ mi_\w+ Budget default\? → b: final value \(via push\)/);
        expect(s1).toMatch(/✓ mi_\w+ Keep the npmrc as-is\? → keep it as is \(via assistant\)/);
        expect(s1).toContain('Open: 2 remaining, 1 live_check'); // answered decisions no longer count as open
        // idempotent: building the prompt does not consume the answers
        expect(buildMissionPromptSection(meshId)).toBe(s1);
        expect(buildMissionPromptSection(meshId)).toBe(s1);

        // the coordinator touching the mission = it has seen them
        write({ id: missionId, summary: 'Decisions received; proceeding.' });
        const s2 = buildMissionPromptSection(meshId);
        expect(s2).not.toContain('✓');
        expect(s2).toContain('Decisions received; proceeding.');
        expect(buildMissionPromptSection(meshId)).toBe(s2);
    });

    it('a CHANGED answer (newer answer.at) re-surfaces after an ack; a daemon write does not ack', () => {
        const missionId = missionWithDecisions();
        const [d] = store().missionItems().listItems(meshId, missionId, { kinds: ['decision'] });
        answerDecision(d.id, { optionId: 'a', at: '2026-10-29T10:00:00.000Z' });
        write({ id: missionId }, 'daemon'); // not a coordinator write
        expect(buildMissionPromptSection(meshId)).toContain('✓');

        expect(acknowledgeAnsweredDecisions(meshId, missionId, '2026-10-29T10:05:00.000Z')).toBe(1);
        expect(acknowledgeAnsweredDecisions(meshId, missionId, '2026-10-29T10:06:00.000Z')).toBe(0); // idempotent
        expect(buildMissionPromptSection(meshId)).not.toContain('✓');

        answerDecision(d.id, { optionId: 'b', at: '2026-10-29T11:00:00.000Z' }); // owner changed their mind
        expect(buildMissionPromptSection(meshId)).toMatch(/✓ .* → b: final value/);
    });

    it('an answer whose delivery message was already acked is not shown', () => {
        const missionId = missionWithDecisions();
        const [d] = store().missionItems().listItems(meshId, missionId, { kinds: ['decision'] });
        answerDecision(d.id, { optionId: 'a' });
        const items = store().missionItems();
        const cur = items.getItem(meshId, d.id)!;
        items.updateItem(meshId, d.id, { decision: { ...cur.decision!, delivery: { messageId: d.id, state: 'acked' } } });
        expect(buildMissionPromptSection(meshId)).not.toContain('✓');
    });
});

describe('migration nudge (§5.3)', () => {
    it('shows the hint for a mission with no summary and no items, until it gets a summary or any item', () => {
        const legacy = write({ title: 'Old goal-only mission', goal: 'everything in one paragraph' }).record.id;
        expect(buildMissionPromptSection(meshId)).toContain(MISSION_MIGRATION_HINT);

        write({ id: legacy, summary: 'now structured' });
        expect(buildMissionPromptSection(meshId)).not.toContain(MISSION_MIGRATION_HINT);

        const another = write({ title: 'Another legacy', goal: 'g' }).record.id;
        expect(buildMissionPromptSection(meshId)).toContain(MISSION_MIGRATION_HINT);
        write({ id: another, itemsAdd: [{ kind: 'evidence', text: 'any item at all' }] });
        expect(buildMissionPromptSection(meshId)).not.toContain(MISSION_MIGRATION_HINT);
    });

    it('is not shown for a mission created with a summary', () => {
        write({ title: 'Fresh', summary: 'already structured' });
        expect(buildMissionPromptSection(meshId)).not.toContain(MISSION_MIGRATION_HINT);
    });
});

describe('prompt integration + verbose goal', () => {
    it('the section flows into the coordinator system prompt', () => {
        missionWithDecisions();
        const prompt = buildCoordinatorSystemPrompt({
            mesh: { id: meshId, name: 'M', repoIdentity: 'x/y', policy: {}, coordinator: {}, nodes: [{ id: 'n1', workspace: '/r', userOverrides: {}, policy: {} }], createdAt: 'x', updatedAt: 'x' } as any,
            coordinatorCliType: 'claude-cli',
            missionSection: buildMissionPromptSection(meshId),
        });
        expect(prompt).toContain('Budget default?');
        expect(prompt).not.toContain('LONG-GOAL-TEXT');
    });

    it('mesh_mission_list verbose still returns the full goal', () => {
        missionWithDecisions();
        const list = listMeshMissionsForTool(meshId, { verbose: true });
        expect((list.missions as any[])[0].goal).toContain('LONG-GOAL-TEXT-THAT-MUST-NOT-APPEAR');
    });
});
