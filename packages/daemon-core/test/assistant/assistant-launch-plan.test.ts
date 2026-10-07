/**
 * Assistant launch planning (design 2026-10-07-assistant-layer.md §4.5, B.1):
 * the generalized MCP launch resolver (`{kind:'assistant'}` → `--assistant`,
 * mesh unchanged), per-provider MCP wiring, claude's built-in tool allowlist,
 * and the never-dangerous approval rule.
 */
import { describe, expect, it } from 'vitest';
import { buildMeshCoordinatorMcpServerEntry, getMcpServersKey } from '../../src/mesh/mesh-coordinator-config.js';
import { findWorkerPrivateHomeSpec } from '../../src/mesh/worker-home-specs.js';
import { resolveAdhdevMcpServerLaunch, resolveMeshCoordinatorSetup, type MeshCoordinatorSetup } from '../../src/commands/mesh-coordinator.js';
import {
    ASSISTANT_MCP_SERVER_NAME,
    assistantClaudeMcpConfigPath,
    assistantPrivateHomeDir,
    assistantSessionSettings,
    assistantWorkspaceDir,
    planAssistantMcp,
    resolveAssistantApprovalSettings,
} from '../../src/assistant/assistant-launch-plan.js';

const CFG = '/tmp/adhdev-cfg';
const WS = assistantWorkspaceDir(CFG);
const server = { command: 'adhdev', args: ['mcp', '--mode', 'ipc', '--assistant'] };

describe('resolveAdhdevMcpServerLaunch toolset', () => {
    it('mesh toolset keeps --repo-mesh, assistant toolset emits --assistant and no mesh id', () => {
        const mesh = resolveAdhdevMcpServerLaunch({ toolset: { kind: 'mesh', meshId: 'mesh_x' }, adhdevMcpCommand: 'adhdev', adhdevMcpTransport: 'ipc', adhdevMcpPort: 19223 })!;
        expect(mesh.args).toEqual(['mcp', '--mode', 'ipc', '--repo-mesh', 'mesh_x', '--port', '19223']);
        const asst = resolveAdhdevMcpServerLaunch({ toolset: { kind: 'assistant' }, adhdevMcpCommand: 'adhdev', adhdevMcpTransport: 'ipc', adhdevMcpPort: 19223 })!;
        expect(asst.args).toEqual(['mcp', '--mode', 'ipc', '--assistant', '--port', '19223']);
    });

    it('resolveMeshCoordinatorSetup threads the toolset (default stays the mesh)', () => {
        const provider: any = { meshCoordinator: { supported: true, mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json' } } };
        const opts = { provider, meshId: 'mesh_x', workspace: WS, adhdevMcpCommand: 'adhdev', adhdevMcpTransport: 'ipc' as const };
        const mesh = resolveMeshCoordinatorSetup(opts) as Extract<MeshCoordinatorSetup, { kind: 'auto_import' }>;
        expect(mesh.mcpServer.args).toContain('--repo-mesh');
        const asst = resolveMeshCoordinatorSetup({ ...opts, meshId: '', toolset: { kind: 'assistant' } }) as Extract<MeshCoordinatorSetup, { kind: 'auto_import' }>;
        expect(asst.mcpServer.args).toContain('--assistant');
        expect(asst.mcpServer.args).not.toContain('--repo-mesh');
    });
});

describe('planAssistantMcp', () => {
    it('claude-cli: daemon-owned config, strict MCP, pre-allowed assistant server, --tools=Read', () => {
        const setup: MeshCoordinatorSetup = { kind: 'auto_import', serverName: 'adhdev-mesh', configPath: `${WS}/.mcp.json`, configFormat: 'claude_mcp_json', mcpServer: server };
        const plan = planAssistantMcp({ cliType: 'claude-cli', setup, workspace: WS, configDir: CFG });
        expect(plan).toEqual({
            ok: true,
            cliArgs: ['--mcp-config', assistantClaudeMcpConfigPath(CFG), '--strict-mcp-config', `--allowedTools=mcp__${ASSISTANT_MCP_SERVER_NAME}`, '--tools=Read'],
            configWrite: { path: assistantClaudeMcpConfigPath(CFG), format: 'claude_mcp_json', serverName: ASSISTANT_MCP_SERVER_NAME, server },
            mcpServer: server,
            toolRestriction: 'enforced',
        });
    });

    it('codex-cli: -c overrides, never the global `codex mcp add`', () => {
        const setup: MeshCoordinatorSetup = { kind: 'cli_command', serverName: 'adhdev-mesh', command: 'codex mcp add adhdev-mesh -- adhdev mcp', requiresRestart: true, instructions: 'x', mcpServer: server };
        const plan = planAssistantMcp({ cliType: 'codex-cli', setup, workspace: WS, configDir: CFG });
        expect(plan.ok && plan.cliArgs).toEqual([
            '-c', `mcp_servers.${ASSISTANT_MCP_SERVER_NAME}.command="adhdev"`,
            '-c', `mcp_servers.${ASSISTANT_MCP_SERVER_NAME}.args=${JSON.stringify(server.args)}`,
        ]);
        expect(plan.ok && plan.configWrite).toBeNull();
        expect(planAssistantMcp({ cliType: 'gemini-cli', setup, workspace: WS, configDir: CFG })).toMatchObject({ ok: false, code: 'assistant_mcp_setup_unsupported' });
    });

    it('auto-import providers write inside the assistant workspace; a global config path is refused', () => {
        const inside: MeshCoordinatorSetup = { kind: 'auto_import', serverName: 'adhdev-mesh', configPath: `${WS}/.cursor/mcp.json`, configFormat: 'claude_mcp_json', mcpServer: server };
        expect(planAssistantMcp({ cliType: 'cursor-cli', setup: inside, workspace: WS, configDir: CFG })).toMatchObject({ ok: true, cliArgs: [], configWrite: { path: `${WS}/.cursor/mcp.json` } });
        const global: MeshCoordinatorSetup = { ...inside, configPath: '/home/u/.gemini/config/mcp_config.json' };
        // No private-HOME spec (gemini-cli), or no declared `~/` path to re-root: refused.
        expect(planAssistantMcp({ cliType: 'gemini-cli', setup: global, workspace: WS, configDir: CFG, declaredMcpConfigPath: '~/.gemini/config/mcp_config.json' })).toMatchObject({ ok: false, code: 'assistant_mcp_setup_unsupported' });
        expect(planAssistantMcp({ cliType: 'antigravity-cli', setup: global, workspace: WS, configDir: CFG })).toMatchObject({ ok: false, code: 'assistant_mcp_setup_unsupported' });
        expect(planAssistantMcp({ cliType: 'antigravity-cli', setup: global, workspace: WS, configDir: CFG, declaredMcpConfigPath: '/etc/mcp.json' })).toMatchObject({ ok: false, code: 'assistant_mcp_setup_unsupported' });
    });

    it('antigravity-cli: the worker private-HOME spec at a stable assistant dir, config inside it, HOME pointed at it', () => {
        const global: MeshCoordinatorSetup = { kind: 'auto_import', serverName: 'adhdev-mesh', configPath: '/home/u/.gemini/config/mcp_config.json', configFormat: 'claude_mcp_json', mcpServer: server };
        const plan = planAssistantMcp({ cliType: 'antigravity-cli', setup: global, workspace: WS, configDir: CFG, declaredMcpConfigPath: '~/.gemini/config/mcp_config.json' });
        if (!plan.ok) throw new Error(plan.code);
        const home = assistantPrivateHomeDir(CFG, 'antigravity-cli');
        expect(home).toBe(`${CFG}/assistant-home/antigravity-cli`);
        expect(home.startsWith(`${WS}/`)).toBe(false);
        expect(plan.cliArgs).toEqual([]);
        expect(plan.toolRestriction).toBe('prompt_only');
        expect(plan.configWrite).toEqual({ path: `${home}/.gemini/config/mcp_config.json`, format: 'claude_mcp_json', serverName: ASSISTANT_MCP_SERVER_NAME, server });
        expect(plan.privateHome?.dir).toBe(home);
        expect(plan.privateHome?.spec).toBe(findWorkerPrivateHomeSpec('antigravity-cli'));
        expect(plan.privateHome?.env.HOME).toBe(home);
    });

    it('unsupported / manual setups fail closed', () => {
        expect(planAssistantMcp({ cliType: 'x', setup: { kind: 'unsupported', reason: 'nope' }, workspace: WS, configDir: CFG })).toEqual({ ok: false, code: 'assistant_unsupported', error: 'nope' });
        expect(planAssistantMcp({ cliType: 'x', setup: { kind: 'manual', serverName: 's', requiresRestart: false, instructions: 'do it', template: '{}' }, workspace: WS, configDir: CFG }))
            .toEqual({ ok: false, code: 'assistant_manual_mcp_setup_required', error: 'do it' });
    });
});

describe('assistant session id reaches the MCP server (every eligible provider)', () => {
    const SID = '8ebaf6d0-f9d9-4766-92b6-6c7892c171ea';
    // The shipped manifests' `meshCoordinator.mcpConfig` (same fixtures as assistant-eligibility.test.ts).
    const FIXTURES: Record<string, any> = {
        'claude-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
        'codex-cli': {
            mode: 'manual', serverName: 'adhdev-mesh', requiresRestart: true, instructions: 'codex mcp add',
            template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}',
        },
        'cursor-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '.cursor/mcp.json', serverName: 'adhdev-mesh' },
        kimi: { mode: 'auto_import', format: 'claude_mcp_json', path: '.kimi-code/mcp.json', serverName: 'adhdev-mesh' },
        opencode: { mode: 'auto_import', format: 'opencode_json', path: 'opencode.json', serverName: 'adhdev-mesh' },
        'grok-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
        'antigravity-cli': { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json', serverName: 'adhdev-mesh' },
    };
    const plan = (cliType: string, sessionId?: string) => {
        const provider: any = { meshCoordinator: { supported: true, mcpConfig: FIXTURES[cliType] } };
        const setup = resolveMeshCoordinatorSetup({ provider, cliType, meshId: '', workspace: WS, toolset: { kind: 'assistant' }, adhdevMcpCommand: 'adhdev', adhdevMcpTransport: 'ipc', adhdevMcpPort: 19223 });
        const p = planAssistantMcp({ cliType, setup, workspace: WS, configDir: CFG, sessionId, declaredMcpConfigPath: FIXTURES[cliType].path });
        if (!p.ok) throw new Error(`${cliType}: ${p.code}`);
        return p;
    };

    it('codex-cli: a dotted `-c mcp_servers.<name>.env.<KEY>` override (codex passes MCP children only configured env)', () => {
        const p = plan('codex-cli', SID);
        const i = p.cliArgs.indexOf(`mcp_servers.${ASSISTANT_MCP_SERVER_NAME}.env.ADHDEV_ASSISTANT_SESSION_ID="${SID}"`);
        expect(i).toBeGreaterThan(0);
        expect(p.cliArgs[i - 1]).toBe('-c');
        expect(p.mcpServer.env).toEqual({ ADHDEV_ASSISTANT_SESSION_ID: SID });
        expect(p.cliArgs.filter((a) => a.includes('.env.'))).toHaveLength(1);
    });

    it.each(['claude-cli', 'cursor-cli', 'kimi', 'opencode', 'grok-cli', 'antigravity-cli'])('%s: the written config entry carries the env', (cliType) => {
        const p = plan(cliType, SID);
        const w = p.configWrite!;
        expect(w).toBeTruthy();
        const entry = buildMeshCoordinatorMcpServerEntry(w.format as any, w.server);
        const envKey = w.format === 'opencode_json' ? 'environment' : 'env';
        expect(entry[envKey]).toEqual({ ADHDEV_ASSISTANT_SESSION_ID: SID });
        expect(getMcpServersKey(w.format as any)).toBeTruthy();
        expect(entry[w.format === 'opencode_json' ? 'command' : 'args']).toEqual(expect.arrayContaining(['--assistant']));
    });

    it('no session id (eligibility probe) → no env, no env override', () => {
        expect(plan('codex-cli').cliArgs.some((a) => a.includes('.env.'))).toBe(false);
        expect(plan('cursor-cli').configWrite!.server.env).toBeUndefined();
        expect(plan('claude-cli', '  ').configWrite!.server.env).toBeUndefined();
    });
});

describe('resolveAssistantApprovalSettings', () => {
    const provider: any = {
        autoApproveModes: {
            default: 'pty-parse',
            modes: [
                { id: 'pty-parse', risk: 'safe', strategy: 'pty-parse-default' },
                { id: 'accept-edits', risk: 'caution', strategy: 'launch-args', launchArgs: ['--permission-mode', 'acceptEdits'] },
                { id: 'yolo', risk: 'dangerous', strategy: 'launch-args', launchArgs: ['--permission-mode', 'bypassPermissions'] },
                { id: 'sneaky', risk: 'caution', strategy: 'launch-args', launchArgs: ['--dangerously-skip-permissions'] },
            ],
        },
    };

    it('defaults to auto-approve OFF (every prompt waits for the person)', () => {
        expect(resolveAssistantApprovalSettings(provider, undefined)).toEqual({ ok: true, settings: { autoApprove: false, autoApproveMode: undefined } });
        expect(assistantSessionSettings({ autoApprove: false })).toEqual({ assistant: true, autoApprove: false });
    });

    it('accepts a declared non-dangerous mode and refuses dangerous (declared or derived) and unknown ones', () => {
        expect(resolveAssistantApprovalSettings(provider, 'accept-edits')).toEqual({ ok: true, settings: { autoApproveMode: 'accept-edits', autoApprove: undefined } });
        expect(resolveAssistantApprovalSettings(provider, 'yolo')).toMatchObject({ ok: false, code: 'assistant_dangerous_mode_refused' });
        expect(resolveAssistantApprovalSettings(provider, 'sneaky')).toMatchObject({ ok: false, code: 'assistant_dangerous_mode_refused' });
        expect(resolveAssistantApprovalSettings(provider, 'nope')).toMatchObject({ ok: false, code: 'invalid_args' });
    });
});
