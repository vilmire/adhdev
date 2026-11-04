/** Integration-level flow (stubs only at the host boundary): confirmed usage limit -> owner picks another CLI ->
 * the exhausted session is proven stopped on a LEGACY session host -> context preserved -> task resumes on the
 * other CLI. Real: quota gate, claim gate, operator cleanup + stop fence, work queue. Stub: the session host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hostBootIdFromStartedAt } from '@adhdev/session-host-core';

vi.mock('../../src/mesh/turn-ledger/deliver.js', async (orig) => ({ ...(await orig() as object), notifyMeshCoordinator: vi.fn(() => true) }));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { sessionIsStopping, sessionStopPending } from '../../src/mesh/mesh-session-stop-fence.js';
import { cleanupMeshSessions } from '../../src/commands/router-worktree-cleanup.js';
import { claimNextTask, enqueueTask, getQueueEntryById } from '../../src/mesh/mesh-work-queue.js';
import { switchQuotaExhaustedSession } from '../../src/mesh/mesh-quota-provider-switch.js';
import { evaluateProviderQuotaGate } from '../../src/mesh/mesh-quota-routing.js';
import { withCliRateLimitEvidence } from '../../src/quota/exhaustion-hold.js';

const NODE = 'node-a';
const prev = process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS;
beforeEach(() => { process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS = '300'; });
afterEach(() => { if (prev === undefined) delete process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS; else process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS = prev; });

function scenario() {
    const meshId = randomUUID();
    const sessionId = randomUUID();
    const startedAt = Date.now();
    const hostBootId = hostBootIdFromStartedAt(startedAt);
    const record: any = {
        sessionId, workspace: '/repo/a', lifecycle: 'running', runtimeKey: `rt-${sessionId}`, startedAt,
        meta: { meshNodeId: NODE, meshNodeFor: meshId, launchedByCoordinator: true },
    };
    // LEGACY host: no stop_session_if_expected, stop by id only.
    const control: any = {
        listSessions: async () => [record],
        resolveHostBootId: async () => hostBootId,
        getDiagnostics: async () => ({ hostBootId, hostStartedAt: startedAt }),
        stopSession: vi.fn(async () => { record.lifecycle = 'stopped'; return { ...record }; }),
        deleteSession: vi.fn(async () => { throw new Error('delete must not be used'); }),
    };
    const self: any = {
        deps: { sessionHostControl: control },
        sessionMatchesMeshNode: () => true,
        isCompletedHostedSession: (r: any) => ['stopped', 'failed', 'interrupted'].includes(r?.lifecycle),
        recordIntentionalMeshSessionStop: vi.fn(async () => {}),
    };
    const node = { id: NODE, workspace: '/repo/a' };
    const taskId = randomUUID();
    enqueueTask(meshId, 'Implement the importer', { id: taskId, targetNodeId: NODE, requiredTags: ['provider=claude-cli'], difficulty: 'medium' } as any);
    const claimed = claimNextTask(meshId, NODE, sessionId, ['provider=claude-cli']);
    expect(claimed?.id).toBe(taskId);
    const deps = { cleanupMeshSessions: (args: any) => cleanupMeshSessions(self, args) };
    const args = { meshId, nodeId: NODE, node, taskId, sessionId, fromProvider: 'claude-cli', toProvider: 'codex-cli', approvedBy: 'owner' as const };
    return { meshId, sessionId, taskId, record, control, self, deps, args };
}

describe('usage limit -> switch CLI flow', () => {
    it('confirmed exhaustion blocks the old provider, the switch stops the session with proof, and the task resumes pinned to the other CLI', async () => {
        const s = scenario();
        // 1. The CLI said "usage limit reached" although the statusline still reads 1% left.
        const claude = withCliRateLimitEvidence('claude-cli', {
            provider: 'claude-cli', status: 'ok', updatedAt: Date.now() - 60_000, error: null,
            session: { usedPercent: 99, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 }, weekly: null,
        } as any, { observedAt: Date.now() - 30_000, resetsAt: Date.now() + 3_600_000 });
        const node = { id: NODE, nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), quota: { 'claude-cli': claude } } };
        expect(evaluateProviderQuotaGate(node, 'claude-cli')?.reason).toBe('provider_quota_exhausted');
        expect(evaluateProviderQuotaGate(node, 'codex-cli')).toBeNull();

        // 2. Owner approves the other CLI.
        const result = await switchQuotaExhaustedSession(s.deps, s.args);
        expect(result).toMatchObject({ ok: true, stopProof: 'proven', toProvider: 'codex-cli' });

        // Old session proven stopped through the legacy path, exactly once, ownership fenced (no second writer).
        expect(s.control.stopSession).toHaveBeenCalledTimes(1);
        expect(s.record.lifecycle).toBe('stopped');
        expect(sessionIsStopping(MeshRuntimeStore.getInstance().db, s.sessionId)).toBe(true);
        expect(s.self.recordIntentionalMeshSessionStop).toHaveBeenCalledTimes(1);
        // The record (and its chat) is kept: nothing was deleted.
        expect(s.control.deleteSession).not.toHaveBeenCalled();

        // Context preserved on the SAME task row; pin replaced for this task only; back in the queue.
        const task = getQueueEntryById(s.meshId, s.taskId)!;
        expect(task.status).toBe('pending');
        expect(task.assignedSessionId).toBeUndefined();
        expect(task.requiredTags).toEqual(['provider=codex-cli']);
        expect(task.message).toContain('Implement the importer');
        expect(task.message).toContain(`previous session ${s.sessionId}`);
        expect(task.message).toContain('mesh_read_chat');
        expect(task.requeueCount).toBe(1);

        // 3. The other CLI can claim it; the old one cannot hold a second copy.
        const resumed = claimNextTask(s.meshId, NODE, randomUUID(), ['provider=codex-cli']);
        expect(resumed?.id).toBe(s.taskId);
        const again = await switchQuotaExhaustedSession(s.deps, s.args);
        expect(again).toMatchObject({ ok: false, code: 'task_not_owned_by_session' });
        expect(s.control.stopSession).toHaveBeenCalledTimes(1);
    });

    it('refuses without owner approval or to the same provider, and stops nothing', async () => {
        const s = scenario();
        expect(await switchQuotaExhaustedSession(s.deps, { ...s.args, approvedBy: 'coordinator' as any })).toMatchObject({ ok: false, code: 'owner_approval_required' });
        expect(await switchQuotaExhaustedSession(s.deps, { ...s.args, toProvider: 'claude-cli' })).toMatchObject({ ok: false, code: 'same_provider' });
        expect(s.control.stopSession).not.toHaveBeenCalled();
        expect(getQueueEntryById(s.meshId, s.taskId)?.status).toBe('assigned');
    });

    it('an unproven stop keeps the task owned, the session fenced, and says how to recover (no Ctrl-C advice)', async () => {
        const s = scenario();
        s.control.stopSession = vi.fn(async () => ({ lifecycle: 'stopping' })); // host never reports stopped
        const result = await switchQuotaExhaustedSession(s.deps, s.args);
        expect(result).toMatchObject({ ok: false, phase: 'stop', code: 'cleanup_stop_not_proven' });
        expect((result as any).recovery).toMatch(/fenced/);
        const task = getQueueEntryById(s.meshId, s.taskId)!;
        expect(task.status).toBe('assigned');
        expect(task.assignedSessionId).toBe(s.sessionId);
        expect(sessionStopPending(MeshRuntimeStore.getInstance().db, s.sessionId)).toBe(true);
        expect(claimNextTask(s.meshId, NODE, randomUUID(), ['provider=codex-cli'])).toBeNull();
    });

    it('a concurrent duplicate switch for the same task is refused', async () => {
        const s = scenario();
        const first = switchQuotaExhaustedSession(s.deps, s.args);
        const second = await switchQuotaExhaustedSession(s.deps, s.args);
        expect(second).toMatchObject({ ok: false, code: 'switch_in_progress' });
        expect(await first).toMatchObject({ ok: true });
        expect(s.control.stopSession).toHaveBeenCalledTimes(1);
    });
});
