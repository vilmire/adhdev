import { describe, expect, it } from 'vitest';
import {
    summarizeMeshAsyncRefineJobs,
    STALE_TERMINAL_REFINE_WINDOW_MS,
    RECENT_TERMINAL_REFINE_CAP,
    type MeshAsyncRefineJobStatus,
    type MeshAsyncRefineJobSummary,
} from '../../src/mesh/mesh-refine-status.js';

const ANCHOR = Date.parse('2026-06-14T12:00:00.000Z');

function job(
    jobId: string,
    status: MeshAsyncRefineJobStatus,
    lastUpdatedAtMs: number,
): MeshAsyncRefineJobSummary {
    return {
        jobId,
        status,
        instruction: `${status} job`,
        lastUpdatedAt: new Date(lastUpdatedAtMs).toISOString(),
    };
}

describe('summarizeMeshAsyncRefineJobs', () => {
    it('always counts active (accepted/running) jobs and never folds them as stale', () => {
        const jobs = [
            job('a', 'running', ANCHOR),
            job('b', 'accepted', ANCHOR - 10 * 24 * 60 * 60 * 1000), // very old but non-terminal
        ];
        const summary = summarizeMeshAsyncRefineJobs(jobs);
        expect(summary.byStatus).toEqual({ running: 1, accepted: 1 });
        expect(summary.staleTerminal).toBe(0);
        expect(summary.total).toBe(2);
        expect(summary.activeJobs.map(j => j.jobId).sort()).toEqual(['a', 'b']);
    });

    it('counts recent terminal jobs but folds stale terminal jobs out of byStatus', () => {
        const jobs = [
            job('fresh-fail', 'failed', ANCHOR),
            job('fresh-ok', 'completed', ANCHOR - 60 * 1000),
            // older than the freshness window relative to the newest job → stale residue
            job('old-fail-1', 'failed', ANCHOR - STALE_TERMINAL_REFINE_WINDOW_MS - 1000),
            job('old-fail-2', 'failed', ANCHOR - 3 * 24 * 60 * 60 * 1000),
        ];
        const summary = summarizeMeshAsyncRefineJobs(jobs);
        // Only the two fresh terminals are counted.
        expect(summary.byStatus).toEqual({ failed: 1, completed: 1 });
        expect(summary.staleTerminal).toBe(2);
        expect(summary.total).toBe(2);
        expect(summary.activeJobs).toEqual([]);
    });

    it('reproduces the reported noise: 6 failed historical jobs collapse to staleTerminal', () => {
        // Mirrors the real ledger: a burst of resolved refinery rejections days ago plus a
        // few recent completions. Without folding, byStatus reads failed:6 (false breakage).
        const jobs: MeshAsyncRefineJobSummary[] = [];
        for (let i = 0; i < 6; i += 1) {
            jobs.push(job(`old-fail-${i}`, 'failed', ANCHOR - (2 * 24 * 60 * 60 * 1000) - i * 1000));
        }
        for (let i = 0; i < 3; i += 1) {
            jobs.push(job(`recent-ok-${i}`, 'completed', ANCHOR - i * 60 * 1000));
        }
        const summary = summarizeMeshAsyncRefineJobs(jobs);
        expect(summary.byStatus.failed ?? 0).toBe(0);
        expect(summary.byStatus.completed).toBe(3);
        expect(summary.staleTerminal).toBe(6);
        expect(summary.total).toBe(3);
    });

    it('caps the number of recent terminal jobs counted even when all are fresh', () => {
        const jobs: MeshAsyncRefineJobSummary[] = [];
        const fresh = RECENT_TERMINAL_REFINE_CAP + 4;
        for (let i = 0; i < fresh; i += 1) {
            // all within the freshness window
            jobs.push(job(`ok-${i}`, 'completed', ANCHOR - i * 1000));
        }
        const summary = summarizeMeshAsyncRefineJobs(jobs);
        expect(summary.byStatus.completed).toBe(RECENT_TERMINAL_REFINE_CAP);
        expect(summary.staleTerminal).toBe(fresh - RECENT_TERMINAL_REFINE_CAP);
        expect(summary.total).toBe(RECENT_TERMINAL_REFINE_CAP);
    });

    it('is deterministic relative to the newest job, not wall-clock', () => {
        // The whole set is years in the past; freshness is measured relative to the newest
        // job, so the two recent-relative terminals are still counted.
        const base = Date.parse('2020-01-01T00:00:00.000Z');
        const jobs = [
            job('newest-fail', 'failed', base),
            job('near-ok', 'completed', base - 60 * 1000),
            job('far-fail', 'failed', base - STALE_TERMINAL_REFINE_WINDOW_MS - 1000),
        ];
        const summary = summarizeMeshAsyncRefineJobs(jobs);
        expect(summary.byStatus).toEqual({ failed: 1, completed: 1 });
        expect(summary.staleTerminal).toBe(1);
    });

    it('handles an empty job set', () => {
        const summary = summarizeMeshAsyncRefineJobs([]);
        expect(summary.total).toBe(0);
        expect(summary.byStatus).toEqual({});
        expect(summary.staleTerminal).toBe(0);
        expect(summary.activeJobs).toEqual([]);
    });
});
