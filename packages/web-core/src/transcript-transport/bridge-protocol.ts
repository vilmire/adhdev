/**
 * Control-plane envelope shared between the main-thread opaque bridge
 * (`main-thread-bridge.ts`) and the transcript worker's MessagePort channel
 * (`message-port-channel.ts`) — design §3.6 "worker transport foundation".
 *
 * This is the ONLY structured (non-string) value the bridge ever puts on the
 * MessagePort. Every other message crossing the port is an opaque seqscribe
 * wire string, forwarded byte-for-byte and never inspected by the bridge.
 * Keeping the control envelope in its own tiny module — rather than inline in
 * the bridge — is what makes "the main thread never parses transcript
 * content" a checkable invariant: this file only ever describes lifecycle
 * events the bridge itself originates, never transcript wire content, so a
 * source scan of `main-thread-bridge.ts` for JSON parsing has nothing to
 * legitimately find.
 *
 * ── The one structured message that DOES carry content ──────────────────────
 * `TranscriptBridgeSnapshotMessage` travels worker → main and carries a
 * verified `ReplicatedTranscriptSnapshotV1`. That does not weaken the
 * invariant above, because the invariant is about PARSING, not about content:
 *
 *  - The worker decodes, verifies (chunk/byte/SHA-256/owner) and assembles the
 *    snapshot; what crosses the port is an already-structured object handed to
 *    `postMessage`, cloned by the structured clone algorithm. The main thread
 *    performs no parse and no verification — it cannot, and must not, since
 *    re-deriving trust on the main thread is exactly what §3.6 moved into the
 *    worker.
 *  - It is a distinct message KIND, so the opaque wire-string relay path is
 *    untouched: `main-thread-bridge.ts` still forwards only `typeof data ===
 *    'string'` frames and still contains zero JSON calls.
 *
 * This message is the transcript's exit door from the worker, and it exists on
 * the MAIN thread only to reach React. It is never sent back down to the
 * transport, and it never travels to the server (design §2.3 — content class).
 */
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core/seqscribe/transcript-projection';

export type TranscriptBridgeControlEventName = 'transport_open' | 'transport_closed' | 'queue_overflow';

export interface TranscriptBridgeControlEvent {
    readonly kind: 'transcript-bridge-control';
    readonly event: TranscriptBridgeControlEventName;
}

export function transcriptBridgeControlEvent(event: TranscriptBridgeControlEventName): TranscriptBridgeControlEvent {
    return { kind: 'transcript-bridge-control', event };
}

export function isTranscriptBridgeControlEvent(value: unknown): value is TranscriptBridgeControlEvent {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { kind?: unknown }).kind === 'transcript-bridge-control'
    );
}

/**
 * One verified-complete transcript revision, worker → main. See this file's
 * header for why this does not weaken the "main thread parses nothing"
 * invariant.
 */
export interface TranscriptBridgeSnapshotMessage {
    readonly kind: 'transcript-bridge-snapshot';
    /** Raw (unsanitized) session id, so the main thread can route without re-deriving it. */
    readonly sessionId: string;
    readonly snapshot: ReplicatedTranscriptSnapshotV1;
    /** Design §3.7 SNAP-reset discontinuity — becomes the pane's "이전 내용 생략". */
    readonly omittedBefore: boolean;
}

export function transcriptBridgeSnapshotMessage(
    sessionId: string,
    snapshot: ReplicatedTranscriptSnapshotV1,
    omittedBefore: boolean,
): TranscriptBridgeSnapshotMessage {
    return { kind: 'transcript-bridge-snapshot', sessionId, snapshot, omittedBefore };
}

export function isTranscriptBridgeSnapshotMessage(value: unknown): value is TranscriptBridgeSnapshotMessage {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { kind?: unknown }).kind === 'transcript-bridge-snapshot'
    );
}

/**
 * Which sessions the worker should subscribe to — main → worker, on the
 * snapshot port.
 *
 * The set is absolute, not incremental: the worker closes subscriptions absent
 * from it and opens those newly present. That makes the message idempotent, so
 * a re-send after a transport reset re-establishes exactly the intended set
 * without the main thread tracking what the worker currently holds.
 *
 * This mirrors, one layer down, the `declareSessionInterest` the dashboard
 * sends the daemon: the daemon narrows its GRANT map, and this narrows what the
 * worker actually SUBSCRIBES to. Both are needed — a grant without a
 * subscription delivers nothing, and a subscription without a grant is refused.
 */
export interface TranscriptSessionActivation {
    readonly kind: 'transcript-session-activation';
    readonly sessionIds: readonly string[];
    /** Daemon's seqscribe writer id, to gate every row (design §3.3). */
    readonly ownerWriterId?: string;
}

export function transcriptSessionActivation(
    sessionIds: readonly string[],
    ownerWriterId?: string,
): TranscriptSessionActivation {
    return {
        kind: 'transcript-session-activation',
        sessionIds: [...sessionIds],
        ...(ownerWriterId ? { ownerWriterId } : {}),
    };
}

export function isTranscriptSessionActivation(value: unknown): value is TranscriptSessionActivation {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { kind?: unknown }).kind === 'transcript-session-activation' &&
        Array.isArray((value as { sessionIds?: unknown }).sessionIds)
    );
}
