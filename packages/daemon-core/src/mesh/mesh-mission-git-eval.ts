/**
 * Mission-level git projection (design 2026-11-01-mission-git-refs §3.3, §5): turns the
 * stored per-ref verdicts into a `MissionGitState`, serializes evaluation (concurrency 1),
 * applies the 10-minute TTL and records the one `git_state_changed` event per transition.
 *
 * ★`landed` means "the referenced changes are on the base" and NOTHING more. It does not
 * imply live acceptance, completion or that remaining items are done, and this module —
 * like the evaluator — never changes a mission's status, outcome or items. That is a
 * source-shape invariant (test/mesh/mission-git-eval-readonly-shape.test.ts): do not
 * import a mission/item write API here.
 *
 * Exported for other consumers (release objects, assistant, dashboard): `MissionGitState`
 * (re-exported from mesh-shared), `readMissionGitState`, `evaluateMissionGitState`.
 */
import { aggregateMissionGitState, type MissionGitState, type MissionRefGitEval } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { missionRefEvals, recordGitStateTransition } from './mesh-mission-ref-evals-store.js';
import { collectMissionRefTargets, evaluateMissionRefs, type MissionRefEvalEnv } from './mission-ref-evaluator.js';

export type { MissionGitState, MissionGitStateValue, MissionRefGitEval, MissionRefGitStatus } from '@adhdev/mesh-shared';

/** Cached verdicts older than this are re-evaluated lazily on read (design §5 ②). */
export const MISSION_GIT_EVAL_TTL_MS = 10 * 60_000;

function project(missionId: string, rows: readonly MissionRefGitEval[], targetKeys: ReadonlySet<string> | null, nowMs: number): MissionGitState {
    // Only rows of refs still on the mission's items vote (a removed ref must not keep a verdict alive).
    const live = targetKeys ? rows.filter(r => targetKeys.has(`${r.itemId}\u0000${r.refKey}`)) : [...rows];
    const unevaluated = targetKeys ? targetKeys.size - live.length : 0;
    const agg = aggregateMissionGitState(live.map(r => r.status));
    // Targets that have no verdict yet count as unknown — never as "not landed".
    const counts = { ...agg.counts, total: agg.counts.total + unevaluated, unknown: agg.counts.unknown + unevaluated };
    const state = unevaluated > 0 && agg.state === 'no_refs' ? 'unknown'
        : unevaluated > 0 && agg.state === 'landed' ? 'partial'
        : unevaluated > 0 && agg.state === 'not_landed' ? 'unknown'
        : agg.state;
    const partialUnknown = state === 'partial' && counts.unknown > 0;
    const newest = [...live].sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1))[0];
    const oldestAt = live.reduce<string | undefined>((acc, r) => (acc === undefined || r.evaluatedAt < acc ? r.evaluatedAt : acc), undefined);
    const stale = unevaluated > 0 || (oldestAt !== undefined && nowMs - Date.parse(oldestAt) > MISSION_GIT_EVAL_TTL_MS);
    return {
        missionId,
        state,
        partialUnknown,
        counts,
        ...(newest?.baseRef ? { baseRef: newest.baseRef } : {}),
        ...(newest?.baseSha ? { baseSha: newest.baseSha } : {}),
        ...(oldestAt ? { evaluatedAt: oldestAt } : {}),
        stale,
        refs: live,
    };
}

/** Cached projection of one mission. Pure read: no git, no network. */
export function readMissionGitState(meshId: string, missionId: string, nowMs: number = Date.now()): MissionGitState {
    const keys = new Set(collectMissionRefTargets(meshId, missionId).map(t => `${t.itemId}\u0000${t.refKey}`));
    return project(missionId, missionRefEvals().list(meshId, missionId), keys, nowMs);
}

/** Cached projections of several missions (list views). Pure read. */
export function readMissionGitStates(meshId: string, missionIds: readonly string[], nowMs: number = Date.now()): Map<string, MissionGitState> {
    const byMission = missionRefEvals().listByMesh(meshId);
    const out = new Map<string, MissionGitState>();
    for (const id of missionIds) {
        const keys = new Set(collectMissionRefTargets(meshId, id).map(t => `${t.itemId}\u0000${t.refKey}`));
        out.set(id, project(id, byMission.get(id) ?? [], keys, nowMs));
    }
    return out;
}

// ─── serialized evaluation ───────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<MissionGitState>>();
const durationsMs: number[] = [];

/**
 * Evaluate (and persist) one mission's refs, then project. One at a time across the
 * daemon (concurrency 1); concurrent callers for the same mission share one run.
 * Records `git_state_changed` only when the projected state differs from the last one.
 */
export function evaluateMissionGitState(meshId: string, missionId: string, env: MissionRefEvalEnv): Promise<MissionGitState> {
    const key = `${meshId}\u0000${missionId}`;
    const running = inFlight.get(key);
    if (running) return running;
    const run = chain.then(async () => {
        const started = Date.now();
        await evaluateMissionRefs(meshId, missionId, env);
        const state = readMissionGitState(meshId, missionId, (env.now ?? Date.now)());
        recordGitStateTransition(meshId, missionId, state.state, state.baseSha);
        durationsMs.push(Date.now() - started);
        if (durationsMs.length > 200) durationsMs.shift();
        return state;
    });
    const tracked = run.finally(() => { inFlight.delete(key); });
    inFlight.set(key, tracked);
    chain = tracked.catch(() => undefined);
    return tracked;
}

/**
 * Fire-and-forget refresh of every stale mission in `missionIds` (cached answer is
 * returned to the caller first; the next read sees the new rows). Never throws.
 */
export function scheduleStaleMissionGitEvals(meshId: string, states: Iterable<MissionGitState>, envFactory: () => MissionRefEvalEnv | null): void {
    for (const s of states) {
        if (!s.stale) continue;
        try {
            const env = envFactory();
            if (!env) return;
            void evaluateMissionGitState(meshId, s.missionId, env).catch(e => LOG.debug('MeshMissions', `lazy git eval failed for ${s.missionId}: ${e?.message || e}`));
        } catch { /* best effort */ }
    }
}

/** Local-only operational metrics (design §2): evaluation latency p95 and the unknown-reason spread. */
export function missionGitEvalMetrics(meshId: string): { byState: Record<string, number>; unknownReasons: Record<string, number>; p95Ms: number | null } {
    const byMission = missionRefEvals().listByMesh(meshId);
    const byState: Record<string, number> = {};
    const unknownReasons: Record<string, number> = {};
    for (const [missionId, rows] of byMission) {
        const s = project(missionId, rows, null, Date.now());
        byState[s.state] = (byState[s.state] ?? 0) + 1;
        for (const r of rows) if (r.status === 'unknown') {
            const reason = String(r.detail?.unknownReason ?? 'unspecified');
            unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;
        }
    }
    const sorted = [...durationsMs].sort((a, b) => a - b);
    return { byState, unknownReasons, p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null };
}
