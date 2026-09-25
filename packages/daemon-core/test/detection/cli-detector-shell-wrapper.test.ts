import { describe, expect, it } from 'vitest';
import { detectCLIs } from '../../src/detection/cli-detector.js';
import { isShellWrapperCommand, resolveWrappedCliBinary, type ProviderLoader } from '../../src/providers/provider-loader.js';

/**
 * 2026-09-25: antigravity-cli launches through `bash -c "… exec agy"` (hidden-dir
 * workspace handling). Detection resolved the WRAPPER, so the provider looked
 * installed wherever bash exists, its version was bash's, and model discovery
 * ran `bash models` — the Gemini 3.8 models never appeared. Detection must
 * resolve the manifest's `binary` for a shell-wrapped spawn.
 */
describe('shell-wrapped CLI spawn', () => {
    it('names the wrapped binary only when spawn.command is a shell', () => {
        expect(resolveWrappedCliBinary('bash', 'agy')).toBe('agy');
        expect(resolveWrappedCliBinary('/bin/bash', 'agy')).toBe('agy');
        expect(resolveWrappedCliBinary('powershell.exe', 'agy')).toBe('agy');
        expect(resolveWrappedCliBinary('codex', 'codex')).toBeUndefined();
        expect(resolveWrappedCliBinary('cursor-agent', 'cursor-agent')).toBeUndefined();
        expect(resolveWrappedCliBinary('bash', undefined)).toBeUndefined();
        expect(resolveWrappedCliBinary('bash', 'bash')).toBeUndefined();
    });

    it('recognises shell paths across platforms', () => {
        expect(isShellWrapperCommand('/bin/bash')).toBe(true);
        expect(isShellWrapperCommand('C:\\Windows\\System32\\cmd.exe')).toBe(true);
        expect(isShellWrapperCommand('/Users/x/.local/bin/agy')).toBe(false);
        expect(isShellWrapperCommand(null)).toBe(false);
    });

    it('detection resolves detectCommand, not the wrapper: a missing wrapped CLI is NOT installed even though bash exists', async () => {
        const loader = {
            getCliDetectionList() {
                return [{
                    id: 'wrapped-cli',
                    displayName: 'wrapped',
                    icon: '🔧',
                    command: 'bash',
                    detectCommand: 'adhdev-test-nonexistent-wrapped-cli',
                    category: 'cli' as const,
                    enabled: true,
                }];
            },
        } as unknown as ProviderLoader;
        const [result] = await detectCLIs(loader, { includeVersion: false });
        expect(result.installed).toBe(false);
    });
});
