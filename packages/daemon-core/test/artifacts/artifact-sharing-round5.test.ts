import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import {
    __resetOriginGrantStateForTest,
    getHostOriginGrantPublicKey,
    mintArtifactOriginFetchGrant,
} from '../../src/commands/med-family/artifact-origin-grant.js';
import {
    artifactHandlers,
    setArtifactCommandRuntimeForDeps,
    type ArtifactCommandContext,
} from '../../src/commands/med-family/artifacts.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import {
    __resetWorkerSessionBindsForTest,
    __resetWorkerTaskTokensForTest,
    mintWorkerSessionBind,
    mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation.js';
import {
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
} from '../../src/seqscribe/transcript-publisher.js';
import { SessionRegistry } from '../../src/sessions/registry.js';

const ALL_ALIASES = [
    'artifact_register',
    'session_artifact_register',
    'artifact_list',
    'session_artifact_list',
    'artifact_fetch',
    'artifact_read',
    'session_artifact_fetch',
] as const;

describe('Artifact Sharing Round 5 Regressions (Codex Review 3f3a4fbb)', () => {
    let tempRoot: string;
    let hostWorkspace: string;
    let workerWorkspace: string;
    let originWorkspace: string;
    let hostMeshStore: MeshRuntimeStore;
    let hostArtifactStore: ArtifactStore;
    let hostSessionRegistry: SessionRegistry;
    let hostDeps: CommandRouterDeps;
    let hostCtx: ArtifactCommandContext;
    let prevConfigDir: string | undefined;

    function seedHostAttempt(
        store: MeshRuntimeStore,
        overrides: Parameters<typeof seedMeshAttempt>[0] & { ownerDaemonId?: string },
    ) {
        const seeded = seedMeshAttempt({
            ...overrides,
            nodeId: overrides.nodeId ?? 'node-worker-r5',
        });
        const record = {
            ...seeded,
            ownerDaemonId: overrides.ownerDaemonId ?? 'daemon_host_r5',
        };
        store.turnStore().upsertAttempt(record, Date.now());
        return record;
    }

    beforeEach(() => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-artifact-r5-'));
        const hostConfigDir = path.join(tempRoot, 'host-config');
        fs.mkdirSync(hostConfigDir, { recursive: true });
        process.env.ADHDEV_CONFIG_DIR = hostConfigDir;

        hostWorkspace = path.join(tempRoot, 'ws-host');
        workerWorkspace = path.join(tempRoot, 'ws-worker');
        originWorkspace = path.join(tempRoot, 'ws-origin');
        fs.mkdirSync(hostWorkspace, { recursive: true });
        fs.mkdirSync(workerWorkspace, { recursive: true });
        fs.mkdirSync(originWorkspace, { recursive: true });

        MeshRuntimeStore.resetForTests();
        __resetWorkerSessionBindsForTest();
        __resetWorkerTaskTokensForTest();
        __resetOriginGrantStateForTest();
        __resetTranscriptProjectionForTests();

        hostMeshStore = MeshRuntimeStore.getInstance();
        hostArtifactStore = new ArtifactStore(hostMeshStore.db);
        hostSessionRegistry = new SessionRegistry();

        configureTranscriptProjection({
            daemonId: () => 'daemon_host_r5',
            writerId: () => 'writer-r5',
            epoch: 'epoch-r5',
            appendChatFrame: async () => {},
            readPersistedChat: () => null,
        });

        hostDeps = {
            commandHandler: { handle: async () => ({ success: true }) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { getInstance: () => undefined } as any,
            detectedIdes: { value: [] },
            sessionRegistry: hostSessionRegistry,
            statusInstanceId: 'daemon_host_r5',
        };
        setArtifactCommandRuntimeForDeps(hostDeps, {
            artifactStore: hostArtifactStore,
            meshRuntimeStore: hostMeshStore,
        });
        hostCtx = {
            deps: hostDeps,
            getMeshForCommand: async () => null,
            getCachedInlineMesh: () => undefined,
        };
    });

    afterEach(() => {
        __resetTranscriptProjectionForTests();
        __resetWorkerSessionBindsForTest();
        __resetWorkerTaskTokensForTest();
        __resetOriginGrantStateForTest();
        MeshRuntimeStore.resetForTests();
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('Finding 1 (HIGH): rejects a stale task token + old attemptId after the same task/session is requeued with a new live attempt and assignment stamp across all 7 aliases', async () => {
        const meshId = 'mesh-r5-requeue';
        const taskId = 'task-r5-requeue';
        const workerSessionId = 'sess-worker-requeue';
        const oldAttemptId = 'att-old-completed-1';
        const newAttemptId = 'att-new-live-2';

        fs.writeFileSync(path.join(hostWorkspace, 'host-input.md'), '# Host Input\nShared with worker.\n', 'utf8');
        fs.writeFileSync(path.join(workerWorkspace, 'worker-out.md'), '# Worker Output\nAttempt output.\n', 'utf8');

        hostSessionRegistry.register({
            sessionId: 'sess-host-producer',
            parentSessionId: null,
            providerType: 'claude-cli',
            transport: 'pty',
            workspace: hostWorkspace,
        });
        const sharedArtifact = hostArtifactStore.register({
            sessionId: 'sess-host-producer',
            meshId,
            missionId: 'mission-r5-1',
            originDaemonId: 'daemon_host_r5',
            workspaceRoot: hostWorkspace,
            path: 'host-input.md',
            title: 'Host Input',
        }).record;

        // Mint OLD task token for the old completed attempt
        const oldToken = mintWorkerTaskToken({
            meshId,
            taskId,
            sessionId: workerSessionId,
            nodeId: 'node-worker-r5',
            attemptId: oldAttemptId,
        });

        // Old attempt completed on host
        const nowMs = Date.now();
        seedHostAttempt(hostMeshStore, {
            attemptId: oldAttemptId,
            taskId,
            meshId,
            nodeId: 'node-worker-r5',
            sessionId: workerSessionId,
            attemptNo: 0,
            stage: 'completed',
            terminal: true,
            terminalOutcome: 'completed',
            terminalAt: nowMs - 5_000,
        });

        // Requeue the SAME task and SAME session with a NEW live attempt on the host
        const nowIso = new Date().toISOString();
        hostMeshStore.insertQueueEntry({
            id: taskId,
            meshId,
            targetNodeId: 'node-worker-r5',
            assignedNodeId: 'node-worker-r5',
            status: 'assigned',
            assignedSessionId: workerSessionId,
            attemptId: newAttemptId,
            message: 'Requeued task on same session',
            workspace: workerWorkspace,
            missionId: 'mission-r5-1',
            inputArtifactIds: [sharedArtifact.artifactId],
            createdAt: nowIso,
            updatedAt: nowIso,
        } as any);
        seedHostAttempt(hostMeshStore, {
            attemptId: newAttemptId,
            taskId,
            meshId,
            nodeId: 'node-worker-r5',
            sessionId: workerSessionId,
            attemptNo: 1,
            stage: 'generating',
            terminal: false,
        });

        // Mint NEW task token for the new live attempt
        const newToken = mintWorkerTaskToken({
            meshId,
            taskId,
            sessionId: workerSessionId,
            nodeId: 'node-worker-r5',
            attemptId: newAttemptId,
        });

        // Set up remote worker daemon with its OWN empty SQLite store and NEW live assignment stamp on the session
        const workerMeshStore = new MeshRuntimeStore(path.join(tempRoot, 'worker-requeue.db'));
        const workerArtifactStore = new ArtifactStore(workerMeshStore.db);
        const workerRegistry = new SessionRegistry();
        workerRegistry.register({
            sessionId: workerSessionId,
            parentSessionId: null,
            providerType: 'claude-cli',
            transport: 'pty',
            workspace: workerWorkspace,
        });

        const inlineMesh = {
            id: meshId,
            meshHost: {
                hostDaemonId: 'daemon_host_r5',
                originGrantPublicKey: getHostOriginGrantPublicKey('daemon_host_r5'),
            },
            nodes: [
                { id: 'node-host-r5', daemonId: 'daemon_host_r5', workspace: hostWorkspace },
                {
                    id: 'node-worker-r5',
                    daemonId: 'daemon_worker_r5',
                    workspace: workerWorkspace,
                    activeSessionId: workerSessionId,
                },
            ],
        };

        hostCtx = {
            deps: hostDeps,
            getMeshForCommand: async (id: string) => (id === meshId ? { mesh: inlineMesh, source: 'inline' } : null),
            getCachedInlineMesh: (id: string) => (id === meshId ? inlineMesh : undefined),
        };

        let currentStampAttemptId: string | undefined = newAttemptId;
        const forwardedClaimsObserved: Array<Record<string, unknown>> = [];

        const workerDeps: CommandRouterDeps = {
            commandHandler: { handle: async () => ({ success: true }) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: {
                getInstance: (sid: string) =>
                    sid === workerSessionId
                        ? ({
                              providerType: 'claude-cli',
                              getState: () => ({
                                  workspace: workerWorkspace,
                                  status: 'working',
                                  settings: {
                                      meshNodeFor: meshId,
                                      meshCoordinatorDaemonId: 'daemon_host_r5',
                                      meshNodeId: 'node-worker-r5',
                                      meshActiveTaskId: taskId,
                                      meshTaskId: taskId,
                                      ...(currentStampAttemptId
                                          ? {
                                                meshActiveAttemptId: currentStampAttemptId,
                                                meshAttemptId: currentStampAttemptId,
                                            }
                                          : {}),
                                  },
                              }),
                          } as any)
                        : undefined,
            } as any,
            detectedIdes: { value: [] },
            sessionRegistry: workerRegistry,
            statusInstanceId: 'daemon_worker_r5',
            dispatchMeshCommand: async (targetDaemonId: string, command: string, payload: Record<string, unknown>) => {
                forwardedClaimsObserved.push({ targetDaemonId, command, ...payload });
                const stamped = { ...payload, [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_worker_r5' };
                if (targetDaemonId === 'daemon_host_r5' && command === 'artifact_index_forwarded') {
                    return artifactHandlers.artifact_index_forwarded(hostCtx, stamped);
                }
                if (targetDaemonId === 'daemon_host_r5' && command === 'artifact_fetch_origin') {
                    return artifactHandlers.artifact_fetch_origin(hostCtx, stamped);
                }
                throw new Error(`Unexpected mesh dispatch: ${targetDaemonId} ${command}`);
            },
        };
        setArtifactCommandRuntimeForDeps(workerDeps, {
            artifactStore: workerArtifactStore,
            meshRuntimeStore: workerMeshStore,
        });
        const workerRouter = new DaemonCommandRouter(workerDeps);
        workerRouter.inlineMeshCache.set(meshId, inlineMesh);

        try {
            // 1) Exact repro from review: request carrying ONLY the OLD task token + OLD attemptId
            //    while the session has the NEW live attempt and NEW assignment stamp.
            //    Must be rejected BEFORE forming any forwarded claim on all 7 aliases!
            for (const alias of ALL_ALIASES) {
                const res = await workerRouter.execute(
                    alias,
                    {
                        token: oldToken.token,
                        attemptId: oldAttemptId,
                        path: 'worker-out.md',
                        artifactId: sharedArtifact.artifactId,
                    },
                    'ipc',
                );
                expect(res.success, `${alias} with old token + old attemptId`).toBe(false);
                expect(res.code, `${alias} code`).toBe('stale_attempt');
                expect(res.content).toBeUndefined();
                expect(res.artifacts).toBeUndefined();
            }
            // Verify zero forwarded claims were sent when local stamp disagreed with the old token/attempt
            expect(forwardedClaimsObserved).toHaveLength(0);
            expect(workerArtifactStore.listBySession(workerSessionId)).toHaveLength(0);

            // 2) Also verify with ONLY the OLD task token (omitting explicit attemptId in args):
            for (const alias of ALL_ALIASES) {
                const res = await workerRouter.execute(
                    alias,
                    {
                        token: oldToken.token,
                        path: 'worker-out.md',
                        artifactId: sharedArtifact.artifactId,
                    },
                    'ipc',
                );
                expect(res.success, `${alias} with old token only`).toBe(false);
                expect(res.code, `${alias} code`).toBe('stale_attempt');
            }
            expect(forwardedClaimsObserved).toHaveLength(0);

            // 3) Even if the worker's local stamp does not carry attemptId yet, the forwarded claim
            //    MUST carry the token's bound attemptId (oldAttemptId) and be rejected by the host on all 7 aliases.
            currentStampAttemptId = undefined;
            for (const alias of ALL_ALIASES) {
                forwardedClaimsObserved.length = 0;
                const res = await workerRouter.execute(
                    alias,
                    {
                        token: oldToken.token,
                        attemptId: oldAttemptId,
                        path: 'worker-out.md',
                        artifactId: sharedArtifact.artifactId,
                    },
                    'ipc',
                );
                expect(res.success, `${alias} host-side rejection of old token`).toBe(false);
                expect(res.code, `${alias} host-side code`).toBe('stale_attempt');
                expect(forwardedClaimsObserved.length).toBeGreaterThanOrEqual(1);
                for (const claim of forwardedClaimsObserved) {
                    expect(claim.attemptId).toBe(oldAttemptId);
                }
            }
            expect(workerArtifactStore.listBySession(workerSessionId)).toHaveLength(0);

            // 4) Positive control: the NEW task token + NEW attemptId succeeds across all 7 aliases
            currentStampAttemptId = newAttemptId;
            for (const regAlias of ['artifact_register', 'session_artifact_register'] as const) {
                const reg = await workerRouter.execute(
                    regAlias,
                    {
                        token: newToken.token,
                        attemptId: newAttemptId,
                        path: 'worker-out.md',
                    },
                    'ipc',
                );
                expect(reg.success, `${regAlias} with new token`).toBe(true);
            }
            for (const listAlias of ['artifact_list', 'session_artifact_list'] as const) {
                const list = await workerRouter.execute(
                    listAlias,
                    {
                        token: newToken.token,
                        attemptId: newAttemptId,
                    },
                    'ipc',
                );
                expect(list.success, `${listAlias} with new token`).toBe(true);
                const ids = (list.artifacts as any[]).map((a) => a.artifactId);
                expect(ids).toContain(sharedArtifact.artifactId);
            }
            for (const fetchAlias of ['artifact_fetch', 'artifact_read', 'session_artifact_fetch'] as const) {
                const fetched = await workerRouter.execute(
                    fetchAlias,
                    {
                        token: newToken.token,
                        attemptId: newAttemptId,
                        artifactId: sharedArtifact.artifactId,
                    },
                    'ipc',
                );
                expect(fetched.success, `${fetchAlias} with new token`).toBe(true);
                expect(fetched.content).toContain('# Host Input\nShared with worker.');
            }
        } finally {
            workerMeshStore.close();
        }
    });

    it('Finding 2 (MEDIUM): verifies Ed25519 cross-origin grants across a REAL separate Node process and separate SQLite store, rejecting forged, expired, replayed, wrong-origin, wrong-artifact, and task/attempt-mismatched grants', async () => {
        const meshId = 'mesh-r5-two-proc';
        const hostDaemonIdRaw = 'mach_host_r5';
        const hostDaemonIdHyphen = 'daemon_mach_host_r5'; // Exercises raw (mach_*) vs canonical (daemon_mach_*) daemon-id equivalence
        const originDaemonIdRaw = 'daemon_mach_origin_r5';
        const workerDaemonIdRaw = 'daemon_mach_worker_r5';

        const originConfigDir = path.join(tempRoot, 'origin-config');
        const originDbPath = path.join(tempRoot, 'origin-mesh.db');
        fs.mkdirSync(originConfigDir, { recursive: true });

        fs.writeFileSync(
            path.join(originWorkspace, 'origin-design.md'),
            '# Cross-Process Origin Artifact\nVerified via Ed25519 across separate processes.\n',
            'utf8',
        );
        fs.writeFileSync(
            path.join(originWorkspace, 'origin-other.md'),
            '# Other Origin Artifact\nMust not be served under first artifact grant.\n',
            'utf8',
        );

        // Host generates its Ed25519 public key in host-config; origin-config does NOT have host's private key!
        const hostPublicKey = getHostOriginGrantPublicKey(hostDaemonIdRaw);
        expect(hostPublicKey.length).toBeGreaterThan(20);
        expect(fs.existsSync(path.join(originConfigDir, 'artifact-origin-grant-keys.json'))).toBe(false);

        // Write a tiny ESM worker script for the separate Origin daemon process
        const distIndexUrl = new URL('../../dist/index.mjs', import.meta.url).href;
        const originRunnerPath = path.join(tempRoot, 'origin-daemon-runner.mjs');
        fs.writeFileSync(
            originRunnerPath,
            `
import * as readline from 'node:readline';
import {
    DaemonCommandRouter,
    SessionRegistry,
    MESH_SENDER_DAEMON_ID_ARG,
    issueTrustedOwnerIngressProof,
    attachTrustedOwnerIngressProof,
} from ${JSON.stringify(distIndexUrl)};

const workspace = process.env.TEST_ORIGIN_WORKSPACE;
const meshId = process.env.TEST_MESH_ID;
const hostDaemonId = process.env.TEST_HOST_DAEMON_ID;
const originDaemonId = process.env.TEST_ORIGIN_DAEMON_ID;
const workerDaemonId = process.env.TEST_WORKER_DAEMON_ID;
const hostPublicKey = process.env.TEST_HOST_PUBLIC_KEY;

const sessionRegistry = new SessionRegistry();
sessionRegistry.register({
    sessionId: 'sess-origin-producer',
    parentSessionId: null,
    providerType: 'claude-cli',
    transport: 'pty',
    workspace,
});

const inlineMesh = {
    id: meshId,
    meshHost: {
        hostDaemonId,
        originGrantPublicKey: hostPublicKey,
    },
    nodes: [
        { id: 'node-host', daemonId: hostDaemonId, workspace, originGrantPublicKey: hostPublicKey },
        { id: 'node-origin', daemonId: originDaemonId, workspace },
        { id: 'node-worker', daemonId: workerDaemonId, workspace, activeSessionId: 'sess-worker-two-proc' },
    ],
};

const deps = {
    commandHandler: { handle: async () => ({ success: true }) },
    cliManager: {},
    cdpManagers: new Map(),
    providerLoader: {},
    instanceManager: { getInstance: () => undefined },
    detectedIdes: { value: [] },
    sessionRegistry,
    statusInstanceId: originDaemonId,
};
const router = new DaemonCommandRouter(deps);
router.inlineMeshCache.set(meshId, inlineMesh);

const ownerProof = issueTrustedOwnerIngressProof({
    source: 'standalone',
    ownerVerified: true,
    verifyCurrent: () => true,
});

const reg1 = await router.execute(
    'artifact_register',
    attachTrustedOwnerIngressProof(
        {
            sessionId: 'sess-origin-producer',
            meshId,
            missionId: 'mission-two-proc',
            path: 'origin-design.md',
            title: 'Origin Design',
        },
        ownerProof,
    ),
    'standalone',
    { ownerVerified: true, ownerProof },
);
const reg2 = await router.execute(
    'artifact_register',
    attachTrustedOwnerIngressProof(
        {
            sessionId: 'sess-origin-producer',
            meshId,
            missionId: 'mission-two-proc',
            path: 'origin-other.md',
            title: 'Origin Other',
        },
        ownerProof,
    ),
    'standalone',
    { ownerVerified: true, ownerProof },
);

const doc1 = { ...reg1.artifact, meshId, missionId: 'mission-two-proc', originDaemonId };
const doc2 = { ...reg2.artifact, meshId, missionId: 'mission-two-proc', originDaemonId };

process.stdout.write('__RPC__:' + JSON.stringify({ ready: true, pid: process.pid, doc1, doc2 }) + '\\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
        const msg = JSON.parse(line);
        if (msg.cmd === 'shutdown') {
            process.stdout.write('__RPC__:' + JSON.stringify({ id: msg.id, result: { shutDown: true } }) + '\\n');
            process.exit(0);
        }
        const res = await router.execute(
            'artifact_fetch_origin',
            {
                ...msg.payload,
                [MESH_SENDER_DAEMON_ID_ARG]: msg.senderDaemonId,
            },
            'mesh',
        );
        process.stdout.write('__RPC__:' + JSON.stringify({ id: msg.id, result: res }) + '\\n');
    } catch (err) {
        process.stdout.write('__RPC__:' + JSON.stringify({ id: 0, error: String(err) }) + '\\n');
    }
});
`,
            'utf8',
        );

        async function spawnOriginDaemon() {
            const child = childProcess.spawn(process.execPath, [originRunnerPath], {
                env: {
                    ...process.env,
                    ADHDEV_CONFIG_DIR: originConfigDir,
                    TEST_ORIGIN_DB_PATH: originDbPath,
                    TEST_ORIGIN_WORKSPACE: originWorkspace,
                    TEST_MESH_ID: meshId,
                    TEST_HOST_DAEMON_ID: hostDaemonIdHyphen,
                    TEST_ORIGIN_DAEMON_ID: originDaemonIdRaw,
                    TEST_WORKER_DAEMON_ID: workerDaemonIdRaw,
                    TEST_HOST_PUBLIC_KEY: hostPublicKey,
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stderrBuf = '';
            child.stderr.on('data', (chunk) => {
                stderrBuf += String(chunk);
            });
            const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
            const pending = new Map<number, (val: any) => void>();
            let readyResolve!: (val: any) => void;
            let readyReject!: (err: Error) => void;
            const readyPromise = new Promise<any>((resolve, reject) => {
                readyResolve = resolve;
                readyReject = reject;
            });
            child.on('exit', (code) => {
                if (isFirst) {
                    readyReject(new Error(`Origin child exited early with code ${code}: ${stderrBuf}`));
                }
            });
            let isFirst = true;
            rl.on('line', (line) => {
                if (!line.startsWith('__RPC__:')) return;
                const parsed = JSON.parse(line.slice('__RPC__:'.length));
                if (isFirst && parsed.ready) {
                    isFirst = false;
                    readyResolve(parsed);
                    return;
                }
                const cb = pending.get(parsed.id);
                if (cb) {
                    pending.delete(parsed.id);
                    cb(parsed.result);
                }
            });
            let nextRpcId = 1;
            const callOrigin = (senderDaemonId: string, payload: Record<string, unknown>): Promise<any> => {
                const id = nextRpcId++;
                return new Promise((resolve) => {
                    pending.set(id, resolve);
                    child.stdin.write(JSON.stringify({ id, senderDaemonId, payload }) + '\n');
                });
            };
            const shutdown = async () => {
                if (child.exitCode !== null) return;
                const id = nextRpcId++;
                await new Promise<void>((resolve) => {
                    pending.set(id, () => resolve());
                    child.stdin.write(JSON.stringify({ id, cmd: 'shutdown' }) + '\n');
                    setTimeout(resolve, 1000);
                });
                child.kill();
            };
            const readyInfo = await readyPromise;
            return { child, readyInfo, callOrigin, shutdown };
        }

        let originProc = await spawnOriginDaemon();
        try {
            expect(originProc.readyInfo.pid).not.toBe(process.pid);
            const originDoc1 = originProc.readyInfo.doc1;
            const originDoc2 = originProc.readyInfo.doc2;

            // Index both forwarded artifacts on Host and assign Worker to consume originDoc1
            hostArtifactStore.upsertForwardedArtifact(originDoc1);
            hostArtifactStore.upsertForwardedArtifact(originDoc2);

            const nowIso = new Date().toISOString();
            const nowMs = Date.now();
            hostMeshStore.insertQueueEntry({
                id: 'task-two-proc-1',
                meshId,
                targetNodeId: 'node-worker',
                assignedNodeId: 'node-worker',
                status: 'assigned',
                assignedSessionId: 'sess-worker-two-proc',
                attemptId: 'att-two-proc-1',
                message: 'Fetch cross-process artifact',
                workspace: workerWorkspace,
                missionId: 'mission-two-proc',
                inputArtifactIds: [originDoc1.artifactId],
                createdAt: nowIso,
                updatedAt: nowIso,
            } as any);
            seedHostAttempt(hostMeshStore, {
                attemptId: 'att-two-proc-1',
                taskId: 'task-two-proc-1',
                meshId,
                nodeId: 'node-worker',
                ownerDaemonId: hostDaemonIdRaw,
                sessionId: 'sess-worker-two-proc',
                attemptNo: 0,
                stage: 'generating',
            });

            const inlineMeshOnHost = {
                id: meshId,
                meshHost: {
                    hostDaemonId: hostDaemonIdRaw,
                    originGrantPublicKey: hostPublicKey,
                },
                nodes: [
                    { id: 'node-host', daemonId: hostDaemonIdRaw, workspace: hostWorkspace },
                    { id: 'node-origin', daemonId: originDaemonIdRaw, workspace: originWorkspace },
                    {
                        id: 'node-worker',
                        daemonId: workerDaemonIdRaw,
                        workspace: workerWorkspace,
                        activeSessionId: 'sess-worker-two-proc',
                    },
                ],
            };
            hostDeps.statusInstanceId = hostDaemonIdRaw;
            hostCtx = {
                deps: hostDeps,
                getMeshForCommand: async (id: string) =>
                    id === meshId ? { mesh: inlineMeshOnHost, source: 'inline' } : null,
                getCachedInlineMesh: (id: string) => (id === meshId ? inlineMeshOnHost : undefined),
            };

            // Worker daemon setup dispatching to Host (in-process) and Origin (separate child process!)
            const workerMeshStore = new MeshRuntimeStore(path.join(tempRoot, 'worker-two-proc.db'));
            const workerArtifactStore = new ArtifactStore(workerMeshStore.db);
            const workerRegistry = new SessionRegistry();
            workerRegistry.register({
                sessionId: 'sess-worker-two-proc',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workerWorkspace,
            });
            const workerBind = mintWorkerSessionBind({
                sessionId: 'sess-worker-two-proc',
                meshId,
                nodeId: 'node-worker',
                spawnedForTaskId: 'task-two-proc-1',
            });
            const workerToken = mintWorkerTaskToken({
                taskId: 'task-two-proc-1',
                attemptId: 'att-two-proc-1',
                meshId,
                nodeId: 'node-worker',
                sessionId: 'sess-worker-two-proc',
            });

            const workerDeps: any = {
                statusInstanceId: workerDaemonIdRaw,
                sessionRegistry: workerRegistry,
                instanceManager: {
                    getInstance: (sid: string) =>
                        sid === 'sess-worker-two-proc'
                            ? {
                                  providerType: 'claude-cli',
                                  getState: () => ({
                                      workspace: workerWorkspace,
                                      status: 'working',
                                      settings: {
                                          meshNodeFor: meshId,
                                          meshCoordinatorDaemonId: hostDaemonIdRaw,
                                          meshNodeId: 'node-worker',
                                          meshActiveTaskId: 'task-two-proc-1',
                                          meshAttemptId: 'att-two-proc-1',
                                      },
                                  }),
                              }
                            : undefined,
                },
                dispatchMeshCommand: async (
                    targetDaemonId: string,
                    command: string,
                    payload: Record<string, unknown>,
                ) => {
                    if (targetDaemonId === hostDaemonIdRaw && command === 'artifact_index_forwarded') {
                        return artifactHandlers.artifact_index_forwarded(hostCtx, {
                            ...payload,
                            [MESH_SENDER_DAEMON_ID_ARG]: workerDaemonIdRaw,
                        });
                    }
                    if (targetDaemonId === originDaemonIdRaw && command === 'artifact_fetch_origin') {
                        return originProc.callOrigin(workerDaemonIdRaw, payload);
                    }
                    throw new Error(`Unexpected dispatch: ${targetDaemonId} ${command}`);
                },
            };
            setArtifactCommandRuntimeForDeps(workerDeps, {
                artifactStore: workerArtifactStore,
                meshRuntimeStore: workerMeshStore,
            });
            const workerCtx: ArtifactCommandContext = {
                deps: workerDeps,
                getMeshForCommand: async (id: string) =>
                    id === meshId ? { mesh: inlineMeshOnHost, source: 'inline' } : null,
                getCachedInlineMesh: (id: string) => (id === meshId ? inlineMeshOnHost : undefined),
            };

            try {
                // 1) POSITIVE: legitimate cross-process fetch succeeds
                const okRead = await artifactHandlers.artifact_read(workerCtx, {
                    artifactId: originDoc1.artifactId,
                    bind: workerBind.bind,
                    token: workerToken.token,
                });
                expect(okRead.success, JSON.stringify(okRead)).toBe(true);
                expect(okRead.content).toContain('# Cross-Process Origin Artifact');

                // Mint a fresh grant from Host for negative and replay tests against the Origin child process
                const validGrant = mintArtifactOriginFetchGrant({
                    meshId,
                    hostDaemonId: hostDaemonIdRaw,
                    originDaemonId: originDaemonIdRaw,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    nowMs,
                });

                // 2) NEGATIVE — Forged signature (signed with an attacker's Ed25519 private key)
                const attackerKey = crypto.generateKeyPairSync('ed25519');
                const forgedSig = crypto
                    .sign(null, Buffer.from('forged-payload', 'utf8'), attackerKey.privateKey)
                    .toString('base64url');
                const forgedRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: { ...validGrant, signature: forgedSig },
                    mode: 'read',
                    asChunks: true,
                });
                expect(forgedRes.success).toBe(false);
                expect(forgedRes.code).toBe('artifact_access_denied');
                expect(forgedRes.error).toContain('invalid_grant_signature');

                // 3) NEGATIVE — Expired grant
                const expiredGrant = mintArtifactOriginFetchGrant({
                    meshId,
                    hostDaemonId: hostDaemonIdRaw,
                    originDaemonId: originDaemonIdRaw,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    nowMs: nowMs - 120_000,
                    ttlMs: 10_000,
                });
                const expiredRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: expiredGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(expiredRes.success).toBe(false);
                expect(expiredRes.code).toBe('artifact_access_denied');
                expect(expiredRes.error).toContain('expired_or_invalid_grant_window');

                // 4) NEGATIVE — Wrong origin daemon ID
                const wrongOriginGrant = mintArtifactOriginFetchGrant({
                    meshId,
                    hostDaemonId: hostDaemonIdRaw,
                    originDaemonId: 'daemon_some_other_origin',
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    nowMs,
                });
                const wrongOriginRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: wrongOriginGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(wrongOriginRes.success).toBe(false);
                expect(wrongOriginRes.code).toBe('artifact_access_denied');
                expect(wrongOriginRes.error).toContain('grant_scope_mismatch');

                // 5) NEGATIVE — Wrong artifact ID (using grant for doc1 to request doc2)
                const wrongArtifactRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc2.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: validGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(wrongArtifactRes.success).toBe(false);
                expect(wrongArtifactRes.code).toBe('artifact_access_denied');
                expect(wrongArtifactRes.error).toContain('grant_scope_mismatch');

                // 6) NEGATIVE — Task / attempt mismatch between request and signed grant
                const wrongTaskRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-different-99',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: validGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(wrongTaskRes.success).toBe(false);
                expect(wrongTaskRes.code).toBe('artifact_access_denied');
                expect(wrongTaskRes.error).toContain('grant_task_or_attempt_mismatch');

                const wrongAttemptRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-different-99',
                    requesterRole: 'worker',
                    originFetchGrant: validGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(wrongAttemptRes.success).toBe(false);
                expect(wrongAttemptRes.code).toBe('artifact_access_denied');
                expect(wrongAttemptRes.error).toContain('grant_task_or_attempt_mismatch');

                // 7) Consume validGrant once (succeeds), then REPLAY validGrant (rejected in memory AND after origin restart via durable SQLite!)
                const firstUseRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: validGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(firstUseRes.success).toBe(true);

                const replayInMemRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: validGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(replayInMemRes.success).toBe(false);
                expect(replayInMemRes.code).toBe('artifact_access_denied');
                expect(replayInMemRes.error).toContain('replayed_grant_nonce');

                // Restart the Origin child process and verify durable SQLite nonce store still blocks replay!
                await originProc.shutdown();
                originProc = await spawnOriginDaemon();
                const replayAfterRestartRes = await originProc.callOrigin(workerDaemonIdRaw, {
                    meshId,
                    artifactId: originDoc1.artifactId,
                    requesterSessionId: 'sess-worker-two-proc',
                    requesterTaskId: 'task-two-proc-1',
                    requesterAttemptId: 'att-two-proc-1',
                    requesterRole: 'worker',
                    originFetchGrant: validGrant,
                    mode: 'read',
                    asChunks: true,
                });
                expect(replayAfterRestartRes.success).toBe(false);
                expect(replayAfterRestartRes.code).toBe('artifact_access_denied');
                expect(replayAfterRestartRes.error).toContain('replayed_grant_nonce');
            } finally {
                workerMeshStore.close();
            }
        } finally {
            await originProc.shutdown();
        }
    });

    it('Residual: artifact_register and session_artifact_register refuse files containing base64-encoded or percent-encoded mcp_sess_* tokens under neutral keys', async () => {
        hostSessionRegistry.register({
            sessionId: 'sess-residual-scan',
            parentSessionId: null,
            providerType: 'claude-cli',
            transport: 'pty',
            workspace: hostWorkspace,
        });

        const rawBearer = 'mcp_sess_0123456789abcdef0123456789abcdef';
        const base64Bearer = Buffer.from(rawBearer, 'utf8').toString('base64');
        const percentBearer = 'mcp%5Fsess%5F0123456789abcdef0123456789abcdef';

        fs.writeFileSync(
            path.join(hostWorkspace, 'encoded-b64.json'),
            JSON.stringify({ note: 'harmless looking payload', data: base64Bearer }) + '\n',
            'utf8',
        );
        fs.writeFileSync(
            path.join(hostWorkspace, 'encoded-pct.txt'),
            `harmlessQuery=${percentBearer}\n`,
            'utf8',
        );

        for (const regAlias of ['artifact_register', 'session_artifact_register'] as const) {
            const b64Res = await artifactHandlers[regAlias](hostCtx, {
                sessionId: 'sess-residual-scan',
                path: 'encoded-b64.json',
            });
            expect(b64Res.success, `${regAlias} base64`).toBe(false);
            expect(b64Res.code).toBe('secret_file_refused');

            const pctRes = await artifactHandlers[regAlias](hostCtx, {
                sessionId: 'sess-residual-scan',
                path: 'encoded-pct.txt',
            });
            expect(pctRes.success, `${regAlias} percent-encoded`).toBe(false);
            expect(pctRes.code).toBe('secret_file_refused');
        }
    });
});
