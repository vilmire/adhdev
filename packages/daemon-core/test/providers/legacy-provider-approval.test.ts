import { describe, expect, it } from 'vitest';
import { readProviderDecision, isActionableProviderApproval } from '@adhdev/mesh-shared';
import { legacyLiveProviderApproval } from '../../src/providers/legacy-provider-approval.js';

// IDE/extension instances (and CLI adapters without a modal lifecycle) attach a keyed
// approval for owner escalation. It must still read as a legacy session-only decision —
// a record without `source` is dropped by readProviderDecision, which removed these
// approvals from the Approvals inbox and from mesh active-work.
describe('legacyLiveProviderApproval', () => {
    it('survives readProviderDecision and keeps its escalation key', () => {
        const approval = legacyLiveProviderApproval('modal:6f1d1b5e-2c0a-4a51-9a7e-0c3f6f1c2d11', true);
        const decision = readProviderDecision(approval, true, true);
        expect(decision).not.toBeNull();
        expect(decision?.source).toBe('legacy_provider');
        expect(decision?.compatibility).toBe('session_only');
        expect(decision?.modalKey).toBe('modal:6f1d1b5e-2c0a-4a51-9a7e-0c3f6f1c2d11');
        expect(decision?.evidence).toBe('live');
    });

    it('is never actionable on the exact-button Inbox path', () => {
        expect(isActionableProviderApproval(legacyLiveProviderApproval('modal:k', true))).toBe(false);
    });
});
