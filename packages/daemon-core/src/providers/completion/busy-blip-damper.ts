/**
 * Busy-blip damper — a "generating" frame that appears right after the FSM
 * settled to idle must persist before it may cancel an armed completion.
 *
 * Live cursor-cli (2026-10 fleet member): a finished turn's screen flipped
 * idle→busy→idle roughly every 3 s. Each idle armed the completion, each busy
 * blip cancelled it, so the completion gate never reached a verdict and the
 * dashboard showed "generating…" forever. A genuine resume keeps generating, so
 * deferring the cancel by BUSY_BLIP_DAMP_MS costs a real follow-up turn at most
 * that much latency on its `generating_started`, while a blip shorter than the
 * window leaves the armed completion untouched.
 *
 * State is per host in a WeakMap (no host-interface change). It is cleared the
 * moment any non-generating status is observed, so only an UNBROKEN busy run
 * longer than the window counts as a resume. While genuinely busy the adapter
 * reports change events continuously (spinner repaint), so the re-check after
 * the window needs no timer of its own.
 */
export const BUSY_BLIP_DAMP_MS = 2000;

const blipSince = new WeakMap<object, number>();

/** True when this idle→generating frame is still inside the damping window. */
export function dampBusyBlip(host: object, now: number): boolean {
    const since = blipSince.get(host);
    if (since === undefined) {
        blipSince.set(host, now);
        return true;
    }
    if (now - since < BUSY_BLIP_DAMP_MS) return true;
    blipSince.delete(host);
    return false;
}

/** Forget any running blip (a non-generating status was observed). */
export function clearBusyBlip(host: object): void {
    blipSince.delete(host);
}
