import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    preserveTrustedOwnerIngress,
} from '../../src/commands/command-args.js';
import { startSession } from '../../src/commands/cli-manager-launch.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context.js';
import {
    NEW_WORK_HELD_CODE,
    NewWorkHeldError,
    assertNewWorkHoldAdmission,
    buildNewWorkHeldRefusal,
    classifyNewWorkHeld,
    releaseNewWorkHold,
    resetNewWorkHoldForTests,
    setNewWorkHold,
} from '../../src/maintenance/new-work-hold.js';
import type { MeshClaimRefusal } from '../../src/mesh/mesh-claim-refusal.js';
import { tryAssignQueueTask } from '../../src/mesh/mesh-queue-assignment.js';
import { maybeAutoLaunchOneQueueSession } from '../../src/mesh/mesh-queue-autolaunch.js';
import { deliverTaskToSession } from '../../src/mesh/mesh-queue-dispatch.js';
import { triggerMeshQueue } from '../../src/mesh/mesh-queue-trigger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { claimNextTask, enqueueTask, getQueueEntryById } from '../../src/mesh/mesh-work-queue.js';
import { createTurnDeliverHandler } from '../../src/mesh/turn-ledger/deliver.js';
import { createTurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { sendDirectAgentTask } from '../../../mcp-server/src/tools/mesh-remote-dispatch.js';
import { meshSendTask } from '../../../mcp-server/src/tools/mesh-tools-send-task.js';

describe('new-work hold gates (S1, S2, H1, H2, H3, F4 choke point, F6 notices, F7 continuations)', () => {
    let rootDir: string;
    let store: MeshRuntimeStore;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-new-work-hold-gates-'));
        process.env.ADHDEV_CONFIG_DIR = rootDir;
        resetProcessInstanceContextForTests();
        MeshRuntimeStore.resetForTests();
        resetNewWorkHoldForTests();
        store = MeshRuntimeStore.getInstance();
    });

    afterEach(() => {
        resetNewWorkHoldForTests();
        MeshRuntimeStore.resetForTests();
        resetProcessInstanceContextForTests();
        try {
            fs.rmSync(rootDir, { recursive: true, force: true });
        } catch {
            /* ignore cleanup errors */
        }
    });

    it('gates S1 router commands, F4 session-start choke point, and rejects IPC origin forgery while allowing proof-verified owner chat and F7 running continuations', async () => {
        const meshId = 'mesh-s1-f4';
        const nodeId = 'node-1';
        const runningSessionId = 'sess-running-worker';
        const activeTaskId = 'task-running-123';
        const activeAttemptId = 'att-running-123';

        store.insertQueueEntry({
            id: activeTaskId,
            meshId,
            status: 'assigned',
            assignedNodeId: nodeId,
            assignedSessionId: runningSessionId,
            message: 'Initial running task',
            difficulty: 'simple',
            priority: 'normal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

        const deliveredMessages: string[] = [];
        const inputService = createSessionInputService({
            resolveSession: (id) => ({
                getStatus: () => ({ status: 'idle' }),
                getSessionSettings: () =>
                    id === runningSessionId
                        ? {
                              meshNodeFor: meshId,
                              meshNodeId: nodeId,
                              meshActiveTaskId: activeTaskId,
                              meshActiveAttemptId: activeAttemptId,
                          }
                        : undefined,
                sendMessage: async (body) => {
                    deliveredMessages.push(typeof body === 'string' ? body : (body as any)?.textFallback);
                    return { status: 'sent' as const };
                },
            }),
        });

        const submitThroughH2 = async (args: Record<string, unknown>) => {
            const mc = (args.meshContext && typeof args.meshContext === 'object' ? args.meshContext : {}) as Record<string, unknown>;
            const msg = preserveTrustedOwnerIngress(args, {
                messageId: (args.messageId as string) || `msg_${randomUUID()}`,
                sessionId: runningSessionId,
                input: { parts: [{ type: 'text', text: String(args.message || '') }], textFallback: String(args.message || '') },
                origin: (args.origin as any) || 'dashboard',
                policy: { mode: 'queue' as const },
                createdAt: Date.now(),
                ...(typeof mc.attemptId === 'string' ? { meshAttemptRef: mc.attemptId } : {}),
                ...(typeof mc.taskId === 'string' ? { meshTaskId: mc.taskId } : {}),
            });
            const outcome = await inputService.submit(msg);
            if (outcome.kind === 'refused') {
                return { success: false, code: outcome.reason, reason: outcome.reason, error: outcome.message };
            }
            return { success: true, sent: true, outcome };
        };

        const components: any = {
            cliManager: {
                input: inputService,
                agentCommand: submitThroughH2,
                adapters: new Map([
                    [
                        runningSessionId,
                        {
                            getStatus: () => ({ status: 'generating' }),
                        },
                    ],
                ]),
            },
            instanceManager: {
                listInstanceIds: () => [runningSessionId],
                getInstance: (id: string) =>
                    id === runningSessionId
                        ? {
                              category: 'cli',
                              getState: () => ({
                                  instanceId: runningSessionId,
                                  type: 'claude-cli',
                                  status: 'generating',
                                  settings: {
                                      meshNodeFor: meshId,
                                      meshNodeId: nodeId,
                                      meshActiveTaskId: activeTaskId,
                                      meshActiveAttemptId: activeAttemptId,
                                  },
                              }),
                          }
                        : undefined,
            },
        };

        const router = new DaemonCommandRouter({
            commandHandler: {
                rejectUnknown: async (cmd: string) => ({ success: false, error: `Unknown: ${cmd}` }),
                handleSpec: async (_spec: any, args: Record<string, unknown>) => submitThroughH2(args),
            } as any,
            cliManager: components.cliManager,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: components.instanceManager,
            detectedIdes: { value: [] },
            sessionRegistry: {} as any,
            statusInstanceId: 'daemon_mach_test',
        });
        components.router = router;
        router.attachComponents(components);

        const holdSet = await router.execute(
            'maintenance_new_work_hold_set',
            { holdId: 'hold-s1', holder: 'owner-main', reason: 'upgrade drain' },
            'standalone',
            { ownerVerified: true },
        );
        expect(holdSet.success).toBe(true);

        // F4: S1 refuses launch_cli, restart_session, session_host_resume_session, session_host_restart_session, launch_assistant, refine_mesh_node, batch_refine_mesh_nodes
        for (const [cmd, args] of [
            ['launch_cli', { type: 'claude-cli', dir: rootDir }],
            ['launch_mesh_coordinator', { meshId }],
            ['restart_session', { sessionId: runningSessionId }],
            ['session_host_resume_session', { sessionId: runningSessionId }],
            ['session_host_restart_session', { sessionId: runningSessionId }],
            ['launch_assistant', { projectId: 'proj-1' }],
            ['refine_mesh_node', { meshId, nodeId, execute: true }],
            ['batch_refine_mesh_nodes', { meshId, nodeIds: [nodeId], execute: true }],
        ] as const) {
            const res = await router.execute(cmd, args as Record<string, unknown>, 'ipc');
            expect(res.success, `Expected ${cmd} to be refused while held`).toBe(false);
            expect(res.code).toBe(NEW_WORK_HELD_CODE);
        }

        // F4: Session-start choke point (startSession / assertNewWorkHoldAdmission) throws NewWorkHeldError under hold
        expect(() => assertNewWorkHoldAdmission({ command: 'start_session', meshId })).toThrow(NewWorkHeldError);
        await expect(startSession({} as any, 'claude-cli', rootDir)).rejects.toThrow(NewWorkHeldError);

        // F5 & F6: Origin forgery via IPC (`origin: 'dashboard'`, `ownerVerified: true` on 'ipc' source) is REFUSED at S1 and H2
        const ipcForgedChat = await router.execute(
            'send_chat',
            { targetSessionId: runningSessionId, message: 'forged dashboard chat over ipc', origin: 'dashboard' },
            'ipc',
            { ownerVerified: true },
        );
        expect(ipcForgedChat.success).toBe(false);
        expect(ipcForgedChat.code).toBe(NEW_WORK_HELD_CODE);

        // H2 direct forgery: calling inputService.submit with origin:'dashboard' but WITHOUT trusted owner proof is refused
        const h2ForgedDashboard = await inputService.submit({
            messageId: `forged_${randomUUID()}`,
            sessionId: runningSessionId,
            input: { parts: [{ type: 'text', text: 'spoofed origin' }], textFallback: 'spoofed origin' },
            origin: 'dashboard',
            policy: { mode: 'queue' },
            createdAt: Date.now(),
        });
        expect(h2ForgedDashboard.kind).toBe('refused');
        if (h2ForgedDashboard.kind === 'refused') {
            expect(h2ForgedDashboard.reason).toBe(NEW_WORK_HELD_CODE);
        }

        // Proof-verified owner dashboard chat (standalone + ownerVerified + proof preserved) IS allowed
        const validOwnerChat = await router.execute(
            'send_chat',
            { targetSessionId: runningSessionId, message: 'genuine owner chat', origin: 'dashboard' },
            'standalone',
            { ownerVerified: true },
        );
        expect(validOwnerChat.success).toBe(true);
        expect(deliveredMessages).toContain('genuine owner chat');

        // F7: Coordinator follow-up to an already-running worker (matching active taskId) IS allowed at S1 & H2
        const runningContinuation = await router.execute(
            'agent_command',
            {
                agentType: 'claude-cli',
                action: 'send_chat',
                targetSessionId: runningSessionId,
                message: 'coordinator follow-up for active task',
                origin: 'mesh',
                meshContext: { meshId, nodeId, taskId: activeTaskId, attemptId: activeAttemptId },
            },
            'mesh',
            { inProcess: true },
        );
        expect(runningContinuation.success).toBe(true);
        expect(deliveredMessages).toContain('coordinator follow-up for active task');

        // Whereas a dispatch for a DIFFERENT (new) taskId to the session is refused with new_work_held
        const newWorkDispatch = await router.execute(
            'agent_command',
            {
                agentType: 'claude-cli',
                action: 'send_chat',
                targetSessionId: runningSessionId,
                message: 'brand new task',
                origin: 'mesh',
                meshContext: { meshId, nodeId, taskId: 'task-brand-new-999' },
            },
            'mesh',
            { inProcess: true },
        );
        expect(newWorkDispatch.success).toBe(false);
        expect(newWorkDispatch.code).toBe(NEW_WORK_HELD_CODE);
    });

    it('scopes session admission to the resolved session mesh and leaves unrelated sessions runnable', async () => {
        const sent: string[] = [];
        const input = createSessionInputService({ resolveSession: (sessionId) => ({
            getStatus: () => ({ status: 'idle' }),
            getSessionSettings: () => ({ meshNodeFor: sessionId === 'held' ? 'mesh-held' : 'mesh-other' }),
            sendMessage: async () => { sent.push(sessionId); return { status: 'sent' as const }; },
        }) });
        setNewWorkHold({ meshId: 'mesh-held' });
        const message = (sessionId: string) => ({ messageId: `scope:${sessionId}`, sessionId, origin: 'mesh' as const,
            input: { parts: [{ type: 'text' as const, text: 'new task' }], textFallback: 'new task' }, policy: { mode: 'queue' as const }, createdAt: Date.now() });
        expect(await input.submit(message('held'))).toMatchObject({ kind: 'refused', reason: NEW_WORK_HELD_CODE });
        expect(await input.submit(message('other'))).toMatchObject({ kind: 'delivered' });
        expect(sent).toEqual(['other']);
    });

    it('exempts coordinator notices via noticeObserver at H2 and treats new_work_held as retryable in deliverPendingTurns (F6)', async () => {
        const coordSessionId = 'sess-coordinator-1';
        const deliveredNotices: string[] = [];

        // 1. Direct submitNotice (which attaches noticeObserver) passes through H2 while held
        let observerPassedToWrite = false;
        const inputService = createSessionInputService({
            resolveSession: () => ({
                getStatus: () => ({ status: 'idle' }),
                observeSendWrite: (_messageId: string, cb: (state: 'started' | 'submitted' | 'uncertain') => void) => {
                    observerPassedToWrite = true;
                    cb('submitted');
                },
                sendMessage: async (body) => {
                    deliveredNotices.push(typeof body === 'string' ? body : (body as any)?.textFallback);
                    return { status: 'sent' as const };
                },
            }),
        });

        setNewWorkHold({ holdId: 'hold-f6-notice', holder: 'owner-1' });

        let observedFired = false;
        const noticeOutcome = await inputService.submitNotice(
            {
                messageId: 'notify:att-worker-1:completed',
                sessionId: coordSessionId,
                input: { parts: [{ type: 'text', text: '[MESH WORKER COMPLETED]' }], textFallback: '[MESH WORKER COMPLETED]' },
                origin: 'mesh',
                policy: { mode: 'queue' },
                createdAt: Date.now(),
            },
            () => {
                observedFired = true;
            },
        );
        expect(noticeOutcome.kind).toBe('delivered');
        expect(observerPassedToWrite).toBe(true);
        expect(observedFired).toBe(true);
        expect(deliveredNotices).toEqual(['[MESH WORKER COMPLETED]']);

        // 2. Even if createTurnDeliverHandler encounters a port that returns refused(new_work_held),
        // the notice is treated as a retryable refusal (throws to trigger backoff/retry, NOT permanently claimed/dropped)
        const ledger = createTurnLedger({ db: store.db, selfDaemonId: 'daemon_mach_test', autoFlush: false });
        ledger.notifyMeshEvent({
            eventId: 'evt-f6-notice-1',
            meshId: 'mesh-f6',
            targetDaemonId: 'daemon_mach_test',
            targetSessionId: coordSessionId,
            at: Date.now(),
            payload: {
                event: 'task_completed',
                local: {
                    event: 'task_completed',
                    summary: 'worker finished during hold',
                },
            },
        });
        const notifyEntry = {
            meshId: 'mesh-f6',
            writer: 'daemon_mach_test',
            seq: 1,
            kind: 'turn.notify',
            own: true,
            payload: {
                eventId: 'evt-f6-notice-1',
                notify: 'mesh_event',
                targetDaemonId: 'daemon_mach_test',
                targetSessionId: coordSessionId,
                at: Date.now() - 5_000,
            },
        };
        const deliverHandler = createTurnDeliverHandler({
            ledger,
            selfDaemonIds: () => ['daemon_mach_test'],
            coordinators: () => [{ sessionId: coordSessionId, idle: true }],
            waiter: { wait: async () => undefined },
            port: {
                submit: async () => ({
                    kind: 'refused' as const,
                    reason: NEW_WORK_HELD_CODE,
                    message: 'New work is held',
                }),
            },
        });

        await expect(deliverHandler(notifyEntry, new AbortController().signal)).rejects.toThrow(/refused \(new_work_held\)/);
        // Must NOT be claimed as delivered/refused in the ledger store so the cursor redelivers it!
        expect(ledger.store.isDeliveryClaimed('mesh-f6', 'daemon_mach_test', 1)).toBe(false);
    });

    it('makes tryAssignQueueTask (mesh-queue-assignment.ts:502) and H1 maybeAutoLaunchOneQueueSession (mesh-queue-autolaunch.ts:1076) provably red->green (F5)', async () => {
        const meshId = 'mesh-red-green';
        const localNodeId = 'node-local-1';
        const remoteNodeId = 'node-remote-1';
        const localSessionId = 'sess-idle-local';

        // Seed 1 pending task for tryAssignQueueTask on localNodeId
        const assignTask = enqueueTask(meshId, 'Task for tryAssignQueueTask red->green', {
            difficulty: 'easy',
            priority: 'normal',
            targetNodeId: localNodeId,
        });

        const ledger = createTurnLedger({ db: store.db, selfDaemonId: 'daemon-local', autoFlush: false });
        const deliveredDispatches: any[] = [];
        const remoteLaunchCalls: any[] = [];

        const meshObj = {
            id: meshId,
            name: 'Red Green Mesh',
            policy: { maxParallelTasks: 4 },
            nodes: [
                {
                    id: localNodeId,
                    name: localNodeId,
                    daemonId: 'daemon-local',
                    isLocal: true,
                    workspace: rootDir,
                    repoRoot: rootDir,
                    status: 'online',
                    health: 'online',
                    launchReady: true,
                    providers: ['claude-cli'],
                    policy: {
                        maxConcurrentSessions: 4,
                        slots: [
                            {
                                provider: 'claude-cli',
                                model: 'claude-sonnet-4-6',
                                difficulty: ['simple', 'easy', 'medium', 'difficult'],
                                maxParallel: 2,
                            },
                        ],
                    },
                },
                {
                    id: remoteNodeId,
                    name: remoteNodeId,
                    daemonId: 'daemon-remote',
                    isLocal: false,
                    workspace: rootDir,
                    repoRoot: rootDir,
                    status: 'online',
                    health: 'online',
                    launchReady: true,
                    capabilities: { providers: ['claude-cli'] },
                    providers: ['claude-cli'],
                    policy: {
                        maxConcurrentSessions: 4,
                        slots: [
                            {
                                provider: 'claude-cli',
                                model: 'claude-sonnet-4-6',
                                difficulty: ['simple', 'easy', 'medium', 'difficult'],
                                maxParallel: 2,
                            },
                        ],
                    },
                },
            ],
        };

        const localInstance = {
            category: 'cli',
            settings: { meshNodeFor: meshId, meshNodeId: localNodeId, providerType: 'claude-cli' },
            getState: () => ({
                instanceId: localSessionId,
                type: 'claude-cli',
                status: 'idle',
                settings: { meshNodeFor: meshId, meshNodeId: localNodeId, providerType: 'claude-cli' },
            }),
            updateSettings: vi.fn(),
        };

        const getCachedInlineMeshSpy = vi.fn((id: string) => (id === meshId ? meshObj : undefined));

        const components: any = {
            turnLedger: ledger,
            statusInstanceId: 'daemon-local',
            router: {
                getCachedInlineMesh: getCachedInlineMeshSpy,
                execute: vi.fn(async (cmd: string, args: any) => {
                    if (cmd === 'send_chat' || cmd === 'agent_command') {
                        deliveredDispatches.push({ cmd, args });
                        return { success: true, delivered: true };
                    }
                    return { success: true };
                }),
            },
            cliManager: {
                adapters: new Map([
                    [
                        localSessionId,
                        {
                            getStatus: () => ({ status: 'idle' }),
                            isReady: () => true,
                        },
                    ],
                ]),
                findAdapter: (id: string) =>
                    id === localSessionId ? { key: localSessionId, adapter: { getStatus: () => ({ status: 'idle' }), isReady: () => true } } : null,
                findMeshNodeAdapter: () => ({
                    key: localSessionId,
                    adapter: { getStatus: () => ({ status: 'idle' }), isReady: () => true },
                }),
                input: {
                    submit: vi.fn(async (msg: any) => {
                        deliveredDispatches.push(msg);
                        return { kind: 'delivered', messageId: msg.messageId };
                    }),
                },
            },
            instanceManager: {
                listInstanceIds: () => [localSessionId],
                getByCategory: (cat: string) => (cat === 'cli' ? [localInstance] : []),
                getInstance: (id: string) => (id === localSessionId ? localInstance : undefined),
                attachMeshAssignmentToInstance: vi.fn(() => ({ stamped: true })),
            },
            providerLoader: {
                get: () => ({ type: 'claude-cli', transport: 'pty' }),
                getMeta: () => ({ id: 'claude-cli', supportsAutoApprove: true }),
                resolveAlias: (t: string) => t,
                isMachineProviderEnabled: () => true,
            },
            dispatchMeshCommand: vi.fn(async (_daemonId: string, cmd: string, args: any) => {
                if (cmd === 'launch_cli') {
                    remoteLaunchCalls.push(args);
                    const spawnedId = `remote-sess-${remoteLaunchCalls.length}`;
                    store.setRemoteIdleSession(meshId, remoteNodeId, spawnedId, 'claude-cli', Date.now() + 60_000);
                    return { success: true, sessionId: spawnedId };
                }
                return { success: true };
            }),
        };

        // Activate hold
        const hold = setNewWorkHold({ holdId: 'hold-rg-1', holder: 'owner-1' });
        expect(hold.success).toBe(true);

        // --- A. Provably red->green tryAssignQueueTask (mesh-queue-assignment.ts:502) ---
        // While held: tryAssignQueueTask returns false at line 502 BEFORE calling router.getCachedInlineMesh (line 514) or S2 claimNextTask (line 553)
        const assignWhileHeld = tryAssignQueueTask(components, meshId, localNodeId, localSessionId, 'claude-cli');
        expect(assignWhileHeld).toBe(false);
        expect(getCachedInlineMeshSpy).toHaveBeenCalledTimes(0);
        expect(getQueueEntryById(meshId, assignTask.id)?.status).toBe('pending');

        // Release hold -> exact same tryAssignQueueTask call now runs past line 502, calls getCachedInlineMesh, and assigns the task!
        releaseNewWorkHold({ holdId: 'hold-rg-1', holder: 'owner-1' });
        const assignAfterRelease = tryAssignQueueTask(components, meshId, localNodeId, localSessionId, 'claude-cli');
        expect(assignAfterRelease).toBe(true);
        expect(getCachedInlineMeshSpy).toHaveBeenCalled();
        expect(getQueueEntryById(meshId, assignTask.id)?.status).toBe('assigned');
        expect(getQueueEntryById(meshId, assignTask.id)?.assignedSessionId).toBe(localSessionId);

        // Finish A before B: current main's owned-path gate correctly blocks a
        // second unscoped write task while the first task is assigned.
        const completedAssignment = store.findQueueEntryById(meshId, assignTask.id)!;
        completedAssignment.status = 'completed';
        store.updateQueueEntry(completedAssignment);

        // --- B. Provably red->green H1 maybeAutoLaunchOneQueueSession (mesh-queue-autolaunch.ts:1076) ---
        // Enqueue a task pinned to remoteNodeId (which has no running sessions and dispatches via dispatchMeshCommand, bypassing local S1/S2)
        const autoLaunchTask = enqueueTask(meshId, 'Task for H1 auto-launch red->green', {
            difficulty: 'easy',
            priority: 'normal',
            targetNodeId: remoteNodeId,
        });

        setNewWorkHold({ holdId: 'hold-rg-2', holder: 'owner-1' });
        const launchedWhileHeld = await maybeAutoLaunchOneQueueSession(components, meshId, meshObj);
        expect(launchedWhileHeld).toBe(false);
        expect(remoteLaunchCalls).toHaveLength(0);
        expect(getQueueEntryById(meshId, autoLaunchTask.id)?.autoLaunch).toBeUndefined();

        // Release hold -> exact same maybeAutoLaunchOneQueueSession call now returns true and spawns the session!
        releaseNewWorkHold({ holdId: 'hold-rg-2', holder: 'owner-1' });
        const launchedAfterRelease = await maybeAutoLaunchOneQueueSession(components, meshId, meshObj);
        expect(launchedAfterRelease).toBe(true);
        expect(remoteLaunchCalls).toHaveLength(1);
    });

    it('verifies MCP H3 meshSendTask queries daemon via status command (F3), classifies remote P2P new_work_held refusals, and redelivers cleanly after release (F5)', async () => {
        const meshId = 'mesh-h3-mcp';
        const nodeId = 'node-1';
        const sessionId = 'sess-worker-1';

        const deliveredMessages: string[] = [];
        const inputService = createSessionInputService({
            resolveSession: () => ({
                getStatus: () => ({ status: 'idle' }),
                getSessionSettings: () => undefined,
                sendMessage: async (body) => {
                    deliveredMessages.push(typeof body === 'string' ? body : (body as any)?.textFallback);
                    return { status: 'sent' as const };
                },
            }),
        });

        const hold = setNewWorkHold({ holdId: 'hold-h3-1', holder: 'owner-1' });
        expect(hold.success).toBe(true);

        // 1. S2 claimNextTask & triggerMeshQueue refuse while held
        const queuedTask = enqueueTask(meshId, 'Queued task waiting for release', {
            difficulty: 'easy',
            priority: 'normal',
        });
        const claimRefusal: MeshClaimRefusal = {};
        expect(claimNextTask(meshId, nodeId, sessionId, ['provider=claude-cli'], { outRefusal: claimRefusal })).toBeNull();
        expect(claimRefusal.reason).toBe(NEW_WORK_HELD_CODE);

        const triggerRes = await triggerMeshQueue({} as any, meshId);
        expect(triggerRes.claimed).toBe(false);
        expect((triggerRes as any).code).toBe(NEW_WORK_HELD_CODE);

        // 2. MCP meshSendTask asks the daemon via `maintenance_new_work_hold_status` over transport (F3)
        const transportCommands: string[] = [];
        const directTaskCtx: any = {
            mesh: {
                id: meshId,
                name: 'H3 Mesh',
                policy: {},
                coordinator: {},
                nodes: [
                    {
                        id: nodeId,
                        workspace: rootDir,
                        repoRoot: rootDir,
                        daemonId: 'daemon_mach_test',
                        machineId: 'mach-test',
                        userOverrides: {},
                        policy: { providerPriority: ['claude-cli'] },
                        sessions: [
                            {
                                id: sessionId,
                                providerType: 'claude-cli',
                                status: 'idle',
                                settings: { meshNodeFor: meshId, meshNodeId: nodeId, launchedByCoordinator: true },
                            },
                        ],
                    },
                ],
            },
            transport: {
                command: async (cmd: string) => {
                    transportCommands.push(cmd);
                    if (cmd === 'maintenance_new_work_hold_status') {
                        return {
                            success: true,
                            held: true,
                            hold: hold.hold,
                            drain: hold.drain,
                        };
                    }
                    return { success: true };
                },
            },
            localDaemonId: 'daemon_mach_test',
            localMachineId: 'mach-test',
            coordinatorSessionId: 'sess-coord',
        };

        const mcpDirectHeld = JSON.parse(
            await meshSendTask(directTaskCtx, {
                node_id: nodeId,
                session_id: sessionId,
                message: 'Direct MCP task while held',
                difficulty: 'easy',
            } as any),
        );
        expect(transportCommands).toContain('maintenance_new_work_hold_status');
        expect(mcpDirectHeld.success).toBe(false);
        expect(mcpDirectHeld.code).toBe(NEW_WORK_HELD_CODE);
        expect(mcpDirectHeld.holdId).toBe('hold-h3-1');

        // 3. Remote P2P dispatch (`sendDirectAgentTask`) classifies remote daemon's `new_work_held` refusal
        const remoteHeldRefusal = buildNewWorkHeldRefusal(hold.hold, { command: 'agent_command', surface: 'router_command' });
        const remoteRes = await sendDirectAgentTask(
            {
                ...directTaskCtx,
                transport: {
                    mode: 'daemon',
                    supportsMeshRelay: true as const,
                    command: async () => remoteHeldRefusal,
                    meshCommand: async () => remoteHeldRefusal,
                },
            } as any,
            {
                id: 'node-remote',
                daemonId: 'daemon_remote_peer',
                workspace: rootDir,
            } as any,
            'remote',
            {
                sessionId: 'sess-remote-1',
                providerType: 'claude-cli',
            },
            {
                message: 'Remote task body',
                origin: 'mesh',
            },
        ) as any;
        expect(remoteRes.success).toBe(false);
        expect(remoteRes.code).toBe(NEW_WORK_HELD_CODE);
        expect(remoteRes.holdId).toBe('hold-h3-1');

        // 4. Queue dispatch (`deliverTaskToSession`) during hold requeues to pending with zero budget penalty,
        // and redelivers cleanly after release!
        store.insertQueueEntry({
            id: 'task-redeliver-1',
            meshId,
            status: 'assigned',
            assignedNodeId: nodeId,
            assignedSessionId: sessionId,
            message: 'Task to redeliver after release',
            difficulty: 'simple',
            priority: 'normal',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

        const heldMsgId = `msg_redeliver_${randomUUID()}`;
        const h2Held = await inputService.submit({
            messageId: heldMsgId,
            sessionId,
            input: { parts: [{ type: 'text', text: 'Task to redeliver after release' }], textFallback: 'Task to redeliver after release' },
            origin: 'mesh',
            policy: { mode: 'queue' },
            createdAt: Date.now(),
        });
        expect(h2Held.kind).toBe('refused');
        if (h2Held.kind === 'refused') {
            expect(classifyNewWorkHeld(h2Held.message)?.holdId).toBe('hold-h3-1');
        }

        deliverTaskToSession(
            async () => ({ success: false, code: NEW_WORK_HELD_CODE, error: 'new_work_held' }),
            {
                components: {} as any,
                meshId,
                nodeId,
                sessionId,
                providerType: 'claude-cli',
                task: store.findQueueEntryById(meshId, 'task-redeliver-1')!,
                transport: 'local',
            },
        );
        await new Promise((r) => setImmediate(r));
        const requeued = getQueueEntryById(meshId, 'task-redeliver-1')!;
        expect(requeued.status).toBe('pending');
        expect(requeued.requeueCount ?? 0).toBe(0);
        expect(requeued.dispatchFailureCount ?? 0).toBe(0);

        // Release hold and verify redelivery of both the held messageId and queued tasks
        releaseNewWorkHold({ holdId: 'hold-h3-1', holder: 'owner-1' });

        const h2Redelivered = await inputService.submit({
            messageId: heldMsgId,
            sessionId,
            input: { parts: [{ type: 'text', text: 'Task to redeliver after release' }], textFallback: 'Task to redeliver after release' },
            origin: 'mesh',
            policy: { mode: 'queue' },
            createdAt: Date.now(),
        });
        expect(h2Redelivered.kind).toBe('delivered');
        expect(deliveredMessages).toEqual(['Task to redeliver after release']);

        const claimedAfterRelease = claimNextTask(meshId, nodeId, sessionId, ['provider=claude-cli']);
        expect(claimedAfterRelease).not.toBeNull();
        expect(claimedAfterRelease?.id).toBe(queuedTask.id);
        expect(claimedAfterRelease?.status).toBe('assigned');
    });
});
