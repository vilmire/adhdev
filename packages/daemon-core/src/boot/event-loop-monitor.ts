// ---------------------------------------------------------------------------
// event-loop-monitor — EVENT-LOOP-LAG-HEARTBEAT: make "process frozen" visible
// in the daemon log, distinct from "handler slow".
//
// Background (2026-08-18 RCA, verdict D): the daemon's event loop blacked out
// twice for 28.7s / 33.6s under Refinery load. The freeze could only be
// INFERRED from absence — a gap in the log with zero reconcile ticks — because
// nothing inside the process could speak while it was frozen. That forced the
// investigation to reason from negative evidence ("there is a hole, so it must
// have stopped") instead of reading a direct measurement.
//
// This monitor samples `perf_hooks.monitorEventLoopDelay` on a fixed interval
// and logs the worst-case delay observed per window. A stalled process produces
// a WARN line naming the blackout duration on the very next tick after it
// resumes — positive evidence, in the log, that the loop stopped turning. The
// per-tick DEBUG line also turns future log gaps into proof: a gap WITH lag
// WARNs around it is a stall; a gap in a handler that still ticks is not.
//
// The WARN deliberately does NOT assert which of the two stall shapes occurred.
// Both produce lag and they need opposite fixes, so the line reports `selfCpu`
// and names the discriminator instead: high self CPU means this process blocked
// its own loop (one slow synchronous handler); low self CPU with high drift
// means the OS did not schedule it (machine saturation). A previous version
// asserted the machine-saturation reading unconditionally and sent a real
// investigation (2026-08-23) down the wrong path while this PID alone was hot
// at load average 2.48 — hence the discriminator, not a verdict.
//
// Config (env): ADHDEV_EVENT_LOOP_MONITOR_INTERVAL_MS (default 10s; 0 disables),
// ADHDEV_EVENT_LOOP_LAG_WARN_MS (default 5s — the freeze blackouts were 15–34s,
// so 5s catches them with margin without nagging on ordinary GC pauses).
// ---------------------------------------------------------------------------

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { LOG } from '../logging/logger.js';
import { AsyncBatchWriter } from '../logging/async-batch-writer.js';

export const EVENT_LOOP_MONITOR_INTERVAL_ENV = 'ADHDEV_EVENT_LOOP_MONITOR_INTERVAL_MS';
export const EVENT_LOOP_LAG_WARN_ENV = 'ADHDEV_EVENT_LOOP_LAG_WARN_MS';
export const DEFAULT_EVENT_LOOP_MONITOR_INTERVAL_MS = 10_000;
export const DEFAULT_EVENT_LOOP_LAG_WARN_MS = 5_000;

export interface EventLoopMonitorHandle {
    stop(): void;
}

function parseMs(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveEventLoopMonitorIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
    return parseMs(env[EVENT_LOOP_MONITOR_INTERVAL_ENV], DEFAULT_EVENT_LOOP_MONITOR_INTERVAL_MS);
}

export function resolveEventLoopLagWarnMs(env: NodeJS.ProcessEnv = process.env): number {
    return parseMs(env[EVENT_LOOP_LAG_WARN_ENV], DEFAULT_EVENT_LOOP_LAG_WARN_MS);
}

/** Injectable sink so tests can capture lines without touching the log file. */
export type EventLoopMonitorLogFn = (level: 'debug' | 'warn', message: string) => void;

function defaultLogFn(level: 'debug' | 'warn', message: string): void {
    if (level === 'warn') {
        LOG.warn('EventLoop', message);
        // A lag warning is the one line that must not be lost to the condition
        // it reports: the batch writer flushes on a timer, and a loop blocked
        // long enough to trigger this warning is exactly a loop that may never
        // give that timer a tick. Drain synchronously so the evidence survives.
        AsyncBatchWriter.flushSync();
    } else {
        LOG.debug('EventLoop', message);
    }
}

/**
 * Start the heartbeat. Returns a no-op handle when disabled (interval 0), so
 * callers never branch. The timer is unref'd — the monitor must never keep the
 * process alive. Never throws: an observability helper that could crash boot
 * would be worse than the blind spot it removes.
 */
export function startEventLoopMonitor(opts?: {
    intervalMs?: number;
    warnMs?: number;
    logFn?: EventLoopMonitorLogFn;
}): EventLoopMonitorHandle {
    const intervalMs = opts?.intervalMs ?? resolveEventLoopMonitorIntervalMs();
    const warnMs = opts?.warnMs ?? resolveEventLoopLagWarnMs();
    const logFn = opts?.logFn ?? defaultLogFn;
    if (intervalMs <= 0) return { stop: () => { /* disabled */ } };

    let histogram: IntervalHistogram;
    try {
        histogram = monitorEventLoopDelay({ resolution: 20 });
        histogram.enable();
    } catch {
        return { stop: () => { /* unsupported runtime — observability is best-effort */ } };
    }

    let expectedTickAt: number | null = null;
    // Previous cpuUsage sample, so each window reports the CPU this PROCESS
    // burned during that window. process.cpuUsage() reads counters Node already
    // holds — no child process, no /proc walk, no syscall that could block the
    // very loop we are measuring. That constraint is why this is the CPU signal
    // used here and not `ps`/`top` output.
    let lastCpu: NodeJS.CpuUsage | null = null;
    let lastCpuAt: number | null = null;
    const timer = setInterval(() => {
        try {
            const now = Date.now();
            // TIMER-DRIFT half of the measurement: monitorEventLoopDelay only
            // counts loop iterations the process actually woke for; a loop
            // blocked in one long synchronous stretch — or a process simply
            // not scheduled by the OS (the observed freeze shape) — shows up
            // most directly as this tick firing LATE. Drift is therefore the
            // primary freeze signal; the histogram adds sub-tick granularity.
            const driftMs = expectedTickAt === null ? 0 : Math.max(0, now - expectedTickAt);
            expectedTickAt = now + intervalMs;
            const maxMs = histogram.max / 1e6;
            const p99Ms = histogram.percentile(99) / 1e6;
            const meanMs = histogram.mean / 1e6;
            histogram.reset();
            const worstMs = Math.max(driftMs, maxMs);
            // Self CPU% over the window: ~100% (or more, across threads) means
            // this process was RUNNING the whole time — it blocked itself. A
            // low value while lagging means it was waiting to be scheduled.
            const cpuNow = process.cpuUsage();
            let cpuPct: number | null = null;
            if (lastCpu !== null && lastCpuAt !== null) {
                const elapsedMs = now - lastCpuAt;
                if (elapsedMs > 0) {
                    const usedMs = ((cpuNow.user - lastCpu.user) + (cpuNow.system - lastCpu.system)) / 1000;
                    cpuPct = (usedMs / elapsedMs) * 100;
                }
            }
            lastCpu = cpuNow;
            lastCpuAt = now;
            const cpuPart = cpuPct === null ? '' : ` selfCpu=${cpuPct.toFixed(0)}%`;
            const message = `event-loop lag: drift=${driftMs.toFixed(0)}ms max=${maxMs.toFixed(0)}ms p99=${p99Ms.toFixed(0)}ms mean=${meanMs.toFixed(1)}ms${cpuPart} over ${intervalMs}ms window`;
            if (worstMs >= warnMs) {
                // Do NOT assert a cause here. Both shapes produce lag and they
                // need opposite fixes, so state the discriminator and let the
                // reader decide:
                //   selfCpu high (~100%+) → this process blocked its own loop
                //     in one long synchronous stretch. Find the handler.
                //   selfCpu low + drift high → the process was runnable but not
                //     scheduled. Look at machine-wide load, not at our handlers.
                // An earlier version of this line asserted "machine saturation,
                // not one slow handler" unconditionally. That reading was wrong
                // in a real incident (load average 2.48, this PID alone hot) and
                // it misdirected the investigation toward the machine, so the
                // assertion is gone on purpose — do not reintroduce it.
                logFn('warn', `${message} — EXCEEDS ${warnMs}ms. Cause is one of two shapes:`
                    + ` high selfCpu ⇒ this process blocked its own loop (one slow synchronous handler);`
                    + ` low selfCpu with high drift ⇒ the process was unscheduled (machine saturation).`
                    + ` Expect IPC probe timeouts and reconcile-tick gaps in this window.`);
            } else {
                logFn('debug', message);
            }
        } catch { /* never let observability take the loop down */ }
    }, intervalMs);
    expectedTickAt = Date.now() + intervalMs;
    timer.unref?.();

    return {
        stop: () => {
            clearInterval(timer);
            try { histogram.disable(); } catch { /* noop */ }
        },
    };
}
