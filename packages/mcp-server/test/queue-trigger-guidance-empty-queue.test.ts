import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQueueTriggerGuidance } from '../src/tools/mesh-tools-internal-core.js';

// Live two-machine test (published 1.0.78): mesh_launch_session on an empty queue
// returned queueDispatchState 'pending_or_waiting_for_ready' and "The task is queued
// but this trigger did not claim it" although no task existed. An empty-queue drain
// must produce no guidance at all.
test('no guidance when the trigger saw an empty queue', () => {
  const guidance = buildQueueTriggerGuidance({
    success: true, pendingBefore: 0, assignedBefore: 0, pendingAfter: 0, assignedAfter: 0,
    claimed: false, newlyAssignedTasks: [], autoLaunchStarted: false,
  });
  assert.equal(guidance, undefined);
});

test('a still-pending task keeps the fallback guidance', () => {
  const guidance = buildQueueTriggerGuidance({
    success: true, pendingBefore: 1, assignedBefore: 0, pendingAfter: 1, assignedAfter: 0,
    claimed: false, newlyAssignedTasks: [], autoLaunchStarted: false, localIdleSessionsChecked: 1,
  });
  assert.equal(guidance?.queueDispatchState, 'pending_or_waiting_for_ready');
});

test('a failed trigger on an empty queue still reports trigger_failed', () => {
  const guidance = buildQueueTriggerGuidance({ success: false, pendingBefore: 0, pendingAfter: 0, assignedAfter: 0 });
  assert.equal(guidance?.queueDispatchState, 'trigger_failed');
});
