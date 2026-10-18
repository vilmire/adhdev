import { describe, expect, it, vi } from 'vitest';
import { AssistantDigestScheduler, DEFAULT_DIGEST_HOUR, DIGEST_INPUT_TEXT, type AssistantDigestPorts } from '../../src/assistant/assistant-digest-scheduler.js';
import { normalizeAssistantRegistryEntry } from '../../src/assistant/assistant-registry.js';

/** Daily digest (2026-10-18): one three-line summary per local day, at a set hour. */
function ports(over: Partial<AssistantDigestPorts> = {}) {
    const enqueued: unknown[] = [];
    let last: number | null = null;
    const p: AssistantDigestPorts = {
        liveSessionId: () => 'asst',
        isReady: () => true,
        modalOpen: () => false,
        digestHour: () => undefined,
        lastDigestAt: () => last,
        followsProjects: () => true,
        relayBusy: () => false,
        enqueue: (i) => { enqueued.push(i); },
        recordDigest: (at) => { last = at; },
        ...over,
    };
    return { p, enqueued };
}
const at = (h: number, day = 18) => new Date(2026, 9, day, h, 5).getTime();

describe('AssistantDigestScheduler', () => {
    it('fires once at the default hour and not again the same day, but again the next day', () => {
        const { p, enqueued } = ports();
        const s = new AssistantDigestScheduler(p);
        expect(s.evaluate(at(DEFAULT_DIGEST_HOUR - 1))).toEqual({ fired: false, reason: 'not_the_hour' });
        expect(s.evaluate(at(DEFAULT_DIGEST_HOUR)).fired).toBe(true);
        expect(s.evaluate(at(DEFAULT_DIGEST_HOUR) + 60_000)).toEqual({ fired: false, reason: 'already_today' });
        expect(s.evaluate(at(DEFAULT_DIGEST_HOUR, 19)).fired).toBe(true);
        expect(enqueued).toHaveLength(2);
        expect(enqueued[0]).toMatchObject({ source: 'digest', text: DIGEST_INPUT_TEXT, forSessionId: 'asst' });
    });

    it('respects a set hour, off, and waits for a ready, idle assistant that follows something', () => {
        expect(new AssistantDigestScheduler(ports({ digestHour: () => 18 }).p).evaluate(at(18)).fired).toBe(true);
        expect(new AssistantDigestScheduler(ports({ digestHour: () => null }).p).evaluate(at(9))).toEqual({ fired: false, reason: 'off' });
        expect(new AssistantDigestScheduler(ports({ liveSessionId: () => null }).p).evaluate(at(9))).toEqual({ fired: false, reason: 'no_session' });
        expect(new AssistantDigestScheduler(ports({ isReady: () => false }).p).evaluate(at(9))).toEqual({ fired: false, reason: 'not_ready' });
        expect(new AssistantDigestScheduler(ports({ followsProjects: () => false }).p).evaluate(at(9))).toEqual({ fired: false, reason: 'nothing_followed' });
        const recordDigest = vi.fn();
        expect(new AssistantDigestScheduler(ports({ relayBusy: () => true, recordDigest }).p).evaluate(at(9))).toEqual({ fired: false, reason: 'busy' });
        expect(recordDigest).not.toHaveBeenCalled();
    });

    it('the registry keeps digestHour (number or null) and lastDigestAt, and drops a bad hour', () => {
        const base = { cliType: 'claude-cli', workspace: '/w', createdAt: 1 };
        expect(normalizeAssistantRegistryEntry({ ...base, digestHour: 7, lastDigestAt: 5 })).toMatchObject({ digestHour: 7, lastDigestAt: 5 });
        expect(normalizeAssistantRegistryEntry({ ...base, digestHour: null })).toMatchObject({ digestHour: null });
        expect(normalizeAssistantRegistryEntry({ ...base, digestHour: 24 })).not.toHaveProperty('digestHour');
    });
});
