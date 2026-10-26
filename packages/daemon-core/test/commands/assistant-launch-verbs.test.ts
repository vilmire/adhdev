/**
 * `launch_assistant` / `assistant_pending_relays` (commands/high-family/
 * assistant-launch.ts; design 2026-10-07-assistant-layer.md §4.4, §4.5) over
 * fake daemon deps: the launch_cli envelope (workspace, settings stamp,
 * launchedBy, prompt injection, claude MCP + `--tools=Read`), the MCP config
 * file, idempotence, registry binding + restart note, the dangerous-mode
 * refusal, and the MCP-only pull ownership rule.
 */
import {
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { issueTrustedOwnerIngressProof, markTrustedOwnerIngress } from '../../src/commands/command-args.js';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { acquireOwnedLock } from '../../src/launch-defaults/owned-lock.js';
import * as ownedLocks from '../../src/launch-defaults/owned-lock.js';
import { beginAssistantSpawn } from '../../src/assistant/assistant-launch-fence.js';
import { assistantLaunchHandlers } from '../../src/commands/high-family/assistant-launch.js';
import { writeProtectedAssistantConfigFile } from '../../src/assistant/assistant-config-io.js';
import { ASSISTANT_MCP_SERVER_NAME, mergeAssistantCodexMcpConfigToml } from '../../src/assistant/assistant-launch-plan.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { wireAssistantRuntime, type AssistantRuntime } from '../../src/assistant/assistant-runtime.js';
import { ASSISTANT_SAFETY_TAIL } from '../../src/assistant/assistant-prompt.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const HOST_OWNER = { namespace: 'review-preview', endpoint: 'unix:/tmp/preview-test.sock', managedBy: 'adhdev-cloud', clientId: 'daemon_mach_self' };
const SELF = 'daemon_mach_self';
let dir: string;
let prevConfigDir: string | undefined;
let live: Set<string>;
let execute: ReturnType<typeof vi.fn>;
let registry: AssistantRegistry;
let runtime: AssistantRuntime | null;
let launchCount: number;

function loader(manifest: any) {
    const p = { category: 'cli', modelLaunchArgs: ['--model', '{{model}}'],
        thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['low', 'high'], ...manifest };
    return { resolveAlias: (t: string) => t === 'claude' ? 'claude-cli' : t,
        resolve: () => p, getMeta: () => p,
        getAvailableProviderInfos: () => [{ type: p.type, enabled: true, installed: true }] };
}
const provider: any = {
    type: 'claude-cli',
    meshCoordinator: {
        supported: true,
        mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
        systemPromptInjection: { mode: 'cli_arg', flag: '--append-system-prompt' },
    },
    autoApproveModes: { default: 'pty-parse', modes: [{ id: 'pty-parse', risk: 'safe', strategy: 'pty-parse-default' }, { id: 'yolo', risk: 'dangerous', strategy: 'launch-args', launchArgs: ['--permission-mode', 'bypassPermissions'] }] },
};

function ctx(): any {
    return {
        deps: {
            statusInstanceId: SELF,
            cliManager: { hostedRestoreState: 'ready', deps: { getHostedBindingOwner: () => HOST_OWNER,
                hostedRuntimeManagerTag: HOST_OWNER.managedBy, listHostedCliRuntimes: async () => [] } },
            instanceManager: { getInstance: (id: string) => (live.has(id) ? { getState: () => ({ status: 'idle', settings: { assistant: true } }) } : undefined) },
            providerLoader: loader(provider),
        },
        components: () => ({ instanceManager: { getInstance: () => undefined }, cliManager: { adapters: new Map() } }),
        execute,
    };
}

const run = (verb: string, args: Record<string, unknown> = {}) => assistantLaunchHandlers[verb](ctx(), args);
const launchCalls = () => execute.mock.calls.filter((c) => c[0] === 'launch_cli').map((c) => c[1]);

function fakeComponents(submits: any[]) {
    return {
        bus: { on: () => () => {} },
        instanceManager: { getInstance: (id: string) => (live.has(id) ? { getState: () => ({ status: 'idle', settings: {} }) } : undefined) },
        router: { execute: async () => ({ success: false }) },
        cliManager: { input: { submit: async (m: any) => { submits.push(m); return { kind: 'delivered' }; } } },
    } as any;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-launch-'));
    prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = dir;
    writeFileSync(join(dir, 'launch-defaults.json'), JSON.stringify({ version: 1, revision: 1, history: [],
        assistant: { provider: 'claude-cli', revision: 1, setBy: 'owner', setAt: 1 } }));
    live = new Set();
    launchCount = 0;
    execute = vi.fn(async (cmd: string) => {
        if (cmd === 'launch_cli') return { success: true, sessionId: `asst-${++launchCount}` };
        return { success: true };
    });
    registry = new AssistantRegistry({ configDir: dir });
    setAssistantRegistryForTests(registry);
    const meshes = [{ id: 'mesh_a', name: 'ADHDev', repoIdentity: 'github.com/vilmire/adhdev', nodes: [] } as unknown as LocalMeshEntry];
    setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: () => meshes }));
    const ports = {
        selfDaemonId: () => SELF,
        listMeshes: () => meshes,
        isHostedHere: () => true,
        relay: {},
    } as unknown as AssistantProjectPorts;
    setAssistantProjectPortsForTests(() => ports);
    runtime = null;
});

afterEach(() => {
    runtime?.dispose();
    setAssistantRegistryForTests(null);
    setAssistantServicesForTests(null);
    setAssistantProjectPortsForTests(null);
    if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
});

describe('launch_assistant', () => {
    it('holds admission through a timed-out dispatch and stops its late success before a retry', async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        const c = ctx();
        const stop = vi.fn(async (id: string) => { live.delete(id); });
        c.deps.cliManager.stopSessionWithMode = stop;
        execute.mockImplementation(async (cmd: string) => {
            if (cmd !== 'launch_cli') return { success: true };
            const id = `late-${++launchCount}`;
            if (launchCount === 1) await new Promise<void>(resolve => { finish = resolve; });
            live.add(id);
            return { success: true, sessionId: id };
        });
        try {
            const pending = assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {});
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            expect(launchCalls()).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await pending).toMatchObject({ code: 'assistant_launch_timeout' });
            // A different daemon/registry cannot steal the still-live launch lock.
            const contender = acquireOwnedLock(join(dir, '.assistant-launch.lock'), { now: () => Date.now() + 60_000 });
            if (contender.ok) contender.release();
            expect(contender.ok).toBe(false);
            expect((await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).success).toBe(false);
            expect(launchCalls()).toHaveLength(1);
            finish();
            await vi.advanceTimersByTimeAsync(1);
            expect(stop).toHaveBeenCalledWith('late-1', 'hard');
            expect(live.size).toBe(0);
            expect(registry.reload()?.sessionId ?? null).toBeNull();
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: true, sessionId: 'late-2' });
            expect([...live]).toEqual(['late-2']);
            expect(registry.reload()?.sessionId).toBe('late-2');
        } finally {
            finish?.();
            await vi.advanceTimersByTimeAsync(1);
            vi.useRealTimers();
        }
    });

    it.each([false, true])('never lets late A overwrite retry B after the hard ceiling (cleanup fails: %s)', async cleanupFails => {
        vi.useFakeTimers();
        const c = ctx();
        let finish!: () => void;
        const stop = vi.fn(async (id: string) => {
            if (cleanupFails) throw new Error('stop failed');
            live.delete(id);
        });
        c.deps.cliManager.stopSessionWithMode = stop;
        c.deps.cliManager.deps.listHostedCliRuntimes = async () => [...live].map(runtimeId => ({ runtimeId, cliType: 'claude-cli', workspace: dir, assistant: true }));
        execute.mockImplementation(async (cmd: string) => {
            if (cmd !== 'launch_cli') return { success: true };
            const id = `generation-${++launchCount}`;
            if (launchCount === 1) await new Promise<void>(resolve => { finish = resolve; });
            live.add(id);
            return { success: true, sessionId: id };
        });
        try {
            const a = assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {});
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
            expect(await a).toMatchObject({ code: 'assistant_launch_timeout' });
            const args = markTrustedOwnerIngress({ force: true }, issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true }));
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, args)).toMatchObject({ success: true, sessionId: 'generation-2' });
            finish();
            await vi.advanceTimersByTimeAsync(1);
            expect(stop).toHaveBeenCalledWith('generation-1', 'hard');
            expect(registry.reload()?.sessionId).toBe('generation-2');
            expect(live.has('generation-2')).toBe(true);
            if (!cleanupFails) expect([...live]).toEqual(['generation-2']);
            else {
                expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ code: 'assistant_launch_cleanup_pending' });
                stop.mockImplementation(async id => { live.delete(id); });
                expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, args)).toMatchObject({ success: true, launched: false, sessionId: 'generation-2' });
                expect([...live]).toEqual(['generation-2']);
                expect(registry.reload()?.sessionId).toBe('generation-2');
            }
        } finally { finish?.(); await vi.advanceTimersByTimeAsync(1); vi.useRealTimers(); }
    });

    it('keeps admission past five minutes when spawning has begun and cleanup cannot be acknowledged', async () => {
        vi.useFakeTimers();
        const c = ctx();
        let finish!: () => void;
        c.deps.cliManager.stopSessionWithMode = vi.fn(async (id: string) => { live.delete(id); });
        execute.mockImplementation(async (cmd: string, args: any) => {
            if (cmd !== 'launch_cli') return { success: true };
            beginAssistantSpawn(args.assistantSessionKey);
            await new Promise<void>(resolve => { finish = resolve; });
            live.add('spawning-A');
            return { success: true, sessionId: 'spawning-A' };
        });
        try {
            const a = assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {});
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
            expect(await a).toMatchObject({ code: 'assistant_launch_timeout' });
            const args = markTrustedOwnerIngress({ force: true }, issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true }));
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, args)).toMatchObject({ code: 'assistant_launch_cancellation_pending' });
            expect(existsSync(join(dir, '.assistant-launch.lock'))).toBe(true);
            expect(launchCalls()).toHaveLength(1);
            finish();
            await vi.advanceTimersByTimeAsync(1);
            expect(c.deps.cliManager.stopSessionWithMode).toHaveBeenCalledWith('spawning-A', 'hard');
            expect(existsSync(join(dir, '.assistant-launch.lock'))).toBe(false);
        } finally { finish?.(); await vi.advanceTimersByTimeAsync(1); vi.useRealTimers(); }
    });

    it('reuses an attached bound assistant without scanning unrelated persisted snapshots', async () => {
        registry.bindSession({ sessionId: 'attached', cliType: 'claude-cli', workspace: join(dir, 'assistant'), hostOwner: HOST_OWNER, at: 1 });
        live.add('attached');
        const runtimes = join(dir, 'session-host', 'unrelated', 'runtimes');
        mkdirSync(runtimes, { recursive: true });
        writeFileSync(join(runtimes, 'broken.json'), '{broken snapshot');
        const c = ctx();
        c.deps.cliManager.deps.listHostedCliRuntimes = async () => [{ runtimeId: 'attached', cliType: 'claude-cli', workspace: join(dir, 'assistant'), assistant: true }];
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: true, launched: false, sessionId: 'attached' });
        expect(launchCalls()).toHaveLength(0);
    });

    it('retains binding and admission while late assistant cleanup fails', async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        const c = ctx();
        c.deps.cliManager.stopSessionWithMode = vi.fn(async () => { throw new Error('stop failed'); });
        c.deps.cliManager.deps.listHostedCliRuntimes = async () => [...live].map(runtimeId => ({ runtimeId, cliType: 'claude-cli', workspace: dir, assistant: true }));
        execute.mockImplementation(async (cmd: string) => {
            if (cmd !== 'launch_cli') return { success: true };
            await new Promise<void>(resolve => { finish = resolve; });
            live.add('late-retained');
            return { success: true, sessionId: 'late-retained' };
        });
        try {
            const pending = assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {});
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await pending).toMatchObject({ code: 'assistant_launch_timeout' });
            finish();
            await vi.advanceTimersByTimeAsync(1);
            expect(registry.reload()?.sessionId).toBe('late-retained');
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: false, code: 'assistant_launch_cleanup_pending' });
            expect(existsSync(join(dir, '.assistant-launch.lock'))).toBe(true);
            expect(launchCalls()).toHaveLength(1);
        } finally { finish?.(); await vi.advanceTimersByTimeAsync(1); vi.useRealTimers(); }
    });

    it('refuses trusted owner replacement when another assistant cannot be proven dead', async () => {
        const runtimes = join(dir, 'session-host', 'foreign', 'runtimes');
        mkdirSync(runtimes, { recursive: true });
        writeFileSync(join(runtimes, 'stale.json'), JSON.stringify({ record: {
            sessionId: 'stale', providerType: 'claude-cli', category: 'cli', lifecycle: 'running', osPid: process.pid, meta: { assistant: true } }, snapshot: {} }));
        writeFileSync(join(dir, 'foreign-session-host.pid'), String(process.pid));
        const args = markTrustedOwnerIngress({ replace: true }, issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true }));
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](ctx(), args)).toMatchObject({ success: false, code: 'assistant_identity_conflict', error: expect.stringContaining('namespace foreign') });
    });

    it.each([true, false])('never lets trusted owner force replace a verified live foreign assistant (role metadata: %s)', async marked => {
        const { SessionHostClient, getDefaultSessionHostEndpoint, resolveSessionHostIpcKey } = await import('@adhdev/session-host-core');
        const endpoint = getDefaultSessionHostEndpoint('foreign', { ipcKey: resolveSessionHostIpcKey(dir) });
        const record = { sessionId: 'foreign', providerType: 'claude-cli', category: 'cli', lifecycle: 'running', meta: { assistant: marked } };
        if (!marked) registry.bindSession({ sessionId: 'foreign', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: 1,
            hostOwner: { ...HOST_OWNER, namespace: 'foreign', endpoint: `${endpoint.kind}:${endpoint.path}` } });
        const runtimes = join(dir, 'session-host', 'foreign', 'runtimes');
        mkdirSync(runtimes, { recursive: true });
        writeFileSync(join(runtimes, 'foreign.json'), JSON.stringify({ record, snapshot: {} }));
        const request = vi.spyOn(SessionHostClient.prototype, 'request').mockResolvedValue({ success: true, result: {
            endpoint: endpoint.path, hostStartedAt: 1, hostEntryPath: '/opt/adhdev/session-host-daemon/dist/index.js', sessions: [record],
        } });
        try {
            const args = markTrustedOwnerIngress({ force: true }, issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true }));
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](ctx(), args)).toMatchObject({ success: false, code: 'assistant_identity_conflict' });
            expect(launchCalls()).toHaveLength(0);
            expect(request).toHaveBeenCalledTimes(1);
        } finally { request.mockRestore(); }
    });

    it('prunes a dead legacy assistant resolved by a local tombstone and launches', async () => {
        registry.bindSession({ sessionId: 'legacy-dead', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: 1 });
        const tombstones = join(dir, 'session-host', HOST_OWNER.namespace, 'tombstones');
        mkdirSync(tombstones, { recursive: true });
        writeFileSync(join(tombstones, 'legacy-dead.json'), JSON.stringify({ sessionId: 'legacy-dead', termination: { lifecycle: 'stopped' } }));
        expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: true, launched: true });
    });

    it('recovers from a failed full restore on the next launch', async () => {
        const c = ctx();
        const list = vi.fn().mockRejectedValueOnce(new Error('transient inventory failure')).mockResolvedValue([]);
        const m = new DaemonCliManager({ ...c.deps.cliManager.deps, getInstanceManager: () => c.deps.instanceManager,
            getP2p: () => null, listHostedCliRuntimes: list }, { ...loader(provider), getSettings: () => ({}) } as any);
        await expect(m.restoreHostedSessions()).rejects.toThrow('transient inventory failure');
        c.deps.cliManager = m;
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: true, launched: true });
        expect(m.hostedRestoreState).toBe('ready');
    });

    it('a released binding permits a different host to launch', async () => {
        registry.bindSession({ sessionId: 'released', cliType: 'claude-cli', workspace: join(dir, 'assistant'), hostOwner: HOST_OWNER, at: 1 });
        registry.releaseSession('released', 'pty_exit');
        const c = ctx();
        c.deps.cliManager.deps.getHostedBindingOwner = () => ({ ...HOST_OWNER, namespace: 'foreign', endpoint: 'unix:/tmp/foreign.sock' });
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: true, launched: true });
    });

    it.each(['terminated', 'crashed'])('does not block launch on a %s foreign persisted runtime', async kind => {
        const runtimes = join(dir, 'session-host', 'foreign', 'runtimes');
        mkdirSync(runtimes, { recursive: true });
        const record = { sessionId: 'foreign', providerType: 'claude-cli', category: 'cli', lifecycle: 'running', meta: { assistant: true },
            ...(kind === 'terminated' ? { termination: { lifecycle: 'stopped' } } : {}) };
        writeFileSync(join(runtimes, 'foreign.json'), JSON.stringify(record));
        if (kind === 'crashed') writeFileSync(join(dir, 'foreign-session-host.pid'), '2147483647');
        expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: true, launched: true });
    });

    it('blocks a live foreign runtime in the actual wrapped storage format', async () => {
        const runtimes = join(dir, 'session-host', 'foreign', 'runtimes');
        mkdirSync(runtimes, { recursive: true });
        writeFileSync(join(runtimes, 'foreign.json'), JSON.stringify({ record: {
            sessionId: 'foreign', providerType: 'claude-cli', category: 'cli', lifecycle: 'running', meta: { assistant: true } }, snapshot: {}, updatedAt: 1 }));
        writeFileSync(join(dir, 'foreign-session-host.pid'), String(process.pid));
        expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: false, code: 'assistant_identity_conflict' });
        expect(launchCalls()).toHaveLength(0);
    });

    it('allows only verified owner force to clear a stale unknown binding, and audits it', async () => {
        registry.bindSession({ sessionId: 'unknown-stale', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: 1 });
        expect(await run(ASSISTANT_VERB.launch, { force: true })).toMatchObject({ success: false, code: 'assistant_owner_required' });
        expect(registry.reload()?.sessionId).toBe('unknown-stale');
        const args = markTrustedOwnerIngress({ force: true }, issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true }));
        const { LOG } = await import('../../src/logging/logger.js');
        const audit = vi.spyOn(LOG, 'warn');
        try {
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](ctx(), args)).toMatchObject({ success: true, launched: true });
            expect(audit).toHaveBeenCalledWith('Assistant', expect.stringContaining('owner_force'));
        } finally { audit.mockRestore(); }
    });

    it('creates a missing config directory before acquiring the launch lock', async () => {
        const missing = join(dir, 'missing-config');
        setAssistantRegistryForTests(new AssistantRegistry({ configDir: missing }));
        expect(await run(ASSISTANT_VERB.launch, { cliType: 'claude-cli' })).toMatchObject({ success: true, launched: true });
    });

    it('times out a hung inventory and releases the lock while fencing its late completion', async () => {
        vi.useFakeTimers();
        let finish!: (records: any[]) => void;
        const c = ctx();
        c.deps.cliManager.deps.listHostedCliRuntimes = () => new Promise<any[]>(resolve => { finish = resolve; });
        try {
            const pending = assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {});
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await pending).toMatchObject({ success: false, code: 'assistant_launch_timeout' });
            expect(existsSync(join(dir, '.assistant-launch.lock'))).toBe(false);
            finish([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(launchCalls()).toHaveLength(0);
            c.deps.cliManager.deps.listHostedCliRuntimes = async () => [];
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: true, launched: true });
        } finally { vi.useRealTimers(); }
    });

    it('blocks a real delayed restore, then returns the restored runtime with its original provider conversation', async () => {
        const c = ctx();
        const record = { runtimeId: 'delayed-assistant', cliType: 'claude-cli', workspace: join(dir, 'assistant'), assistant: true, providerSessionId: '364da694-b0e6-421e-802a-8ea938be2b85' };
        let release!: (records: any[]) => void;
        const inventory = new Promise<any[]>(resolve => { release = resolve; });
        const m = new DaemonCliManager({ ...c.deps.cliManager.deps,
            getInstanceManager: () => c.deps.instanceManager, getP2p: () => null,
            listHostedCliRuntimes: () => inventory,
        }, { ...loader({ ...provider, resume: { supported: true, sessionIdFormat: 'uuid', resumeSessionArgs: ['--resume', '{{id}}'] } }), getSettings: () => ({ autoApprove: true }) } as any);
        const attach = vi.spyOn(m, 'registerCliInstance').mockImplementation(async () => { live.add(record.runtimeId); });
        c.deps.cliManager = m;
        const restore = m.restoreHostedSessions();
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: false, code: 'assistant_restore_pending' });
        expect(launchCalls()).toHaveLength(0);
        release([record]);
        expect(await restore).toBe(1);
        expect(attach.mock.calls[0][8]).toMatchObject({ providerSessionId: '364da694-b0e6-421e-802a-8ea938be2b85' });
        expect(attach.mock.calls[0][6]).toMatchObject({ assistant: true, autoApprove: false });
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: true, launched: false, sessionId: record.runtimeId });
        expect(launchCalls()).toHaveLength(0);
    });

    it('refuses a launch while boot restore is delayed or failed', async () => {
        const c = ctx();
        for (const state of ['pending', 'failed']) {
            c.deps.cliManager.hostedRestoreState = state;
            expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: false, code: 'assistant_restore_pending' });
        }
        expect(launchCalls()).toHaveLength(0);
        expect(existsSync(join(dir, 'mcp-configs', 'assistant.json'))).toBe(false);
    });

    it.each([false, true])('reuses a hosted/restorable assistant after binding damage (already bound: %s)', async bound => {
        if (bound) registry.bindSession({ sessionId: 'persisted-assistant', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: 1, hostOwner: HOST_OWNER });
        const c = ctx();
        const record = { runtimeId: 'persisted-assistant', cliType: 'claude-cli', workspace: join(dir, 'assistant'), assistant: true };
        c.deps.cliManager.deps.listHostedCliRuntimes = async () => [record];
        c.deps.cliManager.restoreHostedSessions = vi.fn(async () => { live.add(record.runtimeId); return 1; });
        const results = await Promise.all([assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {}), assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})]);
        for (const result of results) expect(result).toMatchObject({ success: true, launched: false, sessionId: record.runtimeId });
        expect(c.deps.cliManager.restoreHostedSessions).toHaveBeenCalledTimes(1);
        expect(new AssistantRegistry({ configDir: dir }).read()).toMatchObject({ sessionId: record.runtimeId, hostOwner: HOST_OWNER });
        expect(launchCalls()).toHaveLength(0);
    });

    it('fails closed for multiple candidates, a foreign persisted runtime, or a failed inventory', async () => {
        const c = ctx();
        const record = { runtimeId: 'one', cliType: 'claude-cli', workspace: join(dir, 'assistant'), assistant: true };
        c.deps.cliManager.deps.listHostedCliRuntimes = async () => [record, { ...record, runtimeId: 'two' }];
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: false, code: 'assistant_identity_conflict' });
        c.deps.cliManager.deps.listHostedCliRuntimes = async () => [];
        const hostDir = join(dir, 'session-host', 'foreign-host', 'runtimes');
        mkdirSync(hostDir, { recursive: true });
        writeFileSync(join(hostDir, 'foreign.json'), JSON.stringify({ sessionId: 'foreign', providerType: 'claude-cli', category: 'cli', lifecycle: 'running', workspace: record.workspace, meta: { assistant: true } }));
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: false, code: 'assistant_identity_conflict' });
        c.deps.cliManager.deps.listHostedCliRuntimes = async () => { throw new Error('host unavailable'); };
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: false, code: 'assistant_inventory_unavailable' });
        expect(launchCalls()).toHaveLength(0);
    });

    it('preserves an attached assistant role while its hosted inventory is catching up', async () => {
        const c = ctx();
        live.add('attached-assistant');
        c.deps.instanceManager.listInstanceIds = () => ['attached-assistant'];
        expect(await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, {})).toMatchObject({ success: false, code: 'assistant_restore_pending' });
        expect(launchCalls()).toHaveLength(0);
    });

    it('rechecks the disk binding written by another registry before launching', async () => {
        expect(registry.read()).toBeNull();
        new AssistantRegistry({ configDir: dir }).bindSession({ sessionId: 'foreign-bound', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: 1, hostOwner: { ...HOST_OWNER, endpoint: 'unix:/tmp/foreign.sock' } });
        expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: false, code: 'assistant_owned_by_other_host' });
        expect(launchCalls()).toHaveLength(0);
    });

    it('refuses admission while a separate process owns the shared account launch lock', async () => {
        const lock = join(dir, '.assistant-launch.lock');
        const child = spawn(process.execPath, ['-e', `const fs = require('fs'); fs.mkdirSync(process.argv[1]); fs.writeFileSync(process.argv[1] + '/owner.json', JSON.stringify({ pid: process.pid, nonce: 'child', acquiredAt: Date.now() })); process.stdout.write('ready'); process.stdin.resume();`, lock], { stdio: ['pipe', 'pipe', 'pipe'] });
        try {
            await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lock holder exited'))); });
            expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: false, code: 'assistant_launch_pending' });
            expect(launchCalls()).toHaveLength(0);
        } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    });

    describe('launch lock hard ceiling', () => {
        const ownerArgs = () => markTrustedOwnerIngress({ force: true }, issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true }));
        const plantLock = (record: Record<string, unknown>) => {
            const lock = join(dir, '.assistant-launch.lock');
            mkdirSync(lock);
            writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'wedged', ...record }));
        };

        it('refuses to steal a live peer lock past the ceiling without cancellation acknowledgement', async () => {
            plantLock({ acquiredAt: Date.now() - 6 * 60_000 });
            expect(await run(ASSISTANT_VERB.launch, ownerArgs())).toMatchObject({ success: false, code: 'assistant_launch_cancellation_pending' });
            expect(launchCalls()).toHaveLength(0);
        });

        it('keeps refusing an owner-force launch while the lock is younger than the ceiling', async () => {
            plantLock({ acquiredAt: Date.now() - 30_000 });
            expect(await run(ASSISTANT_VERB.launch, ownerArgs())).toMatchObject({ success: false, code: 'assistant_launch_cancellation_pending' });
            expect(launchCalls()).toHaveLength(0);
        });

        it('never reclaims an over-ceiling lock without owner force', async () => {
            plantLock({ acquiredAt: Date.now() - 6 * 60_000 });
            expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: false, code: 'assistant_launch_pending' });
            expect(launchCalls()).toHaveLength(0);
        });

        it('reclaims a reused pid using an injected numeric identity on every platform', async () => {
            const acquire = ownedLocks.acquireOwnedLock;
            const probe = vi.spyOn(ownedLocks, 'acquireOwnedLock').mockImplementation((path, options) =>
                acquire(path, { ...options, processStartId: () => 'darwin-epoch-seconds-v1:2' }));
            try {
                plantLock({ acquiredAt: Date.now(), startId: 'darwin-epoch-seconds-v1:1' });
                expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: true, launched: true });
            } finally { probe.mockRestore(); }
        });
    });

    it('launches claude-cli in <configDir>/assistant with the assistant stamp, prompt and MCP wiring', async () => {
        const r: any = await run(ASSISTANT_VERB.launch, { model: 'opus', thinkingLevel: 'high' });
        expect(r).toMatchObject({ success: true, launched: true, sessionId: 'asst-1', cliType: 'claude-cli', workspace: join(dir, 'assistant') });
        const [launch] = launchCalls();
        expect(launch).toMatchObject({
            cliType: 'claude-cli',
            dir: join(dir, 'assistant'),
            settings: { assistant: true, autoApprove: false },
            launchedBy: 'assistant',
            initialModel: 'opus',
            initialThinkingLevel: 'high',
        });
        expect(launch.settings.autoApproveMode).toBeUndefined();
        const args: string[] = launch.cliArgs;
        const prompt = args[args.indexOf('--append-system-prompt') + 1];
        expect(prompt).toContain("You are the user's ADHDev assistant");
        expect(prompt.endsWith(ASSISTANT_SAFETY_TAIL)).toBe(true);
        expect(prompt).toContain('adhdev');
        const cfgPath = join(dir, 'mcp-configs', 'assistant.json');
        expect(args).toEqual(expect.arrayContaining(['--mcp-config', cfgPath, '--strict-mcp-config', '--allowedTools=mcp__adhdev-assistant', '--tools=Read,WebSearch,WebFetch']));
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        expect(cfg.mcpServers['adhdev-assistant'].args).toContain('--assistant');
        expect(cfg.mcpServers['adhdev-assistant'].args).not.toContain('--repo-mesh');
        // The session id is minted before the config write and handed to launch_cli,
        // so the MCP server entry names the session that is about to spawn.
        expect(launch.assistantSessionKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(cfg.mcpServers['adhdev-assistant'].env).toEqual({ ADHDEV_ASSISTANT_SESSION_ID: launch.assistantSessionKey });
        expect(existsSync(join(dir, 'assistant'))).toBe(true);
        expect(registry.read()).toMatchObject({ sessionId: 'asst-1', cliType: 'claude-cli', mcpConfigPath: cfgPath });
    });

    it('codex-cli: persists stable server in <workspace>/.codex/config.toml once, keeps rotated assistantSessionKey in -c overrides, and preserves persisted tool approval_mode across ordinary session/model/provider restarts without rewriting config.toml', async () => {
        const codex: any = {
            type: 'codex-cli',
            meshCoordinator: {
                supported: true,
                mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh', requiresRestart: true, instructions: 'codex mcp add', template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}' },
                systemPromptInjection: { mode: 'cli_arg', flag: '-c' },
            },
        };
        const c = ctx();
        c.deps.providerLoader = loader(codex);
        const r: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli', model: 'gpt-5.4', thinkingLevel: 'low' });
        expect(r).toMatchObject({ success: true, cliType: 'codex-cli' });
        const [launch] = launchCalls();
        expect(launch.cliArgs).toContain(`mcp_servers.adhdev-assistant.env.ADHDEV_ASSISTANT_SESSION_ID="${launch.assistantSessionKey}"`);
        const cfgPath = join(dir, 'assistant', '.codex', 'config.toml');
        expect(existsSync(cfgPath)).toBe(true);
        const firstToml = readFileSync(cfgPath, 'utf-8');
        expect(firstToml).toContain('[mcp_servers.adhdev-assistant]');
        // Ephemeral session ID stays in CLI `-c` overrides, not in the persisted TOML file.
        expect(firstToml).not.toContain('ADHDEV_ASSISTANT_SESSION_ID');
        expect(registry.read()).toMatchObject({ sessionId: 'asst-1', cliType: 'codex-cli', mcpConfigPath: cfgPath });

        // Simulate Codex writing persistent consent ("3. Always allow") for `project_send` into <workspace>/.codex/config.toml.
        const withConsent = `${firstToml}\n[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"\n`;
        writeFileSync(cfgPath, withConsent, { encoding: 'utf-8', mode: 0o600 });
        const statBeforeRelaunch = statSync(cfgPath);

        // Relaunch with rotated session ID and changed model/thinkingLevel:
        // new assistantSessionKey is passed via -c, while .codex/config.toml is not rewritten at all (same inode & bytes).
        const r2: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli', model: 'gpt-5.4-mini', thinkingLevel: 'high' });
        expect(r2).toMatchObject({ success: true, launched: true, sessionId: 'asst-2', cliType: 'codex-cli' });
        const secondLaunch = launchCalls()[1];
        expect(secondLaunch.assistantSessionKey).not.toBe(launch.assistantSessionKey);
        expect(secondLaunch.cliArgs).toContain(`mcp_servers.adhdev-assistant.env.ADHDEV_ASSISTANT_SESSION_ID="${secondLaunch.assistantSessionKey}"`);
        const statAfterRelaunch = statSync(cfgPath);
        expect(statAfterRelaunch.ino).toBe(statBeforeRelaunch.ino);
        expect(readFileSync(cfgPath, 'utf-8')).toBe(withConsent);

        // Switch assistant provider to claude-cli and back to codex-cli: consent remains intact.
        const rClaude: any = await run(ASSISTANT_VERB.launch, { cliType: 'claude-cli' });
        expect(rClaude).toMatchObject({ success: true, launched: true, cliType: 'claude-cli' });
        const rCodexAgain: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
        expect(rCodexAgain).toMatchObject({ success: true, launched: true, cliType: 'codex-cli' });
        expect(readFileSync(cfgPath, 'utf-8')).toBe(withConsent);
    });

    it('codex-cli: fails closed before launch and leaves malformed or foreign-server .codex/config.toml bytes unchanged', async () => {
        const codex: any = {
            type: 'codex-cli',
            meshCoordinator: {
                supported: true,
                mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh', requiresRestart: true, instructions: 'codex mcp add', template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}' },
                systemPromptInjection: { mode: 'cli_arg', flag: '-c' },
            },
        };
        const c = ctx();
        c.deps.providerLoader = loader(codex);
        const codexDir = join(dir, 'assistant', '.codex');
        mkdirSync(codexDir, { recursive: true, mode: 0o700 });
        const cfgPath = join(codexDir, 'config.toml');

        // 1. Malformed TOML input -> fails closed, zero launch_cli calls, bytes unchanged.
        const malformedBytes = '# User broken edit\n[mcp_servers.adhdev-assistant]\nargs = ["unclosed"\n';
        writeFileSync(cfgPath, malformedBytes, { mode: 0o600 });
        const resMalformed: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
        expect(resMalformed).toMatchObject({ success: false, code: 'assistant_config_write_failed' });
        expect(resMalformed.error).toContain('assistant_codex_config_invalid_toml');
        expect(launchCalls()).toHaveLength(0);
        expect(readFileSync(cfgPath, 'utf-8')).toBe(malformedBytes);

        // 2. Foreign server holding tools.project_send approval -> fails closed, consent not transferred or erased, bytes unchanged.
        const foreignBytes = [
            '[mcp_servers.adhdev-assistant]',
            'command = "/usr/local/bin/foreign-mcp"',
            'args = ["--serve"]',
            '',
            '[mcp_servers.adhdev-assistant.tools.project_send]',
            'approval_mode = "approve"',
            '',
        ].join('\n');
        writeFileSync(cfgPath, foreignBytes, { mode: 0o600 });
        const resForeign: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
        expect(resForeign).toMatchObject({ success: false, code: 'assistant_config_write_failed' });
        expect(resForeign.error).toContain('assistant_codex_config_foreign_server');
        expect(launchCalls()).toHaveLength(0);
        expect(readFileSync(cfgPath, 'utf-8')).toBe(foreignBytes);
    });

    it('private boundary: refuses symlinked workspace, symlinked .codex dir, symlinked/hardlinked config.toml, and pre-rename symlink replacement with external target bytes unchanged', async () => {
        const externalDir = mkdtempSync(join(tmpdir(), 'adhdev-external-target-'));
        try {
            const externalConfig = join(externalDir, 'external-config.toml');
            const sentinelBytes = '# External sentinel config — must never be modified\n[model]\nname = "untouched"\n';
            writeFileSync(externalConfig, sentinelBytes, { mode: 0o600 });
            const danglingTarget = join(externalDir, 'dangling-target.toml');

            const codex: any = {
                type: 'codex-cli',
                meshCoordinator: {
                    supported: true,
                    mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh', requiresRestart: true, instructions: 'codex mcp add', template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}' },
                    systemPromptInjection: { mode: 'cli_arg', flag: '-c' },
                },
            };
            const c = ctx();
            c.deps.providerLoader = loader(codex);
            const ws = join(dir, 'assistant');
            const dotCodex = join(ws, '.codex');
            const cfgPath = join(dotCodex, 'config.toml');

            // Case 1: workspace itself is a symlink to externalDir
            symlinkSync(externalDir, ws);
            const rWsSym: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
            expect(rWsSym).toMatchObject({ success: false, code: 'assistant_config_write_failed' });
            expect(rWsSym.error).toContain('assistant_unsafe_path');
            expect(launchCalls()).toHaveLength(0);
            expect(readFileSync(externalConfig, 'utf-8')).toBe(sentinelBytes);
            unlinkSync(ws);

            // Case 2: <workspace>/.codex is a symlink to externalDir
            mkdirSync(ws, { mode: 0o700 });
            symlinkSync(externalDir, dotCodex);
            const rDirSym: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
            expect(rDirSym).toMatchObject({ success: false, code: 'assistant_config_write_failed' });
            expect(rDirSym.error).toContain('assistant_unsafe_path');
            expect(launchCalls()).toHaveLength(0);
            expect(readFileSync(externalConfig, 'utf-8')).toBe(sentinelBytes);
            unlinkSync(dotCodex);

            // Case 3: <workspace>/.codex/config.toml is a symlink to an existing external file
            mkdirSync(dotCodex, { mode: 0o700 });
            symlinkSync(externalConfig, cfgPath);
            const rFileSym: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
            expect(rFileSym).toMatchObject({ success: false, code: 'assistant_config_write_failed' });
            expect(rFileSym.error).toContain('assistant_unsafe_path');
            expect(launchCalls()).toHaveLength(0);
            expect(readFileSync(externalConfig, 'utf-8')).toBe(sentinelBytes);
            unlinkSync(cfgPath);

            // Case 4: <workspace>/.codex/config.toml is a dangling symlink to a non-existent external file
            symlinkSync(danglingTarget, cfgPath);
            const rDangling: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
            expect(rDangling).toMatchObject({ success: false, code: 'assistant_config_write_failed' });
            expect(rDangling.error).toContain('assistant_unsafe_path');
            expect(launchCalls()).toHaveLength(0);
            expect(existsSync(danglingTarget)).toBe(false);
            unlinkSync(cfgPath);

            // Case 5: <workspace>/.codex/config.toml is a hardlink to externalConfig
            linkSync(externalConfig, cfgPath);
            const rHardlink: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
            expect(rHardlink).toMatchObject({ success: false, code: 'assistant_config_write_failed' });
            expect(rHardlink.error).toContain('assistant_unsafe_path');
            expect(launchCalls()).toHaveLength(0);
            expect(readFileSync(externalConfig, 'utf-8')).toBe(sentinelBytes);
            unlinkSync(cfgPath);

            // Case 6: pre-rename replacement race swaps target to a symlink pointing at externalConfig
            expect(() => writeProtectedAssistantConfigFile({
                rootDir: ws,
                filePath: cfgPath,
                transform: () => '[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp","--mode","ipc","--assistant"]\n',
                onBeforeRenameForTest: (_attempt, canonicalFilePath) => {
                    symlinkSync(externalConfig, canonicalFilePath);
                },
            })).toThrow(/assistant_unsafe_path/);
            expect(readFileSync(externalConfig, 'utf-8')).toBe(sentinelBytes);
            unlinkSync(cfgPath);
            // Temporary file was cleaned up on failure.
            expect(readdirSync(dotCodex).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
        } finally {
            rmSync(externalDir, { recursive: true, force: true });
        }
    });

    it('durability: preserves original bytes on mid-write IO failure and detects/merges or refuses concurrent native edits', () => {
        const ws = join(dir, 'assistant');
        const dotCodex = join(ws, '.codex');
        mkdirSync(dotCodex, { recursive: true, mode: 0o700 });
        const cfgPath = join(dotCodex, 'config.toml');
        const targetServer = { command: 'adhdev', args: ['mcp', '--mode', 'ipc', '--assistant', '--port', '19223'] };

        const legacyInitial = [
            '[mcp_servers.adhdev-assistant]',
            'command = "adhdev"',
            'args = ["mcp","--mode","ipc","--assistant","--port","19223"]',
            '',
            '[mcp_servers.adhdev-assistant.env]',
            'ADHDEV_ASSISTANT_SESSION_ID = "legacy-sid"',
            '',
        ].join('\n');
        writeFileSync(cfgPath, legacyInitial, { mode: 0o600 });
        const initialIno = statSync(cfgPath).ino;

        // 1. Simulated partial write / EIO failure mid-write: original bytes and inode remain untouched, temp file removed.
        expect(() => writeProtectedAssistantConfigFile({
            rootDir: ws,
            filePath: cfgPath,
            transform: (before) => mergeAssistantCodexMcpConfigToml(before, ASSISTANT_MCP_SERVER_NAME, targetServer),
            onWriteTempChunkForTest: () => {
                throw new Error('EIO: simulated disk write failure');
            },
        })).toThrow(/EIO: simulated disk write failure/);
        expect(readFileSync(cfgPath, 'utf-8')).toBe(legacyInitial);
        expect(statSync(cfgPath).ino).toBe(initialIno);
        expect(readdirSync(dotCodex).filter((f) => f.includes('.tmp-'))).toHaveLength(0);

        // 2. Concurrent native Codex edit on attempt 0 (adding tools.project_send approval right before rename):
        // detected, retried on attempt 1, and merged so both the session-id cleanup and the concurrent consent survive!
        const concurrentConsent = `${legacyInitial}\n[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"\n`;
        const retryResult = writeProtectedAssistantConfigFile({
            rootDir: ws,
            filePath: cfgPath,
            transform: (before) => mergeAssistantCodexMcpConfigToml(before, ASSISTANT_MCP_SERVER_NAME, targetServer),
            onBeforeRenameForTest: (attempt, canonicalFilePath) => {
                if (attempt === 0) {
                    writeFileSync(canonicalFilePath, concurrentConsent, { mode: 0o600 });
                }
            },
        });
        expect(retryResult.written).toBe(true);
        const afterRetry = readFileSync(cfgPath, 'utf-8');
        expect(afterRetry).toContain('[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"');
        expect(afterRetry).not.toContain('legacy-sid');
        expect(readdirSync(dotCodex).filter((f) => f.includes('.tmp-'))).toHaveLength(0);

        // 3. Persistent concurrent edits exceeding maxRetries: refuses with assistant_config_write_conflict, preserving latest concurrent file bytes.
        writeFileSync(cfgPath, legacyInitial, { mode: 0o600 });
        let lastConcurrentBytes = legacyInitial;
        expect(() => writeProtectedAssistantConfigFile({
            rootDir: ws,
            filePath: cfgPath,
            maxRetries: 2,
            transform: (before) => mergeAssistantCodexMcpConfigToml(before, ASSISTANT_MCP_SERVER_NAME, targetServer),
            onBeforeRenameForTest: (attempt, canonicalFilePath) => {
                lastConcurrentBytes = `${legacyInitial}\n# concurrent edit ${attempt}\n`;
                writeFileSync(canonicalFilePath, lastConcurrentBytes, { mode: 0o600 });
            },
        })).toThrow(/assistant_config_write_conflict/);
        expect(readFileSync(cfgPath, 'utf-8')).toBe(lastConcurrentBytes);
        expect(readdirSync(dotCodex).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
    });

    it('codex-cli: appends to existing nonempty custom config (with __tomlType keys), stays no-op on relaunch, and fails closed without changing disk on whitespace-aliased command (75c5c695)', async () => {
        const codex: any = {
            type: 'codex-cli',
            meshCoordinator: {
                supported: true,
                mcpConfig: {
                    mode: 'manual',
                    serverName: 'adhdev-mesh',
                    requiresRestart: true,
                    instructions: 'codex mcp add',
                    template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}',
                },
            },
        };
        const c = ctx();
        c.deps.providerLoader = loader(codex);

        const ws = join(dir, 'assistant');
        const dotCodex = join(ws, '.codex');
        mkdirSync(dotCodex, { recursive: true, mode: 0o700 });
        const cfgPath = join(dotCodex, 'config.toml');

        // 1. Existing nonempty user config without adhdev-assistant (comments, model setting, unrelated server, __tomlType keys)
        const existingCustom = [
            '# keep this comment',
            'model = "gpt-6.1-sol"',
            '',
            '[other]',
            '__tomlType = "offset-date-time"',
            'raw = "1979-05-27T07:32:00Z"',
            'foo = "bar"',
            '',
            '[mcp_servers.other]',
            'command = "npx"',
            'args = ["-y", "other-mcp"]',
            '',
        ].join('\n');
        writeFileSync(cfgPath, existingCustom, { mode: 0o600 });

        const firstLaunch: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
        expect(firstLaunch).toMatchObject({ success: true, launched: true });
        const afterAppend = readFileSync(cfgPath, 'utf-8');
        expect(afterAppend.startsWith(existingCustom)).toBe(true);
        expect(afterAppend).toContain('[mcp_servers.adhdev-assistant]');
        expect(afterAppend).toContain('[other]\n__tomlType = "offset-date-time"\nraw = "1979-05-27T07:32:00Z"\nfoo = "bar"');
        const inoAfterAppend = statSync(cfgPath).ino;

        // 2. Relaunch after native approval is a strict disk no-op (inode unchanged, prefix + consent preserved)
        const withConsent = `${afterAppend}\n[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"\n`;
        writeFileSync(cfgPath, withConsent, { mode: 0o600 });
        const inoWithConsent = statSync(cfgPath).ino;
        const secondLaunch: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
        expect(secondLaunch).toMatchObject({ success: true, launched: true });
        expect(statSync(cfgPath).ino).toBe(inoWithConsent);
        expect(readFileSync(cfgPath, 'utf-8')).toBe(withConsent);
        expect(inoAfterAppend).toBeGreaterThan(0);

        // 3. Whitespace-aliased command in config.toml fails closed before changing a single byte on disk or launching
        const whitespaceAliased = [
            '[mcp_servers.adhdev-assistant]',
            'command = "adhdev "',
            'args = ["mcp","--mode","ipc","--assistant","--port","19223"]',
            '',
            '[mcp_servers.adhdev-assistant.tools.project_send]',
            'approval_mode = "approve"',
            '',
        ].join('\n');
        writeFileSync(cfgPath, whitespaceAliased, { mode: 0o600 });
        const inoAliased = statSync(cfgPath).ino;
        const launchesBeforeRefusal = launchCalls().length;
        const refused: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
        expect(refused).toMatchObject({
            success: false,
            code: 'assistant_config_write_failed',
            error: expect.stringMatching(/assistant_codex_config_foreign_server/),
        });
        expect(launchCalls()).toHaveLength(launchesBeforeRefusal);
        expect(readFileSync(cfgPath, 'utf-8')).toBe(whitespaceAliased);
        expect(statSync(cfgPath).ino).toBe(inoAliased);
    });

    it('antigravity-cli: private HOME at <configDir>/assistant-home, MCP config + session env inside it, real ~/.gemini untouched', async () => {
        // A temp HOME stands in for the person's real one (os.homedir() follows $HOME on POSIX).
        const fakeHome = join(dir, 'real-home');
        const agyDir = join(fakeHome, '.gemini', 'antigravity-cli');
        mkdirSync(join(agyDir, 'brain'), { recursive: true });
        mkdirSync(join(agyDir, 'cache'), { recursive: true });
        writeFileSync(join(agyDir, 'settings.json'), '{"theme":"dark"}', { mode: 0o600 });
        writeFileSync(join(agyDir, 'cache', 'onboarding.json'), '{"done":true}');
        // Linux authenticates agy with this file (macOS/Windows use the OS keyring),
        // and the private home refuses to build without it there.
        writeFileSync(join(agyDir, 'antigravity-oauth-token'), '{"token":{"access_token":"x"}}', { mode: 0o600 });
        const prevHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            const agy: any = {
                type: 'antigravity-cli',
                meshCoordinator: {
                    supported: true,
                    mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json', serverName: 'adhdev-mesh' },
                    systemPromptInjection: { mode: 'context_file', path: 'AGENTS.md', wrapper: '<!-- p -->\n{prompt}\n<!-- /p -->' },
                },
            };
            const c = ctx();
            c.deps.providerLoader = loader(agy);
            const r: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'antigravity-cli' });
            expect(r).toMatchObject({ success: true, launched: true, cliType: 'antigravity-cli', workspace: join(dir, 'assistant') });
            const home = join(dir, 'assistant-home', 'antigravity-cli');
            const [launch] = launchCalls();
            expect(launch.env).toMatchObject({ HOME: home });
            expect(launch.dir).toBe(join(dir, 'assistant'));
            const cfgPath = join(home, '.gemini', 'config', 'mcp_config.json');
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
            expect(cfg.mcpServers['adhdev-assistant'].args).toContain('--assistant');
            expect(cfg.mcpServers['adhdev-assistant'].env).toEqual({ ADHDEV_ASSISTANT_SESSION_ID: launch.assistantSessionKey });
            expect(registry.read()).toMatchObject({ cliType: 'antigravity-cli', mcpConfigPath: cfgPath });
            // Nothing written to the (stand-in) real home's global MCP config.
            expect(existsSync(join(fakeHome, '.gemini', 'config'))).toBe(false);
            // settings.json is a copy; transcripts link through to the real home.
            expect(lstatSync(join(home, '.gemini', 'antigravity-cli', 'settings.json')).isSymbolicLink()).toBe(false);
            expect(lstatSync(join(home, '.gemini', 'antigravity-cli', 'brain')).isSymbolicLink()).toBe(true);
            expect(realpathSync(join(home, '.gemini', 'antigravity-cli', 'brain'))).toBe(realpathSync(join(agyDir, 'brain')));

            // Stable dir: a relaunch re-takes the copy (assistant-side settings edits do not survive or flow back).
            writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), '{"theme":"assistant-edit"}');
            const again: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'antigravity-cli' });
            expect(again).toMatchObject({ success: true, launched: true });
            expect(launchCalls()[1].env).toMatchObject({ HOME: home });
            expect(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf-8')).toBe('{"theme":"dark"}');
            expect(readFileSync(join(agyDir, 'settings.json'), 'utf-8')).toBe('{"theme":"dark"}');
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
        }
    });

    it('antigravity-cli: a private HOME that cannot be prepared fails closed (no launch)', async () => {
        const fakeHome = join(dir, 'real-home-loose');
        const agyDir = join(fakeHome, '.gemini', 'antigravity-cli');
        mkdirSync(agyDir, { recursive: true });
        // settings.json is owner-only credential-adjacent material; a loose source is refused.
        writeFileSync(join(agyDir, 'settings.json'), '{}');
        chmodSync(join(agyDir, 'settings.json'), 0o644);
        const prevHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            const agy: any = { type: 'antigravity-cli', meshCoordinator: { supported: true, mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' } } };
            const c = ctx();
            c.deps.providerLoader = loader(agy);
            const r: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'antigravity-cli' });
            expect(r).toMatchObject({ success: false, code: 'assistant_private_home_failed' });
            expect(launchCalls()).toHaveLength(0);
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
        }
    });

    it('is idempotent while the bound session is live', async () => {
        await run(ASSISTANT_VERB.launch);
        live.add('asst-1');
        const again: any = await run(ASSISTANT_VERB.launch, { cliType: 'codex-cli' });
        expect(again).toMatchObject({ success: true, launched: false, sessionId: 'asst-1', cliType: 'claude-cli' });
        expect(launchCalls()).toHaveLength(1);
    });

    it('a fresh launch after a mid-turn death queues the restart note in the relay', async () => {
        registry.bindSession({ sessionId: 'asst-old', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: Date.now() - 60 * 60_000 });
        registry.recordTurnState('asst-old', 'working', Date.now() - 30 * 60_000);
        registry.releaseSession('asst-old', 'pty_exit');
        runtime = wireAssistantRuntime(fakeComponents([]), { registry, store: new InMemoryAssistantRelayStore(), metrics: null });
        const r: any = await run(ASSISTANT_VERB.launch);
        expect(r).toMatchObject({ success: true, launched: true, sessionId: 'asst-1', restartNote: true });
        expect(runtime.relay.snapshot().queued).toBe(1);
        expect(runtime.isActive()).toBe(true);
    });

    it('refuses a dangerous approval mode and never launches', async () => {
        const r: any = await run(ASSISTANT_VERB.launch, { autoApproveMode: 'yolo' });
        expect(r).toMatchObject({ success: false, code: 'assistant_dangerous_mode_refused' });
        expect(launchCalls()).toHaveLength(0);
        expect(registry.read()).toBeNull();
    });

    it('surfaces a launch_cli failure without binding', async () => {
        execute.mockImplementation(async () => ({ success: false, error: 'not installed' }));
        expect(await run(ASSISTANT_VERB.launch)).toMatchObject({ success: false, code: 'assistant_launch_failed', error: 'not installed' });
        expect(registry.read()).toBeNull();
    });
});

describe('assistant_pending_relays', () => {
    it('no runtime → empty events', async () => {
        expect(await run(ASSISTANT_VERB.pendingRelays)).toEqual({ success: true, assistantEvents: [] });
    });

    it('MCP-only: claims queued inputs once; a live PTY assistant only serves its own session', async () => {
        const submits: any[] = [];
        runtime = wireAssistantRuntime(fakeComponents(submits), { registry, store: new InMemoryAssistantRelayStore(), metrics: null });
        expect(runtime.isActive()).toBe(false); // no assistant.json entry yet
        runtime.relay.enqueueInput({ source: 'first_run', text: '[ADHDev first run] hello', messageId: 'first:1' });
        const pulled: any = await run(ASSISTANT_VERB.pendingRelays);
        expect(pulled.success).toBe(true);
        expect(pulled.assistantEvents).toEqual([{ source: 'first_run', messageId: 'first:1', text: '[ADHDev first run] hello' }]);
        expect(runtime.isActive()).toBe(true);
        expect((await run(ASSISTANT_VERB.pendingRelays) as any).assistantEvents).toEqual([]);

        registry.bindSession({ sessionId: 'asst-pty', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: Date.now() });
        live.add('asst-pty');
        expect(await run(ASSISTANT_VERB.pendingRelays, { assistantSessionId: 'someone-else' })).toMatchObject({ success: false, code: 'assistant_session_mismatch' });
        expect(await run(ASSISTANT_VERB.pendingRelays, { assistantSessionId: 'asst-pty' })).toEqual({ success: true, assistantEvents: [] });
        expect(submits).toEqual([]);
    });
});
