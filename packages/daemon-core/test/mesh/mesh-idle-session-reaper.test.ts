import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
    planIdleSessionReap,
    runIdleSessionReapPass,
    resetIdleSessionReapCounter,
    getIdleSessionReapCount,
    type ReapableSessionRecord,
    type IdleSessionReaperDeps,
} from '../../src/mesh/mesh-idle-session-reaper.js';
import {
    resolveDelegatedSessionIdleTtlMinutes,
    resolveDelegatedSessionIdleTtlMs,
    mergeAndNormalizePolicy,
    DEFAULT_MESH_POLICY,
    DEFAULT_DELEGATED_SESSION_IDLE_TTL_MINUTES,
    MESH_DELEGATED_SESSION_IDLE_TTL_MIN_MINUTES,
    MESH_DELEGATED_SESSION_IDLE_TTL_MAX_MINUTES,
} from '../../src/repo-mesh-types.js';
import { isIdleSessionState } from '../../src/mesh/mesh-candidacy-predicates.js';

const MESH_ID = 'mesh_reaper_test';
const NOW = 1_800_000_000_000;
const TTL_MS = 30 * 60_000;

/** A delegate that is reapable unless a test overrides a field. */
function delegate(over: Partial<ReapableSessionRecord> = {}): ReapableSessionRecord {
    return {
        sessionId: 'sess_delegate',
        lastActivityAt: NOW - 31 * 60_000, // 31 min idle — just past the 30 min TTL
        lifecycle: 'running',
        surfaceKind: 'live_runtime',
        meta: { launchedByCoordinator: true, meshNodeFor: MESH_ID, meshNodeId: 'node_a' },
        ...over,
    };
}

function plan(records: ReapableSessionRecord[], activeWork: string[] = [], ttlMs = TTL_MS) {
    return planIdleSessionReap({
        meshId: MESH_ID,
        records,
        activeWorkSessionIds: new Set(activeWork),
        ttlMs,
        now: NOW,
    });
}

const reaped = (records: ReapableSessionRecord[], activeWork: string[] = [], ttlMs = TTL_MS) =>
    plan(records, activeWork, ttlMs).reap.map(r => r.sessionId);

describe('planIdleSessionReap — reaps an idle delegate', () => {
    it('reaps a coordinator-launched delegate idle past the TTL', () => {
        const result = plan([delegate()]);
        expect(result.reap).toHaveLength(1);
        expect(result.reap[0].sessionId).toBe('sess_delegate');
        expect(result.reap[0].idleMs).toBe(31 * 60_000);
    });

    it('reaps exactly at the TTL boundary (idle === ttl)', () => {
        expect(reaped([delegate({ lastActivityAt: NOW - TTL_MS })])).toEqual(['sess_delegate']);
    });
});

// ── RED/GREEN core: each exclusion, proven by flipping ONE field ──────────────
// Every case below asserts BOTH directions: the same record IS reaped when the
// excluding field is removed. A guard that silently stopped excluding would keep
// the "not reaped" half passing, so the paired assertion is what makes these real.
describe('planIdleSessionReap — exclusions', () => {
    it('does NOT reap a session idle less than the TTL (29m < 30m)', () => {
        const young = delegate({ lastActivityAt: NOW - 29 * 60_000 });
        expect(reaped([young])).toEqual([]);
        expect(plan([young]).skipped[0].reason).toBe('within_ttl');
        // green: the same record one minute older IS reaped
        expect(reaped([delegate({ lastActivityAt: NOW - 31 * 60_000 })])).toEqual(['sess_delegate']);
    });

    it('does NOT reap a session holding an active task', () => {
        const busy = delegate({ sessionId: 'sess_busy' });
        expect(reaped([busy], ['sess_busy'])).toEqual([]);
        expect(plan([busy], ['sess_busy']).skipped[0].reason).toBe('holds_active_task');
        // green: same record, no active-work binding
        expect(reaped([busy], [])).toEqual(['sess_busy']);
    });

    it('does NOT reap the coordinator session', () => {
        const coordinator = delegate({
            sessionId: 'sess_coord',
            meta: { launchedByCoordinator: true, meshCoordinatorFor: MESH_ID },
        });
        expect(reaped([coordinator])).toEqual([]);
        expect(plan([coordinator]).skipped[0].reason).toBe('coordinator_session');
        // green: same record without the coordinator marker
        expect(reaped([delegate({ sessionId: 'sess_coord' })])).toEqual(['sess_coord']);
    });

    it('does NOT reap a session the owner opened directly (no launchedByCoordinator)', () => {
        const userOpened = delegate({ sessionId: 'sess_user', meta: { meshNodeFor: MESH_ID } });
        expect(reaped([userOpened])).toEqual([]);
        expect(plan([userOpened]).skipped[0].reason).toBe('not_coordinator_launched');
        // green: same record WITH the delegate marker
        expect(reaped([delegate({ sessionId: 'sess_user' })])).toEqual(['sess_user']);
    });

    it('fails closed when launchedByCoordinator is merely truthy-ish, not true', () => {
        // A string 'true' or 1 must NOT satisfy the delegate check — the marker is a
        // strict boolean, and loosening it would put owner sessions in scope.
        for (const bogus of ['true', 1, {}, 'yes']) {
            const rec = delegate({ meta: { launchedByCoordinator: bogus as any, meshNodeFor: MESH_ID } });
            expect(reaped([rec])).toEqual([]);
        }
    });

    it('does NOT reap a delegate belonging to another mesh', () => {
        const other = delegate({
            sessionId: 'sess_other',
            meta: { launchedByCoordinator: true, meshNodeFor: 'mesh_somewhere_else' },
        });
        expect(reaped([other])).toEqual([]);
        expect(plan([other]).skipped[0].reason).toBe('other_mesh');
    });

    it('does NOT reap a non-live runtime (already stopped / snapshot record)', () => {
        for (const over of [
            { lifecycle: 'stopped' },
            { lifecycle: 'failed' },
            { surfaceKind: 'inactive_record' },
            { surfaceKind: 'recovery_snapshot' },
        ]) {
            const rec = delegate(over as Partial<ReapableSessionRecord>);
            expect(reaped([rec])).toEqual([]);
            expect(plan([rec]).skipped[0].reason).toBe('not_live_runtime');
        }
    });

    it('does NOT reap a record with no lastActivityAt (cannot be aged)', () => {
        const noStamp = delegate({ lastActivityAt: undefined });
        expect(reaped([noStamp])).toEqual([]);
        expect(plan([noStamp]).skipped[0].reason).toBe('missing_last_activity');
    });

    it('reaps only the eligible session out of a mixed set', () => {
        const records = [
            delegate({ sessionId: 'reap_me' }),
            delegate({ sessionId: 'coord', meta: { launchedByCoordinator: true, meshCoordinatorFor: MESH_ID } }),
            delegate({ sessionId: 'user', meta: { meshNodeFor: MESH_ID } }),
            delegate({ sessionId: 'young', lastActivityAt: NOW - 60_000 }),
            delegate({ sessionId: 'busy' }),
        ];
        expect(reaped(records, ['busy'])).toEqual(['reap_me']);
    });
});

describe('planIdleSessionReap — TTL disabled', () => {
    it('reaps nothing when ttlMs is 0, however idle the session is', () => {
        const ancient = delegate({ lastActivityAt: NOW - 30 * 24 * 60 * 60_000 });
        expect(reaped([ancient], [], 0)).toEqual([]);
        expect(plan([ancient], [], 0).skipped).toEqual([]);
    });
});

describe('resolveDelegatedSessionIdleTtlMinutes', () => {
    it('defaults to 30 minutes (owner decision 2026-08-28)', () => {
        expect(DEFAULT_DELEGATED_SESSION_IDLE_TTL_MINUTES).toBe(30);
        expect(resolveDelegatedSessionIdleTtlMinutes(undefined)).toBe(30);
        expect(resolveDelegatedSessionIdleTtlMinutes(null)).toBe(30);
        expect(resolveDelegatedSessionIdleTtlMs(undefined)).toBe(30 * 60_000);
    });

    it('treats 0 and false as disabled', () => {
        expect(resolveDelegatedSessionIdleTtlMinutes(0)).toBe(0);
        expect(resolveDelegatedSessionIdleTtlMinutes(false)).toBe(0);
        expect(resolveDelegatedSessionIdleTtlMs(0)).toBe(0);
        expect(resolveDelegatedSessionIdleTtlMinutes(-5)).toBe(0);
    });

    it('clamps a too-small positive TTL up to the floor rather than honoring it', () => {
        expect(resolveDelegatedSessionIdleTtlMinutes(1)).toBe(MESH_DELEGATED_SESSION_IDLE_TTL_MIN_MINUTES);
    });

    it('clamps an oversized TTL to the ceiling', () => {
        expect(resolveDelegatedSessionIdleTtlMinutes(999_999)).toBe(MESH_DELEGATED_SESSION_IDLE_TTL_MAX_MINUTES);
    });

    it('falls back to the default for a non-numeric value', () => {
        expect(resolveDelegatedSessionIdleTtlMinutes('banana')).toBe(30);
    });

    it('is applied by mergeAndNormalizePolicy (default + explicit disable)', () => {
        expect(DEFAULT_MESH_POLICY.delegatedSessionIdleTtlMinutes).toBe(30);
        expect(mergeAndNormalizePolicy(undefined, undefined).delegatedSessionIdleTtlMinutes).toBe(30);
        expect(mergeAndNormalizePolicy(undefined, { delegatedSessionIdleTtlMinutes: false })
            .delegatedSessionIdleTtlMinutes).toBe(0);
        // a hand-edited meshes.json with a nonsense value normalizes, never crashes
        expect(mergeAndNormalizePolicy(undefined, { delegatedSessionIdleTtlMinutes: 2 })
            .delegatedSessionIdleTtlMinutes).toBe(MESH_DELEGATED_SESSION_IDLE_TTL_MIN_MINUTES);
    });
});

// ── Requirement 3: a reaped session must leave the reuse pool ─────────────────
// The reaper stops the runtime; nothing explicitly de-registers it as a drain
// candidate. That is correct ONLY because isIdleSessionState rejects terminal
// statuses. If that predicate ever stopped treating 'stopped' as terminal, the
// queue would dispatch to a dead session (the dispatch-failure class the
// delivered-not-consumed redrive work already paid for). Lock it here.
describe('reuse-pool exclusion after a reap', () => {
    it('a stopped session is not an idle drain candidate', () => {
        expect(isIdleSessionState({ status: 'stopped' })).toBe(false);
        expect(isIdleSessionState({ status: 'failed' })).toBe(false);
        expect(isIdleSessionState({ status: 'terminated' })).toBe(false);
        expect(isIdleSessionState({ status: 'exited' })).toBe(false);
    });

    it('a stopped session stays excluded even if its chat still reads waiting_input', () => {
        // The terminal check runs FIRST, before the waiting_input branch — a stale
        // activeChat on a killed runtime must not resurrect it as a candidate.
        expect(isIdleSessionState({ status: 'stopped', activeChat: { status: 'waiting_input' } })).toBe(false);
    });

    it('a live idle session IS still a drain candidate (the reaper does not over-exclude)', () => {
        expect(isIdleSessionState({ status: 'idle' })).toBe(true);
    });
});

describe('runIdleSessionReapPass', () => {
    let stopCalls: Array<{ sessionIds: string[]; mode: string }>;
    let deps: IdleSessionReaperDeps;

    const makeDeps = (records: ReapableSessionRecord[]): IdleSessionReaperDeps => ({
        listSessions: async () => records,
        cleanupMeshSessions: async (args: any) => {
            stopCalls.push({ sessionIds: args.sessionIds, mode: args.mode });
            return { success: true };
        },
    });

    beforeEach(() => {
        resetIdleSessionReapCounter();
        stopCalls = [];
        deps = makeDeps([delegate()]);
    });

    it('stops an idle delegate via cleanupMeshSessions with mode "stop" (record preserved)', async () => {
        const out = await runIdleSessionReapPass(deps, { meshId: MESH_ID, policy: undefined, now: NOW });
        expect(out.stoppedSessionIds).toEqual(['sess_delegate']);
        expect(stopCalls).toHaveLength(1);
        // 'stop' — NOT delete_stopped/stop_and_delete: the record must survive.
        expect(stopCalls[0].mode).toBe('stop');
        expect(stopCalls[0].sessionIds).toEqual(['sess_delegate']);
    });

    it('increments the reap counter for observability', async () => {
        expect(getIdleSessionReapCount()).toBe(0);
        await runIdleSessionReapPass(deps, { meshId: MESH_ID, policy: undefined, now: NOW });
        expect(getIdleSessionReapCount()).toBe(1);
    });

    it('does nothing when the policy disables the TTL — not even a listSessions call', async () => {
        const listSessions = vi.fn(async () => [delegate()]);
        const out = await runIdleSessionReapPass(
            { ...deps, listSessions },
            { meshId: MESH_ID, policy: { delegatedSessionIdleTtlMinutes: 0 } as any, now: NOW },
        );
        expect(out.stoppedSessionIds).toEqual([]);
        expect(stopCalls).toEqual([]);
        expect(listSessions).not.toHaveBeenCalled();
    });

    it('plans but does not stop under dryRun', async () => {
        const out = await runIdleSessionReapPass(deps, {
            meshId: MESH_ID, policy: undefined, now: NOW, dryRun: true,
        });
        expect(out.plan.reap.map(r => r.sessionId)).toEqual(['sess_delegate']);
        expect(out.stoppedSessionIds).toEqual([]);
        expect(stopCalls).toEqual([]);
    });

    it('honors a custom TTL from policy', async () => {
        // 31 min idle: reaped at the 30 min default, kept at a 60 min policy TTL.
        const out = await runIdleSessionReapPass(deps, {
            meshId: MESH_ID, policy: { delegatedSessionIdleTtlMinutes: 60 } as any, now: NOW,
        });
        expect(out.stoppedSessionIds).toEqual([]);
    });

    it('keeps reaping siblings when one stop throws', async () => {
        const records = [delegate({ sessionId: 'boom' }), delegate({ sessionId: 'ok' })];
        const failingDeps: IdleSessionReaperDeps = {
            listSessions: async () => records,
            cleanupMeshSessions: async (args: any) => {
                if (args.sessionIds[0] === 'boom') throw new Error('stop failed');
                stopCalls.push({ sessionIds: args.sessionIds, mode: args.mode });
                return { success: true };
            },
        };
        const out = await runIdleSessionReapPass(failingDeps, { meshId: MESH_ID, policy: undefined, now: NOW });
        expect(out.stoppedSessionIds).toEqual(['ok']);
    });

    it('returns empty (never throws) when listSessions fails', async () => {
        const out = await runIdleSessionReapPass(
            { ...deps, listSessions: async () => { throw new Error('host down'); } },
            { meshId: MESH_ID, policy: undefined, now: NOW },
        );
        expect(out.stoppedSessionIds).toEqual([]);
        expect(stopCalls).toEqual([]);
    });
});
