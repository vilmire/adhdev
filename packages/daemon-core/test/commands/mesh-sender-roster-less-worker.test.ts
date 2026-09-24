/**
 * rc.42 live regression: the mesh sender gate on a ROSTER-LESS worker daemon.
 *
 * Live flow (2026-09-24): the coordinator's daemon H (mesh host) dispatched a
 * sessionless `agent_command send_chat` to worker daemon W, which has no
 * meshes.json. W had just been upgrade-restarted: its hosted sessions came
 * back with `meshNodeFor` only (session settings are in-memory; the coordinator
 * anchor is not persisted in the session-host record), so the gate found no
 * roster, no stamp, no inline mesh → `mesh_sender_not_on_roster (roster_unknown)`
 * and the owner recorded dispatch_failed.
 *
 * Every case runs through `DaemonCommandRouter.execute(…, 'mesh')` on a router
 * built WITHOUT any roster: the per-mesh host record (mesh/mesh-host-memory.ts)
 * is what survives the restart; pairing writes it, the launch/dispatch that
 * first names its sender as coordinator records it (trust on first use), and
 * a different sender is refused afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MESH_SENDER_DAEMON_ID_ARG, evaluateMeshSender, type MeshSenderGateDeps } from '../../src/commands/mesh-sender.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { readMeshHostRecord, writeMeshHostRecord } from '../../src/mesh/mesh-host-memory.js';
import { LOG } from '../../src/logging/logger.js';

const SELF = 'daemon_mach_workerpc0001';
const HOST = 'daemon_mach_4462host0001';
const OTHER = 'daemon_mach_intruder0001';
const MESH = 'mesh_271444af_regression';

const ORIGINAL_CONFIG_DIR = process.env.ADHDEV_CONFIG_DIR;
let tmp: string | undefined;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'adhdev-mesh-sender-rosterless-'));
    process.env.ADHDEV_CONFIG_DIR = tmp;
});
afterEach(() => {
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/**
 * A worker daemon router with no roster: no meshes.json, no inline cache. The
 * launchCli mock registers a live session carrying the launch settings (what
 * cli-manager does), so a launch's coordinator anchor is visible to the next
 * command exactly as in production.
 */
function workerDaemon(initialSessions: Record<string, Record<string, unknown>> = {}) {
    const instances = new Map<string, { settings: Record<string, unknown> }>();
    for (const [id, settings] of Object.entries(initialSessions)) instances.set(id, { settings: { ...settings } });
    let launched = 0;
    const launchCli = vi.fn(async (args: Record<string, unknown>) => {
        const sessionId = `sess-launched-${++launched}`;
        instances.set(sessionId, { settings: { ...((args.settings as Record<string, unknown>) ?? {}) } });
        return { success: true, sessionId };
    });
    const agentCommand = vi.fn(async (args: Record<string, unknown>) => ({ success: true, ran: 'agent_command', args }));
    const router = new DaemonCommandRouter({
        commandHandler: { handleSpec: vi.fn(async () => ({ success: true })), rejectUnknown: vi.fn(async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` })) } as any,
        cliManager: { agentCommand, launchCli } as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: {
            collectAllStates: () => [],
            listInstanceIds: () => [...instances.keys()],
            getInstance: (id: string) => {
                const inst = instances.get(id);
                if (!inst) return null;
                return {
                    getState: () => ({ settings: inst.settings }),
                    updateSettings: (patch: Record<string, unknown>) => { Object.assign(inst.settings, patch); },
                };
            },
        } as any,
        detectedIdes: { value: [] },
        sessionRegistry: { get: () => undefined } as any,
        statusInstanceId: SELF,
    } as any);
    return { router, launchCli, agentCommand, instances };
}

const relayed = (sender: string, args: Record<string, unknown>) => ({ ...args, _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: sender });

const launchArgs = (coordinator: string) => ({
    cliType: 'claude-cli',
    dir: '/w/mainpc',
    settings: { role: 'worker', meshNodeFor: MESH, meshNodeId: 'node-mainpc', meshCoordinatorDaemonId: coordinator },
});

const sessionlessDispatch = (coordinator: string) => ({
    agentType: 'claude-cli', cliType: 'claude-cli', action: 'send_chat', message: 'task', dir: '/w/mainpc',
    dispatchSource: 'mesh-tools-internal:ipcDispatchToRemoteAgent',
    meshContext: { meshId: MESH, nodeId: 'node-mainpc', taskId: 'task-1', coordinatorDaemonId: coordinator },
});

describe('roster-less worker: pairing record names the host', () => {
    it('launch_cli(meshContext anchor, sender H) → agent_command send_chat (sender H) runs; sender X is refused', async () => {
        writeMeshHostRecord(MESH, HOST, 'pairing');
        const { router, launchCli, agentCommand, instances } = workerDaemon();

        const launch: any = await router.execute('launch_cli', relayed(HOST, launchArgs(HOST)), 'mesh');
        expect(launch.success).toBe(true);
        expect(launchCli).toHaveBeenCalledTimes(1);
        const sessionId = launch.sessionId as string;
        expect(instances.get(sessionId)?.settings.meshCoordinatorDaemonId).toBe(HOST);

        const sessionless: any = await router.execute('agent_command', relayed(HOST, sessionlessDispatch(HOST)), 'mesh');
        expect(sessionless.success).toBe(true);
        const targeted: any = await router.execute('agent_command', relayed(HOST, { ...sessionlessDispatch(HOST), targetSessionId: sessionId }), 'mesh');
        expect(targeted.success).toBe(true);
        expect(agentCommand).toHaveBeenCalledTimes(2);

        const intruderLaunch: any = await router.execute('launch_cli', relayed(OTHER, launchArgs(OTHER)), 'mesh');
        expect(intruderLaunch).toMatchObject({ success: false, code: 'mesh_sender_not_on_roster' });
        const intruderDispatch: any = await router.execute('agent_command', relayed(OTHER, sessionlessDispatch(OTHER)), 'mesh');
        expect(intruderDispatch).toMatchObject({ success: false, code: 'mesh_sender_not_on_roster' });
        const intruderTargeted: any = await router.execute('agent_command', relayed(OTHER, { ...sessionlessDispatch(OTHER), targetSessionId: sessionId }), 'mesh');
        expect(intruderTargeted).toMatchObject({ success: false, code: 'mesh_sender_not_session_coordinator' });
        expect(launchCli).toHaveBeenCalledTimes(1);
        expect(agentCommand).toHaveBeenCalledTimes(2);
        // The pairing record is never replaced by a learned sender.
        expect(readMeshHostRecord(MESH)).toMatchObject({ hostDaemonId: HOST, source: 'pairing' });
    });

    it('a launch whose coordinator anchor names a third daemon is refused (nothing launched)', async () => {
        writeMeshHostRecord(MESH, HOST, 'pairing');
        const { router, launchCli } = workerDaemon();
        const result: any = await router.execute('launch_cli', relayed(HOST, launchArgs(OTHER)), 'mesh');
        expect(result).toMatchObject({ success: false, code: 'mesh_coordinator_stamp_mismatch' });
        expect(launchCli).not.toHaveBeenCalled();
    });

    it('a launch without a coordinator anchor stays open to any authenticated peer', async () => {
        const { router, launchCli } = workerDaemon();
        const result: any = await router.execute('launch_cli', relayed(OTHER, { cliType: 'claude-cli', dir: '/w/x' }), 'mesh');
        expect(result.success).toBe(true);
        expect(launchCli).toHaveBeenCalledTimes(1);
    });
});

describe('roster-less worker: no pairing record, no stamp (the live rc.42 case)', () => {
    it('the first sessionless dispatch naming its sender as coordinator is accepted and records the host; a second sender is refused', async () => {
        const warn = vi.spyOn(LOG, 'warn');
        // A session restored after the upgrade restart: meshNodeFor only.
        const { router, agentCommand } = workerDaemon({ 'sess-restored': { meshNodeFor: MESH, meshNodeId: 'node-mainpc', launchedByCoordinator: true } });

        const first: any = await router.execute('agent_command', relayed(HOST, sessionlessDispatch(HOST)), 'mesh');
        expect(first.success).toBe(true);
        expect(agentCommand).toHaveBeenCalledTimes(1);
        expect(readMeshHostRecord(MESH)).toMatchObject({ hostDaemonId: HOST, source: 'first_dispatch' });
        const learned = warn.mock.calls.filter(([tag, msg]) => tag === 'MeshSender' && /mesh host learned by first dispatch/.test(String(msg)));
        expect(learned).toHaveLength(1);

        const second: any = await router.execute('agent_command', relayed(OTHER, sessionlessDispatch(OTHER)), 'mesh');
        expect(second).toMatchObject({ success: false, code: 'mesh_sender_not_on_roster' });
        expect(String(second.detail)).toMatch(/host on record/);
        const secondTargeted: any = await router.execute('agent_command', relayed(OTHER, { ...sessionlessDispatch(OTHER), targetSessionId: 'sess-restored' }), 'mesh');
        expect(secondTargeted).toMatchObject({ success: false, code: 'mesh_sender_not_session_coordinator' });
        expect(agentCommand).toHaveBeenCalledTimes(1);

        // The learned host keeps working, and only one WARN was ever logged.
        const again: any = await router.execute('agent_command', relayed(HOST, sessionlessDispatch(HOST)), 'mesh');
        expect(again.success).toBe(true);
        expect(warn.mock.calls.filter(([tag, msg]) => tag === 'MeshSender' && /mesh host learned/.test(String(msg)))).toHaveLength(1);
    });

    it('without a meshContext claim there is no first use: roster_unknown is still refused', async () => {
        const { router, agentCommand } = workerDaemon();
        const result: any = await router.execute('agent_command', relayed(HOST, { action: 'send_chat', message: 'x', meshId: MESH }), 'mesh');
        expect(result).toMatchObject({ success: false, code: 'mesh_sender_not_on_roster' });
        expect(String(result.detail)).toMatch(/roster_unknown/);
        expect(agentCommand).not.toHaveBeenCalled();
        expect(existsSync(join(tmp!, 'mesh-host-records.json'))).toBe(false);
    });

    it('no first use while a session of that mesh is anchored to another daemon', async () => {
        const { router } = workerDaemon({ 'sess-a': { meshNodeFor: MESH, meshCoordinatorDaemonId: HOST } });
        const result: any = await router.execute('agent_command', relayed(OTHER, sessionlessDispatch(OTHER)), 'mesh');
        expect(result).toMatchObject({ success: false, code: 'mesh_sender_not_on_roster' });
    });
});

describe('roster-less worker: the host evidence survives a daemon restart', () => {
    it('launch stamps + records the host → restart (fresh router, restored session without the anchor) → host accepted, intruder refused', async () => {
        const before = workerDaemon();
        const launch: any = await before.router.execute('launch_cli', relayed(HOST, launchArgs(HOST)), 'mesh');
        expect(launch.success).toBe(true);
        expect(readMeshHostRecord(MESH)).toMatchObject({ hostDaemonId: HOST });

        // Restart: session settings are in-memory; restore re-applies meshNodeFor /
        // meshNodeId / launchedByCoordinator only (cli-manager restoreHostedSessions).
        const after = workerDaemon({ [launch.sessionId]: { meshNodeFor: MESH, meshNodeId: 'node-mainpc', launchedByCoordinator: true } });
        const targeted: any = await after.router.execute('agent_command', relayed(HOST, { ...sessionlessDispatch(HOST), targetSessionId: launch.sessionId }), 'mesh');
        expect(targeted.success).toBe(true);
        const sessionless: any = await after.router.execute('agent_command', relayed(HOST, sessionlessDispatch(HOST)), 'mesh');
        expect(sessionless.success).toBe(true);
        expect(after.agentCommand).toHaveBeenCalledTimes(2);

        const intruder: any = await after.router.execute('agent_command', relayed(OTHER, { ...sessionlessDispatch(OTHER), targetSessionId: launch.sessionId }), 'mesh');
        expect(intruder).toMatchObject({ success: false, code: 'mesh_sender_not_session_coordinator' });
        const raw = JSON.parse(readFileSync(join(tmp!, 'mesh-host-records.json'), 'utf8'));
        expect(Object.keys(raw.meshes)).toEqual([MESH]);
    });

    it('a pre-change live stamp is migrated to the per-mesh record on its next use', async () => {
        const before = workerDaemon({ 'sess-old': { meshNodeFor: MESH, meshCoordinatorDaemonId: HOST } });
        const ok: any = await before.router.execute('agent_command', relayed(HOST, { ...sessionlessDispatch(HOST), targetSessionId: 'sess-old' }), 'mesh');
        expect(ok.success).toBe(true);
        expect(readMeshHostRecord(MESH)).toMatchObject({ hostDaemonId: HOST, source: 'session_stamp' });
    });
});

describe('any_member_mesh on a roster-less worker (host → worker restart/ff/refine/logs)', () => {
    const d = (records: Record<string, string>): MeshSenderGateDeps => ({
        selfDaemonId: SELF,
        getLocalMesh: async () => null,
        listLocalMeshes: () => [],
        getSessionSettings: () => null,
        listSessionSettings: () => [],
        getMeshHostRecord: (id) => (records[id] ? { hostDaemonId: records[id] } : null),
        listMeshHostRecords: () => Object.entries(records).map(([meshId, hostDaemonId]) => ({ meshId, hostDaemonId })),
    });
    const from = (sender: string, args: Record<string, unknown>) => ({ ...args, [MESH_SENDER_DAEMON_ID_ARG]: sender });

    it('accepts the recorded host for the named mesh and for an unnamed one; refuses others', async () => {
        expect(await evaluateMeshSender('any_member_mesh', from(HOST, { meshId: MESH, nodeId: 'node-mainpc' }), d({ [MESH]: HOST })))
            .toMatchObject({ ok: true, evidence: `mesh_host_record:${MESH}` });
        expect(await evaluateMeshSender('any_member_mesh', from(HOST, {}), d({ [MESH]: HOST })))
            .toMatchObject({ ok: true, evidence: `mesh_host_record:${MESH}` });
        expect(await evaluateMeshSender('any_member_mesh', from(OTHER, { meshId: MESH }), d({ [MESH]: HOST })))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
        expect(await evaluateMeshSender('any_member_mesh', from(OTHER, {}), d({ [MESH]: HOST })))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });

    it('a paired member mesh record with no nodes still names its host (declared meshHost)', async () => {
        const member = { id: MESH, nodes: [], meshHost: { role: 'member', hostDaemonId: HOST, pairing: { status: 'paired' } } };
        const deps: MeshSenderGateDeps = { ...d({}), getLocalMesh: async (id) => (id === MESH ? member : null), listLocalMeshes: () => [member] };
        expect(await evaluateMeshSender('any_member_mesh', from(HOST, { meshId: MESH }), deps)).toMatchObject({ ok: true, evidence: `local_mesh_host:${MESH}` });
        expect(await evaluateMeshSender('any_member_mesh', from(HOST, {}), deps)).toMatchObject({ ok: true, evidence: `local_mesh_host:${MESH}` });
        expect(await evaluateMeshSender('any_member_mesh', from(OTHER, { meshId: MESH }), deps)).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });
});
