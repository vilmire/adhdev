import { reportMessageId } from '../../src/assistant/project-views.js';
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
    const audit = vi.fn(async (_since: number) => [] as any[] & { complete?: boolean });
    const relay = new AssistantRelay({ subscribe: h => { handler = h; return () => {}; }, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'p',
        readCoordinatorTail: async () => { throw new Error('forbidden'); }, rehydrateAttemptReport: async () => report,
        auditCoordinatorReplies: async since => { const rows = await audit(since); return Object.assign(rows.map(r => ({ ...r, messageId: reportMessageId({ role: 'assistant', timestamp: r.messageAt, content: r.text }) })), { complete: rows.complete }); },
        canReadCoordinatorReply: async () => true, meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => null,
        isAssistantReady: () => false, submit: async () => ({ kind: 'delivered' }), inputLog: new AssistantInputLog(), store });
    relay.start(); relay.openThread('mesh');
    return { relay, store, audit, emit: (event: any) => handler(event) };
}
const committed = { kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: 'plain:a', generation: 0, at: NOW, outcome: 'completed' };
async function micro() { for (let n = 0; n < 16; n++) await Promise.resolve(); }
async function deliver(h: ReturnType<typeof harness>) { h.emit(committed); await vi.advanceTimersByTimeAsync(15_001); return h.relay.pullPending(null); }

describe('relay delivery review regressions', () => {
    it('pages a long native report through the existing 4096-character budget, covers it only after the final page, and emits no gap', async () => {
        const bubbles = [{ at: NOW - 2_000, chars: 4_200, text: 'x'.repeat(4_200) }, { at: NOW - 1_000, chars: 12, text: 'omitted tail' }];
        const h = harness({ body: renderNativeReplies(bubbles), completeness: 'final_native', parts: bubbles.map(({ at, chars }) => ({ at, chars })) });
        const first = await deliver(h);
        expect(first.map(x => x.text).join('\n')).not.toContain('omitted tail');
        expect(h.store.listDeliveredCoverage(NOW)).toEqual([]);
        const second = await h.relay.pullPending(null);
        expect(second.map(x => x.text).join('\n')).toContain('omitted tail');
        expect(h.store.listUndelivered()).toEqual([]);
        h.audit.mockResolvedValue(bubbles.map(b => ({ sessionId: 'coord', attemptId: 'plain:a', messageAt: b.at, text: b.text, chars: b.chars })));
        h.relay.tick(); await micro();
        expect(await h.relay.pullPending(null)).toEqual([]);
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

    it('batches distinct timestamp collisions into one readable window notice', async () => {
        const h = harness({ body: 'irrelevant', completeness: 'final_native' });
        h.audit.mockResolvedValue(['first', 'second'].map(text => ({ sessionId: 'coord', attemptId: null, messageAt: NOW - 1_000, text, chars: text.length })));
        h.relay.tick(); await micro();
        const gaps = await h.relay.pullPending(null);
        expect(gaps.filter(x => x.text.includes('[ADHDev relay gap]'))).toHaveLength(1);
        expect(gaps[0].text).toContain('2 coordinator replies');
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
        expect(await h.relay.pullPending(null)).toEqual([]);
        expect(h.store.listUndelivered()).toHaveLength(1);
        h.relay.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds queued body caches and expires coverage hashes after the retention window', async () => {
        const h = harness({ body: 'small body', completeness: 'final_native', parts: [{ at: NOW - 1_000, chars: 10 }] });
        for (let i = 0; i < 130; i++) h.emit({ ...committed, attemptId: `plain:${i}` });
        await micro();
        expect((h.relay as any).attemptBodies.size).toBeLessThanOrEqual(128);
        await vi.advanceTimersByTimeAsync(15_001);
        const pages = [...await h.relay.pullPending(null), ...await h.relay.pullPending(null)];
        expect(pages.map(p => p.text).join('\n').match(/small body/g)).toHaveLength(130);
        expect(h.store.countUnrendered().total).toBe(0);
        expect(h.store.listUndelivered()).toHaveLength(0);
        expect((h.relay as any).renderedCoverage.size).toBeGreaterThan(0);
        vi.setSystemTime(NOW + 25 * 60 * 60_000); h.relay.tick(); await micro();
        expect((h.relay as any).renderedCoverage.size).toBe(0);
        h.relay.stop();
    });
});

const missing = (n: number, attemptId: string | null = 'plain:missing') => ({
    sessionId: 'coord', meshId: 'mesh', attemptId, messageAt: NOW - 2_000 + n,
    text: `Synthetic finalized reply ${n}. All sentences are available.`, chars: 56,
});
const cursorFor = (r: ReturnType<typeof missing>) => reportMessageId({ role: 'assistant', timestamp: r.messageAt, content: r.text });

describe('batched actionable relay gaps', () => {
    it('batches N replies from one attempt and never wakes again for later replies from that attempt', async () => {
        const h = harness({ body: 'unused', completeness: 'final_native' });
        h.audit.mockResolvedValue(Array.from({ length: 5 }, (_, n) => missing(n)));
        h.relay.tick(); await micro();
        const notices = await h.relay.pullPending(null);
        expect(notices).toHaveLength(1);
        expect(notices[0].text).toContain('5 coordinator replies');
        expect(notices[0].text).toContain(cursorFor(missing(4)));
        h.audit.mockResolvedValue([missing(6)]);
        h.relay.tick(); await micro();
        expect(await h.relay.pullPending(null)).toEqual([]);
        h.relay.stop();
    });

    it('withdraws a queued notice when project_read has already returned the full target', async () => {
        const h = harness({ body: 'unused', completeness: 'final_native' });
        const reply = missing(1);
        h.audit.mockResolvedValue([reply]); h.relay.tick(); await micro();
        h.relay.recordProjectRead({ coordinatorSessionId: 'coord', messages: [{ messageId: cursorFor(reply),
            text: reply.text, complete: true, totalChars: reply.text.length }] }, null);
        expect(await h.relay.pullPending(null)).toEqual([]);
        h.relay.tick(); await micro(); expect(await h.relay.pullPending(null)).toEqual([]);
        h.relay.stop();
    });

    it('does not acknowledge unread middle pages or a partial growing reply', async () => {
        const h = harness({ body: 'unused', completeness: 'final_native' });
        const reply = missing(1); const messageId = cursorFor(reply);
        h.relay.recordProjectRead({ coordinatorSessionId: 'coord', messageId, offset: 20,
            text: reply.text.slice(20), complete: true, totalChars: reply.text.length }, null);
        h.audit.mockResolvedValue([reply]); h.relay.tick(); await micro();
        expect(await h.relay.pullPending(null)).toHaveLength(1);
        h.relay.stop();
    });

    it('checks availability at delivery and suppresses unreadable and expired targets', async () => {
        const h = harness({ body: 'unused', completeness: 'final_native' });
        const canRead = vi.fn(async () => false);
        (h.relay as any).ports.canReadCoordinatorReply = canRead;
        h.audit.mockResolvedValue([missing(1)]); h.relay.tick(); await micro();
        expect(await h.relay.pullPending(null)).toEqual([]);
        expect(canRead).toHaveBeenCalledWith(expect.objectContaining({ messageId: cursorFor(missing(1)) }));
        canRead.mockResolvedValue(true);
        h.relay.tick(); await micro();
        const notices = await h.relay.pullPending(null);
        expect(notices).toHaveLength(1);
        expect(notices[0].text).toContain('"coordinatorSessionId":"coord"');
        expect(notices[0].text).toContain('"offset":0');
        h.relay.stop();
    });

    it('preserves notification receipts across relay restarts and does not repeat an unchanged counter', async () => {
        const store = new InMemoryAssistantRelayStore();
        store.recordCommitted({ attemptId: 'lost', coordinatorSessionId: 'coord', meshId: 'mesh', committedAt: NOW, kind: 'relay', outcome: 'completed' });
        store.markDelivered(['lost'], NOW, []);
        const h = harness({ body: 'unused', completeness: 'final_native' }, store);
        h.audit.mockResolvedValue([missing(1)]); h.relay.tick(); await micro();
        const first = (await h.relay.pullPending(null)).map(e => e.text).join('\n');
        expect(first).toContain('1 coordinator report did not reach you');
        h.relay.stop();
        const next = harness({ body: 'unused', completeness: 'final_native' }, store);
        next.audit.mockResolvedValue([missing(1), missing(2, 'plain:other')]); next.relay.tick(); await micro();
        const second = (await next.relay.pullPending(null)).map(e => e.text).join('\n');
        expect(second).toContain('relay gap');
        expect(second).not.toContain('did not reach you');
        next.relay.stop();
    });
});


it('preserves whitespace and Unicode across bounded relay pages without repeating any body text', async () => {
    const body = '가'.repeat(4095) + ' boundary sentence.\nAnother complete sentence ends here.';
    const h = harness({ body, completeness: 'final_native', parts: [{ at: NOW - 1_000, chars: Array.from(body).length }] });
    const pages = [...await deliver(h), ...await h.relay.pullPending(null)];
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toContain('가'.repeat(4095) + ' \n\n[/relay]');
    expect(pages[1].text).toContain('boundary sentence.\nAnother complete sentence ends here.');
    expect(h.store.listDeliveredCoverage(NOW)[0].replies).toHaveLength(1);
    h.relay.stop();
});

it('does not flag a delivered late flush even when its timestamp leaves it outside the original attempt span', async () => {
    const h = harness({ body: 'Final after debounce. Complete message.', completeness: 'final_native',
        parts: [{ at: NOW + 1_000, chars: 'Final after debounce. Complete message.'.length }] });
    await deliver(h);
    h.audit.mockResolvedValue([{ sessionId: 'coord', attemptId: null, messageAt: NOW + 1_000,
        text: 'Final after debounce. Complete message.', chars: 'Final after debounce. Complete message.'.length }]);
    h.relay.tick(); await micro();
    expect(await h.relay.pullPending(null)).toEqual([]);
    h.relay.stop();
});

it('suppresses fully paged attempt reads only for the same content-bound report', async () => {
    const h = harness({ body: 'unused', completeness: 'final_native' });
    const reply = { ...missing(1), attemptReportId: 'a'.repeat(64) };
    const page = { coordinatorSessionId: 'coord', attemptId: reply.attemptId, reportId: reply.attemptReportId,
        offset: 0, text: reply.text.slice(0, 20), totalChars: reply.text.length, complete: false, nextOffset: 20 };
    h.relay.recordProjectRead(page, null);
    h.relay.recordProjectRead({ ...page, offset: 20, text: reply.text.slice(20), complete: true, nextOffset: null }, null);
    h.audit.mockResolvedValue([reply]); h.relay.tick(); await micro();
    expect(await h.relay.pullPending(null)).toEqual([]);
    h.audit.mockResolvedValue([{ ...reply, attemptReportId: 'b'.repeat(64) }]); h.relay.tick(); await micro();
    expect(await h.relay.pullPending(null)).toHaveLength(1);
    h.relay.stop();
});

it('suppresses replies older than a fully read native tail, while an unverified read cannot advance the fence', async () => {
    const tail = { coordinatorSessionId: 'coord', sourceComplete: true, messages: [{ role: 'assistant',
        messageId: 'c'.repeat(64), at: new Date(NOW).toISOString(), text: 'Later finalized native reply.',
        totalChars: 'Later finalized native reply.'.length, complete: true }] };
    const h = harness({ body: 'unused', completeness: 'final_native' });
    h.relay.recordProjectRead(tail, null);
    h.audit.mockResolvedValue([missing(1)]); h.relay.tick(); await micro();
    expect(await h.relay.pullPending(null)).toEqual([]);
    h.relay.stop();
    const unverified = harness({ body: 'unused', completeness: 'final_native' });
    unverified.relay.recordProjectRead({ ...tail, sourceComplete: false }, null);
    unverified.audit.mockResolvedValue([missing(1)]); unverified.relay.tick(); await micro();
    expect(await unverified.relay.pullPending(null)).toHaveLength(1);
    unverified.relay.stop();
});
