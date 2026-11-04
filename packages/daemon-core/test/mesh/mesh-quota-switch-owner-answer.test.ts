/** Owner entry point of the Usage-limit CLI switch: the quota decision card for an ASSIGNED task offers the
 * installed alternative CLIs; only an owner answer (dashboard/CLI) runs switchQuotaExhaustedSession. */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { hostBootIdFromStartedAt } from '@adhdev/session-host-core';

const testConfigDir = join(tmpdir(), `adhdev-quota-switch-owner-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => { if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
    loadConfig: () => ({ machineId: 'test-machine' }), getMachineId: () => 'test-machine', getMachineNickname: () => null,
}));
vi.mock('../../src/mesh/turn-ledger/deliver.js', async (orig) => ({ ...(await orig() as object), notifyMeshCoordinator: vi.fn(() => true) }));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { answerAndDeliver } from '../../src/commands/high-family/mission-decisions.js';
import { answerMissionDecision, buildOwnerDecisions } from '../../src/mesh/mesh-mission-decisions.js';
import { escalateQuotaHeldTasks, resetQuotaEscalationForTests } from '../../src/mesh/mesh-quota-hold-escalation.js';
import { cleanupMeshSessions } from '../../src/commands/router-worktree-cleanup.js';
import { sessionStopPending } from '../../src/mesh/mesh-session-stop-fence.js';
import { __resetMeshRuntimeStoreForTests, claimNextTask, enqueueTask, getQueueEntryById } from '../../src/mesh/mesh-work-queue.js';
import { withCliRateLimitEvidence } from '../../src/quota/exhaustion-hold.js';

const NODE = 'node-a';
const prev = process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS;
beforeEach(() => { process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS = '300'; resetQuotaEscalationForTests(); });
afterEach(() => {
    if (prev === undefined) delete process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS; else process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS = prev;
    __resetMeshRuntimeStoreForTests();
});

async function scenario(nodeDaemon = 'test-machine') {
    const meshId = randomUUID();
    const sessionId = randomUUID();
    const startedAt = Date.now();
    const hostBootId = hostBootIdFromStartedAt(startedAt);
    const record: any = { sessionId, workspace: '/repo/a', lifecycle: 'running', runtimeKey: `rt-${sessionId}`, startedAt,
        meta: { meshNodeId: NODE, meshNodeFor: meshId, launchedByCoordinator: true } };
    const control: any = {
        listSessions: async () => [record], resolveHostBootId: async () => hostBootId,
        getDiagnostics: async () => ({ hostBootId, hostStartedAt: startedAt }),
        stopSession: vi.fn(async () => { record.lifecycle = 'stopped'; return { ...record }; }),
    };
    const self: any = { deps: { sessionHostControl: control }, sessionMatchesMeshNode: () => true,
        isCompletedHostedSession: (r: any) => ['stopped', 'failed', 'interrupted'].includes(r?.lifecycle),
        recordIntentionalMeshSessionStop: vi.fn(async () => {}) };
    const taskId = randomUUID();
    enqueueTask(meshId, 'Build the importer', { id: taskId, targetNodeId: NODE, requiredTags: ['provider=claude-cli'], difficulty: 'medium' } as any);
    claimNextTask(meshId, NODE, sessionId, ['provider=claude-cli']);
    const store = MeshRuntimeStore.getInstance();
    const row = store.findQueueEntryById(meshId, taskId)!;
    row.assignedProviderType = 'claude-cli'; row.assignedNodeId = NODE; row.assignedSessionId = sessionId;
    store.updateQueueEntry(row);

    const claude = withCliRateLimitEvidence('claude-cli', { provider: 'claude-cli', status: 'ok', updatedAt: Date.now() - 60_000, error: null,
        session: { usedPercent: 99, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 }, weekly: null } as any,
        { observedAt: Date.now() - 30_000, resetsAt: Date.now() + 3_600_000 });
    const node = { id: NODE, daemonId: nodeDaemon, workspace: '/repo/a', nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), quota: { 'claude-cli': claude } } };
    const mesh = { id: meshId, policy: {}, nodes: [node] };
    const raised = await escalateQuotaHeldTasks(null, meshId, mesh, { findAlternatives: async () => ['codex-cli', 'kimi'] });
    if (nodeDaemon !== 'test-machine') return { meshId, taskId, raised, control, mesh, node };
    expect(raised).toHaveLength(1);
    const card = buildOwnerDecisions(meshId).find(d => d.itemId === raised[0])!;
    const ctx: any = {
        deps: { sessionHostControl: control, providerLoader: { resolve: (t: string) => (['codex-cli', 'kimi'].includes(t) ? {} : null) } },
        components: () => { throw new Error('not needed'); },
        getMeshForCommand: async () => ({ mesh }),
        execute: async (cmd: string, args: any) => { expect(cmd).toBe('cleanup_mesh_sessions'); return cleanupMeshSessions(self, { ...args, node, source: 'mesh_cleanup_sessions' }); },
    };
    const optionFor = (label: string) => card.options.find(o => o.label === label)!.id;
    return { meshId, taskId, sessionId, control, card, ctx, optionFor };
}

const owner = { by: 'owner', via: 'dashboard' } as const;

describe('quota switch decision card + owner answer', () => {
    it('offers Wait plus a Switch option per installed alternative, with the revision to echo', async () => {
        const s = await scenario();
        expect(s.card.options.map(o => o.label)).toEqual(['Wait for reset', 'Switch to codex-cli', 'Switch to kimi']);
        expect(s.card.recommended).toBe(s.optionFor('Wait for reset'));
        expect(s.card.revision).toBe(0);
    });

    it('an owner answer runs the switch: session proven stopped, task pending on the chosen CLI', async () => {
        const s = await scenario();
        const out = await answerAndDeliver(s.ctx, { meshId: s.meshId, itemId: s.card.itemId, optionId: s.optionFor('Switch to codex-cli'), expectedRevision: 0 }, owner);
        expect(out).toMatchObject({ success: true });
        expect(s.control.stopSession).toHaveBeenCalledTimes(1);
        expect(getQueueEntryById(s.meshId, s.taskId)).toMatchObject({ status: 'pending', requiredTags: ['provider=codex-cli'] });
    });

    it('the assistant and push relay cannot choose a Switch option (and nothing is stopped)', async () => {
        const s = await scenario();
        for (const via of ['assistant', 'push'] as const) {
            const r = await answerAndDeliver(s.ctx, { meshId: s.meshId, itemId: s.card.itemId, optionId: s.optionFor('Switch to codex-cli'), interpretedFrom: 'yes' }, { by: 'owner', via } as any);
            expect(r).toMatchObject({ success: false, code: 'quota_override_owner_only' });
        }
        expect(s.control.stopSession).not.toHaveBeenCalled();
        expect(getQueueEntryById(s.meshId, s.taskId)?.status).toBe('assigned');
    });

    it('a non-owner actor reaching the module is refused and the decision is reopened', async () => {
        const s = await scenario();
        // Simulate a bypass of the ingress guard: record the answer directly, then run the module with a non-owner actor.
        answerMissionDecision({ meshId: s.meshId, itemId: s.card.itemId, optionId: s.optionFor('Switch to codex-cli') }, owner);
        const { applyOwnerQuotaSwitch } = await import('../../src/commands/high-family/quota-switch-answer.js');
        const r = await applyOwnerQuotaSwitch(s.ctx, { meshId: s.meshId, itemId: s.card.itemId }, { by: 'coordinator', via: 'dashboard' } as any);
        expect(r).toMatchObject({ ok: false, code: 'quota_switch_owner_only' });
        expect(s.control.stopSession).not.toHaveBeenCalled();
        expect(buildOwnerDecisions(s.meshId).some(d => d.itemId === s.card.itemId)).toBe(true);
    });

    it('a stale revision is refused', async () => {
        const s = await scenario();
        const r = await answerAndDeliver(s.ctx, { meshId: s.meshId, itemId: s.card.itemId, optionId: s.optionFor('Switch to codex-cli'), expectedRevision: 3 }, owner);
        expect(r).toMatchObject({ success: false, code: 'stale_revision' });
        expect(s.control.stopSession).not.toHaveBeenCalled();
        expect(getQueueEntryById(s.meshId, s.taskId)?.status).toBe('assigned');
    });

    it('an unproven stop leaves the task assigned and the session fenced, and reopens the decision with a recovery', async () => {
        const s = await scenario();
        s.control.stopSession = vi.fn(async () => ({ lifecycle: 'stopping' }));
        const r: any = await answerAndDeliver(s.ctx, { meshId: s.meshId, itemId: s.card.itemId, optionId: s.optionFor('Switch to codex-cli') }, owner);
        expect(r).toMatchObject({ success: false, code: 'cleanup_stop_not_proven' });
        expect(r.recovery).toMatch(/fenced/);
        const task = getQueueEntryById(s.meshId, s.taskId)!;
        expect(task).toMatchObject({ status: 'assigned', assignedSessionId: s.sessionId });
        expect(task.requiredTags).toEqual(['provider=claude-cli']);
        expect(sessionStopPending(MeshRuntimeStore.getInstance().db, s.sessionId)).toBe(true);
        expect(buildOwnerDecisions(s.meshId).some(d => d.itemId === s.card.itemId)).toBe(true);
    });

    it('a task on a remote member node gets no switch card (the stop proof is local-host only)', async () => {
        const s: any = await scenario('member-a-daemon');
        expect(s.raised).toEqual([]);
        expect(buildOwnerDecisions(s.meshId)).toEqual([]);
    });

    it('an owner answer for a task on a remote node is refused: nothing stopped, task stays assigned, decision reopened', async () => {
        const s = await scenario();
        answerMissionDecision({ meshId: s.meshId, itemId: s.card.itemId, optionId: s.optionFor('Switch to codex-cli') }, owner);
        const remoteNode = { id: NODE, daemonId: 'member-a-daemon', workspace: '/repo/a' };
        const ctx = { ...s.ctx, getMeshForCommand: async () => ({ mesh: { id: s.meshId, policy: {}, nodes: [remoteNode] } }) };
        const { applyOwnerQuotaSwitch } = await import('../../src/commands/high-family/quota-switch-answer.js');
        const r = await applyOwnerQuotaSwitch(ctx, { meshId: s.meshId, itemId: s.card.itemId }, owner as any);
        expect(r).toMatchObject({ ok: false, code: 'quota_switch_remote_node' });
        expect(s.control.stopSession).not.toHaveBeenCalled();
        expect(getQueueEntryById(s.meshId, s.taskId)?.status).toBe('assigned');
        expect(buildOwnerDecisions(s.meshId).some(d => d.itemId === s.card.itemId)).toBe(true);
    });
});
