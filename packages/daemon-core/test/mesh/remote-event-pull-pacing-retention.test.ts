import { describe, it, expect, beforeEach } from 'vitest';
import {
    __resetRemoteEventPullPacingForTests,
    __noteRemotePullResultForTests,
    __readRemoteEventPullPacingStateForTests,
    __REMOTE_PULL_PACING_BOUNDS_FOR_TESTS as BOUNDS,
} from '../../src/mesh/mesh-remote-event-pull.js';
import { applyBoundedRetention, setWithBoundedRetention } from '../../src/shared/bounded-retention.js';
import { canonicalDaemonId } from '@adhdev/mesh-shared';
import {
    __resetAutoPruneThrottleForTests,
    __noteAutoPruneRunForTests,
    __readAutoPruneThrottleStateForTests,
    __AUTO_PRUNE_THROTTLE_BOUNDS_FOR_TESTS as AUTO_PRUNE_BOUNDS,
} from '../../src/mesh/mesh-reconcile-loop.js';

// The pacing maps key on `${meshId}::${canonicalDaemonId(daemonId)}` so pacing stays
// stable when a daemon alternates identity forms. Build the same key here rather than
// asserting on the raw id — canonicalDaemonId strips the `daemon_` prefix.
const key = (meshId: string, daemonId: string) => `${meshId}::${canonicalDaemonId(daemonId) ?? daemonId}`;

// MEM-4 regression. Before the fix, `remotePullBackoffByDaemon` was deleted ONLY on a
// non-empty pull result and `lastRedrivePullAtMs` had no production delete path at all,
// so both grew with every distinct (mesh, daemon) pair the coordinator had ever pulled
// from — retired worktree clones, removed nodes, machines that went away — for the whole
// daemon lifetime. These tests drive the REAL module-private writer and assert the map
// is bounded, while pinning that entries still inside their pacing window survive.

const T0 = 1_700_000_000_000;

describe('MEM-4: remote-pull pacing map retention', () => {
    beforeEach(() => {
        __resetRemoteEventPullPacingForTests();
    });

    it('reproduces the growth shape: many distinct daemons each leave a backoff row', () => {
        // Each empty-but-reached pull writes a row keyed meshId::daemonId.
        for (let i = 0; i < 50; i++) {
            __noteRemotePullResultForTests('mesh_a', `daemon_${i}`, { received: 0, reached: true }, T0);
        }
        // Well under the cap and all within the TTL, so nothing is removed — this is the
        // pre-fix accumulation shape, now simply bounded rather than unbounded.
        expect(__readRemoteEventPullPacingStateForTests().backoffSize).toBe(50);
    });

    it('expires rows untouched past the TTL, and keeps rows inside it', () => {
        __noteRemotePullResultForTests('mesh_a', 'daemon_old', { received: 0, reached: true }, T0);
        // A second write far in the future triggers the sweep against that later `now`.
        const later = T0 + BOUNDS.ttlMs + 1;
        __noteRemotePullResultForTests('mesh_a', 'daemon_new', { received: 0, reached: true }, later);

        const state = __readRemoteEventPullPacingStateForTests();
        expect(state.backoffSize).toBe(1);
        expect(state.backoffKeys).toContain(key('mesh_a', 'daemon_new'));
        expect(state.backoffKeys).not.toContain(key('mesh_a', 'daemon_old'));
    });

    it('does NOT expire a row still inside the TTL (no early-drop regression)', () => {
        __noteRemotePullResultForTests('mesh_a', 'daemon_recent', { received: 0, reached: true }, T0);
        // One second short of the TTL — must survive.
        __noteRemotePullResultForTests('mesh_a', 'daemon_other', { received: 0, reached: true }, T0 + BOUNDS.ttlMs - 1000);

        const state = __readRemoteEventPullPacingStateForTests();
        expect(state.backoffSize).toBe(2);
        expect(state.backoffKeys).toContain(key('mesh_a', 'daemon_recent'));
    });

    it('caps cardinality at the backstop even when every row is inside the TTL', () => {
        const overshoot = BOUNDS.maxEntries + 25;
        for (let i = 0; i < overshoot; i++) {
            // Strictly increasing timestamps, all well inside the TTL, so ONLY the
            // cardinality backstop can remove anything.
            __noteRemotePullResultForTests('mesh_a', `daemon_${i}`, { received: 0, reached: true }, T0 + i);
        }
        const state = __readRemoteEventPullPacingStateForTests();
        expect(state.backoffSize).toBe(BOUNDS.maxEntries);
        // Oldest-first eviction: the newest daemon must still be present, the first gone.
        expect(state.backoffKeys).toContain(key('mesh_a', `daemon_${overshoot - 1}`));
        expect(state.backoffKeys).not.toContain(key('mesh_a', 'daemon_0'));
    });

    it('keeps the existing non-empty-result delete behavior', () => {
        __noteRemotePullResultForTests('mesh_a', 'daemon_x', { received: 0, reached: true }, T0);
        expect(__readRemoteEventPullPacingStateForTests().backoffSize).toBe(1);
        __noteRemotePullResultForTests('mesh_a', 'daemon_x', { received: 3, reached: true }, T0 + 100);
        expect(__readRemoteEventPullPacingStateForTests().backoffSize).toBe(0);
    });

    it('keeps the existing transport-failure behavior (no backoff evidence recorded)', () => {
        __noteRemotePullResultForTests('mesh_a', 'daemon_y', { received: 0, reached: false }, T0);
        expect(__readRemoteEventPullPacingStateForTests().backoffSize).toBe(0);
    });
});

describe('MEM-4: auto-prune throttle map retention', () => {
    beforeEach(() => {
        __resetAutoPruneThrottleForTests();
    });

    it('reproduces the growth shape: one row per mesh id ever hosted', () => {
        for (let i = 0; i < 40; i++) __noteAutoPruneRunForTests(`mesh_${i}`, T0);
        expect(__readAutoPruneThrottleStateForTests().size).toBe(40);
    });

    it('expires meshes untouched past the TTL, keeps ones inside it', () => {
        __noteAutoPruneRunForTests('mesh_gone', T0);
        __noteAutoPruneRunForTests('mesh_live', T0 + AUTO_PRUNE_BOUNDS.ttlMs + 1);
        const state = __readAutoPruneThrottleStateForTests();
        expect(state.keys).toEqual(['mesh_live']);
    });

    it('does NOT expire a mesh still inside the TTL', () => {
        __noteAutoPruneRunForTests('mesh_a', T0);
        __noteAutoPruneRunForTests('mesh_b', T0 + AUTO_PRUNE_BOUNDS.ttlMs - 1000);
        expect(__readAutoPruneThrottleStateForTests().size).toBe(2);
    });

    it('caps cardinality at the backstop, oldest first', () => {
        const overshoot = AUTO_PRUNE_BOUNDS.maxEntries + 10;
        for (let i = 0; i < overshoot; i++) __noteAutoPruneRunForTests(`mesh_${i}`, T0 + i);
        const state = __readAutoPruneThrottleStateForTests();
        expect(state.size).toBe(AUTO_PRUNE_BOUNDS.maxEntries);
        expect(state.keys).toContain(`mesh_${overshoot - 1}`);
        expect(state.keys).not.toContain('mesh_0');
    });
});

describe('bounded-retention helper semantics', () => {
    it('never expires an entry with a missing/zero timestamp via TTL', () => {
        const map = new Map<string, { at: number }>([['a', { at: 0 }]]);
        const r = applyBoundedRetention(map, {
            ttlMs: 1000,
            maxEntries: 10,
            readTimestamp: (v) => v.at,
            now: T0,
        });
        expect(r.expired).toBe(0);
        expect(map.size).toBe(1);
    });

    it('honours isProtected against BOTH the TTL sweep and the cardinality eviction', () => {
        const map = new Map<string, number>();
        for (let i = 0; i < 10; i++) map.set(`k${i}`, T0 - 10_000_000);
        const r = applyBoundedRetention(map, {
            ttlMs: 1000,
            maxEntries: 2,
            readTimestamp: (v) => v,
            now: T0,
            isProtected: (entryKey) => entryKey === 'k0',
        });
        expect(map.has('k0')).toBe(true);
        expect(r.expired).toBe(9);
    });

    it('setWithBoundedRetention never evicts the row it just wrote', () => {
        const map = new Map<string, number>();
        for (let i = 0; i < 20; i++) {
            setWithBoundedRetention(map, `k${i}`, T0 + i, { ttlMs: 60_000, maxEntries: 5 });
            expect(map.has(`k${i}`)).toBe(true);
        }
        expect(map.size).toBe(5);
    });
});
