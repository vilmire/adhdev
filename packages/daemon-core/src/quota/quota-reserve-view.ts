/**
 * Read model for the machine quota reserve (`quota_reserve_get`): the stored
 * value, the resolved reserve per provider / pool with the layer each field
 * came from, and the current remaining quota next to it so the dashboard can
 * draw "8% left / reserve 15%". Interactive use (manual chat, coordinator
 * launch) is never blocked by the reserve (owner decision Q1) — this view is
 * how that state is SHOWN instead.
 */
import { QUOTA_SUPPORTED_PROVIDERS, type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { quotaWindowsForGateTarget } from '../mesh/mesh-quota-routing.js';
import { remainingPercent } from '../mesh/mesh-quota-sources.js';
import { quotaAccountLineage } from './account-lineage.js';
import { coerceQuotaReserve, quotaReservePoolKey, resolveQuotaReserveDetailed, type QuotaReserveSource, type ResolvedQuotaReserve } from './quota-reserve.js';
import { quotaReserveStats } from './quota-reserve-metrics.js';

const ANTIGRAVITY = 'antigravity-cli';
const ANTIGRAVITY_POOLS: ReadonlyArray<{ pool: 'gemini' | 'claude-gpt'; probeModel: string }> = [
    { pool: 'gemini', probeModel: 'Gemini' },
    { pool: 'claude-gpt', probeModel: 'Claude' },
];

export interface QuotaReserveViewRow {
    provider: string;
    pool: string | null;
    poolKey: string;
    /** Hashed account lineage key of the current snapshot; null when unidentifiable. */
    accountKey: string | null;
    policy: ResolvedQuotaReserve;
    source: Partial<Record<keyof ResolvedQuotaReserve, QuotaReserveSource>>;
    remaining: { session: number | null; long: number | null; tightest: number | null };
    /** True when a window is below the routing reserve (automatic work is held; manual use is not). */
    withinReserve: boolean;
    withinReserveWindow: 'session' | 'long' | null;
    /** Below the assistant-review floor (tightest window). */
    belowAssistantReview: boolean;
}

export interface QuotaReserveView {
    raw: unknown;
    rows: QuotaReserveViewRow[];
    /** provider -> known account lineage keys (current snapshot + stored overrides). */
    accounts: Record<string, string[]>;
    stats: ReturnType<typeof quotaReserveStats>;
}

function pct(n: number | undefined): number | null {
    return n === undefined ? null : Math.round(n * 10) / 10;
}

export function buildQuotaReserveView(
    raw: unknown,
    cache: Record<string, MeshNodeFactsProviderQuota> | undefined,
): QuotaReserveView {
    const config = coerceQuotaReserve(raw);
    const rows: QuotaReserveViewRow[] = [];
    const accounts: Record<string, string[]> = {};
    for (const provider of QUOTA_SUPPORTED_PROVIDERS) {
        const entry = cache?.[provider];
        const lineage = quotaAccountLineage(entry?.metadata?.accountLineage);
        const accountKey = lineage.kind === 'account' ? lineage.key : null;
        const known = new Set<string>(accountKey ? [accountKey] : []);
        for (const key of Object.keys(config?.accounts ?? {})) {
            if (config?.accounts?.[key]?.[provider] || Object.keys(config?.accounts?.[key] ?? {}).some(k => k.startsWith(`${provider}:`))) known.add(key);
        }
        if (known.size) accounts[provider] = [...known];
        const pools: Array<{ pool: string | null; windows: { session: any; weekly: any; monthly?: any } | undefined }> =
            provider === ANTIGRAVITY
                ? ANTIGRAVITY_POOLS.map(({ pool, probeModel }) => ({
                    pool,
                    windows: entry ? quotaWindowsForGateTarget(provider, entry, { model: probeModel }) ?? undefined : undefined,
                }))
                : [{ pool: null, windows: entry ? { session: entry.session, weekly: entry.weekly, monthly: entry.monthly } : undefined }];
        for (const { pool, windows } of pools) {
            const { policy, source } = resolveQuotaReserveDetailed(raw, { provider, pool, accountKey });
            const session = remainingPercent(windows?.session);
            const long = [remainingPercent(windows?.weekly), remainingPercent(windows?.monthly)]
                .filter((n): n is number => n !== undefined)
                .reduce<number | undefined>((min, n) => (min === undefined || n < min ? n : min), undefined);
            const tightestVals = [session, long].filter((n): n is number => n !== undefined);
            const tightest = tightestVals.length ? Math.min(...tightestVals) : undefined;
            const sessionLow = session !== undefined && session < policy.routingSessionMinPercent;
            const longLow = long !== undefined && long < policy.routingLongMinPercent;
            rows.push({
                provider,
                pool,
                poolKey: quotaReservePoolKey(provider, pool),
                accountKey,
                policy,
                source,
                remaining: { session: pct(session), long: pct(long), tightest: pct(tightest) },
                withinReserve: sessionLow || longLow,
                withinReserveWindow: sessionLow ? 'session' : longLow ? 'long' : null,
                belowAssistantReview: tightest !== undefined && tightest < policy.assistantReviewMinPercent,
            });
        }
    }
    return { raw: config ?? null, rows, accounts, stats: quotaReserveStats() };
}
