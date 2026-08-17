import { describe, expect, it } from 'vitest';
import { DaemonStatusReporter, SERVER_DEDUP_KEEPALIVE_REPORTS } from '../../src/status/reporter.js';

/**
 * The P2P transport cost counters must not defeat the idle dedup.
 *
 * Two features meet in `wsHash`, which is computed over the whole cloud payload
 * — `p2p` included:
 *
 *   - idle dedup suppresses byte-identical periodic reports, because each report
 *     is a UserSessionDO request on the account axis nearest its limit;
 *   - the direct/relay counters ride that same `p2p` object.
 *
 * If the counters moved on every report the hash would differ every time and
 * suppression would never engage — silently undoing the saving. They are safe
 * only because they change on CONNECTION EVENTS, not on a timer: an idle machine
 * re-reports the same tallies, so the payload stays byte-identical.
 *
 * These tests pin that property. If someone later makes a counter time-derived
 * (a rate, an "ms since last relay", a rolling window), these turn red — which
 * is the point.
 */

interface SentMessage { type: string; data: any }

/** `stats` is read on every report, so a test can move the counters mid-run. */
function makeReporter(stats: { value: Record<string, number> | undefined }) {
    const sent: SentMessage[] = [];
    const reporter = new DaemonStatusReporter(
        {
            serverConn: {
                isConnected: () => true,
                sendMessage: (type, data) => { sent.push({ type, data }); },
                getUserPlan: () => 'pro',
            },
            cdpManagers: new Map(),
            p2p: {
                isConnected: true,
                isAvailable: true,
                connectionState: 'connected',
                connectedPeerCount: 1,
                screenshotActive: false,
                get transportStats() { return stats.value as any; },
                sendStatus: () => {},
                sendStatusEvent: () => {},
            },
            providerLoader: { resolve: () => undefined, getAll: () => [] },
            detectedIdes: [],
            instanceId: 'inst-1',
            daemonVersion: '1.0.0',
            instanceManager: {
                collectAllStates: () => ([{
                    category: 'cli',
                    type: 'claude-cli',
                    status: 'idle',
                    sessions: [{ id: 'sess-1', providerType: 'claude-cli', status: 'idle', transport: 'pty', kind: 'agent' }],
                } as any]),
                collectStatesByCategory: () => [],
            },
        },
        { logFn: () => {} },
    );
    return { reporter, statusReports: () => sent.filter((m) => m.type === 'status_report') };
}

const STABLE = { direct: 1, relay: 0, unknownTransport: 0, directTotal: 4, relayTotal: 2 };

describe('transport counters vs idle dedup', () => {
    it('an idle daemon with stable counters is still deduped', async () => {
        const stats = { value: { ...STABLE } };
        const { reporter, statusReports } = makeReporter(stats);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        // No connection events occurred — the counters are unchanged, so these
        // periodic reports must be suppressed exactly as before the counters existed.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        expect(
            statusReports(),
            'stable counters must not change the hash and must not defeat dedup',
        ).toHaveLength(1);
    });

    it('keeps the full keepalive budget — counters do not shorten suppression', async () => {
        const stats = { value: { ...STABLE } };
        const { reporter, statusReports } = makeReporter(stats);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        // Exactly the number of suppressions the keepalive allows.
        for (let i = 0; i < SERVER_DEDUP_KEEPALIVE_REPORTS - 1; i++) {
            await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        }
        expect(statusReports(), 'suppression window must be unaffected').toHaveLength(1);

        // The next one is the bounded keepalive.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(2);
    });

    it('a real relay fallback transmits immediately, without waiting for keepalive', async () => {
        const stats = { value: { ...STABLE } };
        const { reporter, statusReports } = makeReporter(stats);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        // A connection fell back to TURN — a real, billable state change.
        stats.value = { direct: 0, relay: 1, unknownTransport: 0, directTotal: 4, relayTotal: 3 };
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        expect(statusReports(), 'a transport change must not be suppressed').toHaveLength(2);
        expect(statusReports()[1].data.p2p).toMatchObject({ relay: 1, relayTotal: 3 });
    });

    it('resumes deduping once the counters settle again', async () => {
        const stats = { value: { ...STABLE } };
        const { reporter, statusReports } = makeReporter(stats);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        stats.value = { ...STABLE, relayTotal: 3 };
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(2);

        // Settled — back to suppression, so a burst of reconnects cannot leave the
        // daemon permanently un-deduped.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(2);
    });

    it('a daemon without transport observability dedups exactly as before', async () => {
        const stats = { value: undefined };
        const { reporter, statusReports } = makeReporter(stats);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        expect(statusReports()).toHaveLength(1);
    });
});

describe('transport counters vs delivery confirmation', () => {
    it('does not commit the hash when a counter-bearing report is dropped', async () => {
        // T1 made the dedup hash commit only after a confirmed send. A dropped
        // frame carrying new counters must be retried, not silently deduped away.
        const sent: SentMessage[] = [];
        let deliverable = false;
        const reporter = new DaemonStatusReporter(
            {
                serverConn: {
                    isConnected: () => true,
                    sendMessage: (type, data) => {
                        if (!deliverable) return false;
                        sent.push({ type, data });
                        return true;
                    },
                    getUserPlan: () => 'pro',
                },
                cdpManagers: new Map(),
                p2p: {
                    isConnected: true,
                    isAvailable: true,
                    connectionState: 'connected',
                    connectedPeerCount: 1,
                    screenshotActive: false,
                    transportStats: { ...STABLE } as any,
                    sendStatus: () => {},
                    sendStatusEvent: () => {},
                },
                providerLoader: { resolve: () => undefined, getAll: () => [] },
                detectedIdes: [],
                instanceId: 'inst-1',
                daemonVersion: '1.0.0',
                instanceManager: {
                    collectAllStates: () => ([{
                        category: 'cli', type: 'claude-cli', status: 'idle',
                        sessions: [{ id: 'sess-1', providerType: 'claude-cli', status: 'idle', transport: 'pty', kind: 'agent' }],
                    } as any]),
                    collectStatesByCategory: () => [],
                },
            },
            { logFn: () => {} },
        );

        // Socket is mid-reconnect: the frame is dropped.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(sent.filter((m) => m.type === 'status_report')).toHaveLength(0);

        // Socket recovers — the same payload must still be sent, not deduped.
        deliverable = true;
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        const reports = sent.filter((m) => m.type === 'status_report');
        expect(reports, 'a dropped counter report must be retried').toHaveLength(1);
        expect(reports[0].data.p2p).toMatchObject({ directTotal: 4, relayTotal: 2 });
    });
});
