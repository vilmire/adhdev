import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

/**
 * HOST-PIN-WRITER regression.
 *
 * The dashboard promised that "Launching the coordinator on a connected daemon fixes
 * that daemon as the mesh host (a 1:1 pin)". No code ever wrote that pin: the only
 * writer of `meshHost.hostDaemonId` was `markMeshHostPairingJoined`, which writes
 * `role:'member'` — the JOINING side, the opposite of establishing a host. So a mesh
 * was created with role-only host metadata and stayed pin-less forever, and every peer
 * synthesized itself as host on read (HOST-SELF-SYNTHESIS-GUARD then correctly refused
 * to answer, surfacing this long-standing gap).
 *
 * These tests pin the write side: an explicit set-host mutator that is idempotent and
 * refuses silent reassignment, a create_mesh that marks its creating node role:'host'
 * so new meshes are never born pin-less, and the launch-time idempotent backfill.
 */

const testTmpDir = join(tmpdir(), `adhdev-mesh-host-pin-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine', machineNickname: 'test-nick' }),
}));

import {
    createMesh,
    getMesh,
    addNode,
    setMeshHostPin,
} from '../../src/config/mesh-config.js';
import { resolveMeshHostStatus, requireMeshHostQueueOwner } from '../../src/mesh/mesh-host-ownership.js';
import { recoverMeshIdByCoordinatorAndNode } from '../../src/mesh/mesh-event-forwarding.js';

function configPath(): string {
    return join(testConfigDir, 'meshes.json');
}

function writeRawMeshConfig(config: unknown): void {
    if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function readRawMeshConfig(): any {
    return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

afterEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

const HOST_DAEMON = 'daemon_mach_1b46842a15d3409d96ad33e767a916dd';
const OTHER_DAEMON = 'daemon_mach_84407c5a5e554421b06f1a42fc4ecca9';

describe('setMeshHostPin — the missing host-pin writer', () => {
    it('writes the pin when the mesh has none (the case Launch never covered)', () => {
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'host', pairing: { status: 'not_configured' } },
                nodes: [{ id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON }],
            }],
        });

        const result = setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1' });

        expect(result?.applied).toBe(true);
        expect(result?.meshHost.hostDaemonId).toBe(HOST_DAEMON);
        expect(result?.meshHost.hostNodeId).toBe('node-1');
        expect(result?.meshHost.role).toBe('host');
        // Persisted, not just returned.
        expect(readRawMeshConfig().meshes[0].meshHost.hostDaemonId).toBe(HOST_DAEMON);
        // And the node that now hosts is flagged so the resolver's node-declaration
        // path stays authoritative even for a reader with no pin knowledge.
        expect(readRawMeshConfig().meshes[0].nodes[0].role).toBe('host');
    });

    it('REFUSES to reassign an existing pin to a different daemon without force', () => {
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'host', hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1', pairing: { status: 'not_configured' } },
                nodes: [{ id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON }],
            }],
        });

        const result = setMeshHostPin('mesh_a', { hostDaemonId: OTHER_DAEMON, hostNodeId: 'node-2' });

        expect(result?.applied).toBe(false);
        expect(result?.reason).toBe('host_already_pinned');
        // The stored pin is untouched — no silent re-homing.
        expect(readRawMeshConfig().meshes[0].meshHost.hostDaemonId).toBe(HOST_DAEMON);
        expect(readRawMeshConfig().meshes[0].meshHost.hostNodeId).toBe('node-1');
    });

    it('is a no-op when re-pinned to the SAME daemon (idempotent)', () => {
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'host', hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1', pairing: { status: 'not_configured' } },
                nodes: [{ id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON }],
            }],
        });
        const before = readRawMeshConfig().meshes[0].updatedAt;

        const result = setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1' });

        expect(result?.applied).toBe(false);
        expect(result?.reason).toBe('already_pinned_same');
        expect(result?.meshHost.hostDaemonId).toBe(HOST_DAEMON);
        expect(readRawMeshConfig().meshes[0].updatedAt).toBe(before);
    });

    it('treats equivalent daemon-id FORMS as the same host (canon-identity, not raw compare)', () => {
        // The persisted pin is frequently a config-form id (`mach_…`) while the runtime
        // caller passes `daemon_mach_…`. A raw !== compare would reject the same machine
        // as a reassignment — the recurring canon-identity defect class.
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'host', hostDaemonId: 'mach_1b46842a15d3409d96ad33e767a916dd', pairing: { status: 'not_configured' } },
                nodes: [{ id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON }],
            }],
        });

        const result = setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON });

        expect(result?.applied).toBe(false);
        expect(result?.reason).toBe('already_pinned_same');
    });

    it('allows an explicit force reassignment (operator-initiated re-home)', () => {
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'host', hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1', pairing: { status: 'not_configured' } },
                nodes: [
                    { id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON, role: 'host' },
                    { id: 'node-2', workspace: '/w2', daemonId: OTHER_DAEMON },
                ],
            }],
        });

        const result = setMeshHostPin('mesh_a', { hostDaemonId: OTHER_DAEMON, hostNodeId: 'node-2', force: true });

        expect(result?.applied).toBe(true);
        expect(result?.meshHost.hostDaemonId).toBe(OTHER_DAEMON);
        const nodes = readRawMeshConfig().meshes[0].nodes;
        // The previous host node loses the flag so exactly one node claims role:'host'.
        expect(nodes.find((n: any) => n.id === 'node-1').role).not.toBe('host');
        expect(nodes.find((n: any) => n.id === 'node-2').role).toBe('host');
    });

    it('returns undefined for an unknown mesh', () => {
        writeRawMeshConfig({ meshes: [] });
        expect(setMeshHostPin('nope', { hostDaemonId: HOST_DAEMON })).toBeUndefined();
    });

    it('refuses to pin a host on a mesh this daemon joined as a member', () => {
        // role:'member' means the host lives elsewhere; writing a local host pin here
        // would let a member falsely claim coordinator/queue ownership.
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'member', hostDaemonId: OTHER_DAEMON, pairing: { status: 'paired' } },
                nodes: [{ id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON }],
            }],
        });

        const result = setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, force: true });

        expect(result?.applied).toBe(false);
        expect(result?.reason).toBe('not_host_role');
        expect(readRawMeshConfig().meshes[0].meshHost.hostDaemonId).toBe(OTHER_DAEMON);
    });

    it('makes the resolver report an AUTHORITATIVE (non-synthesized) host after pinning', () => {
        // The whole point: before the pin, a multi-peer mesh resolves to "host unknown"
        // (HOST-SELF-SYNTHESIS-GUARD). After the pin it resolves to the real host for
        // EVERY evaluating daemon, with no synthesis flag.
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'host', pairing: { status: 'not_configured' } },
                nodes: [
                    { id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON },
                    { id: 'node-2', workspace: '/w2', daemonId: OTHER_DAEMON },
                ],
            }],
        });

        const before = resolveMeshHostStatus(getMesh('mesh_a'), { localDaemonId: HOST_DAEMON });
        expect(before.hostDaemonId).toBeUndefined();

        setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1' });

        const fromHost = resolveMeshHostStatus(getMesh('mesh_a'), { localDaemonId: HOST_DAEMON });
        const fromOther = resolveMeshHostStatus(getMesh('mesh_a'), { localDaemonId: OTHER_DAEMON });
        expect(fromHost.hostDaemonId).toBe(HOST_DAEMON);
        expect(fromOther.hostDaemonId).toBe(HOST_DAEMON);
        expect(fromHost.hostSynthesized).toBeFalsy();
        expect(fromOther.hostSynthesized).toBeFalsy();
    });
});

/**
 * The launch-time backfill contract (mesh-coordinator-launch.ts
 * backfillMeshHostPinAfterLaunch). The handler itself needs a full provider/PTY/MCP
 * rig to drive, so these exercise the state transition it performs — pin the
 * coordinator node when unpinned, never touch an existing pin — against real config.
 */
describe('launch-time host pin backfill', () => {
    function meshWithNodes(meshHost: any) {
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost,
                nodes: [
                    { id: 'node-coord', workspace: '/w', daemonId: HOST_DAEMON },
                    { id: 'node-other', workspace: '/w2', daemonId: OTHER_DAEMON },
                ],
            }],
        });
    }

    // Mirrors the handler's guard: back off when a pin already exists, else pin the
    // coordinator node. No force is ever passed.
    function backfill(coordinatorNode: { id: string; daemonId: string }) {
        const mesh: any = getMesh('mesh_a');
        if (mesh?.meshHost?.hostDaemonId) return { skipped: true as const };
        return {
            skipped: false as const,
            result: setMeshHostPin('mesh_a', { hostDaemonId: coordinatorNode.daemonId, hostNodeId: coordinatorNode.id }),
        };
    }

    it('records the pin when the launch happened on an unpinned mesh', () => {
        meshWithNodes({ role: 'host', pairing: { status: 'not_configured' } });

        const outcome = backfill({ id: 'node-coord', daemonId: HOST_DAEMON });

        expect(outcome.skipped).toBe(false);
        expect(getMesh('mesh_a')?.meshHost?.hostDaemonId).toBe(HOST_DAEMON);
        expect(getMesh('mesh_a')?.meshHost?.hostNodeId).toBe('node-coord');
    });

    it('does NOT touch an existing pin when a launch runs on a different node', () => {
        // The re-home hazard: a coordinator launched on node-other must never steal the
        // host from the pinned daemon.
        meshWithNodes({ role: 'host', hostDaemonId: HOST_DAEMON, hostNodeId: 'node-coord', pairing: { status: 'not_configured' } });

        const outcome = backfill({ id: 'node-other', daemonId: OTHER_DAEMON });

        expect(outcome.skipped).toBe(true);
        expect(getMesh('mesh_a')?.meshHost?.hostDaemonId).toBe(HOST_DAEMON);
        expect(getMesh('mesh_a')?.meshHost?.hostNodeId).toBe('node-coord');
    });

    it('is safe to run repeatedly — a second launch changes nothing', () => {
        meshWithNodes({ role: 'host', pairing: { status: 'not_configured' } });
        backfill({ id: 'node-coord', daemonId: HOST_DAEMON });
        const afterFirst = readRawMeshConfig().meshes[0];

        backfill({ id: 'node-coord', daemonId: HOST_DAEMON });

        expect(readRawMeshConfig().meshes[0]).toEqual(afterFirst);
    });

    it('cannot re-home even if the backfill is reached on an already-pinned mesh', () => {
        // Belt-and-braces: even bypassing the handler's own skip guard, the mutator
        // refuses the write because the backfill never passes force.
        meshWithNodes({ role: 'host', hostDaemonId: HOST_DAEMON, hostNodeId: 'node-coord', pairing: { status: 'not_configured' } });

        const result = setMeshHostPin('mesh_a', { hostDaemonId: OTHER_DAEMON, hostNodeId: 'node-other' });

        expect(result?.applied).toBe(false);
        expect(getMesh('mesh_a')?.meshHost?.hostDaemonId).toBe(HOST_DAEMON);
    });

    it('is a no-op against the operator-edited live config shape (manual pin already present)', () => {
        // The owner hand-edited ~/.adhdev/meshes.json to insert a pin + role:'host'
        // node before this fix shipped. That state must survive untouched.
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a',
                name: 'm',
                repoIdentity: 'id_a',
                policy: {},
                meshHost: { role: 'host', hostDaemonId: HOST_DAEMON, hostNodeId: 'node-coord', pairing: { status: 'not_configured' } },
                nodes: [
                    { id: 'node-coord', workspace: '/w', daemonId: HOST_DAEMON, role: 'host' },
                    { id: 'node-other', workspace: '/w2', daemonId: OTHER_DAEMON },
                ],
            }],
        });
        const before = readRawMeshConfig();

        backfill({ id: 'node-coord', daemonId: HOST_DAEMON });
        setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, hostNodeId: 'node-coord' });

        expect(readRawMeshConfig()).toEqual(before);
    });
});

/**
 * Shared-resolver impact. `resolveMeshHostStatus` is read by
 * requireMeshHostMutationOwner (router.ts), recoverMeshIdByCoordinatorAndNode
 * (mesh-event-forwarding.ts) and requireMeshHostQueueOwner. Introducing pins where
 * none existed changes what they see, so the direction of that change is pinned here.
 */
describe('shared resolver consumers after a host pin exists', () => {
    it('keeps mutation-owner gating on role (a pin does not demote the host)', () => {
        // router.requireMeshHostMutationOwner gates on canOwnCoordinator/canOwnQueue,
        // both derived from role — pinning must not flip a host into a refusal.
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a', name: 'm', repoIdentity: 'id_a', policy: {},
                meshHost: { role: 'host', pairing: { status: 'not_configured' } },
                nodes: [{ id: 'node-1', workspace: '/w', daemonId: HOST_DAEMON }],
            }],
        });
        setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1' });

        const status = resolveMeshHostStatus(getMesh('mesh_a'));
        expect(status.canOwnCoordinator).toBe(true);
        expect(status.canOwnQueue).toBe(true);
        expect(() => requireMeshHostQueueOwner({ ownerRole: status.role })).not.toThrow();
    });

    it('narrows anchor recovery to the real host once pinned (was: any anchor matched)', () => {
        // recoverMeshIdByCoordinatorAndNode accepts a mesh when `!host.hostDaemonId`,
        // so a pin-less mesh matched EVERY coordinator anchor. After pinning, only the
        // real host's anchor resolves — a stray anchor no longer claims this mesh.
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a', name: 'm', repoIdentity: 'id_a', policy: {}, coordinator: {},
                meshHost: { role: 'host', pairing: { status: 'not_configured' } },
                nodes: [{ id: 'node-1', workspace: '/w', userOverrides: {}, policy: {}, daemonId: HOST_DAEMON }],
            }],
        });
        // Pre-pin: an unrelated daemon's anchor still resolves this mesh.
        expect(recoverMeshIdByCoordinatorAndNode(OTHER_DAEMON, 'node-1')).toBe('mesh_a');

        setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1' });

        expect(recoverMeshIdByCoordinatorAndNode(HOST_DAEMON, 'node-1')).toBe('mesh_a');
        expect(recoverMeshIdByCoordinatorAndNode(OTHER_DAEMON, 'node-1')).toBe('');
    });

    it('resolves anchor recovery across daemon-id FORMS (canon-identity preserved)', () => {
        writeRawMeshConfig({
            meshes: [{
                id: 'mesh_a', name: 'm', repoIdentity: 'id_a', policy: {}, coordinator: {},
                meshHost: { role: 'host', pairing: { status: 'not_configured' } },
                nodes: [{ id: 'node-1', workspace: '/w', userOverrides: {}, policy: {}, daemonId: HOST_DAEMON }],
            }],
        });
        setMeshHostPin('mesh_a', { hostDaemonId: HOST_DAEMON, hostNodeId: 'node-1' });

        // Worker stamps the bare form; the pin holds the daemon_-prefixed form.
        expect(recoverMeshIdByCoordinatorAndNode('mach_1b46842a15d3409d96ad33e767a916dd', 'node-1')).toBe('mesh_a');
    });
});

describe('createMesh — the creating node is the host', () => {
    it('records the creating daemon as the host pin so a new mesh is never born pin-less', () => {
        writeRawMeshConfig({ meshes: [] });

        const mesh = createMesh({
            name: 'new mesh',
            repoIdentity: 'id_new',
            hostDaemonId: HOST_DAEMON,
        });

        expect(mesh.meshHost?.role).toBe('host');
        expect(mesh.meshHost?.hostDaemonId).toBe(HOST_DAEMON);
        const status = resolveMeshHostStatus(getMesh(mesh.id), { localDaemonId: OTHER_DAEMON });
        // Even a foreign daemon reading it agrees on the host — no synthesis, no guessing.
        expect(status.hostDaemonId).toBe(HOST_DAEMON);
        expect(status.hostSynthesized).toBeFalsy();
    });

    it('flags the first node added by the host daemon as role:host', () => {
        writeRawMeshConfig({ meshes: [] });
        const mesh = createMesh({ name: 'new mesh', repoIdentity: 'id_new', hostDaemonId: HOST_DAEMON });

        const node = addNode(mesh.id, { workspace: '/w', daemonId: HOST_DAEMON });

        expect(node?.role).toBe('host');
        // And the pin's node anchor is backfilled to that node.
        expect(getMesh(mesh.id)?.meshHost?.hostNodeId).toBe(node?.id);
    });

    it('does not flag a node from a different daemon as host', () => {
        writeRawMeshConfig({ meshes: [] });
        const mesh = createMesh({ name: 'new mesh', repoIdentity: 'id_new', hostDaemonId: HOST_DAEMON });

        const node = addNode(mesh.id, { workspace: '/w2', daemonId: OTHER_DAEMON });

        expect(node?.role).not.toBe('host');
    });

    it('still creates a pin-less host mesh when no creating daemon is known (back-compat)', () => {
        writeRawMeshConfig({ meshes: [] });
        const mesh = createMesh({ name: 'anon', repoIdentity: 'id_anon' });
        expect(mesh.meshHost?.role).toBe('host');
        expect(mesh.meshHost?.hostDaemonId).toBeUndefined();
    });
});
