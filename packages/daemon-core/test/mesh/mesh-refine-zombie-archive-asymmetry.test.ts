/**
 * REFINE-ZOMBIE / ARCHIVE-ASYMMETRY regression suite.
 *
 * Root cause (2026-08-09 → 08-16): the (retired) event ledger archived terminal
 * kinds after 7 days while task_dispatched stayed live, so the refine resume
 * scanner re-read a job that finished in ~90 seconds as eternally open.
 *
 * C-W9a retired the ledger, its archive and the archived-terminal-key sidecar.
 * What is pinned now:
 *   R — `mesh_local_records` retention deletes by age, so a job's dispatch always
 *       leaves no later than its terminal (the asymmetry cannot recur).
 *   D — a dispatch whose node left the mesh is closed as removed-node, never
 *       resumed (this alone covered all five observed false zombies).
 *
 * All storage is redirected to a temp dir via the getConfigDir mock.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-refine-zombie-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { readLocalRecords, pruneLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { meshRecord } from '../../src/mesh/mesh-record.js';
import {
    selectOpenRefineDispatches,
    classifyRefineDispatch,
} from '../../src/mesh/mesh-refine-zombie-sweep.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A refine dispatch/terminal payload, shaped exactly as router-refine writes it. */
function refinePayload(jobId: string, nodeId: string) {
    return {
        source: 'refine_mesh_node_async_job',
        async: true,
        refineJob: { jobId, nodeId, meshId: 'ignored', status: 'running' },
    };
}

describe('refine zombie jobs — archive asymmetry', () => {
    let meshId: string;

    beforeEach(() => {
        meshId = `test-mesh-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // ── R: retention is time-ordered, so the pair cannot split the wrong way ──
    describe('R — local-record retention never strands a dispatch', () => {
        it('prunes the dispatch no later than its terminal: a closed job never re-reads as open', () => {
            const now = Date.now();
            const dispatchedAt = now - 31 * DAY_MS;          // past the 30-day window
            const completedAt = dispatchedAt + 90_000;        // 90 s later — also past it
            meshRecord(meshId, 'task_dispatched', { nodeId: 'node_a', at: dispatchedAt, payload: refinePayload('job_old', 'node_a') }, { local: true });
            meshRecord(meshId, 'task_completed', { nodeId: 'node_a', at: completedAt, payload: refinePayload('job_old', 'node_a') }, { local: true });
            // A job straddling the cutoff: dispatch pruned, terminal kept — reads CLOSED, not open.
            meshRecord(meshId, 'task_dispatched', { nodeId: 'node_b', at: now - 30 * DAY_MS - 1_000, payload: refinePayload('job_edge', 'node_b') }, { local: true });
            meshRecord(meshId, 'task_completed', { nodeId: 'node_b', at: now - 29 * DAY_MS, payload: refinePayload('job_edge', 'node_b') }, { local: true });

            expect(pruneLocalRecords(30 * DAY_MS, now)).toBe(3);
            const entries = readLocalRecords(meshId, { kind: ['task_dispatched', 'task_completed', 'task_failed'], turnTerminals: false });
            expect(entries.map((e) => e.kind)).toEqual(['task_completed']);
            expect(selectOpenRefineDispatches(entries)).toEqual([]);
        });
    });

    // ── D: removed nodes are never resumed ─────────────────────────────────
    describe('D — node existence guard', () => {
        const baseOpts = {
            nowMs: Date.now(),
            graceMs: 60_000,
            zombieCutoffMs: DAY_MS,
            isRunning: () => false,
        };

        it('closes out a dispatch whose node left the mesh, without resuming', () => {
            const decision = classifyRefineDispatch(
                { nodeId: 'node_removed', jobId: 'job_1', timestamp: new Date(Date.now() - 7 * DAY_MS).toISOString() },
                { ...baseOpts, nodeExists: () => false },
            );
            expect(decision?.disposition).toBe('close_removed_node');
        });

        it('prefers removed-node over the grace window for a very fresh dispatch', () => {
            // A node that is gone cannot be refined no matter how recent the dispatch;
            // deferring would just re-ask the same unanswerable question forever.
            const decision = classifyRefineDispatch(
                { nodeId: 'node_removed', jobId: 'job_2', timestamp: new Date().toISOString() },
                { ...baseOpts, nodeExists: () => false },
            );
            expect(decision?.disposition).toBe('close_removed_node');
        });

        it('never closes a job that is running in THIS process, even for a removed node', () => {
            const decision = classifyRefineDispatch(
                { nodeId: 'node_removed', jobId: 'job_3', timestamp: new Date(Date.now() - 7 * DAY_MS).toISOString() },
                { ...baseOpts, nodeExists: () => false, isRunning: () => true },
            );
            expect(decision).toBeUndefined();
        });

        it('still resumes a genuinely interrupted job when the node exists', () => {
            // The guard must not suppress real recovery: past grace, inside the cutoff.
            const decision = classifyRefineDispatch(
                { nodeId: 'node_live', jobId: 'job_4', timestamp: new Date(Date.now() - 10 * 60_000).toISOString() },
                { ...baseOpts, nodeExists: () => true },
            );
            expect(decision?.disposition).toBe('resume');
        });

        it('still closes a genuinely stale job when the node exists', () => {
            const decision = classifyRefineDispatch(
                { nodeId: 'node_live', jobId: 'job_5', timestamp: new Date(Date.now() - 7 * DAY_MS).toISOString() },
                { ...baseOpts, nodeExists: () => true },
            );
            expect(decision?.disposition).toBe('close_stale');
        });
    });
});
