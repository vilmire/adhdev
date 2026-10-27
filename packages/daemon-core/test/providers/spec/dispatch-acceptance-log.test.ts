/**
 * DISPATCH-ACK PRODUCER (providers/spec/dispatch-acceptance-log.ts): the serialized
 * input-acceptance log a DispatchAcknowledgementWatermark is derived from. The claim
 * `unacceptedConfirmed: true` is fail-closed — only an exact id whose last write was
 * followed by its own `unaccepted` verdict and by nothing that could be an acceptance.
 * The consumer stays dormant: no provider capability is flipped.
 */
import { describe, expect, it } from 'vitest';
import { DISPATCH_ACCEPTANCE_LOG_MAX, DispatchAcceptanceLog } from '../../../src/providers/spec/dispatch-acceptance-log.js';
import { PROVIDER_CONSUMPTION_CAPABILITIES, hasAuthoritativeNonConsumptionProof } from '../../../src/boot/stages/mesh-runtime.js';

function clock(start = 1_000_000) { let t = start; return { now: () => t, tick: (ms: number) => { t += ms; } }; }

describe('DispatchAcceptanceLog', () => {
    it('written → unaccepted is confirmed, bound to the exact messageId and nonce, with a seq at/after the write', () => {
        const c = clock();
        const log = new DispatchAcceptanceLog(c.now);
        const writtenAt = log.record('written', 'task:a:n3', 3);
        c.tick(5_000);
        log.record('unaccepted', 'task:a:n3');
        const wm = log.watermark('task:a:n3');
        expect(wm).toEqual({ messageId: 'task:a:n3', nonce: 3, watermarkSeq: writtenAt + 5_000, unacceptedConfirmed: true });
        expect(log.watermark('task:a:n3', 3)?.unacceptedConfirmed).toBe(true);
        expect(log.watermark('task:a:n3', 4)).toBeNull();
        expect(log.watermark('task:a:n4')).toBeNull();
        expect(log.watermark('task:a:n3 ')).toBeNull();
    });

    it('a write with no verdict yet is not confirmed', () => {
        const log = new DispatchAcceptanceLog();
        log.record('written', 'task:b:n0');
        expect(log.watermark('task:b:n0')?.unacceptedConfirmed).toBe(false);
    });

    for (const event of ['accepted', 'activity', 'indeterminate', 'foreign_input', 'reset'] as const) {
        it(`any '${event}' after the write — for any message — withdraws the claim`, () => {
            const log = new DispatchAcceptanceLog();
            log.record('written', 'task:c:n0');
            log.record('unaccepted', 'task:c:n0');
            log.record(event, event === 'accepted' || event === 'indeterminate' ? 'task:other:n0' : undefined);
            expect(log.watermark('task:c:n0')?.unacceptedConfirmed).toBe(false);
        });
    }

    it('an acceptance between the write and the verdict withdraws the claim (serialization order matters)', () => {
        const log = new DispatchAcceptanceLog();
        log.record('written', 'task:d:n0');
        log.record('activity');
        log.record('unaccepted', 'task:d:n0');
        expect(log.watermark('task:d:n0')?.unacceptedConfirmed).toBe(false);
    });

    it('a re-write of the same id supersedes the earlier verdict', () => {
        const log = new DispatchAcceptanceLog();
        log.record('written', 'task:e:n0');
        log.record('unaccepted', 'task:e:n0');
        log.record('written', 'task:e:n0');
        expect(log.watermark('task:e:n0')?.unacceptedConfirmed).toBe(false);
    });

    it('another id\'s verdict does not confirm this one', () => {
        const log = new DispatchAcceptanceLog();
        log.record('written', 'task:f:n0');
        log.record('unaccepted', 'task:g:n0');
        expect(log.watermark('task:f:n0')?.unacceptedConfirmed).toBe(false);
    });

    it('seq is strictly monotonic under a frozen or stepped-back clock', () => {
        const c = clock(5_000);
        const log = new DispatchAcceptanceLog(c.now);
        const a = log.record('written', 'x');
        const b = log.record('foreign_input');
        c.tick(-1_000);
        const d = log.record('activity');
        expect(b).toBeGreaterThan(a);
        expect(d).toBeGreaterThan(b);
    });

    it('history evicted past the bound never yields a claim spanning it', () => {
        const log = new DispatchAcceptanceLog();
        log.record('written', 'task:old:n0');
        for (let i = 0; i < DISPATCH_ACCEPTANCE_LOG_MAX; i += 1) log.record('written', `task:fill:${i}`);
        expect(log.watermark('task:old:n0')).toBeNull();
        expect(log.snapshot()).toHaveLength(DISPATCH_ACCEPTANCE_LOG_MAX);
    });
});

describe('consumer stays dormant — capabilities remain false', () => {
    it('every provider still declares both non-consumption capabilities false', () => {
        for (const cap of Object.values(PROVIDER_CONSUMPTION_CAPABILITIES)) {
            expect(cap.canProveNonConsumption).toBe(false);
            expect(cap.supportsDispatchAcknowledgementWatermark).toBe(false);
        }
    });

    function fullProofInputs(watermark: unknown, sinceMs: number) {
        const payload: Record<string, unknown> = {
            status: 'idle', transcriptAuthority: 'provider', coverage: 'full', providerSessionId: 'ps_1',
            messages: [
                { role: 'user', content: 'earlier prompt', receivedAt: sinceMs - 60_000 },
                { role: 'assistant', content: 'earlier answer', receivedAt: sinceMs - 50_000 },
            ],
            dispatchAcknowledgement: watermark,
        };
        const ms = { selected: 'native-history', nativeSource: 'provider-native', nativeHistoryCoverage: 'full', identityStatus: 'safe', coverage: { safeMapping: true }, staleness: { freshEnough: true } };
        return { payload, ms, observed: { stale: false } as any };
    }

    it('the produced watermark is exactly what the consumer binds to — yet without a capability nothing is proven', () => {
        // Epoch-ms clock: the consumer treats timestamps below 1e10 as seconds.
        const c = clock(1_760_000_000_000);
        const log = new DispatchAcceptanceLog(c.now);
        const sinceMs = log.record('written', 'task:p:n0');
        c.tick(6_000);
        log.record('unaccepted', 'task:p:n0');
        const wm = log.watermark('task:p:n0');
        const { payload, ms, observed } = fullProofInputs(wm, sinceMs);
        // Dormant: the real capability matrix refuses before reading the watermark.
        expect(hasAuthoritativeNonConsumptionProof(payload, ms, observed, 'claude-cli', sinceMs, { messageId: 'task:p:n0' })).toBe(false);
        // Contract check only (never shipped): a provider that COULD prove it would accept this watermark…
        const could = { providerType: 'x', canProveNonConsumption: true, supportsDispatchAcknowledgementWatermark: true, requiresTurnTerminalMarkers: false, reason: 'test' };
        expect(hasAuthoritativeNonConsumptionProof(payload, ms, observed, 'x', sinceMs, { messageId: 'task:p:n0', capabilityOverride: could })).toBe(true);
        // …and refuses it for any other messageId or once the claim is withdrawn.
        expect(hasAuthoritativeNonConsumptionProof(payload, ms, observed, 'x', sinceMs, { messageId: 'task:p:n1', capabilityOverride: could })).toBe(false);
        log.record('activity');
        const withdrawn = fullProofInputs(log.watermark('task:p:n0'), sinceMs);
        expect(hasAuthoritativeNonConsumptionProof(withdrawn.payload, withdrawn.ms, withdrawn.observed, 'x', sinceMs, { messageId: 'task:p:n0', capabilityOverride: could })).toBe(false);
    });
});
