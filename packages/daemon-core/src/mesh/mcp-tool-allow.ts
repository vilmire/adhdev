/**
 * Pre-approve ADHDev's own MCP servers at a CLI's per-TOOL permission layer.
 *
 * cursor-agent has two independent MCP gates: `--approve-mcps` (or the
 * `mcp-approvals.json` file) approves LOADING a server, while every tool call
 * still parks the session on "Run this MCP tool?" unless `Mcp(<server>:<tool>)`
 * is in the permissions allow list (matcher in cursor-agent 2026.10.22:
 * `matchesMcpPattern`, `*` wildcards per side). An ADHDev assistant / worker /
 * coordinator would therefore stop on its first `projects` or
 * `report_completion` call.
 *
 * Owner principle: usefulness first, security second — written down, not
 * silent. Trade-off: for the named ADHDev servers ONLY (`adhdev-assistant`,
 * `adhdev-worker`, `adhdev-mesh`) cursor's per-call consent is skipped. Those
 * servers are ADHDev's own token-scoped surface. Third-party MCP servers, shell
 * and file writes keep their normal prompts, and nothing here passes `--force`.
 *
 * Placement follows the MCP config the daemon just wrote:
 *  - inside the workspace  → project permissions `<dir>/cli.json`
 *  - outside (private HOME) → user permissions `<dir>/cli-config.json`
 * The file is created if absent and merged otherwise (other keys and other
 * allow/deny entries are kept; a file that does not parse is left alone).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

import { ensureLocalGitExclude } from '../git/git-local-exclude.js';
import { LOG } from '../logging/logger.js';

export interface McpToolAllowDeclaration { format: 'cursor_cli_permissions' }

export function isMcpToolAllowDeclared(value: unknown): value is McpToolAllowDeclaration {
    return !!value && typeof value === 'object' && (value as { format?: unknown }).format === 'cursor_cli_permissions';
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Allow entries cursor understands for a server: every tool of it. */
export function cursorMcpAllowEntries(serverNames: readonly string[]): string[] {
    return serverNames.map((n) => n.trim()).filter(Boolean).map((n) => `Mcp(${n}:*)`);
}

/**
 * Merge `Mcp(<server>:*)` entries for `serverNames` into the permissions file
 * that sits next to `mcpConfigPath`. Returns the file path, or null when
 * nothing was written (best effort — a failure must never fail a launch; the
 * detection safety net in the provider spec still handles the prompt).
 */
export function ensureCursorMcpToolAllow(input: {
    mcpConfigPath: string;
    workspace: string;
    serverNames: readonly string[];
}): string | null {
    const entries = cursorMcpAllowEntries(input.serverNames);
    if (!entries.length) return null;
    const dir = path.dirname(input.mcpConfigPath);
    const inWorkspace = isInside(input.mcpConfigPath, input.workspace);
    const target = path.join(dir, inWorkspace ? 'cli.json' : 'cli-config.json');
    try {
        let config: Record<string, any> = {};
        if (existsSync(target)) {
            const raw = readFileSync(target, 'utf-8');
            if (raw.trim()) {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
                config = parsed;
            }
        }
        const permissions = config.permissions && typeof config.permissions === 'object' && !Array.isArray(config.permissions)
            ? config.permissions : {};
        const allow: unknown[] = Array.isArray(permissions.allow) ? permissions.allow : [];
        const missing = entries.filter((e) => !allow.includes(e));
        if (!missing.length && existsSync(target)) return target;
        config = {
            ...config,
            permissions: { ...permissions, allow: [...allow, ...missing], deny: Array.isArray(permissions.deny) ? permissions.deny : [] },
        };
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
        if (inWorkspace) ensureLocalGitExclude(input.workspace, target);
        return target;
    } catch (err: any) {
        LOG.warn('McpToolAllow', `could not pre-approve ${entries.join(', ')} in ${target}: ${err?.message || err}`);
        return null;
    }
}
