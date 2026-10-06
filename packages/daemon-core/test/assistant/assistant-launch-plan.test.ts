/**
 * Assistant launch planning (design 2026-10-07-assistant-layer.md §4.5, B.1):
 * the generalized MCP launch resolver (`{kind:'assistant'}` → `--assistant`,
 * mesh unchanged), per-provider MCP wiring, claude's built-in tool allowlist,
 * and the never-dangerous approval rule.
 */
import { describe, expect, it } from 'vitest';
import { resolveAdhdevMcpServerLaunch, resolveMeshCoordinatorSetup, type MeshCoordinatorSetup } from '../../src/commands/mesh-coordinator.js';
import {
    ASSISTANT_MCP_SERVER_NAME,
    assistantClaudeMcpConfigPath,
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
        expect(planAssistantMcp({ cliType: 'antigravity-cli', setup: global, workspace: WS, configDir: CFG })).toMatchObject({ ok: false, code: 'assistant_mcp_setup_unsupported' });
    });

    it('unsupported / manual setups fail closed', () => {
        expect(planAssistantMcp({ cliType: 'x', setup: { kind: 'unsupported', reason: 'nope' }, workspace: WS, configDir: CFG })).toEqual({ ok: false, code: 'assistant_unsupported', error: 'nope' });
        expect(planAssistantMcp({ cliType: 'x', setup: { kind: 'manual', serverName: 's', requiresRestart: false, instructions: 'do it', template: '{}' }, workspace: WS, configDir: CFG }))
            .toEqual({ ok: false, code: 'assistant_manual_mcp_setup_required', error: 'do it' });
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
