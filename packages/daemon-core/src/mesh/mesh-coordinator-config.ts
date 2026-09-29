/**
 * MCP coordinator config helpers
 *
 * Extracted from commands/router.ts (behavior-preserving move). Contains the
 * MCP-server config parse/serialize/entry-build helpers for the coordinator
 * auto-import formats.
 *
 * router.ts re-exports every public symbol from here so existing import paths
 * keep working.
 */

import type { MeshCoordinatorConfigFormat } from './mesh-refine-gates.js';

/**
 * Every auto-import config format this module can parse/serialize/build an
 * entry for. The coordinator LAUNCH path gates on this list before writing a
 * workspace config — keep it here, next to the parse/serialize/build helpers,
 * so a new format cannot pass schema validation yet be rejected at launch
 * (the opencode_json miss: the format existed in the enum, the schema and the
 * helpers below, but the launch path carried its own two-entry allowlist).
 */
export const MESH_COORDINATOR_AUTO_IMPORT_FORMATS: readonly MeshCoordinatorConfigFormat[] =
    ['claude_mcp_json', 'opencode_json'];

export function isSupportedMeshCoordinatorConfigFormat(format: unknown): format is MeshCoordinatorConfigFormat {
    return MESH_COORDINATOR_AUTO_IMPORT_FORMATS.includes(format as MeshCoordinatorConfigFormat);
}

export function getMcpServersKey(format: MeshCoordinatorConfigFormat): 'mcpServers' | 'mcp' {
    if (format === 'opencode_json') return 'mcp'; // opencode.json `mcp` block (opencode.ai/docs/mcp-servers)
    return 'mcpServers';
}

export function parseMeshCoordinatorMcpConfig(text: string, _format: MeshCoordinatorConfigFormat): Record<string, any> {
    if (!text.trim()) return {};
    return JSON.parse(text);
}

export function serializeMeshCoordinatorMcpConfig(config: Record<string, any>, _format: MeshCoordinatorConfigFormat): string {
    return JSON.stringify(config, null, 2);
}

/**
 * Format-specific server ENTRY shape for the auto-import writer. Claude-style
 * configs (claude_mcp_json) take `{command, args, env?}`; opencode's `mcp`
 * block takes a local-server object with the command+args as ONE array
 * (`{type:'local', command:[...], enabled, environment?}`).
 */
export function buildMeshCoordinatorMcpServerEntry(
    format: MeshCoordinatorConfigFormat,
    server: { command: string; args: string[]; env?: Record<string, string> },
): Record<string, any> {
    if (format === 'opencode_json') {
        return {
            type: 'local',
            command: [server.command, ...server.args],
            enabled: true,
            ...(server.env ? { environment: server.env } : {}),
        };
    }
    return {
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
    };
}
