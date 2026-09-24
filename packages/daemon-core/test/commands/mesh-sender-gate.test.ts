/**
 * Mesh sender verification (commands/mesh-sender.ts + the router gate).
 *
 * The sender is read ONLY from the transport-stamped `_meshSenderDaemonId`;
 * every payload id is a claim checked against this daemon's own state. One
 * describe per class: accepted vs refused (spoofed payload id, sender off the
 * roster, sender owning a different node, a non-coordinator peer on a session,
 * missing sender). Then the router wiring: refusal before the handler, one WARN
 * line, sender stripped from non-mesh sources, in-process mesh calls bypass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    evaluateMeshSender,
    MESH_SENDER_DAEMON_ID_ARG,
    readMeshSender,
    type MeshSenderGateDeps,
} from '../../src/commands/mesh-sender.js';
import { MESH_SENDER_DAEMON_ID_ARG as WORKER_REPORT_REEXPORT } from '../../src/commands/low-family/worker-report.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { LOG } from '../../src/logging/logger.js';

const SELF = 'daemon_mach_self0001';
const COORD = 'daemon_mach_coord0001';
const WORKER = 'daemon_mach_worker0001';
const OTHER = 'daemon_mach_other0001';
const MESH = 'mesh_gate_1';

function roster(extra: Record<string, unknown> = {}) {
    return {
        id: MESH,
        nodes: [
            { id: 'node-coord', workspace: '/w/coord', daemonId: COORD },
            { id: 'node-worker', workspace: '/w/worker', daemonId: WORKER },
            { id: 'node-self', workspace: '/w/self', daemonId: SELF },
        ],
        ...extra,
    };
}

function deps(opts: {
    meshes?: Record<string, any>;
    sessions?: Record<string, Record<string, unknown>>;
    self?: string;
} = {}): MeshSenderGateDeps {
    const meshes = opts.meshes ?? {};
    const sessions = opts.sessions ?? {};
    return {
        selfDaemonId: opts.self ?? SELF,
        getLocalMesh: async (id) => meshes[id] ?? null,
        listLocalMeshes: () => Object.values(meshes),
        getSessionSettings: (id) => sessions[id] ?? null,
        listSessionSettings: () => Object.entries(sessions).map(([sessionId, settings]) => ({ sessionId, settings })),
        resolveForwardEventMeshId: (payload) => (typeof payload.meshId === 'string' ? payload.meshId : ''),
    };
}

const from = (sender: string | undefined, args: Record<string, unknown>) =>
    (sender ? { ...args, [MESH_SENDER_DAEMON_ID_ARG]: sender } : { ...args });

describe('readMeshSender / constant', () => {
    it('reads only the stamped arg; worker-report re-exports the same key', () => {
        expect(WORKER_REPORT_REEXPORT).toBe(MESH_SENDER_DAEMON_ID_ARG);
        expect(readMeshSender({ [MESH_SENDER_DAEMON_ID_ARG]: ` ${COORD} ` })).toBe(COORD);
        expect(readMeshSender({ senderDaemonId: COORD, coordinatorDaemonId: COORD })).toBe('');
        expect(readMeshSender(null)).toBe('');
    });
});

describe('missing sender / missing policy', () => {
    it('refuses mesh_sender_unknown for every class when no sender is stamped', async () => {
        for (const cls of ['roster', 'node_owner', 'session_coordinator', 'any_member_mesh', 'pairing_member', 'authenticated_peer'] as const) {
            const v = await evaluateMeshSender(cls, { meshId: MESH, senderDaemonId: COORD }, deps({ meshes: { [MESH]: roster() } }));
            expect(v).toMatchObject({ ok: false, refusal: 'mesh_sender_unknown' });
        }
    });

    it('refuses mesh_sender_policy_missing for a command without a class', async () => {
        const v = await evaluateMeshSender(undefined, from(COORD, {}), deps());
        expect(v).toMatchObject({ ok: false, refusal: 'mesh_sender_policy_missing' });
    });
});

describe('roster', () => {
    it('accepts a sender on the local roster (any id form)', async () => {
        const v = await evaluateMeshSender('roster', from('mach_worker0001', { meshId: MESH }), deps({ meshes: { [MESH]: roster() } }));
        expect(v).toMatchObject({ ok: true, evidence: `local_roster:${MESH}` });
    });

    it('refuses a sender off the local roster, even when the payload inlineMesh lists it (spoofed roster)', async () => {
        const spoofed = { id: MESH, nodes: [...roster().nodes, { id: 'n-x', daemonId: OTHER }] };
        const v = await evaluateMeshSender('roster', from(OTHER, { meshId: MESH, inlineMesh: spoofed }), deps({ meshes: { [MESH]: roster() } }));
        expect(v).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });

    it('refuses roster_unknown when this daemon holds no roster and the payload carries none', async () => {
        const v = await evaluateMeshSender('roster', from(COORD, { meshId: MESH }), deps());
        expect(v).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
        expect((v as any).detail).toMatch(/roster_unknown/);
    });

    it('accepts a self-consistent payload inlineMesh only when this daemon holds no roster (lists sender AND self)', async () => {
        const ok = await evaluateMeshSender('roster', from(COORD, { meshId: MESH, inlineMesh: roster() }), deps());
        expect(ok).toMatchObject({ ok: true, evidence: `payload_inline_self_consistent:${MESH}` });
        const notUs = { id: MESH, nodes: [{ id: 'node-coord', daemonId: COORD }] };
        const bad = await evaluateMeshSender('roster', from(COORD, { meshId: MESH, inlineMesh: notUs }), deps());
        expect(bad).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
        const otherMesh = await evaluateMeshSender('roster', from(COORD, { meshId: MESH, inlineMesh: { ...roster(), id: 'mesh_other' } }), deps());
        expect(otherMesh).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });

    it('accepts on local session-stamp evidence (the sender coordinates a session of that mesh here)', async () => {
        const v = await evaluateMeshSender('roster', from(COORD, { meshId: MESH }), deps({
            sessions: { s1: { meshNodeFor: MESH, meshCoordinatorDaemonId: COORD } },
        }));
        expect(v).toMatchObject({ ok: true, evidence: `session_stamp:${MESH}` });
    });

    it('accepts the mesh host even without a node of its own', async () => {
        const hosted = { id: MESH, meshHost: { role: 'host', hostDaemonId: OTHER }, nodes: [{ id: 'n', daemonId: WORKER }] };
        const v = await evaluateMeshSender('roster', from(OTHER, { meshId: MESH }), deps({ meshes: { [MESH]: hosted } }));
        expect(v.ok).toBe(true);
    });
});

describe('node_owner (mesh_forward_event)', () => {
    const d = () => deps({ meshes: { [MESH]: roster() } });

    it('accepts the daemon owning the named node', async () => {
        const v = await evaluateMeshSender('node_owner', from(WORKER, { meshId: MESH, nodeId: 'node-worker', event: 'agent:generating_completed' }), d());
        expect(v).toMatchObject({ ok: true });
    });

    it('refuses a roster member reporting about a node another daemon owns', async () => {
        const v = await evaluateMeshSender('node_owner', from(WORKER, { meshId: MESH, nodeId: 'node-coord' }), d());
        expect(v).toMatchObject({ ok: false, refusal: 'mesh_sender_not_node_owner' });
    });

    it('refuses a node the roster does not know, and a mesh this daemon holds no roster for', async () => {
        expect(await evaluateMeshSender('node_owner', from(WORKER, { meshId: MESH, nodeId: 'node-ghost' }), d()))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_node_owner' });
        expect(await evaluateMeshSender('node_owner', from(WORKER, { meshId: 'mesh_unknown', nodeId: 'node-worker' }), d()))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });

    it('matches by workspace when no nodeId is named; falls back to roster membership when neither is', async () => {
        expect(await evaluateMeshSender('node_owner', from(WORKER, { meshId: MESH, workspace: '/w/coord' }), d()))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_node_owner' });
        expect(await evaluateMeshSender('node_owner', from(WORKER, { meshId: MESH, workspace: '/w/worker' }), d()))
            .toMatchObject({ ok: true });
        expect(await evaluateMeshSender('node_owner', from(WORKER, { meshId: MESH, targetSessionId: 's' }), d()))
            .toMatchObject({ ok: true });
        expect(await evaluateMeshSender('node_owner', from(OTHER, { meshId: MESH, targetSessionId: 's' }), d()))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });
});

describe('session_coordinator', () => {
    const sessions = {
        'sess-worker': { meshNodeFor: MESH, meshNodeId: 'node-self', meshCoordinatorDaemonId: COORD },
        'sess-unanchored': { meshNodeFor: MESH, meshNodeId: 'node-self' },
        'sess-user': { cwd: '/home/user' },
        'sess-task': { meshNodeFor: MESH, meshCoordinatorDaemonId: COORD, meshActiveTaskId: 'task-1' },
    };

    it('accepts the stamped coordinator (any id form)', async () => {
        const v = await evaluateMeshSender('session_coordinator', from('mach_coord0001', { targetSessionId: 'sess-worker' }), deps({ sessions }));
        expect(v).toMatchObject({ ok: true, evidence: 'session_anchor:sess-worker' });
    });

    it('refuses a non-coordinator roster peer on a coordinated session', async () => {
        const v = await evaluateMeshSender('session_coordinator', from(WORKER, { targetSessionId: 'sess-worker' }), deps({ sessions, meshes: { [MESH]: roster() } }));
        expect(v).toMatchObject({ ok: false, refusal: 'mesh_sender_not_session_coordinator' });
    });

    it('accepts the mesh host of the session mesh', async () => {
        const hosted = roster({ meshHost: { role: 'host', hostDaemonId: WORKER } });
        const v = await evaluateMeshSender('session_coordinator', from(WORKER, { sessionId: 'sess-worker' }), deps({ sessions, meshes: { [MESH]: hosted } }));
        expect(v).toMatchObject({ ok: true, evidence: `mesh_host:${MESH}` });
    });

    it('refuses to let a mesh peer drive a local user session (no mesh stamp) or a session not live here', async () => {
        expect(await evaluateMeshSender('session_coordinator', from(COORD, { targetSessionId: 'sess-user' }), deps({ sessions })))
            .toMatchObject({ ok: false, refusal: 'mesh_session_not_mesh_owned' });
        expect(await evaluateMeshSender('session_coordinator', from(COORD, { targetSessionId: 'sess-gone' }), deps({ sessions })))
            .toMatchObject({ ok: false, refusal: 'mesh_session_not_mesh_owned' });
    });

    it('agent_command meshContext: a coordinator stamp naming a third daemon is refused', async () => {
        const v = await evaluateMeshSender('session_coordinator', from(COORD, {
            targetSessionId: 'sess-worker',
            meshContext: { meshId: MESH, coordinatorDaemonId: OTHER },
        }), deps({ sessions }));
        expect(v).toMatchObject({ ok: false, refusal: 'mesh_coordinator_stamp_mismatch' });
    });

    it('an unanchored mesh session is bound by the first dispatch that anchors the sender on its own mesh', async () => {
        const ok = await evaluateMeshSender('session_coordinator', from(COORD, {
            targetSessionId: 'sess-unanchored',
            meshContext: { meshId: MESH, coordinatorDaemonId: COORD },
        }), deps({ sessions }));
        expect(ok).toMatchObject({ ok: true, evidence: 'first_binding:sess-unanchored' });
        const wrongMesh = await evaluateMeshSender('session_coordinator', from(COORD, {
            targetSessionId: 'sess-unanchored',
            meshContext: { meshId: 'mesh_other', coordinatorDaemonId: COORD },
        }), deps({ sessions }));
        expect(wrongMesh).toMatchObject({ ok: false, refusal: 'mesh_sender_not_session_coordinator' });
        const noContext = await evaluateMeshSender('session_coordinator', from(COORD, { targetSessionId: 'sess-unanchored' }), deps({ sessions }));
        expect(noContext).toMatchObject({ ok: false, refusal: 'mesh_sender_not_session_coordinator' });
    });

    it('deposit_worker_mailbox: the (meshId, taskId) worker session decides', async () => {
        expect(await evaluateMeshSender('session_coordinator', from(COORD, { meshId: MESH, taskId: 'task-1', text: 'x' }), deps({ sessions })))
            .toMatchObject({ ok: true, evidence: 'session_anchor:sess-task' });
        expect(await evaluateMeshSender('session_coordinator', from(WORKER, { meshId: MESH, taskId: 'task-1', text: 'x' }), deps({ sessions })))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_session_coordinator' });
    });

    it('a sessionless (node-scoped) dispatch needs the sender on the named mesh roster', async () => {
        const ok = await evaluateMeshSender('session_coordinator', from(COORD, { meshContext: { meshId: MESH, coordinatorDaemonId: COORD } }), deps({ meshes: { [MESH]: roster() } }));
        expect(ok.ok).toBe(true);
        const off = await evaluateMeshSender('session_coordinator', from(OTHER, { meshContext: { meshId: MESH, coordinatorDaemonId: OTHER } }), deps({ meshes: { [MESH]: roster() } }));
        expect(off).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
        const none = await evaluateMeshSender('session_coordinator', from(COORD, { cliType: 'claude-cli' }), deps());
        expect(none).toMatchObject({ ok: false, refusal: 'mesh_session_not_mesh_owned' });
    });
});

describe('any_member_mesh', () => {
    it('named mesh: roster membership of THAT mesh', async () => {
        const d = deps({ meshes: { [MESH]: roster(), mesh_b: { id: 'mesh_b', nodes: [{ id: 'b', daemonId: OTHER }] } } });
        expect(await evaluateMeshSender('any_member_mesh', from(COORD, { meshId: MESH, nodeId: 'node-self', force: true }), d)).toMatchObject({ ok: true });
        // OTHER is a member of mesh_b, but the command names MESH.
        expect(await evaluateMeshSender('any_member_mesh', from(OTHER, { meshId: MESH, nodeId: 'node-self', force: true }), d))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });

    it('no mesh named: membership of any mesh this daemon holds', async () => {
        const d = deps({ meshes: { mesh_b: { id: 'mesh_b', nodes: [{ id: 'b', daemonId: OTHER }] } } });
        expect(await evaluateMeshSender('any_member_mesh', from(OTHER, {}), d)).toMatchObject({ ok: true });
        expect(await evaluateMeshSender('any_member_mesh', from(COORD, {}), d)).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
        expect(await evaluateMeshSender('any_member_mesh', from(COORD, {}), deps())).toMatchObject({ ok: false, refusal: 'mesh_sender_not_on_roster' });
    });
});

describe('pairing_member (apply_mesh_host_join)', () => {
    it('the sender must be the daemon the memberNode names', async () => {
        expect(await evaluateMeshSender('pairing_member', from(WORKER, { meshId: MESH, token: 't', memberNode: { daemonId: WORKER } }), deps()))
            .toMatchObject({ ok: true });
        expect(await evaluateMeshSender('pairing_member', from(WORKER, { meshId: MESH, token: 't', memberNode: { daemonId: OTHER } }), deps()))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_join_member' });
        expect(await evaluateMeshSender('pairing_member', from(WORKER, { meshId: MESH, token: 't', memberNode: { workspace: '/w' } }), deps()))
            .toMatchObject({ ok: false, refusal: 'mesh_sender_not_join_member' });
    });
});

// ─── Router wiring ──────────────────────────────────────────────────────────

const ORIGINAL_CONFIG_DIR = process.env.ADHDEV_CONFIG_DIR;
let tmp: string | undefined;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'adhdev-mesh-sender-gate-'));
    process.env.ADHDEV_CONFIG_DIR = tmp;
});
afterEach(() => {
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function createRouter(sessions: Record<string, Record<string, unknown>> = {}) {
    const handleSpec = vi.fn(async (spec: { name: string }, args: Record<string, unknown>) => ({ success: true, ran: spec.name, args }));
    const agentCommand = vi.fn(async (args: Record<string, unknown>) => ({ success: true, ran: 'agent_command', args }));
    const launchCli = vi.fn(async (args: Record<string, unknown>) => ({ success: true, sessionId: 'sess-new', args }));
    const instances = Object.fromEntries(Object.entries(sessions).map(([id, settings]) => [id, {
        getState: () => ({ settings }),
        updateSettings: vi.fn(),
    }]));
    const router = new DaemonCommandRouter({
        commandHandler: { handleSpec, rejectUnknown: vi.fn(async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` })) } as any,
        cliManager: { agentCommand, launchCli } as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: {
            collectAllStates: () => [],
            listInstanceIds: () => Object.keys(instances),
            getInstance: (id: string) => instances[id] ?? null,
        } as any,
        detectedIdes: { value: [] },
        sessionRegistry: { get: () => undefined } as any,
        statusInstanceId: SELF,
    } as any);
    return { router, handleSpec, agentCommand, launchCli };
}

describe('router mesh sender gate', () => {
    it('refuses before the handler runs, with ONE warn line naming the command, sender and refusal', async () => {
        const warn = vi.spyOn(LOG, 'warn');
        const { router, handleSpec } = createRouter({ 'sess-user': {} });
        const result: any = await router.execute('send_keys', {
            targetSessionId: 'sess-user', sequence: ['x'], _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: COORD,
        }, 'mesh');
        expect(result).toMatchObject({ success: false, error: 'mesh_session_not_mesh_owned', code: 'mesh_session_not_mesh_owned' });
        expect(handleSpec).not.toHaveBeenCalled();
        const lines = warn.mock.calls.filter(([tag]) => tag === 'MeshSender');
        expect(lines).toHaveLength(1);
        expect(String(lines[0][1])).toMatch(/send_keys.*daemon_mach_coord0001.*mesh_session_not_mesh_owned/);
    });

    it('runs the handler for the stamped coordinator', async () => {
        const { router, handleSpec } = createRouter({ 'sess-w': { meshNodeFor: MESH, meshCoordinatorDaemonId: COORD } });
        const result: any = await router.execute('read_terminal', {
            targetSessionId: 'sess-w', _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: COORD,
        }, 'mesh');
        expect(result.success).toBe(true);
        expect(handleSpec).toHaveBeenCalledTimes(1);
    });

    it('agent_command re-pointing the coordinator anchor to a third daemon is refused (nothing stamped)', async () => {
        const { router, agentCommand } = createRouter({ 'sess-w': { meshNodeFor: MESH, meshCoordinatorDaemonId: COORD } });
        const result: any = await router.execute('agent_command', {
            targetSessionId: 'sess-w', action: 'send_chat', message: 'hi', _meshDirectDispatch: true,
            meshContext: { meshId: MESH, coordinatorDaemonId: OTHER },
            [MESH_SENDER_DAEMON_ID_ARG]: COORD,
        }, 'mesh');
        expect(result).toMatchObject({ success: false, error: 'mesh_coordinator_stamp_mismatch' });
        expect(agentCommand).not.toHaveBeenCalled();
    });

    it('a relayed mesh command with no stamped sender is refused; an in-process mesh call is not gated', async () => {
        const { router, launchCli } = createRouter();
        const relayed: any = await router.execute('launch_cli', { cliType: 'claude-cli', dir: '/tmp/ws' }, 'mesh');
        expect(relayed).toMatchObject({ success: false, error: 'mesh_sender_unknown' });
        expect(launchCli).not.toHaveBeenCalled();
        const local: any = await router.execute('launch_cli', { cliType: 'claude-cli', dir: '/tmp/ws' }, 'mesh', { inProcess: true });
        expect(local.success).toBe(true);
        expect(launchCli).toHaveBeenCalledTimes(1);
    });

    it('a spoofed sender arg on a non-mesh source is stripped before the handler sees it', async () => {
        const { router, handleSpec } = createRouter();
        await router.execute('read_chat', { targetSessionId: 's', [MESH_SENDER_DAEMON_ID_ARG]: COORD }, 'p2p');
        const seenArgs = handleSpec.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(seenArgs).toBeDefined();
        expect(MESH_SENDER_DAEMON_ID_ARG in seenArgs).toBe(false);
    });

    it('roster-class forwarded worker report: a sender off the owner roster never reaches the handler', async () => {
        const { router } = createRouter();
        router.getCachedInlineMesh(MESH, roster());
        const result: any = await router.execute('worker_report_forwarded', {
            meshId: MESH, sessionId: 's', report: { outcome: 'completed' }, _meshDirectDispatch: true, [MESH_SENDER_DAEMON_ID_ARG]: OTHER,
        }, 'mesh');
        expect(result).toMatchObject({ success: false, error: 'mesh_sender_not_on_roster' });
    });
});
