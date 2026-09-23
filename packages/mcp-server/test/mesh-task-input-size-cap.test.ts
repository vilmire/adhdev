import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readTaskInput,
  MESH_TASK_INPUT_MAX_PART_BYTES,
  MESH_TASK_INPUT_MAX_TOTAL_BYTES,
} from '../src/tools/mesh-tool-shared.js';

// IPC load audit 2026-09-23: a task input envelope is persisted on the queue row
// for its 30-day lifetime and travels over IPC/P2P on every dispatch, so an
// unbounded image made dashboard mesh_status exceed the P2P chunk ceiling.
test('readTaskInput accepts an image under the per-part cap', () => {
  const data = 'a'.repeat(1024);
  const input = readTaskInput({ parts: [{ type: 'image', mimeType: 'image/png', data }] });
  assert.equal(input?.parts.length, 1);
});

test('readTaskInput rejects a single part over the per-part cap with an actionable message', () => {
  const data = 'a'.repeat(MESH_TASK_INPUT_MAX_PART_BYTES + 1);
  assert.throws(
    () => readTaskInput({ parts: [{ type: 'image', mimeType: 'image/png', data }] }),
    /per-part limit is 8\.0 MiB/,
  );
});

test('readTaskInput rejects an envelope whose parts together exceed the total cap', () => {
  const half = 'a'.repeat(Math.floor(MESH_TASK_INPUT_MAX_TOTAL_BYTES / 2) + 1024);
  assert.throws(
    () => readTaskInput({ parts: [
      { type: 'image', mimeType: 'image/png', data: half },
      { type: 'image', mimeType: 'image/png', data: half },
    ] }),
    /envelope limit is 12\.0 MiB/,
  );
});
