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
 */

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
