import { describe, expect, it } from 'vitest';
import { evaluateProviderQuotaGate, expiryRiskForRanking, rankProvidersByQuotaGate } from '../../src/mesh/mesh-quota-routing.js';
import { quotaRiskSnapshotForCandidates, quotaSpreadBonusByProvider, quotaSpreadBonusDiagnosticsByProvider } from '../../src/mesh/mesh-quota-ranking-records.js';
import { DEFAULT_QUOTA_ROUTING_POLICY } from '../../src/repo-mesh-types.js';

const NOW = 2_000_000_000_000;
const DAY = 86_400_000;
const RESET = NOW + 6 * DAY + 4 * 3_600_000;
const context = { suppressObservabilityLogs: true };
function quota(used = 12.1, resetsAt: number | null = RESET, updatedAt = NOW) {
    return { provider: 'cursor-cli', session: null, weekly: null,
        monthly: { usedPercent: used, windowMinutes: 43200, resetsAt },
        status: 'ok', updatedAt, error: null };
}
function node(cursor: any, others = {}) {
    return { id: 'remote-monthly-test', nodeFacts: { reportedAt: NOW, quota: { 'cursor-cli': cursor, ...others } } };
}
const gate = (q: any) => evaluateProviderQuotaGate(node(q), 'cursor-cli', undefined, NOW, context);

describe('Cursor monthly routing', () => {
    it('12.1% is clear, receives measured bonus and ranks with its actual 30d reset', () => {
        const n = node(quota());
        expect(gate(quota())).toBeNull();
        expect(quotaSpreadBonusByProvider(n, undefined, NOW, context)['cursor-cli']).toBe(26);
        const risk = expiryRiskForRanking(n, 'cursor-cli', 'monthly', undefined, NOW, context)!;
        expect(risk.remainingPercent).toBeCloseTo(87.9);
        expect(risk.risk).toBeCloseTo(87.9 ** 2 / (87.9 + 100 * (6 + 4 / 24) / 30));
        const rank = rankProvidersByQuotaGate(n, ['unknown', 'cursor-cli'], undefined, NOW, context);
        expect(rank.clear).toEqual(['cursor-cli', 'unknown']);
        expect(rank.rankingEvidence[0]).toMatchObject({ axis: 'monthly', remainingPercent: 87.9 });
        expect(quotaRiskSnapshotForCandidates(n, ['cursor-cli'], undefined, NOW, context)[0]).toMatchObject({ axis: 'monthly', remainingPercent: 87.9 });
        expect(quotaSpreadBonusDiagnosticsByProvider(n, ['cursor-cli'], undefined, NOW, context)[0].zeroReason).toBeUndefined();
    });
    it('100% blocks on monthly, never weekly, and has zero-headroom evidence', () => {
        expect(gate(quota(100))).toMatchObject({ reason: 'provider_quota_monthly_low', window: 'monthly', remainingPercent: 0 });
        const n = node(quota(100));
        expect(rankProvidersByQuotaGate(n, ['cursor-cli'], undefined, NOW, context).clear).toEqual([]);
        expect(quotaSpreadBonusDiagnosticsByProvider(n, ['cursor-cli'], undefined, NOW, context)[0]).toMatchObject({ value: 0, zeroReason: 'zero-headroom' });
    });
    it('missing data fails open without invented 7d evidence', () => {
        const q = { ...quota(), monthly: null };
        expect(gate(q)).toBeNull();
        expect(rankProvidersByQuotaGate(node(q), ['cursor-cli'], undefined, NOW, context).rankingEvidence).toEqual([{ providerType: 'cursor-cli', axis: 'monthly' }]);
        expect(quotaSpreadBonusDiagnosticsByProvider(node(q), ['cursor-cli'], undefined, NOW, context)[0]).toMatchObject({ value: 0, zeroReason: 'no-data' });
    });
    it('stale current-month readings keep authority until reset; stale undated ones fail open', () => {
        const old = NOW - DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs - 60_000;
        expect(gate(quota(100, RESET, old))?.window).toBe('monthly');
        expect(gate(quota(100, null, old))).toBeNull();
        expect(expiryRiskForRanking(node(quota(12.1, null, old)), 'cursor-cli', 'monthly', undefined, NOW, context)).toBeUndefined();
    });
    it('at and after actual reset the old month cannot gate, bonus or rank', () => {
        for (const reset of [NOW, NOW - 1]) {
            const q = quota(100, reset);
            expect(gate(q)).toBeNull();
            expect(quotaSpreadBonusByProvider(node(q), undefined, NOW, context)['cursor-cli']).toBe(0);
            expect(expiryRiskForRanking(node(q), 'cursor-cli', 'monthly', undefined, NOW, context)).toBeUndefined();
            expect(quotaSpreadBonusDiagnosticsByProvider(node(q), ['cursor-cli'], undefined, NOW, context)[0].zeroReason).toBe('stale');
        }
    });
    it('only proven last-good monthly windows survive a failed probe', () => {
        expect(gate({ ...quota(100), status: 'error' })).toBeNull();
        expect(gate({ ...quota(100), status: 'error', metadata: { lastGoodWindows: true } })?.window).toBe('monthly');
    });
    it('5h and 7d gates and the most-constrained spread bonus remain effective alongside 30d', () => {
        const q = { ...quota(), session: { usedPercent: 99, windowMinutes: 300, resetsAt: NOW + 3_600_000 },
            weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: NOW + DAY } };
        expect(gate(q)?.window).toBe('session');
        expect(quotaSpreadBonusByProvider(node(q), undefined, NOW, context)['cursor-cli']).toBe(0);
        q.session.usedPercent = 10; q.weekly.usedPercent = 99;
        expect(gate(q)?.window).toBe('weekly');
        q.weekly.usedPercent = 10; q.monthly.usedPercent = 100;
        expect(gate(q)?.window).toBe('monthly');
        const codex = { ...q, provider: 'codex-cli', monthly: null };
        expect(rankProvidersByQuotaGate(node(null, { 'codex-cli': codex }), ['codex-cli'], undefined, NOW, context).rankingEvidence[0].axis).toBe('session');
    });
});
