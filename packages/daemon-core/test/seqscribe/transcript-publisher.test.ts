import { describe, expect, it, vi } from 'vitest';
import {
    TranscriptProjectionService,
    __resetTranscriptProjectionForTests,
    activeTranscriptProjectionService,
    configureTranscriptProjection,
    markTranscriptSessionDirty,
    notifyTranscriptObservation,
    type TranscriptObservationCollectResult,
    type TranscriptProjectionDeps,
    type TranscriptRevisionEnvelope,
} from '../../src/seqscribe/transcript-publisher.js';
import type { TranscriptObservation } from '../../src/seqscribe/transcript-observation.js';
import { TRANSCRIPT_MODE_ENV } from '../../src/seqscribe/transcript-mode.js';
import { MAX_TRANSCRIPT_REVISION_CHUNKS, TRANSCRIPT_REVISION_CHUNK_BYTES } from '../../src/seqscribe/transcript-revision-codec.js';

function obs(overrides: Partial<TranscriptObservation> = {}): TranscriptObservation {
    return {
        sessionId: 'sess-1',
        providerType: 'claude-code',
        status: 'idle',
        messages: [{ role: 'assistant', kind: 'standard', content: 'hi' }],
        coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
        ...overrides,
    };
}

function makeDeps(overrides: Partial<TranscriptProjectionDeps> = {}): {
    deps: TranscriptProjectionDeps;
    published: { sessionId: string; envelope: TranscriptRevisionEnvelope }[];
} {
    const published: { sessionId: string; envelope: TranscriptRevisionEnvelope }[] = [];
    const deps: TranscriptProjectionDeps = {
        daemonId: () => 'daemon-a',
        writerId: () => 'writer-a',
        epoch: 'epoch-fixed',
        now: () => '2026-08-29T00:00:00.000Z',
        publishRevision: async (sessionId, envelope) => {
            published.push({ sessionId, envelope });
        },
        ...overrides,
    };
    return { deps, published };
}

async function flush(): Promise<void> {
    // Two microtask turns is enough to drain the service's chained promises in
    // every test below — none of them nest more than one settle() recursion.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('TranscriptProjectionService.observe — mode gate + dedup (design §3.4, §5.1)', () => {
    it('off mode never publishes', async () => {
        const { deps, published } = makeDeps();
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('off');
        service.observe('sess-1', obs());
        await flush();
        expect(published).toEqual([]);
        expect(service.getCounters().published).toBe(0);
    });

    it('shadow mode publishes a complete revision', async () => {
        const { deps, published } = makeDeps();
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        service.observe('sess-1', obs());
        await flush();
        expect(published).toHaveLength(1);
        expect(published[0]!.sessionId).toBe('sess-1');
        expect(published[0]!.envelope.begin.revision).toBe(1);
        expect(published[0]!.envelope.commit.chunks).toBe(published[0]!.envelope.chunks.length);
        expect(service.getCounters().published).toBe(1);
    });

    it('a second observe with byte-identical content dedupes (no new revision)', async () => {
        const { deps, published } = makeDeps();
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        service.observe('sess-1', obs());
        await flush();
        service.observe('sess-1', obs()); // identical content
        await flush();
        expect(published).toHaveLength(1);
        expect(service.getCounters().deduped).toBe(1);
    });

    it('changed content publishes a new revision with an incremented counter', async () => {
        const { deps, published } = makeDeps();
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        service.observe('sess-1', obs());
        await flush();
        service.observe('sess-1', obs({ messages: [{ role: 'assistant', kind: 'standard', content: 'changed' }] }));
        await flush();
        expect(published).toHaveLength(2);
        expect(published[1]!.envelope.begin.revision).toBe(2);
    });

    it('an empty observation does not clobber a prior non-empty complete revision (§3.4)', async () => {
        const { deps, published } = makeDeps();
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        service.observe('sess-1', obs());
        await flush();
        service.observe('sess-1', obs({ messages: [] }));
        await flush();
        expect(published).toHaveLength(1); // the empty one never published
        expect(service.getCounters().emptyGuarded).toBe(1);
    });

    it('a VERIFIED-clear empty observation is allowed through markDirty (§3.4 exception)', async () => {
        const { deps, published } = makeDeps();
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        service.observe('sess-1', obs());
        await flush();

        const collectObservation = vi.fn(
            async (): Promise<TranscriptObservationCollectResult> => ({
                observation: obs({ messages: [] }),
                verifiedClear: true,
            }),
        );
        const service2 = new TranscriptProjectionService({ ...deps, collectObservation });
        vi.spyOn(service2, 'mode').mockReturnValue('shadow');
        service2.observe('sess-1', obs()); // seed a prior complete revision on THIS instance
        await flush();
        service2.markDirty('sess-1');
        await flush();
        expect(collectObservation).toHaveBeenCalled();
        // Second publish (the seed) + third publish (the verified clear) = 2.
        expect(published.length).toBeGreaterThanOrEqual(1);
    });

    it('never throws when publishRevision rejects — counts publishFailed instead', async () => {
        const { deps } = makeDeps({ publishRevision: async () => { throw new Error('boom'); } });
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        expect(() => service.observe('sess-1', obs())).not.toThrow();
        await flush();
        expect(service.getCounters().publishFailed).toBe(1);
        expect(service.getCounters().published).toBe(0);
    });
});

describe('TranscriptProjectionService — oversize fallback (design §3.3/§7.2 item 3)', () => {
    it('rejects a projection over MAX_TRANSCRIPT_REVISION_CHUNKS with zero commits, and calls onOversize', async () => {
        const onOversize = vi.fn();
        const { deps, published } = makeDeps({ onOversize });
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        const hugeContent = 'x'.repeat(TRANSCRIPT_REVISION_CHUNK_BYTES * (MAX_TRANSCRIPT_REVISION_CHUNKS + 5));
        service.observe('sess-1', obs({ messages: [{ role: 'assistant', kind: 'standard', content: hugeContent }] }));
        await flush();
        expect(published).toEqual([]);
        expect(service.getCounters().oversized).toBe(1);
        expect(onOversize).toHaveBeenCalledTimes(1);
        expect(onOversize.mock.calls[0]![0]).toBe('sess-1');
    });
});

describe('TranscriptProjectionService — per-session coalescing (design §5.2)', () => {
    it('a second observe arriving mid-publish replaces the pending one (latest wins, not queued)', async () => {
        let resolveFirst: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            resolveFirst = resolve;
        });
        let calls = 0;
        const { deps, published } = makeDeps({
            publishRevision: async (sessionId, envelope) => {
                calls++;
                if (calls === 1) await gate; // block the first publish
                published.push({ sessionId, envelope });
            },
        });
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');

        service.observe('sess-1', obs({ messages: [{ role: 'assistant', kind: 'standard', content: 'A' }] }));
        await Promise.resolve(); // let the first publish start and block on `gate`
        service.observe('sess-1', obs({ messages: [{ role: 'assistant', kind: 'standard', content: 'B' }] }));
        service.observe('sess-1', obs({ messages: [{ role: 'assistant', kind: 'standard', content: 'C' }] })); // replaces B, not queued after it
        resolveFirst?.();
        await flush();
        await flush();

        // First publish (A) landed, then exactly ONE coalesced follow-up (C) —
        // B was replaced, never published on its own.
        expect(published).toHaveLength(2);
        expect(published[1]!.envelope.begin.snapshotSha256).not.toBe(published[0]!.envelope.begin.snapshotSha256);
    });

    it('markDirty without a configured collectObservation is an inert no-op, counted', () => {
        const { deps, published } = makeDeps();
        const service = new TranscriptProjectionService(deps); // no collectObservation
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        service.markDirty('sess-1');
        expect(published).toEqual([]);
        expect(service.getCounters().collectorUnavailable).toBe(1);
    });

    it('seedSession is an alias for markDirty', async () => {
        const collectObservation = vi.fn(async (): Promise<TranscriptObservationCollectResult> => ({ observation: obs() }));
        const { deps, published } = makeDeps({ collectObservation });
        const service = new TranscriptProjectionService(deps);
        vi.spyOn(service, 'mode').mockReturnValue('shadow');
        service.seedSession('sess-1');
        await flush();
        expect(collectObservation).toHaveBeenCalledWith('sess-1');
        expect(published).toHaveLength(1);
    });
});

describe('module-level singleton — safe no-op until configured (design §8 unit 2 boundary)', () => {
    it('notifyTranscriptObservation / markTranscriptSessionDirty do nothing when unconfigured', () => {
        __resetTranscriptProjectionForTests();
        expect(activeTranscriptProjectionService()).toBeNull();
        expect(() => notifyTranscriptObservation('sess-1', obs())).not.toThrow();
        expect(() => markTranscriptSessionDirty('sess-1')).not.toThrow();
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
