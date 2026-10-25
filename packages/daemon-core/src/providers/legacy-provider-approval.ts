import type { ProviderApproval } from '@adhdev/mesh-shared';

/**
 * Approval record for a provider without a modal lifecycle (IDE/extension, or a CLI
 * whose adapter reported no providerApproval). It carries only the opaque modalKey so
 * owner escalation can coalesce, and keeps the legacy session-only shape that
 * readProviderDecision accepts — a record without `source` is dropped there, which
 * removed these approvals from the Inbox and mesh active-work.
 */
export function legacyLiveProviderApproval(modalKey: string, hasButtons: boolean): ProviderApproval {
    return {
        source: 'legacy_provider', type: 'unknown', compatibility: hasButtons ? 'session_only' : 'unknown',
        evidence: 'live', lifecycle: 'pending', modalKey, createdAt: null, resolvedAt: null,
        description: '', buttons: [], actionable: false,
    } as ProviderApproval;
}
