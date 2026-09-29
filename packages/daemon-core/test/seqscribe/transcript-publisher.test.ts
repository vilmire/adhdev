import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    TRANSCRIPT_PTY_DIRTY_THROTTLE_MS,
    TranscriptProjectionService,
    __resetTranscriptProjectionForTests,
    activeTranscriptProjectionService,
    configureTranscriptProjection,
    markTranscriptSessionDirty,
    notifyTranscriptObservation,
    requestTranscriptBaseFrame,
    type TranscriptObservationCollectResult,
    type TranscriptProjectionDeps,
} from '../../src/seqscribe/transcript-publisher.js';
import type { KeyedChatFrame } from '../../src/seqscribe/transcript-keyed-frame.js';
import { CHAT_COMMIT_KIND, CHAT_DEL_KIND, CHAT_MSG_KIND } from '../../src/seqscribe/transcript-keyed-codec.js';
import type { TranscriptObservation } from '../../src/seqscribe/transcript-observation.js';

/**
 * `TranscriptProjectionService` over the keyed chat lane (design 2026-09-28):
 * "unchanged writes nothing", empty-guard, failure → re-diff,
 * coalescing, the fixed PTY window, the tripwire and base requests.
 */

function msg(id: string, content: string, ord = 'a0') {
    return { messageId: id, ord, role: 'assistant', kind: 'standard', content };
}

function obs(overrides: Partial<TranscriptObservation> = {}): TranscriptObservation {
    return {
        sessionId: 'sess-1',
        providerType: 'claude-code',
        status: 'idle',
        messages: [msg('d.t.1', 'hi')],
        coverage: { mode: 'full', omittedBefore: false },
        ...overrides,
    };
}

function makeDeps(overrides: Partial<TranscriptProjectionDeps> = {}): {
    deps: TranscriptProjectionDeps;
    published: { sessionId: string; frame: KeyedChatFrame }[];
} {
    const published: { sessionId: string; frame: KeyedChatFrame }[] = [];
    const deps: TranscriptProjectionDeps = {
        daemonId: () => 'daemon-a',
        writerId: () => 'writer-a',
        epoch: 'epoch-fixed',
        now: () => '2026-09-28T00:00:00.000Z',
        appendChatFrame: async (sessionId, frame) => {
            published.push({ sessionId, frame });
        },
        ...overrides,
    };
    return { deps, published };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Keyed publishing is always on — this only names the construction. */
function publisher(service: TranscriptProjectionService): TranscriptProjectionService {
    return service;
}

afterEach(() => {
    delete process.env.ADHDEV_TRANSCRIPT_TRIPWIRE;
});

describe('TranscriptProjectionService.observe — changed-only frames', () => {
    it('publishes one frame: head + meta + commit', async () => {
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs());
        await flush();
        expect(published).toHaveLength(1);
        expect(published[0]!.frame.rows.map((r) => r.kind)).toEqual([CHAT_MSG_KIND, 'chat.meta.v2', CHAT_COMMIT_KIND]);
        expect(published[0]!.frame.commit).toMatchObject({ sessionId: 'sess-1', writer: 'writer-a', producerDaemonId: 'daemon-a', epoch: 'epoch-fixed', frame: 1 });
        const counters = service.getCounters();
        expect(counters.published).toBe(1);
        expect(counters.chatRowsWritten).toBe(3);
        expect(counters.chatBytesWritten).toBeGreaterThan(0);
    });

    it('an unchanged observation writes nothing (deduped)', async () => {
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs());
        await flush();
        service.observe('sess-1', obs());
        await flush();
        expect(published).toHaveLength(1);
        expect(service.getCounters().deduped).toBe(1);
    });

    it('a changed bubble publishes a frame carrying only that bubble', async () => {
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs({ messages: [msg('d.t.1', 'hi'), msg('d.t.2', 'there', 'a1')] }));
        await flush();
        service.observe('sess-1', obs({ messages: [msg('d.t.1', 'hi'), msg('d.t.2', 'there!', 'a1')] }));
        await flush();
        expect(published).toHaveLength(2);
        expect(published[1]!.frame.rows.map((r) => r.key)).toEqual(['m:d.t.2', 'commit']);
    });

    it('an empty observation does not clobber published bubbles', async () => {
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs());
        await flush();
        service.observe('sess-1', obs({ messages: [] }));
        await flush();
        expect(published).toHaveLength(1);
        expect(service.getCounters().emptyGuarded).toBe(1);
    });

    it('a VERIFIED clear tombstones every bubble', async () => {
        const collectObservation = vi.fn(
            async (): Promise<TranscriptObservationCollectResult> => ({ observation: obs({ messages: [] }), verifiedClear: true }),
        );
        const { deps, published } = makeDeps({ collectObservation });
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs());
        await flush();
        service.markDirty('sess-1');
        await flush();
        expect(published).toHaveLength(2);
        expect(published[1]!.frame.rows.map((r) => r.kind)).toEqual([CHAT_DEL_KIND, CHAT_COMMIT_KIND]);
        expect(published[1]!.frame.commit.liveCount).toBe(0);
    });

    it('an observation without message ids is refused, not published', async () => {
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs({ messages: [{ role: 'assistant', content: 'no id' }] }));
        await flush();
        expect(published).toEqual([]);
        expect(service.getCounters().unidentified).toBe(1);
    });

    it('a failed append is counted and the next frame re-diffs against the topic (restore), never trusting the lost frame', async () => {
        let fail = true;
        const readPersistedChat = vi.fn(() => ({ committed: [], torn: [] }));
        const { deps, published } = makeDeps({
            readPersistedChat,
            appendChatFrame: async (sessionId, frame) => {
                if (fail) throw new Error('boom');
                published.push({ sessionId, frame });
            },
        });
        const service = publisher(new TranscriptProjectionService(deps));
        expect(() => service.observe('sess-1', obs())).not.toThrow();
        await flush();
        expect(service.getCounters().publishFailed).toBe(1);
        fail = false;
        service.observe('sess-1', obs());
        await flush();
        // Nothing landed the first time, so the SAME content is written again.
        expect(published).toHaveLength(1);
        expect(readPersistedChat).toHaveBeenCalledTimes(2);
    });
});

describe('TranscriptProjectionService — tripwire and base frames (§8.2c, §4.10)', () => {
    const many = (text: (i: number) => string) =>
        Array.from({ length: 12 }, (_, i) => msg(`d.t.${i}`, text(i), `a${i.toString(36).padStart(3, '0')}`));

    it('production: a mass-rewrite delta frame is published and counted unexpected', async () => {
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs({ messages: many((i) => `a${i}`) }));
        await flush();
        service.observe('sess-1', obs({ messages: many((i) => `b${i}`) }));
        await flush();
        expect(published).toHaveLength(2);
        expect(service.getCounters().chatBaseFrames.unexpected).toBe(1);
    });

    it('armed (ADHDEV_TRANSCRIPT_TRIPWIRE=throw): the same frame is refused', async () => {
        process.env.ADHDEV_TRANSCRIPT_TRIPWIRE = 'throw';
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs({ messages: many((i) => `a${i}`) }));
        await flush();
        service.observe('sess-1', obs({ messages: many((i) => `b${i}`) }));
        await flush();
        expect(published).toHaveLength(1);
        expect(service.getCounters().chatTripwireRefused).toBe(1);
    });

    it('requestBase makes the next frame a resync_request base frame', async () => {
        const collectObservation = vi.fn(async (): Promise<TranscriptObservationCollectResult> => ({ observation: obs() }));
        const { deps, published } = makeDeps({ collectObservation });
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs());
        await flush();
        service.requestBase('sess-1');
        await flush();
        expect(published).toHaveLength(2);
        expect(published[1]!.frame.commit).toMatchObject({ basis: 'base', baseReason: 'resync_request' });
        expect(service.getCounters().chatBaseFrames.resync_request).toBe(1);
    });
});

describe('TranscriptProjectionService — per-session coalescing', () => {
    it('a second observe arriving mid-publish replaces the pending one (latest wins, not queued)', async () => {
        let resolveFirst: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
        let calls = 0;
        const { deps, published } = makeDeps({
            appendChatFrame: async (sessionId, frame) => {
                calls++;
                if (calls === 1) await gate;
                published.push({ sessionId, frame });
            },
        });
        const service = publisher(new TranscriptProjectionService(deps));
        service.observe('sess-1', obs({ messages: [msg('d.t.1', 'A')] }));
        await Promise.resolve();
        service.observe('sess-1', obs({ messages: [msg('d.t.1', 'B')] }));
        service.observe('sess-1', obs({ messages: [msg('d.t.1', 'C')] }));
        resolveFirst?.();
        await flush();
        await flush();
        expect(published).toHaveLength(2);
        const second = published[1]!.frame.rows[0]!.payload as { body: { text: string } };
        expect(second.body.text).toBe('C');
    });

    it('markDirty without a configured collectObservation is an inert no-op, counted', () => {
        const { deps, published } = makeDeps();
        const service = publisher(new TranscriptProjectionService(deps));
        service.markDirty('sess-1');
        expect(published).toEqual([]);
        expect(service.getCounters().collectorUnavailable).toBe(1);
    });

    it('seedSession is an alias for markDirty', async () => {
        const collectObservation = vi.fn(async (): Promise<TranscriptObservationCollectResult> => ({ observation: obs() }));
        const { deps, published } = makeDeps({ collectObservation });
        const service = publisher(new TranscriptProjectionService(deps));
        service.seedSession('sess-1');
        await flush();
        expect(collectObservation).toHaveBeenCalledWith('sess-1');
        expect(published).toHaveLength(1);
    });

    it('the PTY trailing window is FIXED at the throttle, whatever the transcript size (§7.1)', async () => {
        vi.useFakeTimers();
        try {
            const pulls: number[] = [];
            const { deps } = makeDeps({
                collectObservation: async () => {
                    pulls.push(Date.now());
                    return { observation: obs({ messages: [msg('d.t.1', `${'x'.repeat(2 * 1024 * 1024)}${pulls.length}`)] }) };
                },
            });
            const service = publisher(new TranscriptProjectionService(deps));
            const drain = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
            service.markPtyOutputActivity('sess-1');
            await drain();
            service.markPtyOutputActivity('sess-1');
            await vi.advanceTimersByTimeAsync(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
            await drain();
            service.markPtyOutputActivity('sess-1');
            await vi.advanceTimersByTimeAsync(TRANSCRIPT_PTY_DIRTY_THROTTLE_MS);
            await drain();
            // v1 stretched this to ~2.3 s for a 2 MiB transcript; keyed stays at 350 ms.
            expect(pulls).toHaveLength(3);
            service.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('module-level singleton — safe no-op until configured', () => {
    it('notify / markDirty / requestTranscriptBaseFrame do nothing when unconfigured', () => {
        __resetTranscriptProjectionForTests();
        expect(activeTranscriptProjectionService()).toBeNull();
        expect(() => notifyTranscriptObservation('sess-1', obs())).not.toThrow();
        expect(() => markTranscriptSessionDirty('sess-1')).not.toThrow();
        expect(requestTranscriptBaseFrame('sess-1')).toBe(false);
    });

    it('configureTranscriptProjection(null) disarms a previously-armed service', async () => {
        const { deps, published } = makeDeps();
        configureTranscriptProjection(deps);
        expect(activeTranscriptProjectionService()).not.toBeNull();
        configureTranscriptProjection(null);
        expect(activeTranscriptProjectionService()).toBeNull();
        notifyTranscriptObservation('sess-1', obs());
        await flush();
        expect(published).toEqual([]);
        __resetTranscriptProjectionForTests();
    });
});
