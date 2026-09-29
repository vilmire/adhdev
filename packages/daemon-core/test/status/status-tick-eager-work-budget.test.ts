import { describe, expect, it, vi, afterEach } from 'vitest';
import { DaemonStatusReporter } from '../../src/status/reporter.js';

/**
 * Server status_report tick budget + dedup (perf regression gate).
 *
 * The fleet.status shadow entry and the 5s P2P tick are gone (data-path audit
 * 2026-09-29 P0-3/P0-4); what remains must still transmit a real change at
 * once and suppress an unchanged report, and the per-category log summary is
 * built in one pass.
 */

describe('status tick eager-work budget', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function makeReporter(opts: {
        status: { value: string };
        sessionCount?: number;
        onSeqscribeStats?: () => void;
    }) {
        const sent: Array<{ type: string; data: any }> = [];
        const n = opts.sessionCount ?? 3;
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
                    collectAllStates: () => Array.from({ length: n }, (_, i) => ({
                        category: 'cli',
                        type: 'claude-cli',
                        status: opts.status.value,
                        sessions: [{
                            id: `sess-${i}`,
                            providerType: 'claude-cli',
                            status: opts.status.value,
                            transport: 'pty',
                            kind: 'agent',
                        }],
                    })) as any[],
                    collectStatesByCategory: () => [],
                },
                getSeqscribeStats: () => {
                    opts.onSeqscribeStats?.();
                    return null;
                },
            } as any,
            { logFn: () => {} },
        );
        return { reporter, statusReports: () => sent.filter((m) => m.type === 'status_report') };
    }

    it('reads the seqscribe stats once per report (server frame only)', async () => {
        let statsReads = 0;
        const { reporter } = makeReporter({
            status: { value: 'idle' },
            onSeqscribeStats: () => { statsReads++; },
        });

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        expect(statsReads).toBe(3);
    });

    // ── Dedup correctness must be untouched by the perf gating ───────────────
    // These restate the invariants of server-report-idle-dedup.test.ts against a
    // reporter whose eager work is now skipped, so a future "optimization" that
    // elides the payload build itself (and thus the hash) fails HERE rather than
    // silently stranding the server on a stale status.

    it('still suppresses an unchanged report after the eager work is skipped', async () => {
        const status = { value: 'idle' };
        const { reporter, statusReports } = makeReporter({ status });

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);
    });

    it('still transmits a real status change immediately', async () => {
        const status = { value: 'idle' };
        const { reporter, statusReports } = makeReporter({ status });

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(1);

        // The single most important property on this path: a genuine state
        // change must transmit on the very next tick. If a perf change ever
        // makes the payload/hash conditional on a stale signal, this goes red.
        status.value = 'generating';
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(2);
        expect(statusReports()[1].data.sessions[0].status).toBe('generating');

        // ...and back again — a transition in either direction is a change.
        status.value = 'idle';
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(statusReports()).toHaveLength(3);
        expect(statusReports()[2].data.sessions[0].status).toBe('idle');
    });

    it('emits the summary log line unchanged when the level permits it', async () => {
        // The summary is now built in one pass instead of three filters; the
        // rendered text must be identical to the previous three-filter form.
        const lines: string[] = [];
        const status = { value: 'idle' };
        const { reporter } = makeReporter({ status });
        const infoSpy = vi.spyOn((await import('../../src/logging/logger.js')).LOG, 'info')
            .mockImplementation((_c: string, msg: string) => { lines.push(msg); });

        // Every report logs at INFO, which is not suppressed by default.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        const summary = lines.find((l) => l.includes('IDE:'));
        expect(summary).toBeDefined();
        expect(summary).toContain('IDE: 0 []');
        expect(summary).toContain('CLI: 3 [claude-cli(idle), claude-cli(idle), claude-cli(idle)]');
        expect(summary).toContain('ACP: 0 []');
        infoSpy.mockRestore();
    });
});
