import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module imports `statfsSync` as a named ESM binding, so a spy on the `fs`
// CJS namespace object does not intercept it — the mock has to replace the
// module itself.
const statfsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, statfsSync: statfsSyncMock };
});

import {
    classifyDiskSpace,
    describeDiskSpace,
    formatBytes,
    preflightDiskSpace,
    logDiskSpaceStatus,
    checkDiskSpace,
    LowDiskSpaceError,
    DISK_CRITICAL_PERCENT_FREE,
    DISK_CRITICAL_FREE_BYTES,
    DISK_WARNING_PERCENT_FREE,
    DISK_WARNING_FREE_BYTES,
    type DiskSpaceStats,
} from '../../src/diagnostics/disk-space-preflight.js';
import { LOG } from '../../src/logging/logger.js';

const GiB = 1024 * 1024 * 1024;

/** Build stats for a volume of `totalGiB` with `freeGiB` available. */
function volume(totalGiB: number, freeGiB: number): DiskSpaceStats {
    const totalBytes = totalGiB * GiB;
    const freeBytes = freeGiB * GiB;
    return { totalBytes, freeBytes, percentFree: (freeBytes / totalBytes) * 100 };
}

describe('classifyDiskSpace', () => {
    it('reports ok for a healthy volume', () => {
        expect(classifyDiskSpace(volume(228, 100))).toBe('ok');
    });

    it('reports critical when BOTH the percent and byte floors are breached', () => {
        // 100GiB volume, 0.5GiB free → 0.5% free, under 1GiB.
        expect(classifyDiskSpace(volume(100, 0.5))).toBe('critical');
    });

    it('reports warning when both warning floors are breached but not critical', () => {
        // 100GiB volume, 3GiB free → 3% free, under 5GiB but over the 1GiB critical floor.
        expect(classifyDiskSpace(volume(100, 3))).toBe('warning');
    });

    it('requires BOTH axes — a large volume at low percent with ample bytes stays ok', () => {
        // 4TB volume with 1% free is still ~40GiB — plenty of headroom.
        expect(classifyDiskSpace(volume(4096, 40))).toBe('ok');
    });

    it('requires BOTH axes — a tiny volume with few bytes but high percent stays ok', () => {
        // 2GiB volume with 1.5GiB free = 75% free: low absolute bytes, but not full.
        expect(classifyDiskSpace(volume(2, 1.5))).toBe('ok');
    });

    it('classifies ok (not a failure) when the volume is unmeasurable', () => {
        // Refusing to boot on an unreadable statfs would be worse than the
        // problem being guarded against.
        expect(classifyDiskSpace({ totalBytes: 0, freeBytes: 0, percentFree: 0 })).toBe('ok');
        expect(classifyDiskSpace({ totalBytes: NaN, freeBytes: NaN, percentFree: NaN })).toBe('ok');
    });

    it('critical wins over warning at the boundary', () => {
        const stats = volume(100, 0.4); // 0.4% free, 0.4GiB — trips both tiers
        expect(classifyDiskSpace(stats)).toBe('critical');
    });

    it('treats the thresholds as strict (a volume exactly at the limit is not tripped)', () => {
        const atWarning: DiskSpaceStats = {
            totalBytes: 100 * GiB,
            freeBytes: DISK_WARNING_FREE_BYTES,
            percentFree: DISK_WARNING_PERCENT_FREE,
        };
        expect(classifyDiskSpace(atWarning)).toBe('ok');
    });

    it('exposes thresholds that place the incident volume in an unhealthy tier', () => {
        // Sanity-check the constants themselves against the motivating incident:
        // the 97%-used volume must NOT classify as ok once its effective
        // headroom is what the byte floor sees.
        expect(DISK_CRITICAL_PERCENT_FREE).toBeLessThan(DISK_WARNING_PERCENT_FREE);
        expect(DISK_CRITICAL_FREE_BYTES).toBeLessThan(DISK_WARNING_FREE_BYTES);
        // 3% free / 2GiB free — the shape of a volume about to ENOSPC.
        expect(classifyDiskSpace(volume(100, 3))).not.toBe('ok');
    });
});

describe('describeDiskSpace / formatBytes', () => {
    it('formats byte magnitudes readably', () => {
        expect(formatBytes(0)).toBe('0B');
        expect(formatBytes(1536)).toBe('1.5KiB');
        expect(formatBytes(5 * GiB)).toBe('5.0GiB');
        expect(formatBytes(-1)).toBe('unknown');
    });

    it('names the level, the path and both the free and used percentages', () => {
        const summary = describeDiskSpace(volume(100, 3), 'warning', '/Users/x/.adhdev');
        expect(summary).toContain('WARNING');
        expect(summary).toContain('/Users/x/.adhdev');
        expect(summary).toContain('3.0% free');
        expect(summary).toContain('97.0% used');
    });
});

describe('preflightDiskSpace — low disk must NOT pass silently', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(LOG, 'error').mockImplementation(() => {});
        warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        vi.spyOn(LOG, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * The regression this whole module exists for: a volume at the critical tier
     * must produce BOTH a loud log line and a thrown error. Reverting the throw
     * (or the classification) turns this red.
     */
    it('throws AND logs at error when the volume is critical', () => {
        statfsSyncMock.mockReturnValue({
            bsize: 4096,
            blocks: (100 * GiB) / 4096,
            bavail: (0.5 * GiB) / 4096,
            bfree: (0.5 * GiB) / 4096,
            files: 0,
            ffree: 0,
            type: 0,
        } as any);

        expect(() => preflightDiskSpace('/fake/path', 'spawn the session host')).toThrow(LowDiskSpaceError);
        expect(errorSpy).toHaveBeenCalled();
        const logged = errorSpy.mock.calls.map(c => String(c[1])).join('\n');
        expect(logged).toContain('ENOSPC');
    });

    it('names the operation and the remedy in the thrown error', () => {
        const status = {
            ...volume(100, 0.5),
            level: 'critical' as const,
            path: '/fake',
            summary: describeDiskSpace(volume(100, 0.5), 'critical', '/fake'),
        };
        const error = new LowDiskSpaceError(status, 'spawn the session host');
        expect(error.message).toContain('spawn the session host');
        expect(error.message).toContain('ENOSPC');
        expect(error.name).toBe('LowDiskSpaceError');
        expect(error.status.level).toBe('critical');
    });

    it('warns but proceeds at the warning tier', () => {
        statfsSyncMock.mockReturnValue({
            bsize: 4096,
            blocks: (100 * GiB) / 4096,
            bavail: (3 * GiB) / 4096,
            bfree: (3 * GiB) / 4096,
            files: 0,
            ffree: 0,
            type: 0,
        } as any);

        expect(() => preflightDiskSpace('/fake/path', 'spawn the session host')).not.toThrow();
        expect(warnSpy).toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not throw when throwOnCritical is disabled, but still logs at error', () => {
        statfsSyncMock.mockReturnValue({
            bsize: 4096,
            blocks: (100 * GiB) / 4096,
            bavail: (0.5 * GiB) / 4096,
            bfree: (0.5 * GiB) / 4096,
            files: 0,
            ffree: 0,
            type: 0,
        } as any);

        expect(() =>
            preflightDiskSpace('/fake/path', 'sweep', { throwOnCritical: false }),
        ).not.toThrow();
        expect(errorSpy).toHaveBeenCalled();
    });

    it('proceeds quietly on a healthy volume', () => {
        statfsSyncMock.mockReturnValue({
            bsize: 4096,
            blocks: (228 * GiB) / 4096,
            bavail: (100 * GiB) / 4096,
            bfree: (100 * GiB) / 4096,
            files: 0,
            ffree: 0,
            type: 0,
        } as any);

        expect(() => preflightDiskSpace('/fake/path', 'spawn the session host')).not.toThrow();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('proceeds when the volume cannot be measured', () => {
        statfsSyncMock.mockImplementation(() => { throw new Error('ENOTSUP'); });

        expect(checkDiskSpace('/fake/path')).toBeNull();
        expect(() => preflightDiskSpace('/fake/path', 'spawn the session host')).not.toThrow();
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

describe('logDiskSpaceStatus severity mapping', () => {
    afterEach(() => vi.restoreAllMocks());

    it('escalates by level so an unhealthy volume is never debug-only', () => {
        const error = vi.spyOn(LOG, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const debug = vi.spyOn(LOG, 'debug').mockImplementation(() => {});

        const mk = (level: 'ok' | 'warning' | 'critical') => ({
            ...volume(100, 3),
            level,
            path: '/p',
            summary: 'summary',
        });

        logDiskSpaceStatus(mk('critical'), 'ctx');
        expect(error).toHaveBeenCalledTimes(1);

        logDiskSpaceStatus(mk('warning'), 'ctx');
        expect(warn).toHaveBeenCalledTimes(1);

        logDiskSpaceStatus(mk('ok'), 'ctx');
        expect(debug).toHaveBeenCalled();
    });
});
