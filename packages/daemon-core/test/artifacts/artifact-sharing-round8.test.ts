import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, MAX_ARTIFACT_BYTES } from '../../src/artifacts/index.js';
import {
    __resetOriginGrantStateForTest,
    ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS,
    MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH,
    MAX_TRACKED_NONCES,
    canonGrantDaemonId,
    getHostKeyRotationChain,
    getHostOriginGrantPublicKey,
    mintArtifactOriginFetchGrant,
    originGrantPublicKeysEqual,
    resolveTrustedHostOriginGrantPublicKey,
    rotateHostOriginGrantKeyPair,
    verifyArtifactOriginFetchGrant,
    verifyOriginGrantKeyRotationChain,
    verifyOriginGrantKeyRotationProof,
} from '../../src/commands/med-family/artifact-origin-grant.js';
import { setArtifactCommandRuntimeForDeps } from '../../src/commands/med-family/artifacts.js';
import {
    attachTrustedOwnerIngressProof,
    issueTrustedOwnerIngressProof,
} from '../../src/commands/command-args.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import {
    containsEncodedOrRawSecret,
    redactCredentialString,
} from '../../src/logging/credential-redactor.js';
import {
    clearAuthenticatedPeerOriginGrantPublicKey,
    readAuthenticatedPeerOriginGrantPublicKey,
    readMeshHostRecord,
    recordAuthenticatedPeerOriginGrantPublicKey,
    writeMeshHostRecord,
} from '../../src/mesh/mesh-host-memory.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    MESH_HANDSHAKE_ORIGIN_GRANT_CAP,
    MeshHandshakeError,
    computeClientProof,
    computeServerProof,
    mintHandshakeNonce,
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

/**
 * Deterministic PRNG buffer generator so binary fixtures are fast and reproducible.
 */
function buildDeterministicRandomBuffer(byteLength: number, seed = 0x12345678): Buffer {
    const buf = Buffer.allocUnsafe(byteLength);
    let state = seed >>> 0;
    for (let i = 0; i < byteLength; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        buf[i] = (state >>> 24) & 0xff;
    }
    return buf;
}

/**
 * Generates a ~1.3 MB PNG-like binary with a valid PNG signature, IHDR, IDAT chunks, and IEND.
 */
function buildGeneratedPngBuffer(totalBytes = 1_340_000): Buffer {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.from([
        0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x04, 0x00, // width 1024
        0x00, 0x00, 0x04, 0x00, // height 1024
        0x08, 0x06, 0x00, 0x00, 0x00,
        0x7f, 0x1d, 0x2b, 0x83, // CRC placeholder
    ]);
    const iend = Buffer.from([
        0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44,
        0xae, 0x42, 0x60, 0x82,
    ]);
    const idatHeader = Buffer.from([0x00, 0x14, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54]);
    const bodyLen = Math.max(1024, totalBytes - pngSignature.length - ihdr.length - idatHeader.length - iend.length);
    const body = buildDeterministicRandomBuffer(bodyLen, 0x9e3779b9);
    return Buffer.concat([pngSignature, ihdr, idatHeader, body, iend]);
}

function buildRealistic2MbLog(targetBytes = 2 * 1024 * 1024 + 32_768): string {
    const lines: string[] = [];
    let currentBytes = 0;
    let seq = 0;
    while (currentBytes < targetBytes) {
        seq++;
        const ts = new Date(1_760_000_000_000 + seq * 125).toISOString();
        const reqId = `req_${(seq * 2654435761 >>> 0).toString(16).padStart(8, '0')}_${seq}`;
        const pathEncoded = `/api/v1/workspaces/%2Fhome%2Fuser%2Fproject-${seq % 97}/items?filter=status%3Aactive%20tag%3Dbuild_${seq}`;
        const line = `${ts} [INF] [HttpIngressServer] ${reqId} GET ${pathEncoded} status=200 durationMs=${(seq % 45) + 2} controller=ArtifactSyncController_${seq % 500} handler=handleWorkspaceSnapshot_${seq}\n`;
        lines.push(line);
        currentBytes += Buffer.byteLength(line, 'utf8');
    }
    return lines.join('');
}

function buildGenerated70KbTypeScriptSource(targetBytes = 72 * 1024): string {
    const chunks: string[] = [
        `// Generated neutral TypeScript source fixture (~72 KB)\n`,
        `export interface CommandExecutionEnvelopeContext {\n    readonly correlationIdentifier: string;\n    readonly workspaceDirectoryPath: string;\n    readonly requestedTimestampMillis: number;\n}\n\n`,
    ];
    let size = chunks.reduce((acc, c) => acc + c.length, 0);
    let idx = 0;
    while (size < targetBytes) {
        idx++;
        const block = [
            `export async function dispatchNormalizedCommandHandler_${idx}(`,
            `    contextEnvelope: CommandExecutionEnvelopeContext,`,
            `    inputPayloadRecord_${idx}: Record<string, unknown>,`,
            `): Promise<{ handledByProcessor_${idx}: boolean; correlationIdentifier: string }> {`,
            `    const normalizedPropertyKey_${idx} = String(inputPayloadRecord_${idx}.propertyIdentifier ?? 'default_value_${idx}');`,
            `    if (normalizedPropertyKey_${idx}.length === 0) {`,
            `        throw new Error('UnexpectedEmptyNormalizedProperty_${idx}: ' + contextEnvelope.workspaceDirectoryPath);`,
            `    }`,
            `    return {`,
            `        handledByProcessor_${idx}: normalizedPropertyKey_${idx}.startsWith('prefix_'),`,
            `        correlationIdentifier: contextEnvelope.correlationIdentifier,`,
            `    };`,
            `}\n\n`,
        ].join('\n');
        chunks.push(block);
        size += block.length;
    }
    return chunks.join('');
}

function buildPackageLockLikeJson(targetBytes = 140 * 1024): string {
    const packages: Record<string, unknown> = {};
    let idx = 0;
    while (idx < 380) {
        idx++;
        const hashBytes = buildDeterministicRandomBuffer(64, idx * 0x45d9f3b);
        const integrity = `sha512-${hashBytes.toString('base64')}`;
        packages[`node_modules/@scope-pkg/component-library-${idx}`] = {
            version: `2.${idx % 20}.${idx % 9}`,
            resolved: `https://registry.npmjs.org/@scope-pkg/component-library-${idx}/-/component-library-${idx}-2.${idx % 20}.${idx % 9}.tgz`,
            integrity,
            dependencies: {
                [`helper-module-${idx}`]: `^1.${idx % 12}.0`,
            },
        };
    }
    const lockObj = {
        name: 'neutral-fixture-workspace',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages,
    };
    const serialized = JSON.stringify(lockObj, null, 2);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThanOrEqual(targetBytes);
    return serialized;
}

describe('Artifact Sharing Round 8 Regressions (Review 34085ac7)', () => {
    let tempRoot: string;
    let hostWorkspace: string;
    let hostMeshStore: MeshRuntimeStore;
    let hostArtifactStore: ArtifactStore;
    let hostSessionRegistry: SessionRegistry;
    let hostDeps: CommandRouterDeps;
    let prevConfigDir: string | undefined;
    let prevSessionCred: string | undefined;

    beforeEach(() => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        prevSessionCred = process.env.ADHDEV_MCP_SESSION_CREDENTIAL;

        tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-artifact-round8-')));
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
        configureTranscriptProjection({
            daemonId: () => 'daemon_mach_host_r8',
            writerId: () => 'writer-r8',
            epoch: 'epoch-r8',
            appendChatFrame: async () => {},
            readPersistedChat: () => null,
        });

        hostDeps = {
            sessionRegistry: hostSessionRegistry,
            statusInstanceId: 'daemon_mach_host_r8',
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
        __resetWorkerTaskTokensForTest();
        __resetWorkerSessionBindsForTest();
        __resetOriginGrantStateForTest();
        __resetTranscriptProjectionForTests();
        try {
            hostMeshStore.close();
        } catch {
            // ignore
        }
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        if (prevSessionCred === undefined) delete process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
        else process.env.ADHDEV_MCP_SESSION_CREDENTIAL = prevSessionCred;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('B-1 (BLOCKING): accepts generated ~1.3 MB PNG, 300 KB random binary, 2 MB realistic log, 70 KB TS source (and real router.ts), package-lock.json, and >64 KiB text with novel tail identifiers', async () => {
        const liveBearer = 'mcp_sess_live_round8_secret_token_1122334455667788';
        process.env.ADHDEV_MCP_SESSION_CREDENTIAL = liveBearer;

        const router = new DaemonCommandRouter(hostDeps);
        hostSessionRegistry.register({
            sessionId: 'sess-r8-b1-accept',
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

        const png13Mb = buildGeneratedPngBuffer(1_340_000);
        const randomBin300Kb = buildDeterministicRandomBuffer(300 * 1024, 0xdeadbeef);
        const png300Kb = buildGeneratedPngBuffer(300 * 1024);
        const realisticLog2Mb = Buffer.from(buildRealistic2MbLog(), 'utf8');
        const generatedTs70Kb = Buffer.from(buildGenerated70KbTypeScriptSource(), 'utf8');
        const packageLockBuf = Buffer.from(buildPackageLockLikeJson(), 'utf8');
        const tailNovelWordBuf = Buffer.from(
            'neutral line content\n'.repeat(3_500) + '\nnovelIdentifierWordInTailAfter64KiB_2026\n',
            'utf8',
        );
        const realRouterTsPath = path.resolve(__dirname, '../../src/commands/router.ts');
        const realRouterTsBuf = fs.readFileSync(realRouterTsPath);
        expect(realRouterTsBuf.byteLength).toBeGreaterThan(64 * 1024);

        // Raw 300 KB random binary (no PNG header) must also pass scanner without false positives
        expect(containsEncodedOrRawSecret(randomBin300Kb.toString('utf8'))).toBe(false);
        expect(containsEncodedOrRawSecret(randomBin300Kb.toString('latin1'))).toBe(false);

        const benignFixtures: Array<{ name: string; buf: Buffer; mimeType?: string }> = [
            { name: 'fixture-1.3mb.png', buf: png13Mb, mimeType: 'image/png' },
            { name: 'fixture-300kb.png', buf: png300Kb, mimeType: 'image/png' },
            { name: 'fixture-300kb-random.txt', buf: randomBin300Kb, mimeType: 'text/plain' },
            { name: 'fixture-2mb.log', buf: realisticLog2Mb, mimeType: 'text/plain' },
            { name: 'fixture-70kb-ts.txt', buf: generatedTs70Kb, mimeType: 'text/plain' },
            { name: 'router-copy-ts.txt', buf: realRouterTsBuf, mimeType: 'text/plain' },
            { name: 'package-lock.json', buf: packageLockBuf, mimeType: 'application/json' },
            { name: 'tail-novel-word.txt', buf: tailNovelWordBuf, mimeType: 'text/plain' },
        ];

        for (const fixture of benignFixtures) {
            expect(
                containsEncodedOrRawSecret(fixture.buf.toString('utf8')),
                `containsEncodedOrRawSecret must be false for ${fixture.name} (${fixture.buf.byteLength} bytes)`,
            ).toBe(false);

            fs.writeFileSync(path.join(hostWorkspace, fixture.name), fixture.buf);
            const res = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r8-b1-accept',
                        path: fixture.name,
                        title: `Benign ${fixture.name}`,
                        mimeType: fixture.mimeType,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(res.success, `artifact_register must accept ${fixture.name}: ${JSON.stringify(res)}`).toBe(true);
            expect((res as any).artifact?.artifactId).toBeTruthy();
        }
    });

    it('B-1 (BLOCKING): refuses and redacts credentials at offsets 100 KB and 3.9 MB, across literal, base64, double-base64, percent-encoded, and 4-layer nested encodings', async () => {
        const liveBearer = 'mcp_sess_live_round8_deep_offset_token_abcdef012345';
        process.env.ADHDEV_MCP_SESSION_CREDENTIAL = liveBearer;

        const router = new DaemonCommandRouter(hostDeps);
        hostSessionRegistry.register({
            sessionId: 'sess-r8-b1-refuse',
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

        const singleB64 = Buffer.from(liveBearer, 'utf8').toString('base64');
        const doubleB64 = Buffer.from(singleB64, 'utf8').toString('base64');
        const percentEncoded = liveBearer
            .split('')
            .map((ch, idx) => (idx % 2 === 0 ? `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}` : ch))
            .join('');
        // 4-layer nested encoding: base64(percent(base64url(base64(token))))
        const layer1 = Buffer.from(`token=${liveBearer}`, 'utf8').toString('base64');
        const layer2 = Buffer.from(layer1, 'utf8').toString('base64url');
        const layer3 = encodeURIComponent(`payload=${layer2}`);
        const layer4Nested = Buffer.from(layer3, 'utf8').toString('base64');

        const log2Mb = buildRealistic2MbLog(200 * 1024);
        const prefix100k = log2Mb.slice(0, 100 * 1024);
        const suffix100k = log2Mb.slice(100 * 1024, 180 * 1024);

        const padLine = '2026-10-24T00:00:00.000Z [INF] normal log line padding for 3.9MB offset check\n';
        const prefix39Mb = padLine.repeat(Math.ceil((3.9 * 1024 * 1024) / padLine.length));
        expect(Buffer.byteLength(prefix39Mb, 'utf8')).toBeGreaterThanOrEqual(Math.floor(3.9 * 1024 * 1024));
        expect(Buffer.byteLength(prefix39Mb, 'utf8')).toBeLessThan(MAX_ARTIFACT_BYTES - 32_768);

        const leakPayloads100k: Record<string, string> = {
            cred_at_100kb_in_log_literal: `${prefix100k}\nAuthorization: Bearer ${liveBearer}\n${suffix100k}`,
            cred_at_100kb_in_log_double_b64: `${prefix100k}\nblob=${doubleB64}\n${suffix100k}`,
            cred_at_100kb_in_log_percent: `${prefix100k}\nurl=https://example.test/cb?tok=${percentEncoded}\n${suffix100k}`,
            cred_at_100kb_in_log_4layer: `${prefix100k}\nnested=${layer4Nested}\n${suffix100k}`,
        };

        for (const [label, payload] of Object.entries(leakPayloads100k)) {
            expect(containsEncodedOrRawSecret(payload), `must detect secret in ${label}`).toBe(true);
            const redacted = redactCredentialString(payload);
            expect(redacted, `redacted output must not contain liveBearer in ${label}`).not.toContain(liveBearer);
            expect(redacted, `redacted output must not contain singleB64 in ${label}`).not.toContain(singleB64);
            expect(redacted, `redacted output must not contain doubleB64 in ${label}`).not.toContain(doubleB64);
            expect(redacted, `redacted output must not contain layer4Nested in ${label}`).not.toContain(layer4Nested);

            const fileName = `${label}.log`;
            fs.writeFileSync(path.join(hostWorkspace, fileName), payload, 'utf8');
            const regRes = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r8-b1-refuse',
                        path: fileName,
                        title: `Leak probe ${label}`,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(regRes.success, `artifact_register must refuse ${label}`).toBe(false);
            expect(regRes.code, `artifact_register code for ${label}`).toBe('secret_file_refused');
        }

        const leakPayloads39Mb: Record<string, string> = {
            cred_at_3_9mb_literal: `${prefix39Mb}\n${liveBearer}\n`,
            cred_at_3_9mb_single_b64: `${prefix39Mb}\n${singleB64}\n`,
            cred_at_3_9mb_double_b64: `${prefix39Mb}\n${doubleB64}\n`,
            cred_at_3_9mb_percent: `${prefix39Mb}\n${percentEncoded}\n`,
            cred_at_3_9mb_4layer: `${prefix39Mb}\n${layer4Nested}\n`,
        };

        for (const [label, payload] of Object.entries(leakPayloads39Mb)) {
            const fileName = `${label}.log`;
            fs.writeFileSync(path.join(hostWorkspace, fileName), payload, 'utf8');
            const regRes = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r8-b1-refuse',
                        path: fileName,
                        title: `Leak probe ${label}`,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(regRes.success, `artifact_register must refuse ${label}`).toBe(false);
            expect(regRes.code, `artifact_register code for ${label}`).toBe('secret_file_refused');
        }
        const redacted39MbNested = redactCredentialString(leakPayloads39Mb.cred_at_3_9mb_4layer);
        expect(redacted39MbNested).not.toContain(liveBearer);
        expect(redacted39MbNested).not.toContain(layer4Nested);
    }, 15_000);

    it('B-1 (BLOCKING): 4 MiB worst-case adversarial input scan is linear and bounded in time', () => {
        const liveBearer = 'mcp_sess_live_round8_timing_probe_token_99887766';
        process.env.ADHDEV_MCP_SESSION_CREDENTIAL = liveBearer;

        // Build a 4 MiB adversarial string full of unique 16-char base64-alphabet tokens and %XX sequences
        const unit = 'AbCdEfGhIjKlMnOp %2F%3A%20 QrStUvWxYz012345 '; // 44 bytes
        const count = Math.floor(MAX_ARTIFACT_BYTES / unit.length);
        const adversarial4MiB = unit.repeat(count);
        expect(Buffer.byteLength(adversarial4MiB, 'utf8')).toBeGreaterThan(3.99 * 1024 * 1024);

        const startBenign = performance.now();
        const detectedBenign = containsEncodedOrRawSecret(adversarial4MiB);
        const elapsedBenignMs = performance.now() - startBenign;
        expect(detectedBenign).toBe(false);
        expect(elapsedBenignMs).toBeLessThan(2_500);

        // Now place an encoded secret at the very tail of the 4 MiB adversarial input
        const tailSecretB64 = Buffer.from(liveBearer, 'utf8').toString('base64');
        const adversarialWithTailSecret =
            adversarial4MiB.slice(0, MAX_ARTIFACT_BYTES - tailSecretB64.length - 4) + ` ${tailSecretB64}\n`;
        const startSecret = performance.now();
        const detectedSecret = containsEncodedOrRawSecret(adversarialWithTailSecret);
        const elapsedSecretMs = performance.now() - startSecret;
        expect(detectedSecret).toBe(true);
        expect(elapsedSecretMs).toBeLessThan(2_500);
    });

    it('(a) Rolling upgrade: old<->new both directions succeed without pinning keys, new<->new enforces binding, and capability stripping is refused', async () => {
        const meshId = 'mesh-r8-rolling-upgrade';
        const hostId = 'daemon_mach_aaaa1111aaaa1111aaaa1111aaaa1111';
        const memberId = 'daemon_mach_bbbb2222bbbb2222bbbb2222bbbb2222';
        const secret = mintPeerSecret();

        // 1) old Initiator -> new Responder:
        // Simulate a pre-round-7 Initiator talking to our round-8 Responder.
        const [oldClientSock, newServerSock] = createProxySocketPair();
        const responderPromise1 = performMeshHandshake(newServerSock, 'responder', {
            localDaemonId: hostId,
            resolveSecret: (m, d) => (m === meshId && d === memberId ? secret : null),
        });
        const oldInitiatorPromise = (async () => {
            const nonceC = mintHandshakeNonce();
            const waitFrame = () =>
                new Promise<Record<string, unknown>>((resolve) => {
                    oldClientSock.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString('utf8'))));
                });
            const challengeP = waitFrame();
            // Old hello has NO caps and NO originGrantPublicKey
            oldClientSock.send(
                JSON.stringify({
                    kind: 'mesh_hello',
                    v: 1,
                    meshId,
                    daemonId: memberId,
                    nonce: nonceC,
                }),
            );
            const challenge = await challengeP;
            expect(challenge.kind).toBe('mesh_challenge');
            const nonceS = String(challenge.nonce);
            const expectedServerProof = computeServerProof({
                secret,
                meshId,
                clientDaemonId: memberId,
                serverDaemonId: hostId,
                clientNonce: nonceC,
                serverNonce: nonceS,
            });
            expect(challenge.proof).toBe(expectedServerProof);

            const okP = waitFrame();
            const proofC = computeClientProof({
                secret,
                meshId,
                clientDaemonId: memberId,
                serverDaemonId: hostId,
                clientNonce: nonceC,
                serverNonce: nonceS,
            });
            oldClientSock.send(
                JSON.stringify({
                    kind: 'mesh_proof',
                    v: 1,
                    proof: proofC,
                }),
            );
            const okFrame = await okP;
            expect(okFrame.kind).toBe('mesh_ok');
        })();
        const [resResponder1] = await Promise.all([responderPromise1, oldInitiatorPromise]);
        expect(resResponder1.peerDaemonId).toBe(memberId);
        // No key was pinned from the old Initiator
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, memberId)).toBeNull();

        // 2) new Initiator -> old Responder:
        // Simulate our round-8 Initiator talking to a pre-round-7 Responder.
        const [newClientSock, oldServerSock] = createProxySocketPair();
        const oldResponderPromise = (async () => {
            const waitFrame = () =>
                new Promise<Record<string, unknown>>((resolve) => {
                    oldServerSock.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString('utf8'))));
                });
            const hello = await waitFrame();
            expect(hello.kind).toBe('mesh_hello');
            const nonceC = String(hello.nonce);
            const nonceS = mintHandshakeNonce();
            const proofS = computeServerProof({
                secret,
                meshId,
                clientDaemonId: memberId,
                serverDaemonId: hostId,
                clientNonce: nonceC,
                serverNonce: nonceS,
            });
            const proofP = waitFrame();
            // Old challenge has NO caps and NO originGrantPublicKey
            oldServerSock.send(
                JSON.stringify({
                    kind: 'mesh_challenge',
                    v: 1,
                    daemonId: hostId,
                    nonce: nonceS,
                    proof: proofS,
                }),
            );
            const proofFrame = await proofP;
            expect(proofFrame.kind).toBe('mesh_proof');
            const expectedClientProof = computeClientProof({
                secret,
                meshId,
                clientDaemonId: memberId,
                serverDaemonId: hostId,
                clientNonce: nonceC,
                serverNonce: nonceS,
            });
            expect(proofFrame.proof).toBe(expectedClientProof);
            oldServerSock.send(
                JSON.stringify({
                    kind: 'mesh_ok',
                    v: 1,
                    daemonId: hostId,
                }),
            );
        })();
        const initiatorPromise2 = performMeshHandshake(newClientSock, 'initiator', {
            meshId,
            daemonId: memberId,
            serverDaemonIdExpected: hostId,
            secret,
        });
        const [, resInitiator2] = await Promise.all([oldResponderPromise, initiatorPromise2]);
        expect(resInitiator2.peerDaemonId).toBe(hostId);
        // Against an old peer, NO key is pinned or accepted from that handshake
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBeNull();
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId: hostId })).toBe('');

        // Cross-origin grant verification against an old peer without a pinned key fails closed
        const nowMs = Date.now();
        const unverifiableGrant = mintArtifactOriginFetchGrant({
            meshId,
            hostDaemonId: hostId,
            originDaemonId: memberId,
            artifactId: 'art-old-peer',
            requesterSessionId: 'sess-1',
            requesterTaskId: 'task-1',
            requesterAttemptId: 'att-1',
            nowMs,
        });
        expect(
            verifyArtifactOriginFetchGrant(
                unverifiableGrant,
                {
                    meshId,
                    hostDaemonId: hostId,
                    originDaemonId: memberId,
                    artifactId: 'art-old-peer',
                    requesterSessionId: 'sess-1',
                    requesterTaskId: 'task-1',
                    requesterAttemptId: 'att-1',
                },
                nowMs,
            ),
        ).toEqual({ ok: false, reason: 'untrusted_or_missing_host_public_key' });

        // 3) Downgrade / capability stripping between two new peers MUST be detected and refused:
        // Case 3a: relay strips caps + originGrantPublicKey from mesh_hello
        const [stripHelloClient, stripHelloServer] = createProxySocketPair({
            rewriteClientToServer: (frame) => {
                if (frame.kind === 'mesh_hello') {
                    const copy = { ...frame };
                    delete copy.caps;
                    delete copy.originGrantPublicKey;
                    delete copy.keyRotation;
                    delete copy.keyRotationChain;
                    return copy;
                }
                return frame;
            },
        });
        const [stripHelloServerRes, stripHelloClientRes] = await Promise.all([
            performMeshHandshake(stripHelloServer, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshId && d === memberId ? secret : null),
            }).catch((e) => e),
            performMeshHandshake(stripHelloClient, 'initiator', {
                meshId,
                daemonId: memberId,
                serverDaemonIdExpected: hostId,
                secret,
            }).catch((e) => e),
        ]);
        expect(stripHelloClientRes).toBeInstanceOf(MeshHandshakeError);
        expect((stripHelloClientRes as MeshHandshakeError).code).toBe('bad_proof');
        expect(stripHelloServerRes).toBeInstanceOf(MeshHandshakeError);

        // Case 3b: relay strips caps + originGrantPublicKey from BOTH mesh_hello and mesh_challenge
        const [stripBothClient, stripBothServer] = createProxySocketPair({
            rewriteClientToServer: (frame) => {
                if (frame.kind === 'mesh_hello') {
                    const copy = { ...frame };
                    delete copy.caps;
                    delete copy.originGrantPublicKey;
                    return copy;
                }
                return frame;
            },
            rewriteServerToClient: (frame) => {
                if (frame.kind === 'mesh_challenge' || frame.kind === 'mesh_ok') {
                    const copy = { ...frame };
                    delete copy.caps;
                    delete copy.originGrantPublicKey;
                    if (frame.kind === 'mesh_ok') {
                        delete copy.proof;
                    }
                    return copy;
                }
                return frame;
            },
        });
        const [stripBothServerRes, stripBothClientRes] = await Promise.all([
            performMeshHandshake(stripBothServer, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshId && d === memberId ? secret : null),
            }).catch((e) => e),
            performMeshHandshake(stripBothClient, 'initiator', {
                meshId,
                daemonId: memberId,
                serverDaemonIdExpected: hostId,
                secret,
            }).catch((e) => e),
        ]);
        expect(stripBothClientRes).toBeInstanceOf(MeshHandshakeError);
        expect((stripBothClientRes as MeshHandshakeError).code).toBe('bad_proof');
        expect(stripBothServerRes).toBeInstanceOf(MeshHandshakeError);

        // Case 3c: relay strips caps from mesh_challenge only
        const [stripChalClient, stripChalServer] = createProxySocketPair({
            rewriteServerToClient: (frame) => {
                if (frame.kind === 'mesh_challenge') {
                    const copy = { ...frame };
                    delete copy.caps;
                    delete copy.originGrantPublicKey;
                    return copy;
                }
                return frame;
            },
        });
        const [stripChalServerRes, stripChalClientRes] = await Promise.all([
            performMeshHandshake(stripChalServer, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshId && d === memberId ? secret : null),
            }).catch((e) => e),
            performMeshHandshake(stripChalClient, 'initiator', {
                meshId,
                daemonId: memberId,
                serverDaemonIdExpected: hostId,
                secret,
            }).catch((e) => e),
        ]);
        expect(stripChalClientRes).toBeInstanceOf(MeshHandshakeError);
        expect((stripChalClientRes as MeshHandshakeError).code).toBe('bad_proof');
        expect(stripChalServerRes).toBeInstanceOf(MeshHandshakeError);

        // 4) new <-> new handshake succeeds, negotiates MESH_HANDSHAKE_ORIGIN_GRANT_CAP, and pins both keys
        expect(MESH_HANDSHAKE_ORIGIN_GRANT_CAP).toBe('origin_grant_v1');
        const [newC, newS] = createProxySocketPair();
        await Promise.all([
            performMeshHandshake(newS, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshId && d === memberId ? secret : null),
            }),
            performMeshHandshake(newC, 'initiator', {
                meshId,
                daemonId: memberId,
                serverDaemonIdExpected: hostId,
                secret,
            }),
        ]);
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBe(getHostOriginGrantPublicKey(hostId));
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, memberId)).toBe(getHostOriginGrantPublicKey(memberId));
    });

    it('(b) & (c): bounded rotation chain (N=4) allows recovery after missing 2..4 rotations in handshake and grant verification, and rotation compares canonical SPKI DER bytes', async () => {
        const meshHandshake = 'mesh-r8-rotation-handshake';
        const meshGrant = 'mesh-r8-rotation-grant';
        const hostId = 'daemon_mach_cccc3333cccc3333cccc3333cccc3333';
        const memberId = 'daemon_mach_dddd4444dddd4444dddd4444dddd4444';
        const secret = mintPeerSecret();

        const k0Base64Url = getHostOriginGrantPublicKey(hostId);
        // Convert k0 to PEM and standard padded base64 to verify canonical DER comparison (c)
        const k0Der = Buffer.from(k0Base64Url, 'base64url');
        const k0PaddedBase64 = k0Der.toString('base64');
        const k0Pem = crypto
            .createPublicKey({ key: k0Der, format: 'der', type: 'spki' })
            .export({ format: 'pem', type: 'spki' })
            .toString();

        expect(originGrantPublicKeysEqual(k0Base64Url, k0PaddedBase64)).toBe(true);
        expect(originGrantPublicKeysEqual(k0Base64Url, k0Pem)).toBe(true);

        // Pin k0 in PEM format for meshHandshake and padded base64 for meshGrant
        writeMeshHostRecord(meshHandshake, hostId, 'pairing', k0Pem);
        writeMeshHostRecord(meshGrant, hostId, 'pairing', k0PaddedBase64);

        // Rotate 4 times (K0 -> K1 -> K2 -> K3 -> K4)
        const r1 = rotateHostOriginGrantKeyPair(hostId);
        const r2 = rotateHostOriginGrantKeyPair(hostId);
        const r3 = rotateHostOriginGrantKeyPair(hostId);
        const r4 = rotateHostOriginGrantKeyPair(hostId);
        expect(MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH).toBe(4);

        // Verify canonical byte comparison on single proof against PEM / padded base64
        expect(
            verifyOriginGrantKeyRotationProof(r1.rotationProof, {
                hostDaemonId: hostId,
                currentPinnedPublicKey: k0Pem,
            }).ok,
        ).toBe(true);
        expect(
            verifyOriginGrantKeyRotationProof(r1.rotationProof, {
                hostDaemonId: hostId,
                currentPinnedPublicKey: k0PaddedBase64,
            }).ok,
        ).toBe(true);

        const chain4 = getHostKeyRotationChain(hostId);
        expect(chain4).toHaveLength(4);
        const chain4Check = verifyOriginGrantKeyRotationChain(
            { rotationChain: chain4 },
            { hostDaemonId: hostId, currentPinnedPublicKey: k0Pem, targetPublicKey: r4.publicKey },
        );
        expect(chain4Check.ok).toBe(true);
        if (chain4Check.ok) {
            expect(chain4Check.newPublicKey).toBe(r4.publicKey);
        }

        // 1) Peer on meshHandshake missed 4 rotations (still has k0Pem pinned) -> handshake succeeds and advances pin to K4
        const [clientSock, serverSock] = createProxySocketPair();
        await Promise.all([
            performMeshHandshake(serverSock, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshHandshake && d === memberId ? secret : null),
            }),
            performMeshHandshake(clientSock, 'initiator', {
                meshId: meshHandshake,
                daemonId: memberId,
                serverDaemonIdExpected: hostId,
                secret,
            }),
        ]);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: meshHandshake, hostDaemonId: hostId })).toBe(
            r4.publicKey,
        );

        // 2) Peer on meshGrant missed 4 rotations (still has k0PaddedBase64 pinned) -> verifyArtifactOriginFetchGrant succeeds and advances pin to K4
        const nowMs = Date.now();
        const grantAtK4 = mintArtifactOriginFetchGrant({
            meshId: meshGrant,
            hostDaemonId: hostId,
            originDaemonId: memberId,
            artifactId: 'art-rot-chain-4',
            requesterSessionId: 'sess-rot',
            requesterTaskId: 'task-rot',
            requesterAttemptId: 'att-rot',
            nowMs,
        });
        expect(grantAtK4.keyRotationChain).toHaveLength(4);
        const verifiedGrantK4 = verifyArtifactOriginFetchGrant(
            grantAtK4,
            {
                meshId: meshGrant,
                hostDaemonId: hostId,
                originDaemonId: memberId,
                artifactId: 'art-rot-chain-4',
                requesterSessionId: 'sess-rot',
                requesterTaskId: 'task-rot',
                requesterAttemptId: 'att-rot',
            },
            nowMs,
        );
        expect(verifiedGrantK4.ok).toBe(true);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: meshGrant, hostDaemonId: hostId })).toBe(r4.publicKey);

        // 3) If a peer missed 5 rotations (> MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH = 4), the 4-link chain starts at K1, so a peer pinned at K0 fails closed until re-pair
        const meshStale = 'mesh-r8-rotation-stale-5';
        writeMeshHostRecord(meshStale, hostId, 'pairing', k0Base64Url);
        rotateHostOriginGrantKeyPair(hostId); // 5th rotation (K4 -> K5)
        const chainAfter5 = getHostKeyRotationChain(hostId);
        expect(chainAfter5).toHaveLength(4);
        expect(
            verifyOriginGrantKeyRotationChain(
                { rotationChain: chainAfter5 },
                { hostDaemonId: hostId, currentPinnedPublicKey: k0Base64Url },
            ).ok,
        ).toBe(false);
    });

    it('(d) & (e): handshake key recording never creates a pairing host record for non-host peers, and clearAuthenticatedPeerOriginGrantPublicKey clears all stores atomically across restarts', async () => {
        const meshId = 'mesh-r8-notes-d-e';
        const hostId = 'daemon_mach_eeee5555eeee5555eeee5555eeee5555';
        const nonHostPeerId = 'daemon_mach_ffff6666ffff6666ffff6666ffff6666';
        const secret = mintPeerSecret();

        // (d) Handshake between hostId and nonHostPeerId when NO mesh-host-records.json exists
        const [clientSock, serverSock] = createProxySocketPair();
        await Promise.all([
            performMeshHandshake(serverSock, 'responder', {
                localDaemonId: hostId,
                resolveSecret: (m, d) => (m === meshId && d === nonHostPeerId ? secret : null),
            }),
            performMeshHandshake(clientSock, 'initiator', {
                meshId,
                daemonId: nonHostPeerId,
                serverDaemonIdExpected: hostId,
                secret,
            }),
        ]);

        // Keys are recorded in the dedicated peer grant key store, NOT as a pairing host record!
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, nonHostPeerId)).toBe(
            getHostOriginGrantPublicKey(nonHostPeerId),
        );
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBe(getHostOriginGrantPublicKey(hostId));
        expect(readMeshHostRecord(meshId)).toBeNull();

        // Direct call to recordAuthenticatedPeerOriginGrantPublicKey also never creates a MeshHostRecord
        const otherMesh = 'mesh-r8-no-host-record';
        expect(
            recordAuthenticatedPeerOriginGrantPublicKey(
                otherMesh,
                nonHostPeerId,
                getHostOriginGrantPublicKey(nonHostPeerId),
            ),
        ).toBe(true);
        expect(readMeshHostRecord(otherMesh)).toBeNull();

        // (e) Now populate all stores (in-memory, mesh-peer-grant-keys.json, mesh-host-records.json, and mesh-peer-secrets.json)
        const hostPubKey = getHostOriginGrantPublicKey(hostId);
        writeMeshHostRecord(meshId, hostId, 'pairing', hostPubKey);
        putPeerSecret({
            meshId,
            peerDaemonId: hostId,
            role: 'member',
            secret,
            originGrantPublicKey: hostPubKey,
            createdAt: new Date().toISOString(),
        });
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId: hostId })).toBe(hostPubKey);
        expect(getPeerSecret(meshId, hostId)?.originGrantPublicKey).toBe(hostPubKey);

        // Clear the peer's public key atomically
        clearAuthenticatedPeerOriginGrantPublicKey(meshId, hostId);
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBeNull();
        expect(readMeshHostRecord(meshId)?.originGrantPublicKey).toBeUndefined();
        expect(getPeerSecret(meshId, hostId)?.originGrantPublicKey).toBeUndefined();
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId: hostId })).toBe('');

        // Simulate daemon restart: reset in-memory caches and verify the cleared key does NOT return from disk
        __resetOriginGrantStateForTest();
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBeNull();
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId: hostId })).toBe('');
    });

    it('(f) Residual LOW: nonce capacity is scoped per (meshId, hostDaemonId) and verifyArtifactOriginFetchGrant caps expiresAt - issuedAt at ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS', () => {
        const meshA = 'mesh-r8-scope-a';
        const meshB = 'mesh-r8-scope-b';
        const hostA = 'daemon_mach_12121212121212121212121212121212';
        const hostB = 'daemon_mach_34343434343434343434343434343434';
        const originId = 'daemon_mach_56565656565656565656565656565656';

        const pubA = getHostOriginGrantPublicKey(hostA);
        const pubB = getHostOriginGrantPublicKey(hostB);
        writeMeshHostRecord(meshA, hostA, 'pairing', pubA);
        writeMeshHostRecord(meshB, hostB, 'pairing', pubB);

        const nowMs = 1_765_000_000_000;

        // 1) Verify TTL window cap: expiresAt - issuedAt > ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS is refused
        const baseGrant = mintArtifactOriginFetchGrant({
            meshId: meshA,
            hostDaemonId: hostA,
            originDaemonId: originId,
            artifactId: 'art-ttl-cap',
            requesterSessionId: 'sess-ttl',
            requesterTaskId: 'task-ttl',
            requesterAttemptId: 'att-ttl',
            nowMs,
            ttlMs: ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS,
        });
        // Forge a grant with excessive TTL window (even if signed by the real host key, verify rejects the window before signature check)
        const excessiveWindowGrant = {
            ...baseGrant,
            expiresAt: baseGrant.issuedAt + ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS + 1,
        };
        expect(
            verifyArtifactOriginFetchGrant(
                excessiveWindowGrant,
                {
                    meshId: meshA,
                    hostDaemonId: hostA,
                    originDaemonId: originId,
                    artifactId: 'art-ttl-cap',
                    requesterSessionId: 'sess-ttl',
                    requesterTaskId: 'task-ttl',
                    requesterAttemptId: 'att-ttl',
                },
                nowMs,
            ),
        ).toEqual({ ok: false, reason: 'expired_or_invalid_grant_window' });

        // 2) Exhaust nonce capacity (4,096) for (meshA, hostA)
        for (let i = 0; i < MAX_TRACKED_NONCES; i++) {
            const g = mintArtifactOriginFetchGrant({
                meshId: meshA,
                hostDaemonId: hostA,
                originDaemonId: originId,
                artifactId: `art-scope-a-${i}`,
                requesterSessionId: 'sess-scope',
                requesterTaskId: 'task-scope',
                requesterAttemptId: 'att-scope',
                nowMs,
            });
            const res = verifyArtifactOriginFetchGrant(
                g,
                {
                    meshId: meshA,
                    hostDaemonId: hostA,
                    originDaemonId: originId,
                    artifactId: `art-scope-a-${i}`,
                    requesterSessionId: 'sess-scope',
                    requesterTaskId: 'task-scope',
                    requesterAttemptId: 'att-scope',
                    consumeNonce: true,
                    nonceStoreDb: hostMeshStore.db,
                },
                nowMs,
            );
            expect(res.ok).toBe(true);
        }

        // 4,097th grant on (meshA, hostA) is refused with grant_capacity_exhausted
        const overflowA = mintArtifactOriginFetchGrant({
            meshId: meshA,
            hostDaemonId: hostA,
            originDaemonId: originId,
            artifactId: 'art-scope-a-overflow',
            requesterSessionId: 'sess-scope',
            requesterTaskId: 'task-scope',
            requesterAttemptId: 'att-scope',
            nowMs,
        });
        expect(
            verifyArtifactOriginFetchGrant(
                overflowA,
                {
                    meshId: meshA,
                    hostDaemonId: hostA,
                    originDaemonId: originId,
                    artifactId: 'art-scope-a-overflow',
                    requesterSessionId: 'sess-scope',
                    requesterTaskId: 'task-scope',
                    requesterAttemptId: 'att-scope',
                    consumeNonce: true,
                    nonceStoreDb: hostMeshStore.db,
                },
                nowMs,
            ),
        ).toEqual({ ok: false, reason: 'grant_capacity_exhausted' });

        // Meanwhile, (meshB, hostB) on the SAME origin daemon and SQLite DB still succeeds!
        const grantMeshB = mintArtifactOriginFetchGrant({
            meshId: meshB,
            hostDaemonId: hostB,
            originDaemonId: originId,
            artifactId: 'art-scope-b-1',
            requesterSessionId: 'sess-scope',
            requesterTaskId: 'task-scope',
            requesterAttemptId: 'att-scope',
            nowMs,
        });
        const resMeshB = verifyArtifactOriginFetchGrant(
            grantMeshB,
            {
                meshId: meshB,
                hostDaemonId: hostB,
                originDaemonId: originId,
                artifactId: 'art-scope-b-1',
                requesterSessionId: 'sess-scope',
                requesterTaskId: 'task-scope',
                requesterAttemptId: 'att-scope',
                consumeNonce: true,
                nonceStoreDb: hostMeshStore.db,
            },
            nowMs,
        );
        expect(resMeshB.ok).toBe(true);
    });
});
