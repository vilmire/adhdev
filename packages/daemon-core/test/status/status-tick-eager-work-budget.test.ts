import { describe, expect, it, vi, afterEach } from 'vitest';
import { DaemonStatusReporter } from '../../src/status/reporter.js';
import * as fleetShadow from '../../src/seqscribe/fleet-status-shadow.js';

/**
 * Per-tick eager-work budget on the status heartbeat (perf regression gate).
 *
 * `sendUnifiedStatusReport` runs every 5s on a P2P-connected daemon. Two pieces
 * of unconditional O(N) work on that path produced results that were, in the
 * default configuration, thrown away:
 *
 *   1. the fleet.status ring entry — `fleetStatusEntry(...)` walks every session
 *      via countFleetSessions and reads the seqscribe stats getter, but
 *      `recordFleetStatusShadow` discards it outright unless a shadow node is
 *      armed (off by default on every daemon);
 *   2. the per-category log summary — three `allStates.filter()` passes plus
 *      three `.map().join()` string builds, feeding one log line that is DEBUG
 *      on the 5s P2P tick and therefore suppressed on a default (info) daemon.
 *
 * Both are now gated. These tests pin the budget AND — more importantly — that
 * gating them changed nothing about what is transmitted or deduped: a status
 * report is a delivery path, and a perf fix that suppressed a real change would
 * be far worse than the cost it saved.
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

    it('does not build a fleet.status entry when no shadow node is armed', async () => {
        // Default configuration: the shadow is off, so the entry — and the
        // session walk + stats read it needs — must never be constructed.
        const spy = vi.spyOn(fleetShadow, 'recordFleetStatusShadow');
        let statsReads = 0;
        const { reporter } = makeReporter({
            status: { value: 'idle' },
            onSeqscribeStats: () => { statsReads++; },
        });

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        // ★ The regression assertion: reverting the gate calls the recorder (and
        // builds the entry) on every tick.
        expect(spy).not.toHaveBeenCalled();
        // The fleet entry's stats read is likewise skipped. The SERVER frame has
        // its own stats read, so this asserts the count stayed at the one-per-
        // send the transmit path needs, not that it dropped to zero.
        expect(statsReads).toBeLessThanOrEqual(3);
    });

    it('still records a fleet.status entry when the shadow IS armed', async () => {
        // The gate must be a pure no-op elision, not a feature removal: with the
        // shadow active the entry is built and recorded exactly as before.
        vi.spyOn(fleetShadow, 'isFleetStatusShadowActive').mockReturnValue(true);
        const spy = vi.spyOn(fleetShadow, 'recordFleetStatusShadow').mockReturnValue(true);
        const { reporter } = makeReporter({ status: { value: 'idle' } });

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        expect(spy).toHaveBeenCalledTimes(1);
        const entry = spy.mock.calls[0][0];
        expect(entry.daemonId).toBe('inst-1');
        // The session walk really ran — the counts are populated, not zeroed.
        expect(entry.sessionCounts.cliCount).toBe(3);
        expect(entry.sessionCounts.idleCount).toBe(3);
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

        // A non-p2pOnly tick logs at INFO, which is not suppressed by default.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });

        const summary = lines.find((l) => l.includes('IDE:'));
        expect(summary).toBeDefined();
        expect(summary).toContain('IDE: 0 []');
        expect(summary).toContain('CLI: 3 [claude-cli(idle), claude-cli(idle), claude-cli(idle)]');
        expect(summary).toContain('ACP: 0 []');
        infoSpy.mockRestore();
    });
});
