/**
 * Main-thread opaque byte bridge (design §3.6). The transcript worker owns
 * the seqscribe node, SUB, and replica state; the main thread's only job is
 * forwarding wire bytes between the real authenticated transport — cloud's
 * dedicated data channel or standalone's authenticated WS lane, both
 * structurally `WebSocketLike` (`seqscribe/ws.ts`) — and the worker's
 * MessagePort, WITHOUT ever reading what those bytes mean.
 *
 * ★ Keep it that way. `test/transcript-transport/main-thread-bridge-canary.test.ts`
 * scans this file's own source for `JSON.parse`/`JSON.stringify` and fails if
 * either appears. That is what turns "the main thread parses zero transcript
 * content" (worker-transport-foundation completion criterion 3) into a
 * checked invariant instead of a promise: every message this module forwards
 * is handled as an opaque string, and the only structured data it ever
 * constructs is the `TranscriptBridgeControlEvent` it originates itself.
 *
 * Reconnect/backoff policy for the real transport lives with its caller (the
 * daemon-cloud P2P stack or the standalone WS client) — this module bridges
 * ONE transport instance for its lifetime. A caller reconnecting the
 * underlying transport creates a fresh bridge per attempt.
 */
import type { WebSocketLike } from 'seqscribe';
import { transcriptBridgeControlEvent } from './bridge-protocol.js';

export interface MainThreadBridgePortLike {
    postMessage(data: unknown): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
}

export type BridgeOverflowReason = 'pre_open_queue_full';

export interface MainThreadBridgeOptions {
    /** Max buffered outbound (worker -> transport) frames while the transport isn't open. */
    readonly preOpenQueueCap?: number;
    readonly onOverflow?: (reason: BridgeOverflowReason) => void;
}

export interface MainThreadBridgeHandle {
    /** Number of frames currently buffered, waiting for the transport to open. */
    pendingCount(): number;
    close(): void;
}

const DEFAULT_PRE_OPEN_QUEUE_CAP = 4096;

function transportOpen(transport: WebSocketLike): boolean {
    if (typeof transport.isOpen === 'function') return transport.isOpen();
    return transport.readyState === 1 || transport.readyState === 'open';
}

/**
 * Attach one real transport instance to one worker port for the transport's
 * lifetime.
 */
export function bridgeTranscriptTransport(
    transport: WebSocketLike,
    workerPort: MainThreadBridgePortLike,
    options: MainThreadBridgeOptions = {},
): MainThreadBridgeHandle {
    const cap = options.preOpenQueueCap ?? DEFAULT_PRE_OPEN_QUEUE_CAP;
    const preOpen: string[] = [];
    let closed = false;

    const flushPreOpen = (): void => {
        for (const frame of preOpen.splice(0)) transport.send(frame);
    };

    // §3.6 criterion 4: overflow is a typed reset, never a silent drop. A
    // partial in-order flush past this point could hand the worker a
    // truncated revision chunk sequence, so the whole pending queue is
    // discarded (not just the frame that overflowed) and the worker side is
    // told to close its channel — the next attach starts a clean SUB instead
    // of building on a gap.
    const handleOverflow = (): void => {
        preOpen.length = 0;
        closed = true;
        workerPort.onmessage = null;
        options.onOverflow?.('pre_open_queue_full');
        workerPort.postMessage(transcriptBridgeControlEvent('queue_overflow'));
    };

    workerPort.onmessage = (ev) => {
        if (closed) return;
        const data = ev.data;
        if (typeof data !== 'string') return; // opaque relay only: never inspect shape/content
        if (transportOpen(transport)) {
            if (preOpen.length > 0) flushPreOpen();
            transport.send(data);
        } else if (preOpen.length < cap) {
            preOpen.push(data);
        } else {
            handleOverflow();
        }
    };

    transport.addEventListener('message', (ev) => {
        if (closed) return;
        const raw = ev.data;
        // the design's wire format is JSON text (§3.3) carried as string
        // frames (§3.6 "seqscribe Channel contract"); a transport delivering
        // anything else here is outside the current wire contract.
        if (typeof raw === 'string') workerPort.postMessage(raw);
    });

    transport.addEventListener('open', () => {
        if (closed) return;
        flushPreOpen();
        workerPort.postMessage(transcriptBridgeControlEvent('transport_open'));
    });

    transport.addEventListener('close', () => {
        if (closed) return;
        closed = true;
        preOpen.length = 0;
        workerPort.postMessage(transcriptBridgeControlEvent('transport_closed'));
    });

    return {
        pendingCount(): number {
            return preOpen.length;
        },
        close(): void {
            if (closed) return;
            closed = true;
            preOpen.length = 0;
            workerPort.onmessage = null;
        },
    };
}
