// ---------------------------------------------------------------------------
// mesh-reconcile-v2-backstop — last-resort completion backstop counters
// ---------------------------------------------------------------------------
// Pure move out of mesh-reconcile-loop.ts (no behavior change).
//
// T6 (B3c): PHASE-4 synthesis + acked-hold fast-track demoted to last-resort.
//
// Under mesh-protocol-v2 enforce, the completion contract is explicit: a worker's
// terminal emit is a v2 unicast event drained straight to the coordinator. The
// PHASE-4 transcript-synthesis backstop and the acked-hold fast-track exist to
// paper over a LOST emit — they should NEVER fire once v2 delivery is healthy. So
// their firing is now a demoted last-resort signal: every fire bumps a counter, and
// under enforce a fire additionally emits a WARN naming it a v2-contract violation
// (a real emit was expected but never arrived). Target = 0 fires in steady state.
//
// The code is NOT removed — it stays as the correctness net for a genuinely lost
// emit (rollout plan §B3c: "코드 삭제는 하지 않고 관측 후 다음 사이클에 판단"). Process-
// lifetime totals; read by tests + surfaced in mesh_status.
// ---------------------------------------------------------------------------

import { LOG } from '../logging/logger.js';

const meshV2BackstopCounters = {
    /** PHASE-4 transcript synthesis actually reconciled a missing completion. */
    phase4SynthesisFired: 0,
    /** Acked-hold transcript fast-track promoted a synth ahead of the death deadline. */
    ackedHoldFastTrackFired: 0,
    /** Acked-hold death-deadline backstop released a held synth (the 8-min net). */
    ackedHoldDeathDeadlineFired: 0,
};

/** Test/observability accessor for the v2 last-resort backstop counters (snapshot). */
export function getMeshV2BackstopCounters(): Readonly<typeof meshV2BackstopCounters> {
    return { ...meshV2BackstopCounters };
}

/** Test helper: zero the backstop counters so a case starts from a clean slate. */
export function __resetMeshV2BackstopCountersForTests(): void {
    for (const k of Object.keys(meshV2BackstopCounters) as Array<keyof typeof meshV2BackstopCounters>) {
        meshV2BackstopCounters[k] = 0;
    }
}

/** Enforce switch mirror (see isMeshProtocolV2EnforceEnabled in mesh-events-pending);
 *  re-read here (not imported) to keep the reconcile loop free of a cross-file coupling
 *  and to read env at fire time. On by default; set MESH_PROTOCOL_V2_ENFORCE=0/false/
 *  off/no to disable. Same vocabulary as the source of truth. */
function meshProtocolV2EnforceOn(): boolean {
    const raw = process.env.MESH_PROTOCOL_V2_ENFORCE;
    if (typeof raw !== 'string' || !raw.trim()) return true;   // unset/blank = default ON
    const v = raw.trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Bump a backstop counter and, under enforce, WARN that a last-resort net fired —
 *  which under a healthy v2 contract should not happen (the real emit was lost). */
export function recordBackstopFire(kind: keyof typeof meshV2BackstopCounters, detail: string): void {
    meshV2BackstopCounters[kind]++;
    if (meshProtocolV2EnforceOn()) {
        LOG.warn('MeshReconcileV2', `v2 ENFORCE last-resort backstop fired (${kind}): ${detail}. Under a healthy v2 completion contract this should be 0 — a worker's real terminal emit was lost/late.`);
    }
}
