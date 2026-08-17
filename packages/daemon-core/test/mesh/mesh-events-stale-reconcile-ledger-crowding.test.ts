import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// reconcileDirectDispatchCompletionFromTranscript's private helpers findDirectDispatchLedgerEntry
// and hasTerminalLedgerAfterDispatch read through readLedgerEntriesByKind. Redirect the store to
// a temp dir so the test never touches the real ~/.adhdev.
const testConfigDir = join(tmpdir(), `adhdev-reconcile-crowding-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { reconcileDirectDispatchCompletionFromTranscript } from '../../src/mesh/mesh-events-stale.js';
import { __clearMeshLedgerForTests, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js';

function burySession(meshId: string, n: number) {
    for (let i = 0; i < n; i++) {
        appendLedgerEntry(meshId, {
            kind: 'session_launched',
            nodeId: 'node-other',
            payload: { source: 'unrelated_traffic', seq: i },
        } as any);
    }
}

describe('reconcileDirectDispatchCompletionFromTranscript — LEDGER-KIND-TAIL-BLINDSPOT (private helpers)', () => {
    let meshId = `reconcile-crowding-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `reconcile-crowding-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        __clearMeshLedgerForTests(meshId);
    });

    // ★findDirectDispatchLedgerEntry + hasTerminalLedgerAfterDispatch: a dispatch row followed
    // by its real task_completed terminal, buried under 520+ unrelated entries, must still be
    // found — otherwise the reconcile path would write a DUPLICATE task_completed for a task
    // that already finished (alreadyTerminal must stay true even under crowding).
    it('★still detects an already-terminal task even when the dispatch + terminal rows are buried beyond the 500-entry tail window', () => {
        const taskId = 'task-buried-terminal';
        const sessionId = 'sess-buried-terminal';
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node-a',
            sessionId,
            payload: { taskId, source: 'direct' },
        } as any);
        burySession(meshId, 260);
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-a',
            sessionId,
            payload: { taskId, success: true, finalSummaryText: 'done for real' },
        } as any);
        burySession(meshId, 520);

        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: 'a later duplicate-looking transcript read',
            preValidatedTranscriptEvidence: true,
        });

        expect(result.reconciled).toBe(false);
        expect(result.alreadyTerminal).toBe(true);
    });

    it('reconciles normally (not alreadyTerminal) when there is no prior terminal, even under crowding', () => {
        const taskId = 'task-no-terminal';
        const sessionId = 'sess-no-terminal';
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node-a',
            sessionId,
            payload: { taskId, source: 'direct' },
        } as any);
        burySession(meshId, 260);

        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: 'genuinely the first completion',
            preValidatedTranscriptEvidence: true,
        });

        expect(result.alreadyTerminal).not.toBe(true);
    });
});
