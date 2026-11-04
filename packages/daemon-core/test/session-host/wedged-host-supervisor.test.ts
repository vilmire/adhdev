import { describe, expect, it, vi } from 'vitest';
import {
    createWedgedHostSupervisor,
    type WedgeProbeResult,
    type WedgedHostIdentity,
} from '../../src/session-host/wedged-host-supervisor.js';

const MIN = 60_000;
const HOST: WedgedHostIdentity = { pid: 4242, birth: 'Mon Nov  3 08:00:00 2026' };

function harness(over: { probes?: WedgeProbeResult[]; identity?: () => WedgedHostIdentity | null; held?: () => boolean; kill?: () => boolean } = {}) {
    let clock = 0;
    const queue = [...(over.probes ?? [])];
    const calls = { probe: [] as boolean[], capture: 0, kill: 0, respawn: 0 };
    const logs: string[] = [];
    const supervisor = createWedgedHostSupervisor({
        probe: async (long) => { calls.probe.push(long); return queue.length ? queue.shift()! : 'timeout'; },
        identity: over.identity ?? (() => HOST),
        capture: async () => { calls.capture++; return '/tmp/capture.txt'; },
        kill: () => { calls.kill++; return (over.kill ?? (() => true))(); },
        respawn: async () => { calls.respawn++; },
        maintenanceHeld: over.held ?? (() => false),
        log: (_l, m) => logs.push(m),
        now: () => clock,
    }, { thresholdMs: 5 * MIN, minSamples: 6, cooldownMs: 10 * MIN, maxRecoveriesPerHour: 2 });
    const advance = (ms: number) => { clock += ms; };
    return { supervisor, calls, logs, advance, queue };
}

async function runTicks(h: ReturnType<typeof harness>, count: number, everyMs = 30_000) {
    const out = [];
    for (let i = 0; i < count; i++) { out.push(await h.supervisor.tick()); h.advance(everyMs); }
    return out;
}

describe('wedged host supervisor', () => {
    it('recovers only after a continuous timeout streak spanning the threshold', async () => {
        const h = harness();
        const outcomes = await runTicks(h, 11); // 0s..300s: streak reaches 300s on the 11th probe
        expect(outcomes.slice(0, 10).every((o) => o === 'counting')).toBe(true);
        expect(outcomes[10]).toBe('recovered');
        expect(h.calls).toMatchObject({ capture: 1, kill: 1, respawn: 1 });
        expect(h.calls.probe.filter(Boolean)).toHaveLength(1); // one long confirmation probe
    });

    it('never acts on a busy host that still answers: any ok resets the streak', async () => {
        const probes: WedgeProbeResult[] = [];
        for (let i = 0; i < 40; i++) probes.push(i % 8 === 7 ? 'ok' : 'timeout');
        const h = harness({ probes });
        const outcomes = await runTicks(h, 40);
        expect(outcomes).not.toContain('recovered');
        expect(h.calls.kill).toBe(0);
    });

    it('ignores observer-starved timeouts and refused sockets (existing respawn path)', async () => {
        const h = harness({ probes: Array(30).fill('starved') });
        await runTicks(h, 30);
        expect(h.calls.kill).toBe(0);
        const g = harness({ probes: Array(30).fill('unreachable') });
        await runTicks(g, 30);
        expect(g.calls.kill).toBe(0);
    });

    it('aborts when the pre-kill confirmation probe is answered', async () => {
        const probes: WedgeProbeResult[] = Array(11).fill('timeout');
        probes.push('ok'); // the long confirmation
        const h = harness({ probes });
        const outcomes = await runTicks(h, 11);
        expect(outcomes[10]).toBe('aborted');
        expect(h.calls.kill).toBe(0);
        expect(h.calls.capture).toBe(0);
    });

    it('restarts the streak when the host identity changes (new pid or birth)', async () => {
        let host: WedgedHostIdentity = HOST;
        const h = harness({ identity: () => host });
        await runTicks(h, 8);
        host = { pid: 4243, birth: 'later' };
        const outcomes = await runTicks(h, 8);
        expect(outcomes).not.toContain('recovered');
        expect(h.calls.kill).toBe(0);
    });

    it('does nothing during cooperative maintenance or with no host', async () => {
        const held = harness({ held: () => true });
        expect(new Set(await runTicks(held, 20))).toEqual(new Set(['skipped']));
        const none = harness({ identity: () => null });
        expect(new Set(await runTicks(none, 20))).toEqual(new Set(['idle']));
        expect(held.calls.probe).toHaveLength(0);
        expect(none.calls.probe).toHaveLength(0);
    });

    it('reports a refused kill and does not respawn or count it as a recovery', async () => {
        const h = harness({ kill: () => false });
        const outcomes = await runTicks(h, 11);
        expect(outcomes[10]).toBe('kill_refused');
        expect(h.calls.respawn).toBe(0);
    });

    it('applies a cooldown and an hourly cap after recoveries', async () => {
        const h = harness();
        await runTicks(h, 11);
        expect(h.calls.kill).toBe(1);
        const next = await runTicks(h, 11); // within the 10 minute cooldown
        expect(next).toContain('rate_limited');
        expect(h.calls.kill).toBe(1);
    });

    it('survives a failing respawn', async () => {
        let clock = 0;
        const supervisor = createWedgedHostSupervisor({
            probe: async () => 'timeout', identity: () => HOST, capture: async () => undefined,
            kill: () => true, respawn: vi.fn(async () => { throw new Error('disk critical'); }),
            maintenanceHeld: () => false, log: () => {}, now: () => clock,
        }, { thresholdMs: 0, minSamples: 1 });
        await expect(supervisor.tick()).resolves.toBe('recovered');
        clock += 1;
    });
});
