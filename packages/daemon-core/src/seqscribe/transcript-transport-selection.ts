/**
 * `transcriptTransportSelection` counters — `replicaSelected`/`legacySelected`
 * (design §7e G2, RCA `scratchpad/transcript-handshake-rca.md` finding #5).
 *
 * `stats.ts`'s `SeqscribeStatusSummary.transcriptTransportSelection` and
 * `SummarizeOptions.transcriptTransportSelection` were already scaffolded
 * (fields exist, `summarizeSeqscribeStats` already passes them through) —
 * what was missing was anything that actually COUNTS `replicaSelected`/
 * `legacySelected`. `zombieRecovered` has a clean daemon-side source
 * (`packages/daemon-cloud/src/daemon-p2p/data-channel-router.ts`
 * `getZombiePeerRecoveryCount()`, already counting, injected by
 * `cloud-seqscribe-wiring.ts`) — this module is the other two.
 *
 * ── Why this needs a NEW signal, not a derivation ───────────────────────────
 * `replicaHealthy`/`shouldRunLegacySubscription()` are BROWSER-LOCAL state
 * (`web-core/src/components/dashboard/session-chat-tail-controller.ts`) —
 * they never reach the daemon today. There is no way to derive "did this
 * dashboard peer's session use replica or legacy transport" from anything the
 * daemon already observes; the browser is the only party that knows which
 * transport it actually used. So the browser reports it explicitly, once per
 * subscription decision, via a new low-family command
 * (`commands/low-family/transcript-transport-report.ts`) —
 * `report_transcript_transport` — invoked over the SAME P2P `type:'command'`
 * frame the dashboard already uses for every other low-family command
 * (`packages/daemon-cloud/src/daemon-p2p/data-channel-router.ts`
 * `handleP2PCommand`), not a new WS/REST fallback (CLAUDE.md "Cloud dashboard
 * transport policy": P2P only).
 *
 * ── Content boundary ─────────────────────────────────────────────────────
 * The reported value is a closed two-value enum (`'replica' | 'legacy'`) —
 * an identifier of WHICH TRANSPORT was used, never any chat content, session
 * text, or free-form string. It stays local-only for the same reason
 * `zombieRecovered` does (see `stats.ts`'s doc comment on
 * `transcriptTransportSelection`): a raw monotonic counter that would defeat
 * the deduped status-frame hash, and `buildCloudSeqscribeSummary`
 * (status/reporter.ts) is a fixed-key allow-list that must not name this key
 * — `test/status/cloud-status-content-boundary.test.ts` covers that.
 */

export type TranscriptTransportSelection = 'replica' | 'legacy';

export interface TranscriptTransportSelectionCounters {
    replicaSelected: number;
    legacySelected: number;
}

let counters: TranscriptTransportSelectionCounters = {
    replicaSelected: 0,
    legacySelected: 0,
};

/** Record one dashboard session's transport choice. Called once per subscription decision, never per message. */
export function recordTranscriptTransportSelection(selection: TranscriptTransportSelection): void {
    if (selection === 'replica') counters.replicaSelected++;
    else counters.legacySelected++;
}

/** Current counters. Local-only diagnostics — see `local-stats.ts`'s caller. */
export function transcriptTransportSelectionCounters(): TranscriptTransportSelectionCounters {
    return { ...counters };
}

/** Reset counters. TESTS ONLY. */
export function __resetTranscriptTransportSelectionForTests(): void {
    counters = { replicaSelected: 0, legacySelected: 0 };
}
