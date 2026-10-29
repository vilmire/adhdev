import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Structured missions, bundle D (design 2026-10-28 §5.2, §6.3, §6.4): the assistant's decision verbs,
// the follow-relay ops, and the status fields — over the real mission item store.
const testConfigDir = join(tmpdir(), `adhdev-assistant-decisions-${randomUUID().slice(0, 8)}`, '.adhdev');
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
const delivered: string[] = [];
vi.mock('../../src/mesh/mesh-mission-decision-delivery.js', async (orig) => ({
    ...(await orig<typeof import('../../src/mesh/mesh-mission-decision-delivery.js')>()),
    deliverDecisionAnswer: vi.fn(async (_mesh: string, itemId: string) => { delivered.push(itemId); return 'sent'; }),
}));

import { ASSISTANT_VERB, followerOpPermitted } from '@adhdev/mesh-shared';
import { assistantDecisionHandlers } from '../../src/commands/high-family/assistant-decisions.js';
import { decisionStatusFields, listDecisionsForMesh, parseDecisionAnswers } from '../../src/commands/high-family/assistant-decisions-core.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { buildOwnerDecisions, answerMissionDecision } from '../../src/mesh/mesh-mission-decisions.js';
import { isCarryOverMissionRecord } from '@adhdev/mesh-shared';
import { getMeshMission } from '../../src/mesh/mesh-missions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { createAssistantServices, getAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { followerStatusView } from '../../src/assistant/project-views.js';
import { loadMeshConfig, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const SELF = 'daemon_mach_assistant00001';
const HOST = 'daemon_mach_host0000000001';
let meshId = '';
let hostedNow = true;
let callHost: ReturnType<typeof vi.fn>;
const store = () => MeshRuntimeStore.getInstance();
const run = (verb: string, args: Record<string, unknown>) => assistantDecisionHandlers[verb]({} as any, args);

function meshEntry(): LocalMeshEntry {
    return {
        id: meshId, name: 'Blog', repoIdentity: 'github.com/acme/blog',
        meshHost: { role: 'host', hostDaemonId: HOST },
        nodes: [{ id: 'n-host', workspace: '/w', daemonId: HOST, role: 'host' }, { id: 'n-asst', workspace: '/a', daemonId: SELF }],
    } as unknown as LocalMeshEntry;
}

function authed(extra: Record<string, unknown> = {}, sid = assistantSession.sid): Record<string, unknown> {
    return {
        assistantSessionId: sid,
        mcpSessionCredential: mintMcpSessionCredential({ sessionId: sid, isCoordinator: false }),
        ...extra,
    };
}
/** The owner spoke: the assistant's current turn was opened by a human input. */
function ownerSpoke(): void { getAssistantServices().inputLog.append(assistantSession.sid, 'human'); }

function ask(question = 'Budget default?', decision: Record<string, unknown> = {}) {
    const r = upsertStructuredMission(meshId, {
        title: 'Ship budget', goal: 'g',
        itemsAdd: [{ kind: 'decision', question, options: [{ label: 'temp value' }, { label: 'final value' }], recommended: 'a', ...decision }],
    }, { actor: 'coordinator' });
    return { missionId: r.record.id, itemId: r.result.itemResults[0].id! };
}
const item = (id: string) => store().missionItems().getItem(meshId, id)!;

beforeEach(() => {
    meshId = `assistant-decisions-${randomUUID().slice(0, 8)}`;
    delivered.length = 0;
    hostedNow = true;
    saveMeshConfig({ ...loadMeshConfig(), meshes: [meshEntry()] as any });
    setAssistantServicesForTests(createAssistantServices({ configDir: testConfigDir, listMeshes: () => [meshEntry()] }));
    const hostHandler = getDaemonCommandRegistry().get('assistant_remote_project')!.run as any;
    callHost = vi.fn(async (_t: unknown, op: string, args: Record<string, unknown>) => {
        // The host daemon runs the same code on its own store; the sender is the assistant's daemon.
        hostedNow = true;
        try {
            const result = await hostHandler({} as any, { meshId, op, ...args, [MESH_SENDER_DAEMON_ID_ARG]: SELF });
            return result.success === true ? { ok: true, result } : { ok: false, kind: 'refused', code: result.code, error: result.error, result };
        } finally { hostedNow = false; }
    });
    setAssistantProjectPortsForTests(() => ({
        selfDaemonId: () => (hostedNow ? HOST : SELF),
        listMeshes: () => [meshEntry()],
        isHostedHere: () => hostedNow,
        aliases: () => ({}),
        coordinators: () => [],
        lastCoordinatorSessionId: () => null,
        queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
        activeMissionCount: () => 0,
        pendingApprovals: () => 0,
        relay: { openThread: vi.fn(), isThreadOpen: () => false, lastRelayAt: () => 0 },
        execute: vi.fn(async () => ({ success: true })) as any,
        remoteHost: () => ({ label: 'host-box', hostDaemonId: HOST, hostMeshId: meshId, reachable: true }),
        callHost: callHost as any,
        coordinatorTurns: () => ({ open: false, committed: [] }),
        meshStatusLine: () => null,
    }) as unknown as AssistantProjectPorts);
});

afterEach(() => {
    setAssistantProjectPortsForTests(null);
    setAssistantServicesForTests(null);
    __resetMcpSessionCredentialsForTest();
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('contract', () => {
    it('the new verbs are registered for the assistant MCP sources only', () => {
        for (const verb of [ASSISTANT_VERB.decisionAnswer, ASSISTANT_VERB.decisionRequest]) {
            expect(getDaemonCommandRegistry().get(verb)?.sources).toEqual(['ipc', 'standalone']);
        }
    });

    it('a grant that lets the follower send/read status already covers the decision ops; an unrelated grant does not', () => {
        expect(followerOpPermitted('decision_answer', ['send'])).toBe(true);
        expect(followerOpPermitted('decision_request', ['send'])).toBe(true);
        expect(followerOpPermitted('decision_list', ['status'])).toBe(true);
        expect(followerOpPermitted('decision_answer', ['status', 'read'])).toBe(false);
        expect(followerOpPermitted('decision_list', ['send'])).toBe(false);
        expect(followerOpPermitted('terminal', ['status'])).toBe(false);
        expect(followerOpPermitted('inventory', ['status', 'send'])).toBe(false);
    });
});

describe('decision_answer', () => {
    it('refuses without the bound assistant credential, with a coordinator or other session credential, and without an owner utterance', async () => {
        const { itemId } = ask();
        ownerSpoke();
        const a = { project: meshId, itemId, optionId: 'a', interpretedFrom: 'temp' };
        expect(await run(ASSISTANT_VERB.decisionAnswer, { ...a, assistantSessionId: assistantSession.sid })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        expect(await run(ASSISTANT_VERB.decisionAnswer, { ...a, ...authed({}, 'worker-session-9') })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        const coord = mintMcpSessionCredential({ sessionId: assistantSession.sid, isCoordinator: true });
        expect(await run(ASSISTANT_VERB.decisionAnswer, { ...a, assistantSessionId: assistantSession.sid, mcpSessionCredential: coord })).toMatchObject({ success: false });
        expect(await run(ASSISTANT_VERB.decisionAnswer, { ...a, bind: 'b', ...authed() })).toMatchObject({ success: false });
        expect(item(itemId).state).toBe('open');
        // a turn opened only by a relay is not an owner utterance
        getAssistantServices().inputLog.closeTurn(assistantSession.sid);
        getAssistantServices().inputLog.append(assistantSession.sid, 'relay');
        expect(await run(ASSISTANT_VERB.decisionAnswer, { ...a, ...authed() })).toMatchObject({ success: false, code: 'no_owner_utterance' });
        expect(item(itemId).state).toBe('open');
    });

    it('accepts a turn opened by an unverified dashboard human (no-auth standalone) — and only that, not a relay after it', async () => {
        const { itemId } = ask();
        const log = getAssistantServices().inputLog;
        log.append(assistantSession.sid, 'human_unverified');
        const a = { project: meshId, itemId, optionId: 'a', interpretedFrom: 'temp', ...authed() };
        expect(await run(ASSISTANT_VERB.decisionAnswer, a)).toMatchObject({ success: true });
        expect(item(itemId).state).not.toBe('open');
        // the write classification of that kind stays non-human
        expect(log.writeContext(assistantSession.sid).origin).toBe('relay');
        // a relay-only turn after it is still refused
        const second = ask('Second?').itemId;
        log.closeTurn(assistantSession.sid);
        log.append(assistantSession.sid, 'relay');
        expect(await run(ASSISTANT_VERB.decisionAnswer, { ...a, itemId: second })).toMatchObject({ success: false, code: 'no_owner_utterance' });
    });

    it('maps one owner sentence onto several decisions: via assistant, interpretedFrom kept, a line per answer with the item id', async () => {
        const budget = ask('Budget default?');
        const npmrc = ask('Keep .npmrc as is?', { options: [{ label: 'keep' }, { label: 'change' }], recommended: 'a' });
        ownerSpoke();
        const r: any = await run(ASSISTANT_VERB.decisionAnswer, {
            project: meshId,
            answers: [
                { itemId: budget.itemId, optionId: 'a', interpretedFrom: 'budget temp, npmrc as is' },
                { itemId: npmrc.itemId, optionId: 'a', interpretedFrom: 'budget temp, npmrc as is' },
            ],
            ...authed(),
        });
        expect(r).toMatchObject({ success: true, project: 'blog' });
        expect(r.lines).toHaveLength(2);
        expect(r.lines[0]).toContain(budget.itemId);
        expect(r.lines[0]).toContain('[undo]');
        expect(r.lines[1]).toContain(npmrc.itemId);
        const a = item(budget.itemId).decision!.answer!;
        expect(a).toMatchObject({ optionId: 'a', by: 'owner', via: 'assistant', interpretedFrom: 'budget temp, npmrc as is' });
        expect(item(budget.itemId).state).toBe('answered');
        expect(delivered.sort()).toEqual([budget.itemId, npmrc.itemId].sort());
    });

    it('requires interpretedFrom on every answer and records nothing otherwise', async () => {
        const { itemId } = ask();
        ownerSpoke();
        const r: any = await run(ASSISTANT_VERB.decisionAnswer, { project: meshId, itemId, optionId: 'a', ...authed() });
        expect(r).toMatchObject({ success: false, code: 'invalid_args' });
        expect(r.error).toMatch(/interpretedFrom/);
        const batch: any = await run(ASSISTANT_VERB.decisionAnswer, { project: meshId, answers: [{ itemId, optionId: 'a', interpretedFrom: 'x' }, { itemId: 'other', optionId: 'a' }], ...authed() });
        expect(batch).toMatchObject({ success: false, code: 'invalid_args' });
        expect(item(itemId).state).toBe('open');
    });

    it('one bad item does not block the others; the failure is named', async () => {
        const good = ask();
        ownerSpoke();
        const r: any = await run(ASSISTANT_VERB.decisionAnswer, {
            project: meshId,
            answers: [{ itemId: 'nope', optionId: 'a', interpretedFrom: 'a' }, { itemId: good.itemId, optionId: 'b', interpretedFrom: 'final' }],
            ...authed(),
        });
        expect(r.success).toBe(false);
        expect(r.result.answers.map((x: any) => [x.itemId, x.ok, x.code])).toEqual([['nope', false, 'decision_not_found'], [good.itemId, true, undefined]]);
        expect(item(good.itemId).decision!.answer!.optionId).toBe('b');
    });

    it('undo reopens the decision (same tool, undo:true)', async () => {
        const { itemId } = ask();
        ownerSpoke();
        await run(ASSISTANT_VERB.decisionAnswer, { project: meshId, itemId, optionId: 'a', interpretedFrom: 'temp', ...authed() });
        const u: any = await run(ASSISTANT_VERB.decisionAnswer, { project: meshId, itemId, undo: true, interpretedFrom: 'undo that', ...authed() });
        expect(u.success).toBe(true);
        expect(u.lines[0]).toContain('open again');
        expect(item(itemId).state).toBe('open');
        expect(item(itemId).decision!.answer).toBeUndefined();
    });
});

describe('decision_request', () => {
    it('writes a decision into the carry-over mission when no mission is named, and dedupes a re-ask', async () => {
        const r: any = await run(ASSISTANT_VERB.decisionRequest, {
            project: meshId, question: 'Which DB?', options: ['postgres', 'sqlite'], recommended: 'a', urgency: 'blocking', ...authed(),
        });
        expect(r).toMatchObject({ success: true, project: 'blog' });
        const open = buildOwnerDecisions(meshId);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ question: 'Which DB?', recommended: 'a', urgency: 'blocking', carryOver: true });
        expect(open[0].options.map(o => o.label)).toEqual(['postgres', 'sqlite']);
        expect(isCarryOverMissionRecord(getMeshMission(meshId, open[0].missionId)!)).toBe(true);
        const again: any = await run(ASSISTANT_VERB.decisionRequest, { project: meshId, question: 'Which DB?', options: ['postgres', 'sqlite'], ...authed() });
        expect(again.result).toMatchObject({ success: true, deduped: true, itemId: r.result.itemId });
        expect(buildOwnerDecisions(meshId)).toHaveLength(1);
    });

    it('goes to the named mission; an unknown mission is refused; needs the assistant credential but not an owner utterance', async () => {
        const { missionId } = ask('Other?');
        const r: any = await run(ASSISTANT_VERB.decisionRequest, { project: meshId, missionId, question: 'Rename the repo?', options: ['yes', 'no'], ...authed() });
        expect(r.result.missionId).toBe(missionId);
        const bad: any = await run(ASSISTANT_VERB.decisionRequest, { project: meshId, missionId: 'nope', question: 'q?', ...authed() });
        expect(bad).toMatchObject({ success: false, code: 'mission_not_found' });
        expect(await run(ASSISTANT_VERB.decisionRequest, { project: meshId, question: 'q?', assistantSessionId: assistantSession.sid })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        expect(await run(ASSISTANT_VERB.decisionRequest, { project: meshId, ...authed() })).toMatchObject({ success: false, code: 'invalid_args' });
    });

    it('a registered question never marks answers as seen by the coordinator', async () => {
        const { itemId, missionId } = ask();
        answerMissionDecision({ meshId, itemId, optionId: 'a' }, { by: 'owner', via: 'dashboard' });
        expect(item(itemId).decision!.promptAckedAt).toBeUndefined();
        await run(ASSISTANT_VERB.decisionRequest, { project: meshId, missionId, question: 'Another?', ...authed() });
        expect(item(itemId).decision!.promptAckedAt).toBeUndefined();
    });
});

describe('open decisions in project status', () => {
    it('carries compact rows with the recommended option marked, nothing when there are none', () => {
        expect(decisionStatusFields(meshId)).toEqual({});
        const { itemId } = ask('Budget default?', { urgency: 'blocking', dueAt: '2030-01-01T00:00:00Z' });
        const f: any = decisionStatusFields(meshId);
        expect(f.openDecisions).toEqual({ count: 1, blocking: 1 });
        expect(f.ownerDecisions[0]).toMatchObject({ itemId, urgency: 'blocking', recommended: 'a', dueAt: '2030-01-01T00:00:00.000Z', source: 'coordinator' });
        expect(f.ownerDecisions[0].options).toEqual([{ id: 'a', label: 'temp value', recommended: true }, { id: 'b', label: 'final value' }]);
    });

    it('caps the rows, counts the rest, and lists auto-applied answers only on request', () => {
        for (let i = 0; i < 12; i++) ask(`Question ${i}?`);
        const l = listDecisionsForMesh(meshId);
        expect(l.ownerDecisions).toHaveLength(10);
        expect(l.openDecisions.count).toBe(12);
        expect(l.autoApplied).toBeUndefined();
        const target = buildOwnerDecisions(meshId)[0];
        answerMissionDecision({ meshId, itemId: target.itemId, optionId: 'a' }, { by: 'auto_recommended', via: 'auto' });
        const l2 = listDecisionsForMesh(meshId, { includeAutoApplied: true });
        expect(l2.autoApplied).toHaveLength(1);
        expect(l2.autoApplied![0]).toMatchObject({ itemId: target.itemId, by: 'auto_recommended' });
        expect(l2.autoApplied![0].answer).toContain('temp value');
    });

    it('survives a follower view: allow-listed fields only, foreign keys dropped', () => {
        ask();
        const raw: any = { ...decisionStatusFields(meshId), name: 'Blog' };
        raw.ownerDecisions[0].secret = 'leak';
        raw.ownerDecisions[0].options[0].extra = 'leak';
        const view: any = followerStatusView(raw, { id: meshId, name: 'Blog', repoIdentity: 'github.com/acme/blog' } as any);
        expect(view.openDecisions).toEqual({ count: 1, blocking: 0 });
        expect(view.ownerDecisions[0].secret).toBeUndefined();
        expect(view.ownerDecisions[0].options[0].extra).toBeUndefined();
        expect(view.ownerDecisions[0].question).toBe('Budget default?');
        expect(followerStatusView({ name: 'Blog' }, { id: meshId, name: 'Blog' } as any).ownerDecisions).toBeUndefined();
    });
});

describe('remote followed project (follow relay round trip)', () => {
    it('lists, answers and registers decisions on the host through assistant_remote_project', async () => {
        const { itemId } = ask();
        hostedNow = false; // the assistant's daemon does not host it
        ownerSpoke();
        const r: any = await run(ASSISTANT_VERB.decisionAnswer, {
            project: 'blog', answers: [{ itemId, optionId: 'b', interpretedFrom: 'final please' }], ...authed(),
        });
        expect(callHost).toHaveBeenCalledWith(expect.anything(), 'decision_answer', { answers: [{ itemId, optionId: 'b', interpretedFrom: 'final please' }] });
        expect(r).toMatchObject({ success: true, project: 'blog' });
        expect(r.lines[0]).toContain(itemId);
        expect(r.result).toMatchObject({ via: 'relay', host: 'host-box' });
        expect(item(itemId).decision!.answer).toMatchObject({ optionId: 'b', via: 'assistant', interpretedFrom: 'final please' });
        expect(delivered).toContain(itemId);

        hostedNow = false;
        const reg: any = await run(ASSISTANT_VERB.decisionRequest, { project: meshId, question: 'Ship Friday?', options: ['yes', 'no'], ...authed() });
        expect(reg).toMatchObject({ success: true, result: { via: 'relay' } });
        expect(buildOwnerDecisions(meshId).map(d => d.question)).toEqual(['Ship Friday?']);

        const listed: any = await callHost({}, 'decision_list', { includeAutoApplied: true });
        expect(listed.ok).toBe(true);
        expect(listed.result.result.openDecisions).toEqual({ count: 1, blocking: 0 });
    });

    it('a failed relay answer reports the host refusal, and an unreachable host is project_unreachable', async () => {
        hostedNow = false;
        ownerSpoke();
        callHost.mockResolvedValueOnce({ ok: false, kind: 'unreachable', code: 'project_unreachable', reason: 'host_offline', error: 'offline' });
        const r: any = await run(ASSISTANT_VERB.decisionAnswer, { project: meshId, itemId: 'x', optionId: 'a', interpretedFrom: 'a', ...authed() });
        expect(r).toMatchObject({ success: false, code: 'project_unreachable' });
    });
});

describe('parseDecisionAnswers', () => {
    it('accepts the single form and the batch form, caps the batch, rejects duplicates', () => {
        expect(parseDecisionAnswers({ itemId: 'i', optionId: 'a', interpretedFrom: 'w' })).toEqual([{ itemId: 'i', optionId: 'a', interpretedFrom: 'w' }]);
        expect(parseDecisionAnswers({ answers: Array.from({ length: 11 }, (_, i) => ({ itemId: `i${i}`, interpretedFrom: 'w' })) })).toMatch(/at most 10/);
        expect(parseDecisionAnswers({ answers: [{ itemId: 'i', interpretedFrom: 'w' }, { itemId: 'i', interpretedFrom: 'w' }] })).toMatch(/twice/);
        expect(parseDecisionAnswers({ answers: [] })).toMatch(/empty/);
    });
});
