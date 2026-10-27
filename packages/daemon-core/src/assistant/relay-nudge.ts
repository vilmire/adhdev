/**
 * Notice pull for a PTY assistant: before a relay is pushed in full, the
 * assistant gets one short `[ADHDev notice]` line and pulls the relay itself
 * (`assistantEvents` on its next `projects` / `project_status` call, which
 * claims it through `AssistantRelay.pullPending`). An unpulled notice repeats
 * on a doubling backoff; after the last attempt's backoff the caller pushes
 * the relay in full, so nothing waits on the assistant forever.
 *
 * State is in-memory per daemon process: after a restart, relays restored
 * from the store start again at attempt 1.
 */
import type { SubmitOutcome } from '@adhdev/mesh-shared';
import { buildRelayNudge, RELAY_NUDGE_BACKOFF_MAX_MS, RELAY_NUDGE_BACKOFF_MS, RELAY_NUDGE_MAX_ATTEMPTS } from './assistant-relay-format.js';
import type { RelayClock } from './assistant-relay-types.js';

/** `nudged`: a notice went out. `waiting`: hold the relay (backoff, refusal or cancel). `push`: deliver in full now. */
export type NudgeDecision = 'nudged' | 'waiting' | 'push';

export class RelayNudgeGate {
    private attempts = 0;
    private nextAt = 0;
    private timer: unknown = null;
    /** Bumped by reset(): a submit or timer from before it must not touch the new state. */
    private epoch = 0;

    constructor(private readonly clock: RelayClock, private readonly wake: () => void,
        private readonly maxAttempts = RELAY_NUDGE_MAX_ATTEMPTS, private readonly backoffMs = RELAY_NUDGE_BACKOFF_MS) {}

    /** The relays were pulled, pushed or dropped: the next relay starts at attempt 1. */
    reset(): void {
        this.epoch += 1;
        this.clearTimer();
        this.attempts = 0;
        this.nextAt = 0;
    }

    async decide(notice: { count: number; projects: readonly string[] },
        send: (text: string, attempt: number) => Promise<SubmitOutcome>, canceled: () => boolean): Promise<NudgeDecision> {
        if (this.maxAttempts <= 0) return 'push';
        const epoch = this.epoch;
        const now = this.clock.now();
        if (this.nextAt > now) {
            this.arm(this.nextAt - now, epoch);
            return 'waiting';
        }
        if (this.attempts >= this.maxAttempts) {
            this.reset();
            return 'push';
        }
        const attempt = this.attempts + 1;
        const outcome = await send(buildRelayNudge(notice), attempt);
        // A refused notice wrote nothing: not counted, retried on the next ready edge.
        if (epoch !== this.epoch || canceled() || outcome.kind === 'refused') return 'waiting';
        this.attempts = attempt;
        const delay = Math.min(RELAY_NUDGE_BACKOFF_MAX_MS, this.backoffMs * 2 ** (attempt - 1));
        this.nextAt = now + delay;
        this.arm(delay, epoch);
        return 'nudged';
    }

    private arm(delayMs: number, epoch: number): void {
        this.clearTimer();
        this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            if (epoch === this.epoch) this.wake();
        }, Math.max(1, delayMs));
    }

    private clearTimer(): void {
        if (this.timer === null) return;
        this.clock.clearTimeout(this.timer);
        this.timer = null;
    }
}
