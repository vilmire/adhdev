/**
 * REFINE-ZOMBIE / ARCHIVE-ASYMMETRY regression suite.
 *
 * Root cause (2026-08-09 → 08-16): compactLedger archives terminal kinds
 * (task_completed / task_failed) after 7 days and DELETES them from the live
 * store, while task_dispatched is deliberately never archivable. Past that age a
 * dispatch outlives its own completion, so the refine resume scanner — which
 * replays only the live set — re-reads a job that finished in ~90 seconds as
 * eternally open and fires `resume_abandoned_stale_dispatch`. Because the archive
 * window (7d) is wider than the zombie cutoff (24h), the false positive is
 * structural rather than incidental.
 *
 * Three independent defenses are pinned here:
 *   B — compactLedger keeps a dispatch↔terminal pair atomic (no NEW asymmetry).
 *   A — archived terminal pair keys are indexed so already-stranded rows still
 *       read as closed.
 *   D — a dispatch whose node left the mesh is closed as removed-node, never
 *       resumed (this alone covered all five observed false zombies).
 *
 * All storage is redirected to a temp dir via the getConfigDir mock — the real
 * ~/.adhdev ledger is never read or written.
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
}));

import {
    appendLedgerEntry,
    compactLedger,
    readLedgerEntries,
    readArchivedTerminalKeys,
    ledgerPairKey,
} from '../../src/mesh/mesh-ledger.js';
import {
    selectOpenRefineDispatches,
    classifyRefineDispatch,
    refineArchivePairKey,
} from '../../src/mesh/mesh-refine-zombie-sweep.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A refine dispatch/terminal ledger payload, shaped exactly as router-refine writes it. */
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

    // ── B: the pair stays atomic ───────────────────────────────────────────
    describe('B — dispatch↔terminal pair atomicity in compactLedger', () => {
        it('does NOT archive a terminal row whose dispatch stays in the live set', () => {
            const jobId = `job_${randomUUID().slice(0, 8)}`;
            const nodeId = 'node_worktree_a';
            const old = new Date(Date.now() - 10 * DAY_MS).toISOString();

            // A dispatch and its completion, both 10 days old — past the 7d archive
            // cutoff. This is the exact 2026-08-09 shape: the job DID finish.
            const dispatched = appendLedgerEntry(meshId, {
                kind: 'task_dispatched', nodeId, payload: refinePayload(jobId, nodeId),
            });
            const failed = appendLedgerEntry(meshId, {
                kind: 'task_failed', nodeId, payload: refinePayload(jobId, nodeId),
            });
            // Backdate both rows past the archive cutoff.
            backdate(meshId, [dispatched.id, failed.id], old);

            compactLedger(meshId);

            const live = readLedgerEntries(meshId);
            const liveKinds = live.map(e => e.kind);
            // The dispatch was never archivable...
            expect(liveKinds).toContain('task_dispatched');
            // ...so its terminal counterpart must have been pinned alongside it.
            // Reverting the pair guard in compactLedger fails HERE.
            expect(liveKinds).toContain('task_failed');

            // And the reader consequently sees no open dispatch.
            expect(selectOpenRefineDispatches(live)).toHaveLength(0);
        });

        it('still archives a terminal row that has no dispatch counterpart', () => {
            // The guard must not become "never archive terminals" — an unpaired
            // terminal row is still ordinary archive volume.
            const old = new Date(Date.now() - 10 * DAY_MS).toISOString();
            const orphanTerminal = appendLedgerEntry(meshId, {
                kind: 'task_completed', nodeId: 'node_gone',
                payload: refinePayload(`job_${randomUUID().slice(0, 8)}`, 'node_gone'),
            });
            backdate(meshId, [orphanTerminal.id], old);

            const result = compactLedger(meshId);

            expect(result.archivedCount).toBe(1);
            expect(readLedgerEntries(meshId).map(e => e.kind)).not.toContain('task_completed');
        });

        it('archives unrelated old telemetry kinds unchanged', () => {
            // Regression guard on scope: the pair invariant applies only to
            // PAIRED_TERMINAL_KINDS, not to every archivable kind.
            const old = new Date(Date.now() - 10 * DAY_MS).toISOString();
            const telemetry = appendLedgerEntry(meshId, {
                kind: 'session_auto_launch', nodeId: 'node_x', payload: { phase: 'skipped' },
            });
            backdate(meshId, [telemetry.id], old);

            expect(compactLedger(meshId).archivedCount).toBe(1);
        });
    });

    // ── A: the reader sees archived closures ───────────────────────────────
    describe('A — archived terminal key index', () => {
        it('records the pair key of a terminal row it archives', () => {
            const jobId = `job_${randomUUID().slice(0, 8)}`;
            const nodeId = 'node_gone';
            const old = new Date(Date.now() - 10 * DAY_MS).toISOString();
            const terminal = appendLedgerEntry(meshId, {
                kind: 'task_failed', nodeId, payload: refinePayload(jobId, nodeId),
            });
            backdate(meshId, [terminal.id], old);

            compactLedger(meshId);

            expect(readArchivedTerminalKeys(meshId)).toContain(refineArchivePairKey(nodeId, jobId));
        });

        it('treats an already-stranded dispatch as CLOSED when its terminal key was archived', () => {
            // Simulates data stranded by the OLD asymmetric policy: the dispatch row
            // survives in the live set, its terminal row is long gone. Without the
            // index this reads as an open job and fires a false zombie.
            const jobId = `job_${randomUUID().slice(0, 8)}`;
            const nodeId = 'node_worktree_b';
            const entries = [{
                kind: 'task_dispatched',
                nodeId,
                timestamp: new Date(Date.now() - 7 * DAY_MS).toISOString(),
                payload: refinePayload(jobId, nodeId),
            }];

            // Without the index → the scanner reports it open (the old, buggy read).
            expect(selectOpenRefineDispatches(entries)).toHaveLength(1);

            // With it → correctly recognized as closed.
            const archived = new Set([refineArchivePairKey(nodeId, jobId)]);
            expect(selectOpenRefineDispatches(entries, archived)).toHaveLength(0);
        });

        it('keeps the sweep key spelling in step with mesh-ledger ledgerPairKey', () => {
            // The index is written by mesh-ledger and read by the sweep module. If the
            // two spellings drift, every lookup silently misses and A stops working
            // with no other symptom — so pin them against each other.
            const nodeId = 'node_worktree_c';
            const jobId = 'job_abc123';
            const fromLedger = ledgerPairKey({
                kind: 'task_failed', nodeId, payload: refinePayload(jobId, nodeId),
            });
            expect(fromLedger).toBe(refineArchivePairKey(nodeId, jobId));
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

/**
 * Backdate ledger rows in BOTH the SQLite store and the JSONL mirror so
 * compactLedger sees them as past the archive cutoff. Writes only inside the
 * mocked temp config dir.
 */
function backdate(meshId: string, ids: string[], timestamp: string): void {
    const store = MeshRuntimeStore.getInstance() as any;
    const db = store.db ?? store.getDb?.();
    for (const id of ids) {
        db.prepare('UPDATE mesh_event_ledger SET timestamp = ? WHERE id = ?').run(timestamp, id);
    }
    // Mirror into the JSONL export artifact so both read paths agree.
    const { readFileSync, writeFileSync } = require('fs') as typeof import('fs');
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(testConfigDir, 'mesh-ledger', `${safe}.jsonl`);
    if (!existsSync(path)) return;
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(line => {
        const entry = JSON.parse(line);
        if (ids.includes(entry.id)) entry.timestamp = timestamp;
        return JSON.stringify(entry);
    });
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}
