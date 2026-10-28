import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Structured missions, bundle C (design 2026-10-28 §6): owner decision answering, delivery, deadlines.
const testConfigDir = join(tmpdir(), `adhdev-mission-decisions-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const assistantSession = { sid: 'assistant-session-1' };
vi.mock('../../src/assistant/assistant-registry.js', () => ({
    getAssistantRegistry: () => ({ read: () => ({ sessionId: assistantSession.sid }), reload: () => ({ sessionId: assistantSession.sid }) }),
}));

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import {
    answerMissionDecision,
    buildOwnerDecisions,
    listRecentlyAnswered,
    processDecisionDeadlines,
} from '../../src/mesh/mesh-mission-decisions.js';
import {
    DECISION_DELIVERY_RETRY_MS,
    DECISION_DELIVERY_RETRY_MAX_MS,
    decisionRetryDelayMs,
    deliverDecisionAnswer,
    formatDecisionDelivery,
    runDecisionTick,
    type DecisionReceiptChecker,
    type DecisionReceiptState,
    type DecisionSender,
} from '../../src/mesh/mesh-mission-decision-delivery.js';
import { buildMissionPromptSection, acknowledgeAnsweredDecisions } from '../../src/mesh/mesh-mission-prompt.js';
import { setMissionChangeListener } from '../../src/mesh/mesh-mission-change-notifier.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { classifyDecisionCaller, MISSION_DECISION_ANSWER, MISSION_DECISION_ANSWER_SOURCES } from '../../src/commands/high-family/mission-decisions.js';
import { attachIpcMcpAuthority } from '../../src/commands/mcp-authority-attach.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { registerMeshCoordinator, unregisterMeshCoordinator } from '../../src/mesh/coordinator-registry.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
const owner = { by: 'owner', via: 'dashboard' } as const;
const notified: string[] = [];

beforeEach(() => { meshId = `mission-decisions-${randomUUID().slice(0, 8)}`; notified.length = 0; setMissionChangeListener(id => { notified.push(id); }); });
afterEach(() => {
    setMissionChangeListener(null);
    __resetMcpSessionCredentialsForTest();
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

function ask(decision: Record<string, unknown> = {}, title = 'Ship budget') {
    const r = upsertStructuredMission(meshId, {
        title, goal: 'g',
        itemsAdd: [{ kind: 'decision', question: 'Budget default?', options: [{ label: 'temp value' }, { label: 'final value' }], recommended: 'a', ...decision }],
    }, { actor: 'coordinator' });
    return { missionId: r.record.id, itemId: r.result.itemResults[0].id! };
}
const item = (id: string) => store().missionItems().getItem(meshId, id)!;
const okSender = () => { const calls: Array<{ text: string; messageId: string }> = []; const fn: DecisionSender = async (r) => { calls.push({ text: r.text, messageId: r.messageId }); return { ok: true }; }; return { fn, calls }; };

describe('answerMissionDecision', () => {
    it('a text answer that is an option letter or label is recorded as that option', () => {
        const { itemId } = ask();
        expect(answerMissionDecision({ meshId, itemId, text: 'B' }, owner)).toMatchObject({ ok: true });
        expect(item(itemId).decision!.answer).toMatchObject({ optionId: 'b' });
        expect(item(itemId).decision!.answer!.text).toBeUndefined();
        answerMissionDecision({ meshId, itemId, text: 'Temp Value' }, owner);
        expect(item(itemId).decision!.answer).toMatchObject({ optionId: 'a' });
        answerMissionDecision({ meshId, itemId, text: 'b please' }, owner);
        expect(item(itemId).decision!.answer).toMatchObject({ text: 'b please' });
    });

    it('records the answer, event, version bump, clears the prompt watermark and arms a pending delivery', () => {
        const { missionId, itemId } = ask();
        const before = store().missionItems().getStructured(meshId, missionId)!.version;
        // an earlier prompt watermark must be cleared by the answer
        const it0 = item(itemId);
        store().missionItems().updateItem(meshId, itemId, { decision: { ...it0.decision!, promptAckedAt: '2000-01-01T00:00:00.000Z' } });
        const r = answerMissionDecision({ meshId, itemId, optionId: 'b' }, owner, Date.parse('2026-10-29T00:00:00Z'));
        expect(r).toMatchObject({ ok: true, action: 'answered', revision: 1 });
        const stored = item(itemId);
        expect(stored.state).toBe('answered');
        expect(stored.decision!.answer).toMatchObject({ optionId: 'b', by: 'owner', via: 'dashboard' });
        expect(stored.decision!.promptAckedAt).toBeUndefined();
        expect(stored.decision!.delivery).toEqual({ messageId: `decision:${itemId}:r1`, state: 'pending', kind: 'answered' });
        expect(store().missionItems().getStructured(meshId, missionId)!.version).toBeGreaterThan(before);
        expect(store().missionItems().listEvents(meshId, missionId, { types: ['decision_answered'] })).toHaveLength(1);
        expect(notified).toContain(meshId);
        // the coordinator prompt shows the answer again
        expect(buildMissionPromptSection(meshId)).toContain(`✓ ${itemId}`);
    });

    it('validates option / free text / assistant provenance / state', () => {
        const { itemId } = ask({ allowFreeText: false });
        expect(answerMissionDecision({ meshId, itemId }, owner)).toMatchObject({ ok: false, code: 'answer_required' });
        expect(answerMissionDecision({ meshId, itemId, optionId: 'z' }, owner)).toMatchObject({ ok: false, code: 'unknown_option', validOptions: ['a', 'b'] });
        expect(answerMissionDecision({ meshId, itemId, text: 'whatever' }, owner)).toMatchObject({ ok: false, code: 'free_text_not_allowed' });
        expect(answerMissionDecision({ meshId, itemId, optionId: 'a' }, { by: 'owner', via: 'assistant' })).toMatchObject({ ok: false, code: 'interpreted_from_required' });
        expect(answerMissionDecision({ meshId, itemId, optionId: 'a', interpretedFrom: 'keep it temporary' }, { by: 'owner', via: 'assistant' })).toMatchObject({ ok: true });
        expect(item(itemId).decision!.answer!.interpretedFrom).toBe('keep it temporary');
        expect(answerMissionDecision({ meshId, itemId: 'mi_nope', optionId: 'a' }, owner)).toMatchObject({ ok: false, code: 'decision_not_found' });
        const w = ask({ question: 'Another?' }, 'M2');
        store().missionItems().updateItem(meshId, w.itemId, { state: 'withdrawn' });
        expect(answerMissionDecision({ meshId, itemId: w.itemId, optionId: 'a' }, owner)).toMatchObject({ ok: false, code: 'decision_not_open' });
    });

    it('a free-text answer works when allowed, and a zero-option decision is free-answer', () => {
        const { itemId } = ask({ question: 'What name?', options: [], recommended: undefined });
        expect(answerMissionDecision({ meshId, itemId, text: 'call it Atlas' }, owner)).toMatchObject({ ok: true });
        expect(item(itemId).decision!.answer).toMatchObject({ text: 'call it Atlas' });
    });

    it('changing the answer replaces it (answer_changed); the same answer again is idempotent', () => {
        const { missionId, itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        expect(answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner)).toMatchObject({ ok: true, action: 'unchanged', revision: 1 });
        const r = answerMissionDecision({ meshId, itemId, optionId: 'b' }, { by: 'owner', via: 'cli' });
        expect(r).toMatchObject({ ok: true, action: 'changed', revision: 2 });
        expect(item(itemId).decision!.answer).toMatchObject({ optionId: 'b', via: 'cli' });
        expect(store().missionItems().listEvents(meshId, missionId, { types: ['decision_answer_changed'] })).toHaveLength(1);
        // never delivered yet → the coordinator is simply told the (single) answer
        expect(item(itemId).decision!.delivery).toMatchObject({ kind: 'answered', messageId: `decision:${itemId}:r2` });
    });

    it('re-asking after an answer returns the stored answer (acceptance 3)', () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'b' }, owner);
        const again = upsertStructuredMission(meshId, { title: 'Other', goal: 'g', itemsAdd: [{ kind: 'decision', question: 'Budget default?', options: [{ label: 'x' }] }] }, { actor: 'coordinator' });
        expect(again.result.itemResults[0]).toMatchObject({ id: itemId, deduped: true, answer: { optionId: 'b', by: 'owner' } });
    });

    it('a coordinator cannot answer through items_update', () => {
        const { missionId, itemId } = ask();
        const r = upsertStructuredMission(meshId, { id: missionId, itemsUpdate: [{ id: itemId, state: 'answered' }] }, { actor: 'coordinator' });
        expect(r.result.itemResults[0].error).toMatch(/decision_answer_not_allowed/);
        expect(item(itemId).state).toBe('open');
    });
});

describe('undo', () => {
    it('undo returns the item to open and clears the answer; no notice when the coordinator never heard it', () => {
        const { missionId, itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        const r = answerMissionDecision({ meshId, itemId, undo: true }, owner);
        expect(r).toMatchObject({ ok: true, action: 'undone', revision: 2 });
        expect((r as any).delivery).toBeUndefined();
        const stored = item(itemId);
        expect(stored.state).toBe('open');
        expect(stored.decision!.answer).toBeUndefined();
        expect(stored.decision!.delivery).toBeUndefined();
        expect(store().missionItems().listEvents(meshId, missionId, { types: ['decision_answer_undone'] })).toHaveLength(1);
        expect(buildOwnerDecisions(meshId).map(e => e.itemId)).toContain(itemId);
        expect(answerMissionDecision({ meshId, itemId, undo: true }, owner)).toMatchObject({ ok: false, code: 'nothing_to_undo' });
    });
});

describe('delivery to the coordinator', () => {
    it('sends exactly once per revision: repeated and concurrent attempts never re-send', async () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'b' }, owner);
        const s = okSender();
        const [a, b] = await Promise.all([deliverDecisionAnswer(meshId, itemId, s.fn), deliverDecisionAnswer(meshId, itemId, s.fn)]);
        expect([a, b].sort()).toEqual(['sent', 'skipped']);
        expect(await deliverDecisionAnswer(meshId, itemId, s.fn)).toBe('skipped');
        await runDecisionTick(meshId, s.fn);
        await runDecisionTick(meshId, s.fn);
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0].messageId).toBe(`decision:${itemId}:r1`);
        expect(s.calls[0].text).toBe(`[owner decision ${itemId}] Budget default? → b: final value`);
        expect(item(itemId).decision!.delivery!.state).toBe('sent');
    });

    it('a failed send stays pending, is retried by the tick after the retry delay with the SAME messageId, then not again', async () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        const ids: string[] = [];
        let fail = true;
        const send: DecisionSender = async (r) => { ids.push(r.messageId); return fail ? { ok: false, code: 'no_coordinator', error: 'down' } : { ok: true }; };
        const t0 = Date.now();
        expect((await runDecisionTick(meshId, send, t0)).failed).toBe(1);
        expect(item(itemId).decision!.delivery).toMatchObject({ state: 'pending' });
        await runDecisionTick(meshId, send, t0 + 1000); // inside the retry delay → untouched
        expect(ids).toHaveLength(1);
        fail = false;
        expect((await runDecisionTick(meshId, send, t0 + DECISION_DELIVERY_RETRY_MS + 1)).delivered).toBe(1);
        await runDecisionTick(meshId, send, t0 + 10 * DECISION_DELIVERY_RETRY_MS);
        expect(ids).toEqual([`decision:${itemId}:r1`, `decision:${itemId}:r1`]);
        expect(item(itemId).decision!.delivery!.state).toBe('sent');
    });

    it('an undeliverable answer backs off (15s, 30s, 1m … capped at 10m) and counts attempts', async () => {
        expect([1, 2, 3, 4].map(decisionRetryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000]);
        expect(decisionRetryDelayMs(50)).toBe(DECISION_DELIVERY_RETRY_MAX_MS);
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        let calls = 0;
        const send: DecisionSender = async () => { calls++; return { ok: false, code: 'no_coordinator', error: 'down' }; };
        const t0 = Date.now();
        await runDecisionTick(meshId, send, t0);
        await runDecisionTick(meshId, send, t0 + 16_000);                 // 2nd attempt after 15s
        await runDecisionTick(meshId, send, t0 + 16_000 + 20_000);        // inside the 30s backoff → skipped
        expect(calls).toBe(2);
        await runDecisionTick(meshId, send, t0 + 16_000 + 31_000);        // 3rd attempt
        expect(calls).toBe(3);
        expect(item(itemId).decision!.delivery).toMatchObject({ state: 'pending', attempts: 3 });
    });

    it('a send the coordinator only queued is confirmed by its receipt, and re-sent under a new id if a restart dropped it', async () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        const ids: string[] = [];
        const send: DecisionSender = async (r) => { ids.push(r.messageId); return { ok: true, queued: true, sessionId: 'coord-1', wireMessageId: `wire:${r.messageId}` }; };
        let receipt: DecisionReceiptState = 'accepted';
        const checked: string[] = [];
        const check: DecisionReceiptChecker = async (sid, wire, text) => { checked.push(`${sid}|${wire}`); expect(text).toContain(`[owner decision ${itemId}]`); return receipt; };
        const t0 = Date.now();
        await runDecisionTick(meshId, send, t0, check);
        expect(item(itemId).decision!.delivery).toMatchObject({ state: 'queued', sessionId: 'coord-1', wireMessageId: `wire:decision:${itemId}:r1` });
        await runDecisionTick(meshId, send, t0 + 1000, check);           // still in the queue → wait
        expect(ids).toEqual([`decision:${itemId}:r1`]);
        expect(checked).toEqual([`coord-1|wire:decision:${itemId}:r1`]);
        receipt = 'busy';                                                 // receipt unknown, coordinator still working → wait
        await runDecisionTick(meshId, send, t0 + 1500, check);
        expect(ids).toHaveLength(1);
        receipt = 'lost';                                                 // idle and not in the transcript: the queue was dropped
        await runDecisionTick(meshId, send, t0 + 2000, check);
        expect(ids).toEqual([`decision:${itemId}:r1`, `decision:${itemId}:r1:a2`]);
        receipt = 'submitted';
        await runDecisionTick(meshId, send, t0 + 3000, check);
        expect(item(itemId).decision!.delivery).toMatchObject({ state: 'sent', messageId: `decision:${itemId}:r1:a2` });
        await runDecisionTick(meshId, send, t0 + 600_000, check);
        expect(ids).toHaveLength(2);
    });

    it('a queued delivery whose receipt is unknown but whose text reached the transcript is not re-sent', async () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        const ids: string[] = [];
        const send: DecisionSender = async (r) => { ids.push(r.messageId); return { ok: true, queued: true, sessionId: 'coord-1', wireMessageId: 'w1' }; };
        await runDecisionTick(meshId, send, Date.now(), async () => 'seen');
        await runDecisionTick(meshId, send, Date.now() + 1000, async () => 'seen');
        expect(ids).toHaveLength(1);
        expect(item(itemId).decision!.delivery!.state).toBe('sent');
    });

    it('a sender that throws leaves the delivery pending (restart-safe: state is persisted, retry reuses the messageId)', async () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        expect(await deliverDecisionAnswer(meshId, itemId, async () => { throw new Error('boom'); })).toBe('failed');
        expect(item(itemId).decision!.delivery).toMatchObject({ state: 'pending', messageId: `decision:${itemId}:r1` });
    });

    it('change after delivery sends "changed"; undo after delivery sends "undone"; each revision once', async () => {
        const { itemId } = ask();
        const s = okSender();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        await deliverDecisionAnswer(meshId, itemId, s.fn);
        answerMissionDecision({ meshId, itemId, optionId: 'b' }, owner);
        await deliverDecisionAnswer(meshId, itemId, s.fn);
        await deliverDecisionAnswer(meshId, itemId, s.fn);
        const undone = answerMissionDecision({ meshId, itemId, undo: true }, owner);
        expect((undone as any).delivery).toMatchObject({ kind: 'undone', state: 'pending' });
        await deliverDecisionAnswer(meshId, itemId, s.fn);
        expect(s.calls.map(c => c.text)).toEqual([
            `[owner decision ${itemId}] Budget default? → a: temp value`,
            `[owner decision changed ${itemId}] → b: final value`,
            `[owner decision undone ${itemId}]`,
        ]);
        expect(s.calls.map(c => c.messageId)).toEqual([1, 2, 3].map(n => `decision:${itemId}:r${n}`));
        // answering again after the undo is a fresh answer, not a "change"
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        expect(item(itemId).decision!.delivery).toMatchObject({ kind: 'answered', messageId: `decision:${itemId}:r4` });
    });

    it('a change that lands while the previous revision is in flight keeps the newer delivery pending', async () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        const send: DecisionSender = async () => {
            answerMissionDecision({ meshId, itemId, optionId: 'b' }, owner); // owner changes mind mid-send
            return { ok: true };
        };
        await deliverDecisionAnswer(meshId, itemId, send);
        expect(item(itemId).decision!.delivery).toMatchObject({ messageId: `decision:${itemId}:r2`, state: 'pending' });
    });

    it('formats an auto-applied answer', () => {
        const { itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, { by: 'auto_recommended', via: 'auto' });
        expect(formatDecisionDelivery(itemId, item(itemId).decision!)).toContain('auto-applied');
    });

    it('acknowledging a delivered answer keeps working with the prompt watermark', async () => {
        const { missionId, itemId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, owner);
        expect(acknowledgeAnsweredDecisions(meshId, missionId)).toBe(1);
        expect(buildMissionPromptSection(meshId)).not.toContain(`✓ ${itemId}`);
    });
});

describe('deadlines', () => {
    const past = '2026-01-01T00:00:00.000Z';
    it('apply_recommended auto-answers after dueAt, is delivered, and can be undone (acceptance 7)', async () => {
        const { itemId } = ask({ dueAt: past, onDue: 'apply_recommended', recommended: 'b' });
        const r = processDecisionDeadlines(meshId, Date.parse('2026-02-01T00:00:00Z'));
        expect(r.autoApplied).toEqual([itemId]);
        expect(item(itemId).decision!.answer).toMatchObject({ optionId: 'b', by: 'auto_recommended', via: 'auto' });
        const s = okSender();
        await runDecisionTick(meshId, s.fn);
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0].text).toContain('auto-applied');
        expect(listRecentlyAnswered(meshId, 0)).toEqual([expect.objectContaining({ itemId, autoApplied: true })]);
        // owner undoes it → coordinator is told, decision reopens
        const undone = answerMissionDecision({ meshId, itemId, undo: true }, owner);
        expect((undone as any).delivery).toMatchObject({ kind: 'undone' });
        expect(item(itemId).state).toBe('open');
    });

    it('does nothing before dueAt; skips withdrawn / superseded / already answered', () => {
        const future = ask({ dueAt: '2999-01-01T00:00:00.000Z', onDue: 'apply_recommended', recommended: 'a', question: 'future?' });
        const wd = ask({ dueAt: past, onDue: 'apply_recommended', recommended: 'a', question: 'withdrawn?' }, 'M2');
        const sup = ask({ dueAt: past, onDue: 'apply_recommended', recommended: 'a', question: 'superseded?' }, 'M3');
        const ans = ask({ dueAt: past, onDue: 'apply_recommended', recommended: 'a', question: 'answered?' }, 'M4');
        store().missionItems().updateItem(meshId, wd.itemId, { state: 'withdrawn' });
        store().missionItems().updateItem(meshId, sup.itemId, { state: 'superseded' });
        answerMissionDecision({ meshId, itemId: ans.itemId, optionId: 'b' }, owner);
        const r = processDecisionDeadlines(meshId, Date.parse('2026-02-01T00:00:00Z'));
        expect(r).toEqual({ autoApplied: [], reminded: [] });
        expect(item(ans.itemId).decision!.answer).toMatchObject({ optionId: 'b', by: 'owner' });
        expect(item(future.itemId).state).toBe('open');
        expect(item(wd.itemId).state).toBe('withdrawn');
    });

    it('remind marks remindedAt once per due crossing and records an event, without answering', () => {
        const { missionId, itemId } = ask({ dueAt: past, onDue: 'remind', urgency: 'blocking' });
        const now = Date.parse('2026-02-01T00:00:00Z');
        expect(processDecisionDeadlines(meshId, now).reminded).toEqual([itemId]);
        expect(processDecisionDeadlines(meshId, now + 60_000).reminded).toEqual([]);
        expect(item(itemId).state).toBe('open');
        expect(item(itemId).decision!.remindedAt).toBeTruthy();
        expect(store().missionItems().listEvents(meshId, missionId, { types: ['decision_reminded'] })).toHaveLength(1);
    });
});

describe('ownerDecisions projection', () => {
    it('lists open decisions across missions incl. carry-over, blocking first, then nearest due, then oldest; answered excluded', async () => {
        const normal = ask({ question: 'normal old?' }, 'M-normal');
        await new Promise(r => setTimeout(r, 5));
        const dueSoon = ask({ question: 'due soon?', dueAt: '2999-01-02T00:00:00.000Z' }, 'M-due-soon');
        const dueLater = ask({ question: 'due later?', dueAt: '2999-06-01T00:00:00.000Z' }, 'M-due-later');
        const blocking = ask({ question: 'blocking?', urgency: 'blocking' }, 'M-blocking');
        const answered = ask({ question: 'answered?' }, 'M-answered');
        answerMissionDecision({ meshId, itemId: answered.itemId, optionId: 'a' }, owner);
        // a decision that arrived without a mission lives in the carry-over mission
        const carry = upsertStructuredMission(meshId, { toCarryOver: true, itemsAdd: [{ kind: 'decision', question: 'carry question?' }] }, { actor: 'worker' });
        const list = buildOwnerDecisions(meshId);
        expect(list.map(e => e.question)).toEqual(['blocking?', 'due soon?', 'due later?', 'normal old?', 'carry question?']);
        expect(list[0]).toMatchObject({ meshId, missionTitle: 'M-blocking', itemId: blocking.itemId, urgency: 'blocking', source: 'coordinator', options: expect.any(Array) });
        expect(list.at(-1)).toMatchObject({ itemId: carry.result.itemResults[0].id, carryOver: true, source: 'worker' });
        expect(list.map(e => e.itemId)).not.toContain(answered.itemId);
        expect(list.map(e => e.itemId)).toContain(normal.itemId);
        expect(dueSoon.itemId && dueLater.itemId).toBeTruthy();
    });
});

describe('who may answer (caller identity)', () => {
    const stamped = (source: string, extra: Record<string, unknown> = {}) => ({ meshId, itemId: 'mi_x', _commandSource: source, ...extra });

    it('owner transports and a plain local CLI pass with the right via; assistant via and forged sources do not', () => {
        expect(classifyDecisionCaller(stamped('p2p'))).toEqual({ ok: true, actor: { by: 'owner', via: 'dashboard' } });
        expect(classifyDecisionCaller(stamped('p2p', { via: 'push' }))).toEqual({ ok: true, actor: { by: 'owner', via: 'push' } });
        expect(classifyDecisionCaller(stamped('standalone'))).toMatchObject({ ok: true });
        expect(classifyDecisionCaller(stamped('ipc'))).toEqual({ ok: true, actor: { by: 'owner', via: 'cli' } });
        expect(classifyDecisionCaller(stamped('p2p', { via: 'assistant' }))).toMatchObject({ ok: false, code: 'decision_answer_not_allowed' });
        // a standalone dashboard with no password configured is demoted to `ipc` — still the owner
        expect(classifyDecisionCaller(stamped('ipc', { via: 'dashboard' }))).toEqual({ ok: true, actor: { by: 'owner', via: 'dashboard' } });
        expect(classifyDecisionCaller(stamped('ipc', { via: 'assistant' }))).toMatchObject({ ok: false, code: 'decision_answer_not_allowed' });
        for (const s of ['mesh', 'internal', 'ws', 'api', 'project_attach', '']) {
            expect(classifyDecisionCaller(stamped(s))).toMatchObject({ ok: false, code: 'decision_answer_not_allowed' });
        }
        expect(classifyDecisionCaller(stamped('ipc', { token: 't' }))).toMatchObject({ ok: false });
        expect(classifyDecisionCaller(stamped('ipc', { bind: 'b' }))).toMatchObject({ ok: false });
    });

    it('a worker credential on the local socket is refused (even an unknown one)', () => {
        const args = stamped('ipc');
        attachIpcMcpAuthority(args, MISSION_DECISION_ANSWER, { workerCredential: 'wrk_anything' });
        expect(classifyDecisionCaller(args)).toMatchObject({ ok: false, code: 'decision_answer_not_allowed' });
    });

    it('a session credential of a non-assistant session (worker / any CLI session) is refused', () => {
        const token = mintMcpSessionCredential({ sessionId: 'worker-session-9', isCoordinator: false });
        const args = stamped('ipc');
        attachIpcMcpAuthority(args, MISSION_DECISION_ANSWER, { sessionCredential: token });
        expect(classifyDecisionCaller(args)).toMatchObject({ ok: false, code: 'decision_answer_not_allowed' });
    });

    it('an unknown / revoked session credential is refused, not treated as a plain CLI', () => {
        const args = stamped('ipc');
        attachIpcMcpAuthority(args, MISSION_DECISION_ANSWER, { sessionCredential: 'mcp_sess_forged' });
        expect(classifyDecisionCaller(args)).toMatchObject({ ok: false });
    });

    it('a live coordinator session credential is refused', () => {
        registerMeshCoordinator({ meshId, sessionId: 'coord-session-1', startedAt: Date.now() });
        try {
            const token = mintMcpSessionCredential({ sessionId: 'coord-session-1', meshId, isCoordinator: true });
            const args = stamped('ipc');
            attachIpcMcpAuthority(args, MISSION_DECISION_ANSWER, { sessionCredential: token });
            expect(classifyDecisionCaller(args)).toMatchObject({ ok: false, code: 'decision_answer_not_allowed' });
        } finally {
            unregisterMeshCoordinator('coord-session-1');
        }
    });

    it('the bound assistant session passes as via=assistant (and only as assistant)', () => {
        const token = mintMcpSessionCredential({ sessionId: assistantSession.sid, isCoordinator: false });
        const args = stamped('ipc');
        attachIpcMcpAuthority(args, MISSION_DECISION_ANSWER, { sessionCredential: token });
        expect(classifyDecisionCaller(args)).toEqual({ ok: true, actor: { by: 'owner', via: 'assistant' } });
        const forged = stamped('ipc', { via: 'cli' });
        attachIpcMcpAuthority(forged, MISSION_DECISION_ANSWER, { sessionCredential: token });
        expect(classifyDecisionCaller(forged)).toMatchObject({ ok: false });
    });

    it('the registered spec never accepts the daemon relay, internal or project-attach sources', () => {
        const spec = getDaemonCommandRegistry().get(MISSION_DECISION_ANSWER)!;
        expect(spec).toBeTruthy();
        expect(spec.sources).toEqual([...MISSION_DECISION_ANSWER_SOURCES]);
        for (const s of ['mesh', 'internal', 'project_attach', 'ws', 'api']) expect(spec.sources).not.toContain(s);
    });
});
