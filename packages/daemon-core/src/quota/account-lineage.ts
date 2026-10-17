/**
 * Account lineage for quota retention, never an authentication mechanism.
 * Only an issuer + subject recorded by the owning CLI can establish identity.
 * Tokens, token mtimes, emails, transport labels and unknowns cannot do so.
 */
import { createHash } from 'node:crypto';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import type { ProviderQuota } from './types.js';

export type QuotaAccountLineage =
    | { version: 1; kind: 'account'; key: string }
    | { version: 1; kind: 'unknown' };

export const UNKNOWN_ACCOUNT_LINEAGE: QuotaAccountLineage = Object.freeze({ version: 1, kind: 'unknown' });

/** Local CLI credential claims only; no network, verification, or token exchange. */
export function accountLineageFromCliJwt(provider: string, token: string, authority: string): QuotaAccountLineage {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return UNKNOWN_ACCOUNT_LINEAGE;
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (typeof claims?.iss !== 'string' || !claims.iss.trim()
            || typeof claims?.sub !== 'string' || !claims.sub.trim()) return UNKNOWN_ACCOUNT_LINEAGE;
        // Domain separation includes the provider and quota authority; neither
        // an opaque account id nor a credential value leaves this function.
        const key = createHash('sha256').update(JSON.stringify([
            'adhdev-quota-account-v1', provider, authority, claims.iss, claims.sub,
        ])).digest('hex');
        return { version: 1, kind: 'account', key };
    } catch {
        return UNKNOWN_ACCOUNT_LINEAGE;
    }
}

export function quotaAccountLineage(value: unknown): QuotaAccountLineage {
    if (!value || typeof value !== 'object') return UNKNOWN_ACCOUNT_LINEAGE;
    const v = value as Record<string, unknown>;
    return v.version === 1 && v.kind === 'account' && typeof v.key === 'string' && /^[a-f0-9]{64}$/.test(v.key)
        ? { version: 1, kind: 'account', key: v.key }
        : UNKNOWN_ACCOUNT_LINEAGE;
}

export function sameQuotaAccount(a: unknown, b: unknown): boolean {
    const left = quotaAccountLineage(a);
    const right = quotaAccountLineage(b);
    return left.kind === 'account' && right.kind === 'account' && left.key === right.key;
}

export function canTransferQuotaReading(prior: MeshNodeFactsProviderQuota | undefined, fresh: MeshNodeFactsProviderQuota): boolean {
    return !!prior && prior.provider === fresh.provider
        && fresh.metadata?.lineageUncertain !== true
        && prior.metadata?.lineageUncertain !== true
        && sameQuotaAccount(prior.metadata?.accountLineage, fresh.metadata?.accountLineage);
}

/** Remove every account-scoped reading/label; keep observation/attempt clocks separate. */
export function unconfirmedQuotaReading<T extends MeshNodeFactsProviderQuota | ProviderQuota>(quota: T, lineage: QuotaAccountLineage = UNKNOWN_ACCOUNT_LINEAGE): T {
    const metadata: NonNullable<MeshNodeFactsProviderQuota['metadata']> = { ...quota.metadata, accountLineage: lineage, lineageUncertain: true };
    for (const field of ['lastGood', 'lastGoodWindows', 'accountEmail', 'planType', 'usage', 'cursorUsage']) delete metadata[field];
    return { ...quota, session: null, weekly: null, monthly: null, buckets: [],
        status: 'unavailable', error: 'Quota account lineage could not be confirmed; previous readings were not transferred.',
        // A provider-method 429 cooldown is not account headroom. Retain its
        // retry bookkeeping even when its account numbers cannot be restored.
        metadata: { ...metadata, failureKind: quota.metadata?.failureKind === 'rate-limited' ? 'rate-limited' : 'no-data' } } as T;
}

export function withQuotaAccountLineage(quota: ProviderQuota, lineage: QuotaAccountLineage): ProviderQuota {
    return { ...quota, metadata: { ...quota.metadata, accountLineage: lineage } };
}

/**
 * Recheck the owning CLI after collection. A stable account survives token
 * rotation. With no identity, equal credentials only confirm THIS request's
 * continuity; they never authorize transfer to/from a different measurement.
 */
export function settleCredentialQuota(quota: ProviderQuota, before: {
    token: string; lineage: QuotaAccountLineage; authority: string;
}, after: { token: string; lineage: QuotaAccountLineage; authority: string } | null): ProviderQuota {
    const continuous = after && before.authority === after.authority
        && (sameQuotaAccount(before.lineage, after.lineage)
            || (before.lineage.kind === 'unknown' && after.lineage.kind === 'unknown' && before.token === after.token));
    return continuous ? withQuotaAccountLineage(quota, before.lineage)
        : unconfirmedQuotaReading(quota, after?.lineage ?? UNKNOWN_ACCOUNT_LINEAGE);
}
