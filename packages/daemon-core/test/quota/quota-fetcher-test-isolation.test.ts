import { describe, expect, it } from 'vitest';
import { fetchGrokQuota } from '../../src/quota/fetchers/grok.js';
import { fetchKimiQuota } from '../../src/quota/fetchers/kimi.js';
import { fetchAntigravityQuota } from '../../src/quota/fetchers/antigravity.js';

/**
 * INJECTION TEST — revert-sensitive.
 *
 * Removing assertInjectedNetworkFetchInTest from fetchGrokQuota (the 2026-08-23
 * live-endpoint hole) turns the grok case red. The kimi/antigravity cases pin
 * the same contract on the other network fetchers so the next added provider
 * cannot copy quota-boot-refresh.test.ts's "mock everyone except the new one".
 *
 * These call the REAL modules with no deps.fetch. They must throw BEFORE
 * reading ~/.grok/auth.json or issuing HTTP.
 */
describe('network quota fetchers refuse live endpoints in a test runtime', () => {
    it('fetchGrokQuota() without deps.fetch throws (does not read ~/.grok or call cli-chat-proxy)', async () => {
        await expect(fetchGrokQuota()).rejects.toThrow(/injected fetch/);
    });

    it('fetchKimiQuota() without deps.fetch throws', async () => {
        await expect(fetchKimiQuota()).rejects.toThrow(/injected fetch/);
    });

    it('fetchAntigravityQuota() without deps.fetch throws', async () => {
        await expect(fetchAntigravityQuota()).rejects.toThrow(/injected fetch/);
    });
});
