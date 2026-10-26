import { describe, expect, it } from 'vitest';
import { createBackgroundWorkMonitor } from '../../src/mesh/turn-ledger/background-work-guard.js';

// rc34 7d2d45e6 (rc28 live verification PARTIAL): three "background work has run
// 2 minutes" notices fired while the live command was only ~2.8 s old. An early
// mid-turn read (unknown status, or an unsafe 'idle' projection while the agent
// was still generating) seeded the entry's clock; it was never cleared when the
// agent resumed, so a short command started at the real turn end inherited it.
const T0 = 1_000_000;
const TIMEOUT = 120_000;

function attempt(): any {
  return {
    attemptId: 'a1', generation: 1, scope: 'mesh_queue', state: 'awaiting', terminal: null,
    data: {}, meshId: 'm1', nodeId: 'n1', sessionId: 's1', taskId: 't1',
    coordinator: { daemonId: 'd1', sessionId: 'c1' }, acceptedAt: T0, deliveredAt: T0,
  };
}

function monitor() {
  const notices: number[] = [];
  const m = createBackgroundWorkMonitor({
    timeoutMs: TIMEOUT,
    inactivityReleaseMs: 10 * 60_000,
    notifyCoordinator: (_c, _t, meta) => { notices.push(meta.at); },
    nudgeWorker: () => true,
  });
  return { m, notices };
}

describe('background work 120 s notice clock', () => {
  it('an unknown status never starts the clock', async () => {
    const { m } = monitor();
    await m.observe({ attempt: attempt(), nowMs: T0 + 1_000, status: '', liveBackgroundProcesses: ['npm'] });
    expect(m.getEntry('a1')).toBeUndefined();
  });

  it('a mid-turn "ended" read is forgotten once the agent is generating again, so a later short command is not notified early', async () => {
    const { m, notices } = monitor();
    // False end read mid-turn while a quick command runs.
    await m.observe({ attempt: attempt(), nowMs: T0 + 5_000, status: 'idle', liveBackgroundProcesses: ['npm'] });
    expect(m.getEntry('a1')).toBeDefined();
    // The agent keeps working.
    await m.observe({ attempt: attempt(), nowMs: T0 + 60_000, status: 'generating', liveBackgroundProcesses: ['npm'] });
    expect(m.getEntry('a1')).toBeUndefined();
    // Real turn end at +130 s; a new short command started ~3 s ago.
    const realEnd = T0 + 130_000;
    await m.observe({ attempt: attempt(), nowMs: realEnd + 3_000, status: 'idle', finalAssistantAt: realEnd, liveBackgroundProcesses: ['sleep'] });
    expect(notices).toEqual([]);
    // Real post-turn background work is still reported 120 s after the real end.
    await m.observe({ attempt: attempt(), nowMs: realEnd + TIMEOUT + 1_000, status: 'idle', finalAssistantAt: realEnd, liveBackgroundProcesses: ['sleep'] });
    expect(notices).toEqual([realEnd + TIMEOUT + 1_000]);
  });

  it('a flapping TUI after the real end does not reset the clock (it is re-anchored on the validated final timestamp)', async () => {
    const { m, notices } = monitor();
    const realEnd = T0 + 10_000;
    await m.observe({ attempt: attempt(), nowMs: realEnd + 1_000, status: 'idle', finalAssistantAt: realEnd, liveBackgroundProcesses: ['server'] });
    await m.observe({ attempt: attempt(), nowMs: realEnd + 60_000, status: 'generating', liveBackgroundProcesses: ['server'] });
    await m.observe({ attempt: attempt(), nowMs: realEnd + TIMEOUT + 500, status: 'idle', finalAssistantAt: realEnd, liveBackgroundProcesses: ['server'] });
    expect(notices).toEqual([realEnd + TIMEOUT + 500]);
  });
});
