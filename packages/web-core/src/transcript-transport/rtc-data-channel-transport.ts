/**
 * Browser-side `WebSocketLike` adapter over a browser `RTCDataChannel`
 * (design §4: "attach to that data channel"; seqscribe SPEC §14 / P4).
 *
 * This is the browser twin of daemon-cloud's `SeqscribeDataChannelSocket`
 * (`data-channel-router.ts`), which adapts node-datachannel's callback surface.
 * The browser's `RTCDataChannel` is already an `EventTarget`, so the shape is
 * thinner — but it is NOT directly usable as `WebSocketLike`, for one reason
 * that SPEC `:600-610` calls out explicitly:
 *
 *   > an RTCDataChannel reports the STRING "open" [...] Testing
 *   > `readyState === 1` is then PERMANENTLY false, so every frame — HELLO
 *   > included — accumulates in the pre-open buffer and the session never
 *   > reaches ready, silently: no throw, no close.
 *
 * `isOpen()` below is therefore the primary readiness signal, and it tests the
 * string. A conforming adapter must accept `isOpen() === true`,
 * `readyState === 1`, or `readyState === "open"`; supplying `isOpen` makes this
 * unambiguous regardless of which branch the library checks first.
 *
 * ── Pre-open buffering (SPEC `:605-610`) ───────────────────────────────────
 * Frames sent before the channel opens are buffered IN ORDER and flushed ahead
 * of the frame that triggers the flush — including on the first post-open send,
 * because a channel whose `open` event fired before this adapter was wired
 * would otherwise never drain. The buffer is BOUNDED; dropping beyond the bound
 * is safe per SPEC (anti-entropy recovers dropped frames), and is preferred to
 * unbounded growth against a channel that may never open.
 */

/** The `RTCDataChannel` surface this adapter needs — narrowed so it is testable without WebRTC. */
export interface RtcDataChannelLike {
    readonly readyState: string;
    send(data: string): void;
    close(): void;
    addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
    addEventListener(type: 'open', cb: () => void): void;
    addEventListener(type: 'close', cb: () => void): void;
}

/**
 * Default pre-open frame cap.
 *
 * Matches `main-thread-bridge.ts`'s `DEFAULT_PRE_OPEN_QUEUE_CAP` deliberately:
 * both bound the same logical hop (main thread → real transport), so a frame
 * that survives one queue should not be dropped by the other at a different
 * threshold.
 */
export const DEFAULT_RTC_PRE_OPEN_CAP = 4096;

export interface RtcDataChannelTransportOptions {
    readonly preOpenCap?: number;
    /** Fires when a frame is dropped because the pre-open buffer is full. */
    readonly onDrop?: () => void;
}

/**
 * The `WebSocketLike` shape seqscribe's `dataChannelChannel` consumes.
 *
 * Declared structurally rather than imported from `seqscribe` so this module
 * stays usable from a plain DOM context; the field names and semantics are the
 * library's (`seqscribe/ws.ts`).
 */
export interface RtcTransportHandle {
    isOpen(): boolean;
    send(data: string): void;
    close(): void;
    addEventListener(type: 'message', cb: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', cb: () => void): void;
    addEventListener(type: 'open', cb: () => void): void;
    /** Frames currently buffered awaiting open — test/diagnostic view. */
    pendingCount(): number;
}

function channelOpen(dc: RtcDataChannelLike): boolean {
    // The string form is the one an RTCDataChannel actually reports; the
    // numeric form is accepted so a WebSocket-shaped stub also works.
    return dc.readyState === 'open' || (dc.readyState as unknown) === 1;
}

/**
 * Adapt one `RTCDataChannel` into the `WebSocketLike` surface seqscribe's
 * reference `dataChannelChannel` adapter expects.
 */
export function rtcDataChannelTransport(
    dc: RtcDataChannelLike,
    options: RtcDataChannelTransportOptions = {},
): RtcTransportHandle {
    const cap = options.preOpenCap ?? DEFAULT_RTC_PRE_OPEN_CAP;
    const preOpen: string[] = [];

    const flush = (): void => {
        // splice() first so a throwing send cannot re-enter and double-send the
        // remainder; frames leave in order.
        for (const frame of preOpen.splice(0)) dc.send(frame);
    };

    // Drain as soon as the channel opens, even if nothing is sent afterwards —
    // otherwise a buffered HELLO would wait for an outbound frame that, on a
    // subscribe-only consumer, may never come.
    dc.addEventListener('open', flush);

    return {
        isOpen: () => channelOpen(dc),
        send(data: string): void {
            if (!channelOpen(dc)) {
                // Bounded: drop rather than grow without limit. SPEC `:610` —
                // anti-entropy recovers dropped frames, so this is a
                // degradation, not a correctness break.
                if (preOpen.length >= cap) {
                    options.onDrop?.();
                    return;
                }
                preOpen.push(data);
                return;
            }
            // ★ Flush BEFORE the triggering frame, on every send — this is the
            // "first post-open send" case in SPEC `:605-610`. If the channel's
            // `open` event fired before this adapter was constructed, the
            // listener above never runs, and this is the only thing that drains
            // the buffer. Ordering matters: the buffered frames precede this one.
            if (preOpen.length > 0) flush();
            dc.send(data);
        },
        close: () => dc.close(),
        addEventListener(type: 'message' | 'close' | 'open', cb: never): void {
            dc.addEventListener(type as 'message', cb as (ev: { data: unknown }) => void);
        },
        pendingCount: () => preOpen.length,
    };
}
