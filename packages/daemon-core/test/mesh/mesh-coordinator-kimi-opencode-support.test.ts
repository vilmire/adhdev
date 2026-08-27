import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMeshCoordinatorSetup, applyMeshCoordinatorSystemPromptInjection, cleanupCoordinatorAgentFile } from '../../src/commands/mesh-coordinator.js';
import { validateProviderDefinition } from '../../src/providers/provider-schema.js';

// ALL-CLI-COORDINATOR end-to-end (minus process spawn): drive the EXACT gates
// the live launch path runs — resolveMeshCoordinatorSetup (the source of the
// historical "Provider does not declare Repo Mesh coordinator support"
// refusal) and the system-prompt injection — against the REAL kimi/opencode
// manifests from the sibling adhdev-providers checkout. The spawn path itself
// is shared with the already-live-verified providers (claude/agy).

function loadRealManifest(type: 'kimi' | 'opencode'): Record<string, any> {
    // Walk up from the package root to find the sibling adhdev-providers checkout
    // (same shape the ProviderLoader sibling probe accepts in the test harness).
    let current = path.resolve(__dirname, '..', '..');
    for (let hops = 0; hops < 8; hops += 1) {
        const candidate = path.join(current, 'adhdev-providers', 'cli', type, 'provider.v1.json');
        if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        current = path.dirname(current);
    }
    throw new Error(`sibling adhdev-providers checkout not found for ${type}`);
}

describe.each(['kimi', 'opencode'] as const)('%s mesh coordinator declaration', (type) => {
    const manifest = loadRealManifest(type);

    it('passes provider-schema validation (incl. the mcpConfig format enum)', () => {
        const result = validateProviderDefinition(manifest) as { errors?: string[] };
        const coordErrors = (result.errors ?? []).filter((e: string) => e.includes('meshCoordinator'));
        expect(coordErrors).toEqual([]);
    });

    it('resolves an auto_import MCP setup (no more "unsupported" refusal)', () => {
        const setup = resolveMeshCoordinatorSetup({
            provider: manifest as any,
            cliType: type,
            meshId: 'mesh-verify',
            workspace: '/tmp/ws',
        } as any);
        expect(setup.kind).toBe('auto_import');
        expect((setup as any).serverName).toBe('adhdev-mesh');
        if (type === 'kimi') {
            expect((setup as any).configFormat).toBe('claude_mcp_json');
            // configPath is built with path.join(), which emits OS-native
            // separators — match against the joined suffix, not a
            // hardcoded forward-slash literal.
            expect(String((setup as any).configPath)).toContain(path.join('.kimi-code', 'mcp.json'));
        } else {
            expect((setup as any).configFormat).toBe('opencode_json');
            expect(String((setup as any).configPath)).toContain('opencode.json');
        }
    });

    if (type === 'kimi') {
        it('injects the coordinator prompt via a daemon-owned temp agent file (--agent-file)', () => {
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `coord-${type}-`));
            let agentFilePath: string | undefined;
            try {
                const cliArgs: string[] = [];
                const launchEnv: Record<string, string> = {};
                const effect = applyMeshCoordinatorSystemPromptInjection(
                    'COORDINATOR PROMPT BODY',
                    (manifest as any).meshCoordinator.systemPromptInjection,
                    { cliArgs, launchEnv, workspace, cliType: type },
                );
                agentFilePath = effect.agentFilePath;
                // Prompt travels via a temp agent file path on argv — never the
                // workspace, never env.
                expect(agentFilePath).toBeTruthy();
                expect(cliArgs).toEqual(['--agent-file', agentFilePath]);
                expect(launchEnv).toEqual({});
                const written = fs.readFileSync(agentFilePath!, 'utf-8');
                // kimi renders ${base_prompt} itself; the daemon only substitutes {prompt}.
                expect(written).toContain('${base_prompt}');
                expect(written).toContain('COORDINATOR PROMPT BODY');
                // The file lives outside the workspace and the workspace is untouched.
                expect(agentFilePath!.startsWith(workspace)).toBe(false);
                expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false);
                // Cleanup removes the file and its temp dir, and is idempotent.
                cleanupCoordinatorAgentFile(agentFilePath!);
                expect(fs.existsSync(agentFilePath!)).toBe(false);
                cleanupCoordinatorAgentFile(agentFilePath!);
            } finally {
                fs.rmSync(workspace, { recursive: true, force: true });
                if (agentFilePath) cleanupCoordinatorAgentFile(agentFilePath);
            }
        });
    } else {
        it('injects the coordinator prompt into workspace AGENTS.md with the marker wrapper', () => {
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `coord-${type}-`));
            try {
                const cliArgs: string[] = [];
                const launchEnv: Record<string, string> = {};
                const effect = applyMeshCoordinatorSystemPromptInjection(
                    'COORDINATOR PROMPT BODY',
                    (manifest as any).meshCoordinator.systemPromptInjection,
                    { cliArgs, launchEnv, workspace, cliType: type },
                );
                const agentsPath = path.join(workspace, 'AGENTS.md');
                expect(effect.contextFilePath).toBe(agentsPath);
                const written = fs.readFileSync(agentsPath, 'utf-8');
                expect(written).toContain('<!-- adhdev-mesh-coordinator-prompt -->');
                expect(written).toContain('COORDINATOR PROMPT BODY');
                expect(written).toContain('<!-- /adhdev-mesh-coordinator-prompt -->');
                // Prompt travels via the context file — never argv/env for these CLIs.
                expect(cliArgs).toEqual([]);
                expect(launchEnv).toEqual({});
            } finally {
                fs.rmSync(workspace, { recursive: true, force: true });
            }
        });
    }
});
