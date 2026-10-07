/**
 * Launch planning for the assistant session (design
 * docs/design/2026-10-07-assistant-layer.md §4.5, appendix B.1). Pure: the
 * `launch_assistant` verb (commands/high-family/assistant-launch.ts) does the
 * I/O; everything that decides arguments, paths and settings is here so it is
 * testable without a daemon.
 *
 * MCP wiring per provider (the mesh coordinator's MCP setup resolved with the
 * `{kind:'assistant'}` toolset → `adhdev mcp --assistant`):
 *   - claude-cli: a daemon-owned config `<configDir>/mcp-configs/assistant.json`
 *     + `--mcp-config <path> --strict-mcp-config` (no user MCP servers in the
 *     assistant), the assistant server pre-allowed, and `--tools=Read` as the
 *     BUILT-IN tool allowlist (B.1: `--allowedTools` is a pre-approval list,
 *     not a restriction). `claude --help` documents `--tools` as "the list of
 *     available tools from the built-in set", so MCP tools stay available; the
 *     `=` form keeps the variadic flag from swallowing later args.
 *   - codex-cli (`cli_command` registration): never `codex mcp add` (that
 *     writes the user's global codex config) — `-c mcp_servers.*` overrides.
 *   - other auto-import providers: the config is written inside the assistant
 *     workspace (not a repo, so nothing tracked gets dirty). A provider whose
 *     config path is outside the workspace (a global file) is refused.
 *   - manual / other cli_command providers: refused (fail closed, no global
 *     registration on the user's behalf).
 *
 * Session id (all providers): the assistant MCP server learns its session from
 * `ADHDEV_ASSISTANT_SESSION_ID`, carried in the server entry itself — the
 * config file's `env` block, or codex's `-c mcp_servers.<name>.env.*` — never
 * by inheritance from the CLI's process env (codex hands an MCP child only the
 * env its config lists; same rule as the delegated worker's session bind in
 * mesh/worker-mcp-config.ts). The verb mints the id before planning and passes
 * it to `launch_cli` (`assistantSessionKey`) so the config and the live
 * session agree on one value.
 *
 * Approval: the default is NO auto-approve (the assistant has shell-capable
 * tools near the home directory on every CLI but claude, §4.5 "위험 모드는
 * 절대 쓰지 않는다"). A caller may pick one declared mode explicitly; a mode
 * that is (or derives to) `dangerous` is refused.
 */

import { join, resolve, sep } from 'path';
import { ASSISTANT_SESSION_ID_ENV } from '@adhdev/mesh-shared';
import { resolveMeshCoordinatorSetup, type MeshCoordinatorSetup } from '../commands/mesh-coordinator.js';
import { deriveAutoApproveModeRisk } from '../providers/auto-approve-modes.js';
import type { ProviderModule } from '../providers/contracts.js';
import type { ProviderAssistantEligibility } from '../shared-types.js';

export const DEFAULT_ASSISTANT_CLI_TYPE = 'claude-cli';
export const ASSISTANT_MCP_SERVER_NAME = 'adhdev-assistant';
/** claude-cli built-in tool allowlist (B.1). */
export const ASSISTANT_CLAUDE_BUILTIN_TOOLS = 'Read';

export function assistantWorkspaceDir(configDir: string): string {
    return join(configDir, 'assistant');
}

export function assistantClaudeMcpConfigPath(configDir: string): string {
    return join(configDir, 'mcp-configs', 'assistant.json');
}

export interface AssistantMcpConfigWrite {
    path: string;
    format: string;
    serverName: string;
    server: AssistantMcpServerLaunch;
}

export interface AssistantMcpServerLaunch {
    command: string;
    args: string[];
    env?: Record<string, string>;
}

/**
 * How the assistant's tool limit is held: `enforced` = the CLI's own built-in
 * tool allowlist (claude-cli `--tools=Read`); `prompt_only` = the system prompt
 * is the only restriction (every other CLI keeps its shell-capable tools).
 */
export type AssistantToolRestriction = ProviderAssistantEligibility['toolRestriction'];

export type AssistantMcpPlan =
    | {
        ok: true;
        cliArgs: string[];
        configWrite: AssistantMcpConfigWrite | null;
        mcpServer: AssistantMcpServerLaunch;
        toolRestriction: AssistantToolRestriction;
    }
    | { ok: false; code: string; error: string };

function isInside(path: string, dir: string): boolean {
    const p = resolve(path);
    const d = resolve(dir);
    return p === d || p.startsWith(d + sep);
}

/** claude-cli argv for the assistant MCP server and the built-in tool allowlist. */
export function buildAssistantClaudeArgs(mcpConfigPath: string, serverName: string = ASSISTANT_MCP_SERVER_NAME): string[] {
    return [
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
        `--allowedTools=mcp__${serverName}`,
        `--tools=${ASSISTANT_CLAUDE_BUILTIN_TOOLS}`,
    ];
}

/**
 * Codex `-c` overrides carrying one MCP server entry (TOML values; JSON strings/arrays are valid TOML).
 * Each env var is its own dotted override (`mcp_servers.<name>.env.<KEY>="v"`): codex passes an MCP
 * child only the env its config lists, so inheritance from the codex process never reaches it.
 */
export function buildAssistantCodexOverrideArgs(serverName: string, server: AssistantMcpServerLaunch): string[] {
    const args = [
        '-c', `mcp_servers.${serverName}.command=${JSON.stringify(server.command)}`,
        '-c', `mcp_servers.${serverName}.args=${JSON.stringify(server.args)}`,
    ];
    for (const [key, value] of Object.entries(server.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        args.push('-c', `mcp_servers.${serverName}.env.${key}=${JSON.stringify(value)}`);
    }
    return args;
}

/** The assistant MCP server launch with its session id in the entry's own env (absent id → unchanged). */
export function withAssistantSessionEnv(
    server: { command: string; args: string[]; env?: Record<string, string> },
    sessionId: string | undefined,
): AssistantMcpServerLaunch {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return server;
    return { ...server, env: { ...(server.env ?? {}), [ASSISTANT_SESSION_ID_ENV]: id } };
}

export function planAssistantMcp(input: {
    cliType: string;
    setup: MeshCoordinatorSetup;
    workspace: string;
    configDir: string;
    /** The session id the launch will use (minted before planning); stamped into the server env. */
    sessionId?: string;
}): AssistantMcpPlan {
    const { cliType, setup, workspace, configDir } = input;
    const serverName = ASSISTANT_MCP_SERVER_NAME;
    if (setup.kind === 'unsupported') return { ok: false, code: 'assistant_unsupported', error: setup.reason };
    if (setup.kind === 'manual') {
        return { ok: false, code: 'assistant_manual_mcp_setup_required', error: setup.instructions };
    }
    if (setup.kind === 'cli_command') {
        if (cliType !== 'codex-cli') {
            return {
                ok: false,
                code: 'assistant_mcp_setup_unsupported',
                error: `${cliType} registers MCP servers in its global config; the assistant does not register one on your behalf`,
            };
        }
        const codexServer = withAssistantSessionEnv(setup.mcpServer, input.sessionId);
        return {
            ok: true,
            cliArgs: buildAssistantCodexOverrideArgs(serverName, codexServer),
            configWrite: null,
            mcpServer: codexServer,
            toolRestriction: 'prompt_only',
        };
    }
    const mcpServer = withAssistantSessionEnv(setup.mcpServer, input.sessionId);
    if (cliType === 'claude-cli') {
        const path = assistantClaudeMcpConfigPath(configDir);
        return {
            ok: true,
            cliArgs: buildAssistantClaudeArgs(path, serverName),
            configWrite: { path, format: setup.configFormat ?? 'claude_mcp_json', serverName, server: mcpServer },
            mcpServer,
            toolRestriction: 'enforced',
        };
    }
    if (!isInside(setup.configPath, workspace)) {
        return {
            ok: false,
            code: 'assistant_mcp_setup_unsupported',
            error: `${cliType} reads MCP servers from ${setup.configPath}, outside the assistant workspace; the assistant does not write a global config`,
        };
    }
    return {
        ok: true,
        cliArgs: [],
        configWrite: { path: setup.configPath, format: setup.configFormat ?? 'claude_mcp_json', serverName, server: mcpServer },
        mcpServer,
        toolRestriction: 'prompt_only',
    };
}

/**
 * Would `launch_assistant` accept this CLI? Runs the SAME two steps the verb
 * runs (`resolveMeshCoordinatorSetup` with the assistant toolset →
 * `planAssistantMcp`) on the provider manifest, so the dashboard's picker and
 * the verb cannot disagree. Pure apart from resolving `~` and relative MCP
 * config paths: the MCP server launch is pinned to a placeholder command
 * because only the setup KIND and config PATH decide eligibility, never the
 * binary the server would run.
 */
export function describeAssistantEligibility(input: {
    cliType: string;
    provider: Pick<ProviderModule, 'meshCoordinator'> | null | undefined;
    configDir: string;
}): ProviderAssistantEligibility {
    const { cliType, provider, configDir } = input;
    const workspace = assistantWorkspaceDir(configDir);
    const setup = resolveMeshCoordinatorSetup({
        provider: (provider ?? null) as ProviderModule | null,
        cliType,
        meshId: '',
        workspace,
        toolset: { kind: 'assistant' },
        adhdevMcpCommand: 'adhdev',
        adhdevMcpTransport: 'ipc',
        adhdevMcpPort: 1,
    });
    const plan = planAssistantMcp({ cliType, setup, workspace, configDir });
    if (plan.ok) return { supported: true, toolRestriction: plan.toolRestriction };
    return { supported: false, toolRestriction: 'prompt_only', code: plan.code, reason: plan.error };
}

export type AssistantApprovalSettings =
    | { ok: true; settings: Record<string, unknown> }
    | { ok: false; code: string; error: string };

/**
 * Approval settings for the assistant session. Default: auto-approve OFF
 * (`autoApprove:false`, no mode — every prompt waits for the person). An
 * explicit `requested` mode must exist on the provider and must not be
 * dangerous.
 */
export function resolveAssistantApprovalSettings(provider: ProviderModule | null | undefined, requested: unknown): AssistantApprovalSettings {
    const id = typeof requested === 'string' ? requested.trim() : '';
    if (!id) return { ok: true, settings: { autoApprove: false, autoApproveMode: undefined } };
    const mode = provider?.autoApproveModes?.modes.find((m) => m.id === id);
    if (!mode) return { ok: false, code: 'invalid_args', error: `unknown autoApproveMode: ${id}` };
    if (deriveAutoApproveModeRisk(mode) === 'dangerous') {
        return { ok: false, code: 'assistant_dangerous_mode_refused', error: `autoApproveMode ${id} is dangerous; the assistant never runs in a dangerous mode` };
    }
    return { ok: true, settings: { autoApproveMode: id, autoApprove: undefined } };
}

/** The settings stamp every assistant launch (and restore) carries. */
export function assistantSessionSettings(approval: Record<string, unknown>): Record<string, unknown> {
    return { assistant: true, ...approval };
}
