import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// DUPNOTIF-DURABLE gap_a — hasIdenticalSynthesizedTerminal near-match idempotency.
//
// reconcileDirectDispatchCompletionFromTranscript has TWO live external callers —
// mesh-completion-synthesis.ts and mesh-reconcile-stranded-dispatch.ts — and both can
// fire for the same stalled task seconds apart. hasTerminalLedgerAfterDispatch
// deliberately SKIPS weak terminals (Fix C) so a genuine completion can still be
// synthesized over a false idle, which leaves hasIdenticalSynthesizedTerminal as the
// only backstop against the two producers double-writing.
//
// That backstop compared finalSummary by STRING EQUALITY. Each caller scrapes the
// worker's transcript independently, so an unstable scrape offset (one extra trailing
// line, a truncation boundary landing differently) made the two summaries of the SAME
// completion differ by a few characters — equality failed, both passed, both wrote.
// Measured live: session 3845d986 uttered one final summary three times.
//
// The fix mirrors supersedesTruncatedTerminalSummary's prefix/length comparison
// (mesh-event-forwarding.ts), read in the opposite direction, and is deliberately its
// exact complement at the 32-char threshold so a genuinely FULLER later synth still
// supersedes.

const testConfigDir = join(tmpdir(), `adhdev-synth-replay-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { reconcileDirectDispatchCompletionFromTranscript } from '../../src/mesh/mesh-events-stale.js';
import { __clearMeshLedgerForTests, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js';

const SUMMARY = 'Read-only audit complete. No files changed; 3 findings recorded in the report.';

/** A dispatch + the FIRST producer's synthesized weak terminal, as the live ledger had it. */
function seedDispatchAndSynthTerminal(meshId: string, taskId: string, sessionId: string, recordedSummary: string) {
    appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        nodeId: 'node-a',
        sessionId,
        payload: { taskId, source: 'direct' },
    } as any);
    appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node-a',
        sessionId,
        payload: {
            taskId,
            success: true,
            finalSummary: recordedSummary,
            // Stamped weak + reconcile-sourced exactly as the synth path records it, so
            // hasTerminalLedgerAfterDispatch skips it (Fix C) and the ONLY thing that can
            // stop a second write is hasIdenticalSynthesizedTerminal.
            evidenceLevel: 'insufficient',
            completionDiagnostic: { reason: 'direct_task_transcript_reconciliation', finalAssistantPresent: false },
        },
    } as any);
}

describe('reconcileDirectDispatchCompletionFromTranscript — synth replay near-match (gap_a)', () => {
    let meshId = `synth-replay-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `synth-replay-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        __clearMeshLedgerForTests(meshId);
    });

    it('REGRESSION: the second producer re-scraping the SAME completion with a trailing-newline drift does not double-write', () => {
        const taskId = 'task-scrape-drift';
        const sessionId = 'sess-scrape-drift';
        seedDispatchAndSynthTerminal(meshId, taskId, sessionId, SUMMARY);

        // mesh-reconcile-stranded-dispatch scrapes the same transcript moments later and
        // lands one character off. Pre-fix this !== the recorded summary → it wrote a
        // SECOND terminal and the coordinator was told a second time.
        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: `${SUMMARY}\n`,
            preValidatedTranscriptEvidence: true,
        });

        expect(result.reconciled).toBe(false);
    });

    it('REGRESSION: a re-scrape that picked up a few extra trailing characters does not double-write', () => {
        const taskId = 'task-scrape-tail';
        const sessionId = 'sess-scrape-tail';
        seedDispatchAndSynthTerminal(meshId, taskId, sessionId, SUMMARY);

        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: `${SUMMARY} (done)`,
            preValidatedTranscriptEvidence: true,
        });

        expect(result.reconciled).toBe(false);
    });

    it('REGRESSION: a re-scrape that TRUNCATED slightly relative to the recorded one does not double-write', () => {
        const taskId = 'task-scrape-short';
        const sessionId = 'sess-scrape-short';
        // The recorded terminal is the LONGER text this time — drift can go either way,
        // so the comparison must be symmetric.
        seedDispatchAndSynthTerminal(meshId, taskId, sessionId, `${SUMMARY} (done)`);

        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: SUMMARY,
            preValidatedTranscriptEvidence: true,
        });

        expect(result.reconciled).toBe(false);
    });

    it('an exact replay is still deduped (unchanged behaviour)', () => {
        const taskId = 'task-exact-replay';
        const sessionId = 'sess-exact-replay';
        seedDispatchAndSynthTerminal(meshId, taskId, sessionId, SUMMARY);

        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: SUMMARY,
            preValidatedTranscriptEvidence: true,
        });

        expect(result.reconciled).toBe(false);
    });

    it('★a genuinely FULLER later synth still supersedes — the weak-supersede design must not break', () => {
        const taskId = 'task-genuine-fuller';
        const sessionId = 'sess-genuine-fuller';
        // The recorded terminal is a truncated false-idle capture.
        seedDispatchAndSynthTerminal(meshId, taskId, sessionId, 'Read-only audit');

        // The REAL final arrives with substantially more text (well past the 32-char
        // complement threshold). This must NOT be swallowed — it is the corrected final,
        // and swallowing it would leave the coordinator stuck on the truncated text
        // forever (the one-shot-consumption symptom supersedesTruncatedTerminalSummary
        // exists to prevent).
        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: SUMMARY,
            preValidatedTranscriptEvidence: true,
        });

        expect(result.reconciled).toBe(true);
    });

    it('a completely DIFFERENT summary for the same task still writes (not a replay)', () => {
        const taskId = 'task-different-summary';
        const sessionId = 'sess-different-summary';
        seedDispatchAndSynthTerminal(meshId, taskId, sessionId, SUMMARY);

        const result = reconcileDirectDispatchCompletionFromTranscript({
            meshId,
            nodeId: 'node-a',
            sessionId,
            taskId,
            finalSummary: 'Applied the migration and pushed branch fix/foo; 12 files changed.',
            preValidatedTranscriptEvidence: true,
        });

        expect(result.reconciled).toBe(true);
    });
});
