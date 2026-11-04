/**
 * Daemon-side backstop for a session host that is alive but serves nothing.
 *
 * The host has its own watchdog (it kills itself when the libuv pool stalls),
 * but 2026-10-21 and 2026-11-02 showed a host process that stayed alive, kept
 * its socket, and answered no request for hours. The daemon's respawn logic only
 * reacts to a refused connection, so "host process is alive" never recovered.
 *
 * Policy (every clause is a guard against killing a host that is merely busy):
 *  - a probe is an isolated `get_host_diagnostics` RPC without session payload,
 *    which a busy host with a free main loop answers in milliseconds;
 *  - only a CONNECTED-then-timed-out (or connect-hung) probe counts; a refused or
 *    absent socket is the existing respawn path, an observer-starved timeout
 *    (this daemon's own loop lagged) is ignored, any answer resets the streak;
 *  - the streak must span `thresholdMs` (default 5 min) and `minSamples` probes
 *    against ONE host identity (pid + native birth);
 *  - one last confirmation probe with a longer timeout runs right before acting;
 *  - the kill itself re-verifies pid, birth and managed command line;
 *  - cooldown and an hourly cap bound the damage of any misjudgement;
 *  - nothing runs while cooperative maintenance holds the daemon.
 */

export type WedgeProbeResult = 'ok' | 'timeout' | 'unreachable' | 'starved';

export interface WedgedHostIdentity {
    pid: number;
    /** Native process birth (`ps -o lstart=`); null where unavailable. */
    birth: string | null;
}

export interface WedgedHostSupervisorDeps {
    /** Isolated diagnostics probe. `longTimeout` is the pre-kill confirmation. */
    probe(longTimeout: boolean): Promise<WedgeProbeResult>;
    /** Current host process identity from the pidfile, or null when none. */
    identity(): WedgedHostIdentity | null;
    /** Best-effort diagnostics capture; returns a file path or a short note. */
    capture(identity: WedgedHostIdentity, context: WedgeContext): Promise<string | undefined>;
    /** SIGKILL after re-verifying identity; true when a signal was sent. */
    kill(identity: WedgedHostIdentity): boolean;
    /** Brings a new host up (single-flight `ensure`). */
    respawn(): Promise<unknown>;
    maintenanceHeld(): boolean;
    log(level: 'info' | 'warn' | 'error', message: string): void;
    now?(): number;
}

export interface WedgeContext {
    streakMs: number;
    samples: number;
}

export interface WedgedHostSupervisorOptions {
    intervalMs?: number;
    thresholdMs?: number;
    minSamples?: number;
    cooldownMs?: number;
    maxRecoveriesPerHour?: number;
}

export const WEDGED_HOST_PROBE_INTERVAL_MS = 30_000;
export const WEDGED_HOST_THRESHOLD_MS = 5 * 60_000;
export const WEDGED_HOST_MIN_SAMPLES = 6;
export const WEDGED_HOST_COOLDOWN_MS = 10 * 60_000;
export const WEDGED_HOST_MAX_RECOVERIES_PER_HOUR = 3;

export type WedgeTickOutcome =
    | 'idle' | 'ok' | 'counting' | 'skipped' | 'aborted' | 'recovered' | 'kill_refused' | 'rate_limited';

export interface WedgedHostSupervisor {
    start(): void;
    stop(): void;
    /** One probe + decision; exposed for tests. */
    tick(): Promise<WedgeTickOutcome>;
}

const sameHost = (a: WedgedHostIdentity | null, b: WedgedHostIdentity | null): boolean =>
    !!a && !!b && a.pid === b.pid && a.birth === b.birth;

export function createWedgedHostSupervisor(
    deps: WedgedHostSupervisorDeps,
    options: WedgedHostSupervisorOptions = {},
): WedgedHostSupervisor {
    const intervalMs = options.intervalMs ?? WEDGED_HOST_PROBE_INTERVAL_MS;
    const thresholdMs = options.thresholdMs ?? WEDGED_HOST_THRESHOLD_MS;
    const minSamples = options.minSamples ?? WEDGED_HOST_MIN_SAMPLES;
    const cooldownMs = options.cooldownMs ?? WEDGED_HOST_COOLDOWN_MS;
    const maxPerHour = options.maxRecoveriesPerHour ?? WEDGED_HOST_MAX_RECOVERIES_PER_HOUR;
    const now = deps.now ?? Date.now;

    let timer: NodeJS.Timeout | null = null;
    let running = false;
    let streak: { identity: WedgedHostIdentity; firstAt: number; samples: number } | null = null;
    let lastRecoveryAt = -Infinity;
    const recoveries: number[] = [];

    const tick = async (): Promise<WedgeTickOutcome> => {
        if (running) return 'idle';
        if (deps.maintenanceHeld()) { streak = null; return 'skipped'; }
        running = true;
        try {
            const identity = deps.identity();
            if (!identity) { streak = null; return 'idle'; }
            const result = await deps.probe(false);
            if (result === 'ok' || result === 'unreachable') { streak = null; return 'ok'; }
            if (result === 'starved') return 'counting';
            // The pidfile may have moved to a new host while the probe was out.
            if (!sameHost(identity, deps.identity())) { streak = null; return 'idle'; }
            if (!streak || !sameHost(streak.identity, identity)) {
                streak = { identity, firstAt: now(), samples: 0 };
            }
            streak.samples += 1;
            const streakMs = now() - streak.firstAt;
            if (streakMs < thresholdMs || streak.samples < minSamples) return 'counting';

            const t = now();
            if (t - lastRecoveryAt < cooldownMs) return 'rate_limited';
            while (recoveries.length && t - recoveries[0] > 3_600_000) recoveries.shift();
            if (recoveries.length >= maxPerHour) return 'rate_limited';

            // Last chance for a host that was only slow: a longer probe.
            const confirm = await deps.probe(true);
            if (confirm !== 'timeout') {
                streak = confirm === 'starved' ? streak : null;
                return 'aborted';
            }
            if (deps.maintenanceHeld() || !sameHost(identity, deps.identity())) { streak = null; return 'aborted'; }

            const context = { streakMs, samples: streak.samples };
            deps.log('error', `Session host pid ${identity.pid} is alive but answered no diagnostics probe for `
                + `${Math.round(streakMs / 1000)}s (${streak.samples} probes); capturing diagnostics then restarting it.`);
            let captured: string | undefined;
            try { captured = await deps.capture(identity, context); } catch { /* best-effort */ }
            if (captured) deps.log('warn', `Wedged session host diagnostics: ${captured}`);

            if (!sameHost(identity, deps.identity())) { streak = null; return 'aborted'; }
            const killed = deps.kill(identity);
            if (!killed) {
                deps.log('warn', `Wedged session host pid ${identity.pid} was not signalled (identity or ownership check refused).`);
                return 'kill_refused';
            }
            lastRecoveryAt = now();
            recoveries.push(lastRecoveryAt);
            streak = null;
            try { await deps.respawn(); } catch (error: any) {
                deps.log('error', `Session host respawn after wedge recovery failed: ${error?.message || error}`);
            }
            return 'recovered';
        } finally {
            running = false;
        }
    };

    return {
        start() {
            if (timer) return;
            timer = setInterval(() => { void tick().catch(() => {}); }, intervalMs);
            timer.unref?.();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
        tick,
    };
}
