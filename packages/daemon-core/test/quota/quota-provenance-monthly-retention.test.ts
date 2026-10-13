/**
 * rc12 quota provenance (2026-10-13) — two consumer gaps, synthetic data only.
 *
 *  (2) A retained last-good reading kept its numbers and `updatedAt`, but its
 *      metadata was rebuilt from the FAILED attempt, so the retained numbers
 *      were labelled with the failing collector's source and lost their plan.
 *      `metadata.lastGood` now carries the original measurement's provenance
 *      through carry-forward (memory) and the persist clobber barrier (disk).
 *  (3) cursor-cli reports ONLY a 30-day `monthly` axis. Every "do we hold a
 *      reading?" predicate looked at session/weekly/buckets, so a transient
 *      failure (memory) or a numberless failure (disk) erased a good cursor
 *      reading, and the CLI never printed the 30-day line at all.
 */
import { describe, expect, it } from 'vitest';
import { assessQuotaFreshness, type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';

import { carryForwardLastGoodWindows } from '../../src/quota/refresh.js';
import { mergeLastGoodForPersist, quotaEntryHoldsReading } from '../../src/quota/persist.js';
import { printQuota } from '../../src/quota/cli.js';
import type { ProviderQuota } from '../../src/quota/types.js';

const ANSI = /\x1b\[[0-9;]*m/g;
function captureLogs(fn: () => void): string[] {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ').replace(ANSI, '')); };
    try { fn(); } finally { console.log = original; }
    return lines;
}

const MEASURED_AT = 1_700_000_000_000;

const codexOk = (): MeshNodeFactsProviderQuota => ({
    provider: 'codex-cli',
    status: 'ok',
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
    updatedAt: MEASURED_AT,
    error: null,
    metadata: { source: 'rollout', planType: 'plus' },
});

const codexCollector401 = (): MeshNodeFactsProviderQuota => ({
    provider: 'codex-cli',
    status: 'error',
    session: null,
    weekly: null,
    updatedAt: MEASURED_AT + 3_600_000,
    error: 'Codex usage lookup by the background quota collector was refused (401)',
    metadata: { source: 'app-server', collectorScope: 'background-collector', failureKind: 'unauthorized' },
});

const cursorMonthlyOk = (): MeshNodeFactsProviderQuota => ({
    provider: 'cursor-cli',
    status: 'ok',
    session: null,
    weekly: null,
    monthly: { usedPercent: 41, windowMinutes: 43200, resetsAt: null },
    updatedAt: MEASURED_AT,
    error: null,
    metadata: { source: 'api', planType: 'pro' },
});

const cursorTransient = (): MeshNodeFactsProviderQuota => ({
    provider: 'cursor-cli',
    status: 'error',
    session: null,
    weekly: null,
    updatedAt: MEASURED_AT + 600_000,
    error: 'Cursor usage request failed: network',
    metadata: { source: 'api', failureKind: 'network' },
});

describe('(2) retained last-good keeps its ORIGINAL provenance', () => {
    it('carry-forward records the measuring source/plan/time, not the failed collector', () => {
        const merged = carryForwardLastGoodWindows(codexOk(), codexCollector401());
        expect(merged.metadata?.lastGoodWindows).toBe(true);
        // Top level still describes the fresh failure honestly…
        expect(merged.metadata?.source).toBe('app-server');
        expect(merged.metadata?.collectorScope).toBe('background-collector');
        expect(merged.metadata?.failureKind).toBe('unauthorized');
        // …while the retained numbers are attributed to what measured them.
        expect(merged.metadata?.lastGood).toEqual({ measuredAt: MEASURED_AT, source: 'rollout', planType: 'plus' });
        expect(merged.updatedAt).toBe(MEASURED_AT);
    });

    it('a chain of consecutive failures keeps naming the ORIGINAL measurement', () => {
        const once = carryForwardLastGoodWindows(codexOk(), codexCollector401());
        const twice = carryForwardLastGoodWindows(once, { ...codexCollector401(), metadata: { source: 'other', failureKind: 'network' } });
        expect(twice.metadata?.lastGood).toEqual({ measuredAt: MEASURED_AT, source: 'rollout', planType: 'plus' });
    });

    it('the persist barrier records the stored reading provenance too', () => {
        const merged = mergeLastGoodForPersist(
            { 'codex-cli': codexCollector401() },
            { 'codex-cli': codexOk() },
        );
        expect(merged['codex-cli']!.session?.usedPercent).toBe(12);
        expect(merged['codex-cli']!.metadata?.lastGood).toEqual({ measuredAt: MEASURED_AT, source: 'rollout', planType: 'plus' });
        expect(merged['codex-cli']!.metadata?.source).toBe('app-server');
    });

    it('the CLI labels retained numbers with where they came from', () => {
        const retained = carryForwardLastGoodWindows(codexOk(), codexCollector401()) as unknown as ProviderQuota;
        const lines = captureLogs(() => printQuota('Codex', retained));
        expect(lines.join('\n')).toMatch(/retained reading from rollout, plus, measured/);
    });
});

describe('(3) a monthly-only cursor reading counts as a reading', () => {
    it('the shared predicate sees it, and an unknown window does not invent one', () => {
        expect(quotaEntryHoldsReading(cursorMonthlyOk())).toBe(true);
        expect(quotaEntryHoldsReading(cursorTransient())).toBe(false);
    });

    it('carry-forward retains it across a transient failure', () => {
        const merged = carryForwardLastGoodWindows(cursorMonthlyOk(), cursorTransient());
        expect(merged.monthly?.usedPercent).toBe(41);
        expect(merged.session).toBeNull();
        expect(merged.weekly).toBeNull();
        expect(merged.metadata?.lastGoodWindows).toBe(true);
        expect(merged.metadata?.lastGood).toEqual({ measuredAt: MEASURED_AT, source: 'api', planType: 'pro' });
    });

    it('a non-transient failure still replaces it wholesale', () => {
        const fresh = { ...cursorTransient(), metadata: { failureKind: 'missing-credentials' } };
        expect(carryForwardLastGoodWindows(cursorMonthlyOk(), fresh)).toBe(fresh);
    });

    it('the persist barrier keeps it on disk against a numberless failure', () => {
        const merged = mergeLastGoodForPersist({ 'cursor-cli': cursorTransient() }, { 'cursor-cli': cursorMonthlyOk() });
        expect(merged['cursor-cli']!.monthly?.usedPercent).toBe(41);
        expect(merged['cursor-cli']!.updatedAt).toBe(MEASURED_AT);
        expect(merged['cursor-cli']!.metadata?.lastGoodWindows).toBe(true);
    });

    it('the CLI prints an honest 30 day line, and an unknown percentage as unknown', () => {
        const ok = captureLogs(() => printQuota('Cursor', cursorMonthlyOk() as unknown as ProviderQuota)).join('\n');
        expect(ok).toMatch(/30 day .*41\.0% used/);
        const unknown = captureLogs(() => printQuota('Cursor', {
            ...(cursorMonthlyOk() as unknown as ProviderQuota),
            monthly: { usedPercent: Number.NaN, windowMinutes: 43200, resetsAt: null },
        })).join('\n');
        expect(unknown).toMatch(/30 day\s+unknown/);
        expect(unknown).not.toMatch(/NaN|0\.0%/);
    });

    it('a provider without a monthly axis does not grow a 30 day row', () => {
        const lines = captureLogs(() => printQuota('Codex', codexOk() as unknown as ProviderQuota)).join('\n');
        expect(lines).not.toMatch(/30 day/);
    });

    it('the shared freshness cue treats retained monthly numbers as numbers (mesh-shared)', () => {
        const noData = { ...cursorMonthlyOk(), status: 'error', metadata: { failureKind: 'no-data' } };
        expect(assessQuotaFreshness(noData, MEASURED_AT + 60_000)).toEqual({ cue: 'stale', userMustAct: true });
        // Unknown monthly percentage is not a reading: no cue is invented for it.
        const unknown = { ...noData, monthly: { usedPercent: null as unknown as number, windowMinutes: 43200, resetsAt: null } };
        expect(assessQuotaFreshness(unknown, MEASURED_AT + 60_000).cue).toBeUndefined();
    });
});
