import { describe, expect, it, vi } from 'vitest';
import {
    TranscriptProjectionService,
    type TranscriptProjectionDeps,
} from '../../src/seqscribe/transcript-publisher.js';
import type { TranscriptObservation } from '../../src/seqscribe/transcript-observation.js';

/**
 * Regression: `runPull` counted a THROWING `collectObservation` and a clean
 * "nothing new" as the same thing — both just bumped `sourcePending`.
 *
 * That conflation was load-bearing in the wrong direction. The internal
 * collector (`boot/daemon-lifecycle.ts`) returns null on its HEALTHY path too,
 * because the read's own choke point pushes the observation nested and
 * `settle()` publishes it after the pull returns. So `sourcePending` rising is
 * the normal steady state of a working daemon — meaning a collect leg that
 * failed on EVERY tick produced a counter trace identical to an idle session,
 * and the swallowed exception left no log line either. There was no observable
 * distinction between "healthy and quiet" and "completely broken".
 *
 * `collectFailed` is the split-out signal, mirroring how `publishFailed` is
 * kept separate from `published`. Revert either half of the fix — the
 * `catch`/`collectThrew` branch in `runPull`, or the `throw error` rethrow in
 * the lifecycle collector — and the first two cases below go red.
 */
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

function makeService(collect: TranscriptProjectionDeps['collectObservation']): TranscriptProjectionService {
    const deps: TranscriptProjectionDeps = {
        daemonId: () => 'daemon-a',
        writerId: () => 'writer-a',
        epoch: 'epoch-fixed',
        now: () => '2026-08-29T00:00:00.000Z',
        publishRevision: async () => {},
        collectObservation: collect,
    };
    const service = new TranscriptProjectionService(deps);
    vi.spyOn(service, 'mode').mockReturnValue('on');
    return service;
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('transcript projection — collect failure is counted apart from source-pending', () => {
    it('★ a THROWING collector bumps collectFailed and NOT sourcePending', async () => {
        const service = makeService(async () => {
            throw new Error('internal read_chat exploded');
        });

        service.markDirty('sess-1');
        await flush();

        const counters = service.getCounters();
        expect(counters.collectFailed).toBe(1);
        // Before the fix this was 1 — a broken collect leg was indistinguishable
        // from a healthy idle pull.
        expect(counters.sourcePending).toBe(0);
    });

    it('★ a collector returning null still bumps only sourcePending', async () => {
        const service = makeService(async () => null);

        service.markDirty('sess-1');
        await flush();

        const counters = service.getCounters();
        expect(counters.sourcePending).toBe(1);
        expect(counters.collectFailed).toBe(0);
    });

    it('a throwing collector is still non-fatal — the session is not wedged for the next tick', async () => {
        let shouldThrow = true;
        let calls = 0;
        const service = makeService(async () => {
            calls++;
            if (shouldThrow) throw new Error('transient failure');
            return { observation: obs() };
        });

        // Must not throw synchronously: the pull loop is best-effort, and the
        // `finally` in `runPull` still has to reach `settle()`.
        expect(() => service.markDirty('sess-1')).not.toThrow();
        await flush();
        expect(service.getCounters().collectFailed).toBe(1);

        // The load-bearing recovery property: `settle()` ran despite the throw,
        // so `inFlight` was cleared and a subsequent trigger is admitted and
        // reaches the collector again. (If the throw had escaped `runPull`'s
        // `finally`, this second call would never happen.)
        shouldThrow = false;
        service.markDirty('sess-1');
        await flush();
        expect(calls).toBe(2);
        expect(service.getCounters().collectFailed).toBe(1);
    });

    it('counters start at zero for both fields', () => {
        const service = makeService(async () => null);
        const counters = service.getCounters();
        expect(counters.collectFailed).toBe(0);
        expect(counters.sourcePending).toBe(0);
    });
});
