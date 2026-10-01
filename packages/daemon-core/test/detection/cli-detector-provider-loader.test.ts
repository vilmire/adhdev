import { describe, expect, it } from 'vitest';
import { detectCLIs } from '../../src/detection/cli-detector.js';
import type { ProviderLoader } from '../../src/providers/provider-loader.js';

/**
 * Guards the setup-time CLI-detection miss: `detectCLIs()` is meaningless
 * without a ProviderLoader — the provider list is `providerLoader ?
 * providerLoader.getCliDetectionList() : []`, so an absent loader yields an
 * empty result and the setup wizard prints "No known CLI agents detected" on
 * every platform. The wizard now threads a shared ProviderLoader; this test
 * pins the contract that a supplied loader's detection list is honored.
 */
function makeStubLoader(entries: Array<{ id: string; command: string; displayName?: string }>): ProviderLoader {
    return {
        getCliDetectionList() {
            return entries.map((e) => ({
                id: e.id,
                displayName: e.displayName ?? e.id,
                icon: '🔧',
                command: e.command,
                category: 'cli' as const,
                enabled: true,
            }));
        },
    } as unknown as ProviderLoader;
}

describe('detectCLIs providerLoader wiring', () => {
    it('returns an empty list when no ProviderLoader is supplied (the setup-time bug)', async () => {
        const result = await detectCLIs(undefined, { includeVersion: false });
        expect(result).toEqual([]);
    });

    it('scans every provider from a supplied loader (no version probing)', async () => {
        // Use commands that are essentially never installed so the test is
        // deterministic across platforms — we assert the provider is present in
        // the scan result (installed:false), not that it resolves.
        const loader = makeStubLoader([
            { id: 'nonexistent-cli-a', command: 'adhdev-test-nonexistent-cli-a' },
            { id: 'nonexistent-cli-b', command: 'adhdev-test-nonexistent-cli-b' },
        ]);
        const result = await detectCLIs(loader, { includeVersion: false });
        expect(result).toHaveLength(2);
        expect(result.map((c) => c.id).sort()).toEqual(['nonexistent-cli-a', 'nonexistent-cli-b']);
        // Bogus commands never resolve → reported missing, not silently dropped.
        expect(result.every((c) => c.installed === false)).toBe(true);
    });
});

describe('detectCLI includeDisabled', () => {
    // A fresh machine has nothing enabled, and the gated detection list is then
    // empty — `adhdev provider detect claude-cli` said "not installed" with
    // Claude Code on PATH (2026-10-01). The option must reach the loader.
    function gatedLoader(seen: Array<boolean | undefined>): ProviderLoader {
        return {
            resolveAlias: (t: string) => t,
            getCliDetectionList(options?: { includeDisabled?: boolean }) {
                seen.push(options?.includeDisabled);
                if (!options?.includeDisabled) return [];
                return [{ id: 'sh-cli', displayName: 'sh', icon: '🔧', command: 'sh', category: 'cli' as const, enabled: false }];
            },
        } as unknown as ProviderLoader;
    }

    it('finds a not-yet-enabled provider only when includeDisabled is passed', async () => {
        const seen: Array<boolean | undefined> = [];
        const { detectCLI } = await import('../../src/detection/cli-detector.js');
        expect(await detectCLI('sh-cli', gatedLoader(seen), { includeVersion: false })).toBeNull();
        const found = await detectCLI('sh-cli', gatedLoader(seen), { includeVersion: false, includeDisabled: true });
        expect(found?.installed).toBe(true);
        expect(seen[0]).toBeUndefined();
        expect(seen[seen.length - 1]).toBe(true);
    });
});
