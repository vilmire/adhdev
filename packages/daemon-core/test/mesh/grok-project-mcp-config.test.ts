/**
 * Grok coordinator in a repo that commits `.mcp.json`: the coordinator entry goes
 * to grok's project `.grok/config.toml` (which outranks `.mcp.json` for the same
 * server name) so the tracked file — and the base node — stay clean.
 */
import { describe, expect, it } from 'vitest';
import { renderGrokMcpServerTable, upsertGrokMcpServerTable } from '../../src/mesh/grok-project-mcp-config.js';

const server = { command: '/usr/bin/node', args: ['/x/index.js', '--mode', 'local'], env: { ADHDEV_INLINE_MESH: '{"id":"m","q":"a\\"b"}' } };

describe('grok project MCP config', () => {
    it('renders the server and its env as TOML tables', () => {
        expect(renderGrokMcpServerTable('adhdev-mesh', server)).toBe([
            '[mcp_servers.adhdev-mesh]',
            'command = "/usr/bin/node"',
            'args = ["/x/index.js","--mode","local"]',
            '',
            '[mcp_servers.adhdev-mesh.env]',
            'ADHDEV_INLINE_MESH = "{\\"id\\":\\"m\\",\\"q\\":\\"a\\\\\\"b\\"}"',
            '',
        ].join('\n'));
    });

    it('replaces only its own tables and keeps the rest of the file', () => {
        const existing = [
            '[ui]',
            'screen_mode = "minimal"',
            '',
            '[mcp_servers.adhdev-mesh]',
            'command = "old"',
            'args = []',
            '',
            '[mcp_servers.adhdev-mesh.env]',
            'OLD = "1"',
            '',
            '[mcp_servers.other]',
            'command = "keep"',
        ].join('\n');
        const next = upsertGrokMcpServerTable(existing, 'adhdev-mesh', server);
        expect(next).toContain('[ui]\nscreen_mode = "minimal"');
        expect(next).toContain('[mcp_servers.other]\ncommand = "keep"');
        expect(next).not.toContain('command = "old"');
        expect(next).not.toContain('OLD = "1"');
        expect(next.match(/\[mcp_servers\.adhdev-mesh\]/g)).toHaveLength(1);
        // Idempotent: a second upsert with the same entry changes nothing.
        expect(upsertGrokMcpServerTable(next, 'adhdev-mesh', server)).toBe(next);
    });
});
