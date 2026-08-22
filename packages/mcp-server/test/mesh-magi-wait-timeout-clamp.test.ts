import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAGI_DEFAULT_WAIT_MS,
    MAGI_MAX_WAIT_MS,
    resolveMagiWaitTimeoutMs,
} from '../src/tools/mesh-tools.js';

// ─── MAGI-DEADLINE-MISLABEL (A): default/max wait budget ─────────────────────
//
// A live 3-replica fan-out measured kimi taking 16m09s to answer against the then
// 180_000ms (3 min) deadline: collect force-finalized it 13 minutes before kimi
// actually answered. The default was raised to 480_000ms (8 min) and the ceiling to
// 1_200_000ms (20 min) so a slow-but-real replica has room to land, while `wait:false`
// + mesh_magi_collect remains the recommended way to avoid blocking the coordinator
// at all for reviews that may run long.
//
// resolveMagiWaitTimeoutMs is the exact clamp expression both mesh_magi_review and
// mesh_magi_collect apply to `wait_timeout_ms` — testing it directly (pure, no mesh
// context, no real/mocked wall-clock wait) proves the raised constants are the values
// ACTUALLY WIRED into request handling, not just declared and unused.

test('A: the raised constants are the values in effect (not the old 180_000 / 600_000)', () => {
    assert.equal(MAGI_DEFAULT_WAIT_MS, 480_000, 'default must be the new 8-minute budget, not the old 3-minute one');
    assert.equal(MAGI_MAX_WAIT_MS, 1_200_000, 'ceiling must be the new 20-minute cap, not the old 10-minute one');
    // The measured kimi overrun (16m09s = 969_000ms) must fit under the new ceiling —
    // the whole point of raising it.
    assert.ok(969_000 <= MAGI_MAX_WAIT_MS, 'the measured kimi completion time must fit under the new ceiling');
    assert.ok(969_000 > 600_000, 'sanity: the measured time exceeds the OLD ceiling (proves the old cap was insufficient)');
});

test('A: omitting wait_timeout_ms resolves to the new default (480_000ms), not the old default (180_000ms)', () => {
    assert.equal(resolveMagiWaitTimeoutMs(undefined), 480_000);
    assert.equal(resolveMagiWaitTimeoutMs(null), 480_000);
    assert.equal(resolveMagiWaitTimeoutMs(0), 480_000, '0 is falsy — falls back to the default, same as undefined');
    assert.equal(resolveMagiWaitTimeoutMs(NaN), 480_000);
    assert.equal(resolveMagiWaitTimeoutMs('not-a-number'), 480_000);
});

test('A: an explicit wait_timeout_ms far above the ceiling is CLAMPED to the new max (1_200_000ms), not the old max (600_000ms)', () => {
    assert.equal(resolveMagiWaitTimeoutMs(999_999_999), 1_200_000);
    // Specifically: a value between the OLD and NEW ceiling must now be honored in
    // full rather than clamped down to the old 600_000 — this is what actually gives
    // a `wait:true` caller enough room to cover the measured 16m09s kimi case.
    assert.equal(resolveMagiWaitTimeoutMs(900_000), 900_000, 'a value above the OLD ceiling but below the NEW one must pass through unclamped');
});

test('A: an explicit wait_timeout_ms within range passes through unmodified', () => {
    assert.equal(resolveMagiWaitTimeoutMs(240_000), 240_000);
});

test('A: an explicit wait_timeout_ms below the poll interval floor is raised to the floor (5_000ms)', () => {
    assert.equal(resolveMagiWaitTimeoutMs(100), 5_000);
    assert.equal(resolveMagiWaitTimeoutMs(-1), 5_000, 'a negative value is truthy in JS (only 0/NaN/"" are falsy) so it skips the default, but Math.max still floors it to the poll interval');
});
