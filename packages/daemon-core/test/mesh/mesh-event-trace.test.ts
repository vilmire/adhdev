/**
 * EVTTRACE infra coverage: the correlation key is stable/uniform and the stage/drop
 * emitters log under the EvtTrace category with greppable [stage:*] / [drop:*] anchors.
 * This is observation-only logging — these tests assert the trace surface, not any
 * decision behaviour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LOG } from '../../src/logging/logger.js';
import { meshEventTraceKey, traceMeshEventStage, traceMeshEventDrop } from '../../src/mesh/mesh-event-trace.js';

describe('mesh-event-trace (EVTTRACE)', () => {
  afterEach(() => vi.restoreAllMocks());

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
