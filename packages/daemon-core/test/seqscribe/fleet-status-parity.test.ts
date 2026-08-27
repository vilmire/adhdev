import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    configureFleetStatusParity,
    fleetStatusParityCounters,
    observeFleetStatusWsProjection,
    __resetFleetStatusParityForTests,
    type FleetStatusParityExpectation,
} from '../../src/seqscribe/fleet-status-parity.js';
import {
    configureFleetStatusShadow,
    fleetStatusInflight,
    getLastAppendedEntryForParity,
    recordFleetStatusShadow,
    __resetFleetStatusShadowForTests,
} from '../../src/seqscribe/fleet-status-shadow.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import {
    buildCloudStatusReportPayload,
    countFleetSessions,
    fleetStatusEntry,
    type FleetOnlineState,
} from '../../src/status/reporter.js';

const SHADOW_ENV = { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' };
const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-fleet-parity-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: {},
        storedFleetSecret: null,
        daemonId: 'daemon_parity_test',
    });
    handles.push(handle);
    return handle;
}

function expectation(
    sessions: unknown,
    onlineState: FleetOnlineState = 'online',
    timestamp = 1_700_000_000_000,
): FleetStatusParityExpectation {
    // This is the independent production path: route through the WS allow-list
    // first, then derive the count axes from what that path retained.
    const ws = buildCloudStatusReportPayload(sessions, undefined, timestamp);
    return {
        at: new Date(timestamp).toISOString(),
        sessionCounts: countFleetSessions(ws.sessions),
        onlineState,
    };
}

async function untilQuiet(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (fleetStatusInflight() === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timeout waiting for fleet.status append');
}

afterEach(async () => {
    vi.restoreAllMocks();
    __resetFleetStatusParityForTests();
    __resetFleetStatusShadowForTests();
    for (const handle of handles.splice(0)) await handle.close().catch(() => {});
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fleet.status parity — producer append snapshot', () => {
    it('reports mismatch zero for matching WS/shadow builders and freezes the successful snapshot', async () => {
        const node = openNode('clean');
        configureFleetStatusShadow(node, SHADOW_ENV);
        const logs: string[] = [];
        const parity = configureFleetStatusParity(node, { once: true, log: (line) => logs.push(line) });
        expect(parity).not.toBeNull();

        const sessions = [
            { id: 'a', kind: 'agent', transport: 'pty', status: 'generating' },
            { id: 'b', kind: 'workspace', transport: 'cdp-page', status: 'idle' },
        ];
        const expected = expectation(sessions);
        expect(observeFleetStatusWsProjection(() => expected)).toBe(true);
        const shadowEntry = fleetStatusEntry({
            daemonId: 'daemon_parity_test',
            sessions,
            onlineState: 'online',
            p2pActive: true,
            timestamp: 1_700_000_000_000,
        });
        const appendedCliCount = shadowEntry.sessionCounts.cliCount;
        expect(recordFleetStatusShadow(shadowEntry)).toBe(true);
        shadowEntry.sessionCounts.cliCount += 99;
        await untilQuiet();

        expect(parity!.runOnce()).toEqual({ compared: true, mismatches: [] });
        const snapshot = getLastAppendedEntryForParity();
        expect(snapshot).not.toBeNull();
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot!.sessionCounts)).toBe(true);
        expect(snapshot!.sessionCounts.cliCount).toBe(appendedCliCount);
        expect(fleetStatusParityCounters()).toMatchObject({ runs: 1, compared: 1, mismatches: 0 });
        expect(logs).toEqual([]);
    });

    it('injection proof: valid but divergent axes increment fixed buckets and emit a numeric summary', async () => {
        const node = openNode('inject');
        configureFleetStatusShadow(node, SHADOW_ENV);
        const logs: string[] = [];
        const parity = configureFleetStatusParity(node, { once: true, log: (line) => logs.push(line) });

        const sessions = [{ id: 'a', kind: 'agent', transport: 'pty', status: 'generating' }];
        const expected = expectation(sessions);
        observeFleetStatusWsProjection(() => expected);

        const injected = fleetStatusEntry({
            daemonId: 'daemon_parity_test',
            sessions,
            onlineState: 'reconnecting',
            p2pActive: true,
            timestamp: 1_700_000_000_000,
        });
        injected.sessionCounts.cliCount++;
        expect(recordFleetStatusShadow(injected)).toBe(true);
        await untilQuiet();

        expect(parity!.runOnce()).toEqual({
            compared: true,
            mismatches: ['cli_count', 'online_state'],
        });
        const counters = fleetStatusParityCounters();
        expect(counters.mismatches).toBe(2);
        expect(counters.buckets.cli_count).toBe(1);
        expect(counters.buckets.online_state).toBe(1);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatch(
            /^fleet\.status parity summary(?: [a-z_]+=[0-9]+)+$/,
        );
        expect(logs[0]).not.toContain('daemon_parity_test');
        expect(logs[0]).not.toContain(expected.at);
    });

    it('rate-limits mismatch summaries to at most one per minute', async () => {
        const node = openNode('rate-limit');
        configureFleetStatusShadow(node, SHADOW_ENV);
        let now = 10_000;
        const logs: string[] = [];
        const parity = configureFleetStatusParity(node, {
            once: true,
            appendSettleMs: 0,
            clock: () => now,
            log: (line) => logs.push(line),
        });

        const expected = expectation([]);
        observeFleetStatusWsProjection(() => expected);
        const injected = fleetStatusEntry({
            daemonId: 'daemon_parity_test',
            sessions: [{ id: 'a', kind: 'agent', transport: 'pty', status: 'idle' }],
            onlineState: 'online',
            p2pActive: false,
            timestamp: 1_700_000_000_000,
        });
        expect(recordFleetStatusShadow(injected)).toBe(true);
        await untilQuiet();

        parity!.runOnce();
        now += 1_000;
        parity!.runOnce();
        expect(logs).toHaveLength(1);
        now += 59_000;
        parity!.runOnce();
        expect(logs).toHaveLength(2);
    });

    it('is completely inert in off mode, including the expectation thunk and scan/timer', () => {
        const node = openNode('off');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'off' });
        const interval = vi.spyOn(globalThis, 'setInterval');
        const build = vi.fn(() => expectation([]));

        expect(configureFleetStatusParity(node)).toBeNull();
        expect(observeFleetStatusWsProjection(build)).toBe(false);
        expect(build).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(getLastAppendedEntryForParity()).toBeNull();
        expect(fleetStatusParityCounters()).toMatchObject({ runs: 0, compared: 0, mismatches: 0 });
    });
});

describe('fleet.status parity — production wiring', () => {
    it('arms after the shadow and detaches before it in daemon lifecycle', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(join(here, '../../src/boot/daemon-lifecycle.ts'), 'utf8');
        const armShadow = source.indexOf('configureFleetStatusShadow(components.seqscribeNode ?? null)');
        const armParity = source.indexOf('configureFleetStatusParity(components.seqscribeNode ?? null)');
        const detachParity = source.indexOf('configureFleetStatusParity(null)');
        const detachShadow = source.indexOf('configureFleetStatusShadow(null)');

        expect(armShadow).toBeGreaterThan(-1);
        expect(armParity).toBeGreaterThan(armShadow);
        expect(detachParity).toBeGreaterThan(armParity);
        expect(detachShadow).toBeGreaterThan(detachParity);
    });

    it('builds the expectation through buildCloudStatusReportPayload without changing server fields', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(join(here, '../../src/status/reporter.ts'), 'utf8');
        const observer = source.indexOf('observeFleetStatusWsProjection(() => {');
        const shadow = source.indexOf('recordFleetStatusShadow(fleetStatusEntry({', observer);
        const block = source.slice(observer, shadow);

        expect(observer).toBeGreaterThan(-1);
        expect(block).toContain('buildCloudStatusReportPayload(payload.sessions, payload.p2p, now)');
        expect(block).toContain('countFleetSessions(wsProjection.sessions)');
    });

    it('uses only the producer snapshot getter — no seqscribe read or stats API', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(join(here, '../../src/seqscribe/fleet-status-parity.ts'), 'utf8');

        expect(source).not.toMatch(/\.onEntry\s*\(/);
        expect(source).not.toMatch(/\.stats\s*\(/);
        expect(source).not.toMatch(/\.scanEntries\s*\(/);
        expect(source).not.toMatch(/\.vectors\s*\(/);
        expect(source).toContain('getLastAppendedEntryForParity()');
    });
});
