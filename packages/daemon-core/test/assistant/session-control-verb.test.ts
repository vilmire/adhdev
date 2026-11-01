import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testConfigDir = join(tmpdir(), `adhdev-session-control-verb-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => { if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true }); return testConfigDir; },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const assistantSession = { sid: 'assistant-session-1' };
vi.mock('../../src/assistant/assistant-registry.js', () => ({
    getAssistantRegistry: () => ({ read: () => ({ sessionId: assistantSession.sid, cliType: 'claude-cli' }), reload: () => ({ sessionId: assistantSession.sid }) }),
}));

import { ASSISTANT_REVIEW_TURN_VERBS, ASSISTANT_TOOLS, ASSISTANT_TOOL_VERBS, ASSISTANT_VERB, ASSISTANT_WRITE_TOOLS } from '@adhdev/mesh-shared';
import { assistantSessionControlHandlers, resolveStagedControl } from '../../src/commands/high-family/assistant-session-control.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { createAssistantServices, getAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { StagedControlStore, setStagedControlStoreForTest } from '../../src/assistant/staged-control.js';
import { isCoordinatorDraining, setCoordinatorDraining } from '../../src/mesh/coordinator-registry.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const SELF = 'daemon_mach_assistant00001';
const mesh = { id: 'sc-mesh-1', name: 'Blog', repoIdentity: 'github.com/acme/blog', meshHost: { role: 'host', hostDaemonId: SELF }, nodes: [{ id: 'n1', workspace: '/w', daemonId: SELF, role: 'host' }] } as unknown as LocalMeshEntry;
let coordIdle = true;
let coordAlive = true;
let executed: Array<{ cmd: string; args: any }> = [];
const run = (args: Record<string, unknown>, ctx: any = makeCtx()) => assistantSessionControlHandlers[ASSISTANT_VERB.sessionControl](ctx, args);
const authed = (extra: Record<string, unknown> = {}, sid = assistantSession.sid) => ({
    project: 'blog', assistantSessionId: sid,
    mcpSessionCredential: mintMcpSessionCredential({ sessionId: sid, isCoordinator: false }), ...extra,
});
const ownerSpoke = () => getAssistantServices().inputLog.append(assistantSession.sid, 'human');

function makeCtx(): any {
    return {
        deps: {
            statusInstanceId: SELF,
            instanceManager: { getInstance: (id: string) => (id === 'coord-1' && coordAlive ? { getState: () => ({ status: coordIdle ? 'idle' : 'generating', type: 'claude-cli', settings: {} }) } : null) },
            cliManager: {}, providerLoader: {},
        },
        components: () => ({}),
        execute: vi.fn(async (cmd: string, args: any) => { executed.push({ cmd, args }); if (cmd === 'stop_cli') coordAlive = false; return { success: true }; }),
    };
}

beforeEach(() => {
    coordIdle = true; coordAlive = true; executed = [];
    setAssistantServicesForTests(createAssistantServices({ configDir: testConfigDir, listMeshes: () => [mesh] }));
    setStagedControlStoreForTest(new StagedControlStore({ configDir: testConfigDir }));
    setAssistantProjectPortsForTests(() => ({
        selfDaemonId: () => SELF, listMeshes: () => [mesh], isHostedHere: () => true, aliases: () => ({}),
        coordinators: () => (coordAlive ? [{ sessionId: 'coord-1', idle: coordIdle, modalParked: false, managedByAssistant: true }] : []),
        lastCoordinatorSessionId: () => null, queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }), activeMissionCount: () => 0, pendingApprovals: () => 0,
        relay: { openThread: vi.fn(), isThreadOpen: () => false, lastRelayAt: () => 0 }, execute: vi.fn(async () => ({ success: true })) as any,
        remoteHost: () => ({ label: 'x', reachable: true }), coordinatorTurns: () => ({ open: false, committed: [] }), meshStatusLine: () => null,
    }) as unknown as AssistantProjectPorts);
});
afterEach(() => {
    setAssistantProjectPortsForTests(null); setAssistantServicesForTests(null); setStagedControlStoreForTest(null);
    __resetMcpSessionCredentialsForTest(); setCoordinatorDraining('coord-1', false);
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('contract', () => {
    it('is an assistant tool and write tool, ipc/standalone only, and not allowed during a review turn', () => {
        expect(ASSISTANT_TOOLS).toContain('session_control');
        expect(ASSISTANT_TOOL_VERBS.session_control).toBe('assistant_session_control');
        expect(ASSISTANT_WRITE_TOOLS).toContain('session_control');
        expect(getDaemonCommandRegistry().get('assistant_session_control')?.sources).toEqual(['ipc', 'standalone']);
        expect(ASSISTANT_REVIEW_TURN_VERBS).not.toContain(ASSISTANT_VERB.sessionControl);
    });
});

describe('acceptance 1: authority', () => {
    it('a turn opened only by a relay is not an owner utterance', async () => {
        getAssistantServices().inputLog.append(assistantSession.sid, 'relay');
        const r: any = await run(authed({ role: 'coordinator', action: 'stop', interpretedFrom: 'stop the coordinator' }));
        expect(r).toMatchObject({ success: false, code: 'owner_utterance_required' });
        expect(executed).toEqual([]);
    });
    it('a review turn is refused by the review-turn whitelist', async () => {
        getAssistantServices().inputLog.append(assistantSession.sid, 'review');
        const r: any = await run(authed({ role: 'coordinator', action: 'status' }));
        expect(r).toMatchObject({ success: false, code: 'review_turn_tool_denied' });
    });
    it('needs the bound assistant credential; a coordinator credential or worker bind is rejected', async () => {
        ownerSpoke();
        const a = { project: 'blog', role: 'coordinator', action: 'stop', interpretedFrom: 'stop' };
        expect(await run({ ...a, assistantSessionId: assistantSession.sid })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        const coordCred = mintMcpSessionCredential({ sessionId: assistantSession.sid, isCoordinator: true });
        expect(await run({ ...a, assistantSessionId: assistantSession.sid, mcpSessionCredential: coordCred })).toMatchObject({ success: false });
        expect(await run({ ...a, bind: 'b', ...authed() })).toMatchObject({ success: false });
        expect(executed).toEqual([]);
    });
    it('status needs no owner utterance (a read)', async () => {
        getAssistantServices().inputLog.append(assistantSession.sid, 'relay');
        const r: any = await run(authed({ role: 'coordinator', action: 'status' }));
        expect(r).toMatchObject({ success: true, result: 'done', code: 'status', status: { sessionId: 'coord-1', state: 'idle' } });
    });
});

describe('verb end to end over the daemon commands', () => {
    it('an idle coordinator stop on the owner utterance runs stop_cli once and reports quiescence', async () => {
        ownerSpoke();
        const r: any = await run(authed({ role: 'coordinator', action: 'stop', interpretedFrom: 'stop the blog coordinator' }));
        expect(r).toMatchObject({ success: true, result: 'done', project: 'blog', meshId: mesh.id });
        expect(executed.filter(e => e.cmd === 'stop_cli')).toHaveLength(1);
        expect(executed[0]!.args).toMatchObject({ targetSessionId: 'coord-1', cliType: 'claude-cli', mode: 'hard' });
        expect(r.quiescence).toBeDefined();
    });
    it('a generating coordinator is only proposed; the card is owner-resolvable and discard runs nothing', async () => {
        coordIdle = false;
        ownerSpoke();
        const r: any = await run(authed({ role: 'coordinator', action: 'restart', interpretedFrom: 'restart it' }));
        expect(r).toMatchObject({ success: true, result: 'proposed' });
        expect(r.stagedId).toMatch(/^ctl-[a-f0-9]{24}$/);
        expect(executed).toEqual([]);
        const discarded: any = await resolveStagedControl(makeCtx(), r.stagedId, 'discard');
        expect(discarded).toMatchObject({ success: true, result: 'discarded' });
        expect(executed).toEqual([]);
    });
    it('approving a restart card re-resolves the session and runs restart_session', async () => {
        coordIdle = false;
        ownerSpoke();
        const r: any = await run(authed({ role: 'coordinator', action: 'restart', interpretedFrom: 'restart it' }));
        const applied: any = await resolveStagedControl(makeCtx(), r.stagedId, 'apply');
        expect(applied).toMatchObject({ success: true, result: 'applied' });
        expect(executed.filter(e => e.cmd === 'restart_session')).toHaveLength(1);
        expect(executed.find(e => e.cmd === 'restart_session')!.args).toEqual({ cliType: 'claude-cli', targetSessionId: 'coord-1' });
    });
    it('draining is released again when the stop fails', async () => {
        ownerSpoke();
        const ctx = makeCtx();
        ctx.execute = vi.fn(async () => ({ success: false, code: 'stop_failed' }));
        const r: any = await run(authed({ role: 'coordinator', action: 'stop', interpretedFrom: 'stop' }), ctx);
        expect(r).toMatchObject({ success: false, code: 'stop_failed' });
        expect(isCoordinatorDraining('coord-1')).toBe(false);
    });
});

import { controlStatusFields } from '../../src/assistant/control-status.js';
import { SqliteHandoffJournal } from '../../src/mesh/host-handoff/journal.js';
import { ASSISTANT_QUOTA_FAILOVER_COMMAND, ASSISTANT_SWITCH_PROVIDER_COMMAND } from '../../src/commands/high-family/assistant-session-control.js';

describe('read-only status fields (ids and enums only)', () => {
    it('project_status shows an active handoff and an open quota card, nothing else', () => {
        expect(controlStatusFields(mesh.id)).toEqual({});
        new SqliteHandoffJournal(MeshRuntimeStore.getInstance().db as never).put({ handoffId: 'h1', role: 'source', meshId: mesh.id, peerDaemonId: 'daemon_mach_x', phase: 'frozen', epoch: 1, createdAt: 5, updatedAt: 9 });
        const store = new StagedControlStore({ configDir: testConfigDir });
        setStagedControlStoreForTest(store);
        store.write({ kind: 'session_control', project: 'blog', meshId: mesh.id, trigger: 'quota_exhausted', role: 'coordinator', action: 'switch_provider', sessionId: 'c1', provider: 'codex-cli', reason: 'quota_exhausted' });
        const fields = controlStatusFields(mesh.id);
        expect(fields).toMatchObject({ hostHandoff: { phase: 'frozen', handoffId: 'h1', since: 9, role: 'source' }, failover: { state: 'proposed' } });
        expect(JSON.stringify(fields)).not.toContain('codex-cli');
    });
});

describe('quota failover policy (owner verb, dashboard sources only)', () => {
    it('is registered for p2p / ws / standalone and never for ipc', () => {
        expect(getDaemonCommandRegistry().get(ASSISTANT_QUOTA_FAILOVER_COMMAND)?.sources).toEqual(['p2p', 'ws', 'standalone']);
        expect(getDaemonCommandRegistry().get(ASSISTANT_SWITCH_PROVIDER_COMMAND)?.sources).toEqual(['p2p', 'ws', 'standalone']);
    });
    it('the owner switch validates the provider before anything is queued', async () => {
        const out: any = await assistantSessionControlHandlers[ASSISTANT_SWITCH_PROVIDER_COMMAND](makeCtx(), { provider: 'nope-cli' });
        expect(out).toMatchObject({ success: false });
        expect(String(out.code)).toMatch(/provider_|catalog_unavailable/);
        expect(await assistantSessionControlHandlers[ASSISTANT_SWITCH_PROVIDER_COMMAND](makeCtx(), {})).toMatchObject({ success: false, code: 'invalid_args' });
    });
});
