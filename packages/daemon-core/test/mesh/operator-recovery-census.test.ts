import { describe, it, expect, vi } from 'vitest';
// Explicit fake physical fixture: only namespace derivation is replaced here.
// The host's separate node test uses real derivation and requires UNKNOWN.
vi.mock('@adhdev/session-host-core', async original => ({
    ...await original<object>(), resolveSessionHostIpcKey: () => '6a2ef3162182',
}));
import { OPERATOR_RECOVERY_TARGET as target } from '@adhdev/session-host-core';
import { evaluateRecoveryCensus, type RecoveryCensusSnapshot } from '../../../session-host-daemon/src/operator-recovery-census.js';
function fixture(): RecoveryCensusSnapshot {
    const nonce = '1'.repeat(64); const fenceDigest = '2'.repeat(64);
    const binding = { namespace: target.namespace, hostBootId: 'fake-boot', workerDaemonId: target.workerDaemonId,
        endpoint: `/fake/adhdev-preview-session-host-${target.namespace}.sock` };
    return { binding, instanceConfigDir: '/fake-explicit-namespace-fixture', nonce, fenceDigest,
        restoreState: 'ready', fullRestoreState: 'ready', partialRestoreCount: 0, storageCensus: 'complete',
        targetRuntime: 'absent', inFlightLaunches: 0,
        guardian: { protocol: 1, namespace: target.namespace, hostBootId: binding.hostBootId, fenceDigest, nonce,
            sessionId: target.sessionId, providerSessionId: target.providerSessionId,
            historicalLineage: 'complete', descendants: 'absent', transcriptHandles: 'absent', launchAliases: 'closed' } };
}
describe('native recovery census with explicitly fake identity and physical observations', () => {
    it('accepts the complete dual-UUID fake proof as a positive control', () => {
        const s = fixture(); expect(evaluateRecoveryCensus(s).verdict).toBe('ABSENT');
        expect(evaluateRecoveryCensus(s)).not.toHaveProperty('writerStopReceipt');
    });
    for (const [field, value] of Object.entries({ restoreState: 'failed', fullRestoreState: 'partial',
        partialRestoreCount: 1, storageCensus: 'unknown', targetRuntime: 'unknown', inFlightLaunches: 1,
        nonce: '', fenceDigest: '', guardian: null })) {
        it(`returns UNKNOWN for ${field}=${value}`, () => {
            expect(evaluateRecoveryCensus({ ...fixture(), [field]: value } as any).verdict).toBe('UNKNOWN');
        });
    }
    for (const [field, value] of Object.entries({ protocol: 2, namespace: '', hostBootId: 'old-boot', fenceDigest: 'old-fence',
        nonce: 'old-nonce', sessionId: 'other-session', providerSessionId: 'other-provider',
        historicalLineage: 'unknown', descendants: 'unknown', transcriptHandles: 'unknown', launchAliases: 'unknown' })) {
        it(`returns UNKNOWN for guardian ${field}=${value}`, () => {
            const s = fixture(); s.guardian = { ...s.guardian!, [field]: value } as any;
            expect(evaluateRecoveryCensus(s).verdict).toBe('UNKNOWN');
        });
    }
    for (const field of ['descendants', 'transcriptHandles'] as const) {
        it(`returns LIVE for guardian ${field}`, () => {
            const s = fixture(); s.guardian![field] = 'live'; expect(evaluateRecoveryCensus(s).verdict).toBe('LIVE');
        });
    }
    it('returns LIVE for an extant target runtime', () => {
        expect(evaluateRecoveryCensus({ ...fixture(), targetRuntime: 'live' }).verdict).toBe('LIVE');
    });
    it('does not accept restorePending=false as positive full restore readiness', () => {
        const s = { ...fixture(), restorePending: false, fullRestoreState: 'failed' };
        expect(evaluateRecoveryCensus(s).verdict).toBe('UNKNOWN');
    });
});
