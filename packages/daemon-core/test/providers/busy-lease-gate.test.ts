/**
 * TX-FSM Stage 2 — busy-lease rollout gate. Pins the canary structure: the
 * lease ships to the designated canary providers only, every other provider
 * observes zero behavior change, and the env knobs widen/disable the rollout
 * without a code change.
 */
import { describe, it, expect } from 'vitest';
import { BUSY_LEASE_BOUND_MS, resolveBusyLeaseGate } from '../../src/providers/busy-lease-gate.js';

describe('resolveBusyLeaseGate (TX-FSM Stage 2 canary)', () => {
    it('enables the default canary (kimi, codex-cli) with the default bound', () => {
        expect(resolveBusyLeaseGate('kimi', {})).toEqual({ enabled: true, boundMs: BUSY_LEASE_BOUND_MS });
        expect(resolveBusyLeaseGate('codex-cli', {})).toEqual({ enabled: true, boundMs: BUSY_LEASE_BOUND_MS });
    });

    it('leaves every non-canary provider disabled (antigravity included)', () => {
        for (const type of ['antigravity-cli', 'claude-cli', 'cursor-cli', 'opencode', 'hermes-cli', undefined, '']) {
            expect(resolveBusyLeaseGate(type, {}).enabled).toBe(false);
        }
    });

    it('env provider list REPLACES the canary (widen or disable without code)', () => {
        expect(resolveBusyLeaseGate('antigravity-cli', { ADHDEV_TX_BUSY_LEASE_PROVIDERS: 'antigravity-cli,kimi' }).enabled).toBe(true);
        expect(resolveBusyLeaseGate('codex-cli', { ADHDEV_TX_BUSY_LEASE_PROVIDERS: 'antigravity-cli,kimi' }).enabled).toBe(false);
        expect(resolveBusyLeaseGate('kimi', { ADHDEV_TX_BUSY_LEASE_PROVIDERS: '-' }).enabled).toBe(false);
    });

    it('env bound override wins; garbage falls back to the default', () => {
        expect(resolveBusyLeaseGate('kimi', { ADHDEV_TX_BUSY_LEASE_BOUND_MS: '30000' }).boundMs).toBe(30_000);
        expect(resolveBusyLeaseGate('kimi', { ADHDEV_TX_BUSY_LEASE_BOUND_MS: 'nope' }).boundMs).toBe(BUSY_LEASE_BOUND_MS);
        expect(resolveBusyLeaseGate('kimi', { ADHDEV_TX_BUSY_LEASE_BOUND_MS: '-5' }).boundMs).toBe(BUSY_LEASE_BOUND_MS);
    });
});
