/**
 * Relay -> direct re-probe scheduler (pure, dependency-free).
 *
 * A P2P connection that settled on a TURN relay never looks for a direct path
 * again. The owning transport (dashboard `P2PConnection`, daemon peer manager)
 * uses this scheduler to periodically attempt a make-before-break probe: a
 * SECOND peer connection (STUN-only) is built next to the working relay one and
 * only swapped in once it is verified direct. The scheduler owns nothing but
 * timing: backoff 60s -> 5min (doubling), jitter, and the stop conditions. The
 * transport supplies `shouldProbe` (open + idle + visible) and `probe`.
 */

export type RelayReprobeOutcome = 'direct' | 'relay' | 'failed' | 'skipped'

export interface RelayReprobeTiming {
    /** First delay and the unit of growth (default 60s). */
    baseDelayMs?: number
    /** Backoff ceiling before jitter (default 5min). */
    maxDelayMs?: number
    /** +/- fraction applied to every delay (default 0.2). */
    jitterRatio?: number
}

export const RELAY_REPROBE_BASE_DELAY_MS = 60_000
export const RELAY_REPROBE_MAX_DELAY_MS = 5 * 60_000
export const RELAY_REPROBE_JITTER_RATIO = 0.2

/** Delay before the next attempt after `failures` consecutive non-direct outcomes. */
export function computeRelayReprobeDelay(
    failures: number,
    random: () => number,
    timing: RelayReprobeTiming = {},
): number {
    const base = timing.baseDelayMs ?? RELAY_REPROBE_BASE_DELAY_MS
    const max = timing.maxDelayMs ?? RELAY_REPROBE_MAX_DELAY_MS
    const jitter = timing.jitterRatio ?? RELAY_REPROBE_JITTER_RATIO
    const grown = Math.min(max, base * 2 ** Math.max(0, failures))
    const factor = 1 + jitter * (Math.min(1, Math.max(0, random())) * 2 - 1)
    return Math.round(grown * factor)
}

export interface RelayReprobeSchedulerOptions extends RelayReprobeTiming {
    random: () => number
    setTimer: (callback: () => void, ms: number) => unknown
    clearTimer: (handle: unknown) => void
    /** Connected over relay, idle, tab visible, auth epoch unchanged... Re-checked on every tick. */
    shouldProbe: () => boolean
    /** One make-before-break attempt. Must never throw into the scheduler; a rejection counts as 'failed'. */
    probe: () => Promise<RelayReprobeOutcome>
}

export class RelayReprobeScheduler {
    private handle: unknown = null
    private running = false
    private inFlight = false
    private failureCount = 0
    private generation = 0

    constructor(private readonly options: RelayReprobeSchedulerOptions) {}

    get isRunning(): boolean { return this.running }
    get failures(): number { return this.failureCount }
    get probing(): boolean { return this.inFlight }

    /** Begin probing (idempotent). Call when a connection is selected as relay. */
    start(): void {
        if (this.running) return
        this.running = true
        this.failureCount = 0
        this.generation++
        this.schedule()
    }

    /** Stop for good (direct path found, connection closed, auth epoch changed). */
    stop(): void {
        this.running = false
        this.generation++
        if (this.handle !== null) {
            this.options.clearTimer(this.handle)
            this.handle = null
        }
    }

    private schedule(): void {
        if (!this.running) return
        const generation = this.generation
        const delay = computeRelayReprobeDelay(this.failureCount, this.options.random, this.options)
        this.handle = this.options.setTimer(() => {
            this.handle = null
            void this.tick(generation)
        }, delay)
    }

    private async tick(generation: number): Promise<void> {
        if (!this.running || generation !== this.generation) return
        if (this.inFlight || !this.options.shouldProbe()) {
            this.schedule()
            return
        }
        this.inFlight = true
        let outcome: RelayReprobeOutcome
        try {
            outcome = await this.options.probe()
        } catch {
            outcome = 'failed'
        }
        this.inFlight = false
        // stop()/restart while the probe was in flight: the verdict is stale.
        if (!this.running || generation !== this.generation) return
        if (outcome === 'direct') {
            this.stop()
            return
        }
        if (outcome !== 'skipped') this.failureCount++
        this.schedule()
    }
}
