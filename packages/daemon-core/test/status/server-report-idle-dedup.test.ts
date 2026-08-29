import { describe, expect, it, vi } from 'vitest';
import { DaemonStatusReporter, SERVER_DEDUP_KEEPALIVE_REPORTS } from '../../src/status/reporter.js';

/**
 * An idle daemon must not re-send a byte-identical status_report every 30s.
 *
 * The dedup hash in sendUnifiedStatusReport has existed for a long time, but the
 * periodic timer called it with `forceServer: true`, so the one path that fires
 * on a wall-clock schedule was the one path that could never dedup. On the
 * server side each report is a UserSessionDO request — the account axis nearest
 * its limit — so a fully idle machine was the single largest source of avoidable
 * load.
 *
 * These tests pin the three properties that make suppression safe:
 *   1. an unchanged payload is suppressed,
 *   2. suppression is bounded (keepalive), so the server view cannot go stale,
 *   3. a real change still transmits immediately, without waiting for keepalive.
 */

interface SentMessage {
    type: string;
    data: any;
}

function makeReporter(sessionStatus: { value: string }, getSeqscribeStats?: () => any) {
    const sent: SentMessage[] = [];
    const reporter = new DaemonStatusReporter(
        {
            serverConn: {
                isConnected: () => true,
                sendMessage: (type, data) => { sent.push({ type, data }); },
                getUserPlan: () => 'pro',
            },
            cdpManagers: new Map(),
            p2p: null,
            providerLoader: { resolve: () => undefined, getAll: () => [] },
            detectedIdes: [],
            instanceId: 'inst-1',
            daemonVersion: '1.0.0',
            instanceManager: {
                // A single CLI session whose status is controlled by the test.
                collectAllStates: () => ([{
                    category: 'cli',
                    type: 'claude-cli',
                    status: sessionStatus.value,
                    sessions: [{
                        id: 'sess-1',
                        providerType: 'claude-cli',
                        status: sessionStatus.value,
                        transport: 'pty',
                        kind: 'agent',
                    }],
                } as any]),
                collectStatesByCategory: () => [],
            },
            ...(getSeqscribeStats ? { getSeqscribeStats } : {}),
        },
        { logFn: () => {} },
    );
    const statusReports = () => sent.filter((m) => m.type === 'status_report');
    return { reporter, statusReports };
}

describe('idle status_report dedup', () => {
    it('includes the supplied seqscribe aggregate and strips non numeric/enum content', async () => {
        const canary = 'session.secret-session.transcript';
        const { reporter, statusReports } = makeReporter(
            { value: 'idle' },
            () => ({
                topics: 5,
                peers: 2,
                peersReady: 1,
                pendingBucket: 2,
                consumerLagBucket: 0,
                queueBucket: 1,
                fgenAgeBucket: 3,
                quarantined: false,
                authority: true,
                topicName: canary,
            }),
        );

        await reporter.sendUnifiedStatusReport({ reason: 'seqscribe-provider' });

        expect(statusReports()).toHaveLength(1);
        expect(statusReports()[0].data.seqscribe).toEqual({
            topics: 5,
            peers: 2,
            peersReady: 1,
            pendingBucket: 2,
            consumerLagBucket: 0,
            queueBucket: 1,
            fgenAgeBucket: 3,
            quarantined: false,
            authority: true,
            dualWrite: false,
            dualWriteFailedBucket: 0,
            dualWriteDroppedBucket: 0,
            dualWriteBackfilledBucket: 0,
            parityMismatchBucket: 0,
            parityRan: false,
            parityMissingInShadowBucket: 0,
            parityExtraInShadowBucket: 0,
            parityFieldMismatchBucket: 0,
            transcriptPublish: false,
            transcriptPublishedBucket: 0,
            transcriptPublishFailedBucket: 0,
            transcriptDedupedBucket: 0,
            transcriptOversizedBucket: 0,
            transcriptDroppedBucket: 0,
            transcriptParityRan: false,
            transcriptParityMismatchBucket: 0,
        });
        expect(JSON.stringify(statusReports()[0].data)).not.toContain(canary);
        for (const value of Object.values(statusReports()[0].data.seqscribe)) {
            expect(['number', 'boolean']).toContain(typeof value);
        }
    });

    it('suppresses unchanged periodic reports instead of resending every interval', async () => {
        const status = { value: 'idle' };
        const { reporter, statusReports } = makeReporter(status);

        // First periodic report seeds the hash and must transmit.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        // Nothing changed — the next few intervals must not reach the server.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);
    });

    it('still sends a keepalive after a bounded number of suppressed reports', async () => {
        const status = { value: 'idle' };
        const { reporter, statusReports } = makeReporter(status);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        // Drive exactly one full keepalive window of unchanged reports. The Nth
        // must transmit so a quiet-but-alive daemon can never be aged out by the
        // server's stale-entry sweep.
        for (let i = 0; i < SERVER_DEDUP_KEEPALIVE_REPORTS; i++) {
            await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        }
        expect(statusReports()).toHaveLength(2);
    });

    it('transmits a status transition immediately, without waiting for keepalive', async () => {
        const status = { value: 'idle' };
        const { reporter, statusReports } = makeReporter(status);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        // idle → generating changes the routing payload, so the hash differs.
        status.value = 'generating';
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(2);
        expect(statusReports()[1].data.sessions[0].status).toBe('generating');
    });

    it('drives the real periodic timer through the dedup path, not around it', async () => {
        // The defect was not in the hash — it was that the periodic timer passed
        // forceServer:true, so the one path firing on a wall-clock schedule was the
        // one path that could never dedup. Exercise startReporting() itself so a
        // reintroduced forceServer on that call site fails here.
        vi.useFakeTimers();
        try {
            const status = { value: 'idle' };
            const { reporter, statusReports } = makeReporter(status);

            reporter.startReporting();
            // Initial report (forceServer by design — a fresh connection must seed
            // the server) plus several idle intervals.
            await vi.advanceTimersByTimeAsync(2_000);
            const afterInitial = statusReports().length;
            expect(afterInitial).toBe(1);

            await vi.advanceTimersByTimeAsync(30_000 * 3);
            expect(statusReports()).toHaveLength(afterInitial);

            reporter.stopReporting();
        } finally {
            vi.useRealTimers();
        }
    });

    it('resets the keepalive counter on a real send', async () => {
        const status = { value: 'idle' };
        const { reporter, statusReports } = makeReporter(status);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        // Partially consume the keepalive window...
        for (let i = 0; i < SERVER_DEDUP_KEEPALIVE_REPORTS - 2; i++) {
            await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        }
        expect(statusReports()).toHaveLength(1);

        // ...then a real change transmits and must restart the window, rather
        // than leaving a nearly-expired counter that fires a redundant keepalive
        // one report later.
        status.value = 'generating';
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(2);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(2);
    });
});
