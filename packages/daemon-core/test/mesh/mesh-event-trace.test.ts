/**
 * EVTTRACE infra coverage: the correlation key is stable/uniform and the stage/drop
 * emitters log under the EvtTrace category with greppable [stage:*] / [drop:*] anchors.
 * This is observation-only logging — these tests assert the trace surface, not any
 * decision behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LOG } from '../../src/logging/logger.js';
import {
  meshEventTraceKey,
  traceMeshEventStage,
  traceMeshEventDrop,
  __resetMeshEventDropStreaksForTests,
} from '../../src/shared/mesh-event-trace.js';

describe('mesh-event-trace (EVTTRACE)', () => {
  beforeEach(() => __resetMeshEventDropStreaksForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    __resetMeshEventDropStreaksForTests();
  });

  it('builds a correlation key carrying every provided anchor', () => {
    const key = meshEventTraceKey({
      taskId: 'task_1', sessionId: 'sess_1', nodeId: 'node_1', meshId: 'mesh_1', event: 'agent:generating_completed',
    });
    expect(key).toContain('task=task_1');
    expect(key).toContain('sess=sess_1');
    expect(key).toContain('node=node_1');
    expect(key).toContain('mesh=mesh_1');
    expect(key).toContain('event=agent:generating_completed');
  });

  it('renders "-" for missing task/session anchors so the key shape is uniform', () => {
    const key = meshEventTraceKey({ nodeId: 'node_x' });
    expect(key).toContain('task=-');
    expect(key).toContain('sess=-');
    expect(key).toContain('node=node_x');
  });

  it('stage logs INFO under the EvtTrace category with a [stage:*] anchor + key + detail', () => {
    const info = vi.spyOn(LOG, 'info').mockImplementation(() => {});
    traceMeshEventStage('received', { taskId: 'task_42', sessionId: 'sess_42' }, 'detail');
    expect(info).toHaveBeenCalledTimes(1);
    const [cat, msg] = info.mock.calls[0] as [string, string];
    expect(cat).toBe('EvtTrace');
    expect(msg).toContain('[stage:received]');
    expect(msg).toContain('task=task_42');
    expect(msg).toContain('— detail');
  });

  it('drop logs WARN under the EvtTrace category with a [drop:*] anchor + key', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    traceMeshEventDrop('meshId_required', { taskId: 'task_42', nodeId: 'node_9' }, 'no workspace/nodeId');
    expect(warn).toHaveBeenCalledTimes(1);
    const [cat, msg] = warn.mock.calls[0] as [string, string];
    expect(cat).toBe('EvtTrace');
    expect(msg).toContain('[drop:meshId_required]');
    expect(msg).toContain('task=task_42');
    expect(msg).toContain('— no workspace/nodeId');
  });

  it('carries the SAME task anchor across stages and a drop so one grep follows the whole lifecycle', () => {
    const info = vi.spyOn(LOG, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    const ctx = { taskId: 'task_777', sessionId: 'sess_777', nodeId: 'node_777', event: 'agent:generating_completed' };
    traceMeshEventStage('fired', ctx);
    traceMeshEventStage('received', ctx);
    traceMeshEventDrop('retry_forward_rejected', ctx, 'meshId required');
    const lines = [...info.mock.calls, ...warn.mock.calls].map(c => c[1] as string);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain('task=task_777');
  });
});

// ─── per-(reason, anchor) streak dedup (2026-09-23 preview log review) ──────
// EvtTrace WARN volume: one (reason, taskId) pair repeated every ~4s in bursts
// (5,758 combined WARN lines for 3 reasons over 8 days; worst observed case 12
// hits in 20s for one task). traceMeshEventDrop was a bare unconditional
// LOG.warn with no dedup. Fix is generic at the module level — keyed on
// (reason, anchor), not on any specific reason string — so it applies to every
// drop reason, including ones that don't exist yet.
describe('traceMeshEventDrop streak dedup', () => {
  beforeEach(() => __resetMeshEventDropStreaksForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    __resetMeshEventDropStreaksForTests();
  });

  it('the FIRST drop for a (reason, anchor) key still logs WARN immediately', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(LOG, 'debug').mockImplementation(() => {});
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('repeats of the SAME (reason, anchor) within the flush window log DEBUG, not WARN', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(LOG, 'debug').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' }); // 1st: WARN
    now.mockReturnValue(1_004_000); // +4s, well inside the 5min flush window
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' });
    now.mockReturnValue(1_008_000);
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('a DIFFERENT reason for the SAME task is its own streak (not collapsed together)', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' });
    traceMeshEventDrop('reclaim_deferred_unknown_verdict', { taskId: 'task_1' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('the SAME reason for a DIFFERENT task is its own streak (not collapsed together)', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' });
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_2' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('falls back to sessionId, then nodeId, when taskId is absent — same fallback order as meshEventTraceKey', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(LOG, 'debug').mockImplementation(() => {});
    traceMeshEventDrop('meshId_required', { sessionId: 'sess_9' });
    traceMeshEventDrop('meshId_required', { sessionId: 'sess_9' }); // same anchor → streak repeat
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('re-surfaces at WARN with a repeat count once the flush window elapses, and keeps DEBUG-ing after', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(LOG, 'debug').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' }); // WARN #1 (streak start)
    now.mockReturnValue(60_000);
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' }); // DEBUG
    now.mockReturnValue(120_000);
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' }); // DEBUG
    now.mockReturnValue(5 * 60_000 + 1); // just past the 5min flush window
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' }); // WARN #2 (flush)
    now.mockReturnValue(5 * 60_000 + 5_000);
    traceMeshEventDrop('stale_task_terminal', { taskId: 'task_1' }); // DEBUG again

    expect(warn).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenCalledTimes(3);
    const flushLine = warn.mock.calls[1][1] as string;
    expect(flushLine).toContain('[drop:stale_task_terminal]');
    expect(flushLine).toContain('repeated 2x');
    expect(flushLine).toContain('4 total this streak');
    now.mockRestore();
  });

  it('does not delay visibility: the very first line of a brand-new streak is always WARN, never DEBUG', () => {
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(LOG, 'debug').mockImplementation(() => {});
    traceMeshEventDrop('unroutable', { taskId: 'task_new' });
    expect(warn).toHaveBeenCalledOnce();
    expect(debugSpy).not.toHaveBeenCalled();
    const [, msg] = warn.mock.calls[0] as [string, string];
    expect(msg).toContain('[drop:unroutable]');
    expect(msg).not.toContain('repeated');
  });
});
