/**
 * ENTER-LOSS layer ① — shutdown drain gate for in-flight submits.
 *
 * 2026-09-10 incident: a 10,937-char completion notification was written into
 * the coordinator PTY; its CR was scheduled ≥1800ms out (large-body verified
 * submit), a daemon upgrade began 1.4s later, and teardown cleared the submit
 * timers — the body sat unsubmitted in the composer for 1h42m and was then
 * merge-submitted with the owner's next input. The consume ledger had already
 * marked the event drained BEFORE the PTY write, so no redelivery occurred.
 *
 * Called (via DaemonCliManager.drainInFlightSubmits) by
 * shutdownDaemonComponents BEFORE detachAll(): waits — bounded by the caller's
 * timeout, see SUBMIT_DRAIN_SHUTDOWN_MAX_WAIT_MS for the ceiling derivation —
 * for every adapter that reports an in-flight submit to finish firing its
 * submit key. With nothing in flight it returns immediately, so the normal
 * shutdown path pays zero added latency.
 *
 * LIMITATION: this gate only exists on the graceful shutdown path. SIGKILL, a
 * crash, or power loss never reach it — that is what the boot-time
 * composer-residue sweep (layer ③, boot/composer-residue-sweep.ts) is for.
 */
'use strict';

import { LOG } from '../logging/logger.js';
import type { CliAdapter } from '../cli-adapter-types.js';

export interface SubmitDrainResult {
    clean: boolean;
    waitedMs: number;
    pendingKeys: string[];
}

export async function drainInFlightSubmits(
    adapters: ReadonlyMap<string, CliAdapter>,
    timeoutMs: number,
): Promise<SubmitDrainResult> {
    const inFlight: Array<{ key: string; adapter: CliAdapter }> = [];
    for (const [key, adapter] of adapters) {
        try {
            if (typeof adapter.hasInFlightSubmit === 'function' && adapter.hasInFlightSubmit()) {
                inFlight.push({ key, adapter });
            }
        } catch { /* a broken adapter must not block shutdown */ }
    }
    if (inFlight.length === 0) return { clean: true, waitedMs: 0, pendingKeys: [] };

    const startedAt = Date.now();
    LOG.info('CLI', `Shutdown submit-drain gate: waiting up to ${timeoutMs}ms for ${inFlight.length} in-flight submit(s) [${inFlight.map(e => e.key).join(', ')}]`);
    await Promise.all(inFlight.map(({ key, adapter }) =>
        (typeof adapter.whenSubmitDrained === 'function'
            ? adapter.whenSubmitDrained(timeoutMs)
            : Promise.resolve(true)
        ).catch((e: any) => {
            LOG.warn('CLI', `Submit-drain wait failed for ${key}: ${e?.message || e}`);
            return false;
        })));
    const waitedMs = Date.now() - startedAt;
    const pendingKeys = inFlight
        .filter(({ adapter }) => {
            try { return typeof adapter.hasInFlightSubmit === 'function' && adapter.hasInFlightSubmit(); } catch { return false; }
        })
        .map(({ key }) => key);
    if (pendingKeys.length > 0) {
        // Loud by design: proceeding now DROPS these submits — their bodies stay
        // in the session-host composer across the restart. The boot-time residue
        // sweep is the recovery observation point for exactly this state.
        LOG.error('CLI', `Shutdown submit-drain gate TIMED OUT after ${waitedMs}ms — ${pendingKeys.length} submit(s) still unconfirmed [${pendingKeys.join(', ')}]. Their bodies may remain unsubmitted in the composer; the boot-time composer-residue sweep will report them.`);
    } else {
        LOG.info('CLI', `Shutdown submit-drain gate: all in-flight submits completed in ${waitedMs}ms`);
    }
    return { clean: pendingKeys.length === 0, waitedMs, pendingKeys };
}
