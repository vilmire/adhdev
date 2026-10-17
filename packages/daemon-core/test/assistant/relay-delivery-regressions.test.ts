import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantRelay } from '../../src/assistant/assistant-relay.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { renderNativeReplies } from '../../src/assistant/assistant-native-window.js';

const NOW = Date.parse('2026-10-17T06:00:00Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());
function harness(report: { body: string; completeness: 'final_native'; parts?: Array<{ at: number; chars: number }> }, store = new InMemoryAssistantRelayStore()) {
    let handler: (event: any) => void = () => {};
    const audit = vi.fn(async (_since: number) => [] as any[]);
    const relay = new AssistantRelay({ subscribe: h => { handler = h; return () => {}; }, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'p',
        readCoordinatorTail: async () => { throw new Error('forbidden'); }, rehydrateAttemptReport: async () => report,
        auditCoordinatorReplies: audit, meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => null,
        isAssistantReady: () => false, submit: async () => ({ kind: 'delivered' }), inputLog: new AssistantInputLog(), store });
    relay.start(); relay.openThread('mesh');
    return { relay, store, audit, emit: (event: any) => handler(event) };
}
const committed = { kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: 'plain:a', generation: 0, at: NOW, outcome: 'completed' };
async function micro() { for (let n = 0; n < 16; n++) await Promise.resolve(); }
async function deliver(h: ReturnType<typeof harness>) { h.emit(committed); await vi.advanceTimersByTimeAsync(15_001); return h.relay.pullPending(null); }

describe('relay delivery review regressions', () => {
    it('does not count a final beyond the 4096-character delivery cap as covered', async () => {
        const bubbles = [{ at: NOW - 2_000, chars: 4_200, text: 'x'.repeat(4_200) }, { at: NOW - 1_000, chars: 12, text: 'omitted tail' }];
        const h = harness({ body: renderNativeReplies(bubbles), completeness: 'final_native', parts: bubbles.map(({ at, chars }) => ({ at, chars })) });
        const delivered = await deliver(h);
        expect(delivered.map(x => x.text).join('\n')).not.toContain('omitted tail');
        h.audit.mockResolvedValue([{ sessionId: 'coord', attemptId: 'plain:a', messageAt: NOW - 1_000, text: 'omitted tail', chars: 12 }]);
        h.relay.tick(); await micro();
        expect((await h.relay.pullPending(null)).map(x => x.text).join('\n')).toContain('[ADHDev relay gap]');
        h.relay.stop();
    });

    it('does not cover a repeated short reply belonging to a different attempt', async () => {
        const h = harness({ body: 'Done.', completeness: 'final_native', parts: [{ at: NOW - 1_000, chars: 5 }] });
        await deliver(h);
        h.audit.mockResolvedValue([{ sessionId: 'coord', attemptId: 'plain:b', messageAt: NOW + 1_000, text: 'Done.', chars: 5 }]);
        h.relay.tick(); await micro();
        expect((await h.relay.pullPending(null)).map(x => x.text).join('\n')).toContain('[ADHDev relay gap]');
        h.relay.stop();
    });

    it('keeps timestamp collisions distinct by content hash when deduplicating gaps', async () => {
        const h = harness({ body: 'irrelevant', completeness: 'final_native' });
        h.audit.mockResolvedValue(['first', 'second'].map(text => ({ sessionId: 'coord', attemptId: null, messageAt: NOW - 1_000, text, chars: text.length })));
        h.relay.tick(); await micro();
        const gaps = await h.relay.pullPending(null);
        expect(gaps.filter(x => x.text.includes('[ADHDev relay gap]'))).toHaveLength(2);
        h.relay.stop();
    });

    it('does not retain delivered bodies, and clears transient coverage and dedup state on stop', async () => {
        const secret = 'body retained only in the bounded exact-report store';
        const h = harness({ body: secret, completeness: 'final_native', parts: [{ at: NOW - 1_000, chars: secret.length }] });
        await deliver(h);
        expect(JSON.stringify([...(h.relay as any).renderedCoverage])).not.toContain(secret);
        h.relay.stop();
        expect((h.relay as any).renderedCoverage.size).toBe(0);
        expect((h.relay as any).flaggedReplies.size).toBe(0);
    });

    it('preserves the audit cursor after failure and ignores an audit completing after stop', async () => {
        const h = harness({ body: 'body', completeness: 'final_native' });
        h.audit.mockRejectedValueOnce(new Error('transient'));
        await vi.advanceTimersByTimeAsync(1_000); h.relay.tick(); await micro();
        const since = h.audit.mock.calls[0][0];
        await vi.advanceTimersByTimeAsync(60_000); h.relay.tick(); await micro();
        expect(h.audit.mock.calls[1][0]).toBe(since);
        let resolve!: (replies: any[]) => void;
        h.audit.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        h.relay.tick(); await micro(); h.relay.stop();
        resolve([{ sessionId: 'coord', attemptId: null, messageAt: NOW, text: 'late', chars: 4 }]); await micro();
        expect(h.relay.hasPendingInput()).toBe(false);
    });

    it('preserves the audit cursor on partial results while reporting healthy-session gaps', async () => {
        const h = harness({ body: 'body', completeness: 'final_native' });
        h.audit.mockResolvedValue(Object.assign([{ sessionId: 'coord', attemptId: null, messageAt: NOW, text: 'healthy', chars: 7 }], { complete: false }));
        await vi.advanceTimersByTimeAsync(1_000); h.relay.tick(); await micro();
        expect((await h.relay.pullPending(null)).map(x => x.text).join('\n')).toContain('[ADHDev relay gap]');
        const since = h.audit.mock.calls[0][0];
        await vi.advanceTimersByTimeAsync(60_000); h.relay.tick(); await micro();
        expect(h.audit.mock.calls[1][0]).toBe(since);
        h.relay.stop();
    });

    it('allows bounded native scan timeouts to return healthy partial results', async () => {
        const h = harness({ body: 'body', completeness: 'final_native' });
        h.audit.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(Object.assign([
            { sessionId: 'coord', attemptId: null, messageAt: NOW, text: 'healthy', chars: 7 },
        ], { complete: false })), 2_100)));
        h.relay.tick(); await vi.advanceTimersByTimeAsync(2_101);
        expect((await h.relay.pullPending(null)).map(x => x.text).join('\n')).toContain('[ADHDev relay gap]');
        h.relay.stop();
    });

    it('defers gaps while the attempt is queued for normal delivery', async () => {
        const h = harness({ body: 'final', completeness: 'final_native', parts: [{ at: NOW - 1_000, chars: 5 }] });
        h.audit.mockResolvedValue([{ sessionId: 'coord', attemptId: 'plain:a', messageAt: NOW - 1_000, text: 'final', chars: 5 }]);
        h.emit(committed); await micro(); h.relay.tick(); await micro();
        expect(await h.relay.pullPending(null)).toEqual([]);
        await vi.advanceTimersByTimeAsync(15_001); await h.relay.pullPending(null);
        h.relay.tick(); await micro();
        expect(await h.relay.pullPending(null)).toEqual([]);
        h.relay.stop();
    });

    it('bounds a hung rehydration and clears its timers on stop', async () => {
        const h = harness({ body: 'body', completeness: 'final_native' });
        (h.relay as any).ports.rehydrateAttemptReport = () => new Promise(() => {});
        h.emit(committed);
        await vi.advanceTimersByTimeAsync(15_001);
        expect((await h.relay.pullPending(null)).map(x => x.text).join('\n')).toContain('no coordinator message found');
        h.relay.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds queued body caches and expires coverage hashes after the retention window', async () => {
        const h = harness({ body: 'small body', completeness: 'final_native', parts: [{ at: NOW - 1_000, chars: 10 }] });
        for (let i = 0; i < 130; i++) h.emit({ ...committed, attemptId: `plain:${i}` });
        await micro();
        expect((h.relay as any).attemptBodies.size).toBeLessThanOrEqual(128);
        await vi.advanceTimersByTimeAsync(15_001);
        await h.relay.pullPending(null);
        expect((h.relay as any).renderedCoverage.size).toBeGreaterThan(0);
        vi.setSystemTime(NOW + 25 * 60 * 60_000); h.relay.tick(); await micro();
        expect((h.relay as any).renderedCoverage.size).toBe(0);
        h.relay.stop();
    });
});
