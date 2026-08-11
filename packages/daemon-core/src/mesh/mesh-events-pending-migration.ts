import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { getLedgerDir } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { buildPendingEventFingerprint, type PendingMeshCoordinatorEvent } from './mesh-events-pending.js';

// ---------------------------------------------------------------------------
// One-shot boot migration: legacy `*.pending-events.jsonl` -> SQLite inbox
// ---------------------------------------------------------------------------
// The pending-event queue used to dual-write every event to SQLite AND to a
// per-mesh JSONL file, and the drain read both. The JSONL half is gone; SQLite
// is the sole store. Machines upgrading across that cut can still hold JSONL
// files containing UNDELIVERED events, and nothing would ever read them again:
//
//   - the drain no longer opens them,
//   - clearPendingMeshCoordinatorEvents no longer unlinks them,
//   - pruneExpiredLedgerJsonl (mesh-disk-retention.ts) matches `*.jsonl`
//     generically and DELETES them at 30 days WITHOUT draining.
//
// So without this migration every event still queued at upgrade time is lost
// (silently, a month later). This module drains those files into SQLite once,
// at boot, and unlinks them.
//
// ORDERING (load-bearing): this must run BEFORE setupMeshReconcileLoop(), because
// the reconcile loop is what drives runDiskRetentionSweep -> pruneExpiredLedgerJsonl.
// See the call site in boot/daemon-lifecycle.ts.
//
// Idempotent by construction: the files are unlinked once consumed, and
// insertPendingEvent is INSERT OR IGNORE against UNIQUE (mesh_id, fingerprint),
// so re-importing an event the store already holds is a no-op rather than a
// duplicate delivery. Running it twice on the same machine is harmless.
// ---------------------------------------------------------------------------

/** `<meshId>.pending-events.jsonl` or `<meshId>-<daemonId>.pending-events.jsonl`. */
const PENDING_EVENTS_SUFFIX = '.pending-events.jsonl';

export interface PendingEventsJsonlMigrationResult {
    /** Files that matched the legacy naming and were processed. */
    filesScanned: number;
    /** Events read, parsed and handed to the store (includes dedup-ignored ones). */
    eventsImported: number;
    /** Lines that were present but unparseable/unusable — skipped, never fatal. */
    linesSkipped: number;
    /** Files removed after a successful drain. */
    filesRemoved: number;
    /** Files left in place because importing them did not fully succeed. */
    filesRetained: number;
}

/**
 * Recover the meshId from a legacy pending-events filename. Both the shared and
 * the coordinator-scoped forms sanitize their components with the same
 * `[^a-zA-Z0-9_-] -> _` replacement, so the split is not reversible in general —
 * which is fine: the meshId used for the INSERT comes from the event payload
 * itself. This only needs to identify the file as ours.
 */
function isPendingEventsFile(name: string): boolean {
    return name.endsWith(PENDING_EVENTS_SUFFIX) && name.length > PENDING_EVENTS_SUFFIX.length;
}

/**
 * Parse one JSONL file's worth of pending events.
 *
 * A corrupt line must NEVER block the readable ones: the file is a plain append
 * log that could have been truncated mid-write by a crash or disk-full, and the
 * whole point of the migration is salvage. Unparseable and structurally-unusable
 * lines (no meshId / no event name) are counted and dropped; everything else is
 * returned.
 */
function parsePendingEventsFile(content: string): { events: PendingMeshCoordinatorEvent[]; skipped: number } {
    const events: PendingMeshCoordinatorEvent[] = [];
    let skipped = 0;
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            skipped++;
            continue;
        }
        const event = parsed as PendingMeshCoordinatorEvent | null;
        if (!event || typeof event !== 'object' || typeof event.meshId !== 'string' || !event.meshId
            || typeof event.event !== 'string' || !event.event) {
            skipped++;
            continue;
        }
        events.push(event);
    }
    return { events, skipped };
}

/**
 * Import one already-parsed event into the SQLite inbox, preserving its original
 * queuedAt (so age-based expiry keeps measuring true age) and its v2 envelope
 * (so eventId idempotency and unicast routing survive the move).
 *
 * Returns false when the store rejected the row; the caller keeps the file so a
 * later boot can retry rather than losing the event.
 */
function importOneEvent(event: PendingMeshCoordinatorEvent): boolean {
    try {
        const fingerprint = buildPendingEventFingerprint(event);
        MeshRuntimeStore.getInstance().insertPendingEvent({
            id: randomUUID(),
            meshId: event.meshId,
            coordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
            event: event.event,
            payload: event,
            fingerprint: fingerprint || null,
            queuedAt: typeof event.queuedAt === 'number' ? event.queuedAt : Date.now(),
            protocolVersion: event.protocolVersion ?? null,
            eventId: event.eventId ?? null,
            scope: event.scope ?? null,
            dispatchedBy: event.dispatchedBy ? JSON.stringify(event.dispatchedBy) : null,
            intendedFor: event.intendedFor ? JSON.stringify(event.intendedFor) : null,
        });
        return true;
    } catch (e: any) {
        LOG.warn('MeshEvents', `Pending-events migration: failed to import ${event.event} for mesh ${event.meshId}: ${e?.message || e}`);
        return false;
    }
}

/**
 * Drain every leftover `*.pending-events.jsonl` in the ledger dir into the SQLite
 * pending-event inbox, then unlink the file.
 *
 * Failure handling, per case:
 *   - ledger dir missing / no matching files -> no-op, returns zeroes.
 *   - empty file                             -> unlinked (nothing to salvage).
 *   - corrupt line(s)                        -> those lines skipped and counted;
 *                                               readable events still imported.
 *   - unreadable file                        -> left in place, logged, next boot retries.
 *   - partial import failure (store threw)   -> file RETAINED, not unlinked, so the
 *                                               un-imported events are not lost.
 *
 * The file is claimed with an atomic rename before reading, so a second daemon
 * racing the same ledger dir cannot import the same events twice.
 *
 * Best-effort overall: this never throws. A migration failure must not stop the
 * daemon from booting.
 */
export function migratePendingEventsJsonlToSqlite(): PendingEventsJsonlMigrationResult {
    const result: PendingEventsJsonlMigrationResult = {
        filesScanned: 0,
        eventsImported: 0,
        linesSkipped: 0,
        filesRemoved: 0,
        filesRetained: 0,
    };

    let dir: string;
    try {
        dir = getLedgerDir();
    } catch {
        return result;
    }
    if (!existsSync(dir)) return result;

    let names: string[];
    try {
        names = readdirSync(dir);
    } catch (e: any) {
        LOG.warn('MeshEvents', `Pending-events migration: cannot read ledger dir: ${e?.message || e}`);
        return result;
    }

    for (const name of names) {
        if (!isPendingEventsFile(name)) continue;
        const path = join(dir, name);
        result.filesScanned++;

        // Claim the file atomically so a concurrent daemon cannot import it too.
        const claimed = `${path}.migrating`;
        try {
            renameSync(path, claimed);
        } catch {
            // Another process claimed it, or it vanished. Either way, not ours.
            continue;
        }

        let content: string;
        try {
            content = readFileSync(claimed, 'utf-8');
        } catch (e: any) {
            LOG.warn('MeshEvents', `Pending-events migration: cannot read ${name}; leaving it for the next boot: ${e?.message || e}`);
            try { renameSync(claimed, path); } catch { /* best-effort restore */ }
            result.filesRetained++;
            continue;
        }

        const { events, skipped } = parsePendingEventsFile(content);
        result.linesSkipped += skipped;

        let allImported = true;
        for (const event of events) {
            if (importOneEvent(event)) result.eventsImported++;
            else allImported = false;
        }

        if (!allImported) {
            // Something did not land. Restore the file rather than unlinking it —
            // a retained file is recoverable, a deleted one is not.
            try { renameSync(claimed, path); } catch { /* best-effort restore */ }
            result.filesRetained++;
            continue;
        }

        try {
            unlinkSync(claimed);
            result.filesRemoved++;
        } catch (e: any) {
            LOG.warn('MeshEvents', `Pending-events migration: imported ${name} but could not unlink it: ${e?.message || e}`);
            result.filesRemoved++;
        }
    }

    if (result.filesScanned > 0) {
        LOG.info(
            'MeshEvents',
            `Pending-events JSONL migration: imported ${result.eventsImported} event(s) from ${result.filesScanned} legacy file(s) `
            + `(removed ${result.filesRemoved}, retained ${result.filesRetained}, skipped ${result.linesSkipped} unreadable line(s))`,
        );
    }
    return result;
}
