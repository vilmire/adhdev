import { describe, expect, it } from 'vitest';
import { getProviderEnablementFacts } from '../../src/detection/cli-detector.js';
import { QUOTA_SUPPORTED_PROVIDERS } from '@adhdev/mesh-shared';
import type { ProviderLoader } from '../../src/providers/provider-loader.js';

/**
 * getProviderEnablementFacts — the reader behind MeshNodeFacts.providerEnablement.
 *
 * It resolves BOTH config defaults (enabled defaults false, quotaEnabled
 * defaults true) into decided booleans before they reach the wire, so a remote
 * reader never re-applies this machine's default rules. A second copy of those
 * rules on the reading side is exactly the drift this shape prevents.
 */
function makeLoader(over: Partial<{
    enabled: (type: string) => boolean;
    quota: ((type: string) => boolean) | undefined;
    throwOn: string;
}> = {}): ProviderLoader {
    const { enabled = () => true, quota = () => true, throwOn } = over;
    return {
        isMachineProviderEnabled(type: string) {
            if (throwOn === type) throw new Error('config unreadable');
            return enabled(type);
        },
        ...(quota ? { isMachineQuotaEnabled: (type: string) => quota(type) } : {}),
    } as unknown as ProviderLoader;
}

describe('getProviderEnablementFacts', () => {
    it('reports both axes for every quota-supported provider', () => {
        const facts = getProviderEnablementFacts(makeLoader());
        expect(Object.keys(facts).sort()).toEqual([...QUOTA_SUPPORTED_PROVIDERS].sort());
        for (const entry of Object.values(facts)) {
            expect(entry).toEqual({ enabled: true, quotaEnabled: true });
        }
    });

    it('scopes itself to quota-supported providers — a provider with no fetcher is not reported', () => {
        // The sole consumer is the absent-quota-entry classifier. A provider
        // with no fetcher can never have a snapshot for any other reason, so
        // reporting its switches would grow every git_status for nothing.
        const facts = getProviderEnablementFacts(makeLoader());
        // cursor-cli graduated to quota-supported on 2026-08-24 (fetcher landed),
        // so it now IS reported; hermes stays the no-fetcher example.
        expect(facts['cursor-cli']).toEqual({ enabled: true, quotaEnabled: true });
        expect(facts['hermes-cli']).toBeUndefined(); // no model-axis quota
    });

    it('carries the two axes independently', () => {
        const facts = getProviderEnablementFacts(makeLoader({
            enabled: (t) => t !== 'kimi',
            quota: (t) => t !== 'codex-cli',
        }));
        expect(facts['kimi']).toEqual({ enabled: false, quotaEnabled: true });
        expect(facts['codex-cli']).toEqual({ enabled: true, quotaEnabled: false });
    });

    it('resolves the quotaEnabled default (absent = enabled) for a loader predating that axis', () => {
        // Mirrors quotaProviderEnabledFromLoader's structural-optional contract:
        // an older loader must read as quota-enabled, never as an opt-out.
        const facts = getProviderEnablementFacts(makeLoader({ quota: undefined }));
        for (const entry of Object.values(facts)) expect(entry.quotaEnabled).toBe(true);
    });

    it('returns nothing when there is no loader at all — absence, not a fabricated verdict', () => {
        expect(getProviderEnablementFacts(undefined)).toEqual({});
    });

    it('lets one unreadable provider fail without costing the others their entry', () => {
        const facts = getProviderEnablementFacts(makeLoader({ throwOn: 'kimi' }));
        expect(facts['kimi']).toBeUndefined();
        expect(facts['claude-cli']).toEqual({ enabled: true, quotaEnabled: true });
    });
});
