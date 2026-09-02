/**
 * Browser RTCDataChannel → `WebSocketLike` adapter (Phase 3 unit 3).
 *
 * The tests here are all about the ONE failure mode seqscribe SPEC `:600-610`
 * singles out as silent: an RTCDataChannel reports the STRING `"open"`, so a
 * readiness predicate written as `readyState === 1` is PERMANENTLY false. Every
 * frame — HELLO included — then accumulates in the pre-open buffer and the
 * session never reaches ready, with no throw and no close. That is precisely
 * the shape of the `e6f341432` flap seen from the browser end, so it is worth
 * pinning directly rather than trusting the adapter by inspection.
 */
import { describe, expect, it, vi } from 'vitest';
import { rtcDataChannelTransport, type RtcDataChannelLike } from '../../src/transcript-transport/rtc-data-channel-transport.js';

/** A channel whose readyState is the STRING form a real RTCDataChannel reports. */
function fakeChannel(initial: string = 'connecting') {
    const sent: string[] = [];
    const listeners = new Map<string, (() => void)[]>();
    const dc: RtcDataChannelLike & { sent: string[]; readyState: string; fire(type: string): void } = {
        readyState: initial,
        sent,
        send(data: string) {
            sent.push(data);
        },
        close() {
            dc.readyState = 'closed';
        },
        addEventListener(type: string, cb: never) {
            const list = listeners.get(type) ?? [];
            list.push(cb as unknown as () => void);
            listeners.set(type, list);
        },
        fire(type: string) {
            for (const cb of listeners.get(type) ?? []) cb();
        },
    };
    return dc;
}

describe('rtcDataChannelTransport', () => {
    it('treats the STRING "open" as open — the SPEC :600 trap', () => {
        const dc = fakeChannel('open');
        const transport = rtcDataChannelTransport(dc);
        expect(transport.isOpen()).toBe(true);
        transport.send('HELLO');
        // If `isOpen` had tested `readyState === 1`, this frame would have been
        // buffered instead and the session would hang forever with no error.
        expect(dc.sent).toEqual(['HELLO']);
        expect(transport.pendingCount()).toBe(0);
    });

    it('buffers before open and flushes IN ORDER when the channel opens', () => {
        const dc = fakeChannel('connecting');
        const transport = rtcDataChannelTransport(dc);
        transport.send('one');
        transport.send('two');
        expect(dc.sent).toEqual([]);
        expect(transport.pendingCount()).toBe(2);

        dc.readyState = 'open';
        dc.fire('open');
        expect(dc.sent).toEqual(['one', 'two']);
        expect(transport.pendingCount()).toBe(0);
    });

    it('drains on the first post-open send when the open event predates wiring', () => {
        // SPEC :605-610 names this case explicitly: a transport whose open event
        // fired before the adapter was constructed never gets the listener
        // callback, so the send path must flush too — and must put the buffered
        // frames AHEAD of the one that triggered the flush.
        const dc = fakeChannel('connecting');
        const transport = rtcDataChannelTransport(dc);
        transport.send('buffered');

        dc.readyState = 'open'; // opened, but no event delivered
        transport.send('trigger');

        expect(dc.sent).toEqual(['buffered', 'trigger']);
    });

    it('bounds the pre-open buffer and reports drops', () => {
        const onDrop = vi.fn();
        const dc = fakeChannel('connecting');
        const transport = rtcDataChannelTransport(dc, { preOpenCap: 2, onDrop });

        transport.send('a');
        transport.send('b');
        transport.send('c'); // over cap

        expect(transport.pendingCount()).toBe(2);
        expect(onDrop).toHaveBeenCalledTimes(1);

        dc.readyState = 'open';
        dc.fire('open');
        // Dropping beyond the bound is SPEC-sanctioned (anti-entropy recovers
        // dropped frames); unbounded growth against a channel that may never
        // open is not.
        expect(dc.sent).toEqual(['a', 'b']);
    });
});
