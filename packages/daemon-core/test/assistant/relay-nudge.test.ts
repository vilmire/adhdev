import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantRelay } from '../../src/assistant/assistant-relay.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { buildRelayNudge, RELAY_NUDGE_MAX_CHARS, RELAY_NUDGE_BACKOFF_MS } from '../../src/assistant/assistant-relay-format.js';
import { ASSISTANT_FIXED_RULES } from '../../src/assistant/assistant-prompt.js';

const NOW = Date.parse('2026-10-27T06:00:00Z');
const BODY = 'Merged the fix and the full coordinator report body lives here.';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

type Submitted = { sid: string; text: string; messageId: string };
function harness(opts: { maxNudgeAttempts?: number; refuse?: (input: Submitted) => boolean } = {}) {
    let handler: (event: any) => void = () => {};
    const submitted: Submitted[] = [];
    const store = new InMemoryAssistantRelayStore();
    const relay = new AssistantRelay({
        subscribe: h => { handler = h; return () => {}; }, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'web-app',
        readCoordinatorTail: async () => null, rehydrateAttemptReport: async () => ({ body: BODY, completeness: 'final_native' as const }),
        meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => 'asst', isAssistantReady: () => true,
        submit: async (sid, input) => {
            const entry = { sid, text: input.text, messageId: input.messageId };
            if (opts.refuse?.(entry)) return { kind: 'refused', reason: 'not_ready' } as any;
            submitted.push(entry);
            return { kind: 'delivered' } as any;
        },
        inputLog: new AssistantInputLog(), store,
        ...(opts.maxNudgeAttempts !== undefined ? { maxNudgeAttempts: opts.maxNudgeAttempts } : {}),
    });
    relay.start(); relay.openThread('mesh');
    let n = 0;
    const commit = async () => {
        handler({ kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: `plain:${++n}`, generation: 0, at: Date.now(), outcome: 'completed' });
        await vi.advanceTimersByTimeAsync(15_001);
    };
    return { relay, store, submitted, commit };
}
const nudges = (s: Submitted[]) => s.filter(x => x.messageId.startsWith('nudge:'));
const full = (s: Submitted[]) => s.filter(x => !x.messageId.startsWith('nudge:'));

describe('assistant notice pull: a short nudge instead of the full relay push', () => {
    it('T1 sends a one-line nudge naming the project and keeps the relay queued for the pull', async () => {
        const h = harness();
        await h.commit();
        expect(full(h.submitted)).toEqual([]);
        const [nudge] = nudges(h.submitted);
        expect(nudge.text).toBe('[ADHDev notice] 1 update ready (web-app). Call projects or project_status to pull assistantEvents.');
        expect(nudge.text).not.toContain(BODY);
        expect(nudge.messageId).toMatch(/^nudge:relay:.+:1$/);
        expect(h.store.listUndelivered()).toHaveLength(1);
        h.relay.stop();
    });

    it('T2 the assistant pulls the full relay through assistantEvents, which settles it and resets the nudge', async () => {
        const h = harness();
        await h.commit();
        const pulled = await h.relay.pullPending('asst');
        expect(pulled.map(e => e.text).join('\n')).toContain(BODY);
        expect(h.store.listUndelivered()).toEqual([]);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(h.submitted).toHaveLength(1);
        await h.commit();
        expect(nudges(h.submitted).map(x => x.messageId.endsWith(':1'))).toEqual([true, true]);
        h.relay.stop();
    });

    it('T3 re-nudges on an exponential backoff, then falls back to the full push after the attempt cap', async () => {
        const h = harness();
        await h.commit();
        expect(nudges(h.submitted)).toHaveLength(1);
        // commit() returns 1 ms after the quiet window fired the first notice.
        await vi.advanceTimersByTimeAsync(RELAY_NUDGE_BACKOFF_MS - 2);
        expect(nudges(h.submitted)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(nudges(h.submitted)).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2 * RELAY_NUDGE_BACKOFF_MS);
        expect(nudges(h.submitted)).toHaveLength(3);
        expect(full(h.submitted)).toEqual([]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(nudges(h.submitted)).toHaveLength(3);
        expect(full(h.submitted)).toHaveLength(1);
        expect(full(h.submitted)[0].text).toContain(BODY);
        expect(h.store.listUndelivered()).toEqual([]);
        h.relay.stop();
    });

    it('T4 a refused nudge is not counted and arms no backoff', async () => {
        let refuse = true;
        const h = harness({ refuse: () => refuse });
        await h.commit();
        expect(h.submitted).toEqual([]);
        refuse = false;
        (h.relay as any).kick(); await vi.advanceTimersByTimeAsync(0);
        expect(nudges(h.submitted).map(x => x.messageId.endsWith(':1'))).toEqual([true]);
        h.relay.stop();
    });

    it('T5 maxNudgeAttempts 0 keeps the legacy full push', async () => {
        const h = harness({ maxNudgeAttempts: 0 });
        await h.commit();
        expect(nudges(h.submitted)).toEqual([]);
        expect(full(h.submitted)[0].text).toContain(BODY);
        h.relay.stop();
    });

    it('T6 one-line daemon inputs that are not relays are pushed as before', async () => {
        const h = harness();
        h.relay.enqueueInput({ source: 'first_run', text: 'Welcome note.', messageId: 'first-run:asst' });
        await vi.advanceTimersByTimeAsync(0);
        expect(h.submitted.map(x => x.text)).toEqual(['Welcome note.']);
        h.relay.stop();
    });

    it('T7 stop and a suppressing closeThread cancel the pending re-nudge', async () => {
        const h = harness();
        await h.commit();
        h.relay.closeThread('mesh', { suppressPending: true });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(h.submitted).toHaveLength(1);
        const h2 = harness();
        await h2.commit();
        h2.relay.stop();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(h2.submitted).toHaveLength(1);
    });

    it('T8 a pull racing the fallback push delivers the relay exactly once', async () => {
        let release!: () => void;
        const h = harness({ maxNudgeAttempts: 0 });
        const submit = (h.relay as any).ports.submit;
        (h.relay as any).ports.submit = async (sid: string, input: any) => { await new Promise<void>(r => { release = r; }); return submit(sid, input); };
        await h.commit();
        const pull = h.relay.pullPending('asst');
        release(); await vi.advanceTimersByTimeAsync(0);
        const pulled = await pull;
        const deliveries = full(h.submitted).length + pulled.filter(e => e.text.includes(BODY)).length;
        expect(deliveries).toBe(1);
        h.relay.stop();
    });
});

describe('buildRelayNudge', () => {
    it('stays a single bounded line and clips long project lists', () => {
        expect(buildRelayNudge({ count: 3, projects: [] })).toBe('[ADHDev notice] 3 updates ready. Call projects or project_status to pull assistantEvents.');
        const long = buildRelayNudge({ count: 2, projects: Array.from({ length: 30 }, (_, i) => `project-number-${i}`) });
        expect(Array.from(long).length).toBeLessThanOrEqual(RELAY_NUDGE_MAX_CHARS);
        expect(long).toContain('…)');
        expect(buildRelayNudge({ count: 1, projects: ['a\nb', '[ADHDev x]'] })).not.toMatch(/[\r\n]|\[ADHDev x/);
    });

    it('is listed as trusted daemon status in the assistant prompt', () => {
        const prompt = ASSISTANT_FIXED_RULES;
        expect(prompt).toContain('[ADHDev notice]');
        expect(prompt).toMatch(/On `\[ADHDev notice\]`, call `projects` or `project_status`/);
    });
});
