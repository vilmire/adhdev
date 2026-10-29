import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Opt-in server-relayed push-notification decision answer (mission 4ae3edf2): the dedicated daemon ingress.
const testConfigDir = join(tmpdir(), `adhdev-decision-push-relay-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/assistant/assistant-registry.js', () => ({
    getAssistantRegistry: () => ({ read: () => ({ sessionId: 'assistant-session-1' }), reload: () => ({ sessionId: 'assistant-session-1' }) }),
}));

import { DECISION_PUSH_RELAY_COMMAND, DECISION_PUSH_RELAY_SOURCE } from '@adhdev/mesh-shared';
import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { answerMissionDecision } from '../../src/mesh/mesh-mission-decisions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { setMissionChangeListener } from '../../src/mesh/mesh-mission-change-notifier.js';
import { classifyDecisionCaller, MISSION_DECISION_ANSWER } from '../../src/commands/high-family/mission-decisions.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { COMMAND_SOURCES, normalizeCommandSource } from '../../src/commands/command-registry.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
beforeEach(() => { meshId = `decision-relay-${randomUUID().slice(0, 8)}`; setMissionChangeListener(() => {}); });
afterEach(() => {
    setMissionChangeListener(null);
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

function ask(decision: Record<string, unknown> = {}) {
    const r = upsertStructuredMission(meshId, {
        title: 'Ship budget', goal: 'g',
        itemsAdd: [{ kind: 'decision', question: 'Budget default?', options: [{ label: 'temp value' }, { label: 'final value' }], recommended: 'a', ...decision }],
    }, { actor: 'coordinator' });
    return r.result.itemResults[0].id!;
}
const item = (id: string) => store().missionItems().getItem(meshId, id)!;
const spec = () => getDaemonCommandRegistry().get(DECISION_PUSH_RELAY_COMMAND)!;
const run = (args: Record<string, unknown>) => spec().run({} as any, { _commandSource: DECISION_PUSH_RELAY_SOURCE, ...args } as any) as Promise<any>;

describe('mission_decision_push_relay_answer ingress', () => {
    it('is registered and accepts ONLY the push_relay source', () => {
        expect(COMMAND_SOURCES).toContain('push_relay');
        expect(normalizeCommandSource('push_relay')).toBe('push_relay');
        expect(spec()).toBeTruthy();
        expect(spec().sources).toEqual(['push_relay']);
        // every other source — agents' ipc/mesh/internal included — is not in the list the router enforces
        for (const s of COMMAND_SOURCES.filter(x => x !== 'push_relay')) expect(spec().sources).not.toContain(s);
    });

    it('the ordinary answer command stays closed to the relay (and the relay source is not an owner transport)', () => {
        const ordinary = getDaemonCommandRegistry().get(MISSION_DECISION_ANSWER)!;
        expect(ordinary.sources).not.toContain('push_relay');
        expect(ordinary.sources).not.toContain('ws');
        expect(classifyDecisionCaller({ meshId, itemId: 'x', _commandSource: 'push_relay', via: 'push' })).toMatchObject({ ok: false, code: 'decision_answer_not_allowed' });
    });

    it('records the recommended option as an owner answer, via push, ingress push_relay (answer + event)', async () => {
        const itemId = ask();
        const r = await run({ meshId, itemId, optionId: 'a' });
        expect(r).toMatchObject({ success: true, action: 'answered', itemId });
        const stored = item(itemId);
        expect(stored.state).toBe('answered');
        expect(stored.decision!.answer).toMatchObject({ optionId: 'a', by: 'owner', via: 'push', ingress: 'push_relay' });
        const events = store().missionItems().listEvents(meshId, stored.missionId, { types: ['decision_answered'] });
        expect(events).toHaveLength(1);
        expect(JSON.stringify(events[0])).toContain('push_relay');
    });

    it('refuses any other option: only the recommended one can be answered from a notification', async () => {
        const itemId = ask();
        expect(await run({ meshId, itemId, optionId: 'b' })).toMatchObject({ success: false, code: 'option_not_relayable' });
        expect(item(itemId).state).toBe('open');
        const noRec = ask({ question: 'No rec?', recommended: undefined });
        expect(await run({ meshId, itemId: noRec, optionId: 'a' })).toMatchObject({ success: false, code: 'option_not_relayable' });
    });

    it('never overwrites an answer given elsewhere in the meantime', async () => {
        const itemId = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'b' }, { by: 'owner', via: 'dashboard' });
        expect(await run({ meshId, itemId, optionId: 'a' })).toMatchObject({ success: false, code: 'decision_not_open' });
        expect(item(itemId).decision!.answer).toMatchObject({ optionId: 'b', via: 'dashboard' });
    });

    it('is ids-only: free text, via and any extra key are refused, not ignored', async () => {
        const itemId = ask();
        for (const extra of [{ text: 'sure' }, { via: 'cli' }, { interpretedFrom: 'x' }, { undo: true }, { token: 't' }]) {
            expect(await run({ meshId, itemId, optionId: 'a', ...extra })).toMatchObject({ success: false, code: 'invalid_args' });
        }
        expect(await run({ meshId, itemId })).toMatchObject({ success: false, code: 'invalid_args' });
        expect(await run({ meshId, itemId, optionId: 'a b' })).toMatchObject({ success: false, code: 'invalid_args' });
        expect(item(itemId).state).toBe('open');
    });

    it('defence in depth: even if the router let another source through, the handler refuses', async () => {
        const itemId = ask();
        for (const source of ['ipc', 'ws', 'api', 'p2p', 'mesh', 'internal', '']) {
            const r = await spec().run({} as any, { meshId, itemId, optionId: 'a', _commandSource: source } as any) as any;
            expect(r).toMatchObject({ success: false, code: 'decision_answer_not_allowed' });
        }
        expect(item(itemId).state).toBe('open');
    });
});
