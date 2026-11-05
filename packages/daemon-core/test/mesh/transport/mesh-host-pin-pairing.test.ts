/**
 * Missing host-key pin recovery (rc.50 pairing stream).
 *
 * An authenticated project attach registers the host on the member but cannot
 * carry the host's artifact-signing public key, so every remote artifact fetch
 * was refused with a generic denial. These tests pin the supported recovery:
 *   - the refusal names the exact next step (code host_pin_missing),
 *   - pin_mesh_host_key adds the pin through the host's pairing-code handshake,
 *     only for a member already on the host roster, single use,
 *   - join_mesh_host_pairing never erases a pin the member already holds.
 * Host and member run in one process; the config dir is swapped per side.
 */
import { mkdtempSync, rmSync } from 'fs';
import { saveMeshConfig } from '../../../src/config/mesh-config-store.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    __resetOriginGrantStateForTest,
    authorizeWorkerOriginFetch,
    getHostOriginGrantPublicKey,
    hostPinMissingMessage,
    mintArtifactOriginFetchGrant,
    resolveTrustedHostOriginGrantPublicKey,
} from '../../../src/commands/med-family/artifact-origin-grant.js';
import { meshHostPairingHandlers } from '../../../src/commands/med-family/mesh-host-pairing.js';
import { addNode, createMesh, getMesh } from '../../../src/config/mesh-config.js';
import { configureMeshHostPairing, createMeshHostPairingToken } from '../../../src/config/mesh-config-host-pairing.js';
import { readMeshHostRecord, writeMeshHostRecord } from '../../../src/mesh/mesh-host-memory.js';
import { getPeerSecret } from '../../../src/mesh/transport/mesh-peer-secrets.js';
import { LOG } from '../../../src/logging/logger.js';

const HOST_ID = 'daemon_mach_00000000000000000000000000000a01';
const MEMBER_ID = 'daemon_mach_00000000000000000000000000000b02';

let hostDir: string;
let memberDir: string;
let prev: string | undefined;

const useDir = (dir: string) => { process.env.ADHDEV_CONFIG_DIR = dir; __resetOriginGrantStateForTest(); };

function makeCtx(selfId: string, dispatch?: (d: string, c: string, a: Record<string, unknown>) => Promise<unknown>) {
    const cache = new Map<string, any>();
    return {
        inlineMeshCache: cache,
        getCachedInlineMesh: (id: string, inline?: unknown) => { if (inline) cache.set(id, inline); return cache.get(id); },
        getMeshForCommand: async (id: string) => { const m = getMesh(id); return m ? { mesh: m, inline: false, source: 'local_config' } : null; },
        invalidateAggregateMeshStatus: () => {},
        deps: { statusInstanceId: selfId, ...(dispatch ? { dispatchMeshCommand: dispatch } : {}) },
    } as any;
}

/** Host side: a host mesh with a live token and the (attached) member already on its roster. */
function setupHost(token: string, withMemberNode = true) {
    useDir(hostDir);
    const mesh = createMesh({ name: 'host', repoIdentity: 'github.com/acme/pin-pairing' });
    if (withMemberNode) addNode(mesh.id, { workspace: '/member/managed/checkout', daemonId: MEMBER_ID } as any);
    createMeshHostPairingToken(mesh.id, { token });
    return mesh;
}

/** Dispatch stub: runs the host's apply_mesh_host_join in the host's config dir. */
function hostDispatch() {
    return async (_to: string, command: string, args: Record<string, unknown>) => {
        useDir(hostDir);
        try {
            return await meshHostPairingHandlers[command](makeCtx(HOST_ID), args);
        } finally {
            useDir(memberDir);
        }
    };
}

beforeEach(() => {
    prev = process.env.ADHDEV_CONFIG_DIR;
    hostDir = mkdtempSync(join(tmpdir(), 'pin-host-'));
    memberDir = mkdtempSync(join(tmpdir(), 'pin-member-'));
    for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(LOG, level).mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev;
    __resetOriginGrantStateForTest();
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(memberDir, { recursive: true, force: true });
});

describe('host_pin_missing refusal', () => {
    it('names the exact next step instead of a generic denial', () => {
        useDir(hostDir);
        const grant = mintArtifactOriginFetchGrant({
            meshId: 'mesh_x', hostDaemonId: HOST_ID, originDaemonId: MEMBER_ID, artifactId: 'art_1',
            requesterSessionId: 'sess_1', requesterTaskId: 'task_1', requesterAttemptId: 'att_1',
        });
        useDir(memberDir); // the member holds no pin for the host
        const res: any = authorizeWorkerOriginFetch({
            args: { requesterSessionId: 'sess_1', requesterTaskId: 'task_1', requesterAttemptId: 'att_1', originFetchGrant: grant },
            record: { artifactId: 'art_1' } as any,
            meshIdToVerify: 'mesh_x', hostDaemonId: HOST_ID, selfDaemonId: MEMBER_ID, senderDaemonId: HOST_ID,
            isSelfHost: false, nodes: [], getMeshStore: (() => { throw new Error('unused'); }) as any,
        });
        expect(res.success).toBe(false);
        expect(res.code).toBe('host_pin_missing');
        expect(res.error).toBe(hostPinMissingMessage('mesh_x', HOST_ID));
        expect(res.error).toContain('create a pairing code');
        expect(res.error).toContain('mesh_host_pairing');
    });
});

describe('pin_mesh_host_key', () => {
    it('adds the missing pin for an attached member through the host pairing code, once', async () => {
        const hostMesh = setupHost('code-1');
        useDir(hostDir);
        const hostKey = getHostOriginGrantPublicKey(HOST_ID);
        useDir(memberDir);
        // What ordinary attach leaves behind: a verified host record without a key.
        expect(writeMeshHostRecord(hostMesh.id, HOST_ID, 'pairing', undefined, { pairingVerified: true })).toBe(true);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe('');

        const res: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID, hostDispatch()), { meshId: hostMesh.id, token: 'code-1' });
        expect(res).toMatchObject({ success: true, code: 'mesh_host_pin_applied', pinned: true });
        expect(JSON.stringify(res)).not.toContain(hostKey);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe(hostKey);
        expect(readMeshHostRecord(hostMesh.id)?.originGrantPublicKey).toBe(hostKey);
        expect(getPeerSecret(hostMesh.id, HOST_ID)?.role).toBe('member');

        // The code is spent: a replay is refused and changes nothing.
        const replay: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID, hostDispatch()), { meshId: hostMesh.id, token: 'code-1' });
        expect(replay.success).toBe(false);
        expect(String(replay.error)).toContain('already used');
    });

    it('trusts the host key a verified transfer left in this machine\'s own mesh config', () => {
        const hostMesh = setupHost('code-transfer', false);
        useDir(hostDir);
        const hostKey = getHostOriginGrantPublicKey(HOST_ID);
        useDir(memberDir);
        const writeMember = (meshHost: Record<string, unknown>) => saveMeshConfig({ meshes: [{ ...hostMesh, meshHost }] } as any);

        writeMember({ role: 'member', hostDaemonId: HOST_ID, originGrantPublicKey: hostKey });
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe(hostKey);

        // Pinned for another host: not evidence for this one.
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: 'daemon_mach_ffffffffffffffffffffffffffffffff' })).toBe('');

        // A record that does not say member is not a pin.
        writeMember({ role: 'host', hostDaemonId: HOST_ID, originGrantPublicKey: hostKey });
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe('');

        // A peer-supplied mesh object is never a source for the key.
        writeMember({ role: 'member', hostDaemonId: HOST_ID });
        expect(resolveTrustedHostOriginGrantPublicKey({
            meshId: hostMesh.id,
            hostDaemonId: HOST_ID,
            meshObj: { meshHost: { hostDaemonId: HOST_ID, originGrantPublicKey: hostKey } },
        })).toBe('');
    });

    it('refuses a member that is not on the host roster and does not consume the code or pin anything', async () => {
        const hostMesh = setupHost('code-2', false);
        useDir(memberDir);
        writeMeshHostRecord(hostMesh.id, HOST_ID, 'pairing', undefined, { pairingVerified: true });
        const res: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID, hostDispatch()), { meshId: hostMesh.id, token: 'code-2' });
        expect(res.success).toBe(false);
        expect(String(res.error)).toContain('member_not_on_roster');
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe('');
        useDir(hostDir);
        expect(getMesh(hostMesh.id)?.meshHost?.pairing?.joinedAt).toBeUndefined();
    });

    it('rejects a wrong code and an answer from a machine that is not the recognised host', async () => {
        const hostMesh = setupHost('code-3');
        useDir(memberDir);
        writeMeshHostRecord(hostMesh.id, HOST_ID, 'pairing', undefined, { pairingVerified: true });
        const wrong: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID, hostDispatch()), { meshId: hostMesh.id, token: 'nope' });
        expect(wrong.success).toBe(false);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe('');

        const impostor = async (): Promise<unknown> => ({ success: true, hostDaemonId: 'daemon_mach_ffffffffffffffffffffffffffffffff', originGrantPublicKey: 'x', peerSecret: 'y' });
        const mismatch: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID, impostor), { meshId: hostMesh.id, token: 'code-3' });
        expect(mismatch.code).toBe('mesh_host_pin_identity_mismatch');
    });

    it('tells the user what to do when the member does not know the host or no code was given', async () => {
        useDir(memberDir);
        const noCode: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID), { meshId: 'mesh_a' });
        expect(noCode.code).toBe('mesh_host_pin_token_required');
        const unknown: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID), { meshId: 'mesh_a', token: 't' });
        expect(unknown.code).toBe('mesh_host_unknown');
        expect(unknown.error).toContain('mesh_attach_remote');
    });
});

describe('pin_mesh_host_key relayed by a coordinator tool', () => {
    it('is honoured only from the recorded host, and never dials a peer-supplied address', async () => {
        const hostMesh = setupHost('code-5');
        useDir(memberDir);
        writeMeshHostRecord(hostMesh.id, HOST_ID, 'pairing', undefined, { pairingVerified: true });
        const fetchSpy = vi.fn(async () => { throw new Error('must not dial'); });
        vi.stubGlobal('fetch', fetchSpy);
        const stranger: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID, hostDispatch()), {
            meshId: hostMesh.id, token: 'code-5', _meshSenderDaemonId: 'daemon_mach_cccccccccccccccccccccccccccccccc',
        });
        expect(stranger.code).toBe('mesh_host_pin_sender_not_host');
        const fromHost: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID, hostDispatch()), {
            meshId: hostMesh.id, token: 'code-5', _meshSenderDaemonId: HOST_ID, hostAddress: '203.0.113.9:3847',
        });
        expect(fromHost).toMatchObject({ success: true, transport: 'mesh_command_dispatch' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

/** Address path: the host's real answer, delivered as an HTTP response, optionally edited by a hostile/old peer. */
function httpFromHost(edit?: (body: any) => any) {
    return async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        useDir(hostDir);
        let result: any;
        try { result = await meshHostPairingHandlers.apply_mesh_host_join(makeCtx(HOST_ID), body); } finally { useDir(memberDir); }
        return { ok: true, status: 200, json: async () => (edit ? edit(structuredClone(result)) : result) };
    };
}

describe('pin_mesh_host_key over a typed address (plain HTTP)', () => {
    it('refuses an answer that does not name the host, so the identity check cannot compare the expected id with itself', async () => {
        const hostMesh = setupHost('code-6');
        useDir(memberDir);
        writeMeshHostRecord(hostMesh.id, HOST_ID, 'pairing', undefined, { pairingVerified: true });
        vi.stubGlobal('fetch', httpFromHost(b => { delete b.hostDaemonId; if (b.meshHost) delete b.meshHost.hostDaemonId; return b; }));
        const res: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID), { meshId: hostMesh.id, token: 'code-6', hostAddress: '203.0.113.9:3847' });
        expect(res).toMatchObject({ success: false, code: 'mesh_host_pin_identity_missing' });
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe('');
    });

    it('fills a missing pin when the answer names the host, but never replaces an existing different pin', async () => {
        const hostMesh = setupHost('code-7');
        useDir(hostDir);
        const hostKey = getHostOriginGrantPublicKey(HOST_ID);
        useDir(memberDir);
        writeMeshHostRecord(hostMesh.id, HOST_ID, 'pairing', undefined, { pairingVerified: true });
        vi.stubGlobal('fetch', httpFromHost());
        const ok: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID), { meshId: hostMesh.id, token: 'code-7', hostAddress: '203.0.113.9:3847' });
        expect(ok).toMatchObject({ success: true, pinned: true });
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe(hostKey);

        // A later answer over HTTP offering a different key must not replace the pin.
        useDir(hostDir);
        createMeshHostPairingToken(hostMesh.id, { token: 'code-8' });
        useDir(memberDir);
        const otherDir = mkdtempSync(join(tmpdir(), 'pin-other-'));
        useDir(otherDir);
        const otherKey = getHostOriginGrantPublicKey(HOST_ID);
        useDir(memberDir);
        rmSync(otherDir, { recursive: true, force: true });
        expect(otherKey).not.toBe(hostKey);
        vi.stubGlobal('fetch', httpFromHost(b => { b.originGrantPublicKey = otherKey; if (b.meshHost) b.meshHost.originGrantPublicKey = otherKey; return b; }));
        const swap: any = await meshHostPairingHandlers.pin_mesh_host_key(makeCtx(MEMBER_ID), { meshId: hostMesh.id, token: 'code-8', hostAddress: '203.0.113.9:3847' });
        expect(swap.success).toBe(false);
        expect(swap.code).toBe('mesh_host_pin_key_changed');
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe(hostKey);
    });
});

describe('join_mesh_host_pairing preserves an existing pin', () => {
    it('keeps the pin when the host answers without a key', async () => {
        const hostMesh = setupHost('code-4');
        useDir(hostDir);
        const hostKey = getHostOriginGrantPublicKey(HOST_ID);
        useDir(memberDir);
        const local = createMesh({ name: 'member', repoIdentity: 'github.com/acme/pin-pairing' });
        configureMeshHostPairing(local.id, { hostAddress: '127.0.0.1:3847', token: 'code-4' });
        writeMeshHostRecord(local.id, HOST_ID, 'pairing', hostKey, { pairingVerified: true });
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: local.id, hostDaemonId: HOST_ID })).toBe(hostKey);
        vi.stubGlobal('fetch', async () => ({
            ok: true, status: 200,
            json: async () => ({ success: true, meshId: hostMesh.id, hostDaemonId: HOST_ID, tokenId: 'tok', node: { id: 'n' }, peerSecret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTMyYg==', meshHost: { hostDaemonId: HOST_ID } }),
        }));
        const res: any = await meshHostPairingHandlers.join_mesh_host_pairing(makeCtx(MEMBER_ID), { meshId: local.id, token: 'code-4', hostDaemonId: HOST_ID });
        expect(res.success).toBe(true);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: local.id, hostDaemonId: HOST_ID })).toBe(hostKey);
        expect(resolveTrustedHostOriginGrantPublicKey({ meshId: hostMesh.id, hostDaemonId: HOST_ID })).toBe(hostKey);
    });
});
