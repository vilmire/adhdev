import { describe, expect, it } from 'vitest';

import { evaluateProviderQuotaGate } from '../../src/mesh/mesh-quota-routing';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const RESET = NOW + 3 * 24 * 3_600_000;
const win = (usedPercent: number) => ({ usedPercent, windowMinutes: 10080, resetsAt: RESET });

function gate(quota: Record<string, unknown>) {
    return evaluateProviderQuotaGate({ id: 'fixture-node', nodeFacts: {
        reportedAt: NOW, quota: { 'cursor-cli': quota },
        quotaReserve: { version: 1, defaults: { routingLongMinPercent: 80 } },
    } } as never, 'cursor-cli', null, NOW);
}

const base = { provider: 'cursor-cli', status: 'ok', error: null, updatedAt: NOW, session: null, weekly: null } as const;

describe('cursor display buckets never change routing', () => {
    it('treats a 100% headline as exhausted even when the api bucket is empty', () => {
        const withBuckets = gate({
            ...base, monthly: win(100),
            buckets: [{ name: 'auto', ...win(100) }, { name: 'api', ...win(0) }],
        });
        const without = gate({ ...base, monthly: win(100) });
        expect(withBuckets).not.toBeNull();
        expect(withBuckets).toEqual(without);
    });

    it('does not block on buckets alone when the headline has headroom', () => {
        const withBuckets = gate({
            ...base, monthly: win(10),
            buckets: [{ name: 'auto', ...win(100) }, { name: 'api', ...win(0) }],
        });
        expect(withBuckets).toEqual(gate({ ...base, monthly: win(10) }));
    });
});
