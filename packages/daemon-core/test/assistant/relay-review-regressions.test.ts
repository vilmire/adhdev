import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AssistantRelay, type AssistantRelayPorts } from '../../src/assistant/assistant-relay.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { InMemoryAssistantRelayStore, RELAY_RECEIPT_CAPS } from '../../src/assistant/assistant-relay-store.js';
import { SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { RelayGapTracker, receiptKey } from '../../src/assistant/relay-gap-tracker.js';
import { compactTranscriptTail, reportMessageId } from '../../src/assistant/project-views.js';
import { pageAttemptReport, reportBodyId } from '../../src/assistant/report-continuation.js';
import { verifiedNativeRead } from '../../src/assistant/attempt-report-recovery.js';
import { LOG } from '../../src/logging/logger.js';
import { RELAY_BODY_MAX_CHARS, RELAY_MAX_AUTO_PAGES, RELAY_NATIVE_GRACE_MS, RELAY_NATIVE_WAIT_MS,
    RELAY_CAPTURE_BACKOFF_MS, RELAY_READABILITY_CACHE_MS, RELAY_UNREADABLE_HOLD_MS } from '../../src/assistant/assistant-relay-format.js';

const NOW = Date.parse('2026-10-18T06:00:00Z');
const raw = { role: 'assistant', kind: 'standard', receivedAt: NOW - 1000, content: 'Synthetic coordinator context. All sentences are readable.' };
const reply = (id = 'plain:missing') => ({ meshId: 'mesh', sessionId: 'coord', attemptId: id,
    messageAt: raw.receivedAt, text: raw.content, chars: raw.content.length, messageId: reportMessageId(raw) });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function micro() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
function harness(report: any = null, assistant: string | null = null) {
    let emit: (event: any) => void = () => {};
    const store = new InMemoryAssistantRelayStore();
    const state = { ready: false, refuse: false };
    const captures = vi.fn(async () => report);
    const audit = vi.fn(async () => [] as ReturnType<typeof reply>[]);
    const readable = vi.fn(async () => true);
    const context = vi.fn(async () => ({ coordinatorSessionId: 'coord', messageId: reportMessageId(raw), offset: 0 }));
    const submits: string[] = [];
    const ports: AssistantRelayPorts = {
        subscribe: h => { emit = h; return () => {}; }, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'synthetic',
        readCoordinatorTail: async () => { throw new Error('not attempt evidence'); }, rehydrateAttemptReport: captures,
        auditCoordinatorReplies: audit, canReadCoordinatorReply: readable, readCoordinatorReference: context,
        meshWork: () => ({ assigned: 1, pending: 0, activeMissions: 1 }), hasAssistant: () => true,
        assistantSessionId: () => assistant, isAssistantReady: () => state.ready,
        submit: async (_sid, input) => { submits.push(input.text); return state.refuse ? { kind: 'refused', reason: 'session_busy' } as any : { kind: 'delivered' }; },
        inputLog: new AssistantInputLog(), store, maxNudgeAttempts: 0,
    };
    const relay = new AssistantRelay(ports); relay.start(); relay.openThread('mesh');
    return { relay, captures, audit, readable, context, state, store, submits,
        commit: (id = 'plain:a') => emit({ kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: id, generation: 0, at: NOW, outcome: 'completed' }) };
}

describe('review: bounded capture liveness', () => {
    it.each(['kimi-cli', 'cursor-cli', 'opencode-cli', 'grok-cli'])('surfaces a content-free readable context after the grace for %s', async provider => {
        expect(verifiedNativeRead({ success: true, source: 'provider-native', agent: provider }, 'coord')).toBe(false);
        const partial = 'Synthetic partial streaming fragment';
        const h = harness({ body: partial, completeness: 'envelope_unverified', source: provider }); h.commit();
        await vi.advanceTimersByTimeAsync(RELAY_NATIVE_WAIT_MS + 15_000);
        expect(await h.relay.pullPending('mcp')).toEqual([]); // grace only, never a 24-hour hold
        await vi.advanceTimersByTimeAsync(RELAY_NATIVE_GRACE_MS); h.relay.tick(); await micro();
        const events = await h.relay.pullPending('mcp');
        expect(events.map(e => e.text).join('\n')).toContain('native transcript unavailable');
        expect(events[0].text).toContain(reportMessageId(raw));
        expect(events[0].text).not.toContain(partial);
        expect(h.store.listUndelivered()).toEqual([]);
        // The assistant was told by notice + cursor: surfaced, not missed, and no cumulative counter in the same delivery.
        expect(h.store.countUnrendered().total).toBe(0);
        expect(h.relay.missedReportsFor('mesh')).toBe(0);
        expect(events.map(e => e.text).join('\n')).not.toContain('did not reach you');
        h.relay.tick(); await micro(); expect(await h.relay.pullPending('mcp')).toEqual([]);
        h.relay.stop();
    });

    it('bounds continuously-busy, crashed and inaccessible-path captures with the same grace and one actionable attempt pointer', async () => {
        const h = harness({ body: null, completeness: 'envelope_unverified', source: 'provider_busy_or_unavailable' });
        h.context.mockResolvedValue(null as any); h.commit('plain:unavail-1');
        await vi.advanceTimersByTimeAsync(RELAY_NATIVE_WAIT_MS + RELAY_NATIVE_GRACE_MS + 1);
        const events = await h.relay.pullPending('mcp');
        expect(events).toHaveLength(1);
        expect(events[0].text).toContain('No readable coordinator message is available');
        expect(events[0].text).toContain('"project":"synthetic"');
        expect(events[0].text).toContain('"attemptId":"plain:unavail-1"');
        expect(events[0].text).not.toContain('"messageId"');
        expect(h.store.listUndelivered()).toEqual([]);
        h.relay.tick(); await micro();
        expect(await h.relay.pullPending('mcp')).toEqual([]);
        h.relay.stop();
    });

    it.each(['cursor-cli', 'kimi-cli', 'opencode-cli', 'grok-cli'])('delivers a multi-sentence final once with unverified final_adapter provenance for %s and never duplicates if native evidence later appears', async provider => {
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const full = 'Sentence one reports the Cursor coordinator status. Sentence two details the verification changes across modules. Sentence three confirms all unit and boundary checks passed. Sentence four concludes the 229-character report.';
        const h = harness({ body: full, completeness: 'final_adapter', source: 'final_adapter', parts: [{ at: NOW, chars: full.length }] });
        h.commit('plain:adapter-1');
        await vi.advanceTimersByTimeAsync(15_001);
        const events = await h.relay.pullPending('mcp');
        expect(events).toHaveLength(1);
        expect(events[0].text).toContain(full);
        expect(events[0].text).toContain('"source":"final_adapter"');
        expect(events[0].text).toContain('"verified":false');
        expect(events[0].text).toContain('"complete":true');
        expect(warn.mock.calls.filter(c => String(c[1]).includes('native relay capture unavailable'))).toHaveLength(0);
        expect(h.store.listUndelivered()).toEqual([]);
        expect(h.store.countUnrendered().total).toBe(0);

        // Later native evidence for the same attempt (even with an earlier wall-clock bubble timestamp) or orphan within quiet window must not duplicate.
        h.audit.mockResolvedValue([
            { meshId: 'mesh', sessionId: 'coord', attemptId: 'plain:adapter-1', messageAt: NOW - 1_500, text: full, chars: full.length, messageId: reportMessageId({ role: 'assistant', content: full }) },
            { meshId: 'mesh', sessionId: 'coord', attemptId: null, messageAt: NOW + 1_000, text: full, chars: full.length, messageId: reportMessageId({ role: 'assistant', content: full }) },
        ]);
        h.captures.mockResolvedValue({ body: full, completeness: 'final_native', source: provider, parts: [{ at: NOW - 1_500, chars: full.length }] });
        h.commit('plain:adapter-1');
        h.relay.tick(); await micro();
        expect(await h.relay.pullPending('mcp')).toEqual([]);
        expect(warn.mock.calls.filter(c => String(c[1]).includes('relay gap class='))).toHaveLength(0);
        h.relay.stop();
    });

    it('backs off once per capture step instead of re-running eight seconds and warnings every tick', async () => {
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const h = harness(); h.commit();
        await vi.advanceTimersByTimeAsync(RELAY_NATIVE_WAIT_MS + 1);
        const initialCalls = h.captures.mock.calls.length;
        for (let n = 0; n < 5; n++) { h.relay.tick(); await micro(); await h.relay.pullPending('mcp'); }
        expect(h.captures).toHaveBeenCalledTimes(initialCalls);
        await vi.advanceTimersByTimeAsync(RELAY_CAPTURE_BACKOFF_MS); h.relay.tick(); await micro();
        expect(h.captures).toHaveBeenCalledTimes(initialCalls + 1);
        for (let n = 0; n < 5; n++) { h.relay.tick(); await micro(); }
        expect(h.captures).toHaveBeenCalledTimes(initialCalls + 1);
        expect(warn.mock.calls.filter(c => String(c[1]).includes('retry scheduled with backoff'))).toHaveLength(2);
        h.relay.stop();
    });
});

describe('review: gap receipt and readability boundaries', () => {
    it('holds an unreadable reply silently: no standalone wake-up, counted in project_status, verdict cached', async () => {
        const h = harness(null, 'assistant'); h.state.ready = true;
        h.readable.mockResolvedValue(false); h.audit.mockResolvedValue([reply()]);
        h.relay.tick(); await micro(); await h.relay.idle();
        for (let n = 0; n < 3; n++) { h.relay.tick(); await micro(); await h.relay.idle(); }
        expect(h.submits).toEqual([]);
        expect(h.readable).toHaveBeenCalledTimes(1);
        expect(h.relay.missedReportsFor('mesh')).toBe(1);
        await vi.advanceTimersByTimeAsync(RELAY_READABILITY_CACHE_MS + 1); h.relay.tick(); await micro(); await h.relay.idle();
        expect(h.readable).toHaveBeenCalledTimes(2);
        expect(h.submits).toEqual([]);
        h.relay.stop();
    });

    it('announces a held reply once with its cursor when it becomes readable, even after a refused flush', async () => {
        const h = harness(null, 'assistant'); h.state.ready = true;
        h.readable.mockResolvedValue(false); h.audit.mockResolvedValue([reply()]);
        h.relay.tick(); await micro(); await h.relay.idle();
        expect(h.submits).toEqual([]);
        h.readable.mockResolvedValue(true); h.state.refuse = true;
        await vi.advanceTimersByTimeAsync(RELAY_READABILITY_CACHE_MS + 1); h.relay.tick(); await micro(); await h.relay.idle();
        const refused = h.submits.length; // every refused attempt carried the cursor but marked nothing notified
        expect(refused).toBeGreaterThan(0);
        expect(h.submits.every(text => text.includes(reportMessageId(raw)))).toBe(true);
        h.state.refuse = false; h.relay.tick(); await micro(); await h.relay.idle();
        const accepted = h.submits.length;
        expect(accepted).toBe(refused + 1);
        expect(h.submits[accepted - 1]).not.toContain('did not reach you'); // it is no longer a held/missed reply
        expect(h.relay.missedReportsFor('mesh')).toBe(0);
        for (let n = 0; n < 3; n++) { h.relay.tick(); await micro(); await h.relay.idle(); }
        expect(h.submits).toHaveLength(accepted);
        h.relay.stop();
    });

    it('does not let a notified attempt group swallow a reply that was unreadable then became readable', async () => {
        const h = harness(null, 'assistant'); h.state.ready = true;
        const later = { ...reply(), messageAt: NOW, messageId: 'b'.repeat(64), text: 'Later synthetic reply B.', chars: 24 };
        h.readable.mockImplementation(async (r: any) => r.messageId !== later.messageId);
        h.audit.mockResolvedValue([reply(), later]);
        h.relay.tick(); await micro(); await h.relay.idle();
        expect(h.submits).toHaveLength(1);
        expect(h.submits[0]).toContain(reportMessageId(raw)); expect(h.submits[0]).not.toContain(later.messageId);
        expect(h.relay.missedReportsFor('mesh')).toBe(1);
        h.readable.mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(RELAY_READABILITY_CACHE_MS + 1); h.relay.tick(); await micro(); await h.relay.idle();
        expect(h.submits).toHaveLength(2);
        expect(h.submits[1]).toContain(later.messageId);
        for (let n = 0; n < 3; n++) { h.relay.tick(); await micro(); await h.relay.idle(); }
        expect(h.submits).toHaveLength(2);
        h.relay.stop();
    });

    it.each(['timeout', 'throw'])('treats a probe %s as unknown, not unreadable: retried on backoff and announced once readable', async mode => {
        const h = harness(null, 'assistant'); h.state.ready = true;
        h.readable.mockImplementation(mode === 'timeout' ? () => new Promise(() => {}) : async () => { throw new Error('transient'); });
        h.audit.mockResolvedValue([reply()]);
        h.relay.tick(); await micro(); await vi.advanceTimersByTimeAsync(2_001); await h.relay.idle();
        expect(h.submits).toEqual([]);
        expect(h.readable).toHaveBeenCalledTimes(1);
        h.readable.mockResolvedValue(true);
        h.relay.tick(); await micro(); await h.relay.idle();
        expect(h.readable).toHaveBeenCalledTimes(1); // still inside the retry backoff, not the 5-minute cache
        await vi.advanceTimersByTimeAsync(RELAY_CAPTURE_BACKOFF_MS); h.relay.tick(); await micro(); await h.relay.idle();
        expect(h.readable).toHaveBeenCalledTimes(2);
        expect(h.submits).toHaveLength(1);
        expect(h.submits[0]).toContain(reportMessageId(raw));
        h.relay.stop();
    });

    it('stops watching a reply that stays unreadable past the hold: counted, never announced, queue drained', async () => {
        const h = harness(null, 'assistant'); h.state.ready = true;
        h.readable.mockResolvedValue(false); h.audit.mockResolvedValue([reply()]);
        h.relay.tick(); await micro(); await h.relay.idle();
        await vi.advanceTimersByTimeAsync(RELAY_UNREADABLE_HOLD_MS + 1); h.relay.tick(); await micro(); await h.relay.idle();
        h.readable.mockResolvedValue(true); // too late: the hold is bounded
        await vi.advanceTimersByTimeAsync(RELAY_READABILITY_CACHE_MS + 1); h.relay.tick(); await micro(); await h.relay.idle();
        expect(h.submits).toEqual([]);
        expect((h.relay as any).queue.filter((i: any) => i.kind === 'line')).toEqual([]);
        expect(h.relay.missedReportsFor('mesh')).toBe(1);
        h.relay.stop();
    });

    it('keeps MCP-only read, notification and counter receipts under the non-null caller', async () => {
        const h = harness(); const caller = 'mcp-assistant';
        h.store.recordCommitted({ attemptId: 'lost', meshId: 'mesh', coordinatorSessionId: 'coord', kind: 'relay', outcome: 'completed', committedAt: NOW });
        h.store.markDelivered(['lost'], NOW, []);
        h.relay.recordProjectRead({ coordinatorSessionId: 'coord', messages: [{ role: 'assistant', messageId: reportMessageId(raw),
            text: raw.content, totalChars: raw.content.length, complete: true }] }, caller);
        const other = { ...reply('plain:other'), messageId: 'b'.repeat(64), text: 'Synthetic other reply.', chars: 22 };
        h.audit.mockResolvedValue([reply(), other]); h.relay.tick(); await micro();
        const first = (await h.relay.pullPending(caller)).map(e => e.text).join('\n');
        expect(first).toContain(other.messageId); expect(first).not.toContain(reportMessageId(raw));
        expect(first).toContain('did not reach you');
        h.relay.tick(); await micro(); expect(await h.relay.pullPending(caller)).toEqual([]);
        h.audit.mockResolvedValue([{ ...other, attemptId: 'plain:third', messageId: 'c'.repeat(64) }]);
        h.relay.tick(); await micro();
        expect((await h.relay.pullPending(caller)).map(e => e.text).join('\n')).not.toContain('did not reach you');
        h.relay.stop();
    });

    it('only suppresses rows actually returned by a small native tail', async () => {
        const h = harness(); const a = reply(); const b = { ...reply(), messageAt: NOW, messageId: 'd'.repeat(64), text: 'Later row B.', chars: 12 };
        h.relay.recordProjectRead({ sourceComplete: true, coordinatorSessionId: 'coord', messages: [{ role: 'assistant', at: NOW,
            messageId: b.messageId, text: b.text, totalChars: b.text.length, complete: true }] }, 'mcp');
        h.audit.mockResolvedValue([a, b]); h.relay.tick(); await micro();
        const events = await h.relay.pullPending('mcp');
        expect(events[0].text).toContain(a.messageId);
        expect(events[0].text).not.toContain(b.messageId);
        expect(h.readable).toHaveBeenCalledTimes(1);
        h.relay.stop();
    });
});

it('caps automatic pages at three and supplies one exact cursor for the remaining report', async () => {
    const body = 'x'.repeat(RELAY_BODY_MAX_CHARS * 8) + 'Synthetic final suffix.';
    const h = harness({ body, completeness: 'final_native', parts: [{ at: NOW - 1_000, chars: body.length }] }); h.commit();
    await vi.advanceTimersByTimeAsync(15_001);
    const pages = [];
    for (let n = 0; n < 8; n++) pages.push(...await h.relay.pullPending('mcp'));
    expect(pages).toHaveLength(RELAY_MAX_AUTO_PAGES);
    expect(pages[2].text).toContain('[ADHDev relay continuation]');
    expect(pages[2].text).toContain(`"offset":${RELAY_MAX_AUTO_PAGES * RELAY_BODY_MAX_CHARS}`);
    expect(pages[2].text).toContain(reportBodyId(body));
    expect(pages.map(p => p.text).join('\n').match(/Automatic delivery stopped/g)).toHaveLength(1);
    expect(h.store.listUndelivered()).toEqual([]);
    expect(h.store.countUnrendered().total).toBe(0); // the continuation cursor makes it surfaced, not missed
    expect(h.relay.missedReportsFor('mesh')).toBe(0);
    expect(pages.map(p => p.text).join('\n')).not.toContain('did not reach you');
    const rest = pageAttemptReport(body, { attemptId: 'plain:a', coordinatorSessionId: 'coord', reportId: reportBodyId(body),
        offset: RELAY_MAX_AUTO_PAGES * RELAY_BODY_MAX_CHARS }, 'native_window');
    expect(rest.text).toBe(body.slice(RELAY_MAX_AUTO_PAGES * RELAY_BODY_MAX_CHARS, RELAY_MAX_AUTO_PAGES * RELAY_BODY_MAX_CHARS + 4000));
    h.relay.tick(); await micro(); expect(await h.relay.pullPending('mcp')).toEqual([]);
    h.relay.stop();
});

it.each(['memory', 'sqlite'])('heavy transcript reads cannot evict page cursors, notices or counters (%s)', kind => {
    const db = kind === 'sqlite' ? new Database(':memory:') : null;
    if (db) ensureAssistantRelaySchema(db);
    try {
        const store = db ? new SqliteAssistantRelayStore(db) : new InMemoryAssistantRelayStore();
        const tracker = new RelayGapTracker(store, () => NOW);
        store.writeReceipt('page-key', '4096', NOW, 'page');
        store.writeReceipt('counter-key', '3', NOW, 'counter');
        tracker.markNotified(reply(), 'mcp');
        const rows = Array.from({ length: RELAY_RECEIPT_CAPS.read + 10 }, (_, n) => ({ role: 'assistant',
            messageId: receiptKey('fixture', n), text: 'x', totalChars: 1, complete: true }));
        tracker.recordRead({ coordinatorSessionId: 'coord', messages: rows }, 'mcp');
        const ignored = [{ role: 'user', content: 'Synthetic user row.' }, { role: 'assistant', kind: 'thinking', content: 'Synthetic thinking row.' }];
        tracker.recordRead({ coordinatorSessionId: 'coord', ...compactTranscriptTail({ messages: ignored }, 10) }, 'mcp');
        for (const row of ignored) expect(store.readReceipt(receiptKey('read', 'mcp', 'coord', reportMessageId(row)), NOW)).toBeNull();
        expect(store.readReceipt('page-key', NOW)).toBe('4096');
        expect(store.readReceipt('counter-key', NOW)).toBe('3');
        expect(tracker.notified(reply(), 'mcp')).toBe(true);
                expect(rows.filter(row => store.readReceipt(receiptKey('read', 'mcp', 'coord', row.messageId), NOW) !== null)).toHaveLength(RELAY_RECEIPT_CAPS.read);
    } finally { db?.close(); }
});

it('migrates legacy receipts without losing existing notification and counter keys', () => {
    const db = new Database(':memory:');
    try {
        db.exec(`CREATE TABLE assistant_relay_receipts(receipt_key TEXT PRIMARY KEY,value TEXT NOT NULL,at_ms INTEGER NOT NULL);
            INSERT INTO assistant_relay_receipts VALUES('old-counter','2',${NOW})`);
        ensureAssistantRelaySchema(db); ensureAssistantRelaySchema(db);
        const store = new SqliteAssistantRelayStore(db);
        expect(store.readReceipt('old-counter', NOW)).toBe('2');
        store.writeReceipt('new-page', '8192', NOW, 'page');
        expect(db.prepare('SELECT kind FROM assistant_relay_receipts WHERE receipt_key=?').get('new-page')).toEqual({ kind: 'page' });
    } finally { db.close(); }
});


it('restores an available verified report after grace instead of replacing it with an unavailable notice', async () => {
    const body = 'Synthetic verified report restored from durable evidence.';
    const h = harness({ body, completeness: 'final_native' }); h.commit(); await micro();
    await vi.advanceTimersByTimeAsync(RELAY_NATIVE_WAIT_MS + RELAY_NATIVE_GRACE_MS + 1);
    (h.relay as any).attemptBodies.clear(); (h.relay as any).attemptMeta.clear();
    const pages = await h.relay.pullPending('mcp');
    expect(pages[0].text).toContain(body);
    expect(pages[0].text).not.toContain('native transcript unavailable');
    expect(h.store.countUnrendered().total).toBe(0);
    h.relay.stop();
});


it('does not submit anything when a readable verdict arrives after stop', async () => {
    const h = harness(null, 'assistant'); h.state.ready = true;
    let release: (v: boolean) => void = () => {};
    h.readable.mockImplementation(() => new Promise<boolean>(resolve => { release = resolve; }));
    h.audit.mockResolvedValue([reply()]); h.relay.tick(); await micro();
    expect(h.readable).toHaveBeenCalledTimes(1);
    h.relay.stop(); release(true); await micro(); await h.relay.idle();
    expect(h.submits).toEqual([]);
});
