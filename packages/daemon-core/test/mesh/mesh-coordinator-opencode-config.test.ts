import { describe, expect, it } from 'vitest';
import {
    MESH_COORDINATOR_AUTO_IMPORT_FORMATS,
    buildMeshCoordinatorMcpServerEntry,
    getMcpServersKey,
    isSupportedMeshCoordinatorConfigFormat,
    parseMeshCoordinatorMcpConfig,
    serializeMeshCoordinatorMcpConfig,
} from '../../src/mesh/mesh-coordinator-config.js';

// ALL-CLI-COORDINATOR: the opencode_json auto-import format added so opencode
// (and, via claude_mcp_json + .kimi-code/mcp.json, kimi) can host a mesh
// coordinator. opencode's config schema differs structurally from the
// Claude-style {command,args} entry: servers live under `mcp` as
// {type:'local', command:[...]} (opencode.ai/docs/mcp-servers).
describe('opencode_json coordinator MCP config format', () => {
    const server = {
        command: 'node',
        args: ['/x/adhdev-mcp.js', 'mcp', '--mode', 'ipc', '--repo-mesh', 'mesh-1'],
    };

    it('nests servers under the opencode `mcp` key', () => {
        expect(getMcpServersKey('opencode_json')).toBe('mcp');
        expect(getMcpServersKey('claude_mcp_json')).toBe('mcpServers');
        expect(getMcpServersKey('hermes_config_yaml')).toBe('mcp_servers');
    });

    it('builds a local-server entry with command+args as ONE array', () => {
        const entry = buildMeshCoordinatorMcpServerEntry('opencode_json', server);
        expect(entry).toEqual({
            type: 'local',
            command: ['node', '/x/adhdev-mcp.js', 'mcp', '--mode', 'ipc', '--repo-mesh', 'mesh-1'],
            enabled: true,
        });
    });

    it('maps env to opencode `environment` (claude formats keep `env`)', () => {
        const env = { ADHDEV_INLINE_MESH: '{"id":"m"}' };
        expect(buildMeshCoordinatorMcpServerEntry('opencode_json', { ...server, env }).environment).toEqual(env);
        const claudeEntry = buildMeshCoordinatorMcpServerEntry('claude_mcp_json', { ...server, env });
        expect(claudeEntry.env).toEqual(env);
        expect(claudeEntry.command).toBe('node');
        expect(claudeEntry.args).toEqual(server.args);
    });

    it('round-trips as JSON and merges into an existing opencode.json shape', () => {
        const existing = {
            $schema: 'https://opencode.ai/config.json',
            mcp: { other: { type: 'local', command: ['x'], enabled: true } },
            instructions: ['docs/guide.md'],
        };
        const text = serializeMeshCoordinatorMcpConfig(existing, 'opencode_json');
        const parsed = parseMeshCoordinatorMcpConfig(text, 'opencode_json');
        expect(parsed).toEqual(existing);
        // The launch writer's merge pattern: spread existing servers, add ours.
        const merged = {
            ...parsed,
            mcp: { ...parsed.mcp, 'adhdev-mesh': buildMeshCoordinatorMcpServerEntry('opencode_json', server) },
        };
        expect(Object.keys(merged.mcp)).toEqual(['other', 'adhdev-mesh']);
        expect(merged.instructions).toEqual(['docs/guide.md']);
    });

    // COORD-FORMAT-ALLOWLIST (live P4 verification catch): the launch path used
    // to carry its own two-entry format allowlist, so opencode_json passed the
    // schema + helpers but was rejected at launch with
    // "Unsupported auto-import MCP config format". The launch gate now consumes
    // this shared list — every format the helpers support must be in it.
    it('the shared auto-import format list covers every format the helpers support', () => {
        expect([...MESH_COORDINATOR_AUTO_IMPORT_FORMATS].sort())
            .toEqual(['claude_mcp_json', 'hermes_config_yaml', 'opencode_json']);
        for (const format of MESH_COORDINATOR_AUTO_IMPORT_FORMATS) {
            expect(isSupportedMeshCoordinatorConfigFormat(format)).toBe(true);
            // parse/serialize/build must all accept it — the list and the helpers move together.
            expect(() => buildMeshCoordinatorMcpServerEntry(format, server)).not.toThrow();
            expect(parseMeshCoordinatorMcpConfig(serializeMeshCoordinatorMcpConfig({}, format), format)).toEqual({});
        }
        expect(isSupportedMeshCoordinatorConfigFormat('cli_command')).toBe(false);
        expect(isSupportedMeshCoordinatorConfigFormat(undefined)).toBe(false);
    });
});
