import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Structured missions bundle F: owner-decision push event (design §9; owner decision D1).
const testConfigDir = join(tmpdir(), `adhdev-decision-push-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { processDecisionDeadlines } from '../../src/mesh/mesh-mission-decisions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { createDecisionPushEmitter, projectDecisionPushEvent } from '../../src/status/decision-push.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { createStatusEventEmitter, projectServerStatusEvent } from '../../src/status/status-event.js';
import type { DaemonStatusEventPayload } from '../../src/shared-types.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
const flush = () => new Promise<void>(r => setTimeout(r, 0));
let sent: DaemonStatusEventPayload[] = [];
let off: () => void = () => {};

beforeEach(() => {
    meshId = `decision-push-${randomUUID().slice(0, 8)}`;
    sent = [];
    off = createDecisionPushEmitter({ sendServer: (p) => { sent.push(p); } });
});
afterEach(() => {
    off();
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

const SECRET_CONTEXT = 'CONTEXT-SECRET-do-not-send';
const SECRET_GOAL = 'GOAL-SECRET-do-not-send';
function ask(decision: Record<string, unknown> = {}, title = 'Mission title SECRET-TITLE') {
    const r = upsertStructuredMission(meshId, {
        title, goal: SECRET_GOAL,
        itemsAdd: [{ kind: 'decision', question: 'Budget default?', context: SECRET_CONTEXT, options: [{ label: 'temp value', detail: 'DETAIL-SECRET' }, { label: 'final value' }], recommended: 'a', ...decision }],
    }, { actor: 'coordinator' });
    return { missionId: r.record.id, itemId: r.result.itemResults[0].id! };
}

describe('decision push event', () => {
    it('emits exactly one agent:decision_needed per new decision, and not again for a re-ask', async () => {
        const { itemId } = ask();
        await flush();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ event: 'agent:decision_needed', decision: { meshId, itemId, reason: 'new', urgency: 'normal', recommended: 'a' } });
        ask(); // same question → deduped item, no second event
        await flush();
        expect(sent).toHaveLength(1);
    });

    it('allow-list: only ids, 80-char question, <=3 option labels (<=24 chars), recommended, urgency, dueAt', async () => {
        const dueAt = new Date(Date.now() + 3600_000).toISOString();
        ask({
            question: 'Q'.repeat(200),
            options: ['a', 'b', 'c', 'd'].map((x, i) => ({ label: `${x}`.repeat(40), detail: `DETAIL-SECRET-${i}` })),
            recommended: 'b', urgency: 'blocking', dueAt,
        });
        await flush();
        const wire = JSON.stringify(sent[0]);
        const d = sent[0]!.decision!;
        expect(Object.keys(d).sort()).toEqual(['dueAt', 'itemId', 'meshId', 'missionId', 'options', 'question', 'reason', 'recommended', 'urgency']);
        expect(d.question.length).toBeLessThanOrEqual(80);
        expect(d.options).toHaveLength(3);
        for (const o of d.options) { expect(Object.keys(o).sort()).toEqual(['id', 'label']); expect(o.label.length).toBeLessThanOrEqual(24); }
        expect(d).toMatchObject({ recommended: 'b', urgency: 'blocking', dueAt });
        for (const secret of [SECRET_CONTEXT, SECRET_GOAL, 'SECRET-TITLE', 'DETAIL-SECRET']) expect(wire).not.toContain(secret);
        // top-level event carries nothing but event/timestamp/decision
        expect(Object.keys(sent[0]!).sort()).toEqual(['decision', 'event', 'timestamp']);
    });

    it('a recommended option cut by the 3-option limit is not forwarded', () => {
        const e = projectDecisionPushEvent({
            meshId: 'm', missionId: 'x', itemId: 'i', question: 'q', urgency: 'normal',
            options: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id })), recommended: 'd',
        }, 'new');
        expect(e.decision).not.toHaveProperty('recommended');
    });

    it('a blocking decision pushes again on remind (once per due crossing); a normal one does not', async () => {
        const past = new Date(Date.now() - 1000).toISOString();
        const blocking = ask({ question: 'Blocking q?', urgency: 'blocking', dueAt: past, onDue: 'remind' }, 'M1');
        const normal = ask({ question: 'Normal q?', urgency: 'normal', dueAt: past, onDue: 'remind' }, 'M2');
        await flush();
        sent.length = 0;
        const r = processDecisionDeadlines(meshId, Date.now());
        await flush();
        expect(r.reminded.sort()).toEqual([blocking.itemId, normal.itemId].sort());
        expect(sent).toHaveLength(1);
        expect(sent[0]!.decision).toMatchObject({ itemId: blocking.itemId, reason: 'remind' });
        processDecisionDeadlines(meshId, Date.now());
        await flush();
        expect(sent).toHaveLength(1); // remindedAt already stamped → no second pass event
    });

    it('skips a decision answered before the deferred read', async () => {
        const events: DaemonStatusEventPayload[] = [];
        off();
        off = createDecisionPushEmitter({ sendServer: (p) => { events.push(p); }, resolveEntry: () => undefined });
        ask();
        await flush();
        expect(events).toHaveLength(0);
    });
});

describe('status_event wire stays closed to decision text via provider events', () => {
    it('projectServerStatusEvent drops a provider_event named agent:decision_needed and any decision bag', () => {
        expect(projectServerStatusEvent({ event: 'agent:decision_needed', decision: { question: 'leak' } } as never)).toBeNull();
        const p = projectServerStatusEvent({ event: 'agent:waiting_choice', decision: { question: 'leak' } } as never);
        expect(p).not.toHaveProperty('decision');
    });

    it('createStatusEventEmitter wires the push to the server leg only, and unregisters on dispose', async () => {
        const bus = createSessionLifecycleBus();
        const dashboard: unknown[] = [];
        const server: DaemonStatusEventPayload[] = [];
        off();
        const stop = createStatusEventEmitter(bus as never, { sendDashboard: (p) => { dashboard.push(p); }, sendServer: (p) => { server.push(p); } });
        ask();
        await flush();
        expect(server).toHaveLength(1);
        expect(dashboard).toHaveLength(0);
        stop();
        ask({ question: 'Another?' }, 'M2');
        await flush();
        expect(server).toHaveLength(1);
        off = () => {};
    });

    it('without sendServer (standalone) no listener is registered', async () => {
        off();
        const bus = createSessionLifecycleBus();
        const stop = createStatusEventEmitter(bus as never, { sendDashboard: () => {} });
        ask();
        await flush();
        expect(sent).toHaveLength(0);
        stop();
        off = () => {};
    });
});
