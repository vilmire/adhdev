/**
 * `TranscriptObservation` — the single-collection choke point (design §5.2,
 * §8 unit 2: "single observation publisher"; keyed storage 2026-09-28 §3.3).
 *
 * One read_chat observation of a session, as the keyed chat publisher
 * (transcript-publisher.ts) receives it: presentation scalars plus the FULL,
 * caller-independent bubble list, each bubble already carrying the stable
 * `messageId` and fractional `ord` the message identity ledger assigned at the
 * choke point. Producer identity, frame numbers and `rev`s are NOT here — the
 * publisher stamps those when it turns an observation into a frame.
 *
 * Built from the real `ChatMessage[]`/`SessionTurnPresentation` shapes by
 * `commands/transcript-observation-builder.ts` — not in this file, because
 * `check:boundaries` forbids `seqscribe/** -> providers/**|mesh/**` value
 * imports and this module stays producer-neutral like the rest of `seqscribe/`.
 * The types below are therefore STRUCTURAL and loosely typed (`unknown`), and
 * the keyed encoder (transcript-keyed-codec.ts) re-coerces every field by name.
 *
 * The v1 whole-snapshot dedup hash that lived here is gone with the v1 lane
 * (§6.1): "unchanged" is now decided per bubble by the publisher, so an
 * unchanged source writes zero rows without hashing the whole transcript.
 */

/** One observed bubble — flattened content plus the choke point's identity. */
export interface TranscriptObservationMessage {
    /** Stable, opaque id from the message identity ledger (§3.2). */
    readonly messageId?: string;
    /** Fractional-index order key from the ledger (§4.4). */
    readonly ord?: string;
    readonly role?: unknown;
    readonly kind?: unknown;
    readonly content: string;
    readonly receivedAt?: unknown;
    readonly timestamp?: unknown;
    readonly turnKey?: unknown;
    readonly bubbleState?: unknown;
    readonly senderName?: unknown;
    readonly toolName?: unknown;
    /** A truncated tool bubble the daemon can expand by `messageId` (§5.9). */
    readonly expandable?: boolean;
    /** Natural id adopted by source handoff (§3.4), when the ledger recorded one. */
    readonly srcId?: string | null;
    readonly meta?: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptObservationCoverage {
    /** `'window'` when the source shows only part of the transcript (§3.5). */
    readonly mode: unknown;
    readonly omittedBefore?: unknown;
    /**
     * Ids the ledger keeps live although this observation did not list them
     * (they scrolled out of a window source's view). The publisher keeps them
     * instead of tombstoning them.
     */
    readonly retainedMessageIds?: readonly string[];
    readonly [extra: string]: unknown;
}

export interface TranscriptObservation {
    readonly sessionId: string;
    readonly historySessionId?: unknown;
    readonly providerType: string;
    readonly providerSessionId?: unknown;

    readonly status: string;
    readonly providerObservedStatus?: unknown;
    readonly title?: unknown;
    readonly activeModal?: unknown;
    readonly activeInteractivePrompt?: unknown;
    readonly turn?: unknown;

    readonly provenance?: unknown;
    readonly messages: readonly TranscriptObservationMessage[];
    readonly terminalMarkers?: readonly unknown[];
    readonly coverage: TranscriptObservationCoverage;
    /** The session's message identity ledger epoch `E` (persisted on meta, §4.10). */
    readonly ledgerEpoch?: string;

    readonly [extra: string]: unknown;
}

/**
 * An observation with no messages and no title/modal/prompt is the "transient
 * empty read" shape that must not silently replace previously published
 * content — see the `verifiedClear` guard in
 * `TranscriptProjectionService.publishObservation`.
 */
export function isEmptyTranscriptObservation(observation: TranscriptObservation): boolean {
    return (
        observation.messages.length === 0 &&
        !observation.title &&
        !observation.activeModal &&
        !observation.activeInteractivePrompt
    );
}
