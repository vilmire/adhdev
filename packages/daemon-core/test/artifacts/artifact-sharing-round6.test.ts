import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import {
    __resetOriginGrantStateForTest,
    MAX_TRACKED_NONCES,
    getHostOriginGrantPublicKey,
    mintArtifactOriginFetchGrant,
    resolveTrustedHostOriginGrantPublicKey,
    rotateHostOriginGrantKeyPair,
    verifyArtifactOriginFetchGrant,
} from '../../src/commands/med-family/artifact-origin-grant.js';
import {
    artifactHandlers,
    setArtifactCommandRuntimeForDeps,
    type ArtifactCommandContext,
} from '../../src/commands/med-family/artifacts.js';
import {
    handleGetChatDebugBundle,
    sanitizeDebugBundleValue,
} from '../../src/commands/chat-commands-debug-bundle.js';
import {
    attachTrustedOwnerIngressProof,
    issueTrustedOwnerIngressProof,
} from '../../src/commands/command-args.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { getCommandLogPath, getRecentCommands } from '../../src/logging/command-log.js';
import {
    containsEncodedOrRawSecret,
    redactCredentialString,
} from '../../src/logging/credential-redactor.js';
import {
    clearDebugTrace,
    configureDebugTraceStore,
    getRecentDebugTrace,
    recordDebugTrace,
} from '../../src/logging/debug-trace.js';
import { writeMeshHostRecord } from '../../src/mesh/mesh-host-memory.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    performMeshHandshake,
    type WebSocketLike,
} from '../../src/mesh/transport/mesh-peer-handshake.js';
import { mintPeerSecret, putPeerSecret } from '../../src/mesh/transport/mesh-peer-secrets.js';
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
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';

class FakeHandshakeSocket extends EventEmitter implements WebSocketLike {
    readyState = 1;
    peer: FakeHandshakeSocket | null = null;
    sent: string[] = [];
    closed: { code?: number; reason?: string } | null = null;
    send(data: string): void {
        this.sent.push(data);
        const peer = this.peer;
        if (peer) queueMicrotask(() => peer.emit('message', Buffer.from(data, 'utf8')));
    }
    close(code?: number, reason?: string): void {
        if (this.closed) return;
        this.closed = { code, reason };
        this.readyState = 3;
    }
}

function createConnectedSocketPair(): [FakeHandshakeSocket, FakeHandshakeSocket] {
    const a = new FakeHandshakeSocket();
    const b = new FakeHandshakeSocket();
    a.peer = b;
    b.peer = a;
    return [a, b];
}

describe('Artifact Sharing Round 6 Regressions (Codex Review 0b85b014)', () => {
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
    let prevSessionCred: string | undefined;
    let prevTraceEnabled: string | undefined;
    let prevTraceContent: string | undefined;

    function seedHostAttempt(
        store: MeshRuntimeStore,
        overrides: Parameters<typeof seedMeshAttempt>[0] & { ownerDaemonId?: string },
    ) {
        const seeded = seedMeshAttempt({
            ...overrides,
            nodeId: overrides.nodeId ?? 'node-worker-r6',
        });
        const record = {
            ...seeded,
            ownerDaemonId: overrides.ownerDaemonId ?? 'daemon_mach_host_r6',
        };
        store.turnStore().upsertAttempt(record, Date.now());
        return record;
    }

    beforeEach(() => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        prevSessionCred = process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
        prevTraceEnabled = process.env.ADHDEV_DEBUG_TRACE;
        prevTraceContent = process.env.ADHDEV_DEBUG_TRACE_CONTENT;

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-artifact-r6-'));
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
            daemonId: () => 'daemon_mach_host_r6',
            writerId: () => 'writer-r6',
            epoch: 'epoch-r6',
            appendChatFrame: async () => {},
            readPersistedChat: () => null,
        });

        hostDeps = {
            commandHandler: {
                handle: async () => ({ success: true }),
                rejectUnknown: async () => ({ success: false, error: 'Unknown command' }),
            } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { getInstance: () => undefined, listInstanceIds: () => [] } as any,
            detectedIdes: { value: [] },
            sessionRegistry: hostSessionRegistry,
            statusInstanceId: 'daemon_mach_host_r6',
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
        clearDebugTrace();
        __resetTranscriptProjectionForTests();
        __resetWorkerSessionBindsForTest();
        __resetWorkerTaskTokensForTest();
        __resetOriginGrantStateForTest();
        MeshRuntimeStore.resetForTests();

        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;

        if (prevSessionCred === undefined) delete process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
        else process.env.ADHDEV_MCP_SESSION_CREDENTIAL = prevSessionCred;

        if (prevTraceEnabled === undefined) delete process.env.ADHDEV_DEBUG_TRACE;
        else process.env.ADHDEV_DEBUG_TRACE = prevTraceEnabled;

        if (prevTraceContent === undefined) delete process.env.ADHDEV_DEBUG_TRACE_CONTENT;
        else process.env.ADHDEV_DEBUG_TRACE_CONTENT = prevTraceContent;

        configureDebugTraceStore();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('Finding 1 (HIGH): blocks host signing-key injection via get_mesh inlineMesh from WS and authenticated non-host members across two processes, ignores stale synced keys, and allows authenticated key rotation', async () => {
        const meshId = 'mesh-r6-spki-pin';
        const hostDaemonId = 'daemon_mach_11111111111111111111111111111111';
        const originDaemonId = 'daemon_mach_22222222222222222222222222222222';
        const workerDaemonId = 'daemon_mach_33333333333333333333333333333333';

        const originConfigDir = path.join(tempRoot, 'origin-config');
        fs.mkdirSync(originConfigDir, { recursive: true });
        fs.writeFileSync(
            path.join(originWorkspace, 'origin-secret-spec.md'),
            '# Origin Confidential Spec\nMust never be served under an injected attacker key.\n',
            'utf8',
        );

        const realHostPublicKey = getHostOriginGrantPublicKey(hostDaemonId);

        // Generate an attacker Ed25519 keypair
        const attackerKeys = crypto.generateKeyPairSync('ed25519', {
            publicKeyEncoding: { type: 'spki', format: 'der' },
            privateKeyEncoding: { type: 'pkcs8', format: 'der' },
        });
        const attackerPublicKey = (attackerKeys.publicKey as Buffer).toString('base64url');
        const attackerPrivateKeyObj = crypto.createPrivateKey({
            key: attackerKeys.privateKey as Buffer,
            format: 'der',
            type: 'pkcs8',
        });

        function signGrantWithAttackerKey(fields: {
            meshId: string;
            hostDaemonId: string;
            originDaemonId: string;
            artifactId: string;
            requesterSessionId: string;
            requesterTaskId: string;
            requesterAttemptId: string;
            issuedAt: number;
            expiresAt: number;
            nonce: string;
        }) {
            const canonicalPayload = [
                fields.meshId,
                fields.hostDaemonId,
                fields.originDaemonId,
                fields.artifactId,
                fields.requesterSessionId,
                fields.requesterTaskId,
                fields.requesterAttemptId,
                String(fields.issuedAt),
                String(fields.expiresAt),
                fields.nonce,
            ].join('\0');
            const signature = crypto
                .sign(null, Buffer.from(canonicalPayload, 'utf8'), attackerPrivateKeyObj)
                .toString('base64url');
            return { ...fields, signature };
        }

        // 1) Stale synced key in meshObj.meshHost / meshObj.nodes is NEVER used
        const staleSyncedResolved = resolveTrustedHostOriginGrantPublicKey({
            meshObj: {
                id: meshId,
                meshHost: {
                    hostDaemonId,
                    originGrantPublicKey: attackerPublicKey,
                },
                nodes: [
                    {
                        id: 'node-host',
                        daemonId: hostDaemonId,
                        originGrantPublicKey: attackerPublicKey,
                    },
                ],
            },
            meshId,
            hostDaemonId,
            selfDaemonId: originDaemonId,
            isSelfHost: false,
        });
        expect(staleSyncedResolved).toBe('');

        // Spawn a separate Origin daemon process with real DaemonCommandRouter
        const distIndexUrl = new URL('../../dist/index.mjs', import.meta.url).href;
        const originRunnerPath = path.join(tempRoot, 'origin-r6-runner.mjs');
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
    writeMeshHostRecord,
    readAuthenticatedPeerOriginGrantPublicKey,
} from ${JSON.stringify(distIndexUrl)};

const workspace = process.env.TEST_ORIGIN_WORKSPACE;
const meshId = process.env.TEST_MESH_ID;
const hostDaemonId = process.env.TEST_HOST_DAEMON_ID;
const originDaemonId = process.env.TEST_ORIGIN_DAEMON_ID;
const workerDaemonId = process.env.TEST_WORKER_DAEMON_ID;
const hostPublicKey = process.env.TEST_HOST_PUBLIC_KEY;

// Pin the real host public key via authenticated pairing record
writeMeshHostRecord(meshId, hostDaemonId, 'pairing', hostPublicKey);

const sessionRegistry = new SessionRegistry();
sessionRegistry.register({
    sessionId: 'sess-origin-producer-r6',
    parentSessionId: null,
    providerType: 'claude-cli',
    transport: 'pty',
    workspace,
});

const initialInlineMesh = {
    id: meshId,
    meshHost: { hostDaemonId },
    nodes: [
        { id: 'node-host', daemonId: hostDaemonId, workspace },
        { id: 'node-origin', daemonId: originDaemonId, workspace },
        { id: 'node-worker', daemonId: workerDaemonId, workspace, activeSessionId: 'sess-worker-r6' },
    ],
};

const deps = {
    commandHandler: {
        handle: async () => ({ success: true }),
        rejectUnknown: async () => ({ success: false, error: 'Unknown command' }),
    },
    cliManager: {},
    cdpManagers: new Map(),
    providerLoader: {},
    instanceManager: { getInstance: () => undefined, listInstanceIds: () => [] },
    detectedIdes: { value: [] },
    sessionRegistry,
    statusInstanceId: originDaemonId,
};
const router = new DaemonCommandRouter(deps);
router.inlineMeshCache.set(meshId, initialInlineMesh);

const ownerProof = issueTrustedOwnerIngressProof({
    source: 'standalone',
    ownerVerified: true,
    verifyCurrent: () => true,
});

const reg = await router.execute(
    'artifact_register',
    attachTrustedOwnerIngressProof(
        {
            sessionId: 'sess-origin-producer-r6',
            meshId,
            missionId: 'mission-r6',
            path: 'origin-secret-spec.md',
            title: 'Origin Secret Spec',
        },
        ownerProof,
    ),
    'standalone',
    { ownerVerified: true, ownerProof },
);
const doc = { ...reg.artifact, meshId, missionId: 'mission-r6', originDaemonId };
process.stdout.write('__RPC__:' + JSON.stringify({ ready: true, pid: process.pid, doc }) + '\\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
        const msg = JSON.parse(line);
        if (msg.cmd === 'shutdown') {
            process.stdout.write('__RPC__:' + JSON.stringify({ id: msg.id, result: { shutDown: true } }) + '\\n');
            process.exit(0);
        }
        if (msg.cmd === 'inspect_cache') {
            const cached = router.inlineMeshCache.get(meshId);
            const pinned = readAuthenticatedPeerOriginGrantPublicKey(meshId, hostDaemonId);
            process.stdout.write('__RPC__:' + JSON.stringify({ id: msg.id, result: { cached, pinned } }) + '\\n');
            return;
        }
        const args = { ...msg.payload };
        if (msg.senderDaemonId) {
            args[MESH_SENDER_DAEMON_ID_ARG] = msg.senderDaemonId;
        }
        const res = await router.execute(msg.cmd, args, msg.source || 'mesh');
        process.stdout.write('__RPC__:' + JSON.stringify({ id: msg.id, result: res }) + '\\n');
    } catch (err) {
        process.stdout.write('__RPC__:' + JSON.stringify({ id: 0, error: String(err) }) + '\\n');
    }
});
`,
            'utf8',
        );

        const child = childProcess.spawn(process.execPath, [originRunnerPath], {
            env: {
                ...process.env,
                ADHDEV_CONFIG_DIR: originConfigDir,
                TEST_ORIGIN_WORKSPACE: originWorkspace,
                TEST_MESH_ID: meshId,
                TEST_HOST_DAEMON_ID: hostDaemonId,
                TEST_ORIGIN_DAEMON_ID: originDaemonId,
                TEST_WORKER_DAEMON_ID: workerDaemonId,
                TEST_HOST_PUBLIC_KEY: realHostPublicKey,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        const pending = new Map<number, (val: any) => void>();
        let readyInfo: any;
        const readyPromise = new Promise<any>((resolve, reject) => {
            let isFirst = true;
            child.on('exit', (code) => {
                if (isFirst) reject(new Error(`Origin child exited early with code ${code}`));
            });
            rl.on('line', (line) => {
                if (!line.startsWith('__RPC__:')) return;
                const parsed = JSON.parse(line.slice('__RPC__:'.length));
                if (isFirst && parsed.ready) {
                    isFirst = false;
                    resolve(parsed);
                    return;
                }
                const cb = pending.get(parsed.id);
                if (cb) {
                    pending.delete(parsed.id);
                    cb(parsed.result);
                }
            });
        });

        let nextRpcId = 1;
        const callChild = (
            cmd: string,
            payload: Record<string, unknown>,
            opts?: { source?: string; senderDaemonId?: string },
        ): Promise<any> => {
            const id = nextRpcId++;
            return new Promise((resolve) => {
                pending.set(id, resolve);
                child.stdin.write(
                    JSON.stringify({
                        id,
                        cmd,
                        payload,
                        source: opts?.source,
                        senderDaemonId: opts?.senderDaemonId,
                    }) + '\n',
                );
            });
        };

        try {
            readyInfo = await readyPromise;
            const originDoc = readyInfo.doc;
            const nowMs = Date.now();

            // 2) Before injection: attacker-signed grant for nonexistent task/attempt is DENIED
            const forgedGrantBefore = signGrantWithAttackerKey({
                meshId,
                hostDaemonId,
                originDaemonId,
                artifactId: originDoc.artifactId,
                requesterSessionId: 'sess-worker-r6',
                requesterTaskId: 'task-nonexistent-1',
                requesterAttemptId: 'att-nonexistent-1',
                issuedAt: nowMs,
                expiresAt: nowMs + 60_000,
                nonce: crypto.randomBytes(16).toString('hex'),
            });
            const deniedBefore = await callChild(
                'artifact_fetch_origin',
                {
                    meshId,
                    artifactId: originDoc.artifactId,
                    requesterSessionId: 'sess-worker-r6',
                    requesterTaskId: 'task-nonexistent-1',
                    requesterAttemptId: 'att-nonexistent-1',
                    requesterRole: 'worker',
                    originFetchGrant: forgedGrantBefore,
                    mode: 'read',
                    asChunks: true,
                },
                { source: 'mesh', senderDaemonId: workerDaemonId },
            );
            expect(deniedBefore.success).toBe(false);
            expect(deniedBefore.code).toBe('artifact_access_denied');
            expect(deniedBefore.chunks).toBeUndefined();

            // 3) Attempt SPKI injection via get_mesh inlineMesh from server WS ('ws')
            //    with transient node fields (health, lastSeenAt) to trigger reconcileInlineMeshCache
            const poisonedInlineMesh = {
                id: meshId,
                updatedAt: new Date(Date.now() + 10_000).toISOString(),
                meshHost: {
                    hostDaemonId,
                    originGrantPublicKey: attackerPublicKey,
                },
                nodes: [
                    {
                        id: 'node-host',
                        daemonId: hostDaemonId,
                        workspace: originWorkspace,
                        originGrantPublicKey: attackerPublicKey,
                        health: 'healthy',
                        lastSeenAt: new Date().toISOString(),
                    },
                    { id: 'node-origin', daemonId: originDaemonId, workspace: originWorkspace },
                    {
                        id: 'node-worker',
                        daemonId: workerDaemonId,
                        workspace: originWorkspace,
                        activeSessionId: 'sess-worker-r6',
                    },
                ],
            };
            const wsInjectRes = await callChild(
                'get_mesh',
                { meshId, inlineMesh: poisonedInlineMesh, membershipOnly: true },
                { source: 'ws' },
            );
            expect(wsInjectRes.success).toBe(true);

            // 4) Attempt SPKI injection via get_mesh inlineMesh from an authenticated non-host remote member ('mesh')
            const memberInjectRes = await callChild(
                'get_mesh',
                { meshId, inlineMesh: poisonedInlineMesh, membershipOnly: true },
                { source: 'mesh', senderDaemonId: workerDaemonId },
            );
            expect(memberInjectRes.success).toBe(true);

            // Verify the cache stripped originGrantPublicKey and pinned key remained realHostPublicKey
            const cacheInspection = await callChild('inspect_cache', {});
            expect(cacheInspection.pinned).toBe(realHostPublicKey);
            expect(cacheInspection.cached?.meshHost?.originGrantPublicKey).toBeUndefined();
            for (const n of cacheInspection.cached?.nodes ?? []) {
                expect(n.originGrantPublicKey).toBeUndefined();
            }

            // 5) After BOTH injection attempts: attacker-signed grant MUST STILL BE DENIED
            const forgedGrantAfter = signGrantWithAttackerKey({
                meshId,
                hostDaemonId,
                originDaemonId,
                artifactId: originDoc.artifactId,
                requesterSessionId: 'sess-worker-r6',
                requesterTaskId: 'task-nonexistent-2',
                requesterAttemptId: 'att-nonexistent-2',
                issuedAt: nowMs,
                expiresAt: nowMs + 60_000,
                nonce: crypto.randomBytes(16).toString('hex'),
            });
            const deniedAfter = await callChild(
                'artifact_fetch_origin',
                {
                    meshId,
                    artifactId: originDoc.artifactId,
                    requesterSessionId: 'sess-worker-r6',
                    requesterTaskId: 'task-nonexistent-2',
                    requesterAttemptId: 'att-nonexistent-2',
                    requesterRole: 'worker',
                    originFetchGrant: forgedGrantAfter,
                    mode: 'read',
                    asChunks: true,
                },
                { source: 'mesh', senderDaemonId: workerDaemonId },
            );
            expect(deniedAfter.success).toBe(false);
            expect(deniedAfter.code).toBe('artifact_access_denied');
            expect(deniedAfter.chunks).toBeUndefined();

            // 6) Legitimate key rotation:
            //    Mint a pre-rotation grant with the old key (do not consume it yet).
            const preRotationGrant = mintArtifactOriginFetchGrant({
                meshId,
                hostDaemonId,
                originDaemonId,
                artifactId: originDoc.artifactId,
                requesterSessionId: 'sess-worker-r6',
                requesterTaskId: 'task-legit-r6',
                requesterAttemptId: 'att-legit-r6',
                nowMs,
            });

            //    Rotate the host's keypair on the Host side.
            const rotated = rotateHostOriginGrantKeyPair(hostDaemonId);
            expect(rotated.previousPublicKey).toBe(realHostPublicKey);
            expect(rotated.publicKey).not.toBe(realHostPublicKey);
            //    Process key cache must NOT keep the superseded key!
            expect(getHostOriginGrantPublicKey(hostDaemonId)).toBe(rotated.publicKey);

            //    Mint a grant with the rotated key (carries signed keyRotation proof from old key -> new key).
            const postRotationGrant = mintArtifactOriginFetchGrant({
                meshId,
                hostDaemonId,
                originDaemonId,
                artifactId: originDoc.artifactId,
                requesterSessionId: 'sess-worker-r6',
                requesterTaskId: 'task-legit-r6',
                requesterAttemptId: 'att-legit-r6',
                nowMs,
            });
            expect(postRotationGrant.keyRotation).toBeDefined();

            const rotatedFetchRes = await callChild(
                'artifact_fetch_origin',
                {
                    meshId,
                    artifactId: originDoc.artifactId,
                    requesterSessionId: 'sess-worker-r6',
                    requesterTaskId: 'task-legit-r6',
                    requesterAttemptId: 'att-legit-r6',
                    requesterRole: 'worker',
                    originFetchGrant: postRotationGrant,
                    mode: 'read',
                    asChunks: true,
                },
                { source: 'mesh', senderDaemonId: workerDaemonId },
            );
            expect(rotatedFetchRes.success).toBe(true);
            const fetchedText = Buffer.concat(
                (rotatedFetchRes.chunks as string[]).map((c) => Buffer.from(c, 'base64')),
            ).toString('utf8');
            expect(fetchedText).toContain('# Origin Confidential Spec');

            //    Verify the Origin child process now pins the new key and REJECTS the unused pre-rotation grant!
            const afterRotationCache = await callChild('inspect_cache', {});
            expect(afterRotationCache.pinned).toBe(rotated.publicKey);

            const staleKeyFetchRes = await callChild(
                'artifact_fetch_origin',
                {
                    meshId,
                    artifactId: originDoc.artifactId,
                    requesterSessionId: 'sess-worker-r6',
                    requesterTaskId: 'task-legit-r6',
                    requesterAttemptId: 'att-legit-r6',
                    requesterRole: 'worker',
                    originFetchGrant: preRotationGrant,
                    mode: 'read',
                    asChunks: true,
                },
                { source: 'mesh', senderDaemonId: workerDaemonId },
            );
            expect(staleKeyFetchRes.success).toBe(false);
            expect(staleKeyFetchRes.code).toBe('artifact_access_denied');
        } finally {
            await callChild('shutdown', {}).catch(() => {});
            child.kill();
        }
    });

    it('Finding 1 + Lifecycle: WS performMeshHandshake supplies SPKI by default to rotate a stale cached key, and SQLite consumed-nonce table enforces an expiry index and row cap', async () => {
        const meshId = 'mesh-r6-ws-handshake';
        const hostId = 'daemon_mach_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const memberId = 'daemon_mach_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const secret = mintPeerSecret();

        const staleKey = rotateHostOriginGrantKeyPair(hostId).previousPublicKey;
        const freshHostKey = getHostOriginGrantKeyAfterSecondRotation(hostId);

        function getHostOriginGrantKeyAfterSecondRotation(id: string): string {
            rotateHostOriginGrantKeyPair(id);
            return getHostOriginGrantPublicKey(id);
        }

        // Seed stale key in both peer-secrets and mesh-host-records
        putPeerSecret({
            meshId,
            peerDaemonId: hostId,
            role: 'member',
            secret,
            originGrantPublicKey: staleKey,
            createdAt: new Date().toISOString(),
        });
        writeMeshHostRecord(meshId, hostId, 'pairing', staleKey);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId: hostId })).toBe(staleKey);

        // Run performMeshHandshake WITHOUT passing originGrantPublicKey in options:
        // deployed callers and default performMeshHandshake must supply freshHostKey automatically.
        const [clientSock, serverSock] = createConnectedSocketPair();
        const serverP = performMeshHandshake(serverSock, 'responder', {
            localDaemonId: hostId,
            resolveSecret: (m, d) => (m === meshId && d === memberId ? secret : null),
        });
        const clientP = performMeshHandshake(clientSock, 'initiator', {
            meshId,
            daemonId: memberId,
            serverDaemonIdExpected: hostId,
            secret,
        });
        await Promise.all([serverP, clientP]);

        // Fresh handshake key must win over stale cached key in memory and disk
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId: hostId })).toBe(freshHostKey);

        // Verify SQLite consumed_artifact_origin_grant_nonces expiry index and bounded row cap
        const nowMs = Date.now();
        const grant1 = mintArtifactOriginFetchGrant({
            meshId,
            hostDaemonId: hostId,
            originDaemonId: memberId,
            artifactId: 'art-nonce-cap-1',
            requesterSessionId: 'sess-nonce-1',
            requesterTaskId: 'task-nonce-1',
            requesterAttemptId: 'att-nonce-1',
            nowMs,
        });
        const verified1 = verifyArtifactOriginFetchGrant(
            grant1,
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: memberId,
                artifactId: 'art-nonce-cap-1',
                requesterSessionId: 'sess-nonce-1',
                requesterTaskId: 'task-nonce-1',
                requesterAttemptId: 'att-nonce-1',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(verified1.ok).toBe(true);

        const indexes = hostMeshStore.db
            .prepare(`PRAGMA index_list('consumed_artifact_origin_grant_nonces')`)
            .all() as Array<{ name?: string }>;
        expect(indexes.some((idx) => idx.name === 'idx_consumed_origin_grant_nonces_expires')).toBe(true);

        // Seed MAX_TRACKED_NONCES + 20 unexpired rows and 10 expired rows, then consume one more grant
        const insertStmt = hostMeshStore.db.prepare(
            `INSERT OR REPLACE INTO consumed_artifact_origin_grant_nonces (nonce, mesh_id, canonical_payload, expires_at)
             VALUES (?, ?, ?, ?)`,
        );
        hostMeshStore.db.exec('BEGIN');
        try {
            for (let i = 0; i < 10; i++) {
                insertStmt.run(`expired-${i}`, meshId, 'payload', nowMs - 1000 - i);
            }
            for (let i = 0; i < MAX_TRACKED_NONCES + 20; i++) {
                insertStmt.run(`unexpired-${i}`, meshId, 'payload', nowMs + 10_000 + i);
            }
            hostMeshStore.db.exec('COMMIT');
        } catch (e) {
            hostMeshStore.db.exec('ROLLBACK');
            throw e;
        }

        const grant2 = mintArtifactOriginFetchGrant({
            meshId,
            hostDaemonId: hostId,
            originDaemonId: memberId,
            artifactId: 'art-nonce-cap-2',
            requesterSessionId: 'sess-nonce-1',
            requesterTaskId: 'task-nonce-1',
            requesterAttemptId: 'att-nonce-1',
            nowMs,
        });
        const verified2 = verifyArtifactOriginFetchGrant(
            grant2,
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: memberId,
                artifactId: 'art-nonce-cap-2',
                requesterSessionId: 'sess-nonce-1',
                requesterTaskId: 'task-nonce-1',
                requesterAttemptId: 'att-nonce-1',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(verified2.ok).toBe(true);

        const countRow = hostMeshStore.db
            .prepare('SELECT COUNT(*) AS cnt FROM consumed_artifact_origin_grant_nonces')
            .get() as { cnt: number };
        expect(countRow.cnt).toBeLessThanOrEqual(MAX_TRACKED_NONCES);

        const expiredRemaining = hostMeshStore.db
            .prepare('SELECT COUNT(*) AS cnt FROM consumed_artifact_origin_grant_nonces WHERE expires_at <= ?')
            .get(nowMs) as { cnt: number };
        expect(expiredRemaining.cnt).toBe(0);
    });

    it('Finding 2 (MEDIUM): concurrent registration B updating the same path/id is NOT deleted when registration A receives a delayed host refusal', async () => {
        const meshId = 'mesh-r6-rollback-race';
        const taskId = 'task-r6-race';
        const attemptId = 'att-r6-race';
        const workerSessionId = 'sess-worker-r6-race';

        const fileAbsPath = path.join(workerWorkspace, 'race-output.md');
        fs.writeFileSync(fileAbsPath, '# Version A\nInitial pending content.\n', 'utf8');

        const nowIso = new Date().toISOString();
        hostMeshStore.insertQueueEntry({
            id: taskId,
            meshId,
            targetNodeId: 'node-worker-r6',
            assignedNodeId: 'node-worker-r6',
            status: 'assigned',
            assignedSessionId: workerSessionId,
            attemptId,
            message: 'Produce race-output.md',
            workspace: workerWorkspace,
            missionId: 'mission-r6-race',
            createdAt: nowIso,
            updatedAt: nowIso,
        } as any);
        seedHostAttempt(hostMeshStore, {
            attemptId,
            taskId,
            meshId,
            nodeId: 'node-worker-r6',
            sessionId: workerSessionId,
            attemptNo: 0,
            stage: 'generating',
            terminal: false,
        });

        const inlineMesh = {
            id: meshId,
            meshHost: { hostDaemonId: 'daemon_mach_host_r6' },
            nodes: [
                { id: 'node-host-r6', daemonId: 'daemon_mach_host_r6', workspace: hostWorkspace },
                {
                    id: 'node-worker-r6',
                    daemonId: 'daemon_mach_worker_r6',
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

        const workerMeshStore = new MeshRuntimeStore(path.join(tempRoot, 'worker-r6-race.db'));
        const workerArtifactStore = new ArtifactStore(workerMeshStore.db);
        const workerRegistry = new SessionRegistry();
        workerRegistry.register({
            sessionId: workerSessionId,
            parentSessionId: null,
            providerType: 'claude-cli',
            transport: 'pty',
            workspace: workerWorkspace,
        });
        const workerToken = mintWorkerTaskToken({
            meshId,
            taskId,
            sessionId: workerSessionId,
            nodeId: 'node-worker-r6',
            attemptId,
        });

        let resolveFirstForward!: (val: unknown) => void;
        let firstForwardEntered!: () => void;
        const firstForwardEnteredPromise = new Promise<void>((resolve) => {
            firstForwardEntered = resolve;
        });
        let forwardCallCount = 0;

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
                                      meshCoordinatorDaemonId: 'daemon_mach_host_r6',
                                      meshNodeId: 'node-worker-r6',
                                      meshActiveTaskId: taskId,
                                      meshTaskId: taskId,
                                      meshActiveAttemptId: attemptId,
                                      meshAttemptId: attemptId,
                                  },
                              }),
                          } as any)
                        : undefined,
            } as any,
            detectedIdes: { value: [] },
            sessionRegistry: workerRegistry,
            statusInstanceId: 'daemon_mach_worker_r6',
            dispatchMeshCommand: async (targetDaemonId: string, command: string, payload: Record<string, unknown>) => {
                if (targetDaemonId === 'daemon_mach_host_r6' && command === 'artifact_index_forwarded') {
                    forwardCallCount += 1;
                    if (forwardCallCount === 1) {
                        firstForwardEntered();
                        return await new Promise((resolve) => {
                            resolveFirstForward = resolve;
                        });
                    }
                    return artifactHandlers.artifact_index_forwarded(hostCtx, {
                        ...payload,
                        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_mach_worker_r6',
                    });
                }
                throw new Error(`Unexpected dispatch: ${targetDaemonId} ${command}`);
            },
        };
        setArtifactCommandRuntimeForDeps(workerDeps, {
            artifactStore: workerArtifactStore,
            meshRuntimeStore: workerMeshStore,
        });
        const workerRouter = new DaemonCommandRouter(workerDeps);
        workerRouter.inlineMeshCache.set(meshId, inlineMesh);

        try {
            // 1. Start registration A (isUpdate=false), which pauses at dispatchMeshCommand
            const regAPromise = workerRouter.execute(
                'artifact_register',
                {
                    token: workerToken.token,
                    attemptId,
                    path: 'race-output.md',
                    title: 'Race Title A',
                },
                'ipc',
            );
            await firstForwardEnteredPromise;

            // 2. While A is waiting on the host, B updates the same file/path, forwards to host, and publishes
            fs.writeFileSync(fileAbsPath, '# Version B\nUpdated committed content.\n', 'utf8');
            const regBResult = await workerRouter.execute(
                'artifact_register',
                {
                    token: workerToken.token,
                    attemptId,
                    path: 'race-output.md',
                    title: 'Race Title B',
                },
                'ipc',
            );

            // 3. Now A's delayed host forward returns a refusal
            resolveFirstForward({
                success: false,
                code: 'forward_failed',
                error: 'Simulated delayed refusal for Call A',
            });
            const regAResult = await regAPromise;

            const artifactId = (regBResult.artifact as any)?.artifactId;
            const localRow = artifactId ? workerArtifactStore.getById(artifactId) : null;
            const hostRow = artifactId ? hostArtifactStore.getById(artifactId) : null;

            expect(regAResult.success).toBe(false);
            expect(regBResult.success).toBe(true);
            expect(localRow !== null, 'localStillExists must be true').toBe(true);
            expect(hostRow !== null, 'hostStillExists must be true').toBe(true);
            expect(localRow?.title).toBe('Race Title B');
            expect(localRow?.sha256).toBe(hostRow?.sha256);
        } finally {
            workerMeshStore.close();
        }
    });

    it('Finding 3 (MEDIUM): recursively decodes and redacts/refuses double-base64, percent(base64), base64(percent), 4-layer mixed encodings, and split tokens across router _diagnostic command logs, traceContent=true traces, inline & daemon_file debug bundles, and artifact_register', async () => {
        const liveBearer = 'mcp_sess_LiveRound6SecretCredentialToken987654321';
        process.env.ADHDEV_MCP_SESSION_CREDENTIAL = liveBearer;
        process.env.ADHDEV_DEBUG_TRACE = 'true';
        process.env.ADHDEV_DEBUG_TRACE_CONTENT = 'true';
        configureDebugTraceStore();

        const singleB64 = Buffer.from(liveBearer, 'utf8').toString('base64');
        const doubleB64 = Buffer.from(singleB64, 'utf8').toString('base64');
        const percentOfB64 = Array.from(Buffer.from(singleB64, 'utf8'))
            .map((b) => `%${b.toString(16).padStart(2, '0')}`)
            .join('');
        const percentOfRaw = Array.from(Buffer.from(liveBearer, 'utf8'))
            .map((b) => `%${b.toString(16).padStart(2, '0')}`)
            .join('');
        const b64OfPercent = Buffer.from(percentOfRaw, 'utf8').toString('base64');
        const fourLayerMixed = Buffer.from(
            encodeURIComponent(Buffer.from(percentOfRaw, 'utf8').toString('base64url')),
            'utf8',
        ).toString('base64');
        const splitRaw = `${liveBearer.slice(0, 12)}" + "${liveBearer.slice(12)}`;
        const splitB64 = `${singleB64.slice(0, 14)}\n${singleB64.slice(14)}`;

        const encodedPayloads = {
            doubleB64,
            percentOfB64,
            b64OfPercent,
            fourLayerMixed,
            splitRaw,
            splitB64,
        };

        for (const [label, payload] of Object.entries(encodedPayloads)) {
            expect(containsEncodedOrRawSecret(payload), `containsEncodedOrRawSecret(${label})`).toBe(true);
            const redacted = redactCredentialString(`prefix ${payload} suffix`);
            expect(redacted, `redactCredentialString(${label})`).not.toContain(payload);
            expect(redacted, `redactCredentialString(${label}) raw`).not.toContain(liveBearer);
            expect(redacted, `redactCredentialString(${label}) singleB64`).not.toContain(singleB64);
        }

        // 1) Real-router _diagnostic command history and disk logs
        const router = new DaemonCommandRouter(hostDeps);
        await router.execute(
            'get_mesh',
            {
                meshId: 'mesh-nonexistent',
                _diagnostic: {
                    doubleB64,
                    percentOfB64,
                    b64OfPercent,
                    fourLayerMixed,
                    splitRaw,
                    splitB64,
                },
            },
            'ws',
        );

        const recentCommands = JSON.stringify(getRecentCommands(20));
        const diskLogContent = fs.existsSync(getCommandLogPath())
            ? fs.readFileSync(getCommandLogPath(), 'utf8')
            : '';
        for (const [label, payload] of Object.entries(encodedPayloads)) {
            const singleLinePayload = payload.replace(/\n/g, '\\n');
            expect(recentCommands, `recentCommands must not leak ${label}`).not.toContain(singleLinePayload);
            expect(diskLogContent, `diskLogContent must not leak ${label}`).not.toContain(singleLinePayload);
        }
        expect(recentCommands).not.toContain(liveBearer);
        expect(diskLogContent).not.toContain(liveBearer);

        // 2) traceContent=true debug traces
        recordDebugTrace({
            interactionId: 'ix-r6-trace',
            category: 'command',
            stage: 'diagnostic_check',
            level: 'info',
            payload: {
                _diagnostic: { ...encodedPayloads },
                nestedNote: `diag=${doubleB64} pct=${percentOfB64} b64pct=${b64OfPercent}`,
            },
        });
        const tracesJson = JSON.stringify(getRecentDebugTrace({ interactionId: 'ix-r6-trace' }));
        for (const [label, payload] of Object.entries(encodedPayloads)) {
            const singleLinePayload = payload.replace(/\n/g, '\\n');
            expect(tracesJson, `debugTrace must not leak ${label}`).not.toContain(singleLinePayload);
        }
        expect(tracesJson).not.toContain(liveBearer);
        expect(tracesJson).not.toContain(singleB64);

        // 3) inline and daemon_file debug bundles
        const fakeHelpers: any = {
            currentSession: { sessionId: 'sess-debug-r6', workspace: '/Users/me/project' },
            currentProviderType: 'claude',
            currentManagerKey: 'cli:claude',
            currentIdeType: 'claude',
            agentStream: null,
            getProvider: () => undefined,
            getCliAdapter: () => null,
            getCdp: () => null,
            ctx: {
                sessionRegistry: { get: () => null },
                instanceManager: { getInstance: () => null },
            },
            historyWriter: { appendNewMessages: () => {} },
            evaluateProviderScript: () => null,
            getProviderScript: () => null,
        };
        const inlineBundleRes = await handleGetChatDebugBundle(fakeHelpers, {
            targetSessionId: 'sess-debug-r6',
            frontendSnapshot: {
                _diagnostic: { ...encodedPayloads },
            },
        });
        expect(inlineBundleRes.success).toBe(true);
        const inlineBundleJson = JSON.stringify(inlineBundleRes);
        for (const [label, payload] of Object.entries(encodedPayloads)) {
            const singleLinePayload = payload.replace(/\n/g, '\\n');
            expect(inlineBundleJson, `inline debug bundle must not leak ${label}`).not.toContain(singleLinePayload);
        }

        const fileBundleRes = await handleGetChatDebugBundle(fakeHelpers, {
            targetSessionId: 'sess-debug-r6',
            delivery: 'daemon_file',
            frontendSnapshot: {
                _diagnostic: { ...encodedPayloads },
            },
        });
        expect(fileBundleRes.success).toBe(true);
        const savedBundleDisk = fs.readFileSync((fileBundleRes as any).savedPath, 'utf8');
        for (const [label, payload] of Object.entries(encodedPayloads)) {
            const singleLinePayload = payload.replace(/\n/g, '\\n');
            expect(savedBundleDisk, `daemon_file debug bundle must not leak ${label}`).not.toContain(
                singleLinePayload,
            );
        }
        expect(sanitizeDebugBundleValue({ _diagnostic: encodedPayloads })).toBeDefined();

        // 4) artifact_register under neutral keys refuses all composed encodings
        hostSessionRegistry.register({
            sessionId: 'sess-r6-secret-guard',
            parentSessionId: null,
            providerType: 'claude-cli',
            transport: 'pty',
            workspace: hostWorkspace,
        });
        const ownerProof = issueTrustedOwnerIngressProof({
            source: 'standalone',
            ownerVerified: true,
            verifyCurrent: () => true,
        });
        for (const [label, payload] of Object.entries(encodedPayloads)) {
            const relFile = `neutral-${label}.json`;
            fs.writeFileSync(
                path.join(hostWorkspace, relFile),
                JSON.stringify({ status: 'ok', diagnosticNote: payload }, null, 2),
                'utf8',
            );
            const regRes = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r6-secret-guard',
                        path: relFile,
                        title: `Check ${label}`,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(regRes.success, `artifact_register must refuse ${label}`).toBe(false);
            expect(regRes.code, `artifact_register code for ${label}`).toBe('secret_file_refused');
        }

        // 5) Bounded cost / anti-DoS verification
        const noisyInput = Array.from({ length: 300 }, (_, i) => `segment_${i}_` + 'A'.repeat(64)).join(' ');
        const startMs = Date.now();
        expect(containsEncodedOrRawSecret(noisyInput)).toBe(false);
        expect(Date.now() - startMs).toBeLessThan(200);
    });
});
