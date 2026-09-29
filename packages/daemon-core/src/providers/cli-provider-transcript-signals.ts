/**
 * Native-transcript signal plumbing of a CLI provider instance (TX-FSM): the
 * normalized SignalSnapshot published from reads the instance already
 * performs, the single native-transcript signal probe, and the completion
 * latch/terminal-marker helpers that consume them.
 *
 * Split out of cli-provider-instance.ts (file-size gate). Functions take the
 * instance through the compiler-checked {@link TranscriptSignalHost} view.
 */
import { selectTurnTerminalMarker, type NativeTurnTerminalMarker } from '../chat/native-turn-signal.js';
import { resolveTranscriptAuthorityProfile } from './transcript-evidence.js';
import { TranscriptSignalSource } from './transcript-signal-source.js';
import { resolveBusyLeaseGate } from './busy-lease-gate.js';
import type { SignalSnapshot } from './spec/signal-envelope.js';
import { MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS } from './cli-provider-instance-types.js';
import { adapterTurnStartedAt } from './adapter-turn-clock.js';
import type { CliProviderInstance } from './cli-provider-instance.js';

/** The CliProviderInstance members these functions read or call (compiler-checked; no cast). */
export type TranscriptSignalHost = Pick<CliProviderInstance, 'adapter' | 'busyEpoch' | 'completionHasFinalAssistantMessage' | 'lastEmittedCompletion' | 'lastExternalCompletionProbe' | 'lastFinalSummaryProvenance' | 'lastNativeTurnTerminalMarkers' | 'lastTranscriptSignalSnapshot' | 'meshTaskInjectedAt' | 'nativeTurnTerminalMarker' | 'provider' | 'readExternalCompletionMessages' | 'transcriptSignalSource' | 'type'>;

/**
 * The spawned CLI's env overrides (e.g. the mesh coordinator points hermes
 * at a per-coordinator HERMES_HOME so its state.db lives in a tmpdir instead
 * of ~/.hermes). The native-history executor expands `${HERMES_HOME:-~/.hermes}`
 * from this map, so the completion gate MUST pass it through — otherwise the
 * gate reads ~/.hermes, finds no coordinator-session transcript, and
 * false-fires missing_final_assistant on every coordinator turn.
 */
export function spawnedEnvOverrides(host: TranscriptSignalHost): Record<string, string> | undefined {
    const env = host.adapter.getRuntimeMetadata()?.spawnedEnv;
    return env && typeof env === 'object' ? env as Record<string, string> : undefined;
}

/**
 * TX-FSM: normalize the transcript read that JUST happened into a
 * SignalSnapshot. Stage 0 injected it into the FSM driver as a pure
 * shadow observation (daemon → SpecCliAdapter → FsmDriver); Stage 1
 * additionally caches it (lastTranscriptSignalSnapshot) so the instance's
 * OWN stall/growth-hold judgments consume the SAME normalized snapshot
 * instead of re-running private transcript scans. Fed ONLY by reads this
 * method's caller already performs — it adds zero I/O, so the getState()
 * zero-native-read invariant and the stall-path read cadence are
 * untouched. The source update runs regardless of the adapter hook so a
 * non-spec provider still produces the instance-side snapshot (the FSM
 * injection is simply skipped there). Fail-open end to end — an
 * unresolved transcript or any throw degrades to "no observation", never
 * to a wedge.
 */
export function publishTranscriptSignalObservation(host: TranscriptSignalHost, messages: unknown[] | null, error = false): void {
    try {
        if (!host.transcriptSignalSource) {
            host.transcriptSignalSource = new TranscriptSignalSource({
                label: host.type,
                // Choke point: class/timing come from the P0 profile
                // resolver, never from raw predicates or provider names.
                profile: resolveTranscriptAuthorityProfile(host.provider),
                turnStartedAt: () => {
                    const t = adapterTurnStartedAt(host.adapter);
                    if (t > 0) return t;
                    // Mesh fallback: for an emitsPtyTurnEvents=false worker
                    // (idle→idle collapse) currentTurnStartedAt may never
                    // bind; scope to the task injection instead — the SAME
                    // boundary the stall-path rescue uses, so the signal and
                    // the rescue's payload extraction agree on the turn.
                    return host.meshTaskInjectedAt > 0 ? host.meshTaskInjectedAt : undefined;
                },
                // Reuse the exact completion machinery (I1) for the
                // final_assistant_present signal rather than duplicating
                // the message scan.
                finalAssistantPresent: (msgs, ts) => host.completionHasFinalAssistantMessage(msgs, ts),
                growthQuietMs: MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
                // TX-FSM Stage 2: the lease bound follows the rollout gate's
                // (possibly env-overridden) value; the gate's enabled flag is
                // consulted per judgment, not here.
                leaseBoundMs: resolveBusyLeaseGate(host.type).boundMs,
            });
        }
        const snapshot = host.transcriptSignalSource.update(
            { messages, probe: host.lastExternalCompletionProbe, error },
        );
        host.lastTranscriptSignalSnapshot = snapshot;
        host.adapter.setSignalObservation(snapshot);
    } catch { /* signal collection must never break the read path */ }
}

/** The result of one native-transcript signal probe: the normalized
 *  snapshot the shared TranscriptSignalSource produced from the read, and
 *  the very messages it was normalized from (so a judgment site can pull
 *  a payload — e.g. the final summary — from the SAME read with zero
 *  added I/O). */
/**
 * TX-FSM Stage 1 — the single native-transcript signal probe (replaces
 * the Stage-0 sampleNativeTranscriptProgress fingerprint sampler). For a
 * native-source provider (its authoritative history is an on-disk
 * transcript file, e.g. kimi's wire.jsonl), perform the read this
 * judgment point already owns — SAME cadence as before, one
 * readExternalCompletionMessages() per call, never more — and return the
 * NORMALIZED SignalSnapshot the shared TranscriptSignalSource produced
 * from it (publishTranscriptSignalObservation runs inside the read), plus
 * the messages that read returned. Judgment sites (the stall watchdog's
 * transcript-advancing axis, the completion growth-hold, the stall-path
 * completion rescue) consume the snapshot's SIGNALS instead of running
 * their own fingerprint/freshness/final-assistant scans — one source of
 * truth for "what does the transcript say right now".
 *
 * Class gating goes through resolveTranscriptAuthorityProfile ONLY.
 * Returns null for a non-native-source class (nothing to signal from) and
 * a null snapshot when the read threw — callers keep their fail-open
 * fallbacks ("couldn't tell" never blocks an idle verdict and never
 * fabricates a completion). Cheap enough for the stall path: it runs
 * only at the stall threshold (≥180s of PTY stasis) or during an armed
 * completion-debounce retry, never on the routine 5s tick.
 */
export function probeNativeTranscriptSignals(host: TranscriptSignalHost): { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null {
    if (resolveTranscriptAuthorityProfile(host.provider).class !== 'native-source') return null;
    // readExternalCompletionMessages resolves this session's OWN native-source
    // conversation (providerSessionId / persisted pin / floor claim) and, as a
    // side effect, feeds the shared TranscriptSignalSource (which refreshes
    // this.lastTranscriptSignalSnapshot). Reusing it keeps the resolution
    // logic in one place and immune to the antigravity-style session-id quirks.
    let messages: unknown[] | null = null;
    try {
        messages = host.readExternalCompletionMessages();
    } catch {
        return { snapshot: null, messages: null }; // best-effort: fail-open
    }
    return { snapshot: host.lastTranscriptSignalSnapshot, messages };
}

/**
 * (NATIVE-TURN-SIGNAL) This turn's terminal marker from the provider's own transcript,
 * or null when the provider declares no completion signal / the turn has not ended.
 *
 * Turn scoping uses the turn-start boundary — see selectTurnTerminalMarker. Any read error fails
 * CLOSED (null ⇒ shape inference), so a malformed transcript can never manufacture a
 * completion.
 */
export function nativeTurnTerminalMarker(host: TranscriptSignalHost, turnStartedAt?: number): NativeTurnTerminalMarker | null {
    try {
        // Markers are only ever populated by a reader that HAS a signal, so their
        // presence is itself the capability check — no provider-name branching needed.
        const markers = host.lastNativeTurnTerminalMarkers;
        if (!markers || markers.length === 0) return null;
        return selectTurnTerminalMarker(markers, turnStartedAt);
    } catch { return null; }
}

/**
 * (SUMMARY-SCRAPE-FALLBACK, part B) The completionDiagnostic fields describing where the
 * emitted finalSummary came from, and whether it may be clipped.
 *
 * `emittedSummary` is the value ACTUALLY being emitted, and it is verified against the
 * recorded provenance rather than trusted: the weak path's provenance chain can be won by
 * an earlier source (nativeTurnTerminalSummary / snapshotExternalNativeCompletionSummary)
 * that short-circuits before completionFinalSummary ever runs, in which case
 * lastFinalSummaryProvenance still describes a PREVIOUS resolution. Stamping that would
 * mislabel a perfectly good native summary as a possibly-truncated scrape — the exact kind
 * of false flag that teaches the coordinator to ignore the flag. So the length must match;
 * when it does not, the provenance is simply not stamped (absent = "not asserted", the
 * pre-fix shape) rather than guessed at.
 *
 * `finalSummaryMayBeTruncated` is emitted ONLY when true. A `false` on every genuine
 * completion would add a field to every event to say nothing, and downstream readers
 * already treat absent as "no truncation asserted".
 */
export function finalSummaryProvenanceDiagnostic(host: TranscriptSignalHost, emittedSummary: string | undefined): Record<string, unknown> {
    const provenance = host.lastFinalSummaryProvenance;
    if (!provenance) return {};
    const emitted = typeof emittedSummary === 'string' ? emittedSummary : '';
    if (emitted.length !== provenance.contentLength) return {};
    return {
        finalSummarySource: provenance.source,
        ...(provenance.mayBeTruncated ? { finalSummaryMayBeTruncated: true } : {}),
    };
}

/**
 * (NATIVE-TURN-SIGNAL) finalSummary straight from the provider's own terminal record.
 *
 * Placed at the HEAD of the finalSummary provenance chain so the two sources can never
 * diverge: when the provider states the turn's final text, that text wins outright and
 * the reconstruction chain (native snapshot > parsed screen > cached in-turn summary) is
 * not consulted at all. Returns undefined — not '' — for a terminal record with no text,
 * so a tool-terminated turn falls through to the existing chain rather than forcing an
 * empty summary onto a completion that might legitimately have one from elsewhere.
 */
export function nativeTurnTerminalSummary(host: TranscriptSignalHost, turnStartedAt?: number): string | undefined {
    const marker = host.nativeTurnTerminalMarker(turnStartedAt);
    const text = typeof marker?.summary === 'string' ? marker.summary.trim() : '';
    return text || undefined;
}

/**
 * COMPLETION-WEAK-REARM (fix1): the double-emit guard shared by the transcript
 * re-emit paths (flushMeshCompletionBeforeCleanup,
 * tryReconcileTranscriptCompletionForStall). Returns true when a re-emit for `taskId`
 * must be SUPPRESSED because this turn's completion already fired with strong evidence.
 *
 * The defect this replaces: the old guard short-circuited on ANY prior emit for the
 * taskId, regardless of its evidence. After a WEAK completion (CANON-C decoupled-immediate
 * missing_final_assistant, or a startup-grace fast-collapse synth), the same session
 * reaching a GENUINE idle later (final assistant present) was silently swallowed — the
 * worker never emitted the genuine completion and the coordinator held on the acked-death
 * deadline (8 min).
 *
 * New behavior:
 *   • no latch / taskId mismatch → NOT suppressed (the caller's own evidence gate runs).
 *   • prior emit was GENUINE (not weak) → SUPPRESSED (single-shot; a clean completion is
 *     never re-emitted).
 *   • prior emit was WEAK → re-arm ONE-SHOT, but only across a real generating→idle
 *     transition: require busyEpoch to have advanced past the weak emit's epoch, so a
 *     static idle screen cannot re-fire the same weak frame. The genuine re-emit passes
 *     evidenceLevel:'reported' (non-weak), overwriting the latch → any subsequent idle
 *     tick hits the now-genuine latch and is suppressed. Never a third emit.
 */
export function shouldSuppressCompletionReEmit(host: TranscriptSignalHost, taskId: string | undefined): boolean {
    const latch = host.lastEmittedCompletion;
    if (!latch || latch.taskId !== (taskId ?? '')) return false;
    // Prior emit was genuine → single-shot, never re-emit.
    if (!latch.weak) return true;
    // Prior emit was weak → allow the genuine re-emit ONLY once a real generating phase
    // opened after the weak emit (busyEpoch advanced). Otherwise a static idle frame would
    // re-fire the same weak completion. Bounded to a single re-arm by the latch overwrite
    // the genuine re-emit performs (weak=false), so the next tick is suppressed above.
    if (host.busyEpoch <= latch.emittedAtEpoch) return true;
    return false;
}

/**
 * TERMINAL-STALE-APPROVAL (provider side): true once a GENUINE (non-weak) completion
 * has been emitted for the CURRENT busy epoch — the turn is over and no new generating
 * phase has opened since the emit (busyEpoch has not advanced past the latch). A stale
 * cached/sticky modal frame must not re-synthesize waiting_approval for such an
 * already-completed turn. A weak/false-idle emit does NOT count (the turn may
 * genuinely still be in flight), and any new busy phase (busyEpoch advanced past the
 * emit) re-enables approval surfacing for the new turn.
 */
export function hasEmittedGenuineCompletionForCurrentEpoch(host: TranscriptSignalHost): boolean {
    const latch = host.lastEmittedCompletion;
    if (!latch || latch.weak) return false;
    return host.busyEpoch <= latch.emittedAtEpoch;
}
