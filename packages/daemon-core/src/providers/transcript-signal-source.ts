/**
 * TranscriptSignalSource — TX-FSM transcript signal normalizer, daemon side.
 *
 * Owns the collection/normalization half of the dual-source redesign: given
 * the daemon's EXISTING native-transcript reads (file discovery + session pin
 * + parsing all stay in CliProviderInstance.readExternalCompletionMessages,
 * which resolves providerSessionId / persisted pins / floor-claims), this
 * source normalizes each read into the provider-agnostic SignalSnapshot
 * envelope (spec/signal-envelope.ts).
 *
 * Consumers:
 *  - Stage 0 (shadow): the snapshot is injected into the FsmDriver as a pure
 *    observation; `signal` conditions stay pass-through there (fsm-evaluator).
 *  - Stage 1 (delegation): the instance's OWN stall/growth-hold judgments
 *    (checkMeshWorkerStall's transcript-advancing axis, the TRANSCRIPT-
 *    GROWTH-HOLD, and tryReconcileTranscriptCompletionForStall — the FIX 3
 *    probe) consume the SAME normalized snapshot instead of running private
 *    transcript scans. The FSM-side consumption remains shadow/pass-through.
 *
 * Hard contracts:
 *  - ZERO added I/O. update() is fed by transcript reads the daemon already
 *    performs (completion probe / stall sampling); it never opens a file
 *    itself. getState() keeps its zero-native-read invariant untouched.
 *  - Classification goes through resolveTranscriptAuthorityProfile ONLY (the
 *    P0 choke point) — never raw isNativeSourceCanonicalHistory /
 *    isPurePtyTranscriptProvider calls, and never a provider-name branch.
 *  - Fail-open: a non-native-source class, an unresolved transcript, or a
 *    read error yields an unavailable snapshot — consumers treat every signal
 *    as null and keep their pre-delegation fallbacks; a missing signal must
 *    never wedge a session or fabricate a completion.
 *  - No approval signal (Stage 4 scope — see signal-envelope.ts).
 */
'use strict';

import { LOG } from '../logging/logger.js';
import type { TranscriptAuthorityProfile } from './transcript-evidence.js';
import {
    SIGNAL_SNAPSHOT_KIND,
    unavailableSignalSnapshot,
    type SignalSnapshot,
} from './spec/signal-envelope.js';

/** One daemon transcript read, normalized for the source. */
export interface TranscriptSignalSample {
    /** Parsed native-transcript messages, or null when the read failed to
     *  resolve a source this time. */
    messages: unknown[] | null;
    /** The probe metadata the read refreshed (sourcePath/mtime/msgCount), or
     *  null when no source is bound. A null sourceMtimeMs is treated as "no
     *  freshness evidence" (same contract as the growth-hold path). */
    probe: { msgCount: number; sourceMtimeMs: number | null; sourcePath?: string | null } | null;
    /** True when the read threw — logged distinctly from a clean miss. */
    error?: boolean;
}

export interface TranscriptSignalSourceOpts {
    /** Log tag (provider type / session label) — never used for branching. */
    label: string;
    /** The P0 choke-point profile for this provider. */
    profile: TranscriptAuthorityProfile;
    /** Turn-boundary clock (adapter.currentTurnStartedAt) for turn-scoped
     *  final-assistant detection; may yield undefined pre-turn. */
    turnStartedAt?: () => number | undefined;
    /** In-turn final-assistant predicate over the flattened messages — the
     *  instance passes its existing completionHasFinalAssistantMessage so the
     *  signal reuses the exact completion machinery instead of duplicating it. */
    finalAssistantPresent: (messages: unknown[], turnStartedAt?: number) => boolean;
    /** Freshness window (ms) for transcript_growing. The caller passes the
     *  completion pipeline's MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS so
     *  the shadow signal is comparable to the existing growth-hold judgment. */
    growthQuietMs: number;
}

export class TranscriptSignalSource {
    /** msgCount seen at the previous update — drives in_turn_progress. */
    private prevMsgCount = -1;
    /** Fingerprint of the last LOGGED snapshot, so the shadow log fires on
     *  change only (a quiet session must not spam one line per read). */
    private lastLoggedFingerprint = '';

    constructor(private readonly opts: TranscriptSignalSourceOpts) {}

    /**
     * Normalize one daemon read into a SignalSnapshot and emit the Stage-0
     * shadow log when the observation changed. Pure w.r.t. the outside world:
     * the only side effect is the (change-gated) log line. Returns the
     * snapshot the caller should inject into the FSM driver.
     */
    update(sample: TranscriptSignalSample, now: number = Date.now()): SignalSnapshot {
        const snapshot = this.buildSnapshot(sample, now);
        this.logOnChange(snapshot);
        return snapshot;
    }

    /** Pure normalization — separated from update() so tests can assert the
     *  envelope without touching the log path. */
    buildSnapshot(sample: TranscriptSignalSample, now: number): SignalSnapshot {
        const profileRef = { class: this.opts.profile.class, timing: this.opts.profile.timing };

        // Choke-point classification: only native-source providers have an
        // on-disk transcript to signal from. daemon-owned / pure-pty classes
        // fail open — no signal is ever fabricated for them.
        if (this.opts.profile.class !== 'native-source') {
            return unavailableSignalSnapshot(now, 'no_native_source', profileRef);
        }
        if (sample.error) {
            return unavailableSignalSnapshot(now, 'error', profileRef);
        }
        const probe = sample.probe;
        if (!probe || !Array.isArray(sample.messages)) {
            return unavailableSignalSnapshot(now, 'unresolved', profileRef);
        }

        const msgCount = typeof probe.msgCount === 'number' && Number.isFinite(probe.msgCount)
            ? probe.msgCount
            : sample.messages.length;
        const sourceMtimeMs = typeof probe.sourceMtimeMs === 'number' && Number.isFinite(probe.sourceMtimeMs)
            ? probe.sourceMtimeMs
            : 0;
        // mtime 0 = "no freshness evidence" — the growth-hold test lock treats
        // it as unprovable, and so do we: transcript_growing stays null rather
        // than guessing from a missing clock.
        const ageMs = sourceMtimeMs > 0 ? Math.max(0, now - sourceMtimeMs) : null;

        let turnStartedAt: number | undefined;
        try { turnStartedAt = this.opts.turnStartedAt?.(); } catch { turnStartedAt = undefined; }

        let finalAssistant: boolean | null = null;
        try {
            finalAssistant = this.opts.finalAssistantPresent(sample.messages, turnStartedAt);
        } catch { finalAssistant = null; /* fail-open: never let a parse quirk fabricate a signal */ }

        // in_turn_progress: the transcript ADVANCED since the previous sample
        // (msgCount grew) or is still fresh. Conservative: the first sample
        // reports progress only on freshness, never on a count jump from -1.
        const countAdvanced = this.prevMsgCount >= 0 && msgCount > this.prevMsgCount;
        const fresh = ageMs !== null && ageMs < this.opts.growthQuietMs;
        const inTurnProgress = countAdvanced || fresh;
        const transcriptGrowing = ageMs === null ? null : fresh;
        this.prevMsgCount = msgCount;

        return {
            kind: SIGNAL_SNAPSHOT_KIND,
            sampledAt: now,
            available: true,
            profile: profileRef,
            signals: {
                final_assistant_present: finalAssistant,
                in_turn_progress: inTurnProgress,
                transcript_growing: transcriptGrowing,
            },
            detail: { msgCount, sourceMtimeMs, ageMs },
        };
    }

    /** Stage-0 shadow log: emit one line when the normalized observation
     *  CHANGES. This log is the Stage 1-3 judgment input ("which signals were
     *  actually observable, and when"), so it carries the full signal set —
     *  but only on change, so a steady-state session stays quiet. */
    private logOnChange(snapshot: SignalSnapshot): void {
        const s = snapshot.signals;
        const fingerprint = snapshot.available
            ? `1|fa=${s.final_assistant_present}|tp=${s.in_turn_progress}|tg=${s.transcript_growing}|n=${snapshot.detail.msgCount}`
            : `0|${snapshot.unavailableReason ?? 'unknown'}`;
        if (fingerprint === this.lastLoggedFingerprint) return;
        this.lastLoggedFingerprint = fingerprint;
        const age = snapshot.detail.ageMs === null ? 'n/a' : `${snapshot.detail.ageMs}ms`;
        LOG.info(
            'TranscriptSignalSource',
            `[${this.opts.label}] [shadow] signals available=${snapshot.available}`
            + (snapshot.available
                ? ` final_assistant_present=${s.final_assistant_present}`
                + ` in_turn_progress=${s.in_turn_progress}`
                + ` transcript_growing=${s.transcript_growing}`
                + ` msgCount=${snapshot.detail.msgCount} age=${age}`
                : ` reason=${snapshot.unavailableReason ?? 'unknown'}`),
        );
    }
}
