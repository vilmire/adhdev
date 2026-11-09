/**
 * A report forwarded by a remote worker for a SESSIONLESS direct dispatch
 * (`mesh_send_task` with no session_id: the worker daemon picks the session) must
 * be accepted from exactly the session that took the prompt.
 *
 * Live bug (1.0.82-rc.117): the owner opened the `mesh_direct` attempt with the
 * task id standing in for the unknown session and wrote the task row with no
 * assignedSessionId, because the worker's `agent_command send_chat` answer never
 * named the session. The worker's blocked report was then refused
 * (`no_live_task … never claimed by a session`) and the coordinator never saw it.
 *
 * Fix: the worker answer carries `sessionId`; the owner binds its attempt
 * (delivered evidence) and task row to it. Authentication is unchanged — the
 * forwarded report is still matched against what the OWNER recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import { acceptForwardedWorkerCompletionReport, type ForwardedWorkerReportClaim } from '../../src/mesh/worker-report-forwarded.js';
import { __resetReportedSummariesForTest, __setHandoffNoteSinkForTests } from '../../src/mesh/worker-report.js';
import { __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest } from '../../src/mesh/worker-mcp-isolation.js';
import { agentCommand } from '../../src/commands/cli-manager-agent-command.js';
import type { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { evd, T0 } from '../turn-ledger/ledger-harness.js';

const sandbox = mkdtempSync(join(tmpdir(), 'remote-direct-binding-'));
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => sandbox,
    getMachineId: () => 'owner',
    getMachineNickname: () => null,
    loadConfig: () => ({ machineId: 'owner' }),
}));

const MESH = 'mesh-direct-binding';
const TASK = 'b7360a4f-direct-task';
const ATTEMPT = `mesh_direct:${TASK}/g0`;
const WORKER_SESSION = 'fef77be9-worker-session';
const NODE = 'node-remote-worker';
const PROVIDER = 'claude-cli';
const sender = { senderDaemonId: 'remote', nodeDaemonId: (nodeId: string) => nodeId === NODE ? 'remote' : undefined };

let ledger: TurnLedger;
let now: number;

/** The worker daemon's real `agent_command send_chat` for a sessionless dispatch (it picks the session). */
async function workerAnswer(): Promise<{ success?: boolean; sessionId?: string }> {
    const host = {
        deps: { getInstanceManager: () => undefined },
        findAdapter: () => ({ adapter: {}, key: WORKER_SESSION }),
        findMeshNodeAdapter: () => ({ adapter: {}, key: WORKER_SESSION }),
        input: { submit: async () => ({ kind: 'delivered', route: 'pty' }) },
    } as unknown as DaemonCliManager;
    return agentCommand(host, { agentType: PROVIDER, action: 'send_chat', message: 'do the work', messageId: TASK }) as Promise<{ success?: boolean; sessionId?: string }>;
}

function ev(e: TurnEvidence, sessionId: string): TurnEvidence {
    return { ...e, at: now, observedBy: 'owner', sessionId, taskId: TASK, attemptRef: { attemptId: ATTEMPT, generation: 0 } };
}

/**
 * What the owner's mcp-server records for a direct send: attempt opened under the
 * task-id stand-in (target session unknown), `delivered` + the task row carrying
 * whatever session the worker's answer named (`sessionId || taskId` / `|| undefined`).
 */
async function ownerRecordsDirectSend(answeredSessionId: string | undefined): Promise<void> {
    expect(ledger.observe(ev(evd('dispatch_accepted', {
        scope: 'mesh_direct', meshId: MESH, nodeId: NODE, providerType: PROVIDER,
        messageId: TASK, dispatchNonce: 1, consumeProfile: 'default',
    }, { source: 'dispatch' }), TASK)).verdict).toBe('applied');
    now += 1_000;
    expect(ledger.observe(ev(evd('delivered', { messageId: TASK, outcome: 'delivered', via: 'p2p' }, { source: 'dispatch' }), answeredSessionId || TASK)).verdict).toBe('applied');
    MeshRuntimeStore.getInstance().insertQueueEntry({
        id: TASK, meshId: MESH, message: 'do the work', status: 'assigned',
        taskMode: 'code_change', difficulty: 'medium', readonly: false,
        assignedNodeId: NODE, targetNodeId: NODE,
        ...(answeredSessionId ? { assignedSessionId: answeredSessionId, targetSessionId: answeredSessionId } : {}),
        attemptId: ATTEMPT,
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    });
}

function forward(sessionId: string) {
    const claim: ForwardedWorkerReportClaim = { meshId: MESH, taskId: TASK, sessionId, attemptId: ATTEMPT, generation: 0 };
    return acceptForwardedWorkerCompletionReport(claim, {
        outcome: 'blocked', summary: 'Blocked: needs a decision from the coordinator.',
        touchedFiles: [], branchState: 'blocked_review',
    } as any, { sender, nowMs: now, reportedAtMs: now, isSelfDaemon: id => id === 'owner' });
}

beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
    vi.setSystemTime(now);
    __resetWorkerTaskTokensForTest();
    __resetWorkerSessionBindsForTest();
    __resetReportedSummariesForTest();
    __setHandoffNoteSinkForTests(null);
    ledger = createMeshRuntimeTurnLedger({
        selfDaemonId: 'owner', now: () => now, publisher: null,
        policy: { ...DEFAULT_TURN_POLICY },
        ports: { cancelDispatch: vi.fn(), revokeWorkerBind: vi.fn(), redeliver: vi.fn() },
    });
    setActiveTurnLedger(ledger);
});

afterEach(async () => {
    setActiveTurnLedger(null);
    await ledger.flushPublish();
    __setHandoffNoteSinkForTests(null);
    __resetReportedSummariesForTest();
    __resetWorkerTaskTokensForTest();
    __resetWorkerSessionBindsForTest();
    MeshRuntimeStore.resetForTests();
    rmSync(sandbox, { recursive: true, force: true });
    vi.useRealTimers();
});

describe('remote sessionless direct send → forwarded worker report', () => {
    it('the worker names the session that took the prompt in its send_chat answer', async () => {
        const answer = await workerAnswer();
        expect(answer.success).toBe(true);
        expect(answer.sessionId).toBe(WORKER_SESSION);
    });

    it('accepts a report from the exact session the owner dispatched to', async () => {
        const answer = await workerAnswer();
        await ownerRecordsDirectSend(answer.sessionId);
        const result = forward(WORKER_SESSION);
        expect(result.accepted).toBe(true);
    });

    it('still refuses a different session reporting the same task', async () => {
        const answer = await workerAnswer();
        await ownerRecordsDirectSend(answer.sessionId);
        const result = forward('some-other-session');
        expect(result.accepted).toBe(false);
    });

    it('refuses a report for a task the owner never sent to that session (no binding recorded)', async () => {
        await ownerRecordsDirectSend(undefined);
        const result = forward(WORKER_SESSION);
        expect(result.accepted).toBe(false);
        expect((result as any).detail ?? (result as any).refusal).toMatch(/no_live_task/);
    });
});
