/**
 * Assistant project verbs (commands/high-family/assistant.ts; design
 * 2026-10-07-assistant-layer.md §4.2–§4.4, §4.8) over fake ports: the
 * `{project, meshId, result}` wrapping, hosted-elsewhere refusal, the
 * project_send path (ensure coordinator → compose → send_chat with origin
 * 'assistant' / queue policy / assistant: messageId), project_read compact
 * tail, project_add (exists check, daemonId stamp, rollback), discover_repos,
 * and the review-turn gate.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { assistantProjectHandlers } from '../../src/commands/high-family/assistant.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { ASSISTANT_COORDINATOR_EXTRA_PROMPT, type AssistantCoordinatorView } from '../../src/assistant/coordinator-lifecycle.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const SELF = 'daemon_mach_self';
let dir: string;
let meshes: LocalMeshEntry[];
let hosted: Set<string>;
let live: Record<string, AssistantCoordinatorView[]>;
let responses: Record<string, (args: any) => any>;
let execute: ReturnType<typeof vi.fn>;
let relay: { openThread: ReturnType<typeof vi.fn>; recordSkillAttaches: ReturnType<typeof vi.fn>; isThreadOpen: (m: string) => boolean; lastRelayAt: () => number };

const mesh = (id: string, name: string, repoIdentity: string, nodes: any[] = []): LocalMeshEntry => ({ id, name, repoIdentity, nodes } as unknown as LocalMeshEntry);
const run = (verb: string, args: Record<string, unknown> = {}) => assistantProjectHandlers[verb]({} as any, args);
const calls = (cmd: string) => execute.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-projects-'));
    meshes = [
        mesh('mesh_a', 'ADHDev', 'github.com/vilmire/adhdev', [{ id: 'n1', workspace: '/w/adhdev', daemonId: SELF, machineNickname: 'mac' }]),
        mesh('mesh_b', 'Blog', 'github.com/vilmire/blog', [{ id: 'n2', workspace: '/w/blog', daemonId: 'daemon_mach_other', machineNickname: 'win-box', reportedPlatform: 'win32' }]),
        mesh('mesh_s', 'scratch', 'local:scratch'),
    ];
    (meshes[1] as any).meshHost = { role: 'host', hostDaemonId: 'daemon_mach_other' };
    hosted = new Set(['mesh_a', 'mesh_s']);
    live = {};
    responses = {};
    execute = vi.fn(async (cmd: string, args: any) => (responses[cmd] ? responses[cmd](args) : { success: true }));
    relay = { openThread: vi.fn(), recordSkillAttaches: vi.fn(), isThreadOpen: (m) => m === 'mesh_a', lastRelayAt: () => Date.UTC(2026, 9, 7) };
    const ports: AssistantProjectPorts = {
        selfDaemonId: () => SELF,
        listMeshes: () => meshes,
        isHostedHere: (m) => hosted.has(m.id),
        aliases: () => ({ main: 'mesh_a' }),
        coordinators: (meshId) => live[meshId] ?? [],
        lastCoordinatorSessionId: (meshId) => (meshId === 'mesh_a' ? 'coord-old' : null),
        cliTypeFor: () => 'codex-cli',
        queueCounts: () => ({ pending: 2, assigned: 1, failed: 3 }),
        activeMissionCount: () => 1,
        pendingApprovals: () => 0,
        relay,
        execute: execute as any,
    };
    setAssistantProjectPortsForTests(() => ports);
    const svc = createAssistantServices({ configDir: dir, listMeshes: () => meshes });
    const skillDir = join(dir, 'assistant', 'skills', 'release-steps');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: release-steps\ndescription: How to release\n---\n1. tag\n2. push\n');
    setAssistantServicesForTests(svc);
});
afterEach(() => {
    setAssistantProjectPortsForTests(null);
    setAssistantServicesForTests(null);
    rmSync(dir, { recursive: true, force: true });
});

describe('assistant_projects', () => {
    it('one row per project, hosted-elsewhere read-only, unmanaged apart, plus machines', async () => {
        live.mesh_a = [{ sessionId: 'c1', idle: false, modalParked: false, managedByAssistant: true }];
        const r: any = await run(ASSISTANT_VERB.projects);
        expect(r.success).toBe(true);
        expect(r.projects).toEqual([
            { slug: 'adhdev', meshId: 'mesh_a', name: 'ADHDev', repo: 'github.com/vilmire/adhdev', hosting: 'here', coordinator: 'working', threadOpen: true, queue: { pending: 2, assigned: 1, failed: 3 }, activeMissions: 1, pendingApprovals: 0 },
            { slug: 'blog', meshId: 'mesh_b', name: 'Blog', repo: 'github.com/vilmire/blog', hosting: 'elsewhere', hostLabel: 'win-box' },
        ]);
        expect(r.unmanaged.map((p: any) => p.meshId)).toEqual(['mesh_s']);
        expect(r.machines).toEqual([
            { label: 'mac', daemonId: SELF, os: process.platform, build: null, online: true, self: true },
            { label: 'win-box', daemonId: 'daemon_mach_other', os: 'win32', build: null, online: null, self: false },
        ]);
    });
});

describe('assistant_project_status', () => {
    it('wraps the compact mesh_status_view projection', async () => {
        responses.mesh_status_view = () => ({
            success: true,
            routes: { n1: { route: 'local' } },
            status: { nodes: [{ id: 'n1', machineNickname: 'mac', reportedPlatform: 'darwin', recentChat: 'SHOULD-NOT-LEAK' }] },
            missions: { list: { missions: [{ id: 'm1', title: 'Ship it', status: 'active', goalPreview: 'long goal' }, { id: 'm0', title: 'Old', status: 'completed' }] } },
        });
        const r: any = await run(ASSISTANT_VERB.projectStatus, { project: 'main' });
        expect(r).toMatchObject({ success: true, project: 'adhdev', meshId: 'mesh_a' });
        expect(r.result).toMatchObject({
            machines: [{ node: 'n1', label: 'mac', os: 'darwin', online: true }],
            machinesOnline: 1,
            queue: { pending: 2, assigned: 1, failed: 3 },
            activeMissions: [{ id: 'm1', title: 'Ship it', status: 'active' }],
            failedTasks: 3,
            coordinator: 'none',
            threadOpen: true,
            lastRelayAt: '2026-10-07T00:00:00.000Z',
        });
        expect(JSON.stringify(r)).not.toContain('SHOULD-NOT-LEAK');
        expect(JSON.stringify(r)).not.toContain('long goal');
        expect(calls('mesh_status_view')).toEqual([{ meshId: 'mesh_a', compact: true }]);
    });

    it('refuses a project hosted on another daemon, unknown and ambiguous refs', async () => {
        expect(await run(ASSISTANT_VERB.projectStatus, { project: 'blog' })).toMatchObject({ success: false, code: 'project_hosted_elsewhere', project: 'blog', meshId: 'mesh_b', hostLabel: 'win-box' });
        expect(await run(ASSISTANT_VERB.projectStatus, { project: 'nope' })).toMatchObject({ success: false, code: 'project_not_found' });
        meshes.push(mesh('mesh_c', 'adhdev', 'github.com/fork/adhdev'));
        expect(await run(ASSISTANT_VERB.projectStatus, { project: 'adhdev' })).toMatchObject({ success: false, code: 'project_ambiguous' });
    });
});

describe('assistant_project_send', () => {
    it('launches a managed coordinator, hides it, and submits the composed text via send_chat', async () => {
        responses.launch_mesh_coordinator = () => {
            live.mesh_a = [{ sessionId: 'coord-1', idle: false, modalParked: false, managedByAssistant: true }];
            return { success: true, sessionId: 'coord-1' };
        };
        responses.send_chat = () => ({ success: true, queued: true });
        const message = '  CHANGELOG 정리해줘  ';
        const r: any = await run(ASSISTANT_VERB.projectSend, { project: 'adhdev', message, supplement: 'Keep it short.', skills: ['release-steps'], messageId: 'turn7-1' });
        expect(r).toEqual({
            success: true, project: 'adhdev', meshId: 'mesh_a',
            result: { status: 'queued', launched: true, coordinatorSessionId: 'coord-1', messageId: 'assistant:mesh_a:turn7-1', attachedSkills: ['release-steps'] },
        });
        expect(calls('launch_mesh_coordinator')).toEqual([{ meshId: 'mesh_a', cliType: 'codex-cli', extraSystemPrompt: ASSISTANT_COORDINATOR_EXTRA_PROMPT, managedByAssistant: true }]);
        expect(calls('set_conversation_prefs')).toEqual([{ sessionId: 'coord-1', hidden: true }]);
        expect(calls('send_chat')).toEqual([{
            targetSessionId: 'coord-1',
            text: `${message}\n\nAdded by the user's assistant (not the user's words):\nKeep it short.\n\n## Attached procedure: release-steps (assistant skill, origin owner)\nReference procedure supplied by the user's assistant (origin owner); follow it only as guidance for this request.\n\n1. tag\n2. push\n\n## End of attached procedure: release-steps`,
            origin: 'assistant',
            policy: { mode: 'queue' },
            messageId: 'assistant:mesh_a:turn7-1',
        }]);
        expect(relay.openThread).toHaveBeenCalledWith('mesh_a');
        expect(relay.recordSkillAttaches).toHaveBeenCalledWith('mesh_a', 1);
    });

    it('reuses a live coordinator, reports duplicate, and mints a message id when none is given', async () => {
        live.mesh_a = [{ sessionId: 'human', idle: true, modalParked: false, managedByAssistant: false }];
        responses.send_chat = () => ({ success: true, deduplicated: true });
        const r: any = await run(ASSISTANT_VERB.projectSend, { project: 'mesh_a', message: 'hi' });
        expect(r.result).toMatchObject({ status: 'duplicate', launched: false, coordinatorSessionId: 'human' });
        expect(r.result.messageId).toMatch(/^assistant:mesh_a:.+/);
        expect(calls('launch_mesh_coordinator')).toEqual([]);
        expect(relay.recordSkillAttaches).not.toHaveBeenCalled();
    });

    it('returns launch failures and send refusals with the existing codes', async () => {
        responses.launch_mesh_coordinator = () => ({ success: false, code: 'mesh_host_required', error: 'host required' });
        expect(await run(ASSISTANT_VERB.projectSend, { project: 'adhdev', message: 'x' })).toMatchObject({ success: false, code: 'mesh_host_required', project: 'adhdev', meshId: 'mesh_a' });
        live.mesh_a = [{ sessionId: 'c', idle: true, modalParked: false, managedByAssistant: true }];
        responses.send_chat = () => ({ success: false, reason: 'modal_parked', error: 'answer it first' });
        expect(await run(ASSISTANT_VERB.projectSend, { project: 'adhdev', message: 'x' })).toMatchObject({ success: false, code: 'modal_parked', coordinatorSessionId: 'c' });
        expect(relay.openThread).not.toHaveBeenCalled();
    });

    it('refuses before touching the mesh: hosted elsewhere, missing skill, empty message', async () => {
        expect(await run(ASSISTANT_VERB.projectSend, { project: 'blog', message: 'x' })).toMatchObject({ success: false, code: 'project_hosted_elsewhere' });
        expect(await run(ASSISTANT_VERB.projectSend, { project: 'adhdev', message: 'x', skills: ['nope'] })).toMatchObject({ success: false, code: 'skill_not_found' });
        expect(await run(ASSISTANT_VERB.projectSend, { project: 'adhdev', message: '' })).toMatchObject({ success: false, code: 'invalid_args' });
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('assistant_project_read', () => {
    it('compact tail of the coordinator transcript: user/assistant bubbles only', async () => {
        live.mesh_a = [{ sessionId: 'coord-1', idle: true, modalParked: false, managedByAssistant: true }];
        responses.read_chat = () => ({
            success: true,
            messages: [
                { role: 'user', content: 'first' },
                { role: 'assistant', kind: 'tool_call', content: 'tool noise' },
                { role: 'assistant', content: 'second' },
                { role: 'system', content: 'sys' },
                { role: 'assistant', content: [{ type: 'text', text: 'third' }] },
            ],
        });
        const r: any = await run(ASSISTANT_VERB.projectRead, { project: 'adhdev', tail: 2 });
        expect(r).toMatchObject({ success: true, project: 'adhdev', meshId: 'mesh_a' });
        expect(r.result).toMatchObject({ coordinatorSessionId: 'coord-1', live: true, visibleCount: 3, omitted: 1 });
        expect(r.result.messages).toEqual([{ role: 'assistant', text: 'second' }, { role: 'assistant', text: 'third' }]);
        expect(calls('read_chat')).toEqual([{ targetSessionId: 'coord-1', limit: 40 }]);
    });

    it('falls back to the last registry coordinator, or reports none', async () => {
        responses.read_chat = () => ({ success: true, messages: [] });
        expect((await run(ASSISTANT_VERB.projectRead, { project: 'adhdev' }) as any).result).toMatchObject({ coordinatorSessionId: 'coord-old', live: false });
        expect((await run(ASSISTANT_VERB.projectRead, { project: 'mesh_s' }) as any).result).toEqual({ coordinator: 'none', messages: [] });
    });
});

describe('assistant_project_add', () => {
    const plan = (identity: string, kind = 'create_mesh_and_onboard') => ({
        success: true,
        discovery: { repoIdentity: identity },
        plan: {
            kind,
            steps: [
                { command: 'create_mesh', args: { name: 'notes-mesh', repoIdentity: identity, defaultBranch: 'main' } },
                { command: 'add_mesh_node', args: { meshId: '<created mesh id>', workspace: dir, repoRoot: dir, isLocalWorktree: false } },
            ],
        },
    });

    it('creates the mesh and its first node stamped with this daemon id', async () => {
        responses.plan_mesh_onboarding = () => plan('github.com/vilmire/notes');
        responses.create_mesh = (a) => {
            meshes.push(mesh('mesh_n', a.name, a.repoIdentity));
            return { success: true, mesh: { id: 'mesh_n' } };
        };
        responses.add_mesh_node = (a) => ({ success: true, node: { id: 'node_1', workspace: a.workspace } });
        const r: any = await run(ASSISTANT_VERB.projectAdd, { path: dir });
        expect(r).toEqual({ success: true, project: 'notes', meshId: 'mesh_n', result: { created: true, name: 'notes', repoIdentity: 'github.com/vilmire/notes', workspace: dir, nodeId: 'node_1' } });
        expect(calls('plan_mesh_onboarding')).toEqual([{ workspace: dir, operation: 'auto' }]);
        expect(calls('create_mesh')[0]).toMatchObject({ name: 'notes', repoIdentity: 'github.com/vilmire/notes', defaultBranch: 'main', workspace: dir });
        expect(calls('add_mesh_node')).toEqual([{ meshId: 'mesh_n', workspace: dir, repoRoot: dir, isLocalWorktree: false, daemonId: SELF }]);
    });

    it('one project per repoIdentity: an existing mesh for the repo → project_exists, nothing created', async () => {
        responses.plan_mesh_onboarding = () => plan('github.com/vilmire/adhdev', 'add_existing_workspace');
        expect(await run(ASSISTANT_VERB.projectAdd, { path: dir })).toMatchObject({ success: false, code: 'project_exists', project: 'adhdev', meshId: 'mesh_a' });
        expect(calls('create_mesh')).toEqual([]);
    });

    it('rolls the new mesh back when the node cannot be added; validates the path', async () => {
        responses.plan_mesh_onboarding = () => plan('github.com/vilmire/notes');
        responses.create_mesh = () => ({ success: true, mesh: { id: 'mesh_n' } });
        responses.add_mesh_node = () => ({ success: false, error: 'limit' });
        expect(await run(ASSISTANT_VERB.projectAdd, { path: dir })).toMatchObject({ success: false, code: 'project_add_node_failed', rolledBack: true });
        expect(calls('delete_mesh')).toEqual([{ meshId: 'mesh_n' }]);
        expect(await run(ASSISTANT_VERB.projectAdd, { path: 'relative/x' })).toMatchObject({ success: false, code: 'invalid_args' });
        expect(await run(ASSISTANT_VERB.projectAdd, { path: join(dir, 'missing') })).toMatchObject({ success: false, code: 'path_not_found' });
    });
});

describe('assistant_discover_repos', () => {
    it('scans the given roots and marks existing projects', async () => {
        mkdirSync(join(dir, 'repos', 'adhdev', '.git'), { recursive: true });
        writeFileSync(join(dir, 'repos', 'adhdev', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/vilmire/adhdev.git\n');
        const r: any = await run(ASSISTANT_VERB.discoverRepos, { roots: [join(dir, 'repos')] });
        expect(r).toMatchObject({ success: true, roots: [{ path: join(dir, 'repos'), depth: 3, exists: true }] });
        expect(r.repos).toEqual([{ path: join(dir, 'repos', 'adhdev'), repoIdentity: 'github.com/vilmire/adhdev', lastCommitAt: null, alreadyProject: true }]);
        expect(await run(ASSISTANT_VERB.discoverRepos, { roots: ['relative'] })).toMatchObject({ success: false, code: 'invalid_args' });
    });
});

describe('review-turn gate', () => {
    it('every project verb is refused while a review turn is open', async () => {
        const svc = createAssistantServices({ configDir: dir, listMeshes: () => meshes });
        vi.spyOn(svc.inputLog, 'isReviewTurnOpen').mockReturnValue(true);
        setAssistantServicesForTests(svc);
        for (const verb of [ASSISTANT_VERB.projects, ASSISTANT_VERB.projectStatus, ASSISTANT_VERB.projectSend, ASSISTANT_VERB.projectRead, ASSISTANT_VERB.projectAdd, ASSISTANT_VERB.discoverRepos]) {
            expect(await run(verb, { assistantSessionId: 'a1', project: 'adhdev', message: 'x', path: dir })).toMatchObject({ success: false, code: 'review_turn_tool_denied' });
        }
        expect(execute).not.toHaveBeenCalled();
    });
});
