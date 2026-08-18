// ---------------------------------------------------------------------------
// mesh-provider-event-admission — routing the provider_event completion path
// through the single terminal-admission choke point.
// ---------------------------------------------------------------------------
// THE INCIDENT THIS EXISTS FOR
// ----------------------------
// 2026-08-18 10:49:31. A worker session emitted agent:generating_completed;
// 296ms later the turn ledger committed a terminal `completed`
// (source=provider_event, stage was finalizing) and the coordinator was
// notified. ONE SECOND EARLIER the same session had logged
// `completion_gate_hold / native_transcript_advancing` with msgCount=542: the
// transcript was demonstrably still growing. The turn had not ended.
//
// evaluateTerminalAdmission (mesh-terminal-admission.ts) already encodes the
// rule that stops exactly this — rule 6, the transcript_growing veto — but it
// had NO caller on this path. It was reachable only from the transcript POLL,
// which the same day's log shows produced zero completions (49/49 declined
// upstream of the gate). The gate was, in practice, dead code guarding a road
// nobody drove, while every real false completion came through here.
//
// So this module is not a new rule. It is the wiring that makes the existing
// rule apply to the path that actually produces terminals.
//
// WHY THIS IS NOT THE SAME AS THE LIVE-STATE GATE
// -----------------------------------------------
// mesh-completion-live-gate's MID-TURN-LIVE-STATE-GATE already re-checks live
// evidence at delivery time, and it is genuinely load-bearing — but its three
// discriminators (adapter-pending, modal-parked, trailing-tool-after-final) are
// all blind to a transcript that is simply STILL GROWING with no trailing tool
// bubble yet materialized in the tail. That is the 10:49 shape. The completion
// engine sees growth (decideCompletionVerdict rule 5 holds on
// `native_transcript_advancing`) but that hold is instance-local and bounded,
// and a provider-native event completion can bypass the engine flush entirely.
// This gate re-asks the question at the coordinator boundary, where the terminal
// is actually written.
//
// ★ THE LIVENESS CONTRACT — READ BEFORE CHANGING ANYTHING HERE
// ------------------------------------------------------------
// provider_event is ALSO the main path for GENUINE completions. If this gate
// declines a real turn end, the task never completes and the node's write slot
// is pinned forever. Two properties keep that from happening:
//
//   1. NARROW SCOPE. The gate only ever engages when a LOCAL provider instance
//      can be observed. A remote worker, a missing instance, an instance without
//      the accessor, or a probe that throws all resolve to "no observations" and
//      the completion passes through UNCHANGED. Absence of evidence never
//      manufactures a veto.
//   2. BOUNDED HOLD, NEVER A DROP. A decline arms the SAME bounded content-free
//      hold the live-state gate already uses (holdCompletionForLiveStateRetry,
//      5s TTL / 250ms re-check). When the hold's TTL expires the completion is
//      released to the normal pipeline — the transcript-growing window is 8s
//      against a 5s TTL by design, so a genuinely-finished worker whose tail
//      merely looked fresh is delayed by at most one hold, never lost. The turn
//      reducer and terminal outbox remain the exactly-once authorities.
//
// A decline here is therefore a DELAY, in exactly the sense the admission
// module's header describes: it can never wedge a row and never manufacture one.
// ---------------------------------------------------------------------------

import { evaluateTerminalAdmission } from './mesh-terminal-admission.js';
import type { TerminalAdmissionVerdict } from './mesh-terminal-admission.js';
import { providerHasNativeTurnSignal } from '../chat/native-turn-signal.js';
import type { NativeTurnTerminalMarker } from '../chat/native-turn-signal.js';
import { readNonEmptyString } from './mesh-events-utils.js';

/**
 * The provider-instance surface this gate duck-types.
 *
 * Duck-typed, not imported: the import-boundary gate forbids mesh/** → providers/**
 * VALUE imports, and this is the same pattern LiveTurnEvidenceSource already uses in
 * mesh-completion-live-gate.ts. The producing side is
 * CliProviderInstance.getTerminalAdmissionObservations (providers/completion/evidence.ts).
 */
export type TerminalAdmissionObservationSource = {
    getTerminalAdmissionObservations?: (nowMs?: number) => {
        activeModalPresent?: boolean;
        trailingActivityCount?: number;
        newestActivityAtMs?: number;
        finalAssistantPresent?: boolean;
        nativeMarkersFieldPresent?: boolean;
        nativeMarkers?: NativeTurnTerminalMarker[];
    };
    getDrainStatus?: () => 'idle' | 'generating' | 'modal_parked' | 'other';
};

export type ProviderEventAdmissionDecision =
    /** No local observation was possible — the completion passes through untouched. */
    | { kind: 'unobserved'; reason: string }
    | { kind: 'admit'; evidenceLevel: 'strong' | 'weak'; reason: string }
    | { kind: 'decline'; reason: string; detail: string };

/**
 * Ask the single choke point whether this provider-native completion event may be
 * admitted as a turn end.
 *
 * Returns `unobserved` — never `decline` — whenever the local observation could not
 * be made. See the liveness contract in the module header: this is the property that
 * keeps a remote/unobservable worker's genuine completion flowing.
 */
export function evaluateProviderEventAdmission(args: {
    instance: unknown;
    providerType?: string;
    /** Dispatch boundary (epoch ms) — scopes a native marker to THIS turn. */
    turnStartedAtMs?: number;
    nowMs?: number;
}): ProviderEventAdmissionDecision {
    const nowMs = args.nowMs ?? Date.now();
    const source = args.instance as TerminalAdmissionObservationSource | null | undefined;
    if (typeof source?.getTerminalAdmissionObservations !== 'function') {
        return { kind: 'unobserved', reason: 'no_local_observation_source' };
    }

    let observations: ReturnType<NonNullable<TerminalAdmissionObservationSource['getTerminalAdmissionObservations']>>;
    try {
        observations = source.getTerminalAdmissionObservations(nowMs);
    } catch {
        return { kind: 'unobserved', reason: 'observation_probe_error' };
    }
    if (!observations || typeof observations !== 'object') {
        return { kind: 'unobserved', reason: 'observation_probe_empty' };
    }

    // The worker's own status verdict (admission rule 2). getDrainStatus reports the
    // RAW adapter turn-state with the auto-approve visual mask stripped — the honest
    // answer to "is this session at a turn end right now". Deliberately OMITTED (left
    // undefined ⇒ rule 2 skipped) when it cannot be read: this event IS the provider
    // asserting the turn ended, so an unreadable status must not be re-read as
    // "unknown ⇒ not idle", which would decline every completion on a provider whose
    // accessor is absent. The transcript rules below still apply.
    let providerObservedStatus: string | undefined;
    if (typeof source.getDrainStatus === 'function') {
        try {
            const drain = source.getDrainStatus();
            // 'other' is genuinely uninformative (starting/error/unknown) — omit it
            // rather than let it read as a non-idle veto.
            if (drain === 'idle' || drain === 'generating' || drain === 'modal_parked') {
                providerObservedStatus = drain === 'idle' ? 'idle' : drain;
            }
        } catch { /* omit — see above */ }
    }

    const verdict: TerminalAdmissionVerdict = evaluateTerminalAdmission({
        producer: 'provider_event_completion',
        providerType: readNonEmptyString(args.providerType) || undefined,
        providerHasNativeMarker: providerHasNativeTurnSignal({ type: readNonEmptyString(args.providerType) }),
        nativeMarkersFieldPresent: observations.nativeMarkersFieldPresent === true,
        ...(observations.nativeMarkers ? { nativeMarkers: observations.nativeMarkers } : {}),
        ...(typeof args.turnStartedAtMs === 'number' && Number.isFinite(args.turnStartedAtMs)
            ? { turnStartedAtMs: args.turnStartedAtMs } : {}),
        ...(providerObservedStatus !== undefined ? { providerObservedStatus } : {}),
        activeModalPresent: observations.activeModalPresent === true,
        finalAssistantPresent: observations.finalAssistantPresent === true,
        trailingActivityCount: typeof observations.trailingActivityCount === 'number'
            ? observations.trailingActivityCount : 0,
        ...(typeof observations.newestActivityAtMs === 'number' && Number.isFinite(observations.newestActivityAtMs)
            ? { newestActivityAtMs: observations.newestActivityAtMs } : {}),
        nowMs,
    });

    if (verdict.admit) {
        return { kind: 'admit', evidenceLevel: verdict.evidenceLevel, reason: verdict.reason };
    }

    // ★ THE ONE DECLINE THIS GATE ENFORCES.
    //
    // Only `transcript_growing` — the rule that proves the tail was STILL MOVING when
    // the completion arrived — vetoes a provider-native completion here. This is a
    // deliberate narrowing of the full rule table, and the reason is the liveness
    // contract: the other declines are shapes the provider legitimately completes on.
    //
    //   - no_final_assistant_summary: a tool-only or empty-reply turn is a REAL turn
    //     end (codex measured 19.5% empty-reply turns). The engine's own finalization
    //     wait already governs it, and the existing weak-evidence tentative path
    //     (weakCompleted in mesh-event-forwarding) already keeps it non-terminal.
    //   - native_marker_absent: markers are read off the LOCAL transcript snapshot,
    //     which lags the provider's own event by design on write-lag providers —
    //     vetoing on it would decline the very completions the marker exists to
    //     confirm.
    //   - session_not_idle / active_modal / trailing_tool_activity: already enforced,
    //     with their own richer handling, by the MID-TURN-LIVE-STATE-GATE that runs
    //     immediately before this one.
    //
    // Growth is the shape NOTHING else on this path checks, and it is the shape the
    // incident took. Widening this set is a liveness decision, not a cleanup.
    if (verdict.reason === 'transcript_growing') {
        return { kind: 'decline', reason: verdict.reason, detail: verdict.detail };
    }
    return { kind: 'unobserved', reason: `not_enforced_here:${verdict.reason}` };
}
