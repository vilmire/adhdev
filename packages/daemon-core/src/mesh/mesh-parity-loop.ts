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
 *      the shadow armed is the only window where a mismatch WITHIN THIS
 *      PROCESS's writes means what the counter claims. `armedAt` enforces that.
 *
 * ── ★ `armedAt` is necessary but was never sufficient — the backfill ───────
 * The header above used to claim the `armedAt` window is the ONLY interval in
 * which a mismatch is meaningful. That premise was incomplete, and the gap was
 * not temporal at all — it is a PROCESS boundary.
 *
 * `armedAt` filters out entries written before THIS process armed its shadow.
 * It cannot filter out entries written by a DIFFERENT process that never armed
 * one. The **mcp-server process** calls `appendLedgerEntry` in-process (~20
 * ledger kinds — missions, graph gates, enqueue decisions, dispatch, operating
 * notes) with `activeNode` permanently null, so its entries land in the shared
 * SQLite ledger, are inside the `armedAt` window by timestamp, and have no
 * shadow record. See the process-boundary section in `seqscribe/mesh-dual-write.ts`
 * for the full mechanism and why the mcp-server cannot arm its own leg (the
 * seqscribe DB is single-owner-locked and the daemon holds it).
 *
 * So the sweep does two things now, in this order:
 *
 *   1. DETECT — `runMeshParityCheck` runs exactly as before and reports and
 *      counts every mismatch. ★ Unchanged, deliberately: excluding those kinds
 *      from the comparison would make the gate pass by not looking.
 *   2. REPAIR — entries reported `missing_in_shadow` are mirrored from the
 *      ledger through the same projection, counted in their own bucket.
 *
 * The signal survives the repair: a `missing_in_shadow` that reappears in the
 * NEXT sweep for an entry already backfilled is a real replication failure,
 * because the expected cross-process gap is one the repair closes.
 */

import { listMeshesReadOnly } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import {
    runMeshParityCheck,
    type ParityLedgerEntry,
} from '../seqscribe/mesh-parity.js';
import type { SeqscribeNodeHandle } from '../seqscribe/node.js';
import {
    backfillMeshEventShadow,
    isMeshDualWriteActive,
} from '../seqscribe/mesh-dual-write.js';
import { readLedgerEntries } from './mesh-ledger.js';

/** How often a parity sweep runs. Slow on purpose — see the header. */
export const PARITY_INTERVAL_MS = 15 * 60 * 1000;

/** Maximum ledger entries compared per mesh per sweep. */
export const PARITY_TAIL = 500;

/**
 * Maximum entries the backfill mirrors per mesh per sweep.
 *
 * The cap is the runaway guard the repair needs, and its size is chosen against
 * the two things it sits between. Above it: `PARITY_TAIL` (500) bounds how many
 * mismatches a single sweep can even report, so this can never be asked for
 * more than that. Below it: `MAX_INFLIGHT` (512) in the dual-write module is the
 * load-shed cap that protects the topic, and a backfill burst must not be able
 * to consume the whole budget and start shedding the daemon's own INLINE writes
 * — the ones that are on the live path.
 *
 * 100 leaves the inline leg ~80% of the in-flight budget while still repairing a
 * realistic mcp-server backlog within a couple of sweeps. A backlog larger than
 * this drains across sweeps rather than in one burst, and the residue is logged
 * rather than silently truncated.
 */
export const PARITY_BACKFILL_CAP = 100;

/**
 * Consecutive failed sweeps before the backfill pauses for a mesh.
 *
 * If the repair path itself is broken — a closed node, an undefinable topic —
 * retrying 100 mirrors every sweep forever is pure waste, and the mismatch
 * counter already carries the signal. Backing off after two consecutive
 * all-failed sweeps stops the churn; any successful mirror resets it.
 */
export const PARITY_BACKFILL_FAILURE_LIMIT = 2;

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
    /**
     * Mirror entries found `missing_in_shadow` back into the shadow topic.
     * Defaults to true. Setting it false leaves DETECTION fully intact and
     * disables only the repair — the shape an operator wants when diagnosing
     * whether a backlog is the known cross-process gap or something new.
     */
    backfill?: boolean;
    /** Per-mesh per-sweep mirror cap. Defaults to `PARITY_BACKFILL_CAP`. */
    backfillCap?: number;
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
    const backfillEnabled = opts.backfill !== false;
    const backfillCap = opts.backfillCap ?? PARITY_BACKFILL_CAP;
    let stopped = false;

    /** Consecutive all-failed backfill sweeps, per mesh. Reset by any success. */
    const backfillFailures = new Map<string, number>();

    /**
     * Mirror the entries this sweep found missing.
     *
     * ★ Runs AFTER `runMeshParityCheck` has already reported and counted them —
     * repair never suppresses detection.
     *
     * Only `missing_in_shadow` is repairable, and the exclusion of the other two
     * classes is a correctness statement rather than a scoping convenience:
     *
     *   · `field_mismatch` — both sides HAVE the entry and disagree. Re-mirroring
     *     would overwrite the divergent record with the re-projection and erase
     *     the very evidence that something wrote a wrong record. That is a
     *     projection or transport bug and it must stay visible.
     *   · `extra_in_shadow` — the shadow has an id the ledger does not. There is
     *     no ledger entry to mirror, and deleting from the topic is neither
     *     possible on an append log nor desirable.
     */
    const backfillMissing = (
        meshId: string,
        entries: readonly ParityLedgerEntry[],
        result: { mismatches: readonly { kind: string; id: string }[] },
    ): void => {
        if (!backfillEnabled) return;

        const missing = result.mismatches.filter((m) => m.kind === 'missing_in_shadow');
        if (missing.length === 0) {
            // A clean sweep means the repair path is demonstrably fine.
            backfillFailures.delete(meshId);
            return;
        }

        if ((backfillFailures.get(meshId) ?? 0) >= PARITY_BACKFILL_FAILURE_LIMIT) {
            LOG.warn(
                'Seqscribe',
                `parity backfill paused mesh=${meshId} — ${PARITY_BACKFILL_FAILURE_LIMIT} consecutive ` +
                    `failed sweeps; ${missing.length} entries remain unmirrored and parity keeps reporting them`,
            );
            return;
        }

        // Index the entries this sweep already read — the ledger rows are in
        // hand, so repair costs no extra read.
        const byId = new Map(entries.map((e) => [e.id, e]));

        let mirrored = 0;
        let failed = 0;
        let skipped = 0;
        for (const mismatch of missing) {
            if (stopped) break;
            if (mirrored + failed >= backfillCap) {
                skipped = missing.length - (mirrored + failed);
                break;
            }
            const entry = byId.get(mismatch.id);
            if (!entry) {
                // Reported missing but not in the compared set — impossible for
                // `missing_in_shadow`, which is derived from these very entries.
                // Counted as skipped rather than failed so a logic change here
                // cannot masquerade as a broken repair path.
                skipped++;
                continue;
            }
            if (backfillMeshEventShadow(meshId, entry)) mirrored++;
            else failed++;
        }

        if (mirrored > 0) backfillFailures.delete(meshId);
        else if (failed > 0) backfillFailures.set(meshId, (backfillFailures.get(meshId) ?? 0) + 1);

        // ★ No silent caps — say what was left behind, so a persistent backlog
        // is legible rather than reading as a completed repair.
        LOG.info(
            'Seqscribe',
            `parity backfill mesh=${meshId} mirrored=${mirrored} failed=${failed}` +
                (skipped > 0 ? ` deferred=${skipped} (cap=${backfillCap}, next sweep)` : '') +
                ' — these entries were appended by a process with no armed shadow leg' +
                ' (see mesh-dual-write.ts process-boundary note)',
        );
    };

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
                const result = await runMeshParityCheck(handle, meshId, entries);
                // Detection has already happened and been counted above; this
                // repairs what it found. Never allowed to break the sweep.
                try {
                    backfillMissing(meshId, entries, result);
                } catch (error) {
                    LOG.warn(
                        'Seqscribe',
                        `parity backfill failed mesh=${meshId}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
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
