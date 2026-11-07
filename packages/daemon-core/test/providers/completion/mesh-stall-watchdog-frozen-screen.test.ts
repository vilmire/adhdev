import { describe, expect, it } from 'vitest';
import { runMeshStallTick, MESH_WORKER_FROZEN_SCREEN_MS, normalizeScreenForFrozenCheck, type MeshStallHost } from '../../../src/providers/completion/mesh-stall-watchdog.js';

// A worker mid-turn whose only output is a spinner: raw output keeps arriving (lastOutputAt = now)
// while the visible screen, minus spinner/digits/tips, never changes.
function spinningHost(screenAt: (now: number) => string) {
    const events: any[] = [];
    let clock = 0;
    const h = {
        instanceId: 'w1', type: 'cursor-cli', startedAt: 0,
        adapter: {
            isAlive: () => true,
            getStatus: () => ({ status: 'generating', lastOutputAt: clock }),
            getLastApprovalResolvedAt: () => 0,
            getTerminalScreenSnapshot: () => ({ text: screenAt(clock) }),
        },
        meshStallAnchorAt: -1, meshStallEmittedForAnchor: false, meshStallTurnActiveLast: undefined, meshStallLastFiredAt: -1,
        meshStallTranscriptSignalSampled: false, isMeshWorkerSession: () => true, hasAdapterPendingResponse: () => true,
        probeNativeTranscriptSignals: () => null, meshTraceCtx: () => ({}), completingTurnTaskId: () => 't', pushEvent: (e: any) => { events.push(e); },
    } as unknown as MeshStallHost;
    const tick = (now: number) => { clock = now; runMeshStallTick(h, now); };
    return { h, events, tick };
}
const frames = ['⠘⠆', '⠰⠳', '⠞⠀'];
const frozen = (n: number) => `Tip: tip ${n % 3}\n ${frames[n % 3]} Composing\n  → Add a follow-up   ctrl+c to stop\n  Composer 2.5 · ${n % 60}%`;

describe('stall watchdog — frozen screen behind a spinner', () => {
    it('normalizes spinner frames, digits and tip lines away', () => {
        expect(normalizeScreenForFrozenCheck(frozen(1))).toBe(normalizeScreenForFrozenCheck(frozen(2)));
    });

    it('reports no progress once the screen has not changed for the frozen limit, despite spinner output', () => {
        const { events, tick } = spinningHost(now => frozen(Math.floor(now / 1000)));
        for (let t = 0; t <= MESH_WORKER_FROZEN_SCREEN_MS + 120_000; t += 30_000) tick(t);
        const stalls = events.filter(e => e.event === 'monitor:no_progress');
        expect(stalls).toHaveLength(1);
    });

    it('stays quiet while the screen content keeps changing', () => {
        const { events, tick } = spinningHost(now => `${frozen(0)}\nline ${now % 7 === 0 ? 'a' : 'b'} step ${['x', 'y', 'z'][Math.floor(now / 30_000) % 3]}`);
        for (let t = 0; t <= MESH_WORKER_FROZEN_SCREEN_MS + 120_000; t += 30_000) tick(t);
        expect(events.filter(e => e.event === 'monitor:no_progress')).toHaveLength(0);
    });
});
