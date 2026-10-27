import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import {
    __resetOriginGrantStateForTest,
    MAX_TRACKED_NONCES,
    canonGrantDaemonId,
    getHostOriginGrantPublicKey,
    mintArtifactOriginFetchGrant,
    resolveTrustedHostOriginGrantPublicKey,
    rotateHostOriginGrantKeyPair,
    verifyArtifactOriginFetchGrant,
} from '../../src/commands/med-family/artifact-origin-grant.js';
import {
    setArtifactCommandRuntimeForDeps,
} from '../../src/commands/med-family/artifacts.js';
import {
    handleGetChatDebugBundle,
    sanitizeDebugBundleValue,
} from '../../src/commands/chat-commands-debug-bundle.js';
import {
    attachTrustedOwnerIngressProof,
    issueTrustedOwnerIngressProof,
} from '../../src/commands/command-args.js';
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
import { LOG } from '../../src/logging/logger.js';
import {
    readAuthenticatedPeerOriginGrantPublicKey,
    readMeshHostRecord,
    recordAuthenticatedPeerOriginGrantPublicKey,
    writeMeshHostRecord,
} from '../../src/mesh/mesh-host-memory.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    MeshHandshakeError,
    performMeshHandshake,
    type WebSocketLike,
} from '../../src/mesh/transport/mesh-peer-handshake.js';
import {
    getPeerSecret,
    mintPeerSecret,
    putPeerSecret,
} from '../../src/mesh/transport/mesh-peer-secrets.js';
import {
    __resetWorkerSessionBindsForTest,
    __resetWorkerTaskTokensForTest,
} from '../../src/mesh/worker-mcp-isolation.js';
import {
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
} from '../../src/seqscribe/transcript-publisher.js';
import { SessionRegistry } from '../../src/sessions/registry.js';

class ProxyHandshakeSocket extends EventEmitter implements WebSocketLike {
    readyState = 1;
    peer: ProxyHandshakeSocket | null = null;
    transformOutbound?: (frame: Record<string, unknown>) => Record<string, unknown>;
    sent: string[] = [];
    closed: { code?: number; reason?: string } | null = null;
    send(data: string): void {
        let out = data;
        if (this.transformOutbound) {
            try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                out = JSON.stringify(this.transformOutbound(parsed));
            } catch {
                out = data;
            }
        }
        this.sent.push(out);
        const peer = this.peer;
        if (peer) queueMicrotask(() => peer.emit('message', Buffer.from(out, 'utf8')));
    }
    close(code?: number, reason?: string): void {
        if (this.closed) return;
        this.closed = { code, reason };
        this.readyState = 3;
    }
}

function createProxySocketPair(opts?: {
    rewriteServerToClient?: (frame: Record<string, unknown>) => Record<string, unknown>;
    rewriteClientToServer?: (frame: Record<string, unknown>) => Record<string, unknown>;
}): [ProxyHandshakeSocket, ProxyHandshakeSocket] {
    const client = new ProxyHandshakeSocket();
    const server = new ProxyHandshakeSocket();
    client.peer = server;
    server.peer = client;
    client.transformOutbound = opts?.rewriteClientToServer;
    server.transformOutbound = opts?.rewriteServerToClient;
    return [client, server];
}

function generateAttackerEd25519KeyPair(): { publicKey: string; privateKeyObj: crypto.KeyObject } {
    const generated = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const publicKey = (generated.publicKey as Buffer).toString('base64url');
    const privateKeyObj = crypto.createPrivateKey({
        key: generated.privateKey as Buffer,
        format: 'der',
        type: 'pkcs8',
    });
    return { publicKey, privateKeyObj };
}

function signForgedGrantWithKey(
    privateKeyObj: crypto.KeyObject,
    fields: {
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
    },
) {
    const canonical = [
        fields.meshId,
        canonGrantDaemonId(fields.hostDaemonId),
        canonGrantDaemonId(fields.originDaemonId),
        fields.artifactId,
        fields.requesterSessionId,
        fields.requesterTaskId,
        fields.requesterAttemptId,
        String(fields.issuedAt),
        String(fields.expiresAt),
        fields.nonce,
    ].join('\0');
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyObj).toString('base64url');
    return { ...fields, signature };
}

describe('Artifact Sharing Round 7 Regressions', () => {
    let tempRoot: string;
    let hostWorkspace: string;
    let hostMeshStore: MeshRuntimeStore;
    let hostArtifactStore: ArtifactStore;
    let hostSessionRegistry: SessionRegistry;
    let hostDeps: CommandRouterDeps;
    let prevConfigDir: string | undefined;
    let prevSessionCred: string | undefined;
    let prevTraceEnabled: string | undefined;
    let prevTraceContent: string | undefined;

    beforeEach(() => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        prevSessionCred = process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
        prevTraceEnabled = process.env.ADHDEV_DEBUG_TRACE;
        prevTraceContent = process.env.ADHDEV_DEBUG_TRACE_CONTENT;

        tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-artifact-round7-')));
        process.env.ADHDEV_CONFIG_DIR = path.join(tempRoot, 'config');
        fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true, mode: 0o700 });

        hostWorkspace = path.join(tempRoot, 'host-ws');
        fs.mkdirSync(hostWorkspace, { recursive: true });

        hostMeshStore = new MeshRuntimeStore(path.join(tempRoot, 'host-mesh.sqlite'));
        hostArtifactStore = new ArtifactStore(hostMeshStore.db);
        hostSessionRegistry = new SessionRegistry();

        __resetWorkerTaskTokensForTest();
        __resetWorkerSessionBindsForTest();
        __resetOriginGrantStateForTest();
        __resetTranscriptProjectionForTests();
        configureTranscriptProjection({ store: hostMeshStore, daemonId: 'daemon_mach_host_r7' });

        hostDeps = {
            sessionRegistry: hostSessionRegistry,
            statusInstanceId: 'daemon_mach_host_r7',
            instanceManager: {
                getInstance: () => undefined,
                listInstances: () => [],
            } as any,
            cliManager: {
                getSession: () => undefined,
                getSessionByConversationId: () => undefined,
            } as any,
        };

        setArtifactCommandRuntimeForDeps(hostDeps, {
            store: hostArtifactStore,
            meshStore: hostMeshStore,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        __resetWorkerTaskTokensForTest();
        __resetWorkerSessionBindsForTest();
        __resetOriginGrantStateForTest();
        __resetTranscriptProjectionForTests();
        clearDebugTrace();
        try {
            hostMeshStore.close();
        } catch {
            // ignore
        }
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        if (prevSessionCred === undefined) delete process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
        else process.env.ADHDEV_MCP_SESSION_CREDENTIAL = prevSessionCred;
        if (prevTraceEnabled === undefined) delete process.env.ADHDEV_DEBUG_TRACE;
        else process.env.ADHDEV_DEBUG_TRACE = prevTraceEnabled;
        if (prevTraceContent === undefined) delete process.env.ADHDEV_DEBUG_TRACE_CONTENT;
        else process.env.ADHDEV_DEBUG_TRACE_CONTENT = prevTraceContent;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('Finding A (HIGH): proxy rewrite of originGrantPublicKey in mesh_challenge and mesh_ok (or mesh_hello) fails the handshake and never overwrites any store', async () => {
        const meshId = 'mesh-r7-finding-a';
        const hostId = 'daemon_mach_11111111111111111111111111111111';
        const originId = 'daemon_mach_22222222222222222222222222222222';
        const secret = mintPeerSecret();

        const realHostKey = getHostOriginGrantPublicKey(hostId);
        const realOriginKey = getHostOriginGrantPublicKey(originId);
        const attacker = generateAttackerEd25519KeyPair();

        // Pin realHostKey across all 3 stores (cache, mesh-host-records.json, mesh-peer-secrets.json)
        putPeerSecret({
            meshId,
            peerDaemonId: hostId,
            role: 'member',
            secret,
            originGrantPublicKey: realHostKey,
            createdAt: new Date().toISOString(),
        });
        writeMeshHostRecord(meshId, hostId, 'pairing', realHostKey);
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBe(realHostKey);
        expect(readMeshHostRecord(meshId)?.originGrantPublicKey).toBe(realHostKey);
        expect(getPeerSecret(meshId, hostId)?.originGrantPublicKey).toBe(realHostKey);

        // 1) Reviewer probe on initiator side: proxy rewrites originGrantPublicKey in mesh_challenge and mesh_ok
        const [clientSock1, serverSock1] = createProxySocketPair({
            rewriteServerToClient: (frame) => {
                if (frame.kind === 'mesh_challenge' || frame.kind === 'mesh_ok') {
                    return { ...frame, originGrantPublicKey: attacker.publicKey };
                }
                return frame;
            },
        });
        const serverP1 = performMeshHandshake(serverSock1, 'responder', {
            localDaemonId: hostId,
            resolveSecret: (m, d) => (m === meshId && d === originId ? secret : null),
        }).catch((e) => e);
        const clientP1 = performMeshHandshake(clientSock1, 'initiator', {
            meshId,
            daemonId: originId,
            serverDaemonIdExpected: hostId,
            secret,
        }).catch((e) => e);
        const [serverRes1, clientRes1] = await Promise.all([serverP1, clientP1]);
        expect(clientRes1).toBeInstanceOf(MeshHandshakeError);
        expect((clientRes1 as MeshHandshakeError).code).toBe('bad_proof');
        expect(serverRes1).toBeInstanceOf(MeshHandshakeError);
        expect((serverRes1 as MeshHandshakeError).code).toBe('bad_proof');

        // Verify none of the 3 stores were overwritten
        const cacheOverwritten = readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId) !== realHostKey;
        const hostFileOverwritten = readMeshHostRecord(meshId)?.originGrantPublicKey !== realHostKey;
        const peerSecretOverwritten = getPeerSecret(meshId, hostId)?.originGrantPublicKey !== realHostKey;
        expect({ cacheOverwritten, hostFileOverwritten, peerSecretOverwritten }).toEqual({
            cacheOverwritten: false,
            hostFileOverwritten: false,
            peerSecretOverwritten: false,
        });

        // Verify attacker-signed grant for a nonexistent task/attempt is refused
        const nowMs = Date.now();
        const forgedGrant = signForgedGrantWithKey(attacker.privateKeyObj, {
            meshId,
            hostDaemonId: hostId,
            originDaemonId: originId,
            artifactId: 'art-r7-forged',
            requesterSessionId: 'sess-r7-nonexistent',
            requesterTaskId: 'task-r7-nonexistent',
            requesterAttemptId: 'att-r7-nonexistent',
            issuedAt: nowMs,
            expiresAt: nowMs + 60_000,
            nonce: crypto.randomBytes(16).toString('hex'),
        });
        const grantVerification = verifyArtifactOriginFetchGrant(
            forgedGrant,
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: 'art-r7-forged',
                requesterSessionId: 'sess-r7-nonexistent',
                requesterTaskId: 'task-r7-nonexistent',
                requesterAttemptId: 'att-r7-nonexistent',
            },
            nowMs,
        );
        expect(grantVerification).toEqual({ ok: false, reason: 'invalid_grant_signature' });

        // 2) Proxy rewrite of ONLY mesh_ok (leaving mesh_challenge untouched) also fails
        const [clientSock2, serverSock2] = createProxySocketPair({
            rewriteServerToClient: (frame) => {
                if (frame.kind === 'mesh_ok') {
                    return { ...frame, originGrantPublicKey: attacker.publicKey };
                }
                return frame;
            },
        });
        const serverP2 = performMeshHandshake(serverSock2, 'responder', {
            localDaemonId: hostId,
            resolveSecret: (m, d) => (m === meshId && d === originId ? secret : null),
        }).catch((e) => e);
        const clientP2 = performMeshHandshake(clientSock2, 'initiator', {
            meshId,
            daemonId: originId,
            serverDaemonIdExpected: hostId,
            secret,
        }).catch((e) => e);
        const [, clientRes2] = await Promise.all([serverP2, clientP2]);
        expect(clientRes2).toBeInstanceOf(MeshHandshakeError);
        expect((clientRes2 as MeshHandshakeError).code).toBe('bad_proof');
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBe(realHostKey);

        // 3) Proxy rewrite on responder side (rewriting originGrantPublicKey in mesh_hello)
        putPeerSecret({
            meshId,
            peerDaemonId: originId,
            role: 'host',
            secret,
            originGrantPublicKey: realOriginKey,
            createdAt: new Date().toISOString(),
        });
        const [clientSock3, serverSock3] = createProxySocketPair({
            rewriteClientToServer: (frame) => {
                if (frame.kind === 'mesh_hello') {
                    return { ...frame, originGrantPublicKey: attacker.publicKey };
                }
                return frame;
            },
        });
        const serverP3 = performMeshHandshake(serverSock3, 'responder', {
            localDaemonId: hostId,
            resolveSecret: (m, d) => (m === meshId && d === originId ? secret : null),
        }).catch((e) => e);
        const clientP3 = performMeshHandshake(clientSock3, 'initiator', {
            meshId,
            daemonId: originId,
            serverDaemonIdExpected: hostId,
            secret,
        }).catch((e) => e);
        const [serverRes3, clientRes3] = await Promise.all([serverP3, clientP3]);
        expect(clientRes3).toBeInstanceOf(MeshHandshakeError);
        expect(serverRes3).toBeInstanceOf(MeshHandshakeError);
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, originId)).toBe(realOriginKey);
        expect(getPeerSecret(meshId, originId)?.originGrantPublicKey).toBe(realOriginKey);
    });

    it('Finding A (HIGH): proxy rewrite when no pin exists fails the handshake, and unsigned or foreign-signed key changes are refused while legitimate rotation succeeds', async () => {
        const meshIdUnpinned = 'mesh-r7-unpinned';
        const hostId = 'daemon_mach_33333333333333333333333333333333';
        const originId = 'daemon_mach_44444444444444444444444444444444';
        const secret = mintPeerSecret();
        const attacker = generateAttackerEd25519KeyPair();

        // 1) Proxy rewrite when no pin exists -> handshake fails and no key is pinned
        const [clientUnpinned, serverUnpinned] = createProxySocketPair({
            rewriteServerToClient: (frame) => {
                if (frame.kind === 'mesh_challenge' || frame.kind === 'mesh_ok') {
                    return { ...frame, originGrantPublicKey: attacker.publicKey };
                }
                return frame;
            },
        });
        const serverP1 = performMeshHandshake(serverUnpinned, 'responder', {
            localDaemonId: hostId,
            resolveSecret: (m, d) => (m === meshIdUnpinned && d === originId ? secret : null),
        }).catch((e) => e);
        const clientP1 = performMeshHandshake(clientUnpinned, 'initiator', {
            meshId: meshIdUnpinned,
            daemonId: originId,
            serverDaemonIdExpected: hostId,
            secret,
        }).catch((e) => e);
        const [serverRes1, clientRes1] = await Promise.all([serverP1, clientP1]);
        expect(clientRes1).toBeInstanceOf(MeshHandshakeError);
        expect((clientRes1 as MeshHandshakeError).code).toBe('bad_proof');
        expect(serverRes1).toBeInstanceOf(MeshHandshakeError);
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshIdUnpinned, hostId)).toBeNull();
        expect(readMeshHostRecord(meshIdUnpinned)).toBeNull();

        // 2) Authentic first handshake with no prior pin succeeds and pins the real key
        const initialHostKey = getHostOriginGrantPublicKey(hostId);
        const [clientFirst, serverFirst] = createProxySocketPair();
        await Promise.all([
            performMeshHandshake(serverFirst, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshIdUnpinned && d === originId ? secret : null),
            }),
            performMeshHandshake(clientFirst, 'initiator', {
                meshId: meshIdUnpinned,
                daemonId: originId,
                serverDaemonIdExpected: hostId,
                secret,
            }),
        ]);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: meshIdUnpinned, hostDaemonId: hostId })).toBe(
            initialHostKey,
        );

        // 3) Unsigned key replacement (even with valid shared HMAC secret!) is refused and logs a warning without key material
        const warnSpy = vi.spyOn(LOG, 'warn');
        const [clientUnsigned, serverUnsigned] = createProxySocketPair();
        const serverUnsignedP = performMeshHandshake(serverUnsigned, 'responder', {
            localDaemonId: hostId,
            originGrantPublicKey: attacker.publicKey,
            resolveSecret: (m, d) => (m === meshIdUnpinned && d === originId ? secret : null),
        }).catch((e) => e);
        const clientUnsignedP = performMeshHandshake(clientUnsigned, 'initiator', {
            meshId: meshIdUnpinned,
            daemonId: originId,
            serverDaemonIdExpected: hostId,
            secret,
        }).catch((e) => e);
        const [serverUnsignedRes, clientUnsignedRes] = await Promise.all([serverUnsignedP, clientUnsignedP]);
        expect(clientUnsignedRes).toBeInstanceOf(MeshHandshakeError);
        expect((clientUnsignedRes as MeshHandshakeError).code).toBe('bad_proof');
        expect(serverUnsignedRes).toBeInstanceOf(MeshHandshakeError);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: meshIdUnpinned, hostDaemonId: hostId })).toBe(
            initialHostKey,
        );
        const warnMessages = warnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(warnMessages).toContain('Refused unverified origin-grant public key replacement');
        expect(warnMessages).not.toContain(initialHostKey);
        expect(warnMessages).not.toContain(attacker.publicKey);

        // 4) Foreign-signed rotation proof (signed by attacker's key instead of initialHostKey) is refused
        const foreignNonce = crypto.randomBytes(16).toString('hex');
        const foreignRotatedAt = Date.now();
        const foreignCanonical = [
            'origin_grant_key_rotation',
            canonGrantDaemonId(hostId),
            initialHostKey,
            attacker.publicKey,
            String(foreignRotatedAt),
            foreignNonce,
        ].join('\0');
        const foreignSig = crypto
            .sign(null, Buffer.from(foreignCanonical, 'utf8'), attacker.privateKeyObj)
            .toString('base64url');
        const foreignRotationProof = {
            hostDaemonId: hostId,
            oldPublicKey: initialHostKey,
            newPublicKey: attacker.publicKey,
            rotatedAt: foreignRotatedAt,
            nonce: foreignNonce,
            signature: foreignSig,
        };
        expect(
            recordAuthenticatedPeerOriginGrantPublicKey(meshIdUnpinned, hostId, attacker.publicKey, {
                rotationProof: foreignRotationProof,
            }),
        ).toBe(false);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: meshIdUnpinned, hostDaemonId: hostId })).toBe(
            initialHostKey,
        );

        // 5) Legitimate rotation signed by the currently pinned key is accepted
        const rotated = rotateHostOriginGrantKeyPair(hostId);
        expect(rotated.previousPublicKey).toBe(initialHostKey);
        const [clientRotated, serverRotated] = createProxySocketPair();
        await Promise.all([
            performMeshHandshake(serverRotated, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshIdUnpinned && d === originId ? secret : null),
            }),
            performMeshHandshake(clientRotated, 'initiator', {
                meshId: meshIdUnpinned,
                daemonId: originId,
                serverDaemonIdExpected: hostId,
                secret,
            }),
        ]);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: meshIdUnpinned, hostDaemonId: hostId })).toBe(
            rotated.publicKey,
        );
    });

    it('Finding B (MEDIUM): credential scanner limits fail CLOSED across artifact_register, command history/disk, traceContent=true, and debug bundle on all 4 reviewer probes', async () => {
        const liveBearer = 'mcp_sess_live_round7_secret_token_9988776655443322';
        process.env.ADHDEV_MCP_SESSION_CREDENTIAL = liveBearer;
        process.env.ADHDEV_DEBUG_TRACE = '1';
        process.env.ADHDEV_DEBUG_TRACE_CONTENT = '1';
        configureDebugTraceStore({ enabled: true, capacity: 100 });

        const singleB64Bearer = Buffer.from(liveBearer, 'utf8').toString('base64');
        const doubleB64Bearer = Buffer.from(singleB64Bearer, 'utf8').toString('base64');

        // Probe 1: 66,000 neutral chars followed by a live MCP bearer
        const neutralPadding = 'x'.repeat(66_000);
        const probe1 = `${neutralPadding} ${liveBearer}`;

        // Probe 2: the same 66,000-char padding followed by a double-base64 bearer
        const probe2 = `${neutralPadding} ${doubleB64Bearer}`;

        // Probe 3: a 17,388-char base64 run (13,000 spaces) containing a live bearer
        const thirteenThousandSpacesPlusBearer = ' '.repeat(13_000) + `mcp_sess_${'a'.repeat(32)}`;
        const probe3 = Buffer.from(thirteenThousandSpacesPlusBearer, 'utf8').toString('base64');
        expect(probe3.length).toBe(17_388);

        // Probe 4a: 64 harmless decodable base64 candidates followed by a double-base64 bearer
        const harmlessDecodable64 = Array.from({ length: 64 }, (_, i) =>
            Buffer.from(`harmless_candidate_item_${String(i).padStart(4, '0')}`, 'utf8').toString('base64'),
        ).join(' ');
        const probe4Decodable = `${harmlessDecodable64} ${doubleB64Bearer}`;

        // Probe 4b: 64 harmless non-decodable base64 candidates followed by a double-base64 bearer
        const harmlessRaw64 = Array.from({ length: 64 }, (_, i) => `candidate${String(i).padStart(2, '0')}AAAAAA`).join(
            ' ',
        );
        const probe4Raw = `${harmlessRaw64} ${doubleB64Bearer}`;

        const probes: Record<string, string> = {
            probe1_66k_plus_live_bearer: probe1,
            probe2_66k_plus_double_b64_bearer: probe2,
            probe3_17388_char_b64_run: probe3,
            probe4a_64_decodable_plus_double_b64: probe4Decodable,
            probe4b_64_raw_plus_double_b64: probe4Raw,
        };

        for (const [label, payload] of Object.entries(probes)) {
            expect(containsEncodedOrRawSecret(payload), `scanner must fail closed on ${label}`).toBe(true);
            const redacted = redactCredentialString(payload);
            expect(redacted, `redactCredentialString must not leak liveBearer for ${label}`).not.toContain(liveBearer);
            expect(redacted, `redactCredentialString must not leak doubleB64Bearer for ${label}`).not.toContain(
                doubleB64Bearer,
            );
            expect(redacted, `redactCredentialString must not leak probe3 run for ${label}`).not.toContain(probe3);
        }

        // 1) artifact_register refuses all 4 probes with secret_file_refused
        const router = new DaemonCommandRouter(hostDeps);
        hostSessionRegistry.register({
            sessionId: 'sess-r7-secret-guard',
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
        for (const [label, payload] of Object.entries(probes)) {
            const relFile = `${label}.txt`;
            fs.writeFileSync(path.join(hostWorkspace, relFile), payload, 'utf8');
            const regRes = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r7-secret-guard',
                        path: relFile,
                        title: `Probe ${label}`,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(regRes.success, `artifact_register must refuse ${label}`).toBe(false);
            expect(regRes.code, `artifact_register code for ${label}`).toBe('secret_file_refused');
        }

        // 2) Real-router _diagnostic command history and disk JSONL
        await router.execute(
            'get_mesh',
            {
                meshId: 'mesh-nonexistent',
                _diagnostic: { ...probes },
            },
            'ipc',
        );
        const recentHistoryJson = JSON.stringify(getRecentCommands(20));
        const diskLogJson = fs.existsSync(getCommandLogPath())
            ? fs.readFileSync(getCommandLogPath(), 'utf8')
            : '';
        expect(diskLogJson.length).toBeGreaterThan(0);
        for (const [label] of Object.entries(probes)) {
            expect(recentHistoryJson, `recentCommands must not leak liveBearer in ${label}`).not.toContain(liveBearer);
            expect(recentHistoryJson, `recentCommands must not leak doubleB64Bearer in ${label}`).not.toContain(
                doubleB64Bearer,
            );
            expect(recentHistoryJson, `recentCommands must not leak probe3 in ${label}`).not.toContain(probe3);
            expect(diskLogJson, `disk JSONL must not leak liveBearer in ${label}`).not.toContain(liveBearer);
            expect(diskLogJson, `disk JSONL must not leak doubleB64Bearer in ${label}`).not.toContain(doubleB64Bearer);
            expect(diskLogJson, `disk JSONL must not leak probe3 in ${label}`).not.toContain(probe3);
        }

        // 3) traceContent=true debug traces
        recordDebugTrace({
            interactionId: 'ix-r7-trace',
            category: 'command',
            stage: 'probe_check',
            level: 'info',
            payload: {
                _diagnostic: { ...probes },
            },
        });
        const tracesJson = JSON.stringify(getRecentDebugTrace({ interactionId: 'ix-r7-trace' }));
        expect(tracesJson).not.toContain(liveBearer);
        expect(tracesJson).not.toContain(doubleB64Bearer);
        expect(tracesJson).not.toContain(probe3);

        // 4) Debug bundle (inline, daemon_file, and sanitizeDebugBundleValue)
        const fakeHelpers: any = {
            currentSession: { sessionId: 'sess-debug-r7', workspace: '/Users/me/project' },
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
            targetSessionId: 'sess-debug-r7',
            frontendSnapshot: {
                _diagnostic: { ...probes },
            },
        });
        expect(inlineBundleRes.success).toBe(true);
        const inlineBundleJson = JSON.stringify(inlineBundleRes);
        expect(inlineBundleJson).not.toContain(liveBearer);
        expect(inlineBundleJson).not.toContain(doubleB64Bearer);
        expect(inlineBundleJson).not.toContain(probe3);

        const fileBundleRes = await handleGetChatDebugBundle(fakeHelpers, {
            targetSessionId: 'sess-debug-r7',
            delivery: 'daemon_file',
            frontendSnapshot: {
                _diagnostic: { ...probes },
            },
        });
        expect(fileBundleRes.success).toBe(true);
        const savedBundleDisk = fs.readFileSync((fileBundleRes as any).savedPath, 'utf8');
        expect(savedBundleDisk).not.toContain(liveBearer);
        expect(savedBundleDisk).not.toContain(doubleB64Bearer);
        expect(savedBundleDisk).not.toContain(probe3);

        const sanitizedHighLimit = JSON.stringify(
            sanitizeDebugBundleValue({ _diagnostic: { ...probes } }, { maxStringLength: 100_000 }),
        );
        expect(sanitizedHighLimit).not.toContain(liveBearer);
        expect(sanitizedHighLimit).not.toContain(doubleB64Bearer);
        expect(sanitizedHighLimit).not.toContain(probe3);
    });

    it('Finding C (MEDIUM): consuming 4,098 live grants at one timestamp never evicts unexpired nonces, refuses new grants at capacity, refuses replays in-process and after SQLite restart, and accepts again after expiry', () => {
        const meshId = 'mesh-r7-finding-c';
        const hostId = 'daemon_mach_55555555555555555555555555555555';
        const originId = 'daemon_mach_66666666666666666666666666666666';
        const hostPublicKey = getHostOriginGrantPublicKey(hostId);
        writeMeshHostRecord(meshId, hostId, 'pairing', hostPublicKey);

        const nowMs = 1_760_000_000_000;
        const totalProbes = MAX_TRACKED_NONCES + 2; // 4,098 grants
        const grants = Array.from({ length: totalProbes }, (_, idx) =>
            mintArtifactOriginFetchGrant({
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: `art-r7-cap-${idx + 1}`,
                requesterSessionId: 'sess-r7-cap',
                requesterTaskId: 'task-r7-cap',
                requesterAttemptId: 'att-r7-cap',
                nowMs,
                ttlMs: 60_000,
            }),
        );

        // Consume the first MAX_TRACKED_NONCES (4,096) live grants at nowMs
        for (let i = 0; i < MAX_TRACKED_NONCES; i++) {
            const res = verifyArtifactOriginFetchGrant(
                grants[i],
                {
                    meshId,
                    hostDaemonId: hostId,
                    originDaemonId: originId,
                    artifactId: `art-r7-cap-${i + 1}`,
                    requesterSessionId: 'sess-r7-cap',
                    requesterTaskId: 'task-r7-cap',
                    requesterAttemptId: 'att-r7-cap',
                    consumeNonce: true,
                    nonceStoreDb: hostMeshStore.db,
                },
                nowMs,
            );
            expect(res.ok).toBe(true);
        }

        // Grants #4,097 and #4,098 must be REFUSED with grant_capacity_exhausted (fail closed)
        const res4097 = verifyArtifactOriginFetchGrant(
            grants[MAX_TRACKED_NONCES],
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: `art-r7-cap-${MAX_TRACKED_NONCES + 1}`,
                requesterSessionId: 'sess-r7-cap',
                requesterTaskId: 'task-r7-cap',
                requesterAttemptId: 'att-r7-cap',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(res4097).toEqual({ ok: false, reason: 'grant_capacity_exhausted' });

        const res4098 = verifyArtifactOriginFetchGrant(
            grants[MAX_TRACKED_NONCES + 1],
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: `art-r7-cap-${MAX_TRACKED_NONCES + 2}`,
                requesterSessionId: 'sess-r7-cap',
                requesterTaskId: 'task-r7-cap',
                requesterAttemptId: 'att-r7-cap',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(res4098).toEqual({ ok: false, reason: 'grant_capacity_exhausted' });

        // Replaying #1 in-process is REFUSED with replayed_grant_nonce
        const replay1InProcess = verifyArtifactOriginFetchGrant(
            grants[0],
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: 'art-r7-cap-1',
                requesterSessionId: 'sess-r7-cap',
                requesterTaskId: 'task-r7-cap',
                requesterAttemptId: 'att-r7-cap',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(replay1InProcess).toEqual({ ok: false, reason: 'replayed_grant_nonce' });

        // Simulate daemon restart: close SQLite store, clear in-process nonce cache, reopen the same SQLite file
        const sqlitePath = path.join(tempRoot, 'host-mesh.sqlite');
        hostMeshStore.close();
        __resetOriginGrantStateForTest();
        writeMeshHostRecord(meshId, hostId, 'pairing', hostPublicKey);
        hostMeshStore = new MeshRuntimeStore(sqlitePath);

        // Replaying #1 and #2 after restart against the same SQLite file is REFUSED
        const replay1AfterRestart = verifyArtifactOriginFetchGrant(
            grants[0],
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: 'art-r7-cap-1',
                requesterSessionId: 'sess-r7-cap',
                requesterTaskId: 'task-r7-cap',
                requesterAttemptId: 'att-r7-cap',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(replay1AfterRestart).toEqual({ ok: false, reason: 'replayed_grant_nonce' });

        const replay2AfterRestart = verifyArtifactOriginFetchGrant(
            grants[1],
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: 'art-r7-cap-2',
                requesterSessionId: 'sess-r7-cap',
                requesterTaskId: 'task-r7-cap',
                requesterAttemptId: 'att-r7-cap',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(replay2AfterRestart).toEqual({ ok: false, reason: 'replayed_grant_nonce' });

        // Once the 4,096 rows expire, new grants are accepted again
        const afterExpiryMs = nowMs + 60_001;
        const freshGrantAfterExpiry = mintArtifactOriginFetchGrant({
            meshId,
            hostDaemonId: hostId,
            originDaemonId: originId,
            artifactId: 'art-r7-cap-after-expiry',
            requesterSessionId: 'sess-r7-cap',
            requesterTaskId: 'task-r7-cap',
            requesterAttemptId: 'att-r7-cap',
            nowMs: afterExpiryMs,
            ttlMs: 60_000,
        });
        const acceptedAfterExpiry = verifyArtifactOriginFetchGrant(
            freshGrantAfterExpiry,
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: 'art-r7-cap-after-expiry',
                requesterSessionId: 'sess-r7-cap',
                requesterTaskId: 'task-r7-cap',
                requesterAttemptId: 'att-r7-cap',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            afterExpiryMs,
        );
        expect(acceptedAfterExpiry.ok).toBe(true);
    });
});
