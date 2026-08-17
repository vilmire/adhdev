import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// mesh-events-stale reads ledger evidence through readLedgerEntriesByKind, whose underlying
// store side-writes a per-mesh JSONL/SQLite under getConfigDir(); redirect it to a temp dir.
const testConfigDir = join(tmpdir(), `adhdev-events-stale-crowding-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    findRecentTerminalLedgerEvidence,
    hasDispatchAfterTerminal,
    hasUnterminalDirectDispatchLedgerEntry,
    findTerminalLedgerEvidenceForTask,
} from '../../src/mesh/mesh-events-stale.js';
import { __clearMeshLedgerForTests, appendLedgerEntry, readLedgerEntries } from '../../src/mesh/mesh-ledger.js';

function burySession(meshId: string, n = 260) {
    for (let i = 0; i < n; i++) {
        appendLedgerEntry(meshId, {
            kind: 'session_launched',
            nodeId: 'node-other',
            payload: { source: 'unrelated_traffic', seq: i },
        } as any);
    }
}

describe('mesh-events-stale — LEDGER-KIND-TAIL-BLINDSPOT', () => {
    let meshId = `events-stale-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `events-stale-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        __clearMeshLedgerForTests(meshId);
    });

    describe('findRecentTerminalLedgerEvidence', () => {
        it('★finds a terminal entry buried beyond the 200-entry tail window', () => {
            const sessionId = 'sess-recent-terminal';
            appendLedgerEntry(meshId, {
                kind: 'task_completed',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-1', success: true },
            } as any);
            burySession(meshId);

            const evidence = findRecentTerminalLedgerEvidence({ meshId, sessionId });
            expect(evidence?.kind).toBe('task_completed');
        });

        it('returns null when no terminal exists for the session', () => {
            burySession(meshId, 10);
            expect(findRecentTerminalLedgerEvidence({ meshId, sessionId: 'sess-none' })).toBeNull();
        });
    });

    describe('hasDispatchAfterTerminal', () => {
        it('★finds a task_dispatched entry after the terminal anchor, buried beyond the 200-entry tail window', () => {
            const sessionId = 'sess-redispatch';
            const terminal = appendLedgerEntry(meshId, {
                kind: 'task_completed',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-1', success: true },
            } as any);
            appendLedgerEntry(meshId, {
                kind: 'task_dispatched',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-2', source: 'direct' },
            } as any);
            burySession(meshId);

            expect(hasDispatchAfterTerminal(meshId, sessionId, terminal.id)).toBe(true);
        });

        it('returns false when the only dispatch is BEFORE the terminal anchor', () => {
            const sessionId = 'sess-no-redispatch';
            appendLedgerEntry(meshId, {
                kind: 'task_dispatched',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-1', source: 'direct' },
            } as any);
            const terminal = appendLedgerEntry(meshId, {
                kind: 'task_completed',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-1', success: true },
            } as any);
            burySession(meshId, 10);

            expect(hasDispatchAfterTerminal(meshId, sessionId, terminal.id)).toBe(false);
        });
    });

    describe('hasUnterminalDirectDispatchLedgerEntry', () => {
        it('★finds an unterminated direct dispatch buried beyond the 200-entry tail window', () => {
            const sessionId = 'sess-direct-unterminal';
            appendLedgerEntry(meshId, {
                kind: 'task_dispatched',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-1', source: 'direct' },
            } as any);
            burySession(meshId);

            expect(hasUnterminalDirectDispatchLedgerEntry(meshId, sessionId)).toBe(true);
        });

        it('returns false once a terminal follows the direct dispatch, even when buried', () => {
            const sessionId = 'sess-direct-terminated';
            appendLedgerEntry(meshId, {
                kind: 'task_dispatched',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-1', source: 'direct' },
            } as any);
            appendLedgerEntry(meshId, {
                kind: 'task_completed',
                nodeId: 'node-a',
                sessionId,
                payload: { taskId: 'task-1', success: true },
            } as any);
            burySession(meshId);

            expect(hasUnterminalDirectDispatchLedgerEntry(meshId, sessionId)).toBe(false);
        });
    });

    describe('findTerminalLedgerEvidenceForTask', () => {
        it('★finds a task terminal buried beyond the 500-entry default tail window', () => {
            appendLedgerEntry(meshId, {
                kind: 'task_completed',
                nodeId: 'node-a',
                sessionId: 'sess-1',
                payload: { taskId: 'task-buried', success: true },
            } as any);
            burySession(meshId, 520);

            const evidence = findTerminalLedgerEvidenceForTask({ meshId, taskId: 'task-buried' });
            expect(evidence?.kind).toBe('task_completed');
        });

        it('returns null when no terminal exists for the taskId', () => {
            burySession(meshId, 10);
            expect(findTerminalLedgerEvidenceForTask({ meshId, taskId: 'task-none' })).toBeNull();
        });
    });

    // Sanity guard: confirms the READ path itself (readLedgerEntries with an explicit kind
    // filter) is what makes the above tests pass, not a store-level cap.
    it('sanity: a bare tail read over ALL kinds would in fact drop the buried entry (regression baseline)', () => {
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-a',
            sessionId: 'sess-baseline',
            payload: { taskId: 'task-baseline', success: true },
        } as any);
        burySession(meshId, 260);
        const bareTail = readLedgerEntries(meshId, { tail: 200 });
        expect(bareTail.some(e => e.kind === 'task_completed')).toBe(false);
    });
});
