import { afterEach, describe, expect, it } from 'vitest';
import { armQuotaRestartWarmup, QUOTA_RESTART_WARMUP_SECONDS, quotaStillWarmingUp } from '../../src/mesh/mesh-quota-sources.js';

const T0 = 1_000_000;
afterEach(() => armQuotaRestartWarmup(null));

describe('quota warm-up after a restart', () => {
    it('does nothing unless a booting daemon armed it', () => {
        expect(quotaStillWarmingUp(['not_measured'], T0)).toBe(false);
    });
    it('waits only while every usable provider is unmeasured', () => {
        armQuotaRestartWarmup(T0);
        expect(quotaStillWarmingUp(['not_measured', 'not_measured'], T0 + 1000)).toBe(true);
        expect(quotaStillWarmingUp(['not_measured', 'measured'], T0 + 1000)).toBe(false);
        expect(quotaStillWarmingUp(['not_measured', 'probe_disabled'], T0 + 1000)).toBe(false);
        expect(quotaStillWarmingUp([], T0 + 1000)).toBe(false);
    });
    it('never holds past the bound, so a provider that never reports still launches', () => {
        armQuotaRestartWarmup(T0);
        expect(quotaStillWarmingUp(['not_measured'], T0 + QUOTA_RESTART_WARMUP_SECONDS * 1000 - 1)).toBe(true);
        expect(quotaStillWarmingUp(['not_measured'], T0 + QUOTA_RESTART_WARMUP_SECONDS * 1000)).toBe(false);
    });
});
