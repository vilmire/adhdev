/**
 * Worker-side seqscribe `Channel` adapter over the main<->worker MessagePort
 * (design §3.6). The worker's seqscribe node treats this as its transport to
 * "the daemon peer, relayed through the main thread" — it never knows the
 * real transport underneath (RTCDataChannel / WS) is main's problem.
 *
 * This demultiplexes the two message shapes that can arrive on the port:
 *  - a plain string: an opaque seqscribe wire frame, forwarded verbatim into
 *    `Channel.onMessage`.
 *  - a `TranscriptBridgeControlEvent`: a lifecycle signal the bridge
 *    originated itself (never transcript content) — routed to `onControl`
 *    instead, and never handed to the seqscribe session.
 *
 * A `transport_closed` or `queue_overflow` control event closes this channel.
 * Both mean the real transport can no longer be trusted to deliver an
 * in-order, complete byte stream (design §3.6 criterion 4: no partial
 * committed view) — the seqscribe session must see `onClose` fire so its
 * peer handle transitions to `closed` and a fresh attach starts a clean SUB,
 * rather than silently continuing against a channel that may have dropped
 * bytes.
 */
import type { Channel } from 'seqscribe';
import { isTranscriptBridgeControlEvent, type TranscriptBridgeControlEvent } from './bridge-protocol.js';

export interface MessagePortLike {
    postMessage(data: unknown): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    close?(): void;
}

export interface WorkerPortChannel {
    readonly channel: Channel;
    /** Fires for every control event, including the ones that also close the channel. */
    onControl(cb: (event: TranscriptBridgeControlEvent) => void): void;
}

const RESET_EVENTS = new Set<TranscriptBridgeControlEvent['event']>(['transport_closed', 'queue_overflow']);

export function workerPortChannel(port: MessagePortLike): WorkerPortChannel {
    let messageCb: ((m: string) => void) | null = null;
    let closeCb: (() => void) | null = null;
    let controlCb: ((e: TranscriptBridgeControlEvent) => void) | null = null;
    let closed = false;

    const doClose = (): void => {
        if (closed) return;
        closed = true;
        port.onmessage = null;
        try {
            port.close?.();
        } catch {
            // already gone
        }
        closeCb?.();
    };

    port.onmessage = (ev) => {
        if (closed) return;
        const data = ev.data;
        if (typeof data === 'string') {
            messageCb?.(data);
            return;
        }
        if (isTranscriptBridgeControlEvent(data)) {
            controlCb?.(data);
            if (RESET_EVENTS.has(data.event)) doClose();
        }
        // any other shape is neither a wire frame nor a recognized control event
        // — dropped rather than guessed at.
    };

    return {
        channel: {
            send(msg: string): void {
                if (!closed) port.postMessage(msg);
            },
            onMessage(cb): void {
                messageCb = cb;
            },
            onClose(cb): void {
                closeCb = cb;
            },
            close: doClose,
        },
        onControl(cb): void {
            controlCb = cb;
        },
    };
}
