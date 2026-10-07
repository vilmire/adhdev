/**
 * `launch_assistant` / `assistant_pending_relays` (commands/high-family/
 * assistant-launch.ts; design 2026-10-07-assistant-layer.md §4.4, §4.5) over
 * fake daemon deps: the launch_cli envelope (workspace, settings stamp,
 * launchedBy, prompt injection, claude MCP + `--tools=Read`), the MCP config
 * file, idempotence, registry binding + restart note, the dangerous-mode
 * refusal, and the MCP-only pull ownership rule.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { assistantLaunchHandlers } from '../../src/commands/high-family/assistant-launch.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { wireAssistantRuntime, type AssistantRuntime } from '../../src/assistant/assistant-runtime.js';
import { ASSISTANT_SAFETY_TAIL } from '../../src/assistant/assistant-prompt.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const SELF = 'daemon_mach_self';
let dir: string;
let prevConfigDir: string | undefined;
let live: Set<string>;
let execute: ReturnType<typeof vi.fn>;
let registry: AssistantRegistry;
let runtime: AssistantRuntime | null;
let launchCount: number;

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
            instanceManager: { getInstance: (id: string) => (live.has(id) ? { getState: () => ({ status: 'idle', settings: { assistant: true } }) } : undefined) },
            providerLoader: { resolveAlias: (t: string) => (t === 'claude' ? 'claude-cli' : t), resolve: () => provider, getMeta: () => provider },
        },
        components: () => { throw new Error('not used'); },
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
        expect(args).toEqual(expect.arrayContaining(['--mcp-config', cfgPath, '--strict-mcp-config', '--allowedTools=mcp__adhdev-assistant', '--tools=Read']));
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

    it('codex-cli: the session id rides a -c mcp_servers.*.env override matching assistantSessionKey', async () => {
        const codex: any = {
            type: 'codex-cli',
            meshCoordinator: {
                supported: true,
                mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh', requiresRestart: true, instructions: 'codex mcp add', template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}' },
                systemPromptInjection: { mode: 'cli_arg', flag: '-c' },
            },
        };
        const c = ctx();
        c.deps.providerLoader = { resolveAlias: (t: string) => t, resolve: () => codex, getMeta: () => codex };
        const r: any = await assistantLaunchHandlers[ASSISTANT_VERB.launch](c, { cliType: 'codex-cli' });
        expect(r).toMatchObject({ success: true, cliType: 'codex-cli' });
        const [launch] = launchCalls();
        expect(launch.cliArgs).toContain(`mcp_servers.adhdev-assistant.env.ADHDEV_ASSISTANT_SESSION_ID="${launch.assistantSessionKey}"`);
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
            c.deps.providerLoader = { resolveAlias: (t: string) => t, resolve: () => agy, getMeta: () => agy };
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
            c.deps.providerLoader = { resolveAlias: (t: string) => t, resolve: () => agy, getMeta: () => agy };
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
