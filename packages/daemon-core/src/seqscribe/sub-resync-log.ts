/**
 * Rate-limited WARN for the vendor's `sub_resync` anomaly (a SUB subscriber
 * fell back to a coalesced SNAP because its peer's data lane was full, or one
 * DELTA exceeded the frame cap — see the vendor's host-guide §4.6).
 *
 * The anomaly fires once per resync ENTRY, not per write, but a persistently
 * slow subscriber can still re-enter after every recovered SNAP. One line per
 * (topic, peer) per window, carrying how many entries the window swallowed,
 * keeps the signal readable without letting it become log spam. Identifiers
 * only (topic names embed session ids — the daemon log is a local surface);
 * never entry content.
 */

export const SUB_RESYNC_WARN_WINDOW_MS = 60_000;

/** Bound on remembered (topic, peer) keys — a resync storm across many topics must not grow this without limit. */
const MAX_KEYS = 512;

export interface SubResyncEvent {
    topic?: string;
    peerId?: string;
    view?: string;
    reason?: string;
}

export function createSubResyncWarner(
    warn: (message: string) => void,
    clock: () => number = () => Date.now(),
    windowMs: number = SUB_RESYNC_WARN_WINDOW_MS,
): (e: SubResyncEvent, node: string) => void {
    const last = new Map<string, { at: number; suppressed: number }>();
    return (e, node) => {
        const key = `${e.topic ?? '?'}\u0000${e.peerId ?? '?'}`;
        const now = clock();
        const prev = last.get(key);
        if (prev && now - prev.at < windowMs) {
            prev.suppressed++;
            return;
        }
        if (!prev && last.size >= MAX_KEYS) {
            const oldest = last.keys().next().value;
            if (oldest !== undefined) last.delete(oldest);
        }
        const suppressed = prev?.suppressed ?? 0;
        last.delete(key);
        last.set(key, { at: now, suppressed: 0 });
        warn(
            `sub resync node=${node}` +
                (e.topic ? ` topic=${e.topic}` : '') +
                (e.peerId ? ` peer=${e.peerId}` : '') +
                (e.view ? ` view=${e.view}` : '') +
                ` reason=${e.reason ?? 'unknown'}` +
                (suppressed > 0 ? ` (+${suppressed} more in the last ${Math.round(windowMs / 1000)}s)` : '') +
                ' — subscriber stopped taking DELTAs; one coalesced SNAP is sent once its lane drains',
        );
    };
}
