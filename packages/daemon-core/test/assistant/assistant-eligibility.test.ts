/**
 * Per-CLI assistant eligibility (design 2026-10-07-assistant-layer.md §4.5):
 * `describeAssistantEligibility` runs the `launch_assistant` verb's own planner
 * on the provider manifest, and the daemon.metadata lane carries the answer on
 * each CLI `availableProviders` entry so the dashboard picker cannot disagree
 * with the verb.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeAssistantEligibility } from '../../src/assistant/assistant-launch-plan.js';
import { buildAvailableProviders } from '../../src/status/snapshot.js';

const CFG = '/tmp/adhdev-cfg';

/** Expected answer per built-in CLI (the 2026-10 manifests). */
const EXPECTED: Record<string, { supported: boolean; toolRestriction: 'enforced' | 'prompt_only'; code?: string }> = {
    'claude-cli': { supported: true, toolRestriction: 'enforced' },
    'codex-cli': { supported: true, toolRestriction: 'prompt_only' },
    'cursor-cli': { supported: true, toolRestriction: 'prompt_only' },
    kimi: { supported: true, toolRestriction: 'prompt_only' },
    opencode: { supported: true, toolRestriction: 'prompt_only' },
    'grok-cli': { supported: true, toolRestriction: 'prompt_only' },
    // Global `~/.gemini/config/mcp_config.json` → the worker private-HOME mechanism at a stable assistant dir.
    'antigravity-cli': { supported: true, toolRestriction: 'prompt_only' },
};

/** The `meshCoordinator.mcpConfig` blocks of the shipped manifests (OSS-only checkouts have no adhdev-providers sibling). */
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

function pick(e: ReturnType<typeof describeAssistantEligibility>) {
    return { supported: e.supported, toolRestriction: e.toolRestriction, ...(e.code ? { code: e.code } : {}) };
}

describe('describeAssistantEligibility', () => {
    it.each(Object.keys(EXPECTED))('%s (fixture manifest)', (cliType) => {
        const provider = { meshCoordinator: { supported: true, mcpConfig: FIXTURES[cliType] } } as any;
        expect(pick(describeAssistantEligibility({ cliType, provider, configDir: CFG }))).toEqual(EXPECTED[cliType]);
    });

    it('refuses with a reason: no coordinator support, a manual non-command template, codex-style registration on another CLI', () => {
        const none = describeAssistantEligibility({ cliType: 'aider-cli', provider: { meshCoordinator: { supported: false, reason: 'no MCP' } } as any, configDir: CFG });
        expect(none).toEqual({ supported: false, toolRestriction: 'prompt_only', code: 'assistant_unsupported', reason: 'no MCP' });
        expect(describeAssistantEligibility({ cliType: 'x', provider: null, configDir: CFG })).toMatchObject({ supported: false, code: 'assistant_unsupported' });
        const manual = describeAssistantEligibility({
            cliType: 'y', configDir: CFG,
            provider: { meshCoordinator: { supported: true, mcpConfig: { mode: 'manual', instructions: 'edit it', template: '{\n"a":1}' } } } as any,
        });
        expect(manual).toMatchObject({ supported: false, code: 'assistant_manual_mcp_setup_required', reason: 'edit it' });
        const otherCli = describeAssistantEligibility({ cliType: 'gemini-cli', provider: { meshCoordinator: { supported: true, mcpConfig: FIXTURES['codex-cli'] } } as any, configDir: CFG });
        expect(otherCli).toMatchObject({ supported: false, code: 'assistant_mcp_setup_unsupported' });
        expect(otherCli.reason).toContain('global config');
        // A global `~/…` config with no private-HOME spec for the CLI stays refused.
        const globalNoSpec = describeAssistantEligibility({ cliType: 'gemini-cli', provider: { meshCoordinator: { supported: true, mcpConfig: FIXTURES['antigravity-cli'] } } as any, configDir: CFG });
        expect(globalNoSpec).toMatchObject({ supported: false, code: 'assistant_mcp_setup_unsupported' });
    });

    const providersRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../adhdev-providers/cli');
    it.skipIf(!existsSync(providersRoot)).each(Object.keys(EXPECTED))('%s (real adhdev-providers manifest)', (cliType) => {
        const manifest = JSON.parse(readFileSync(join(providersRoot, cliType, 'provider.v1.json'), 'utf8'));
        expect(manifest.type).toBe(cliType);
        expect(pick(describeAssistantEligibility({ cliType, provider: manifest, configDir: CFG }))).toEqual(EXPECTED[cliType]);
    });
});

describe('availableProviders carries assistant eligibility (daemon.metadata lane)', () => {
    it('stamps CLI entries only, from the same planner', () => {
        const loader = {
            getAll: () => [
                { type: 'claude-cli', category: 'cli', meshCoordinator: { supported: true, mcpConfig: FIXTURES['claude-cli'] } },
                { type: 'antigravity-cli', category: 'cli', meshCoordinator: { supported: true, mcpConfig: FIXTURES['antigravity-cli'] } },
                { type: 'aider-cli', category: 'cli' },
                { type: 'cursor', category: 'ide' },
            ],
        } as any;
        const byType = Object.fromEntries(buildAvailableProviders(loader).map((p) => [p.type, p]));
        expect(byType['claude-cli'].assistant).toEqual({ supported: true, toolRestriction: 'enforced' });
        expect(byType['antigravity-cli'].assistant).toEqual({ supported: true, toolRestriction: 'prompt_only' });
        expect(byType['aider-cli'].assistant).toMatchObject({ supported: false, code: 'assistant_unsupported' });
        expect(byType.cursor).not.toHaveProperty('assistant');
    });
});
