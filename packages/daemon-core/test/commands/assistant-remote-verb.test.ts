/**
 * Host side of a remote-hosted assistant project (commands/high-family/assistant-remote.ts;
 * owner decision 2026-10-08): `assistant_remote_project` runs only from the
 * mesh transport, only for a sender on the roster THIS daemon holds for the
 * named mesh, only for a mesh this daemon hosts — and then runs the same local
 * path the host's own assistant would (ensure coordinator → send_chat; ledger
 * turns for the poll; operating-note write). Every case goes through
 * `DaemonCommandRouter.execute` so the sources gate and the mesh-sender gate
 * are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { loadMeshConfig, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts, type CoordinatorTurns } from '../../src/assistant/assistant-project-ports.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import type { AssistantCoordinatorView } from '../../src/assistant/coordinator-lifecycle.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const HOST = 'daemon_mach_host00000001';
const MEMBER = 'daemon_mach_member000001';
const STRANGER = 'daemon_mach_stranger0001';
const MESH = 'mesh_hosted_here';
const OTHER_MESH = 'mesh_hosted_elsewhere';

const ORIGINAL_CONFIG_DIR = process.env.ADHDEV_CONFIG_DIR;
let tmp: string;
let execute: ReturnType<typeof vi.fn>;
let coordinators: AssistantCoordinatorView[];
let turns: CoordinatorTurns;
let record: ReturnType<typeof vi.fn>;
let meshes: LocalMeshEntry[];

function hostMesh(): LocalMeshEntry {
    return {
        id: MESH, name: 'Blog', repoIdentity: 'github.com/acme/blog',
        meshHost: { role: 'host', hostDaemonId: HOST },
        nodes: [
            { id: 'n-host', workspace: '/w/blog', daemonId: HOST, role: 'host' },
            { id: 'n-member', workspace: '/m/blog', daemonId: MEMBER },
        ],
    } as unknown as LocalMeshEntry;
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'adhdev-assistant-remote-verb-'));
    process.env.ADHDEV_CONFIG_DIR = tmp;
    meshes = [hostMesh(), { id: OTHER_MESH, name: 'Other', repoIdentity: 'github.com/acme/other', meshHost: { role: 'member', hostDaemonId: STRANGER }, nodes: [{ id: 'n-m', workspace: '/w/o', daemonId: MEMBER }] } as unknown as LocalMeshEntry];
    // The roster the mesh-sender gate reads is this daemon's own meshes.json.
    saveMeshConfig({ ...loadMeshConfig(), meshes: meshes as any });
    coordinators = [];
    turns = { open: false, committed: [] };
    record = vi.fn(async (meshId: string, input: any) => ({ id: `note-${meshId}`, input }));
    setAssistantServicesForTests(createAssistantServices({ configDir: tmp, operatingNotes: { record, forget: vi.fn(async () => ({ matched: 1 })) }, listMeshes: () => meshes }));
    execute = vi.fn(async (cmd: string) => {
        if (cmd === 'launch_mesh_coordinator') {
            coordinators = [{ sessionId: 'coord-1', idle: true, modalParked: false, managedByAssistant: true }];
            return { success: true, sessionId: 'coord-1' };
        }
        if (cmd === 'send_chat') return { success: true, queued: true };
        if (cmd === 'read_chat') return { success: true, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Done: RSS fixed.' }] };
        return { success: true };
    });
    setAssistantProjectPortsForTests(() => ({
        selfDaemonId: () => HOST,
        listMeshes: () => meshes,
        isHostedHere: (m: LocalMeshEntry) => m.id === MESH,
        aliases: () => ({}),
        coordinators: () => coordinators,
        lastCoordinatorSessionId: () => null,
        cliTypeFor: () => 'claude-cli',
        queueCounts: () => ({ pending: 0, assigned: 1, failed: 0 }),
        activeMissionCount: () => 1,
        pendingApprovals: () => 0,
        relay: { openThread: vi.fn() },
        execute: execute as any,
        remoteHost: () => { throw new Error('not used on the host'); },
        callHost: () => { throw new Error('not used on the host'); },
        coordinatorTurns: () => turns,
        meshStatusLine: () => '[Mesh] 1 assigned',
    }) as unknown as AssistantProjectPorts);
});

afterEach(() => {
    setAssistantProjectPortsForTests(null);
    setAssistantServicesForTests(null);
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
});

function hostRouter(): DaemonCommandRouter {
    return new DaemonCommandRouter({
        commandHandler: { handleSpec: vi.fn(async () => ({ success: true })), rejectUnknown: vi.fn(async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` })) } as any,
        cliManager: {} as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
        detectedIdes: { value: [] },
        sessionRegistry: { get: () => undefined } as any,
        statusInstanceId: HOST,
    } as any);
}

const relayed = (sender: string | null, args: Record<string, unknown>) => ({
    ...args, _meshDirectDispatch: true, ...(sender ? { [MESH_SENDER_DAEMON_ID_ARG]: sender } : {}),
});

describe('assistant_remote_project — gates', () => {
    it('is registered for source mesh only, with the roster sender class', () => {
        const spec = getDaemonCommandRegistry().get('assistant_remote_project');
        expect(spec?.sources).toEqual(['mesh']);
        expect(spec?.meshSender).toBe('roster');
    });

    it('refuses every non-mesh source (dashboard, HTTP, MCP) before the handler', async () => {
        const router = hostRouter();
        for (const source of ['ipc', 'standalone', 'p2p', 'ws']) {
            const r: any = await router.execute('assistant_remote_project', { meshId: MESH, op: 'send', text: 'x', clientId: 'c' }, source);
            expect(r).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it('refuses an unproven mesh sender: none stamped, or not on this daemon\'s roster (even with a spoofed inlineMesh)', async () => {
        const router = hostRouter();
        const none: any = await router.execute('assistant_remote_project', relayed(null, { meshId: MESH, op: 'send', text: 'x', clientId: 'c' }), 'mesh');
        expect(none).toMatchObject({ success: false, code: 'mesh_sender_unknown' });
        const spoof = { ...hostMesh(), nodes: [...(hostMesh().nodes as any[]), { id: 'n-x', daemonId: STRANGER }] };
        const stranger: any = await router.execute('assistant_remote_project', relayed(STRANGER, { meshId: MESH, op: 'send', text: 'x', clientId: 'c', inlineMesh: spoof }), 'mesh');
        expect(stranger).toMatchObject({ success: false, code: 'mesh_sender_not_on_roster' });
        expect(execute).not.toHaveBeenCalled();
    });

    it('a roster member cannot drive a mesh this daemon does not host', async () => {
        const r: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: OTHER_MESH, op: 'send', text: 'x', clientId: 'c' }), 'mesh');
        expect(r).toMatchObject({ success: false, code: 'project_not_hosted_here' });
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('assistant_remote_project — ops for a roster member', () => {
    it('send: ensures a coordinator here and queues the text to it (origin assistant), returns the turn cursor', async () => {
        turns = { open: false, committed: [{ attemptId: 'plain:coord-1:old', outcome: 'completed', at: Date.now() - 60_000 }] };
        const r: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'send', text: 'Fix the RSS feed', clientId: 't1' }), 'mesh');
        expect(r).toEqual({
            success: true,
            result: { status: 'queued', launched: true, coordinatorSessionId: 'coord-1', messageId: `assistant:${MESH}:t1`, cursor: 'plain:coord-1:old' },
        });
        const send = execute.mock.calls.find((c) => c[0] === 'send_chat')![1];
        expect(send).toEqual({ targetSessionId: 'coord-1', text: 'Fix the RSS feed', origin: 'assistant', policy: { mode: 'queue' }, messageId: `assistant:${MESH}:t1` });
        // no target session can be named by the caller
        const r2: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'send', text: 'x', clientId: 't2', targetSessionId: 'some-other' }), 'mesh');
        expect(r2.result.coordinatorSessionId).toBe('coord-1');
        expect(await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'send', text: '  ', clientId: 't3' }), 'mesh')).toMatchObject({ success: false, code: 'invalid_args' });
    });

    it('poll: the ledger\'s commits after the cursor (oldest first, host-clock ages) plus the coordinator\'s reply', async () => {
        coordinators = [{ sessionId: 'coord-1', idle: false, modalParked: false, managedByAssistant: true }];
        const now = Date.now();
        turns = {
            open: true,
            committed: [
                { attemptId: 'plain:coord-1:c3', outcome: 'completed', at: now - 1_000 },
                { attemptId: 'plain:coord-1:c2', outcome: 'failed', at: now - 5_000 },
                { attemptId: 'plain:coord-1:c1', outcome: 'completed', at: now - 50_000 },
            ],
        };
        const r: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'poll', afterAttemptId: 'plain:coord-1:c1' }), 'mesh');
        expect(r).toMatchObject({
            success: true, coordinator: 'working', coordinatorSessionId: 'coord-1', open: true, modal: false,
            cursor: 'plain:coord-1:c3', cursorFound: true, body: 'Done: RSS fixed.',
            work: { activeMissions: 1, pending: 0, assigned: 1 }, statusLine: '[Mesh] 1 assigned',
        });
        expect(r.commits.map((c: any) => [c.attemptId, c.outcome])).toEqual([['plain:coord-1:c2', 'failed'], ['plain:coord-1:c3', 'completed']]);
        expect(r.commits[1].ageMs).toBeGreaterThanOrEqual(1_000);
        const none: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'poll', afterAttemptId: 'plain:coord-1:c3' }), 'mesh');
        expect(none).toMatchObject({ commits: [], cursorFound: true });
        expect(none).not.toHaveProperty('body');
    });

    it('note: stores with the caller\'s applying origin; the text checks run again here', async () => {
        const ok: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'note', action: 'record', text: 'Use pnpm', origin: 'human', callerSessionId: 'asst-1' }), 'mesh');
        expect(ok).toMatchObject({ success: true, result: 'applied', noteId: `note-${MESH}` });
        expect(record).toHaveBeenCalledWith(MESH, expect.objectContaining({ text: 'Use pnpm', sourceCoordinator: 'assistant', callerSessionId: 'asst-1' }));
        const staged: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'note', action: 'record', text: 'x', origin: 'relay' }), 'mesh');
        expect(staged).toMatchObject({ success: false, code: 'invalid_args' });
        const secret: any = await hostRouter().execute('assistant_remote_project', relayed(MEMBER, { meshId: MESH, op: 'note', action: 'record', text: `token adk_${'a1B2'.repeat(6)}`, origin: 'owner' }), 'mesh');
        expect(secret).toMatchObject({ success: false, code: 'note_secret_rejected' });
        expect(record).toHaveBeenCalledTimes(1);
    });
});
