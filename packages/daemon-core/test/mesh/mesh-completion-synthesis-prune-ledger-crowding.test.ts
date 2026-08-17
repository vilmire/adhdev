import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// mesh-completion-synthesis.ts's autoPruneStaleDirectDispatches feeds buildMeshActiveWork (via
// pruneStaleDirectDispatches, mesh-active-work.ts) with a ledger read. This test exercises the
// SAME kind set the fix now reads (readLedgerEntriesByKind), mirroring what
// autoPruneStaleDirectDispatches passes as `ledgerEntries`, to prove a remote/ledger-only
// dispatch's terminal evidence survives ledger crowding and is never misclassified as a
// prunable orphan (staleDirectWork) instead of settled work (terminalDirectWork).
const testConfigDir = join(tmpdir(), `adhdev-prune-crowding-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { buildMeshActiveWork } from '../../src/mesh/mesh-active-work.js';
import { __clearMeshLedgerForTests, appendLedgerEntry, readLedgerEntriesByKind } from '../../src/mesh/mesh-ledger.js';

const AUTO_PRUNE_LEDGER_KINDS = [
    'task_dispatched', 'task_completed', 'task_failed', 'task_stalled',
    'task_approval_needed', 'task_question_pending',
] as const;

function burySession(meshId: string, n: number) {
    for (let i = 0; i < n; i++) {
        appendLedgerEntry(meshId, {
            kind: 'session_launched',
            nodeId: 'node-other',
            payload: { source: 'unrelated_traffic', seq: i },
        } as any);
    }
}

describe('mesh-completion-synthesis auto-prune — LEDGER-KIND-TAIL-BLINDSPOT', () => {
    let meshId = `prune-crowding-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `prune-crowding-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        __clearMeshLedgerForTests(meshId);
    });

    // ★A remote/ledger-only direct dispatch (P2P, no MeshRuntimeStore row on this daemon) whose
    // node is no longer in the live mesh (nodes: []) lands in staleDirectWork ("orphan",
    // pruning-eligible) UNLESS its terminal ledger entry is found — in which case it correctly
    // lands in terminalDirectWork instead. Before the fix, autoPruneStaleDirectDispatches read
    // `readLedgerEntries(meshId, { tail: 500 })`; a bare tail window can be crowded out by
    // unrelated mesh traffic, losing the terminal row and misclassifying an already-finished
    // task as a prunable orphan.
    it('★a buried terminal keeps a remote dispatch in terminalDirectWork, not the orphan-prune bucket', () => {
        const taskId = 'task-remote-buried-terminal';
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node-remote-gone',
            sessionId: 'sess-remote-1',
            payload: { taskId, source: 'direct' },
        } as any);
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-remote-gone',
            sessionId: 'sess-remote-1',
            payload: { taskId, success: true },
        } as any);
        burySession(meshId, 600);

        const ledgerEntries = readLedgerEntriesByKind(meshId, [...AUTO_PRUNE_LEDGER_KINDS]);
        const built = buildMeshActiveWork({
            meshId,
            queue: [],
            ledgerEntries,
            directDispatches: [],
            nodes: [],
        });

        expect(built.terminalDirectWork.some(r => r.taskId === taskId && r.terminal === true)).toBe(true);
        expect(built.staleDirectWork.some(r => r.taskId === taskId)).toBe(false);
    });

    it('sanity: WITHOUT a terminal row, the same dispatch IS classified as a stale orphan', () => {
        const taskId = 'task-remote-genuine-orphan';
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node-remote-gone-2',
            sessionId: 'sess-remote-2',
            payload: { taskId, source: 'direct' },
        } as any);
        burySession(meshId, 10);

        const ledgerEntries = readLedgerEntriesByKind(meshId, [...AUTO_PRUNE_LEDGER_KINDS]);
        const built = buildMeshActiveWork({
            meshId,
            queue: [],
            ledgerEntries,
            directDispatches: [],
            nodes: [],
        });

        expect(built.staleDirectWork.some(r => r.taskId === taskId && r.staleReason)).toBe(true);
        expect(built.terminalDirectWork.some(r => r.taskId === taskId)).toBe(false);
    });
});
