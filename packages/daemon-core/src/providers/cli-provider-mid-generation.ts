/**
 * NOTIF-IMMEDIACY: mid-generation queued-input pass-throughs for a CLI session.
 *
 * Two tiny adapter projections, extracted out of `cli-provider-instance.ts`
 * rather than added to it: that file sits within a couple of lines of the 2,400
 * line file-size gate, and the established convention in this directory is a
 * `cli-provider-*.ts` sibling (see cli-provider-bracketed-paste.ts, which is the
 * same shape — a small pure helper the instance delegates to).
 *
 * Both helpers are deliberately structural (they take the adapter as a shape,
 * not as a class) so the mesh delivery path can ask an INSTANCE what it holds
 * without any code here knowing which adapter implementation is underneath, and
 * so a test double satisfies them without subclassing.
 *
 * ★ Neither helper makes a policy decision. Whether a mid-generation write is
 * ALLOWED (POSIX-only, spec opt-in, size ceiling) is the mesh caller's business,
 * and whether it is ADMISSIBLE right now (ready-once, generating-only, in-flight
 * latch, duplicate suppression) belongs to the driver engine, which is the single
 * authority — a second opinion about send readiness is the class of bug the
 * SEND-OVERLAP work removed.
 */
'use strict';

/** The slice of a CLI adapter these helpers read. Structural on purpose. */
export interface MidGenerationCapableAdapter {
    supportsMidGenerationQueue?(): boolean;
    sendMessageDuringGeneration?(text: string): { accepted: boolean; reason?: string };
}

/**
 * Does this session's SPEC opt into mid-turn queued input
 * (`send_message.mid_generation_queue`)?
 *
 * False for any adapter that does not implement the probe — the conservative
 * answer, which keeps the caller on the existing held path. A spec opts in only
 * after its own live A/B; nothing is extrapolated from claude-cli's measurement.
 */
export function adapterSupportsMidGenerationQueue(adapter: unknown): boolean {
    const a = adapter as MidGenerationCapableAdapter | null | undefined;
    if (!a || typeof a.supportsMidGenerationQueue !== 'function') return false;
    try {
        return a.supportsMidGenerationQueue() === true;
    } catch {
        return false;
    }
}

/**
 * Hand `text` to the CLI's OWN input queue while the session is generating (the
 * SEND-NOW-AGENT-QUEUE split write).
 *
 * `accepted: false` ALWAYS means zero bytes were written — that is the engine's
 * contract — so a refusal is safe for the caller to fall back from without any
 * risk of double-sending. A throw is normalised into the same refusal shape for
 * the same reason: the caller's fallback must never be skipped because of an
 * exception it cannot classify.
 */
export function adapterSendMessageDuringGeneration(
    adapter: unknown,
    text: string,
): { accepted: boolean; reason?: string } {
    const a = adapter as MidGenerationCapableAdapter | null | undefined;
    if (!a || typeof a.sendMessageDuringGeneration !== 'function') {
        return { accepted: false, reason: 'not_supported' };
    }
    try {
        return a.sendMessageDuringGeneration(text);
    } catch (e: any) {
        return { accepted: false, reason: `threw:${e?.message || e}` };
    }
}
