import { describe, expect, it } from 'vitest';

import {
    MAX_WRITE_INTERVAL_MS,
    MIN_WRITE_INTERVAL_MS,
    SNAPSHOT_VERSION,
    parseSnapshotFile,
    shouldWriteSnapshot,
    snapshotFromStatuslineInput,
    type StatuslineSnapshot,
} from '../../src/quota/statusline/snapshot';

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);

/** Shape documented for Claude Code 2.1.80+ statusline stdin. */
function statuslineInput(overrides: Record<string, unknown> = {}) {
    return {
        session_id: 'abc',
        cwd: '/Users/someone/project',
        transcript_path: '/Users/someone/.claude/projects/x/transcript.jsonl',
        version: '2.1.220',
        model: { id: 'claude-opus-5', display_name: 'Opus' },
        rate_limits: {
            five_hour: { used_percentage: 23.5, resets_at: 1786337423 },
            seven_day: { used_percentage: 41.2, resets_at: 1786857600 },
        },
        ...overrides,
    };
}

function snapshot(overrides: Partial<StatuslineSnapshot> = {}): StatuslineSnapshot {
    return {
        version: SNAPSHOT_VERSION,
        capturedAt: NOW,
        fiveHour: { usedPercent: 23.5, resetsAt: 1786337423000 },
        sevenDay: { usedPercent: 41.2, resetsAt: 1786857600000 },
        ...overrides,
    };
}

describe('snapshotFromStatuslineInput', () => {
    it('extracts both windows and converts resets_at from seconds to milliseconds', () => {
        const result = snapshotFromStatuslineInput(statuslineInput(), NOW);

        expect(result).not.toBeNull();
        expect(result?.fiveHour).toEqual({ usedPercent: 23.5, resetsAt: 1786337423 * 1000 });
        expect(result?.sevenDay).toEqual({ usedPercent: 41.2, resetsAt: 1786857600 * 1000 });
        expect(result?.capturedAt).toBe(NOW);
        expect(result?.cliVersion).toBe('2.1.220');
    });

    it('keeps a reset timestamp that is already in milliseconds', () => {
        const ms = 1786337423000;
        const result = snapshotFromStatuslineInput(
            statuslineInput({ rate_limits: { five_hour: { used_percentage: 5, resets_at: ms } } }),
            NOW,
        );

        expect(result?.fiveHour?.resetsAt).toBe(ms);
    });

    it('accepts a payload where only one window is present', () => {
        // The docs state each window may be independently absent.
        const result = snapshotFromStatuslineInput(
            statuslineInput({ rate_limits: { seven_day: { used_percentage: 12, resets_at: 1786857600 } } }),
            NOW,
        );

        expect(result?.fiveHour).toBeNull();
        expect(result?.sevenDay).toEqual({ usedPercent: 12, resetsAt: 1786857600 * 1000 });
    });

    it('returns null when rate_limits is absent (API-key users, pre-first-response)', () => {
        const { rate_limits, ...withoutLimits } = statuslineInput();
        void rate_limits;

        expect(snapshotFromStatuslineInput(withoutLimits, NOW)).toBeNull();
    });

    it('returns null when a window carries a reset time but no percentage', () => {
        // A reset time alone says nothing about consumption, which is the only
        // thing this record exists to carry.
        const result = snapshotFromStatuslineInput(
            statuslineInput({ rate_limits: { five_hour: { resets_at: 1786337423 } } }),
            NOW,
        );

        expect(result).toBeNull();
    });

    it('treats a null or missing resets_at as "no reset time", not as an unusable window', () => {
        const result = snapshotFromStatuslineInput(
            statuslineInput({ rate_limits: { five_hour: { used_percentage: 60, resets_at: null } } }),
            NOW,
        );

        expect(result?.fiveHour).toEqual({ usedPercent: 60, resetsAt: null });
    });

    it('records no content beyond the quota numbers', () => {
        // The statusline payload also carries cwd, transcript_path, session_id
        // and cost. None of that is quota, so none of it may be persisted.
        const result = snapshotFromStatuslineInput(statuslineInput(), NOW);
        const serialized = JSON.stringify(result);

        expect(serialized).not.toContain('/Users/someone/project');
        expect(serialized).not.toContain('transcript');
        expect(serialized).not.toContain('abc');
    });
});

describe('shouldWriteSnapshot (throttle)', () => {
    it('always writes when nothing has been recorded yet', () => {
        expect(shouldWriteSnapshot(null, snapshot(), NOW)).toBe(true);
    });

    it('drops a write inside the minimum interval even when the numbers changed', () => {
        // This is the rate limiter: Claude Code re-runs the statusline on every
        // assistant message with a 300ms debounce, so a changed value alone
        // must not be enough to earn a disk write.
        const previous = snapshot({ capturedAt: NOW });
        const next = snapshot({ fiveHour: { usedPercent: 99, resetsAt: 1786337423000 } });

        expect(shouldWriteSnapshot(previous, next, NOW + MIN_WRITE_INTERVAL_MS - 1)).toBe(false);
    });

    it('writes past the minimum interval when a value changed', () => {
        const previous = snapshot({ capturedAt: NOW });
        const next = snapshot({ fiveHour: { usedPercent: 24.5, resetsAt: 1786337423000 } });

        expect(shouldWriteSnapshot(previous, next, NOW + MIN_WRITE_INTERVAL_MS)).toBe(true);
    });

    it('skips an unchanged value between the minimum and maximum interval', () => {
        const previous = snapshot({ capturedAt: NOW });

        expect(shouldWriteSnapshot(previous, snapshot(), NOW + MIN_WRITE_INTERVAL_MS + 1)).toBe(false);
    });

    it('re-stamps an unchanged value once the maximum interval elapses', () => {
        // Freshness is itself information: the fetcher ages a reading out, so
        // an idle-but-live session must keep proving it is current.
        const previous = snapshot({ capturedAt: NOW });

        expect(shouldWriteSnapshot(previous, snapshot(), NOW + MAX_WRITE_INTERVAL_MS)).toBe(true);
    });

    it('notices a window appearing or disappearing, not just a moved percentage', () => {
        const previous = snapshot({ capturedAt: NOW, sevenDay: null });

        expect(shouldWriteSnapshot(previous, snapshot(), NOW + MIN_WRITE_INTERVAL_MS)).toBe(true);
    });

    it('writes rather than wedging when the clock jumps backwards', () => {
        const previous = snapshot({ capturedAt: NOW });

        expect(shouldWriteSnapshot(previous, snapshot(), NOW - 60_000)).toBe(true);
    });
});

describe('parseSnapshotFile', () => {
    it('round-trips a snapshot written by the wrapper', () => {
        const written = JSON.stringify(snapshot());

        expect(parseSnapshotFile(written)).toEqual(snapshot());
    });

    it('rejects a snapshot from a different on-disk version', () => {
        const written = JSON.stringify({ ...snapshot(), version: SNAPSHOT_VERSION + 1 });

        expect(parseSnapshotFile(written)).toBeNull();
    });

    it('rejects malformed JSON and objects with no usable window', () => {
        expect(parseSnapshotFile('{not json')).toBeNull();
        expect(parseSnapshotFile(JSON.stringify(snapshot({ fiveHour: null, sevenDay: null })))).toBeNull();
    });

    it('rejects a snapshot with no capture time, which cannot be aged', () => {
        const { capturedAt, ...withoutTime } = snapshot();
        void capturedAt;

        expect(parseSnapshotFile(JSON.stringify({ ...withoutTime, version: SNAPSHOT_VERSION }))).toBeNull();
    });
});
