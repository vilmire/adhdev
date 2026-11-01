import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testConfigDir = join(tmpdir(), `adhdev-live-check-${randomUUID().slice(0, 8)}`, '.adhdev');
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

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { buildOpenLiveChecks } from '../../src/mesh/mesh-mission-decisions.js';
import { resolveLiveCheck } from '../../src/mesh/mesh-mission-live-check.js';
import { setMissionChangeListener } from '../../src/mesh/mesh-mission-change-notifier.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { classifyDecisionCaller } from '../../src/commands/high-family/mission-decisions.js';
import { MISSION_LIVE_CHECK_RESOLVE } from '../../src/commands/high-family/mission-live-check.js';
import { attachIpcMcpAuthority } from '../../src/commands/mcp-authority-attach.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
const notified: string[] = [];
beforeEach(() => { meshId = `live-check-${randomUUID().slice(0, 8)}`; notified.length = 0; setMissionChangeListener(id => { notified.push(id); }); });
afterEach(() => {
    setMissionChangeListener(null);
    __resetMcpSessionCredentialsForTest();
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

function seed() {
    const r = upsertStructuredMission(meshId, {
        title: 'Deploy check', goal: 'g',
        itemsAdd: [{ kind: 'live_check', text: 'Open Needs You on the phone', machine: 'build-box' }],
    }, { actor: 'coordinator' });
    return { missionId: r.record.id, itemId: r.result.itemResults[0].id! };
}

describe('resolveLiveCheck', () => {
    it('works → item done, evidence item with the note, mission event, change notification', () => {
        const { missionId, itemId } = seed();
        const r = resolveLiveCheck({ meshId, itemId, verdict: 'works', note: 'all good' }, { via: 'dashboard' });
        expect(r).toMatchObject({ ok: true, state: 'done', missionId });
        expect(store().missionItems().getItem(meshId, itemId)!.state).toBe('done');
        const evidence = store().missionItems().listItems(meshId, missionId, { kinds: ['evidence'] });
        expect(evidence).toHaveLength(1);
        expect(evidence[0].text).toContain('Live check passed on build-box');
        expect(evidence[0].text).toContain('— all good');
        const events = store().missionItems().listEvents(meshId, missionId);
        expect(events.some(e => e.type === 'item_state_changed' && e.payload.verdict === 'works' && e.payload.via === 'dashboard' && e.payload.note === 'all good')).toBe(true);
        expect(notified).toContain(meshId);
        expect(buildOpenLiveChecks(meshId)).toHaveLength(0);
    });

    it("doesnt_work → item failed, still listed as failed, can be re-resolved to done", () => {
        const { itemId } = seed();
        expect(resolveLiveCheck({ meshId, itemId, verdict: 'doesnt_work', note: 'blank screen' }, { via: 'dashboard' })).toMatchObject({ ok: true, state: 'failed' });
        const listed = buildOpenLiveChecks(meshId);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ itemId, state: 'failed', machine: 'build-box' });
        expect(resolveLiveCheck({ meshId, itemId, verdict: 'works' }, { via: 'dashboard' })).toMatchObject({ ok: true, state: 'done' });
        expect(buildOpenLiveChecks(meshId)).toHaveLength(0);
    });

    it('refuses unknown, non-live_check and already-done items', () => {
        const { itemId } = seed();
        expect(resolveLiveCheck({ meshId, itemId: 'mi_nope', verdict: 'works' }, { via: 'cli' })).toMatchObject({ ok: false, code: 'live_check_not_found' });
        resolveLiveCheck({ meshId, itemId, verdict: 'works' }, { via: 'cli' });
        expect(resolveLiveCheck({ meshId, itemId, verdict: 'works' }, { via: 'cli' })).toMatchObject({ ok: false, code: 'live_check_not_open' });
    });
});

describe('mission_live_check_resolve authority', () => {
    const stamped = (source: string, extra: Record<string, unknown> = {}) => ({ meshId, itemId: 'mi_x', _commandSource: source, ...extra });
    const C = MISSION_LIVE_CHECK_RESOLVE;

    it('owner transports pass; relay/internal/ws/api sources and forged credentials do not', () => {
        expect(classifyDecisionCaller(stamped('p2p'), C)).toMatchObject({ ok: true });
        expect(classifyDecisionCaller(stamped('standalone'), C)).toMatchObject({ ok: true });
        expect(classifyDecisionCaller(stamped('ipc'), C)).toMatchObject({ ok: true });
        for (const s of ['mesh', 'internal', 'ws', 'api', 'push_relay', 'project_attach', '']) {
            expect(classifyDecisionCaller(stamped(s), C)).toMatchObject({ ok: false });
        }
        expect(classifyDecisionCaller(stamped('ipc', { token: 't' }), C)).toMatchObject({ ok: false });
    });

    it('a worker session credential is refused', () => {
        const token = mintMcpSessionCredential({ sessionId: 'worker-session-9', isCoordinator: false });
        const args = stamped('ipc');
        attachIpcMcpAuthority(args, C, { sessionCredential: token });
        expect(classifyDecisionCaller(args, C)).toMatchObject({ ok: false });
    });

    it('is registered owner-side only (no relay sources) and dispatches through the registry', async () => {
        const spec = getDaemonCommandRegistry().get(C)!;
        expect(spec).toBeTruthy();
        for (const bad of ['mesh', 'internal', 'ws', 'api', 'push_relay']) expect(spec.sources).not.toContain(bad);
    });
});

describe('mission close scope guidance', () => {
    it('mission prompt footer and coordinator prompt tell the coordinator to record `scope:` in outcome_reason', async () => {
        const { buildMissionPromptSection } = await import('../../src/mesh/mesh-mission-prompt.js');
        upsertStructuredMission(meshId, { title: 'Active', goal: 'g' }, { actor: 'coordinator' });
        const section = buildMissionPromptSection(meshId);
        expect(section).toContain('outcome_reason with `scope:`');
        expect(section).toContain('NOT checked');
        const { buildCoordinatorSystemPrompt } = await import('../../src/mesh/coordinator-prompt.js');
        const prompt = buildCoordinatorSystemPrompt({
            mesh: { id: 'mesh_1', name: 'M', repoIdentity: 'github.com/acme/m', nodes: [{ id: 'n1', workspace: '/repo', daemonId: 'd1', userOverrides: {}, policy: {} }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as any,
            coordinatorCliType: 'claude-cli',
        });
        expect(prompt).toContain('`outcome_reason`');
        expect(prompt).toContain('start it with `scope:`');
    });

    it('the mission structure projection carries outcome and outcome_reason of closed missions', async () => {
        const { buildMissionStructure } = await import('../../src/mesh/mesh-mission-decisions.js');
        const r = upsertStructuredMission(meshId, { title: 'Closed one', goal: 'g', status: 'completed', outcome: 'not_needed', outcomeReason: 'scope: checked grep; not checked live' } as any, { actor: 'coordinator' });
        const entry = buildMissionStructure(meshId).find(m => m.missionId === r.record.id);
        expect(entry).toMatchObject({ outcome: 'not_needed', outcomeReason: 'scope: checked grep; not checked live' });
    });
});
