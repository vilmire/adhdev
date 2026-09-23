import { describe, expect, it } from 'vitest';
import {
    DEFAULT_TURN_POLICY,
    awaitDeliveryMs,
    consumeGraceFor,
    holdTtlMs,
    resolveTurnPolicy,
    resolveTurnPolicyDetailed,
    unknownLivenessGraceMs,
} from '../../src/mesh/turn-ledger/policy.js';

describe('TurnPolicy', () => {
    it('has the 8 design defaults', () => {
        expect(DEFAULT_TURN_POLICY).toEqual({
            tickMs: 4_000, quietWindowMs: 8_000, consumeGraceMs: 90_000, deliveryCeilingMs: 120_000,
            livenessDeadlineMs: 480_000, noTurnDeadlineMs: 900_000, stallNoticeMs: 180_000, hardCeilingMs: 5_400_000,
        });
        expect(resolveTurnPolicy({})).toEqual(DEFAULT_TURN_POLICY);
    });

    it('derives the stamped values', () => {
        expect(holdTtlMs(DEFAULT_TURN_POLICY)).toBe(12_000);
        expect(unknownLivenessGraceMs(DEFAULT_TURN_POLICY)).toBe(12_000);
        expect(awaitDeliveryMs(DEFAULT_TURN_POLICY)).toBe(240_000);
        expect(consumeGraceFor(DEFAULT_TURN_POLICY, 'native_source')).toBe(180_000);
        expect(consumeGraceFor(DEFAULT_TURN_POLICY, 'default')).toBe(90_000);
    });

    it('honours the legacy env aliases with their historical clamps', () => {
        const { policy, sources } = resolveTurnPolicyDetailed({
            MESH_RECONCILE_INTERVAL_MS: '2000',
            MESH_PENDING_HELD_CEILING_MS: '60000',
            MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS: '300000',
            MESH_INFLIGHT_ACKED_HOLD_HARD_CEILING_MS: '3600000',
        });
        expect(policy).toMatchObject({ tickMs: 2_000, deliveryCeilingMs: 60_000, livenessDeadlineMs: 300_000, hardCeilingMs: 3_600_000 });
        expect(sources).toEqual({
            tickMs: 'MESH_RECONCILE_INTERVAL_MS', deliveryCeilingMs: 'MESH_PENDING_HELD_CEILING_MS',
            livenessDeadlineMs: 'MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS', hardCeilingMs: 'MESH_INFLIGHT_ACKED_HOLD_HARD_CEILING_MS',
        });
        // Legacy clamps: interval floor 1s, held ceiling floor 12s.
        expect(resolveTurnPolicy({ MESH_RECONCILE_INTERVAL_MS: '500', MESH_PENDING_HELD_CEILING_MS: '5000' })).toMatchObject({ tickMs: 4_000, deliveryCeilingMs: 120_000 });
    });

    it('lets the canonical name win over an alias, and accepts test-sized values', () => {
        const policy = resolveTurnPolicy({ ADHDEV_TURN_TICK_MS: '250', MESH_RECONCILE_INTERVAL_MS: '2000', ADHDEV_TURN_CONSUME_GRACE_MS: '5000' });
        expect(policy.tickMs).toBe(250);
        expect(policy.consumeGraceMs).toBe(5_000);
    });

    it('ignores garbage and out-of-range values, and reports retired names', () => {
        expect(resolveTurnPolicy({ ADHDEV_TURN_QUIET_WINDOW_MS: '8s', ADHDEV_TURN_HARD_CEILING_MS: '-1', ADHDEV_TURN_TICK_MS: '99999999' })).toEqual(DEFAULT_TURN_POLICY);
        expect(resolveTurnPolicyDetailed({ MESH_PENDING_HELD_DRAIN_ESCALATE_MS: '12000' }).ignored).toEqual(['MESH_PENDING_HELD_DRAIN_ESCALATE_MS']);
    });
});
