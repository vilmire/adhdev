import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, MAX_ARTIFACT_BYTES } from '../../src/artifacts/index.js';
import {
    __resetOriginGrantStateForTest,
    MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH,
    applyAuthenticatedHostKeyRotation,
    getHostKeyRotationChain,
    getHostOriginGrantPublicKey,
    mintArtifactOriginFetchGrant,
    resolveTrustedHostOriginGrantPublicKey,
    rotateHostOriginGrantKeyPair,
    verifyArtifactOriginFetchGrant,
    verifyOriginGrantKeyRotationChain,
} from '../../src/commands/med-family/artifact-origin-grant.js';
import { setArtifactCommandRuntimeForDeps } from '../../src/commands/med-family/artifacts.js';
import { meshHostPairingHandlers } from '../../src/commands/med-family/mesh-host-pairing.js';
import {
    attachTrustedOwnerIngressProof,
    issueTrustedOwnerIngressProof,
} from '../../src/commands/command-args.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import {
    createMeshHostPairingToken,
    configureMeshHostPairing,
} from '../../src/config/mesh-config-host-pairing.js';
import { createMesh } from '../../src/config/mesh-config.js';
import {
    containsEncodedOrRawSecret,
    redactCredentialString,
} from '../../src/logging/credential-redactor.js';
import {
    clearAuthenticatedPeerOriginGrantPublicKey,
    listMeshHostRecords,
    migrateBogusPairingHostRecords,
    readAuthenticatedPeerOriginGrantPublicKey,
    readMeshHostRecord,
    writeMeshHostRecord,
} from '../../src/mesh/mesh-host-memory.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
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

/**
 * Generates an ordinary URL-encoded access log with >= 2 percent-encoded runs per line
 * (and > 1,024 percent runs per 61,440-char window).
 */
function buildDenseUrlEncodedAccessLog(targetBytes: number): string {
    const lines: string[] = [];
    let currentBytes = 0;
    let seq = 0;
    while (currentBytes < targetBytes) {
        seq++;
        const pathRun = `/v1/org%2Fteam_${seq % 50}%2Fitems%3Fpage%3D${seq % 200}`;
        const refRun = `ref%3Dhttps%2520client_${seq}%26sort%3Dcreated_at%253Adesc`;
        const line = `10.0.0.${(seq % 250) + 1} GET ${pathRun} ${refRun} 200\n`;
        lines.push(line);
        currentBytes += Buffer.byteLength(line, 'utf8');
    }
    return lines.join('');
}

/**
 * Generates a ~1 MB HAR-like JSON document with many URL-encoded request URLs,
 * query parameters, headers, and benign base64 response bodies/cursors.
 */
function buildHarLikeJson1Mb(targetBytes = 1024 * 1024 + 16_384): string {
    const entries: unknown[] = [];
    let approxSize = 0;
    let idx = 0;
    while (approxSize < targetBytes) {
        idx++;
        const cursorB64 = Buffer.from(`{"offset":${idx * 25},"filter":"active"}`, 'utf8').toString('base64');
        const bodyB64 = Buffer.from(`{"status":"ok","items":[${idx},${idx + 1}],"next":"${idx + 2}"}`, 'utf8').toString(
            'base64',
        );
        const entry = {
            startedDateTime: new Date(1_765_000_000_000 + idx * 100).toISOString(),
            time: (idx % 80) + 5,
            request: {
                method: 'GET',
                url: `https://api.example.test/v2/projects/%2Fworkspace%2Fapp-${idx % 40}/events?q=type%3Adeploy%20env%3Dprod_${idx}&redirect=https%3A%2F%2Fapp.example.test%2Fview%3Fid%3D${idx}`,
                httpVersion: 'HTTP/2.0',
                queryString: [
                    { name: 'q', value: `type%3Adeploy%20env%3Dprod_${idx}` },
                    { name: 'cursor', value: cursorB64 },
                ],
            },
            response: {
                status: 200,
                statusText: 'OK',
                content: {
                    size: bodyB64.length,
                    mimeType: 'application/json',
                    text: bodyB64,
                    encoding: 'base64',
                },
            },
        };
        entries.push(entry);
        approxSize += 620;
    }
    const har = {
        log: {
            version: '1.2',
            creator: { name: 'neutral-har-fixture', version: '1.0' },
            entries,
        },
    };
    const serialized = JSON.stringify(har, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') < targetBytes) {
        return serialized + '\n' + ' '.repeat(targetBytes - Buffer.byteLength(serialized, 'utf8'));
    }
    return serialized;
}

/**
 * Generates a large URL list with thousands of URL-encoded entries.
 */
function buildEncodedUrlList(count = 2_500): string {
    const urls: string[] = [];
    for (let i = 1; i <= count; i++) {
        urls.push(
            `https://mirror.example.test/download/releases%2Fv1.${i % 30}.0%2Farchive_${i}.tar.gz?mirror=region_${i % 8}%26verify%3Dsha256_${i}`,
        );
    }
    return urls.join('\n') + '\n';
}

describe('Artifact Sharing Round 9 Regressions (Review 78e8a83c)', () => {
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

        tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-artifact-round9-')));
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
            daemonId: () => 'daemon_mach_host_r9',
            writerId: () => 'writer-r9',
            epoch: 'epoch-r9',
            appendChatFrame: async () => {},
            readPersistedChat: () => null,
        });

        hostDeps = {
            sessionRegistry: hostSessionRegistry,
            statusInstanceId: 'daemon_mach_host_r9',
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

    it('FP-1 (MEDIUM): accepts >=61,440-char dense access log (2 percent runs/line), 2 MB access log, 1 MB HAR-like JSON, URL list, and proxy log while keeping the packing guarantee for thousands of decodable decoys + credential', async () => {
        const liveBearer = 'mcp_sess_live_round9_fp1_secret_token_1122334455';
        process.env.ADHDEV_MCP_SESSION_CREDENTIAL = liveBearer;

        const router = new DaemonCommandRouter(hostDeps);
        hostSessionRegistry.register({
            sessionId: 'sess-r9-fp1',
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

        // 1) 70 KB dense access log (2 percent runs per line -> > 1,300 percent runs in the first 61,440-char window)
        const accessLog70Kb = buildDenseUrlEncodedAccessLog(70 * 1024);
        expect(accessLog70Kb.length).toBeGreaterThanOrEqual(61_440);
        // Verify first 61,440 chars genuinely have > 1,024 percent-encoded runs
        const firstWindowRuns = accessLog70Kb
            .slice(0, 61_440)
            .match(/(?<![A-Za-z0-9+/_~=%-])(?:[A-Za-z0-9+/_~=-]|%[0-9A-Fa-f]{2}){10,}/g);
        expect((firstWindowRuns ?? []).length).toBeGreaterThan(1_024);
        expect(containsEncodedOrRawSecret(accessLog70Kb)).toBe(false);

        // 2) 2 MB dense URL-encoded access log
        const accessLog2Mb = buildDenseUrlEncodedAccessLog(2 * 1024 * 1024 + 16_384);
        expect(Buffer.byteLength(accessLog2Mb, 'utf8')).toBeGreaterThanOrEqual(2 * 1024 * 1024);

        // 3) 1 MB HAR-like JSON with many encoded URLs and base64 bodies
        const har1Mb = buildHarLikeJson1Mb(1024 * 1024 + 16_384);
        expect(Buffer.byteLength(har1Mb, 'utf8')).toBeGreaterThanOrEqual(1024 * 1024);

        // 4) Encoded URL list (2,500 URLs, > 200 KB)
        const urlList = buildEncodedUrlList(2_500);
        expect(urlList.length).toBeGreaterThan(200 * 1024);

        const fixtures: Array<{ name: string; content: string; mimeType: string }> = [
            { name: 'dense-access-70kb.log', content: accessLog70Kb, mimeType: 'text/plain' },
            { name: 'dense-access-2mb.log', content: accessLog2Mb, mimeType: 'text/plain' },
            { name: 'capture-1mb.har.json', content: har1Mb, mimeType: 'application/json' },
            { name: 'encoded-urls.txt', content: urlList, mimeType: 'text/plain' },
        ];

        for (const fixture of fixtures) {
            expect(
                containsEncodedOrRawSecret(fixture.content),
                `containsEncodedOrRawSecret must accept ${fixture.name}`,
            ).toBe(false);

            fs.writeFileSync(path.join(hostWorkspace, fixture.name), fixture.content, 'utf8');
            const res = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r9-fp1',
                        path: fixture.name,
                        title: `FP-1 ${fixture.name}`,
                        mimeType: fixture.mimeType,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(res.success, `artifact_register must accept ${fixture.name}: ${JSON.stringify(res)}`).toBe(true);
        }

        // 5) Packing guarantee: thousands of DECODABLE decoys followed by a credential in one window MUST fail closed
        const singleB64Cred = Buffer.from(liveBearer, 'utf8').toString('base64');
        const doubleB64Cred = Buffer.from(singleB64Cred, 'utf8').toString('base64');

        // 5a: 1,500 decodable single-layer base64 decoys + credential in one window
        const singleLayerB64Decoys = Array.from({ length: 1_500 }, (_, i) =>
            Buffer.from(`decoy_${String(i).padStart(4, '0')}`, 'utf8').toString('base64'),
        ).join(' ');
        const packedSingleB64Window = `${singleLayerB64Decoys} ${doubleB64Cred}`;
        expect(packedSingleB64Window.length).toBeLessThan(65_536);
        expect(containsEncodedOrRawSecret(packedSingleB64Window)).toBe(true);

        // 5b: 1,500 decodable percent-encoded decoys + credential in one window
        const singleLayerPctDecoys = Array.from(
            { length: 1_500 },
            (_, i) => `/p%2Fitem_${String(i).padStart(4, '0')}%3Fok%3D1`,
        ).join(' ');
        const packedPctWindow = `${singleLayerPctDecoys} ${encodeURIComponent(liveBearer)}`;
        expect(packedPctWindow.length).toBeLessThan(65_536);
        expect(containsEncodedOrRawSecret(packedPctWindow)).toBe(true);

        // 5c: 1,200 multi-layer decodable decoys (double-base64) + credential in one window (fails closed on exhaustion)
        const multiLayerB64Decoys = Array.from({ length: 1_200 }, (_, i) =>
            Buffer.from(
                Buffer.from(`nested_decoy_${String(i).padStart(4, '0')}`, 'utf8').toString('base64'),
                'utf8',
            ).toString('base64'),
        ).join(' ');
        const packedMultiLayerWindow = `${multiLayerB64Decoys} ${doubleB64Cred}`;
        expect(packedMultiLayerWindow.length).toBeLessThan(65_536);
        expect(containsEncodedOrRawSecret(packedMultiLayerWindow)).toBe(true);

        fs.writeFileSync(path.join(hostWorkspace, 'packed-decoys.txt'), packedMultiLayerWindow, 'utf8');
        const packedRes = await router.execute(
            'artifact_register',
            attachTrustedOwnerIngressProof(
                {
                    sessionId: 'sess-r9-fp1',
                    path: 'packed-decoys.txt',
                    title: 'Packed decoys',
                },
                ownerProof,
            ),
            'standalone',
            { ownerVerified: true, ownerProof },
        );
        expect(packedRes.success).toBe(false);
        expect(packedRes.code).toBe('secret_file_refused');
    }, 20_000);

    it('FP-2: accepts 176 KB TS source containing `const directToken = verifyWorkerTaskToken(credential.token);` and code-shaped assignments, while refusing real `token = "mcp_sess_..."` and `credential: \'...\'` leaks', async () => {
        const router = new DaemonCommandRouter(hostDeps);
        hostSessionRegistry.register({
            sessionId: 'sess-r9-fp2',
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

        // Build a >= 176 KB TS source combining the real artifact modules + the exact line flagged by the reviewer
        const p1 = fs.readFileSync(
            path.resolve(__dirname, '../../src/commands/med-family/artifacts.ts'),
            'utf8',
        );
        const p2 = fs.readFileSync(
            path.resolve(__dirname, '../../src/commands/med-family/artifact-sharing.ts'),
            'utf8',
        );
        const p3 = fs.readFileSync(
            path.resolve(__dirname, '../../src/commands/med-family/artifact-origin-grant.ts'),
            'utf8',
        );
        const codeFalsePositiveSnippet = [
            'export function checkCodeShapedPatterns(credential: { token: string }, args?: { token?: string }) {',
            '    const directToken = verifyWorkerTaskToken(credential.token);',
            '    const memberAccessToken = credential.token;',
            '    const optionalToken = args?.token;',
            '    const secret = getSecretFromStore(directToken);',
            '    const password: string = computePasswordHash(secret);',
            '    const url = `https://example.test/api?token=${encodeURIComponent(directToken)}`;',
            '    return { token: directToken, secret, password, url };',
            '}',
        ].join('\n');

        let tsSource176Kb = `${p1}\n${p2}\n${p3}\n${codeFalsePositiveSnippet}\n`;
        while (Buffer.byteLength(tsSource176Kb, 'utf8') < 180 * 1024) {
            tsSource176Kb += `\n${codeFalsePositiveSnippet}\n`;
        }
        expect(tsSource176Kb).toContain('const directToken = verifyWorkerTaskToken(credential.token);');
        expect(Buffer.byteLength(tsSource176Kb, 'utf8')).toBeGreaterThanOrEqual(176 * 1024);

        expect(containsEncodedOrRawSecret(tsSource176Kb)).toBe(false);
        expect(redactCredentialString(codeFalsePositiveSnippet)).toBe(codeFalsePositiveSnippet);

        fs.writeFileSync(path.join(hostWorkspace, 'source-176kb.txt'), tsSource176Kb, 'utf8');
        const acceptRes = await router.execute(
            'artifact_register',
            attachTrustedOwnerIngressProof(
                {
                    sessionId: 'sess-r9-fp2',
                    path: 'source-176kb.txt',
                    title: '176 KB TS source',
                },
                ownerProof,
            ),
            'standalone',
            { ownerVerified: true, ownerProof },
        );
        expect(acceptRes.success, `176 KB TS source must be accepted: ${JSON.stringify(acceptRes)}`).toBe(true);

        // Real secret leaks in key=value / key: value syntax MUST be refused and redacted
        const realLeaks: Record<string, string> = {
            quoted_token_mcp_sess: 'const token = "mcp_sess_real_secret_token_987654321";',
            quoted_token_ellipsis: 'const token = "mcp_sess_…";',
            single_quoted_credential: "const cfg = { credential: 'my_super_secret_credential_value_123' };",
            single_quoted_credential_ellipsis: "const cfg = { credential: '…' };",
            unquoted_env_token: 'token=mcp_sess_unquoted_secret_1234567890',
            unquoted_api_key: 'api_key=sk_live_99887766554433221100',
        };

        for (const [label, leak] of Object.entries(realLeaks)) {
            expect(containsEncodedOrRawSecret(leak), `must detect real leak ${label}`).toBe(true);
            const redacted = redactCredentialString(leak);
            expect(redacted, `must redact real leak ${label}`).toContain('[REDACTED:');

            const leakFile = `${label}.txt`;
            fs.writeFileSync(path.join(hostWorkspace, leakFile), leak, 'utf8');
            const leakRes = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r9-fp2',
                        path: leakFile,
                        title: `Leak ${label}`,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(leakRes.success, `artifact_register must refuse ${label}`).toBe(false);
            expect(leakRes.code).toBe('secret_file_refused');
        }
    });

    it('Item 3 & Item 4 (a, b): catches credentials split by >4,096 newlines across a window boundary, same-shape decoy blobs via full-content sha256 visitKey, and base64 with binary prefix + credential', async () => {
        const liveBearer = 'mcp_sess_live_round9_failopen_secret_7766554433';
        process.env.ADHDEV_MCP_SESSION_CREDENTIAL = liveBearer;

        const router = new DaemonCommandRouter(hostDeps);
        hostSessionRegistry.register({
            sessionId: 'sess-r9-failopens',
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

        // Item 3: Credential split by a newline run of > 4,096 chars (8,000 newlines) across the 61,440 window boundary
        const prefixBeforeBoundary = 'x'.repeat(60_000) + ' ';
        const splitLiteralAcrossBoundary = `${prefixBeforeBoundary}mcp_sess_${'\n'.repeat(8_000)}splitAcrossWindowSecret987654321`;
        const b64Bearer = Buffer.from(liveBearer, 'utf8').toString('base64');
        const splitB64AcrossBoundary = `${prefixBeforeBoundary}${b64Bearer.slice(0, 12)}${'\n'.repeat(8_000)}${b64Bearer.slice(12)}`;

        // Item 4a: visitKey collision probe — decoy blob and secret blob share identical length, first 128 chars, and last 64 chars
        const sharedPrefix160 = 'P'.repeat(160);
        const sharedSuffix96 = 'S'.repeat(96);
        const innerSecretB64 = Buffer.from(liveBearer, 'utf8').toString('base64');
        const innerDecoyB64 = 'D'.repeat(innerSecretB64.length);
        const outerDecoyPayload = `${sharedPrefix160} ${innerDecoyB64} ${sharedSuffix96}`;
        const outerSecretPayload = `${sharedPrefix160} ${innerSecretB64} ${sharedSuffix96}`;
        expect(outerDecoyPayload.length).toBe(outerSecretPayload.length);
        expect(outerDecoyPayload.slice(0, 128)).toBe(outerSecretPayload.slice(0, 128));
        expect(outerDecoyPayload.slice(-64)).toBe(outerSecretPayload.slice(-64));
        const visitKeyCollisionProbe = `${Buffer.from(outerDecoyPayload, 'utf8').toString('base64')} ${Buffer.from(
            outerSecretPayload,
            'utf8',
        ).toString('base64')}`;

        // Item 4b: base64 of a binary prefix (> 512 bytes with NUL/control/high bytes) plus a credential
        const binaryPrefix600 = Buffer.alloc(600);
        for (let i = 0; i < binaryPrefix600.length; i++) {
            binaryPrefix600[i] = i % 2 === 0 ? 0x00 : (i * 73) & 0xff;
        }
        const binaryPlusLiteralB64 = Buffer.concat([
            binaryPrefix600,
            Buffer.from(` ${liveBearer} `, 'utf8'),
        ]).toString('base64');
        const binaryPlusNestedB64 = Buffer.concat([
            binaryPrefix600,
            Buffer.from(` token_blob=${innerSecretB64} `, 'utf8'),
        ]).toString('base64');

        const probes: Record<string, string> = {
            split_literal_8000_newlines_across_boundary: splitLiteralAcrossBoundary,
            split_b64_8000_newlines_across_boundary: splitB64AcrossBoundary,
            visit_key_same_shape_decoy_collision: visitKeyCollisionProbe,
            binary_prefix_600b_plus_literal_cred: binaryPlusLiteralB64,
            binary_prefix_600b_plus_nested_b64_cred: binaryPlusNestedB64,
        };

        for (const [label, payload] of Object.entries(probes)) {
            expect(containsEncodedOrRawSecret(payload), `must catch ${label}`).toBe(true);
            const redacted = redactCredentialString(payload);
            expect(redacted, `must redact ${label}`).not.toContain(liveBearer);
            expect(redacted, `must redact ${label}`).not.toContain('splitAcrossWindowSecret987654321');

            const fName = `${label}.txt`;
            fs.writeFileSync(path.join(hostWorkspace, fName), payload, 'utf8');
            const res = await router.execute(
                'artifact_register',
                attachTrustedOwnerIngressProof(
                    {
                        sessionId: 'sess-r9-failopens',
                        path: fName,
                        title: `Fail-open probe ${label}`,
                    },
                    ownerProof,
                ),
                'standalone',
                { ownerVerified: true, ownerProof },
            );
            expect(res.success, `artifact_register must refuse ${label}`).toBe(false);
            expect(res.code).toBe('secret_file_refused');
        }
    });

    it('Item 6 (LOW residual d): one-time idempotent migration removes bogus Round 6/7 pairing host records while preserving genuine pairing records', async () => {
        const configDir = process.env.ADHDEV_CONFIG_DIR!;
        const hostRecordsPath = path.join(configDir, 'mesh-host-records.json');

        const bogusPeerId = 'daemon_mach_b0905b0905b0905b0905b0905b0905b0';
        const genuineHostId = 'daemon_mach_9e019e019e019e019e019e019e019e01';
        const firstDispatchCoordinatorId = 'daemon_mach_c00dc00dc00dc00dc00dc00dc00dc00d';
        const bogusKey = getHostOriginGrantPublicKey(bogusPeerId);
        const genuineKey = getHostOriginGrantPublicKey(genuineHostId);

        // Set up a genuine member peer secret backing 'mesh-genuine-v1' -> genuineHostId
        putPeerSecret({
            meshId: 'mesh-genuine-v1',
            peerDaemonId: genuineHostId,
            role: 'member',
            secret: mintPeerSecret(),
            hostAddress: '127.0.0.1:3847',
            originGrantPublicKey: genuineKey,
            createdAt: new Date().toISOString(),
        });

        // Write a pre-Round-9 (version: 1) mesh-host-records.json containing:
        // 1) 'mesh-bogus-r6': a bogus 'pairing' record created by Round 6/7 handshake (no backing pairing!)
        // 2) 'mesh-genuine-v1': a genuine pre-Round-9 'pairing' record backed by mesh-peer-secrets.json (role: 'member')
        fs.writeFileSync(
            hostRecordsPath,
            JSON.stringify(
                {
                    version: 1,
                    meshes: {
                        'mesh-bogus-r6': {
                            meshId: 'mesh-bogus-r6',
                            hostDaemonId: bogusPeerId,
                            source: 'pairing',
                            recordedAt: '2026-10-23T00:00:00.000Z',
                            originGrantPublicKey: bogusKey,
                        },
                        'mesh-genuine-v1': {
                            meshId: 'mesh-genuine-v1',
                            hostDaemonId: genuineHostId,
                            source: 'pairing',
                            recordedAt: '2026-10-23T00:00:00.000Z',
                            originGrantPublicKey: genuineKey,
                        },
                    },
                },
                null,
                2,
            ),
            'utf8',
        );

        // Reading or migrating removes 'mesh-bogus-r6' and preserves 'mesh-genuine-v1'
        expect(readMeshHostRecord('mesh-bogus-r6')).toBeNull();
        expect(readMeshHostRecord('mesh-genuine-v1')).toMatchObject({
            meshId: 'mesh-genuine-v1',
            hostDaemonId: genuineHostId,
            source: 'pairing',
            originGrantPublicKey: genuineKey,
            pairingVerified: true,
        });

        // Idempotency: running migrateBogusPairingHostRecords again removes nothing and keeps 'mesh-genuine-v1'
        const secondRun = migrateBogusPairingHostRecords(configDir);
        expect(secondRun).toEqual({ removed: [], kept: ['mesh-genuine-v1'] });

        // Verify all 3 symptoms of bogus 'pairing' record are resolved:
        // (1) listMeshHostRecords no longer includes bogusPeerId -> mesh-sender gate rejects bogusPeerId for any_member_mesh command
        expect(listMeshHostRecords().map((r) => r.meshId)).toEqual(['mesh-genuine-v1']);
        const router = new DaemonCommandRouter(hostDeps);
        const bogusRestartAttempt: any = await router.execute(
            'restart_daemon_node',
            {
                _meshDirectDispatch: true,
                [MESH_SENDER_DAEMON_ID_ARG]: bogusPeerId,
            },
            'mesh',
        );
        expect(bogusRestartAttempt.success).toBe(false);
        expect(bogusRestartAttempt.code).toBe('mesh_sender_not_on_roster');

        // (2) readAuthenticatedPeerOriginGrantPublicKey no longer falls back to the bogus record
        expect(readAuthenticatedPeerOriginGrantPublicKey('mesh-bogus-r6', bogusPeerId)).toBeNull();
        expect(readAuthenticatedPeerOriginGrantPublicKey('mesh-genuine-v1', genuineHostId)).toBe(genuineKey);

        // (3) 'mesh-bogus-r6' is no longer blocked from recording first_dispatch or session_stamp host records
        expect(writeMeshHostRecord('mesh-bogus-r6', firstDispatchCoordinatorId, 'first_dispatch')).toBe(true);
        expect(readMeshHostRecord('mesh-bogus-r6')).toMatchObject({
            meshId: 'mesh-bogus-r6',
            hostDaemonId: firstDispatchCoordinatorId,
            source: 'first_dispatch',
        });

        // (4) Real pairing flow through join_mesh_host_pairing (mesh-host-pairing.ts:455/461) writes pairingVerified: true and survives migration
        const hostMesh = createMesh({
            name: 'Host Mesh',
            repoIdentity: 'repo:neutral/fixture-host',
            hostDaemonId: genuineHostId,
        });
        const { token } = createMeshHostPairingToken(hostMesh.id, { token: 'mhj_round9_real_pairing_token' })!;
        const memberDaemonId = 'daemon_mach_ce4be9ce4be9ce4be9ce4be9';
        const memberMesh = createMesh({
            name: 'Member Mesh',
            repoIdentity: 'repo:neutral/fixture-member',
            hostDaemonId: memberDaemonId,
        });
        configureMeshHostPairing(memberMesh.id, {
            hostAddress: '127.0.0.1:3847',
            token,
        });

        function createMeshLookup(id: string) {
            const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'meshes.json'), 'utf8'));
            return raw.meshes.find((m: any) => m.id === id);
        }

        const fakeCtx: any = {
            deps: {
                statusInstanceId: memberDaemonId,
                dispatchMeshCommand: async (_target: string, cmd: string, args: any) => {
                    expect(cmd).toBe('apply_mesh_host_join');
                    const hostCtx: any = {
                        deps: { statusInstanceId: genuineHostId },
                        getMeshForCommand: async () => ({ mesh: createMeshLookup(hostMesh.id) ?? hostMesh, inline: false }),
                        getCachedInlineMesh: () => createMeshLookup(hostMesh.id) ?? hostMesh,
                        invalidateAggregateMeshStatus: () => {},
                    };
                    return meshHostPairingHandlers.apply_mesh_host_join(hostCtx, args);
                },
            },
            getMeshForCommand: async () => ({ mesh: createMeshLookup(memberMesh.id) ?? memberMesh, inline: false }),
            getCachedInlineMesh: (_id: string, m: any) => m,
            invalidateAggregateMeshStatus: () => {},
        };

        const joinRes: any = await meshHostPairingHandlers.join_mesh_host_pairing(fakeCtx, {
            meshId: memberMesh.id,
            hostMeshId: hostMesh.id,
            hostDaemonId: genuineHostId,
            token,
            memberNode: {
                id: 'node-member',
                workspace: hostWorkspace,
                daemonId: memberDaemonId,
            },
        });
        expect(joinRes.success).toBe(true);
        expect(readMeshHostRecord(memberMesh.id)).toMatchObject({
            meshId: memberMesh.id,
            hostDaemonId: genuineHostId,
            source: 'pairing',
            pairingVerified: true,
        });
        expect(readMeshHostRecord(hostMesh.id)).toMatchObject({
            meshId: hostMesh.id,
            hostDaemonId: genuineHostId,
            source: 'pairing',
            pairingVerified: true,
        });
        const postJoinMigration = migrateBogusPairingHostRecords(configDir);
        expect(postJoinMigration.removed).toEqual([]);
        expect(readMeshHostRecord(memberMesh.id)?.source).toBe('pairing');
        expect(readMeshHostRecord(hostMesh.id)?.source).toBe('pairing');
    });

    it('Nit 1 & Nit 2: 5+ missed rotations return explicit re_pair_required code and message, and clearAuthenticatedPeerOriginGrantPublicKey stages and clears all stores atomically', async () => {
        const meshId = 'mesh-r9-missed-5-rotations';
        const hostId = 'daemon_mach_77778888777788887777888877778888';
        const originId = 'daemon_mach_99990000999900009999000099990000';

        // Pin K0 on origin for hostId
        const k0 = getHostOriginGrantPublicKey(hostId);
        putPeerSecret({
            meshId,
            peerDaemonId: hostId,
            role: 'member',
            secret: mintPeerSecret(),
            originGrantPublicKey: k0,
            createdAt: new Date().toISOString(),
        });
        writeMeshHostRecord(meshId, hostId, 'pairing', k0, { pairingVerified: true });

        // Rotate host key 5 times (K0 -> K1 -> K2 -> K3 -> K4 -> K5)
        for (let i = 0; i < MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH + 1; i++) {
            rotateHostOriginGrantKeyPair(hostId);
        }
        const chain5 = getHostKeyRotationChain(hostId);
        expect(chain5).toHaveLength(MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH);

        // 1) verifyOriginGrantKeyRotationChain returns explicit re_pair_required code and message
        const chainRes = verifyOriginGrantKeyRotationChain(
            { rotationChain: chain5 },
            { hostDaemonId: hostId, currentPinnedPublicKey: k0 },
        );
        expect(chainRes.ok).toBe(false);
        if (!chainRes.ok) {
            expect(chainRes.reason).toBe('re_pair_required');
            expect(chainRes.code).toBe('re_pair_required');
            expect(chainRes.error).toMatch(/re-pair required/i);
        }

        // 2) applyAuthenticatedHostKeyRotation surfaces re_pair_required
        const applyRes = applyAuthenticatedHostKeyRotation({
            meshId,
            hostDaemonId: hostId,
            currentPinnedPublicKey: k0,
            rotationChain: chain5,
        });
        expect(applyRes.ok).toBe(false);
        if (!applyRes.ok) {
            expect(applyRes.reason).toBe('re_pair_required');
            expect(applyRes.code).toBe('re_pair_required');
            expect(applyRes.error).toMatch(/re-pair required/i);
        }

        // 3) verifyArtifactOriginFetchGrant surfaces re_pair_required when grant carries 5+-rotated chain against K0 pin
        const nowMs = Date.now();
        const grantAfter5 = mintArtifactOriginFetchGrant({
            meshId,
            hostDaemonId: hostId,
            originDaemonId: originId,
            artifactId: 'art-r9-5rot',
            requesterSessionId: 'sess-r9-worker',
            requesterTaskId: 'task-r9',
            requesterAttemptId: 'att-r9',
            nowMs,
        });
        const verifyGrantRes = verifyArtifactOriginFetchGrant(
            grantAfter5,
            {
                meshId,
                hostDaemonId: hostId,
                originDaemonId: originId,
                artifactId: 'art-r9-5rot',
                requesterSessionId: 'sess-r9-worker',
                requesterTaskId: 'task-r9',
                requesterAttemptId: 'att-r9',
                hostPublicKey: k0,
            },
            nowMs,
        );
        expect(verifyGrantRes.ok).toBe(false);
        if (!verifyGrantRes.ok) {
            expect(verifyGrantRes.reason).toBe('re_pair_required');
            expect(verifyGrantRes.code).toBe('re_pair_required');
            expect(verifyGrantRes.error).toMatch(/re-pair required/i);
        }

        // 4) Clear removes the pinned key across all stores with no leftover .tmp files
        clearAuthenticatedPeerOriginGrantPublicKey(meshId, hostId);
        expect(readAuthenticatedPeerOriginGrantPublicKey(meshId, hostId)).toBeNull();
        expect(readMeshHostRecord(meshId)?.originGrantPublicKey).toBeUndefined();
        expect(getPeerSecret(meshId, hostId)?.originGrantPublicKey).toBeUndefined();
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId, hostDaemonId: hostId })).toBe('');
        const configFiles = fs.readdirSync(process.env.ADHDEV_CONFIG_DIR!);
        expect(configFiles.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
});
