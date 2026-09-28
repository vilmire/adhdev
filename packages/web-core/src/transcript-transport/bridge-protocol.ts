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
 * `TranscriptBridgeFrameMessage` travels worker → main and carries the bubbles
 * ONE verified keyed commit changed (design 2026-09-28 message-keyed storage
 * §5.4 "브리지 증분화"). That does not weaken the invariant above, because the
 * invariant is about PARSING, not about content:
 *
 *  - The worker parses and folds the `session.<id>.chat` rows and verifies each
 *    commit (live count + `(id, rev)` digest, owner/session identity) in
 *    `KeyedTranscriptFolder`; what crosses the port is an already-structured
 *    object handed to `postMessage`, cloned by the structured clone algorithm.
 *    The main thread performs no parse and no verification — it cannot, and
 *    must not, since re-deriving trust on the main thread is exactly what §3.6
 *    moved into the worker.
 *  - It is a distinct message KIND, so the opaque wire-string relay path is
 *    untouched: `main-thread-bridge.ts` still forwards only `typeof data ===
 *    'string'` frames and still contains zero JSON calls.
 *
 * ── Only what changed crosses the port ─────────────────────────────────────
 * A frame carries the upserted bubbles, the deleted ids and — only when it
 * changed — the view's meta. The whole live set crosses only on `reset`
 * (a SNAP, the first commit, or a producer writer change). The main thread
 * keeps a `Map<messageId, message>` per session (`transcript-view-mirror.ts`)
 * so every bubble a frame did not touch keeps its object identity, and React
 * re-renders only the bubbles that changed. Cloning the whole transcript on
 * every streaming tick — what the v1 snapshot message did — is gone.
 *
 * This message is the transcript's exit door from the worker, and it exists on
 * the MAIN thread only to reach React. It is never sent back down to the
 * transport, and it never travels to the server (design §2.3 — content class).
 */
import type {
    ReplicatedTranscriptMessageV2,
    ReplicatedTranscriptViewV2,
} from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec';
import type { KeyedTranscriptFrameDelta } from '@adhdev/daemon-core/seqscribe/transcript-keyed-folder';

/** The folded view minus its messages — what a frame's `meta` carries. */
export type TranscriptViewMeta = Omit<ReplicatedTranscriptViewV2, 'messages'>;

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
 * One applied keyed commit, worker → main. See this file's header for why this
 * does not weaken the "main thread parses nothing" invariant, and why it
 * carries only the changed bubbles.
 */
export interface TranscriptBridgeFrameMessage {
    readonly kind: 'transcript-bridge-frame';
    /** Raw (unsanitized) session id, so the main thread can route without re-deriving it. */
    readonly sessionId: string;
    /** Producer epoch + frame of the commit this frame applied. */
    readonly epoch: string;
    readonly frame: number;
    /** True when `upserts` is the whole live set (SNAP, first commit, writer change). */
    readonly reset: boolean;
    /** Bubbles added or changed by this commit, in `ord` order. */
    readonly upserts: readonly ReplicatedTranscriptMessageV2[];
    /** `messageId`s this commit removed. Always empty on `reset`. */
    readonly deletes: readonly string[];
    /** The view's meta when it changed (always on `reset`), else null. */
    readonly meta: TranscriptViewMeta | null;
}

export function transcriptBridgeFrameMessage(
    sessionId: string,
    delta: KeyedTranscriptFrameDelta,
): TranscriptBridgeFrameMessage {
    return {
        kind: 'transcript-bridge-frame',
        sessionId,
        epoch: delta.epoch,
        frame: delta.frame,
        reset: delta.reset,
        upserts: delta.upserts,
        deletes: delta.deletes,
        meta: delta.meta,
    };
}

export function isTranscriptBridgeFrameMessage(value: unknown): value is TranscriptBridgeFrameMessage {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { kind?: unknown }).kind === 'transcript-bridge-frame' &&
        Array.isArray((value as { upserts?: unknown }).upserts) &&
        Array.isArray((value as { deletes?: unknown }).deletes)
    );
}

/**
 * The worker's folder kept failing to verify this session's commits (three
 * consecutive resubscribes for the same reason) — worker → main.
 *
 * The worker only holds the seqscribe channel; asking the producing daemon for
 * one `resync_request` base frame is a normal daemon COMMAND
 * (`request_transcript_base`, design 2026-09-28 §5.2), so the main thread
 * sends it on the dashboard's command path. It carries the raw session id
 * only — never content.
 */
export interface TranscriptBridgeBaseRequestMessage {
    readonly kind: 'transcript-bridge-base-request';
    readonly sessionId: string;
}

export function transcriptBridgeBaseRequestMessage(sessionId: string): TranscriptBridgeBaseRequestMessage {
    return { kind: 'transcript-bridge-base-request', sessionId };
}

export function isTranscriptBridgeBaseRequestMessage(value: unknown): value is TranscriptBridgeBaseRequestMessage {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { kind?: unknown }).kind === 'transcript-bridge-base-request' &&
        typeof (value as { sessionId?: unknown }).sessionId === 'string'
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
    /**
     * The producing daemon's id. When present the worker's folder refuses any
     * commit a different daemon produced (`daemonIdsEquivalent`), on top of the
     * topic name and the commit's own session id.
     */
    readonly ownerDaemonId?: string;
}

export function transcriptSessionActivation(
    sessionIds: readonly string[],
    ownerDaemonId?: string,
): TranscriptSessionActivation {
    return {
        kind: 'transcript-session-activation',
        sessionIds: [...sessionIds],
        ...(ownerDaemonId ? { ownerDaemonId } : {}),
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
