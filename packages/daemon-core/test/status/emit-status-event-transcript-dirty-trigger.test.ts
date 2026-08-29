/**
 * §8 unit 3 dirty trigger — design §5.2's "status-change/finalizing hook".
 *
 * `emitStatusEvent` (status/reporter.ts) is the per-session status transition
 * surface with a real `targetSessionId` in hand (`agent:generating_started`,
 * `agent:waiting_approval`, `agent:waiting_choice`, `agent:generating_completed`
 * — the finalizing→terminal edge — `agent:stopped`, `monitor:no_progress`).
 * §8 unit 2 wired `markChatOutputActivity` (PTY output) as the only dirty
 * trigger; this unit adds the status-transition one, since a session can
 * change status with no new output byte (e.g. `generating_completed`, or a
 * modal appearing with no new stdout).
 */
import { describe, expect, it, vi } from 'vitest';
import { DaemonStatusReporter } from '../../src/status/reporter.js';
import {
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
} from '../../src/seqscribe/transcript-publisher.js';

function createReporter() {
    const sendMessage = vi.fn();
    const sendStatusEvent = vi.fn();
    const reporter = new DaemonStatusReporter({
        serverConn: { isConnected: () => true, sendMessage, getUserPlan: () => 'pro' },
        cdpManagers: new Map(),
        p2p: {
            isConnected: true,
            isAvailable: true,
            connectionState: 'connected',
            connectedPeerCount: 1,
            screenshotActive: false,
            sendStatus: vi.fn(),
            sendStatusEvent,
        },
        providerLoader: { resolve: () => null, getAll: () => [] },
        detectedIdes: [],
        instanceId: 'daemon-1',
        daemonVersion: '0.0.0-test',
        instanceManager: { collectAllStates: () => [], collectStatesByCategory: () => [], getInstance: () => undefined },
        getScreenshotUsage: () => null,
    } as any);
    return reporter;
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('emitStatusEvent — marks the target session dirty for transcript projection', () => {
    it('agent:generating_completed (the finalizing→terminal edge) triggers markDirty for targetSessionId', async () => {
        __resetTranscriptProjectionForTests();
        const collectObservation = vi.fn().mockResolvedValue(null);
        const service = configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation,
        });
        expect(service).not.toBeNull();

        const reporter = createReporter();
        reporter.emitStatusEvent({ event: 'agent:generating_completed', targetSessionId: 'sess-1', providerType: 'claude-cli' });
        await flush();

        expect(collectObservation).toHaveBeenCalledWith('sess-1');
    });

    it('an event with no targetSessionId does not call markDirty for anything', async () => {
        __resetTranscriptProjectionForTests();
        const collectObservation = vi.fn().mockResolvedValue(null);
        configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation,
        });

        const reporter = createReporter();
        reporter.emitStatusEvent({ event: 'agent:stopped' });
        await flush();

        expect(collectObservation).not.toHaveBeenCalled();
    });

    it('a provider:* event (dropped by buildServerStatusEvent) never reaches markDirty', async () => {
        __resetTranscriptProjectionForTests();
        const collectObservation = vi.fn().mockResolvedValue(null);
        configureTranscriptProjection({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            publishRevision: async () => {},
            collectObservation,
        });

        const reporter = createReporter();
        reporter.emitStatusEvent({ event: 'provider:something', targetSessionId: 'sess-1' });
        await flush();

        expect(collectObservation).not.toHaveBeenCalled();
    });

    it('is a safe no-op when the projection service is unconfigured', async () => {
        __resetTranscriptProjectionForTests();
        const reporter = createReporter();
        expect(() => reporter.emitStatusEvent({ event: 'agent:waiting_approval', targetSessionId: 'sess-1' })).not.toThrow();
    });
});
