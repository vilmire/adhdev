/**
 * Phase 2 Stage 3 — the parity loop's mesh-side half.
 *
 * `seqscribe/mesh-parity.ts` owns the COMPARISON but cannot read the ledger:
 * `check:boundaries` forbids `seqscribe/** → mesh/**`, and that rule is worth
 * keeping — it is what stops the replication layer from growing a dependency on
 * the mesh runtime. So the read lives here, on the mesh side, and the comparison
 * is called with the entries as an argument.
 *
 * ── Cadence ────────────────────────────────────────────────────────────────
 * Slow (15 min) and unref'd. Parity is a dogfood-window measurement, not a
 * monitor: Stage 4's gate is "zero mismatches over a real window", and sampling
 * every few seconds would cost ledger reads on every mesh for no extra signal.
 *
 * ── Bounded window ─────────────────────────────────────────────────────────
 * Only the most recent `PARITY_TAIL` ledger entries are compared. Two reasons,
 * and the second is the load-bearing one:
 *
 *   1. Cost — a full ledger read per mesh per tick is unbounded work.
 *   2. ★ Correctness of the comparison itself. The shadow leg starts writing
 *      when the daemon boots, so every ledger entry written BEFORE this feature
 *      existed (or before this boot) has no shadow record and would be reported
 *      as `missing_in_shadow` forever. A tail bounded to entries appended since
 *      the shadow armed is the only window where a mismatch means what the
 *      counter claims it means. `armedAt` enforces exactly that.
 */

import { listMeshesReadOnly } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import {
    runMeshParityCheck,
    type ParityLedgerEntry,
} from '../seqscribe/mesh-parity.js';
import type { SeqscribeNodeHandle } from '../seqscribe/node.js';
import { isMeshDualWriteActive } from '../seqscribe/mesh-dual-write.js';
import { readLedgerEntries } from './mesh-ledger.js';

/** How often a parity sweep runs. Slow on purpose — see the header. */
export const PARITY_INTERVAL_MS = 15 * 60 * 1000;

/** Maximum ledger entries compared per mesh per sweep. */
export const PARITY_TAIL = 500;

export interface MeshParityLoopHandle {
    stop(): void;
    /** Run one sweep immediately. Exposed for tests and manual triage. */
    runOnce(): Promise<void>;
}

export interface MeshParityLoopOptions {
    intervalMs?: number;
    /**
     * Wall-clock ms marking when the shadow leg armed. Ledger entries older
     * than this are excluded — they predate the shadow and their absence is
     * expected, not a mismatch. Defaults to now.
     */
    armedAt?: number;
    /** Skip arming the interval; run sweeps manually. TESTS ONLY. */
    once?: boolean;
}

/**
 * Start the parity loop.
 *
 * Returns null when the shadow leg is not active — with nothing being written
 * there is nothing to compare, and running anyway would report every ledger
 * entry as missing.
 *
 * Never throws, and a sweep that fails logs and returns: parity is diagnostics.
 */
export function startMeshParityLoop(
    handle: SeqscribeNodeHandle,
    opts: MeshParityLoopOptions = {},
): MeshParityLoopHandle | null {
    if (!isMeshDualWriteActive()) {
        LOG.info('Seqscribe', 'parity loop idle — mesh dual-write shadow is not active');
        return null;
    }

    const armedAt = opts.armedAt ?? Date.now();
    let stopped = false;

    const runOnce = async (): Promise<void> => {
        if (stopped) return;
        let meshIds: string[];
        try {
            meshIds = listMeshesReadOnly().map((m) => m.id);
        } catch (error) {
            LOG.warn(
                'Seqscribe',
                `parity sweep could not list meshes: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }

        for (const meshId of meshIds) {
            if (stopped) return;
            try {
                // Only entries appended since the shadow armed — see header.
                const entries: ParityLedgerEntry[] = readLedgerEntries(meshId, {
                    tail: PARITY_TAIL,
                }).filter((e) => {
                    const at = new Date(e.timestamp).getTime();
                    return Number.isFinite(at) && at >= armedAt;
                });
                if (entries.length === 0) continue;
                await runMeshParityCheck(handle, meshId, entries);
            } catch (error) {
                LOG.warn(
                    'Seqscribe',
                    `parity sweep failed mesh=${meshId}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    if (!opts.once) {
        timer = setInterval(() => {
            void runOnce();
        }, opts.intervalMs ?? PARITY_INTERVAL_MS);
        // Parity must never be the reason a process stays alive.
        timer.unref?.();
    }

    LOG.info('Seqscribe', 'mesh parity loop armed');

    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            if (timer) clearInterval(timer);
        },
        runOnce,
    };
}
