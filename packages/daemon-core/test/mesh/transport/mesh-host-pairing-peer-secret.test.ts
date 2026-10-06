/**
 * Pairing extension for the standalone multi-machine mesh
 * (docs/design/2026-10-07-standalone-multi-machine-mesh.md §4.4 steps 1-3, 6).
 *
 * - apply_mesh_host_join (host) mints a per-member peer secret, stores it with
 *   role 'host', and returns it once together with the host's canonical id and
 *   the mesh transport descriptor. A re-join replaces (revokes) the old secret.
 * - Pairing tokens are single use and expire after 10 minutes by default.
 * - join_mesh_host_pairing (member) POSTs to /api/v1/mesh/join (not
 *   /api/v1/command), stores the host's secret with role 'member' and the host
 *   address, and never returns or logs the raw secret.
 * - revoke_mesh_peer removes a secret (removed=false when absent) and is not
 *   reachable over the mesh relay.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    MESH_JOIN_TRANSPORT,
    REDACTED_PEER_SECRET,
    meshHostPairingHandlers,
    normalizeStandaloneHostJoinUrl,
} from '../../../src/commands/med-family/mesh-host-pairing.js';
import { addNode, createMesh, getMesh } from '../../../src/config/mesh-config.js';
import {
    MESH_HOST_PAIRING_TOKEN_TTL_MS,
    applyMeshHostJoinRequest,
    configureMeshHostPairing,
    createMeshHostPairingToken,
} from '../../../src/config/mesh-config-host-pairing.js';
import {
    MESH_PEER_SECRETS_FILE,
    getPeerSecret,
    listPeerSecrets,
    putPeerSecret,
    mintPeerSecret,
    resetPeerSecretsWarningsForTest,
} from '../../../src/mesh/transport/mesh-peer-secrets.js';
import { LOG } from '../../../src/logging/logger.js';
import { getDaemonCommandRegistry } from '../../../src/commands/router.js';

const HOST_CORE = 'mach_00000000000000000000000000000a01';
const MEMBER_CORE = 'mach_00000000000000000000000000000b02';
const HOST_CANON = `daemon_${HOST_CORE}`;
const MEMBER_CANON = `daemon_${MEMBER_CORE}`;

/** Minimal MedFamilyContext double backed by the real meshes.json. */
function makeCtx(opts: { statusInstanceId?: string; dispatchMeshCommand?: (d: string, c: string, a: Record<string, unknown>) => Promise<unknown> } = {}) {
    const inlineMeshCache = new Map<string, any>();
    const ctx: any = {
        inlineMeshCache,
        getCachedInlineMesh: (meshId: string, inlineMesh?: unknown) => {
            if (inlineMesh && typeof inlineMesh === 'object') inlineMeshCache.set(meshId, inlineMesh);
            return inlineMeshCache.get(meshId);
        },
        getMeshForCommand: async (meshId: string) => {
            const mesh = getMesh(meshId);
            return mesh ? { mesh, inline: false, source: 'local_config' } : null;
        },
        invalidateAggregateMeshStatus: () => {},
        deps: {
            ...(opts.statusInstanceId ? { statusInstanceId: opts.statusInstanceId } : {}),
            ...(opts.dispatchMeshCommand ? { dispatchMeshCommand: opts.dispatchMeshCommand } : {}),
        },
    };
    return ctx;
}

let configDir: string;
let previousConfigDir: string | undefined;
let logLines: string[];

beforeEach(() => {
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'mesh-pairing-peer-secret-'));
    process.env.ADHDEV_CONFIG_DIR = configDir;
    resetPeerSecretsWarningsForTest();
    logLines = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(LOG, level).mockImplementation((category: string, msg: string) => { logLines.push(`${category} ${msg}`); });
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
});

function hostMeshWithToken(token: string) {
    const mesh = createMesh({ name: 'host', repoIdentity: 'github.com/acme/peer-secret' });
    createMeshHostPairingToken(mesh.id, { token });
    return mesh;
}

function expectNoSecretInLogs(secret: string) {
    for (const line of logLines) expect(line).not.toContain(secret);
}

describe('apply_mesh_host_join — host side peer secret', () => {
    it('mints a 32-byte secret, stores it under the canonical member id and returns it once with the transport descriptor', async () => {
        const mesh = hostMeshWithToken('tok-host-1');
        const ctx = makeCtx({ statusInstanceId: `standalone_${HOST_CORE}` });

        const res: any = await meshHostPairingHandlers.apply_mesh_host_join(ctx, {
            meshId: mesh.id,
            token: 'tok-host-1',
            memberNode: { workspace: '/member/repo', daemonId: MEMBER_CORE },
        });

        expect(res.success).toBe(true);
        expect(res.code).toBe('mesh_host_join_accepted');
        expect(typeof res.peerSecret).toBe('string');
        expect(Buffer.from(res.peerSecret, 'base64')).toHaveLength(32);
        expect(res.hostDaemonId).toBe(HOST_CANON);
        expect(res.memberDaemonId).toBe(MEMBER_CANON);
        expect(res.meshTransport).toEqual({ wsPath: '/ws/mesh', seqscribePath: '/ws/mesh-seqscribe', protocolVersion: 1 });
        expect(res.meshTransport).toEqual(MESH_JOIN_TRANSPORT);

        const stored = getPeerSecret(mesh.id, `standalone_${MEMBER_CORE}`);
        expect(stored).toMatchObject({ meshId: mesh.id, peerDaemonId: MEMBER_CANON, role: 'host', secret: res.peerSecret });
        expect(stored?.hostAddress).toBeUndefined();

        // The secret lives only in the 0600 secrets file — never meshes.json, never a log line.
        expect(readFileSync(join(configDir, 'meshes.json'), 'utf8')).not.toContain(res.peerSecret);
        expect(readFileSync(join(configDir, MESH_PEER_SECRETS_FILE), 'utf8')).toContain(res.peerSecret);
        expectNoSecretInLogs(res.peerSecret);
    });

    it('a re-join of the same member (fresh token) replaces its secret — the old one is revoked', async () => {
        const mesh = hostMeshWithToken('tok-first');
        const ctx = makeCtx({ statusInstanceId: HOST_CORE });
        const memberNode = { workspace: '/member/repo', daemonId: MEMBER_CORE };

        const first: any = await meshHostPairingHandlers.apply_mesh_host_join(ctx, { meshId: mesh.id, token: 'tok-first', memberNode });
        expect(first.success).toBe(true);

        createMeshHostPairingToken(mesh.id, { token: 'tok-second' });
        const second: any = await meshHostPairingHandlers.apply_mesh_host_join(ctx, {
            meshId: mesh.id,
            token: 'tok-second',
            memberNode: { ...memberNode, daemonId: `daemon_${MEMBER_CORE}` },
        });
        expect(second.success).toBe(true);
        expect(second.peerSecret).not.toBe(first.peerSecret);

        const records = listPeerSecrets().filter((r) => r.meshId === mesh.id);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ peerDaemonId: MEMBER_CANON, role: 'host', secret: second.peerSecret });
    });

    it('a spent token cannot be replayed to mint another secret or overwrite the member', async () => {
        const mesh = hostMeshWithToken('tok-once');
        const ctx = makeCtx({ statusInstanceId: HOST_CORE });
        const accepted: any = await meshHostPairingHandlers.apply_mesh_host_join(ctx, {
            meshId: mesh.id, token: 'tok-once', memberNode: { workspace: '/member/repo', daemonId: MEMBER_CORE },
        });
        expect(accepted.success).toBe(true);

        const replay: any = await meshHostPairingHandlers.apply_mesh_host_join(ctx, {
            meshId: mesh.id, token: 'tok-once', memberNode: { workspace: '/member/repo', daemonId: MEMBER_CORE },
        });
        expect(replay.success).toBe(false);
        expect(replay.code).toBe('mesh_host_join_rejected');
        expect(replay.error).toBe('host pairing token already used');
        expect(replay.peerSecret).toBeUndefined();
        expect(getPeerSecret(mesh.id, MEMBER_CORE)?.secret).toBe(accepted.peerSecret);
        // The host keeps showing the admitted member instead of flipping to "rejected".
        expect(getMesh(mesh.id)?.meshHost?.pairing?.status).toBe('paired');
    });

    it('accepts a join without a member daemon id but issues no secret', async () => {
        const mesh = hostMeshWithToken('tok-anon');
        const res: any = await meshHostPairingHandlers.apply_mesh_host_join(makeCtx({ statusInstanceId: HOST_CORE }), {
            meshId: mesh.id, token: 'tok-anon', memberNode: { workspace: '/member/repo' },
        });
        expect(res.success).toBe(true);
        expect(res.peerSecret).toBeUndefined();
        expect(res.peerSecretSkipped).toBe('member_daemon_id_missing');
        expect(listPeerSecrets()).toEqual([]);
    });

    it('a rejected token issues no secret', async () => {
        const mesh = hostMeshWithToken('tok-good');
        const res: any = await meshHostPairingHandlers.apply_mesh_host_join(makeCtx({ statusInstanceId: HOST_CORE }), {
            meshId: mesh.id, token: 'tok-bad', memberNode: { workspace: '/member/repo', daemonId: MEMBER_CORE },
        });
        expect(res.success).toBe(false);
        expect(res.peerSecret).toBeUndefined();
        expect(listPeerSecrets()).toEqual([]);
    });
});

describe('pairing token lifetime', () => {
    it('defaults to a 10 minute expiry and is refused after it', () => {
        const mesh = createMesh({ name: 'ttl', repoIdentity: 'github.com/acme/ttl' });
        const now = '2026-10-07T00:00:00.000Z';
        const created = createMeshHostPairingToken(mesh.id, { token: 'tok-ttl', now })!;
        expect(MESH_HOST_PAIRING_TOKEN_TTL_MS).toBe(600_000);
        expect(created.expiresAt).toBe('2026-10-07T00:10:00.000Z');

        const late = applyMeshHostJoinRequest(mesh.id, {
            token: 'tok-ttl',
            memberNode: { workspace: '/member/repo', daemonId: MEMBER_CORE },
            now: '2026-10-07T00:10:00.001Z',
        });
        expect(late).toMatchObject({ accepted: false, reason: 'host pairing token expired' });
    });

    it('keeps an explicit expiry', () => {
        const mesh = createMesh({ name: 'ttl2', repoIdentity: 'github.com/acme/ttl2' });
        const created = createMeshHostPairingToken(mesh.id, { token: 'tok-ttl2', expiresAt: '2030-01-01T00:00:00.000Z' })!;
        expect(created.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });
});

function memberMesh(hostAddress: string, token: string) {
    const mesh = createMesh({ name: 'member', repoIdentity: 'github.com/acme/peer-secret-member' });
    addNode(mesh.id, { workspace: '/member/repo', daemonId: MEMBER_CORE, role: 'member' } as any);
    configureMeshHostPairing(mesh.id, { hostAddress, token });
    return mesh;
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('join_mesh_host_pairing — member side', () => {
    it('POSTs the bare join body to <host>/api/v1/mesh/join and stores the host secret with the host address', async () => {
        const mesh = memberMesh('http://100.64.0.7:3847/dashboard', 'tok-http');
        const secret = mintPeerSecret();
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, {
            success: true,
            code: 'mesh_host_join_accepted',
            meshId: 'mesh_on_host',
            node: { id: 'node_member', workspace: '/member/repo', daemonId: MEMBER_CORE },
            tokenId: 'tok_x',
            meshHost: { role: 'host', hostDaemonId: HOST_CORE },
            peerSecret: secret,
            hostDaemonId: HOST_CANON,
            memberDaemonId: MEMBER_CANON,
            meshTransport: MESH_JOIN_TRANSPORT,
        }));
        vi.stubGlobal('fetch', fetchMock);

        const res: any = await meshHostPairingHandlers.join_mesh_host_pairing(makeCtx({ statusInstanceId: MEMBER_CORE }), {
            meshId: mesh.id,
            hostMeshId: 'mesh_on_host',
            token: 'tok-http',
        });

        expect(res.success).toBe(true);
        expect(res.transport).toBe('standalone_http_mesh_join');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://100.64.0.7:3847/api/v1/mesh/join');
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        expect(Object.keys(body).sort()).toEqual(['memberMeshId', 'memberNode', 'meshId', 'token']);
        expect(body).toMatchObject({ meshId: 'mesh_on_host', token: 'tok-http', memberMeshId: mesh.id });
        expect(body.memberNode).toMatchObject({ workspace: '/member/repo', daemonId: MEMBER_CORE });

        // Stored under the HOST's mesh id (the handshake hello names it) and the canonical host id.
        const stored = getPeerSecret('mesh_on_host', HOST_CORE);
        expect(stored).toMatchObject({
            meshId: 'mesh_on_host',
            peerDaemonId: HOST_CANON,
            role: 'member',
            secret,
            hostAddress: 'http://100.64.0.7:3847/dashboard',
        });
        expect(res.peerSecretStored).toBe(true);
        expect(res.peerSecretMeshId).toBe('mesh_on_host');
        expect(res.meshTransport).toEqual(MESH_JOIN_TRANSPORT);

        // The raw secret is consumed, never echoed or logged.
        expect(res.hostResult.peerSecret).toBe(REDACTED_PEER_SECRET);
        expect(JSON.stringify(res)).not.toContain(secret);
        expect(res.manualPairing.description).not.toContain(secret);
        expectNoSecretInLogs(secret);
        expect(readFileSync(join(configDir, 'meshes.json'), 'utf8')).not.toContain(secret);
    });

    it('a host rejection stores nothing and still masks an echoed secret field', async () => {
        const mesh = memberMesh('http://100.64.0.7:3847', 'tok-rejected');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, {
            success: false, code: 'mesh_host_join_rejected', error: 'invalid pairing token', peerSecret: 'should-not-leak',
        })));

        const res: any = await meshHostPairingHandlers.join_mesh_host_pairing(makeCtx({ statusInstanceId: MEMBER_CORE }), {
            meshId: mesh.id, token: 'tok-rejected',
        });
        expect(res.success).toBe(false);
        expect(res.code).toBe('mesh_host_join_rejected');
        expect(JSON.stringify(res)).not.toContain('should-not-leak');
        expect(listPeerSecrets()).toEqual([]);
        expect(getMesh(mesh.id)?.meshHost?.pairing?.status).toBe('pairing');
    });

    it('over mesh_command_dispatch both sides end up holding the same secret', async () => {
        const hostMesh = hostMeshWithToken('tok-dispatch');
        const member = memberMesh('http://100.64.0.7:3847', 'tok-dispatch');
        const hostCtx = makeCtx({ statusInstanceId: HOST_CORE });
        const dispatch = vi.fn(async (_daemonId: string, command: string, args: Record<string, unknown>) => {
            expect(command).toBe('apply_mesh_host_join');
            return meshHostPairingHandlers.apply_mesh_host_join(hostCtx, args);
        });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const res: any = await meshHostPairingHandlers.join_mesh_host_pairing(
            makeCtx({ statusInstanceId: MEMBER_CORE, dispatchMeshCommand: dispatch }),
            { meshId: member.id, hostMeshId: hostMesh.id, hostDaemonId: HOST_CORE, token: 'tok-dispatch' },
        );

        expect(res.success).toBe(true);
        expect(res.transport).toBe('mesh_command_dispatch');
        expect(fetchMock).not.toHaveBeenCalled();
        const hostSide = getPeerSecret(hostMesh.id, MEMBER_CORE);
        const memberSide = getPeerSecret(hostMesh.id, HOST_CORE);
        expect(hostSide?.role).toBe('host');
        expect(memberSide?.role).toBe('member');
        expect(memberSide?.secret).toBe(hostSide?.secret);
        expect(memberSide?.hostAddress).toBe('http://100.64.0.7:3847');
        expect(res.hostResult.peerSecret).toBe(REDACTED_PEER_SECRET);
        expect(JSON.stringify(res)).not.toContain(hostSide!.secret);
        expectNoSecretInLogs(hostSide!.secret);
    });

    it('normalizes ws:// and path-bearing host addresses to the join endpoint', () => {
        expect(normalizeStandaloneHostJoinUrl('ws://10.0.0.2:3847/ws?x=1#y')).toBe('http://10.0.0.2:3847/api/v1/mesh/join');
        expect(normalizeStandaloneHostJoinUrl('wss://host.tail.ts.net/')).toBe('https://host.tail.ts.net/api/v1/mesh/join');
        expect(() => normalizeStandaloneHostJoinUrl('  ')).toThrow('hostAddress required');
    });
});

describe('revoke_mesh_peer', () => {
    it('removes the secret (any id form) and reports removed=false once it is gone', async () => {
        putPeerSecret({ meshId: 'mesh_r', peerDaemonId: MEMBER_CANON, role: 'host', secret: mintPeerSecret(), createdAt: new Date().toISOString() });
        const ctx = makeCtx();

        const first: any = await meshHostPairingHandlers.revoke_mesh_peer(ctx, { meshId: 'mesh_r', peerDaemonId: `standalone_${MEMBER_CORE}` });
        expect(first).toMatchObject({ success: true, removed: true, code: 'mesh_peer_revoked', peerDaemonId: MEMBER_CANON });
        expect(getPeerSecret('mesh_r', MEMBER_CORE)).toBeNull();

        const second: any = await meshHostPairingHandlers.revoke_mesh_peer(ctx, { meshId: 'mesh_r', peerDaemonId: MEMBER_CORE });
        expect(second).toMatchObject({ success: true, removed: false, code: 'mesh_peer_not_paired' });
    });

    it('leaves other meshes and peers alone', async () => {
        putPeerSecret({ meshId: 'mesh_r', peerDaemonId: MEMBER_CANON, role: 'host', secret: mintPeerSecret(), createdAt: new Date().toISOString() });
        putPeerSecret({ meshId: 'mesh_other', peerDaemonId: MEMBER_CANON, role: 'host', secret: mintPeerSecret(), createdAt: new Date().toISOString() });
        const res: any = await meshHostPairingHandlers.revoke_mesh_peer(makeCtx(), { meshId: 'mesh_r', peerDaemonId: MEMBER_CORE });
        expect(res.removed).toBe(true);
        expect(getPeerSecret('mesh_other', MEMBER_CORE)).not.toBeNull();
    });

    it('requires meshId and peerDaemonId', async () => {
        expect(await meshHostPairingHandlers.revoke_mesh_peer(makeCtx(), { peerDaemonId: MEMBER_CORE })).toMatchObject({ success: false, error: 'meshId required' });
        expect(await meshHostPairingHandlers.revoke_mesh_peer(makeCtx(), { meshId: 'm' })).toMatchObject({ success: false, error: 'peerDaemonId required' });
    });

    it('is registered as a local operator command — the mesh relay source cannot run it', () => {
        const spec = getDaemonCommandRegistry().get('revoke_mesh_peer');
        expect(spec?.family).toBe('med');
        expect(spec?.sources).toBeDefined();
        expect(spec?.sources).not.toContain('mesh');
        expect(spec?.sources).toContain('standalone');
    });
});

describe('get_mesh_host_pairing — address candidates', () => {
    it('returns ip:port candidates when the runtime knows its listen address', async () => {
        const mesh = hostMeshWithToken('tok-candidates');
        const ctx = makeCtx({ statusInstanceId: `standalone_${HOST_CORE}` });
        ctx.deps.getMeshListenAddress = () => ({ host: '0.0.0.0', port: 3847 });
        const res: any = await meshHostPairingHandlers.get_mesh_host_pairing(ctx, { meshId: mesh.id });
        expect(res.success).toBe(true);
        expect(Array.isArray(res.addressCandidates)).toBe(true);
        for (const candidate of res.addressCandidates) expect(candidate).toMatch(/^\d+\.\d+\.\d+\.\d+:3847$/);
        expect(res.bindWarning).toBeUndefined();
    });

    it('flags a loopback-only bind with an empty list', async () => {
        const mesh = hostMeshWithToken('tok-loopback');
        const ctx = makeCtx({ statusInstanceId: `standalone_${HOST_CORE}` });
        ctx.deps.getMeshListenAddress = () => ({ host: '127.0.0.1', port: 3847 });
        const res: any = await meshHostPairingHandlers.get_mesh_host_pairing(ctx, { meshId: mesh.id });
        expect(res.addressCandidates).toEqual([]);
        expect(res.bindWarning).toBe('loopback_only');
    });

    it('omits the fields when the listen address is unknown (cloud / embedders)', async () => {
        const mesh = hostMeshWithToken('tok-unknown');
        const res: any = await meshHostPairingHandlers.get_mesh_host_pairing(makeCtx(), { meshId: mesh.id });
        expect(res.success).toBe(true);
        expect('addressCandidates' in res).toBe(false);
        expect('bindWarning' in res).toBe(false);
    });
});

describe('manual pairing — address + code only (dashboard card flow)', () => {
    it('accepts a bare ip:port host address and joins over HTTP even when a mesh dispatch exists', async () => {
        const mesh = memberMesh('192.168.1.5:3847', 'tok-bare');
        expect(getMesh(mesh.id)?.meshHost?.hostAddress).toBe('192.168.1.5:3847');
        const dispatch = vi.fn();
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, {
            success: true,
            code: 'mesh_host_join_accepted',
            meshId: 'mesh_on_host',
            node: { id: 'node_member', workspace: '/member/repo', daemonId: MEMBER_CORE },
            meshHost: { role: 'host', hostDaemonId: HOST_CORE },
            peerSecret: mintPeerSecret(),
            hostDaemonId: HOST_CANON,
        }));
        vi.stubGlobal('fetch', fetchMock);
        const res: any = await meshHostPairingHandlers.join_mesh_host_pairing(
            makeCtx({ statusInstanceId: `standalone_${MEMBER_CORE}`, dispatchMeshCommand: dispatch }),
            { meshId: mesh.id, token: 'tok-bare' },
        );
        expect(res.success).toBe(true);
        expect(res.transport).toBe('standalone_http_mesh_join');
        expect(dispatch).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.1.5:3847/api/v1/mesh/join');
        expect(getPeerSecret('mesh_on_host', HOST_CORE)?.hostAddress).toBe('192.168.1.5:3847');
    });

    it('rejects a garbage host address at configure time', () => {
        const mesh = createMesh({ name: 'garbage', repoIdentity: 'github.com/acme/garbage' });
        expect(() => configureMeshHostPairing(mesh.id, { hostAddress: 'not a host', token: 't' })).toThrow(/hostAddress must be host:port/);
        expect(() => configureMeshHostPairing(mesh.id, { hostAddress: 'ftp://h:1', token: 't' })).toThrow(/hostAddress must be host:port/);
    });

    it('host resolves its mesh from the pairing token when the member names an unknown mesh id', async () => {
        const hostMesh = hostMeshWithToken('tok-resolve');
        const res: any = await meshHostPairingHandlers.apply_mesh_host_join(makeCtx({ statusInstanceId: `standalone_${HOST_CORE}` }), {
            meshId: 'mesh_the_member_named',
            token: 'tok-resolve',
            memberNode: { workspace: '/member/repo', daemonId: MEMBER_CORE },
        });
        expect(res.success).toBe(true);
        expect(res.meshId).toBe(hostMesh.id);
        expect(getPeerSecret(hostMesh.id, MEMBER_CORE)?.role).toBe('host');

        // An unknown mesh id with a token no mesh holds is still "not found".
        const miss: any = await meshHostPairingHandlers.apply_mesh_host_join(makeCtx({ statusInstanceId: `standalone_${HOST_CORE}` }), {
            meshId: 'mesh_unknown',
            token: 'tok-nobody-minted',
            memberNode: { workspace: '/member/repo', daemonId: MEMBER_CORE },
        });
        expect(miss).toMatchObject({ success: false, error: 'Mesh not found' });
    });
});
