// ---------------------------------------------------------------------------
// disk-space-preflight — make a full/near-full data volume LOUD
// ---------------------------------------------------------------------------
// Motivating incident: the data volume reached 97% and the session-host died on
// its first write with
//
//     [session-host] Uncaught exception: ENOSPC: no space left on device, write
//
// Two live sessions died 5 seconds apart. One surfaced as a missing completion
// notification, the other as `native_marker_absent` — one cause wearing two
// faces. Critically the DAEMON log contained NOTHING: the host is spawned
// detached, so its stderr went to its own file, and the investigation was driven
// toward a code-level misdiagnosis of the completion-marker logic. The ENOSPC
// was found only by reading session-host.log directly.
//
// `mesh-disk-retention.ts` already exists because of an earlier 98%-disk
// incident (mission 86def38d) — it reclaims space, but it never *detects* or
// *reports* low disk. So the volume could walk back up to 97% with no signal at
// all. This module is the detection half:
//
//   - a preflight at daemon boot and before spawning a session host, and
//   - a periodic check folded into the existing retention sweep,
//
// all of which FAIL LOUDLY (LOG.error / a thrown preflight error) rather than
// letting the next write be the thing that discovers the disk is full.
//
// Threshold rationale (see DISK_* constants below).
// ---------------------------------------------------------------------------

import { statfsSync } from 'fs';
import { LOG } from '../logging/logger.js';

// ─── Thresholds ─────────────────────────────────────────────────────────────
//
// Two independent axes, because neither alone is right:
//
//   * PERCENT is the intuitive operator signal, but on a 228Gi volume 5% free
//     is still ~11Gi — plenty — while on a small CI disk 5% may be MBs.
//   * ABSOLUTE BYTES is what actually determines whether the next write fits,
//     but a fixed byte floor is meaningless on a very large volume.
//
// A volume is UNHEALTHY only when it trips BOTH the percentage and the byte
// floor for a tier, so neither axis alone produces noise.
//
// The observed incident sat at 97% used / 7.0Gi free and DID hit ENOSPC — which
// looks contradictory until you note the free figure is APFS's optimistic
// number (purgeable space, snapshots) and the real writable headroom was far
// smaller. That is exactly why the critical tier is not set at "7Gi free":
// treating 7Gi as safe is what the old (absent) check would have done.
//
//   critical (2% / 1Gi)  — writes are imminently going to fail; refuse to start
//                          new work rather than corrupt it half-written.
//   warning  (5% / 5Gi)  — enough runway to act, close enough to matter. 5Gi is
//                          above the incident's *effective* headroom, so this
//                          tier would have fired before the sessions died.
export const DISK_CRITICAL_PERCENT_FREE = 2;
export const DISK_CRITICAL_FREE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB
export const DISK_WARNING_PERCENT_FREE = 5;
export const DISK_WARNING_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

export type DiskSpaceLevel = 'ok' | 'warning' | 'critical';

export interface DiskSpaceStats {
    /** Bytes available to an unprivileged writer (statfs bavail * bsize). */
    freeBytes: number;
    /** Total bytes on the volume (statfs blocks * bsize). */
    totalBytes: number;
    /** Percentage of the volume that is free, 0-100. */
    percentFree: number;
}

export interface DiskSpaceStatus extends DiskSpaceStats {
    level: DiskSpaceLevel;
    /** Path whose volume was measured. */
    path: string;
    /** Human-readable one-liner, safe to log or embed in an error. */
    summary: string;
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

/**
 * PURE. Classify a volume from its raw numbers.
 *
 * Both axes must trip for a tier to apply — see the threshold rationale above.
 * Critical is checked first so it wins over warning.
 *
 * A non-positive `totalBytes` means the caller could not measure the volume; we
 * classify that as 'ok' rather than inventing a failure, because refusing to
 * boot on an unreadable statfs would be a worse failure mode than the one we
 * are guarding against. The caller still logs the measurement error.
 */
export function classifyDiskSpace(stats: DiskSpaceStats): DiskSpaceLevel {
    if (!Number.isFinite(stats.totalBytes) || stats.totalBytes <= 0) return 'ok';
    const { percentFree, freeBytes } = stats;
    if (percentFree < DISK_CRITICAL_PERCENT_FREE && freeBytes < DISK_CRITICAL_FREE_BYTES) {
        return 'critical';
    }
    if (percentFree < DISK_WARNING_PERCENT_FREE && freeBytes < DISK_WARNING_FREE_BYTES) {
        return 'warning';
    }
    return 'ok';
}

/** PURE. Build the operator-facing one-liner for a measured volume. */
export function describeDiskSpace(stats: DiskSpaceStats, level: DiskSpaceLevel, path: string): string {
    const pct = Number.isFinite(stats.percentFree) ? stats.percentFree.toFixed(1) : '?';
    const used = Number.isFinite(stats.percentFree) ? (100 - stats.percentFree).toFixed(1) : '?';
    return (
        `disk ${level.toUpperCase()} at ${path}: ${formatBytes(stats.freeBytes)} free of ` +
        `${formatBytes(stats.totalBytes)} (${pct}% free / ${used}% used)`
    );
}

/**
 * Measure the volume containing `path`. Returns null if it cannot be measured
 * (statfs unsupported on the platform/filesystem, or the path does not exist).
 */
export function readDiskSpace(path: string): DiskSpaceStats | null {
    try {
        const stats = statfsSync(path);
        // bavail = blocks available to unprivileged users, which is the number
        // that actually governs whether our writes succeed. bfree includes
        // root-reserved blocks we cannot use.
        const blockSize = Number(stats.bsize);
        const freeBytes = Number(stats.bavail) * blockSize;
        const totalBytes = Number(stats.blocks) * blockSize;
        if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
            return null;
        }
        return {
            freeBytes,
            totalBytes,
            percentFree: (freeBytes / totalBytes) * 100,
        };
    } catch {
        return null;
    }
}

/**
 * Measure + classify + describe in one call. Returns null when unmeasurable.
 */
export function checkDiskSpace(path: string): DiskSpaceStatus | null {
    const stats = readDiskSpace(path);
    if (!stats) return null;
    const level = classifyDiskSpace(stats);
    return { ...stats, level, path, summary: describeDiskSpace(stats, level, path) };
}

export class LowDiskSpaceError extends Error {
    readonly status: DiskSpaceStatus;
    constructor(status: DiskSpaceStatus, operation: string) {
        super(
            `Refusing to ${operation}: ${status.summary}. ` +
                'Writes would fail with ENOSPC mid-operation. Free space and retry ' +
                '(see `adhdev doctor` for the largest reclaimable paths).',
        );
        this.name = 'LowDiskSpaceError';
        this.status = status;
    }
}

/**
 * Log the current disk status at a severity matching its level.
 *
 * This is the "do not pass silently" primitive: an unhealthy volume ALWAYS
 * produces a daemon-log line. Healthy volumes log at debug so routine checks
 * stay quiet.
 */
export function logDiskSpaceStatus(status: DiskSpaceStatus | null, context: string): void {
    if (!status) {
        LOG.debug('DiskSpace', `${context}: volume not measurable (statfs unavailable)`);
        return;
    }
    switch (status.level) {
        case 'critical':
            LOG.error('DiskSpace', `${context}: ${status.summary} — writes are expected to fail with ENOSPC`);
            break;
        case 'warning':
            LOG.warn('DiskSpace', `${context}: ${status.summary}`);
            break;
        default:
            LOG.debug('DiskSpace', `${context}: ${status.summary}`);
            break;
    }
}

/**
 * Preflight gate for an operation that will write to disk.
 *
 * - critical → logs at error AND throws LowDiskSpaceError. Failing before the
 *   work starts is strictly better than the half-written state ENOSPC leaves,
 *   and — the point of this whole module — it names the real cause instead of
 *   letting it resurface as an unrelated downstream symptom.
 * - warning  → logs at warn, proceeds.
 * - ok / unmeasurable → proceeds.
 *
 * `throwOnCritical: false` turns the gate into report-only for callers that must
 * not be blocked (e.g. shutdown paths).
 */
export function preflightDiskSpace(
    path: string,
    operation: string,
    options: { throwOnCritical?: boolean } = {},
): DiskSpaceStatus | null {
    const status = checkDiskSpace(path);
    logDiskSpaceStatus(status, `preflight before ${operation}`);
    if (status?.level === 'critical' && options.throwOnCritical !== false) {
        throw new LowDiskSpaceError(status, operation);
    }
    return status;
}
