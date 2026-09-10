/**
 * ENTER-LOSS layer ① — shutdown drain gate at the DaemonCliManager level
 * (drainInFlightSubmits), the API shutdownDaemonComponents awaits before
 * detachAll() tears the adapters down.
 *
 * Three required branches (mission spec):
 *  1. adapters with an in-flight submit → the gate WAITS for them;
 *  2. ceiling exceeded → the gate reports the unfinished submits and RETURNS
 *     (shutdown proceeds — never an unbounded wait);
 *  3. nothing in flight → immediate pass, zero added latency.
 */
import { describe, it, expect } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import type { CliAdapter } from '../../src/cli-adapter-types.js';

function makeManager(): DaemonCliManager {
    // The gate touches only `adapters` + logging; deps/providerLoader are inert.
    return new DaemonCliManager({
        getServerConn: () => null,
        getP2p: () => null,
        onStatusChange: () => {},
        removeAgentTracking: () => {},
    } as any, {} as any);
}

function stubAdapter(overrides: Partial<CliAdapter>): CliAdapter {
    return {
        cliType: 'stub',
        cliName: 'stub',
        workingDir: '/tmp',
        spawn: async () => {},
        sendMessage: async () => {},
        getStatus: () => ({ status: 'idle', messages: [], activeModal: null }),
        getPartialResponse: () => '',
        shutdown: () => {},
        cancel: () => {},
        isProcessing: () => false,
        isReady: () => true,
        setOnStatusChange: () => {},
        ...overrides,
    } as CliAdapter;
}

describe('ENTER-LOSS ① — DaemonCliManager.drainInFlightSubmits', () => {
    it('branch 3: nothing in flight → immediate clean pass', async () => {
        const mgr = makeManager();
        mgr.adapters.set('a', stubAdapter({ hasInFlightSubmit: () => false }));
        // Adapters WITHOUT the surface (legacy/ACP) count as nothing-in-flight.
        mgr.adapters.set('b', stubAdapter({}));
        const before = Date.now();
        const res = await mgr.drainInFlightSubmits(5_000);
        expect(res.clean).toBe(true);
        expect(res.pendingKeys).toEqual([]);
        expect(res.waitedMs).toBe(0);
        expect(Date.now() - before).toBeLessThan(100);
    });

    it('branch 1: waits for an in-flight submit to finish, then reports clean', async () => {
        const mgr = makeManager();
        let inFlight = true;
        mgr.adapters.set('busy', stubAdapter({
            hasInFlightSubmit: () => inFlight,
            whenSubmitDrained: async (_timeoutMs: number) => {
                await new Promise(r => setTimeout(r, 250));
                inFlight = false;
                return true;
            },
        }));
        const before = Date.now();
        const res = await mgr.drainInFlightSubmits(5_000);
        expect(res.clean).toBe(true);
        expect(res.pendingKeys).toEqual([]);
        // It genuinely waited for the drain rather than passing through.
        expect(Date.now() - before).toBeGreaterThanOrEqual(200);
    });

    it('branch 2: ceiling exceeded → names the unfinished submit and proceeds', async () => {
        const mgr = makeManager();
        mgr.adapters.set('stuck', stubAdapter({
            hasInFlightSubmit: () => true, // never completes
            whenSubmitDrained: async (timeoutMs: number) => {
                await new Promise(r => setTimeout(r, timeoutMs));
                return false;
            },
        }));
        mgr.adapters.set('fine', stubAdapter({ hasInFlightSubmit: () => false }));
        const before = Date.now();
        const res = await mgr.drainInFlightSubmits(300);
        // Returned (bounded) — never an unbounded wait.
        expect(Date.now() - before).toBeLessThan(2_000);
        expect(res.clean).toBe(false);
        expect(res.pendingKeys).toEqual(['stuck']);
    });

    it('a throwing adapter never blocks shutdown', async () => {
        const mgr = makeManager();
        mgr.adapters.set('broken', stubAdapter({
            hasInFlightSubmit: () => { throw new Error('boom'); },
        }));
        const res = await mgr.drainInFlightSubmits(1_000);
        expect(res.clean).toBe(true);
    });
});
