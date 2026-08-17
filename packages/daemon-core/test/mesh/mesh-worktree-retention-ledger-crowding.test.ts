import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// mesh-worktree-retention reads refine-job evidence through readLedgerEntriesByKind, whose
// underlying store side-writes a per-mesh JSONL/SQLite under getConfigDir(); redirect it to a
// temp dir so the test never touches the real ~/.adhdev.
const testConfigDir = join(tmpdir(), `adhdev-worktree-retention-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'local-daemon' }),
}));

import { runWorktreeNodeRetentionTick, __deleteWorktreeNodeRetentionStateForTests, type WorktreeRetentionDeps } from '../../src/mesh/mesh-worktree-retention.js';
import { __clearMeshLedgerForTests, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js';

function makeDeps(): WorktreeRetentionDeps {
    return {
        precheckLocalWorktreeRemovable: async () => ({ ok: true } as any),
        cleanupLocalWorktreeNode: async () => ({ success: true } as any),
        getWorktreeForceCleanupConvergence: async () => ({ converged: true } as any),
        listSessions: async () => [],
    };
}

function worktreeNode(id: string) {
    return {
        id,
        isLocalWorktree: true,
        workspace: `/tmp/nonexistent-worktree-${id}`,
        daemonId: 'local-daemon',
    };
}

describe('mesh-worktree-retention — LEDGER-KIND-TAIL-BLINDSPOT (review_inflight)', () => {
    let meshId = `worktree-retention-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `worktree-retention-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __deleteWorktreeNodeRetentionStateForTests();
    });

    afterEach(() => {
        __clearMeshLedgerForTests(meshId);
        __deleteWorktreeNodeRetentionStateForTests();
    });

    function appendRefineDispatch(jobId: string, nodeId: string) {
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId,
            payload: {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId, status: 'accepted', meshId, nodeId },
                async: true,
            },
        } as any);
    }

    // ★DATA-LOSS ADJACENT: an in-flight Refinery job's task_dispatched row must keep blocking
    // destructive worktree removal even when 260+ unrelated ledger entries are appended after
    // it — the same class as M-WORKTREE-DELETED-WHILE-TASK-RUNNING (2026-08-16). Before the
    // fix, buildPlan's fallback read was `readLedgerEntries(meshId, { tail: 500 })`; a bare
    // tail window can be crowded out by unrelated mesh traffic while a refine job (which runs
    // typecheck/test/build for minutes) is still running, letting the sweep wrongly conclude
    // the node is free to remove out from under a live reviewer.
    it('★review_inflight keeps blocking removal when the refine dispatch is buried beyond the 500-entry tail window', async () => {
        const nodeId = 'node-refining';
        appendRefineDispatch('job-buried', nodeId);

        for (let i = 0; i < 520; i++) {
            appendLedgerEntry(meshId, {
                kind: 'session_launched',
                nodeId: 'node-other',
                payload: { source: 'unrelated_traffic', seq: i },
            } as any);
        }

        const mesh = { id: meshId, nodes: [worktreeNode(nodeId)] };
        const result = await runWorktreeNodeRetentionTick(makeDeps(), {
            mesh,
            nowMs: Date.now(),
            tickId: 'tick-1',
            execute: false,
            graceMs: 48 * 60 * 60 * 1000,
        });

        const entry = result.entries.find(e => e.nodeId === nodeId);
        expect(entry?.candidate).toBe(false);
        expect(entry?.reasonCode).toBe('review_inflight');
    });

    it('becomes a candidate once the buried refine job reaches a terminal row (not blocked_review)', async () => {
        const nodeId = 'node-refined-done';
        appendRefineDispatch('job-buried-done', nodeId);
        for (let i = 0; i < 520; i++) {
            appendLedgerEntry(meshId, {
                kind: 'session_launched',
                nodeId: 'node-other',
                payload: { source: 'unrelated_traffic', seq: i },
            } as any);
        }
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId,
            payload: {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId: 'job-buried-done', status: 'completed', meshId, nodeId },
                async: true,
                success: true,
                result: { code: 'merged' },
            },
        } as any);

        const mesh = { id: meshId, nodes: [worktreeNode(nodeId)] };
        const result = await runWorktreeNodeRetentionTick(makeDeps(), {
            mesh,
            nowMs: Date.now(),
            tickId: 'tick-1',
            execute: false,
            graceMs: 48 * 60 * 60 * 1000,
        });

        const entry = result.entries.find(e => e.nodeId === nodeId);
        // No longer blocked by review_inflight/blocked_review — the two-pass eligibility
        // gate (grace period) may still hold it back, but it must not be review_inflight.
        expect(entry?.reasonCode).not.toBe('review_inflight');
        expect(entry?.reasonCode).not.toBe('blocked_review');
    });
});
