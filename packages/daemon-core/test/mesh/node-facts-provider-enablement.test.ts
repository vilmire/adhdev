import { describe, expect, it, vi, afterEach } from 'vitest';

// providerEnablement — the field that makes a REMOTE node's MISSING quota
// entry classifiable.
//
// The quota cache PRUNES a provider disabled on either axis (quota/refresh.ts
// deletes it on refresh and refuses to restore it from disk), so its absence
// from `nodeFacts.quota` is indistinguishable from "never measured yet" to
// anyone but the daemon that owns the config. That ambiguity is why the
// coordinator could classify only its own node and its worktree clones; every
// other node in the mesh fell to 'unclassified_remote'. Shipping the switches
// alongside the snapshots is what closes that gap — see mesh-quota-routing.ts
// classifyAbsentQuotaReason and its REMOTE test block.
//
// The two axes are INDEPENDENT and must stay so: `enabled` gates launching and
// mesh claims, `quotaEnabled` gates ONLY the probe.

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

async function factsWith(enablement: Record<string, any> | 'throws') {
    vi.resetModules();
    vi.doMock('../../src/detection/cli-detector.js', () => ({
        getProviderSpecPins: () => ({}),
        getProviderEnablementFacts: () => {
            if (enablement === 'throws') throw new Error('loader unreadable');
            return enablement;
        },
    }));
    const { buildLocalNodeFacts } = await import('../../src/mesh/node-facts.js');
    return buildLocalNodeFacts() as any;
}

describe('providerEnablement in the node facts bundle', () => {
    it('carries both switches per provider', async () => {
        const facts = await factsWith({
            'claude-cli': { enabled: true, quotaEnabled: true },
            'codex-cli': { enabled: true, quotaEnabled: false },
            'kimi': { enabled: false, quotaEnabled: true },
        });
        expect(facts.providerEnablement).toEqual({
            'claude-cli': { enabled: true, quotaEnabled: true },
            'codex-cli': { enabled: true, quotaEnabled: false },
            'kimi': { enabled: false, quotaEnabled: true },
        });
    });

    it('keeps the two axes independent — a used provider can still opt out of the probe', async () => {
        const facts = await factsWith({ 'codex-cli': { enabled: true, quotaEnabled: false } });
        expect(facts.providerEnablement['codex-cli'].enabled).toBe(true);
        expect(facts.providerEnablement['codex-cli'].quotaEnabled).toBe(false);
    });

    it('omits the field entirely when there is nothing to report', async () => {
        // Absent means "this node did not tell us" — the consumer must fall
        // back to unclassified rather than read absence as "disabled".
        const facts = await factsWith({});
        expect(facts.providerEnablement).toBeUndefined();
    });

    it('never fails the whole bundle when the loader is unreadable', async () => {
        // Best-effort observability, same contract as providerSpecPins/quota:
        // a broken loader must not take out build/platform reporting with it.
        const facts = await factsWith('throws');
        expect(facts.providerEnablement).toBeUndefined();
        expect(facts.schemaVersion).toBe(1);
        expect(facts.platform).toBeTruthy();
    });

    it('ships booleans only — no free text, no credentials', async () => {
        // This bundle also carries accountEmail (PII) on the quota axis, so the
        // shape of anything added beside it is pinned deliberately.
        const facts = await factsWith({ 'claude-cli': { enabled: true, quotaEnabled: false } });
        for (const entry of Object.values<any>(facts.providerEnablement)) {
            expect(Object.keys(entry).sort()).toEqual(['enabled', 'quotaEnabled']);
            for (const value of Object.values(entry)) expect(typeof value).toBe('boolean');
        }
    });
});
