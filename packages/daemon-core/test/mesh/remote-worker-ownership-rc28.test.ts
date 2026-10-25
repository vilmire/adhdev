/**
 * RC28 acceptance regressions through the real owner store, report ingress,
 * reducer, effects and queue. Transport and the physical writer are fixtures;
 * no daemon, PTY or remote process is started or controlled by this suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnEvidence, TurnScope } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { cancelTask, claimNextTask } from '../../src/mesh/mesh-work-queue.js';
import { deliverTaskToSession } from '../../src/mesh/mesh-queue-dispatch.js';
import { encodeDuplicateMeshDispatchCode } from '../../src/mesh/mesh-duplicate-dispatch.js';
import type { DaemonComponents } from '../../src/boot/daemon-components.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import {
    __resetProgressSurfaceForTest,
    __setWorkerProgressNoticeSinkForTests,
    acceptForwardedWorkerProgressUpdate,
} from '../../src/mesh/worker-report-progress.js';
import {
    acceptForwardedWorkerCompletionReport,
    type ForwardedWorkerReportClaim,
} from '../../src/mesh/worker-report-forwarded.js';
import { __resetReportedSummariesForTest, __setHandoffNoteSinkForTests } from '../../src/mesh/worker-report.js';
import { __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest } from '../../src/mesh/worker-mcp-isolation.js';
import { bridgeReceiptTransaction } from '../../src/mesh/worker-bridge-transaction.js';
import { evd, T0 } from '../turn-ledger/ledger-harness.js';

import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { agentCommand } from '../../src/commands/cli-manager-agent-command.js';
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';
import { stopStaleMeshWorker } from '../../src/mesh/mesh-event-forwarding.js';
import { __setWriterStopPortsForTests, type NativeWriterProcess } from '../../src/commands/mesh-writer-stop.js';
import type { CancelDispatchRequest } from '../../src/mesh/turn-ledger/effects.js';
import { resumePendingHolderReconciles, reconcileDuplicateHolder } from '../../src/mesh/mesh-holder-reconcile.js';
import { retireOpenQueueAttemptForRequeue } from '../../src/mesh/mesh-queue-attempt-guard.js';

// Mock only the configuration boundary. Every SQLite write is confined to this
// disposable directory, including output versions and local notices.
const sandbox = mkdtempSync(join(tmpdir(), 'rc28-owner-regression-'));
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => sandbox,
    getMachineId: () => 'owner',
    getMachineNickname: () => null,
    loadConfig: () => ({ machineId: 'owner' }),
}));

const MESH = 'mesh-rc28-owner';
const TASK = 'task-rc28-owner';
const ATTEMPT = 'attempt-rc28-owner';
const HOLDER = 'session-original-holder';
const NODE = 'node-remote-holder';
const PROVIDER = 'antigravity-cli';
const NOTE = 'The worker finished the first source change and is checking its ownership fences.';
const sender = { senderDaemonId: 'remote', nodeDaemonId: (nodeId: string) => nodeId === NODE ? 'remote' : undefined };
const claim: ForwardedWorkerReportClaim = { meshId: MESH, taskId: TASK, sessionId: HOLDER, attemptId: ATTEMPT, generation: 0 };

let ledger: TurnLedger;
let now: number;
let cancel: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;
let redeliver: ReturnType<typeof vi.fn>;
let notices: ReturnType<typeof vi.fn>;

function evidence(e: TurnEvidence): TurnEvidence {
    return { ...e, at: now, observedBy: 'owner', sessionId: HOLDER, taskId: TASK, attemptRef: { attemptId: ATTEMPT, generation: 0 } };
}

function insertTask(id: string, status: 'assigned' | 'pending', nodeId = NODE): void {
    MeshRuntimeStore.getInstance().insertQueueEntry({
        id, meshId: MESH, message: 'Check the task ownership pipeline', status,
        taskMode: 'code_change', difficulty: 'medium', readonly: false,
        ownedPaths: { paths: [{ path: 'src/owned.ts', subtree: false }] },
        ...(status === 'assigned' ? {
            assignedNodeId: nodeId, assignedSessionId: HOLDER,
            assignedProviderType: PROVIDER, attemptId: ATTEMPT, dispatchNonce: 1,
        } : { targetNodeId: nodeId }),
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    });
}

function open(scope: Exclude<TurnScope, 'plain'> = 'mesh_queue'): void {
    insertTask(TASK, 'assigned');
    expect(ledger.observe(evidence(evd('dispatch_accepted', {
        scope, meshId: MESH, nodeId: NODE, providerType: PROVIDER,
        messageId: 'task-dispatch-1', dispatchNonce: 1, consumeProfile: 'default',
    }, { source: 'dispatch' }))).verdict).toBe('applied');
    now += 1_000;
    expect(ledger.observe(evidence(evd('delivered', {
        messageId: 'task-dispatch-1', outcome: 'delivered', via: 'p2p',
    }, { source: 'dispatch' }))).verdict).toBe('applied');
}

function progress(over: Partial<ForwardedWorkerReportClaim> = {}, deliveryId = 'delivery-progress-1') {
    return acceptForwardedWorkerProgressUpdate({ ...claim, ...over }, NOTE, {
        sender, nowMs: now, reportedAtMs: now, deliveryId, isSelfDaemon: id => id === 'owner',
    });
}

function holds(): Array<{ reason: string; until_ms: number | null }> {
    return MeshRuntimeStore.getInstance().db.prepare("SELECT reason, until_ms FROM turn_holds WHERE attempt_id = ? AND status = 'active'").all(ATTEMPT) as Array<{ reason: string; until_ms: number | null }>;
}

beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
    vi.setSystemTime(now);
    cancel = vi.fn();
    revoke = vi.fn();
    redeliver = vi.fn();
    notices = vi.fn(() => true);
    __resetWorkerTaskTokensForTest();
    __resetWorkerSessionBindsForTest();
    __resetReportedSummariesForTest();
    __resetProgressSurfaceForTest();
    __setHandoffNoteSinkForTests(null);
    __setWorkerProgressNoticeSinkForTests(notices);
    ledger = createMeshRuntimeTurnLedger({
        selfDaemonId: 'owner', now: () => now, publisher: null,
        policy: { ...DEFAULT_TURN_POLICY },
        ports: { cancelDispatch: cancel, revokeWorkerBind: revoke, redeliver },
    });
    setActiveTurnLedger(ledger);
});

afterEach(async () => {
    __setWriterStopPortsForTests(undefined);
    setActiveTurnLedger(null);
    await ledger.flushPublish();
    __setWorkerProgressNoticeSinkForTests(undefined);
    __setHandoffNoteSinkForTests(null);
    __resetProgressSurfaceForTest();
    __resetReportedSummariesForTest();
    __resetWorkerTaskTokensForTest();
    __resetWorkerSessionBindsForTest();
    MeshRuntimeStore.resetForTests();
    rmSync(sandbox, { recursive: true, force: true });
    vi.useRealTimers();
});

describe('RC28 authenticated progress consumes the current remote attempt', () => {
    it.each(['mesh_queue', 'mesh_direct'] as const)('%s: progress survives both default consume windows and permits completion', scope => {
        open(scope);
        // This is R5, not the confirmed provider-setup suspension R5s.
        now += 2_000;
        expect(ledger.observe(evidence(evd('suspension', {
            modal: 'approval', modalKey: 'viewport-modal', clockUnknown: true,
        }))).rule).toBe('R5');
        const deliveredAt = ledger.getAttempt(ATTEMPT)!.deliveredAt!;
        now = deliveredAt + 34_000;
        expect(progress()).toMatchObject({ accepted: true });
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBe(now);
        expect(ledger.getAttempt(ATTEMPT)?.lastActivityAt).toBe(now);
        expect(holds().map(h => h.reason)).not.toEqual(expect.arrayContaining(['await_consume']));
        now = deliveredAt + 90_001;
        ledger.sweepExpiredHolds(now);
        now = deliveredAt + 180_558;
        ledger.sweepExpiredHolds(now);
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ generation: 0, terminal: null, reclaimCount: 0 });
        expect(cancel).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(redeliver).not.toHaveBeenCalled();
        expect(notices).toHaveBeenCalledTimes(1);
        const completion = acceptForwardedWorkerCompletionReport(claim, {
            outcome: 'completed', summary: 'Completed ownership checks.',
            touchedFiles: ['src/owned.ts'], branchState: 'blocked_review',
        }, { sender, nowMs: now, reportedAtMs: now, isSelfDaemon: id => id === 'owner' });
        expect(completion.accepted).toBe(true);
    });

    it('an unavailable owner ledger returns no accepted progress or receipt, then consumes on retry', () => {
        open(); setActiveTurnLedger(null);
        expect(progress()).toMatchObject({ accepted: false, refusal: 'storage_failed' });
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBeNull();
        expect(notices).not.toHaveBeenCalled();
        setActiveTurnLedger(ledger); expect(progress().accepted).toBe(true);
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBe(now);
    });
    it('truly unconsumed default attempts redeliver at 90s and exhaust that window once', () => {
        open();
        const deliveredAt = ledger.getAttempt(ATTEMPT)!.deliveredAt!;
        now = deliveredAt + 89_999;
        ledger.sweepExpiredHolds(now);
        expect(redeliver).not.toHaveBeenCalled();
        now = deliveredAt + 90_000;
        ledger.sweepExpiredHolds(now);
        expect(redeliver).toHaveBeenCalledTimes(1);
        expect(ledger.getAttempt(ATTEMPT)?.redriveCount).toBe(1);
        now = deliveredAt + 180_008;
        ledger.sweepExpiredHolds(now);
        // Exhaustion must initiate a bounded stop/handoff, retaining the exact
        // physical holder until that stop is confirmed. No native-source 180s
        // grace and no arbitrary progress/heartbeat extension is involved.
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancel.mock.calls[0][0]).toMatchObject({
            sessionId: HOLDER, nodeId: NODE, providerType: PROVIDER,
            attemptId: ATTEMPT, generation: 0,
        });
        expect(ledger.getAttempt(ATTEMPT)?.terminal).toBeNull();
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.assignedSessionId).toBe(HOLDER);
    });

    it.each([
        { sessionId: 'foreign-session' }, { taskId: 'foreign-task' },
        { attemptId: 'old-attempt' }, { generation: 1 },
    ])('refuses mismatched identity %j without consuming', over => {
        open();
        now += 34_000;
        expect(progress(over).accepted).toBe(false);
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBeNull();
        expect(notices).not.toHaveBeenCalled();
    });

    it('refuses a foreign forwarding daemon even with the correct task identity', () => {
        open();
        now += 34_000;
        expect(acceptForwardedWorkerProgressUpdate(claim, NOTE, {
            sender: { ...sender, senderDaemonId: 'foreign-daemon' }, nowMs: now,
        }).accepted).toBe(false);
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBeNull();
    });

    it('refuses a note created before dispatch', () => {
        open();
        now += 34_000;
        expect(acceptForwardedWorkerProgressUpdate(claim, NOTE, {
            sender, nowMs: now, reportedAtMs: T0 - 1,
        }).accepted).toBe(false);
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBeNull();
    });

    it('delivery replay neither extends authoritative activity nor repeats the notice', () => {
        open();
        now += 34_000;
        expect(progress().accepted).toBe(true);
        const consumed = ledger.getAttempt(ATTEMPT)!;
        expect(consumed.consumedAt).toBe(now);
        now += 10_000;
        expect(progress().accepted).toBe(true);
        expect(ledger.getAttempt(ATTEMPT)?.lastActivityAt).toBe(consumed.lastActivityAt);
        expect(notices).toHaveBeenCalledTimes(1);
    });

    it('receipt rollback leaves neither consumption nor a surfaced progress notice', () => {
        open();
        now += 34_000;
        expect(() => bridgeReceiptTransaction(MeshRuntimeStore.getInstance().db, () => {
            expect(progress().accepted).toBe(true);
            expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBe(now);
            throw new Error('injected receipt rollback');
        })).toThrow('injected receipt rollback');
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBeNull();
        expect(notices).not.toHaveBeenCalled();
        expect(progress().accepted).toBe(true);
        expect(ledger.getAttempt(ATTEMPT)?.consumedAt).toBe(now);
        expect(notices).toHaveBeenCalledTimes(1);
    });

    it('a genuine provider setup approval still parks without inventing consumption', () => {
        open();
        now += 2_000;
        expect(ledger.observe(evidence(evd('suspension', {
            modal: 'approval', modalKey: 'verified-setup-modal', providerSetup: true,
        }))).rule).toBe('R5s');
        now += 180_558;
        ledger.sweepExpiredHolds(now);
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ generation: 0, consumedAt: null, terminal: null });
        expect(holds().map(h => h.reason)).toContain('suspension_before_consumed');
        expect(cancel).not.toHaveBeenCalled();
        expect(redeliver).not.toHaveBeenCalled();
    });

    it('a typed duplicate refusal alone cannot authenticate a foreign holder', async () => {
        open();
        const task = MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)!;
        deliverTaskToSession(async () => ({
            success: false, code: encodeDuplicateMeshDispatchCode('unproven-holder'),
            error: 'duplicate task',
        }), {
            meshId: MESH, nodeId: NODE, sessionId: HOLDER, providerType: PROVIDER,
            task, transport: 'remote', components: { turnLedger: ledger } as DaemonComponents,
            attemptRef: { attemptId: ATTEMPT, generation: 0 },
        });
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ sessionId: HOLDER, consumedAt: null });
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.assignedSessionId).toBe(HOLDER);
        expect(progress({ sessionId: 'unproven-holder' }).accepted).toBe(false);
    });
});

describe('RC28 hard ceiling retains the physical writer until authenticated settlement', () => {
    it('failed stop keeps dirty tracked/new changes, ownership and restart fences; denies a second writer', async () => {
        open();
        now += 5_000;
        expect(ledger.observe(evidence(evd('turn_started', { retro: false }))).verdict).toBe('applied');
        const tracked = join(sandbox, 'tracked-change.txt');
        const untracked = join(sandbox, 'new-change.txt');
        writeFileSync(tracked, 'tracked edit before cap');
        writeFileSync(untracked, 'new file before cap');
        // This models a transport failure, not an acknowledged worker stop.
        cancel.mockImplementation(async () => { throw new Error('P2P unavailable'); });
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs;
        ledger.sweepExpiredHolds(now);
        await Promise.resolve();
        writeFileSync(tracked, 'original physical writer still editing after failed stop');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancel.mock.calls[0][0]).toMatchObject({ providerType: PROVIDER, sessionId: HOLDER, generation: 0 });
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', terminal: null, sessionId: HOLDER, generation: 0 });
        expect(revoke).not.toHaveBeenCalled();
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)).toMatchObject({ assignedSessionId: HOLDER });
        expect(readFileSync(tracked, 'utf8')).toContain('still editing');
        expect(readFileSync(untracked, 'utf8')).toBe('new file before cap');

        await ledger.flushPublish();
        setActiveTurnLedger(null);
        MeshRuntimeStore.resetForTests();
        ledger = createMeshRuntimeTurnLedger({
            selfDaemonId: 'owner', now: () => now, publisher: null,
            ports: { cancelDispatch: cancel, revokeWorkerBind: revoke, redeliver },
        });
        setActiveTurnLedger(ledger);
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', terminal: null, sessionId: HOLDER, generation: 0 });
        expect(progress({ generation: 1 }, 'foreign-generation-after-cap').accepted).toBe(false);
        expect(progress({}, 'valid-holder-after-cap').accepted).toBe(true);
        // A valid late update preserves evidence from the real holder; it must
        // not silently turn the expired cap into another active work interval.
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', terminal: null, generation: 0 });
        // Different node and session bypass the per-node capacity gate, so this
        // checks the durable worktree/path owner fence after process restart.
        insertTask('task-second-writer', 'pending', 'node-recovery');
        expect(claimNextTask(MESH, 'node-recovery', 'session-second-writer', [], { providerType: PROVIDER })).toBeNull();
        expect(ledger.getAttempt(ATTEMPT)?.terminal).toBeNull();
        expect(readFileSync(tracked, 'utf8')).toContain('still editing');
        expect(readFileSync(untracked, 'utf8')).toBe('new file before cap');
    });
});


function sourceFixture() {
    const adapter = {
        cliType: PROVIDER, shutdown: vi.fn(), updateRuntimeSettings: vi.fn(), updateRuntimeMeta: vi.fn(),
        verifyRuntimeMeta: vi.fn(async () => true),
        getRuntimeMetadata: () => ({ runtimeId: HOLDER, runtimeKey: 'physical-incarnation-1',
            osPid: 417, startedAt: T0, lifecycle: 'running' }),
    };
    const instance = {
        instanceId: HOLDER, adapter, meshTaskInjectedAt: T0,
        meshTaskAttachmentHistory: [{ taskId: TASK, attemptId: ATTEMPT, dispatchNonce: 1, injectedAt: T0 }],
        settings: { meshNodeFor: MESH, meshNodeId: NODE, meshActiveTaskId: TASK, meshActiveAttemptId: ATTEMPT,
            meshActiveAttemptGeneration: 0, meshActiveDispatchNonce: 1, meshCoordinatorDaemonId: 'owner' } as Record<string, any>,
        getState() { return { instanceId: HOLDER, status: 'generating', settings: this.settings }; },
        getAdapter: () => adapter,
        attachMeshAssignment: CliProviderInstance.prototype.attachMeshAssignment,
        captureMeshAssignment: CliProviderInstance.prototype.captureMeshAssignment,
        restoreMeshAssignment: CliProviderInstance.prototype.restoreMeshAssignment,
    };
    const im = Object.create(ProviderInstanceManager.prototype);
    im.instances = new Map([[HOLDER, instance]]);
    Object.assign(adapter, { stopMeshWriter: vi.fn(async () => { adapter.shutdown(); return true; }) });
    const source = { adapters: new Map([[HOLDER, adapter]]), deps: { getInstanceManager: () => im } } as unknown as DaemonCliManager;
    source.stopCli = DaemonCliManager.prototype.stopCli.bind(source);
    return { adapter, instance, im, source };
}
const nativeRoot: NativeWriterProcess = { pid: 417, ppid: 1, pgid: 417, uid: 501, birth: new Date(T0).toString() };
const nativeChild: NativeWriterProcess = { pid: 418, ppid: 417, pgid: 417, uid: 501, birth: new Date(T0 + 1000).toString() };
async function drain() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function wireNativeStop(f: ReturnType<typeof sourceFixture>, tables: () => NativeWriterProcess[] | null) {
    __setWriterStopPortsForTests({ read: async () => tables(), pause: async () => {} });
    const dispatchMeshCommand = vi.fn(async (_daemon, command, args) => {
        if (command === 'agent_command') return agentCommand(f.source, args);
        expect(command).toBe('stop_cli');
        expect(args).toMatchObject({ cliType: PROVIDER, targetSessionId: HOLDER, mode: 'hard' });
        return f.source.stopCli(args);
    });
    const components = { cliManager: { adapters: new Map(), stopCli: f.source.stopCli }, dispatchMeshCommand } as unknown as DaemonComponents;
    cancel.mockImplementation((request: CancelDispatchRequest) => stopStaleMeshWorker(components, {
        meshId: MESH, sessionId: request.sessionId, nodeId: NODE, daemonId: 'remote', providerType: request.providerType!, writerStop: request,
    }));
}

describe('RC29 exact stop and crash settlement through real command/ledger/queue', () => {
    it.each(['nodeId', 'ownerDaemonId'] as const)('rejects a normalized alias in the exact stop %s receipt', async key => {
        open();
        cancel.mockImplementation(async (r: CancelDispatchRequest) => ({ ...r, success: true, quiescent: true,
            incarnation: 'captured-native-incarnation', [key]: `${r[key]} ` }));
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        expect(revoke).not.toHaveBeenCalled();
    });
    it.each(['meshId','taskId','nodeId','attemptId','generation','sessionId','dispatchNonce','providerType','ownerDaemonId','stopRequestId'])(
        'refuses a quiescence receipt for a different %s', async key => {
            open();
            cancel.mockImplementation(async (r: CancelDispatchRequest) => ({ ...r, success: true, quiescent: true,
                incarnation: 'captured-native-incarnation', [key]: typeof r[key as keyof CancelDispatchRequest] === 'number' ? 99 : 'foreign' }));
            now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
            expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
            expect(revoke).not.toHaveBeenCalled();
        });

    it('remote boot-style stop carries provider and confirms the native tree before exactly one recovery', async () => {
        open();
        const f = sourceFixture();
        let table = [nativeRoot, nativeChild];
        f.adapter.shutdown.mockImplementation(() => { table = []; });
        wireNativeStop(f, () => table);
        now += 90_000; ledger.sweepExpiredHolds(now);
        now += 90_001; ledger.sweepExpiredHolds(now);
        await drain();
        expect(f.adapter.shutdown).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'accepted', generation: 1, reclaimCount: 1, terminal: null });
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.status).toBe('pending');
        await ledger.resumeStoppingWriters();
        expect(ledger.getAttempt(ATTEMPT)?.reclaimCount).toBe(1);
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it.each(['still_live', 'pid_reused', 'unknown', 'shutdown_failed'] as const)('%s retains cap claim and denies forced requeue', async mode => {
        open();
        const f = sourceFixture(); let reads = 0;
        f.adapter.shutdown.mockImplementation(() => { if (mode === 'shutdown_failed') throw new Error('stop failed'); });
        wireNativeStop(f, () => {
            reads++;
            if (reads === 1) return [nativeRoot, nativeChild];
            if (mode === 'unknown') return null;
            if (mode === 'pid_reused') return [{ ...nativeRoot, birth: new Date(T0 + 60_000).toString() }];
            return [nativeRoot, nativeChild];
        });
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now);
        await drain();
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        expect(retireOpenQueueAttemptForRequeue(MESH, TASK, { force: true }).kind).toBe('refused');
        expect(revoke).not.toHaveBeenCalled();
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.status).toBe('assigned');
    });

    it.each([{ assistant: true }, { meshCoordinatorFor: MESH }, { meshActiveAttemptGeneration: 1 },
        { meshActiveTaskId: 'foreign-task' }, { meshCoordinatorDaemonId: 'foreign-owner' }])('protects role or identity %j', async over => {
        open(); const f = sourceFixture(); Object.assign(f.instance.settings, over);
        wireNativeStop(f, () => [nativeRoot, nativeChild]);
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        expect(f.adapter.shutdown).not.toHaveBeenCalled();
        expect(ledger.getAttempt(ATTEMPT)?.state).toBe('stopping');
    });

    it('persisted assistant provenance protects a restored session with missing role settings', async () => {
        open(); const f = sourceFixture();
        f.source.deps.getSessionRegistry = (() => ({ get: () => ({ launch: { launchedBy: 'assistant' } }) })) as any;
        wireNativeStop(f, () => [nativeRoot, nativeChild]);
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        expect(f.adapter.shutdown).not.toHaveBeenCalled();
        expect(ledger.getAttempt(ATTEMPT)?.state).toBe('stopping');
    });
    it('persists pre-stop capture so a lost reply recovers after owner/source reopen', async () => {
        open(); const f = sourceFixture(); let table = [nativeRoot, nativeChild];
        wireNativeStop(f, () => table);
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        for (let i = 0; i < 3; i++) { now += 30_000; ledger.sweepExpiredHolds(now); await drain(); }
        expect(cancel).toHaveBeenCalledTimes(3);
        expect(ledger.getAttempt(ATTEMPT)?.data.writerStop?.escalated).toBe(true);
        expect(ledger.getAttempt(ATTEMPT)?.terminal).toBeNull();
        // Native quiescence occurs after the transport reply was lost. The
        // journal remains, while the adapter and owner process are gone.
        table = []; f.source.adapters.clear(); f.im.instances.clear();
        await ledger.flushPublish(); setActiveTurnLedger(null); MeshRuntimeStore.resetForTests();
        ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'owner', now: () => now, publisher: null,
            ports: { cancelDispatch: cancel, revokeWorkerBind: revoke } }); setActiveTurnLedger(ledger);
        await ledger.resumeStoppingWriters();
        expect(ledger.getAttempt(ATTEMPT)?.terminal).toMatchObject({ outcome: 'failed', reason: 'hard_ceiling' });
        expect(cancel.mock.calls.at(-1)![0].inspectOnly).toBe(true);
        expect(revoke).toHaveBeenCalledTimes(1);
        await ledger.resumeStoppingWriters(); expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('an older peer lacking strict-stop capability receives no destructive stop command', async () => {
        open(); const dispatchMeshCommand = vi.fn(async (_daemon, command) => {
            expect(command).toBe('agent_command');
            return { success: false, error: 'Unknown action: mesh_writer_stop_capability' };
        });
        cancel.mockImplementation((request: CancelDispatchRequest) => stopStaleMeshWorker({ cliManager: { adapters: new Map() }, dispatchMeshCommand } as unknown as DaemonComponents,
            { meshId: MESH, sessionId: HOLDER, providerType: PROVIDER, daemonId: 'remote-old', writerStop: request }));
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        expect(dispatchMeshCommand).toHaveBeenCalledTimes(1);
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', terminal: null });
        expect(revoke).not.toHaveBeenCalled();
    });
    it('late current-holder reports are retained without a terminal acknowledgement while its writer is live', async () => {
        open(); cancel.mockImplementation(async () => { throw new Error('P2P unavailable'); });
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        for (let i = 0; i < 2; i++) {
            const report = acceptForwardedWorkerCompletionReport(claim, { outcome: 'completed', summary: 'Late validated source findings.', touchedFiles: [] },
                { sender, nowMs: now, reportedAtMs: now, isSelfDaemon: id => id === 'owner' });
            expect(report).toMatchObject({ accepted: false, detail: expect.stringContaining('checkpoint_pending') });
        }
        expect(ledger.getAttempt(ATTEMPT)?.data.report?.outcome).toBe('completed');
        expect(ledger.getAttempt(ATTEMPT)?.terminal).toBeNull();
        expect(MeshRuntimeStore.getInstance().getLatestTaskOutput(TASK)).toBeNull();
    });

    it('queue cancellation and direct stale writes cannot clear a stopping writer assignment', async () => {
        open(); cancel.mockImplementation(async () => { throw new Error('stop unavailable'); });
        expect(cancelTask(MESH, TASK)?.status).toBe('assigned'); await drain();
        expect(ledger.getAttempt(ATTEMPT)?.state).toBe('stopping');
        const store = MeshRuntimeStore.getInstance(), before = store.findQueueEntryById(MESH, TASK)!;
        for (const over of [{ status: 'pending' }, { assignedSessionId: 'foreign' }, { dispatchNonce: 2 }, { attemptId: 'foreign' }]) {
            expect(() => store.updateQueueEntry({ ...before, ...over } as typeof before)).toThrow('writer_checkpoint_pending');
        }
        expect(store.findQueueEntryById(MESH, TASK)?.assignedSessionId).toBe(HOLDER);
        expect(revoke).not.toHaveBeenCalled();
    });

    it('forced requeue waits for true quiescence and then opens exactly one fresh recovery', async () => {
        open(); const f = sourceFixture(); let table = [nativeRoot, nativeChild];
        wireNativeStop(f, () => table);
        expect(retireOpenQueueAttemptForRequeue(MESH, TASK, { force: true }).kind).toBe('refused'); await drain();
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.status).toBe('assigned');
        table = []; await ledger.resumeStoppingWriters();
        expect(ledger.getAttempt(ATTEMPT)?.terminal).toMatchObject({ outcome: 'cancelled', reason: 'superseded' });
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.status).toBe('pending');
        expect(revoke).toHaveBeenCalledTimes(1);
        await ledger.resumeStoppingWriters(); expect(revoke).toHaveBeenCalledTimes(1);
    });

    it.each(['stale_birth', 'detached_descendant', 'foreign_group_member'] as const)('denies native identity ambiguity before shutdown: %s', async mode => {
        open(); const f = sourceFixture();
        wireNativeStop(f, () => mode === 'stale_birth' ? [{ ...nativeRoot, birth: new Date(T0 + 60_000).toString() }]
            : mode === 'detached_descendant' ? [nativeRoot, { ...nativeChild, pgid: 999 }]
                : [nativeRoot, { ...nativeChild, ppid: 999 }]);
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        expect(f.adapter.shutdown).not.toHaveBeenCalled();
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', terminal: null });
    });

    it('an operator terminal proposal and malformed stop acknowledgement cannot release a live cap', async () => {
        open(); cancel.mockImplementation(async (r: CancelDispatchRequest) => ({ ...r, success: true, stopped: true }));
        now = T0 + DEFAULT_TURN_POLICY.hardCeilingMs; ledger.sweepExpiredHolds(now); await drain();
        ledger.observe(evidence(evd('operator_status', { status: 'completed', reason: 'operator_update' }, { source: 'operator' })));
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ state: 'stopping', terminal: null });
        expect(revoke).not.toHaveBeenCalled();
    });
});

describe('RC29 source attach precedes paired duplicate-holder owner CAS', () => {
    function legacyContext(f: ReturnType<typeof sourceFixture>, mutate?: () => void) {
        open();
        const store = MeshRuntimeStore.getInstance();
        const a = ledger.getAttempt(ATTEMPT)!;
        store.turnStore().upsertAttempt({ ...a, sessionId: 'replacement-session', generation: 1 }, now);
        const q = store.findQueueEntryById(MESH, TASK)!; q.assignedSessionId = 'replacement-session'; store.updateQueueEntry(q);
        const dispatch = vi.fn(async (_daemon: string, command: string, args: any) => {
            expect(command).toBe('agent_command');
            const result = await agentCommand(f.source, args);
            if (args.holderReconcile.phase === 'prepare') mutate?.();
            return result;
        });
        return { meshId: MESH, nodeId: NODE, sessionId: 'replacement-session', providerType: PROVIDER,
            task: q, transport: 'remote' as const, remoteDaemonId: 'remote', attemptRef: { attemptId: ATTEMPT, generation: 1 },
            components: { turnLedger: ledger, dispatchMeshCommand: dispatch } as unknown as DaemonComponents };
    }
    it('generation-0 actual holder attaches generation 1, then queue/attempt and real forwarded progress agree', async () => {
        const f = sourceFixture(), ctx = legacyContext(f);
        deliverTaskToSession(async () => ({ success: false, code: encodeDuplicateMeshDispatchCode(HOLDER) }), ctx);
        await drain();
        expect(f.instance.settings.meshActiveAttemptGeneration).toBe(1);
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ sessionId: HOLDER, generation: 1, consumedAt: expect.any(Number) });
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.assignedSessionId).toBe(HOLDER);
        expect(progress({ generation: 1 }).accepted).toBe(true);
        expect(progress({ generation: 0 }).accepted).toBe(false);
    });
    it('owner restart resumes a source prepare whose response was lost without double attaching', async () => {
        const f = sourceFixture(); let loseReply = true;
        const ctx = legacyContext(f, () => { if (loseReply) { loseReply = false; throw new Error('lost response'); } });
        expect(await reconcileDuplicateHolder(ctx, HOLDER, 'prepare-restart')).toBe(false);
        expect(f.instance.settings.meshActiveAttemptGeneration).toBe(1);
        await ledger.flushPublish(); setActiveTurnLedger(null); MeshRuntimeStore.resetForTests();
        ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'owner', now: () => now, publisher: null });
        setActiveTurnLedger(ledger); ctx.components.turnLedger = ledger;
        await resumePendingHolderReconciles(ctx.components);
        expect(ledger.getAttempt(ATTEMPT)).toMatchObject({ sessionId: HOLDER, generation: 1 });
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.assignedSessionId).toBe(HOLDER);
        expect(f.adapter.updateRuntimeSettings).toHaveBeenCalledTimes(1);
        expect(progress({ generation: 1 }).accepted).toBe(true);
    });
    it('failed attach restores source settings/history/injection time and leaves owner binding intact', async () => {
        const f = sourceFixture(), ctx = legacyContext(f), before = f.instance.captureMeshAssignment();
        f.adapter.updateRuntimeSettings.mockImplementation(s => { if (s.meshActiveAttemptGeneration === 1) throw new Error('attach failed'); });
        expect(await reconcileDuplicateHolder(ctx, HOLDER, 'attach-failure')).toBe(false);
        expect(f.instance.captureMeshAssignment()).toEqual(before);
        expect(ledger.getAttempt(ATTEMPT)?.sessionId).toBe('replacement-session');
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, TASK)?.assignedSessionId).toBe('replacement-session');
    });
    it('native metadata acknowledgement failure rolls back every source surface before owner rebind', async () => {
        const f = sourceFixture(), ctx = legacyContext(f), before = f.instance.captureMeshAssignment();
        f.adapter.verifyRuntimeMeta.mockImplementation(async expected => (expected.meshActiveAttemptRef as any)?.generation === 0);
        expect(await reconcileDuplicateHolder(ctx, HOLDER, 'native-ack-failure')).toBe(false);
        expect(f.instance.captureMeshAssignment()).toEqual(before);
        expect(ledger.getAttempt(ATTEMPT)?.sessionId).toBe('replacement-session');
        expect(f.adapter.verifyRuntimeMeta).toHaveBeenCalledTimes(2);
    });
    it('late owner CAS rolls source prepare back without a queue-only rebind', async () => {
        const f = sourceFixture(); const before = f.instance.captureMeshAssignment();
        const ctx = legacyContext(f, () => {
            const store = MeshRuntimeStore.getInstance(), q = store.findQueueEntryById(MESH, TASK)!;
            q.dispatchNonce = 2; store.updateQueueEntry(q);
        });
        expect(await reconcileDuplicateHolder(ctx, HOLDER, 'late-owner-CAS')).toBe(false);
        expect(f.instance.captureMeshAssignment()).toEqual(before);
        expect(ledger.getAttempt(ATTEMPT)?.sessionId).toBe('replacement-session');
    });
});
