// FOREIGN-TIMESTAMP AGE LOWER BOUND (2026-09-21)
//
// The defect class this suite freezes. Wherever the mesh computes
//     age = now - <foreign timestamp>
// and uses `age < threshold` to GRANT AN EXEMPTION, a future-dated stamp makes the
// age negative and the comparison UNCONDITIONALLY TRUE — so the exemption is granted
// forever and whatever safety action it suppresses never runs again. Foreign stamps
// (`autoLaunch.updatedAt`, queue `updatedAt`/`requeuedAt`, ledger `timestamp`) are
// written by other processes/machines and can legitimately lead this daemon's clock
// via node skew or an NTP step.
//
// ★The correct shape is REJECT, not clamp. `Math.max(0, age)` scores a future stamp
// as age 0 — "created this very instant", the freshest possible reading — which is the
// STRONGEST possible pass of an `age < threshold` exemption. These tests therefore
// assert the future case explicitly; a clamped implementation passes every
// ordinary-age case below and fails only these.
//
// House shape being mirrored: mesh-completion-live-gate.ts rejects
// `observedAt > nowMs + 2_000` as `stale_evidence_timestamp`; mesh-stall-watchdog.ts
// requires a non-negative `causalEvidenceAgeMs`; mesh-turn-presentation.ts keeps
// `rawAgeMs()` unclamped for decisions.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testConfigDir = join(tmpdir(), `adhdev-foreign-age-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import {
    isWithinForeignFreshnessWindow,
    isAutoLaunchWithinAwaitClaimWindow,
    FOREIGN_TIMESTAMP_FUTURE_SKEW_TOLERANCE_MS,
    AUTO_LAUNCH_AWAIT_CLAIM_MS,
} from '../../src/mesh/mesh-autolaunch-integrity.js';
import { bootstrapQueueTaskCountsAsHandled } from '../../src/mesh/mesh-event-delivery.js';
import {
    resolveTargetPinTtlVerdict,
    TARGET_SESSION_PIN_TTL_MS,
    __resetTargetPinGeneratingCreditForTests,
} from '../../src/mesh/mesh-skip-notify.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue.js';

const NOW = 1_800_000_000_000;

describe('isWithinForeignFreshnessWindow — the shared lower bound', () => {
    const WINDOW = 60_000;

    it('admits an ordinary in-window past stamp', () => {
        expect(isWithinForeignFreshnessWindow(NOW - 10_000, NOW, WINDOW)).toBe(true);
    });

    it('declines a stamp older than the window', () => {
        expect(isWithinForeignFreshnessWindow(NOW - WINDOW - 1, NOW, WINDOW)).toBe(false);
    });

    it('declines an unparseable stamp rather than inventing freshness', () => {
        expect(isWithinForeignFreshnessWindow(Number.NaN, NOW, WINDOW)).toBe(false);
    });

    // ★THE DEFECT. A clamped implementation returns true here (age 0 < window).
    it('REJECTS a far-future stamp instead of granting the exemption forever', () => {
        const oneHourAhead = NOW + 3_600_000;
        expect(isWithinForeignFreshnessWindow(oneHourAhead, NOW, WINDOW)).toBe(false);
    });

    it('rejects a future stamp even when the window is enormous', () => {
        // Under `Math.max(0, age)` a bigger window makes the bug MORE certain, never less.
        expect(isWithinForeignFreshnessWindow(NOW + 3_600_000, NOW, 24 * 3_600_000)).toBe(false);
    });

    // The control group: the bound must not be so aggressive that ordinary
    // same-machine write/read jitter is read as a hostile clock.
    it('tolerates sub-tolerance future jitter (control — must stay admitted)', () => {
        const jitter = NOW + (FOREIGN_TIMESTAMP_FUTURE_SKEW_TOLERANCE_MS - 1);
        expect(isWithinForeignFreshnessWindow(jitter, NOW, WINDOW)).toBe(true);
    });

    it('rejects just beyond the tolerance (boundary)', () => {
        const beyond = NOW + FOREIGN_TIMESTAMP_FUTURE_SKEW_TOLERANCE_MS + 1;
        expect(isWithinForeignFreshnessWindow(beyond, NOW, WINDOW)).toBe(false);
    });
});

describe('isAutoLaunchWithinAwaitClaimWindow — the await-claim specialisation', () => {
    it('admits a launch stamped inside the window', () => {
        expect(isAutoLaunchWithinAwaitClaimWindow(NOW - 1_000, NOW)).toBe(true);
    });

    it('declines a launch stamped outside the window', () => {
        expect(isAutoLaunchWithinAwaitClaimWindow(NOW - AUTO_LAUNCH_AWAIT_CLAIM_MS - 1, NOW)).toBe(false);
    });

    // ★A future `autoLaunch.updatedAt` previously held the await-claim window open
    // forever: the duplicate-launch guard never released, so the task sat `pending`
    // with no session and no retry.
    it('REJECTS a future-dated autoLaunch stamp (no permanent await-claim window)', () => {
        expect(isAutoLaunchWithinAwaitClaimWindow(NOW + 600_000, NOW)).toBe(false);
    });
});

describe('bootstrapQueueTaskCountsAsHandled — foreign autoLaunch.updatedAt', () => {
    const base = { status: 'pending', targetNodeId: 'node-a' };

    it('counts an in-window launch as handled', () => {
        const task = { ...base, autoLaunch: { status: 'completed', updatedAt: new Date(NOW - 5_000).toISOString() } };
        expect(bootstrapQueueTaskCountsAsHandled(task, 'node-a', NOW)).toBe(true);
    });

    it('stops counting an expired launch as handled (manual launch IS needed)', () => {
        const stamp = new Date(NOW - AUTO_LAUNCH_AWAIT_CLAIM_MS - 1_000).toISOString();
        const task = { ...base, autoLaunch: { status: 'completed', updatedAt: stamp } };
        expect(bootstrapQueueTaskCountsAsHandled(task, 'node-a', NOW)).toBe(false);
    });

    // ★A future stamp used to report "handled" permanently, so bootstrap never
    // surfaced a task whose launch had in fact never landed.
    it('does NOT report a future-dated launch as handled', () => {
        const future = new Date(NOW + 3_600_000).toISOString();
        const task = { ...base, autoLaunch: { status: 'completed', updatedAt: future } };
        expect(bootstrapQueueTaskCountsAsHandled(task, 'node-a', NOW)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// RC.20 TARGET-PIN TTL — the most severe instance of this class.
//
// The pin anchor (`requeuedAt`/`createdAt`) is foreign. `unproductiveAgeMs` was
// `Math.max(0, wallAgeMs - creditMs)`, so a future-dated anchor produced a negative
// wall age that the clamp floored to 0 — pinning the age at 0 so
// `unproductiveAgeMs >= TARGET_SESSION_PIN_TTL_MS` could NEVER be true. The pin
// became IMMORTAL, which is precisely the mesh_queue_requeue wedge the TTL exists to
// bound: the task sits 'pending' forever behind target_session_constraint.
// ---------------------------------------------------------------------------
function pinnedTask(anchorIso: string, targetSessionId = 'sess-target'): MeshWorkQueueEntry {
    return {
        id: 'task-1',
        meshId: 'mesh-1',
        targetSessionId,
        requeuedAt: anchorIso,
        createdAt: anchorIso,
    } as unknown as MeshWorkQueueEntry;
}

/** A components stub whose pinned session is absent locally → verdict UNKNOWN (never GENERATING). */
const NO_LIVE_SESSIONS = { instanceManager: { getByCategory: () => [] } } as any;

/** A components stub where the pinned session IS observably generating. */
const TARGET_GENERATING = {
    instanceManager: {
        getByCategory: () => [{
            getState: () => ({ instanceId: 'sess-target', status: 'generating', settings: {} }),
        }],
    },
} as any;

describe('resolveTargetPinTtlVerdict — foreign pin anchor', () => {
    beforeEach(() => __resetTargetPinGeneratingCreditForTests());

    it('does not expire a young pin', () => {
        const v = resolveTargetPinTtlVerdict(NO_LIVE_SESSIONS, pinnedTask(new Date(NOW - 60_000).toISOString()), NOW);
        expect(v.expired).toBe(false);
    });

    it('expires a pin past the TTL (the bound still works)', () => {
        const anchor = new Date(NOW - TARGET_SESSION_PIN_TTL_MS - 60_000).toISOString();
        const v = resolveTargetPinTtlVerdict(NO_LIVE_SESSIONS, pinnedTask(anchor), NOW);
        expect(v.expired).toBe(true);
    });

    // ★THE DEFECT. Under the clamp this returns expired:false with ageMs:0 forever.
    it('EXPIRES a future-dated pin instead of clamping it to an immortal age-0 pin', () => {
        const anchor = new Date(NOW + 3_600_000).toISOString();
        const v = resolveTargetPinTtlVerdict(NO_LIVE_SESSIONS, pinnedTask(anchor), NOW);
        expect(v.expired).toBe(true);
        // The reported age must stay NEGATIVE — the untrustworthy-clock signal is not
        // laundered into "freshest possible".
        expect(v.ageMs).toBeLessThan(0);
    });

    // ★CONTROL GROUP — the TTL-WHILE-WORKING invariant must survive the fix. A skewed
    // anchor whose addressee this daemon can WATCH GENERATING still suspends the clock;
    // only an addressee with no positive evidence of work expires.
    it('does NOT expire a future-dated pin whose target is observably GENERATING (control)', () => {
        const anchor = new Date(NOW + 3_600_000).toISOString();
        const v = resolveTargetPinTtlVerdict(TARGET_GENERATING, pinnedTask(anchor), NOW);
        expect(v.expired).toBe(false);
        expect(v.suspended).toBe(true);
    });

    // Control — sub-tolerance jitter is not a hostile clock.
    it('does not expire a pin only marginally ahead of our clock (control)', () => {
        const anchor = new Date(NOW + 500).toISOString();
        const v = resolveTargetPinTtlVerdict(NO_LIVE_SESSIONS, pinnedTask(anchor), NOW);
        expect(v.expired).toBe(false);
    });
});
