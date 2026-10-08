/**
 * Meshes this daemon is a MEMBER of without a meshes.json record of its own
 * (assistant/member-meshes.ts) — the cloud member case (live defect
 * 2026-10-09: an assistant on a Linux member listed `{projects: []}` although
 * the daemon was a node of a mesh hosted on another machine).
 *
 * The member's evidence is the router's inline mesh cache (the host's own
 * record), the persisted mesh-host records and the persisted node-state push
 * subscriptions. Those meshes must list as `hosting: remote` projects under the
 * HOST's mesh id and relay to the host over the mesh transport.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import {
    collectMemberMeshes,
    resetMemberMeshDescriptorsForTests,
    setAssistantMemberMeshSource,
} from '../../src/assistant/member-meshes.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { preloadAssistantProjectReaders, setAssistantRelayHooks } from '../../src/assistant/assistant-project-ports.js';
import { assistantProjectHandlers } from '../../src/commands/high-family/assistant.js';

const HOST_CORE = 'mach_4462a75330c548be9c2e74dd9f7f6ffb';
const SELF_CORE = 'mach_4682cb891bf84e27859623b83bdbbaac';
const SELF = `daemon_${SELF_CORE}`;
const HOST = `daemon_${HOST_CORE}`;
const MESH = 'mesh_271444af883843e9b36c67155b87b22f';

/** The host's own meshes.json record, as it arrives in `inlineMesh` (node ids in the bare `mach_` form). */
function hostRecord(): Record<string, unknown> {
    return {
        id: MESH,
        name: 'adhdev-cloud-mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        meshHost: { role: 'host', hostDaemonId: HOST_CORE },
        policy: {},
        coordinator: {},
        nodes: [
            { id: 'node_mac', workspace: '/Users/v/adhdev', daemonId: HOST_CORE, machineNickname: 'mac-studio', role: 'host' },
            { id: 'node_f289402a016548388cae3db962527439', workspace: '/home/vilmire/adhdev', daemonId: SELF_CORE, machineNickname: 'jupiter' },
        ],
    };
}

describe('collectMemberMeshes', () => {
    it('a cached inline record listing this daemon becomes a member entry hosted by the declared host (mach_ vs daemon_mach_ forms)', () => {
        const [m, ...rest] = collectMemberMeshes({
            selfDaemonId: SELF, configMeshIds: new Set(), inlineMeshes: [hostRecord()], hostRecords: [], pushTargets: [],
        });
        expect(rest).toEqual([]);
        expect(m).toMatchObject({
            id: MESH, name: 'adhdev-cloud-mesh', repoIdentity: 'github.com/vilmire/adhdev',
            meshHost: { role: 'member', hostDaemonId: HOST_CORE },
        });
        expect(m!.nodes).toHaveLength(2);
    });

    it('skips meshes.json meshes, a cached record this daemon is not on, and a mesh this daemon hosts', () => {
        const foreign = { ...hostRecord(), id: 'mesh_foreign', nodes: [{ id: 'n', workspace: '/w', daemonId: HOST_CORE, role: 'host' }] };
        const selfHosted = { ...hostRecord(), id: 'mesh_self', meshHost: { role: 'host', hostDaemonId: SELF } };
        expect(collectMemberMeshes({
            selfDaemonId: SELF, configMeshIds: new Set([MESH]), inlineMeshes: [hostRecord(), foreign, selfHosted], hostRecords: [], pushTargets: [],
        })).toEqual([]);
    });

    it('a host record + push subscription alone (restart, cold inline cache) gives a member entry named after the workspace', () => {
        const [m] = collectMemberMeshes({
            selfDaemonId: SELF, configMeshIds: new Set(), inlineMeshes: [],
            hostRecords: [{ meshId: MESH, hostDaemonId: HOST }],
            pushTargets: [{ coordinatorDaemonId: HOST, meshId: MESH, nodeId: 'node_j', workspace: '/home/vilmire/adhdev' }],
        });
        expect(m).toMatchObject({ id: MESH, name: 'adhdev', repoIdentity: '', meshHost: { role: 'member', hostDaemonId: HOST } });
        expect(m!.nodes).toEqual([{ id: 'node_j', workspace: '/home/vilmire/adhdev', daemonId: SELF }]);
    });
});

// ── live inventory + verbs over the default ports ──────────────────────────

const ORIGINAL_CONFIG_DIR = process.env.ADHDEV_CONFIG_DIR;
let tmp: string;
let inline: unknown[];
let dispatch: ReturnType<typeof vi.fn>;
let hostAnswers: Record<string, (args: any) => unknown>;

const ctx = () => ({
    components: () => ({ statusInstanceId: SELF }) as any,
    execute: vi.fn(async () => ({ success: true })),
    deps: { statusInstanceId: SELF, dispatchMeshCommand: dispatch, getMeshPeerConnectionStatus: () => null },
}) as any;
const run = (verb: string, args: Record<string, unknown> = {}) => assistantProjectHandlers[verb](ctx(), args);

beforeAll(async () => { await preloadAssistantProjectReaders(); });

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'adhdev-member-meshes-'));
    // A cloud member: no meshes.json at all.
    process.env.ADHDEV_CONFIG_DIR = tmp;
    inline = [];
    hostAnswers = {};
    dispatch = vi.fn(async (_daemonId: string, command: string, args: any) => {
        const answer = hostAnswers[command];
        if (!answer) throw new Error('PEER_NOT_CONNECTED');
        return answer(args);
    });
    resetMemberMeshDescriptorsForTests();
    setAssistantServicesForTests(createAssistantServices({ configDir: tmp }));
    setAssistantMemberMeshSource({ selfDaemonId: () => SELF, inlineMeshes: () => inline });
});

afterEach(() => {
    setAssistantMemberMeshSource(null);
    setAssistantServicesForTests(null);
    setAssistantRelayHooks(null);
    resetMemberMeshDescriptorsForTests();
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
});

describe('a member daemon with no meshes.json entry', () => {
    it('lists the cached inline mesh as a remote project and relays project_send to its host under the host mesh id', async () => {
        inline = [hostRecord()];
        const listed: any = await run(ASSISTANT_VERB.projects);
        expect(listed.success).toBe(true);
        expect(listed.projects).toEqual([{
            slug: 'adhdev', meshId: MESH, name: 'adhdev-cloud-mesh', repo: 'github.com/vilmire/adhdev',
            hosting: 'remote', host: 'mac-studio', hostLabel: 'mac-studio', reachability: 'relay', threadOpen: null,
        }]);
        expect(dispatch).not.toHaveBeenCalled();

        hostAnswers.assistant_remote_project = (args) => ({ success: true, result: { status: 'queued', launched: true, coordinatorSessionId: 'coord-1', messageId: `assistant:${MESH}:${args.clientId}`, cursor: null } });
        const remoteSent = vi.fn();
        setAssistantRelayHooks({ remoteSent, openThread: vi.fn() });
        const sent: any = await run(ASSISTANT_VERB.projectSend, { project: 'adhdev', message: 'Fix the flaky test', messageId: 'm1' });
        expect(sent).toMatchObject({ success: true, project: 'adhdev', meshId: MESH, result: { status: 'queued', host: 'mac-studio', via: 'relay', coordinatorSessionId: 'coord-1' } });
        const [target, command, payload] = dispatch.mock.calls.at(-1)!;
        expect(target).toBe(HOST_CORE);
        expect(command).toBe('assistant_remote_project');
        expect(payload).toMatchObject({ meshId: MESH, op: 'send', text: 'Fix the flaky test', clientId: 'm1' });
        expect(remoteSent).toHaveBeenCalledWith(MESH, null);
    });

    it('after a restart (host record + push subscription only) asks the host once for the record, then lists and resolves it by slug', async () => {
        writeFileSync(join(tmp, 'mesh-host-records.json'), JSON.stringify({ version: 1, meshes: { [MESH]: { hostDaemonId: HOST, source: 'session_stamp', recordedAt: '' } } }));
        writeFileSync(join(tmp, 'mesh-node-push-subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [{ coordinatorDaemonId: HOST, meshId: MESH, nodeId: 'node_f289402a016548388cae3db962527439', workspace: '/home/vilmire/adhdev' }] }));
        hostAnswers.get_mesh = (args) => ({ success: true, mesh: args.meshId === MESH ? hostRecord() : null, membershipOnly: true });
        const listed: any = await run(ASSISTANT_VERB.projects);
        expect(listed.projects).toEqual([expect.objectContaining({ slug: 'adhdev', meshId: MESH, name: 'adhdev-cloud-mesh', repo: 'github.com/vilmire/adhdev', hosting: 'remote', host: 'mac-studio', reachability: 'relay' })]);
        expect(dispatch.mock.calls.filter((c) => c[1] === 'get_mesh')).toEqual([[HOST, 'get_mesh', { meshId: MESH, membershipOnly: true }]]);

        hostAnswers.assistant_remote_project = () => ({ success: true, result: { name: 'adhdev-cloud-mesh', machines: [], queue: null } });
        const status: any = await run(ASSISTANT_VERB.projectStatus, { project: 'adhdev' });
        expect(status).toMatchObject({ success: true, project: 'adhdev', meshId: MESH, result: { via: 'relay', host: 'mac-studio' } });
        // the record is held: no second get_mesh
        expect(dispatch.mock.calls.filter((c) => c[1] === 'get_mesh')).toHaveLength(1);
    });

    it('machines on a member list the remote host too, deduped across the mach_ / daemon_mach_ forms', async () => {
        inline = [hostRecord()];
        const listed: any = await run(ASSISTANT_VERB.projects);
        expect(listed.machines.map((m: any) => [m.label, m.self])).toEqual([['jupiter', true], ['mac-studio', false]]);
    });

    it('machines on a member whose host never answered still list the host (from the remote-host resolution), not only "this machine"', async () => {
        writeFileSync(join(tmp, 'mesh-host-records.json'), JSON.stringify({ version: 1, meshes: { [MESH]: { hostDaemonId: HOST, source: 'session_stamp' } } }));
        writeFileSync(join(tmp, 'mesh-node-push-subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [{ coordinatorDaemonId: HOST, meshId: MESH, nodeId: 'node_j', workspace: '/home/vilmire/adhdev' }] }));
        const listed: any = await run(ASSISTANT_VERB.projects);
        expect(listed.machines).toHaveLength(2);
        expect(listed.machines[0]).toMatchObject({ label: 'this machine', self: true });
        expect(listed.machines[1]).toMatchObject({ daemonId: HOST, self: false });
        expect(listed.machines[1].label).not.toBe('this machine');
    });

    it('an unreachable host still lists the project (named after the workspace), never as scratch', async () => {
        writeFileSync(join(tmp, 'mesh-host-records.json'), JSON.stringify({ version: 1, meshes: { [MESH]: { hostDaemonId: HOST, source: 'session_stamp' } } }));
        writeFileSync(join(tmp, 'mesh-node-push-subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [{ coordinatorDaemonId: HOST, meshId: MESH, nodeId: 'node_j', workspace: '/home/vilmire/adhdev' }] }));
        const listed: any = await run(ASSISTANT_VERB.projects);
        expect(listed.unmanaged).toEqual([]);
        expect(listed.projects).toEqual([expect.objectContaining({ slug: 'adhdev', meshId: MESH, name: 'adhdev', hosting: 'remote', reachability: 'relay' })]);
    });
});
