/**
 * Unconfirmed-notice recovery (live 2026-11-07). A coordinator notice that needs a decision (approval,
 * choice, ...) was typed into a codex composer, claimed `delivered`, and never reached the agent: the driver's
 * in-flight latch expired 60 s later with no confirmation and nothing retried it, so the parked worker
 * waited 35 min. This watch re-checks such a notice once the latch must have expired. When the send
 * engine/consume journal still cannot show the notice was taken, the delivery claim is released (the
 * deliver backlog then retypes it once the coordinator is idle) — exactly once per message. A confirmed
 * (`consumed`) notice is never touched, and a notice still parked in the driver FIFO is left alone.
 */
import type { NotifyKind } from '@adhdev/mesh-shared';
import type { ConsumeView } from '../../sessions/input-consume-ack.js';

/** Notices whose loss strands a worker or a decision — worth a verify-and-retry. */
export const CONSUME_WATCHED_NOTIFY: ReadonlySet<NotifyKind> = new Set<NotifyKind>(['approval', 'choice', 'blocked', 'failed', 'late_completion']);

/** The driver's in-flight latch self-expires at 60 s (providers/spec/submit-policy SEND_IN_FLIGHT_MAX_MS; not imported: mesh must not value-import providers) + slack. */
const LATCH_EXPIRY_PLUS_SLACK_MS = 65_000;

export interface NoticeConsumeWatchDeps {
    /** Refresh + read the consume journal for one message (SessionInputService.settleConsume). */
    settle(sessionId: string, messageId: string): Promise<ConsumeView | undefined>;
    /** Forget the input funnel's delivered-dedupe for the id so the retry is written, not answered `duplicate`. */
    forget(messageId: string): void;
    /** Drop one delivery claim (MeshNoticeRuntime.releaseDelivery — also schedules the backlog). */
    release(claimEventId: string): boolean;
    /** The driver FIFO still holds the body (not written yet) — not a loss. */
    stillParked?(sessionId: string, messageId: string): boolean;
    /**
     * The session started or finished a turn after `sinceMs`: it took the input typed before then. Live 2026-11-08:
     * a codex coordinator answered a blocked notice, but the consume journal still read `unknown`, so the notice was
     * released and typed a second time. A turn after the write is proof enough that it was consumed.
     */
    sessionTurnedSince?(sessionId: string, sinceMs: number): boolean;
    delayMs?: number;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
    log?: { info(m: string): void; warn(m: string): void };
}

export interface NoticeConsumeWatchInput {
    messageId: string;
    sessionId: string;
    /** Claim row ids of the primary notice and every coalesced companion. */
    claimEventIds: readonly string[];
    notify: NotifyKind;
}

export function createNoticeConsumeWatch(deps: NoticeConsumeWatchDeps) {
    const delayMs = deps.delayMs ?? LATCH_EXPIRY_PLUS_SLACK_MS;
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const retried = new Set<string>();
    const log = deps.log;
    async function check(input: NoticeConsumeWatchInput, writtenAt = 0): Promise<'consumed' | 'parked' | 'released' | 'unreleased'> {
        if (deps.stillParked?.(input.sessionId, input.messageId)) return 'parked';
        let view: ConsumeView | undefined;
        try { view = await deps.settle(input.sessionId, input.messageId); } catch { view = undefined; }
        if (view?.state === 'consumed') return 'consumed';
        if (view?.state === 'queued') return 'parked';
        let turned = false;
        try { turned = writtenAt > 0 && deps.sessionTurnedSince?.(input.sessionId, writtenAt) === true; } catch { turned = false; }
        if (turned) return 'consumed';
        retried.add(input.messageId);
        deps.forget(input.messageId);
        let released = 0;
        for (const id of input.claimEventIds) { try { if (deps.release(id)) released++; } catch { /* keep going */ } }
        log?.warn(`notice ${input.messageId} (${input.notify}) not confirmed consumed ${delayMs}ms after write (state=${view?.state ?? 'none'}) — claim released for one redelivery`);
        return released > 0 ? 'released' : 'unreleased';
    }
    return {
        check,
        watch(input: NoticeConsumeWatchInput): void {
            if (!CONSUME_WATCHED_NOTIFY.has(input.notify) || retried.has(input.messageId)) return;
            const writtenAt = Date.now();
            const t = setTimer(() => { void check(input, writtenAt).catch(() => undefined); }, delayMs);
            t.unref?.();
        },
    };
}
