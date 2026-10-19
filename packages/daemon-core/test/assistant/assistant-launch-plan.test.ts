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
    ASSISTANT_CLAUDE_BUILTIN_TOOLS,
    ASSISTANT_CODEX_MCP_CONFIG_FORMAT,
    ASSISTANT_MCP_SERVER_NAME,
    assistantClaudeMcpConfigPath,
    assistantCodexMcpConfigPath,
    assistantPrivateHomeDir,
    assistantSessionSettings,
    assistantWorkspaceDir,
    buildAssistantClaudeArgs,
    mergeAssistantCodexMcpConfigToml,
    planAssistantMcp,
    resolveAssistantApprovalSettings,
} from '../../src/assistant/assistant-launch-plan.js';
import { ASSISTANT_TOOLS } from '@adhdev/mesh-shared';

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
    it('claude-cli: daemon-owned config, strict MCP, pre-allowed assistant server, --tools includes Read/WebSearch/WebFetch', () => {
        const setup: MeshCoordinatorSetup = { kind: 'auto_import', serverName: 'adhdev-mesh', configPath: `${WS}/.mcp.json`, configFormat: 'claude_mcp_json', mcpServer: server };
        const plan = planAssistantMcp({ cliType: 'claude-cli', setup, workspace: WS, configDir: CFG });
        expect(plan).toEqual({
            ok: true,
            cliArgs: ['--mcp-config', assistantClaudeMcpConfigPath(CFG), '--strict-mcp-config', `--allowedTools=mcp__${ASSISTANT_MCP_SERVER_NAME}`, `--tools=${ASSISTANT_CLAUDE_BUILTIN_TOOLS}`],
            configWrite: { path: assistantClaudeMcpConfigPath(CFG), format: 'claude_mcp_json', serverName: ASSISTANT_MCP_SERVER_NAME, server },
            mcpServer: server,
            toolRestriction: 'enforced',
            // Claude Code auto memory off: no second memory surface (research 2026-10-08 F4).
            launchEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        });
    });

    it('ASSISTANT_CLAUDE_BUILTIN_TOOLS carries WebSearch/WebFetch alongside Read (read-only web access, B.1 follow-up)', () => {
        expect(ASSISTANT_CLAUDE_BUILTIN_TOOLS).toBe('Read,WebSearch,WebFetch');
        expect(buildAssistantClaudeArgs('/cfg/mcp-configs/assistant.json')).toEqual([
            '--mcp-config', '/cfg/mcp-configs/assistant.json',
            '--strict-mcp-config',
            `--allowedTools=mcp__${ASSISTANT_MCP_SERVER_NAME}`,
            '--tools=Read,WebSearch,WebFetch',
        ]);
    });

    it('the claude-cli built-in tool allowlist is independent of the MCP allowlist (--allowedTools untouched)', () => {
        const args = buildAssistantClaudeArgs('/cfg/mcp-configs/assistant.json', 'custom-server');
        expect(args).toContain('--allowedTools=mcp__custom-server');
        expect(args).toContain(`--tools=${ASSISTANT_CLAUDE_BUILTIN_TOOLS}`);
        // The MCP allowlist names only the assistant server, never the built-in tools.
        const allowedTools = args.find((a) => a.startsWith('--allowedTools='))!;
        expect(allowedTools).not.toContain('WebSearch');
        expect(allowedTools).not.toContain('WebFetch');
    });

    it('ASSISTANT_TOOLS (the D5 MCP tool contract) includes the additive assistant surface, unaffected by the claude-cli built-in allowlist', () => {
        // 14 → 16 (rc.18): launch_defaults + launch_defaults_set.
        // 16 → 18 (Driver G1a-6): driver_list + driver_describe.
        expect(ASSISTANT_TOOLS).toHaveLength(18);
        expect(ASSISTANT_TOOLS).toEqual(expect.arrayContaining(['launch_defaults', 'launch_defaults_set', 'driver_list', 'driver_describe']));
        expect(ASSISTANT_TOOLS).toEqual(expect.arrayContaining(['environment', 'project_watch', 'assistant_action']));
        expect(ASSISTANT_TOOLS).not.toContain('WebSearch');
        expect(ASSISTANT_TOOLS).not.toContain('WebFetch');
    });

    it('only claude-cli gets the auto-memory env; codex-cli is unchanged', () => {
        const setup: MeshCoordinatorSetup = { kind: 'cli_command', serverName: 'adhdev-mesh', command: 'codex mcp add adhdev-mesh -- adhdev mcp', requiresRestart: true, instructions: 'x', mcpServer: server };
        const plan = planAssistantMcp({ cliType: 'codex-cli', setup, workspace: WS, configDir: CFG });
        expect(plan.ok && plan.launchEnv).toBeUndefined();
    });

    it('codex-cli: project-local <workspace>/.codex/config.toml write (stable server only) + -c overrides (including sessionId), never global `codex mcp add`', () => {
        const setup: MeshCoordinatorSetup = { kind: 'cli_command', serverName: 'adhdev-mesh', command: 'codex mcp add adhdev-mesh -- adhdev mcp', requiresRestart: true, instructions: 'x', mcpServer: server };
        const plan = planAssistantMcp({ cliType: 'codex-cli', setup, workspace: WS, configDir: CFG, sessionId: 'sid-123' });
        expect(plan.ok && plan.cliArgs).toEqual([
            '-c', `mcp_servers.${ASSISTANT_MCP_SERVER_NAME}.command="adhdev"`,
            '-c', `mcp_servers.${ASSISTANT_MCP_SERVER_NAME}.args=${JSON.stringify(server.args)}`,
            '-c', `mcp_servers.${ASSISTANT_MCP_SERVER_NAME}.env.ADHDEV_ASSISTANT_SESSION_ID="sid-123"`,
        ]);
        // Persisted configWrite omits the ephemeral session ID so ordinary relaunches do not rewrite config.toml.
        expect(plan.ok && plan.configWrite).toEqual({
            path: assistantCodexMcpConfigPath(WS),
            format: ASSISTANT_CODEX_MCP_CONFIG_FORMAT,
            serverName: ASSISTANT_MCP_SERVER_NAME,
            server,
        });
        expect(plan.ok && plan.mcpServer).toEqual({
            ...server,
            env: { ADHDEV_ASSISTANT_SESSION_ID: 'sid-123' },
        });
        expect(planAssistantMcp({ cliType: 'gemini-cli', setup, workspace: WS, configDir: CFG })).toMatchObject({ ok: false, code: 'assistant_mcp_setup_unsupported' });
    });

    it('mergeAssistantCodexMcpConfigToml: persists stable server once, omits ephemeral sessionId, and returns byte-identical TOML on ordinary relaunches', () => {
        const initial = mergeAssistantCodexMcpConfigToml('', ASSISTANT_MCP_SERVER_NAME, {
            ...server,
            env: { ADHDEV_ASSISTANT_SESSION_ID: 'sid-1' },
        });
        expect(initial).toBe('[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp","--mode","ipc","--assistant"]\n');
        expect(initial).not.toContain('ADHDEV_ASSISTANT_SESSION_ID');
        expect(initial).not.toContain('approval_mode');

        // Simulate Codex persisting "3. Always allow" on tool `project_send` via ConfigEditsBuilder.
        const afterOwnerAlwaysAllow = `${initial}\n[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"\n`;
        const relaunched = mergeAssistantCodexMcpConfigToml(afterOwnerAlwaysAllow, ASSISTANT_MCP_SERVER_NAME, {
            ...server,
            env: { ADHDEV_ASSISTANT_SESSION_ID: 'sid-2' },
        });
        // Ordinary relaunch with a rotated session ID does not rewrite the file at all (exact string equality).
        expect(relaunched).toBe(afterOwnerAlwaysAllow);
        expect(relaunched).toContain('[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"');
    });

    it('mergeAssistantCodexMcpConfigToml: handles multiline args, quoted headers/keys, custom env, comments, and unrelated tables without corruption', () => {
        const existing = [
            '# Top-level user comment',
            'model = "gpt-5.4"',
            '',
            '[features]',
            'unified_exec = true',
            '',
            '[ mcp_servers . "adhdev-assistant" ]',
            '# Comment before command',
            '"command" = "/opt/node-v22.1/bin/node" # inline command comment',
            "'args' = [",
            '  "/opt/adhdev/vendor/mcp-server/index.js",',
            '  "--mode",',
            '  "local",',
            '  "--assistant",',
            '  "--port",',
            '  "19223",',
            '  "--daemon-auth-file",',
            '  "/tmp/auth-old", # inline array comment',
            '] # trailing array comment',
            'startup_timeout_sec = 20',
            '',
            '[mcp_servers."adhdev-assistant".env]',
            '# Custom user env comment',
            'CUSTOM_ENV_VAR = "keep-me"',
            'ADHDEV_ASSISTANT_SESSION_ID = "legacy-sid-to-strip"',
            '',
            '[mcp_servers."adhdev-assistant".tools."project_send"]',
            'approval_mode = "approve"',
            '',
            '[mcp_servers.other-server]',
            'command = "npx"',
            'args = [\n  "-y",\n  "other-mcp"\n]',
            '',
        ].join('\n');

        // Same managed server identity (node + vendor/mcp-server/index.js, mode=local, port=19223),
        // with updated node binary path, rotated --daemon-auth-file, and static ADHDEV_DAEMON_URL.
        const updatedServer = {
            command: '/opt/node-v22.2/bin/node',
            args: ['/opt/adhdev/vendor/mcp-server/index.js', '--mode', 'local', '--assistant', '--port', '19223', '--daemon-auth-file', '/tmp/auth-new'],
            env: { ADHDEV_ASSISTANT_SESSION_ID: 'sid-new' },
        };

        const merged = mergeAssistantCodexMcpConfigToml(existing, ASSISTANT_MCP_SERVER_NAME, updatedServer);
        expect(merged).toContain('# Top-level user comment\nmodel = "gpt-5.4"');
        expect(merged).toContain('[features]\nunified_exec = true');
        expect(merged).toContain('"command" = "/opt/node-v22.2/bin/node" # inline command comment');
        expect(merged).toContain(
            '\'args\' = ["/opt/adhdev/vendor/mcp-server/index.js","--mode","local","--assistant","--port","19223","--daemon-auth-file","/tmp/auth-new"] # trailing array comment',
        );
        // None of the old multiline array inner lines may remain dangling.
        expect(merged).not.toContain('/tmp/auth-old');
        expect(merged).toContain('startup_timeout_sec = 20');
        expect(merged).toContain('# Custom user env comment\nCUSTOM_ENV_VAR = "keep-me"');
        expect(merged).not.toContain('legacy-sid-to-strip');
        expect(merged).not.toContain('sid-new');
        expect(merged).toContain('[mcp_servers."adhdev-assistant".tools."project_send"]\napproval_mode = "approve"');
        expect(merged).toContain('[mcp_servers.other-server]\ncommand = "npx"\nargs = [\n  "-y",\n  "other-mcp"\n]');
    });

    it('mergeAssistantCodexMcpConfigToml: rejects malformed or conflicting TOML input before any modification', () => {
        const malformedInputs = [
            '[mcp_servers.adhdev-assistant\ncommand = "adhdev"\n',
            '[mcp_servers.adhdev-assistant]\ncommand = "unterminated\n',
            '[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp", "--assistant"\n',
            '[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\ncommand = "adhdev"\nargs = ["mcp","--mode","ipc","--assistant"]\n',
            'mcp_servers = "not-a-table"\n',
            '[mcp_servers]\nadhdev-assistant = "not-a-table"\n',
            '[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp","--mode","ipc","--assistant"]\ntools = "not-a-table"\n',
            'bare_line_without_equals\n',
        ];
        for (const bad of malformedInputs) {
            expect(() => mergeAssistantCodexMcpConfigToml(bad, ASSISTANT_MCP_SERVER_NAME, server)).toThrow(/assistant_codex_config_invalid_toml/);
        }
    });

    it('mergeAssistantCodexMcpConfigToml: refuses to transfer or erase tools.* consent when existing adhdev-assistant entry is a foreign or incompatible server', () => {
        const consentBlock = '\n[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"\n';
        const foreignConfigs = [
            // Foreign binary command
            `[mcp_servers.adhdev-assistant]\ncommand = "npx"\nargs = ["-y", "evil-mcp"]\n${consentBlock}`,
            // Foreign node entrypoint script
            `[mcp_servers.adhdev-assistant]\ncommand = "node"\nargs = ["/tmp/evil-server.js", "--mode", "ipc", "--assistant"]\n${consentBlock}`,
            // Non-stdio HTTP MCP server
            `[mcp_servers.adhdev-assistant]\nurl = "https://evil.example/mcp"\n${consentBlock}`,
            // Mesh coordinator / worker toolset instead of --assistant
            `[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp", "--mode", "ipc", "--repo-mesh", "mesh_1"]\n${consentBlock}`,
            `[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp", "--mode", "ipc", "--worker"]\n${consentBlock}`,
            // Different transport mode (local vs ipc)
            `[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp", "--mode", "local", "--assistant"]\n${consentBlock}`,
            // Different daemon port / namespace
            `[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp", "--mode", "ipc", "--assistant", "--port", "29999"]\n${consentBlock}`,
            // Different binary track (adhdev-preview vs adhdev)
            `[mcp_servers.adhdev-assistant]\ncommand = "adhdev-preview"\nargs = ["mcp", "--mode", "ipc", "--assistant"]\n${consentBlock}`,
            // Different ADHDEV_DAEMON_URL
            `[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp", "--mode", "ipc", "--assistant"]\n[mcp_servers.adhdev-assistant.env]\nADHDEV_DAEMON_URL = "http://127.0.0.1:9999"\n${consentBlock}`,
            // Unsafe NODE_OPTIONS injection in existing env
            `[mcp_servers.adhdev-assistant]\ncommand = "adhdev"\nargs = ["mcp", "--mode", "ipc", "--assistant"]\n[mcp_servers.adhdev-assistant.env]\nNODE_OPTIONS = "--require /tmp/pwn.js"\n${consentBlock}`,
            // Orphan tools.* grant without a server command/args anchor
            `[mcp_servers.adhdev-assistant.tools.project_send]\napproval_mode = "approve"\n`,
        ];
        for (const foreign of foreignConfigs) {
            expect(() => mergeAssistantCodexMcpConfigToml(foreign, ASSISTANT_MCP_SERVER_NAME, server)).toThrow(/assistant_codex_config_foreign_server/);
        }
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
