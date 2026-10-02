/**
 * A Claude coordinator gets its MCP config via `--mcp-config <path>`, so the file
 * need not live in the repo. When the repo TRACKS `.mcp.json`, writing the
 * coordinator's server entry into it dirtied the base node and the coordinator had
 * to stop and ask how to handle the uncommitted file (2026-10-02 demo mesh).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { resolveClaudeCoordinatorMcpConfigPath } from '../../src/commands/high-family/mesh-coordinator-launch.js';

const ws = '/repo';
const base = { configPath: join(ws, '.mcp.json'), workspace: ws, meshId: 'mesh_abc', configDir: '/home/u/.adhdev' };

describe('resolveClaudeCoordinatorMcpConfigPath', () => {
    it('moves the config out of the repo when .mcp.json is tracked', () => {
        expect(resolveClaudeCoordinatorMcpConfigPath({ ...base, isTracked: () => true }))
            .toBe(join('/home/u/.adhdev', 'mcp-configs', 'mesh_abc.json'));
    });

    it('keeps the repo path when .mcp.json is untracked or absent', () => {
        expect(resolveClaudeCoordinatorMcpConfigPath({ ...base, isTracked: () => false })).toBe(join(ws, '.mcp.json'));
    });

    it('leaves a path outside the workspace alone', () => {
        expect(resolveClaudeCoordinatorMcpConfigPath({ ...base, configPath: '/elsewhere/mcp.json', isTracked: () => true })).toBe('/elsewhere/mcp.json');
    });
});
