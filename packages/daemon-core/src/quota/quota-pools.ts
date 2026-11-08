/**
 * Quota pools — ONE place that says "this provider's account has separate limits per model group".
 *
 * Owner decision 2026-11-08: instead of splitting a provider into two provider types, the QUOTA axis is
 * keyed by (provider, pool). Every quota decision (measured windows, the CLI's own "usage limit reached"
 * report, reserves) asks this module which pool a model belongs to, so a limit hit by one model group
 * never blocks the other group of the same account. A provider without an entry here has a single pool
 * (the whole provider), exactly as before.
 */

/** A pool id within a provider ('gemini', 'claude-gpt'). */
export type QuotaPoolId = string;

interface PoolRule { pool: QuotaPoolId; leadingLabel: RegExp }

/**
 * Model → pool rules per provider, matched against the model's leading label (slot model names, CLI model
 * ids and quota bucket names all lead with the model family). Antigravity shares one weekly and one 5h limit
 * per group: "Gemini Models" vs "Claude and GPT models".
 */
const PROVIDER_QUOTA_POOLS: Record<string, readonly PoolRule[]> = {
    'antigravity-cli': [
        { pool: 'gemini', leadingLabel: /^gemini(?:[\s/_-]|$)/ },
        { pool: 'claude-gpt', leadingLabel: /^(?:claude|gpt)(?:[\s/_-]|$)/ },
    ],
};

/** The pools a provider's account is split into; empty = one pool for the whole provider. */
export function quotaPoolsOf(provider: string): QuotaPoolId[] {
    return (PROVIDER_QUOTA_POOLS[provider] ?? []).map(rule => rule.pool);
}

/** Which pool a model (or a bucket name) of this provider draws from; undefined when unknown or unpooled. */
export function quotaPoolForModel(provider: string, model: string | null | undefined): QuotaPoolId | undefined {
    const label = typeof model === 'string' ? model.trim().toLowerCase() : '';
    if (!label) return undefined;
    return PROVIDER_QUOTA_POOLS[provider]?.find(rule => rule.leadingLabel.test(label))?.pool;
}
