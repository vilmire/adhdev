// ---------------------------------------------------------------------------
// turn-ledger/targets — which open attempts the scheduler probes, and where
// ---------------------------------------------------------------------------
// Wiring-unification Phase C4 (C-W4). `probeDue()` is a ledger QUERY, not a
// scan of queue rows, direct-dispatch rows, acked-hold rows and live-session
// lists the way the reconcile loop's PHASE 2.5 / 4 / 5 did. An attempt is due
// when the ledger itself says a transcript read could change its state:
//
//   * forced            — the reducer asked (H4 `probe` effect / bus edge);
//   * a transcript hold — weak_candidate / live_pending / transcript_quiet are
//                         released by what the transcript says right now, so
//                         they are read every tick (min spacing = tickMs);
//   * delivered, quiet  — the in-turn-progress gate: a native-source worker
//                         emits no PTY turn start, so a post-delivery agent
//                         bubble is the consumed proof (retro turn_started);
//   * running, quiet    — consumed / generating / finalizing with no activity
//                         for quietWindowMs: the lost-completion / dead-worker
//                         net, re-read at most every authoritativeTranscriptAgeMs.
//
// Suspended attempts wait on a human; accepted ones on the await_delivery
// hold; plain (dashboard) turns only when forced. Only attempts THIS daemon
// owns are probed — a foreign attempt's owner probes it.
//
// Locality: local = the session registry has the session (0 get_status_metadata
// for the local node, B4); remote = the node's daemon via the P-γ 5 s cached
// status probe (probe.ts).
// ---------------------------------------------------------------------------

import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../../boot/daemon-components.js';
import { readMeshNodeDaemonId } from '../mesh-node-identity.js';
import { authoritativeTranscriptAgeMs, type TurnPolicy } from './policy.js';
import { TRANSCRIPT_PROBE_HOLDS, turnStartBoundary, type ProbeLocation } from './probe.js';
import type { TurnStore } from './store.js';
import type { HoldReason, TurnAttempt } from './types.js';

export interface ProbeTarget {
    attempt: TurnAttempt;
    /** Active hold reasons (drives whether the transcript must be read). */
    holds: HoldReason[];
    forced: boolean;
}

export interface SelectProbeTargetsInput {
    store: TurnStore;
    selfDaemonId: string;
    nowMs: number;
    policy: TurnPolicy;
    /** Attempt ids the reducer asked to probe now (H4 / bus). */
    forced?: ReadonlySet<string>;
    /** Per-tick cap (oldest-probed first). */
    limit?: number;
}

export const DEFAULT_PROBE_LIMIT_PER_TICK = 32;

interface ProbeRow { attempt_id: string; last_probe_at: number | null }
interface HoldRow { attempt_id: string; reason: HoldReason }

/** Pure due rule (exported for the table test). */
export function isProbeDue(
    attempt: TurnAttempt,
    holds: readonly HoldReason[],
    lastProbeAt: number | null,
    nowMs: number,
    policy: TurnPolicy,
    forced: boolean,
): boolean {
    if (forced) return true;
    if (attempt.scope === 'plain') return false;
    const sinceProbe = lastProbeAt === null ? Number.POSITIVE_INFINITY : nowMs - lastProbeAt;
    if (holds.some((h) => TRANSCRIPT_PROBE_HOLDS.includes(h))) return sinceProbe >= policy.tickMs;
    const reprobeMs = authoritativeTranscriptAgeMs(policy);
    switch (attempt.state) {
        case 'delivered': {
            const deliveredAt = attempt.deliveredAt ?? attempt.acceptedAt;
            return nowMs - deliveredAt >= policy.quietWindowMs && sinceProbe >= reprobeMs;
        }
        case 'consumed':
        case 'generating':
        case 'finalizing': {
            const quietSince = Math.max(attempt.lastActivityAt ?? 0, turnStartBoundary(attempt));
            return nowMs - quietSince >= policy.quietWindowMs && sinceProbe >= reprobeMs;
        }
        default:
            return false;
    }
}

/** The attempts the scheduler probes this tick. A read-only query; no writes. */
export function selectProbeTargets(input: SelectProbeTargetsInput): ProbeTarget[] {
    const { store, selfDaemonId, nowMs, policy } = input;
    const forced = input.forced ?? new Set<string>();
    const open = store.listOpenAttempts().filter((a) => daemonIdsEquivalent(a.ownerDaemonId, selfDaemonId));
    if (open.length === 0) return [];
    const lastProbe = new Map<string, number | null>();
    for (const row of store.db.prepare('SELECT attempt_id, last_probe_at FROM turn_attempts WHERE terminal_outcome IS NULL').all() as ProbeRow[]) {
        lastProbe.set(row.attempt_id, row.last_probe_at);
    }
    const holdsByAttempt = new Map<string, HoldReason[]>();
    for (const row of store.db.prepare(`SELECT attempt_id, reason FROM turn_holds WHERE status = 'active'`).all() as HoldRow[]) {
        const list = holdsByAttempt.get(row.attempt_id);
        if (list) list.push(row.reason);
        else holdsByAttempt.set(row.attempt_id, [row.reason]);
    }
    const due: Array<ProbeTarget & { lastProbeAt: number }> = [];
    for (const attempt of open) {
        const holds = holdsByAttempt.get(attempt.attemptId) ?? [];
        const isForced = forced.has(attempt.attemptId);
        const probedAt = lastProbe.get(attempt.attemptId) ?? null;
        if (!isProbeDue(attempt, holds, probedAt, nowMs, policy, isForced)) continue;
        due.push({ attempt, holds, forced: isForced, lastProbeAt: probedAt ?? 0 });
    }
    due.sort((a, b) => (Number(b.forced) - Number(a.forced)) || (a.lastProbeAt - b.lastProbeAt));
    return due.slice(0, input.limit ?? DEFAULT_PROBE_LIMIT_PER_TICK).map(({ lastProbeAt: _drop, ...target }) => target);
}

type LocationComponents = Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager'> & {
    /** Mesh membership view (config ∪ router inline cache) — getMeshWithCache. */
    resolveMesh?: (meshId: string) => { nodes?: Array<Record<string, unknown>> } | undefined;
};

/**
 * Local when this daemon hosts the session (registry — no status RPC) or the
 * node's daemon IS this daemon; remote when the mesh node names another
 * daemon; unknown when neither can be told.
 */
export function resolveProbeLocation(components: LocationComponents, attempt: TurnAttempt, selfDaemonId: string): ProbeLocation {
    if (components.sessionRegistry.has(attempt.sessionId)) return { kind: 'local' };
    try {
        if (components.instanceManager.getInstance(attempt.sessionId)) return { kind: 'local' };
    } catch { /* fall through to the mesh view */ }
    if (!attempt.meshId || !attempt.nodeId) return { kind: 'local' };
    const mesh = components.resolveMesh?.(attempt.meshId);
    const node = mesh?.nodes?.find((n) => meshNodeIdMatches(n as never, attempt.nodeId!));
    if (!node) return { kind: 'unknown' };
    const daemonId = readMeshNodeDaemonId(node);
    if (!daemonId || daemonIdsEquivalent(daemonId, selfDaemonId)) return { kind: 'local' };
    const workspace = typeof node.workspace === 'string' ? node.workspace : undefined;
    return { kind: 'remote', daemonId, ...(workspace ? { workspace } : {}) };
}
