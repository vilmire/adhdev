/**
 * Grok coordinator MCP config for repos that commit `.mcp.json`.
 *
 * grok has no per-launch MCP flag (unlike claude's `--mcp-config` or codex's
 * `-c`), and the coordinator entry written into a TRACKED `.mcp.json` dirtied
 * the base node so Refinery refused every merge (2026-10-05 provider matrix,
 * grok→claude). grok's project config `.grok/config.toml` takes precedence over
 * `.mcp.json` for a server of the same name (measured with `grok inspect`), and
 * is normally untracked — so the entry goes there instead.
 *
 * Only the `[mcp_servers.<name>]` table (and its sub-tables) is replaced; every
 * other line of the file is kept byte-for-byte.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureLocalGitExclude } from '../git/git-local-exclude.js';

export const GROK_PROJECT_CONFIG_RELATIVE_PATH = path.join('.grok', 'config.toml');

/** A JSON string / string array is valid TOML for these values. */
function tomlValue(value: string | string[]): string {
    return JSON.stringify(value);
}

function tomlKey(key: string): string {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export function renderGrokMcpServerTable(
    name: string,
    server: { command: string; args: string[]; env?: Record<string, string> },
): string {
    const lines = [
        `[mcp_servers.${tomlKey(name)}]`,
        `command = ${tomlValue(server.command)}`,
        `args = ${tomlValue(server.args)}`,
    ];
    if (server.env && Object.keys(server.env).length > 0) {
        lines.push('', `[mcp_servers.${tomlKey(name)}.env]`);
        for (const [key, value] of Object.entries(server.env)) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
    }
    return lines.join('\n') + '\n';
}

/** Replace (or append) the server's tables in existing TOML text. */
export function upsertGrokMcpServerTable(
    existing: string,
    name: string,
    server: { command: string; args: string[]; env?: Record<string, string> },
): string {
    const header = /^\s*\[([^\]]+)\]\s*$/;
    const own = new Set([`mcp_servers.${tomlKey(name)}`, `mcp_servers.${tomlKey(name)}.env`]);
    const kept: string[] = [];
    let skipping = false;
    for (const line of existing.split('\n')) {
        const m = line.match(header);
        if (m) skipping = own.has(m[1].trim());
        if (!skipping) kept.push(line);
    }
    const body = kept.join('\n').replace(/\s+$/, '');
    return (body ? body + '\n\n' : '') + renderGrokMcpServerTable(name, server);
}

export function writeGrokProjectMcpServer(
    workspace: string,
    name: string,
    server: { command: string; args: string[]; env?: Record<string, string> },
): string {
    const file = path.join(workspace, GROK_PROJECT_CONFIG_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const next = upsertGrokMcpServerTable(existing, name, server);
    if (next !== existing) fs.writeFileSync(file, next, 'utf-8');
    ensureLocalGitExclude(workspace, file);
    return file;
}
