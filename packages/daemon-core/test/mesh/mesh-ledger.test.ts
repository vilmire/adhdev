import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Override home dir to use a temp directory for ledger storage
const testTmpDir = join(tmpdir(), `adhdev-ledger-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

// We need to mock getConfigDir before importing the module
import { vi } from 'vitest';

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
        return testConfigDir;
    },
}));

import {
    appendLedgerEntry,
    appendRemoteLedgerEntries,
    readLedgerEntries,
    readLedgerSlice,
    getLedgerSummary,
    getLedgerDir,
    MAX_LEDGER_SLICE_LIMIT,
    buildTaskCompletionEvidence,
    compactLedger,
    buildWorkerTaskFooter,
} from '../../src/mesh/mesh-ledger.js';
import type { MeshLedgerEntry, MeshLedgerKind } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mesh-ledger', () => {
    const testMeshId = `test-mesh-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
    });

    afterEach(() => {
        // Reset SQLite store so tests don't bleed into each other via the G2 ledger table.
        MeshRuntimeStore.resetForTests();
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    describe('buildTaskCompletionEvidence', () => {
        it('records deferred evidence for ordinary agent status completions', () => {
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'node_child_1',
                sessionId: 'runtime-session-1',
                providerType: 'hermes-cli',
                providerSessionId: 'provider-history-1',
                finalSummary: 'done',
                completedAt: '2026-05-13T13:20:47.000Z',
            });

            expect(evidence).toEqual({
                source: 'agent_status_event',
                event: 'agent:generating_completed',
                nodeId: 'node_child_1',
                sessionId: 'runtime-session-1',
                providerType: 'hermes-cli',
                completedAt: '2026-05-13T13:20:47.000Z',
                transcriptHandle: {
                    kind: 'provider_session',
                    sessionId: 'runtime-session-1',
                    providerSessionId: 'provider-history-1',
                    finalSummaryAvailable: true,
                },
                git: {
                    status: 'deferred',
                    reason: 'ordinary_completion_git_status_not_checked',
                },
                validation: {
                    status: 'deferred',
                    commandsRun: [],
                    reason: 'ordinary_completion_validation_not_run',
                },
                workerResult: {
                    status: 'unknown',
                    changedFiles: [],
                    validationResults: [],
                    processArtifacts: [],
                    errors: [],
                    requiresUserAction: false,
                    source: 'default',
                },
                checkpoint: {
                    attempted: false,
                    reason: 'not_attempted_for_ordinary_completion',
                },
            });
        });

        // FIX#2b — evidenceLevel was always 'insufficient' because resolveWorkerResult returned
        // source='default' whenever the finalSummary was not worker-result-shaped JSON — even when
        // a complete, valid (e.g. MAGI) JSON answer WAS present. resolveWorkerResult now upgrades
        // that case to source='parseable_answer' so the evidenceLevel branch (which marks ONLY
        // 'default' insufficient) resolves it to 'sufficient'.
        it("keeps source='default' for a prose-only final summary (no parseable answer)", () => {
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: 'I finished the investigation, all good.',
            });
            expect(evidence.workerResult.source).toBe('default');
        });

        it("upgrades to source='parseable_answer' when the final summary holds a parseable JSON answer that is NOT worker-result-shaped", () => {
            const magiAnswer = JSON.stringify({
                claims: [{ claim: 'X is the cause', stance: 'support', evidence: ['a.ts:1'], confidence: 0.9 }],
                top_findings: ['found X'],
                open_questions: [],
            });
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: magiAnswer,
            });
            // Not 'default' → the evidenceLevel branch will NOT mark it 'insufficient'.
            expect(evidence.workerResult.source).toBe('parseable_answer');
            expect(evidence.workerResult.source).not.toBe('default');
        });

        it("recognizes a fenced JSON answer in the final summary", () => {
            const fenced = 'Here is my answer:\n```json\n' + JSON.stringify({ answer: 42, reasoning: 'because' }) + '\n```';
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: fenced,
            });
            expect(evidence.workerResult.source).toBe('parseable_answer');
        });

        it("still prefers source='final_summary_json' when the summary IS a worker-result envelope", () => {
            const workerJson = JSON.stringify({ status: 'completed', changedFiles: ['a.ts'], nextAction: 'merge' });
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: workerJson,
            });
            // A real worker-result envelope is still 'final_summary_json' (self-attributing),
            // distinct from the weaker 'parseable_answer' tier.
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });
    });

    describe('appendLedgerEntry', () => {
        it('creates a new ledger file and appends an entry', () => {
            const entry = appendLedgerEntry(testMeshId, {
                kind: 'task_dispatched',
                nodeId: 'node_1',
                sessionId: 'session_1',
                payload: { message: 'test task' },
            });

            expect(entry.id).toBeTruthy();
            expect(entry.meshId).toBe(testMeshId);
            expect(entry.kind).toBe('task_dispatched');
            expect(entry.nodeId).toBe('node_1');
            expect(entry.sessionId).toBe('session_1');
            expect(entry.timestamp).toBeTruthy();
            expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
        });

        it('appends multiple entries to the same file', () => {
            appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: { message: 'task 1' } });
            appendLedgerEntry(testMeshId, { kind: 'task_completed', payload: { result: 'success' } });
            appendLedgerEntry(testMeshId, { kind: 'task_failed', payload: { error: 'timeout' } });

            const entries = readLedgerEntries(testMeshId);
            expect(entries).toHaveLength(3);
            expect(entries[0].kind).toBe('task_dispatched');
            expect(entries[1].kind).toBe('task_completed');
            expect(entries[2].kind).toBe('task_failed');
        });

        it('generates unique IDs for each entry', () => {
            const e1 = appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: {} });
            const e2 = appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: {} });
            expect(e1.id).not.toBe(e2.id);
        });

        it('preserves optional fields when provided', () => {
            const entry = appendLedgerEntry(testMeshId, {
                kind: 'session_launched',
                nodeId: 'node_a',
                sessionId: 'sess_123',
                providerType: 'hermes-cli',
                payload: { providerSessionId: 'prov_456' },
            });

            expect(entry.providerType).toBe('hermes-cli');

            const entries = readLedgerEntries(testMeshId);
            expect(entries[0].providerType).toBe('hermes-cli');
            expect(entries[0].payload.providerSessionId).toBe('prov_456');
        });
    });

    describe('readLedgerEntries', () => {
        it('returns empty array for non-existent mesh', () => {
            const entries = readLedgerEntries('non-existent-mesh');
            expect(entries).toEqual([]);
        });

        it('applies tail filter', () => {
            for (let i = 0; i < 10; i++) {
                appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: { index: i } });
            }

            const entries = readLedgerEntries(testMeshId, { tail: 3 });
            expect(entries).toHaveLength(3);
            expect(entries[0].payload.index).toBe(7);
            expect(entries[2].payload.index).toBe(9);
        });

        it('applies kind filter', () => {
            appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'task_completed', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'task_failed', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: {} });

            const dispatched = readLedgerEntries(testMeshId, { kind: ['task_dispatched'] });
            expect(dispatched).toHaveLength(2);
            expect(dispatched.every(e => e.kind === 'task_dispatched')).toBe(true);

            const failures = readLedgerEntries(testMeshId, { kind: ['task_failed'] });
            expect(failures).toHaveLength(1);
        });

        it('applies since filter', async () => {
            appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: {} });

            // Wait a bit to ensure different timestamps
            await new Promise(resolve => setTimeout(resolve, 10));
            const sinceDate = new Date().toISOString();

            appendLedgerEntry(testMeshId, { kind: 'task_completed', payload: {} });

            const entries = readLedgerEntries(testMeshId, { since: sinceDate });
            expect(entries).toHaveLength(1);
            expect(entries[0].kind).toBe('task_completed');
        });

        it('combines tail and kind filters', () => {
            for (let i = 0; i < 5; i++) {
                appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: { index: i } });
                appendLedgerEntry(testMeshId, { kind: 'task_completed', payload: { index: i } });
            }

            const entries = readLedgerEntries(testMeshId, { kind: ['task_dispatched'], tail: 2 });
            expect(entries).toHaveLength(2);
            expect(entries[0].payload.index).toBe(3);
            expect(entries[1].payload.index).toBe(4);
        });
    });

    describe('readLedgerSlice', () => {
        it('returns bounded cursor-addressable slices', () => {
            const entries: MeshLedgerEntry[] = [];
            for (let i = 0; i < 5; i++) {
                entries.push(appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: { index: i } }));
            }

            const first = readLedgerSlice(testMeshId, { limit: 2 });
            expect(first.protocol).toBe('adhdev.mesh.ledger.slice.v1');
            expect(first.entries).toHaveLength(2);
            expect(first.entries[0].payload.index).toBe(0);
            expect(first.cursor.afterId).toBeNull();
            expect(first.cursor.nextAfterId).toBe(entries[1].id);
            expect(first.cursor.hasMore).toBe(true);
            expect(first.sourceOfTruth.kind).toBe('local_jsonl');
            expect(first.sourceOfTruth.bounded).toBe(true);

            const second = readLedgerSlice(testMeshId, { afterId: first.cursor.nextAfterId ?? undefined, limit: 2 });
            expect(second.entries).toHaveLength(2);
            expect(second.entries[0].payload.index).toBe(2);
            expect(second.cursor.afterId).toBe(entries[1].id);
            expect(second.cursor.nextAfterId).toBe(entries[3].id);
            expect(second.cursor.hasMore).toBe(true);
        });

        it('clamps slice limit to the protocol maximum', () => {
            for (let i = 0; i < MAX_LEDGER_SLICE_LIMIT + 5; i++) {
                appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: { index: i } });
            }

            const slice = readLedgerSlice(testMeshId, { limit: MAX_LEDGER_SLICE_LIMIT + 100 });
            expect(slice.entries).toHaveLength(MAX_LEDGER_SLICE_LIMIT);
            expect(slice.cursor.limit).toBe(MAX_LEDGER_SLICE_LIMIT);
            expect(slice.cursor.hasMore).toBe(true);
        });
    });

    describe('appendRemoteLedgerEntries', () => {
        it('imports valid remote entries and skips duplicates', () => {
            const remoteEntry: MeshLedgerEntry = {
                id: `remote-${randomUUID()}`,
                meshId: testMeshId,
                timestamp: new Date().toISOString(),
                kind: 'task_completed',
                nodeId: 'node_remote',
                payload: { result: 'ok' },
            };

            const first = appendRemoteLedgerEntries(testMeshId, [remoteEntry]);
            expect(first.accepted).toBe(1);
            expect(first.skippedDuplicate).toBe(0);
            expect(first.rejectedInvalid).toBe(0);

            const duplicate = appendRemoteLedgerEntries(testMeshId, [remoteEntry]);
            expect(duplicate.accepted).toBe(0);
            expect(duplicate.skippedDuplicate).toBe(1);
            expect(duplicate.rejectedInvalid).toBe(0);

            const entries = readLedgerEntries(testMeshId);
            expect(entries.filter(entry => entry.id === remoteEntry.id)).toHaveLength(1);
        });

        it('rejects malformed and cross-mesh remote entries', () => {
            const valid: MeshLedgerEntry = {
                id: `remote-${randomUUID()}`,
                meshId: testMeshId,
                timestamp: new Date().toISOString(),
                kind: 'task_failed',
                payload: { error: 'boom' },
            };
            const result = appendRemoteLedgerEntries(testMeshId, [
                valid,
                { ...valid, id: `remote-${randomUUID()}`, meshId: 'different-mesh' },
                { ...valid, id: '', meshId: testMeshId },
            ] as MeshLedgerEntry[]);

            expect(result.accepted).toBe(1);
            expect(result.rejectedInvalid).toBe(2);
        });
    });

    describe('getLedgerSummary', () => {
        it('returns zero summary for empty mesh', () => {
            const summary = getLedgerSummary('empty-mesh');
            expect(summary.totalEntries).toBe(0);
            expect(summary.taskDispatched).toBe(0);
            expect(summary.taskCompleted).toBe(0);
            expect(summary.taskFailed).toBe(0);
            expect(summary.lastActivityAt).toBeNull();
        });

        it('correctly counts by kind', () => {
            appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'task_completed', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'task_failed', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'task_stalled', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'session_launched', payload: {} });
            appendLedgerEntry(testMeshId, { kind: 'checkpoint_created', payload: {} });

            const summary = getLedgerSummary(testMeshId);
            expect(summary.totalEntries).toBe(7);
            expect(summary.taskDispatched).toBe(2);
            expect(summary.taskCompleted).toBe(1);
            expect(summary.taskFailed).toBe(1);
            expect(summary.taskStalled).toBe(1);
            expect(summary.sessionLaunched).toBe(1);
            expect(summary.checkpointCreated).toBe(1);
            expect(summary.lastActivityAt).toBeTruthy();
        });

        it('counts recent failures within 30 minute window', () => {
            // Recent failure — should be counted
            appendLedgerEntry(testMeshId, { kind: 'task_failed', payload: {} });

            const summary = getLedgerSummary(testMeshId);
            expect(summary.recentFailures).toBe(1);
            expect(summary.taskFailed).toBe(1);
        });
    });

    describe('getLedgerDir', () => {
        it('creates the ledger directory', () => {
            const dir = getLedgerDir();
            expect(existsSync(dir)).toBe(true);
            expect(dir).toContain('mesh-ledger');
        });
    });

    describe('JSONL format', () => {
        it('writes one JSON object per line', () => {
            appendLedgerEntry(testMeshId, { kind: 'task_dispatched', payload: { a: 1 } });
            appendLedgerEntry(testMeshId, { kind: 'task_completed', payload: { b: 2 } });

            const safe = testMeshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filePath = join(getLedgerDir(), `${safe}.jsonl`);
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());

            expect(lines).toHaveLength(2);

            // Each line must be valid JSON
            for (const line of lines) {
                const parsed = JSON.parse(line);
                expect(parsed.id).toBeTruthy();
                expect(parsed.meshId).toBe(testMeshId);
            }
        });
    });

    describe('meshId sanitization', () => {
        it('sanitizes path traversal characters in meshId', () => {
            const maliciousMeshId = '../../../etc/passwd';
            const entry = appendLedgerEntry(maliciousMeshId, {
                kind: 'task_dispatched',
                payload: {},
            });

            expect(entry.meshId).toBe(maliciousMeshId);

            // File should be created with sanitized name
            const ledgerDir = getLedgerDir();
            const files = require('fs').readdirSync(ledgerDir);
            const match = files.find((f: string) => f.endsWith('.jsonl'));
            expect(match).toBeTruthy();
            expect(match).not.toContain('..');
        });
    });

    describe('compactLedger', () => {
        // Helper: build a ledger path for a given meshId (mirrors getLedgerPath internals)
        function ledgerPathFor(meshId: string): string {
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            return join(getLedgerDir(), `${safe}.jsonl`);
        }
        function archivePathFor(meshId: string): string {
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            return join(getLedgerDir(), `${safe}.archive.jsonl`);
        }
        function countsPathFor(meshId: string): string {
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            return join(getLedgerDir(), `${safe}.archived-counts.json`);
        }
        function writeEntries(meshId: string, entries: Omit<MeshLedgerEntry, 'id' | 'meshId'>[]): void {
            const ledgerPath = ledgerPathFor(meshId);
            const lines = entries.map(e => JSON.stringify({
                id: randomUUID(),
                meshId,
                ...e,
            })).join('\n') + '\n';
            writeFileSync(ledgerPath, lines, { encoding: 'utf-8' });
        }

        it('moves old terminal entries to archive, keeps non-terminal and recent terminal', () => {
            const meshId = `compact-test-${randomUUID().slice(0, 8)}`;
            const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
            const recentTs = new Date().toISOString();

            writeEntries(meshId, [
                // Two old terminal entries — should be archived
                { kind: 'task_completed', timestamp: oldTs, payload: { n: 1 } },
                { kind: 'task_failed', timestamp: oldTs, payload: { n: 2 } },
                // One non-terminal — always kept
                { kind: 'task_dispatched', timestamp: recentTs, payload: { n: 3 } },
                // One recent terminal — kept because not old enough
                { kind: 'task_completed', timestamp: recentTs, payload: { n: 4 } },
            ]);

            const result = compactLedger(meshId);

            expect(result).toEqual({ archivedCount: 2, retainedCount: 2 });

            // Archive file must exist with 2 lines
            const archivePath = archivePathFor(meshId);
            expect(existsSync(archivePath)).toBe(true);
            const archiveLines = readFileSync(archivePath, 'utf-8').split('\n').filter(l => l.trim());
            expect(archiveLines).toHaveLength(2);

            // Active file must have 2 entries
            const activeEntries = readLedgerEntries(meshId);
            expect(activeEntries).toHaveLength(2);
            const activeKinds = activeEntries.map(e => e.kind);
            expect(activeKinds).toContain('task_dispatched');
            expect(activeKinds).toContain('task_completed');
        });

        it('returns zero counts when all entries are recent', () => {
            const meshId = `compact-recent-${randomUUID().slice(0, 8)}`;
            const recentTs = new Date().toISOString();

            writeEntries(meshId, [
                { kind: 'task_completed', timestamp: recentTs, payload: {} },
                { kind: 'task_failed', timestamp: recentTs, payload: {} },
                { kind: 'task_dispatched', timestamp: recentTs, payload: {} },
            ]);

            const result = compactLedger(meshId);

            expect(result).toEqual({ archivedCount: 0, retainedCount: 3 });
            expect(existsSync(archivePathFor(meshId))).toBe(false);
        });

        it('does nothing on empty mesh', () => {
            const meshId = `compact-empty-${randomUUID().slice(0, 8)}`;
            const result = compactLedger(meshId);
            expect(result).toEqual({ archivedCount: 0, retainedCount: 0 });
        });

        it('never archives non-terminal kinds regardless of age', () => {
            const meshId = `compact-nonterminal-${randomUUID().slice(0, 8)}`;
            const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

            writeEntries(meshId, [
                { kind: 'task_dispatched', timestamp: oldTs, payload: {} },
                { kind: 'session_launched', timestamp: oldTs, payload: {} },
                { kind: 'node_cloned', timestamp: oldTs, payload: {} },
                { kind: 'checkpoint_created', timestamp: oldTs, payload: {} },
            ]);

            const result = compactLedger(meshId);

            expect(result.archivedCount).toBe(0);
            expect(result.retainedCount).toBe(4);
            expect(existsSync(archivePathFor(meshId))).toBe(false);
        });

        it('archives old session_auto_launch telemetry (write-only, no ledger reader), keeps recent', () => {
            const meshId = `compact-autolaunch-${randomUUID().slice(0, 8)}`;
            const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
            const recentTs = new Date().toISOString();

            writeEntries(meshId, [
                // Old auto-launch telemetry — should now be archived (it has no ledger reader).
                { kind: 'session_auto_launch', timestamp: oldTs, payload: { phase: 'skipped', taskId: 't1', reason: 'remote_auto_launch_unsupported' } },
                { kind: 'session_auto_launch', timestamp: oldTs, payload: { phase: 'started', taskId: 't2' } },
                // Recent auto-launch — kept for diagnosis.
                { kind: 'session_auto_launch', timestamp: recentTs, payload: { phase: 'skipped', taskId: 't3', reason: 'auto_launch_cooldown' } },
                // task_dispatched stays non-archivable (getSessionRecoveryContext reads it).
                { kind: 'task_dispatched', timestamp: oldTs, payload: { taskId: 't4' } },
            ]);

            const result = compactLedger(meshId);

            expect(result.archivedCount).toBe(2); // the two OLD auto-launch entries
            const activeKinds = readLedgerEntries(meshId).map(e => e.kind);
            // The recent auto-launch and the old task_dispatched both remain active.
            expect(activeKinds.filter(k => k === 'session_auto_launch')).toHaveLength(1);
            expect(activeKinds).toContain('task_dispatched');
        });

        it('updates archived-counts file', () => {
            const meshId = `compact-counts-${randomUUID().slice(0, 8)}`;
            const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

            writeEntries(meshId, [
                { kind: 'task_completed', timestamp: oldTs, payload: {} },
                { kind: 'task_completed', timestamp: oldTs, payload: {} },
                { kind: 'task_failed', timestamp: oldTs, payload: {} },
            ]);

            compactLedger(meshId);

            const countsPath = countsPathFor(meshId);
            expect(existsSync(countsPath)).toBe(true);

            const counts = JSON.parse(readFileSync(countsPath, 'utf-8'));
            expect(counts.taskCompleted).toBe(2);
            expect(counts.taskFailed).toBe(1);
            expect(counts.totalArchived).toBe(3);
            expect(typeof counts.lastArchivedAt).toBe('string');
            expect(counts.lastArchivedAt.length).toBeGreaterThan(0);
        });

        it('getLedgerSummary includes archived counts after compaction', () => {
            const meshId = `compact-summary-${randomUUID().slice(0, 8)}`;
            const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
            const recentTs = new Date().toISOString();

            writeEntries(meshId, [
                { kind: 'task_completed', timestamp: oldTs, payload: {} },
                { kind: 'task_completed', timestamp: oldTs, payload: {} },
                { kind: 'task_dispatched', timestamp: recentTs, payload: {} },
            ]);

            compactLedger(meshId);

            const summary = getLedgerSummary(meshId);
            // 2 archived task_completed + 1 live task_dispatched
            expect(summary.taskCompleted).toBe(2);
            expect(summary.taskDispatched).toBe(1);
            // totalEntries = 1 live + 2 archived
            expect(summary.totalEntries).toBe(3);
        });
    });

    describe('buildWorkerTaskFooter', () => {
        it('returns a string containing the structured result schema', () => {
            const footer = buildWorkerTaskFooter();
            expect(typeof footer).toBe('string');
            expect(footer.length).toBeGreaterThan(0);
            expect(footer).toContain('"status"');
            expect(footer).toContain('"changedFiles"');
            expect(footer).toContain('"gitStatus"');
            expect(footer).toContain('"validationResults"');
            expect(footer).toContain('"errors"');
            expect(footer).toContain('"nextAction"');
            expect(footer).toContain('completed');
        });
    });

    describe('extractJsonObjectFromSummary via buildTaskCompletionEvidence', () => {
        const baseOpts = {
            event: 'agent:generating_completed' as const,
            nodeId: 'n1',
            sessionId: 's1',
        };

        it('parses worker JSON with status and changedFiles', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: 'All done.\n```json\n{"status":"completed","changedFiles":["src/foo.ts"],"errors":[]}\n```',
            });
            expect(evidence.workerResult.status).toBe('completed');
            expect(evidence.workerResult.changedFiles).toEqual(['src/foo.ts']);
            expect(evidence.workerResult.errors).toEqual([]);
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });

        it('does not populate worker fields from generic JSON, but marks it parseable_answer (FIX#2b)', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: 'Some summary.\n```json\n{"foo":"bar","baz":123}\n```',
            });
            // extractJsonObjectFromSummary still rejects non-worker JSON, so NO worker fields are
            // fabricated (status stays 'unknown', changedFiles empty)…
            expect(evidence.workerResult.status).toBe('unknown');
            expect(evidence.workerResult.changedFiles).toEqual([]);
            // …but a parseable JSON answer is concrete evidence, so source is upgraded off 'default'
            // (FIX#2b: the evidenceLevel branch will not label this 'insufficient').
            expect(evidence.workerResult.source).toBe('parseable_answer');
        });

        it('accepts JSON with status + errors only', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: '```json\n{"status":"failed","errors":["build failed"]}\n```',
            });
            expect(evidence.workerResult.status).toBe('failed');
            expect(evidence.workerResult.errors).toContain('build failed');
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });

        it('accepts JSON with status + gitStatus', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: '```json\n{"status":"completed","gitStatus":{"branch":"feat/x","committed":true}}\n```',
            });
            expect(evidence.workerResult.status).toBe('completed');
            expect(evidence.workerResult.gitStatus).toEqual({ branch: 'feat/x', committed: true });
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });

        it('does not treat status-only JSON as a worker envelope, but marks it parseable_answer (FIX#2b)', () => {
            // "status" alone plus an unrelated field is not a worker envelope — need
            // changedFiles/errors/gitStatus/nextAction/validationResults — so worker fields are
            // NOT populated from it. It is still parseable JSON, so source upgrades off 'default'.
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: '```json\n{"status":"completed","message":"hello"}\n```',
            });
            // status stays 'unknown' (not lifted from the non-worker JSON's "status" field).
            expect(evidence.workerResult.status).toBe('unknown');
            expect(evidence.workerResult.source).toBe('parseable_answer');
        });
    });

    describe('ledger read cache', () => {
        it('returns same object reference for repeated reads within 100ms', () => {
            const meshId = `cache-ref-${randomUUID().slice(0, 8)}`;
            // Append an entry so the file exists
            appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: { n: 1 } });

            const first = readLedgerEntries(meshId);
            const second = readLedgerEntries(meshId);
            // Both calls must return the exact same array reference (cache hit)
            expect(second).toBe(first);
        });

        it('invalidates cache after appendLedgerEntry', () => {
            const meshId = `cache-append-${randomUUID().slice(0, 8)}`;
            appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: { n: 1 } });

            // Warm the cache
            const cached = readLedgerEntries(meshId);
            expect(cached).toHaveLength(1);

            // appendLedgerEntry must invalidate the cache
            appendLedgerEntry(meshId, { kind: 'task_completed', payload: { n: 2 } });

            const fresh = readLedgerEntries(meshId);
            expect(fresh).toHaveLength(2);
        });

        it('invalidates cache after appendRemoteLedgerEntries', () => {
            const meshId = `cache-remote-${randomUUID().slice(0, 8)}`;
            appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: { n: 1 } });

            // Warm the cache
            const cached = readLedgerEntries(meshId);
            expect(cached).toHaveLength(1);

            // appendRemoteLedgerEntries must invalidate the cache
            const remoteEntry: MeshLedgerEntry = {
                id: `remote-cache-${randomUUID()}`,
                meshId,
                timestamp: new Date().toISOString(),
                kind: 'task_completed',
                nodeId: 'node_remote',
                payload: { result: 'ok' },
            };
            appendRemoteLedgerEntries(meshId, [remoteEntry]);

            const fresh = readLedgerEntries(meshId);
            expect(fresh).toHaveLength(2);
        });

        it('invalidates cache after compactLedger', () => {
            const meshId = `cache-compact-${randomUUID().slice(0, 8)}`;
            const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
            const recentTs = new Date().toISOString();

            // Write old terminal entries + recent entries directly to the file
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filePath = join(getLedgerDir(), `${safe}.jsonl`);
            const entries = [
                { id: randomUUID(), meshId, timestamp: oldTs, kind: 'task_completed', payload: { n: 1 } },
                { id: randomUUID(), meshId, timestamp: oldTs, kind: 'task_failed', payload: { n: 2 } },
                { id: randomUUID(), meshId, timestamp: recentTs, kind: 'task_dispatched', payload: { n: 3 } },
            ];
            writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf-8' });

            // Warm the cache — 3 entries
            const cached = readLedgerEntries(meshId);
            expect(cached).toHaveLength(3);

            // compactLedger must invalidate the cache
            const result = compactLedger(meshId);
            // 2 old terminal entries archived, 1 recent non-terminal kept
            expect(result.archivedCount).toBe(2);
            expect(result.retainedCount).toBe(1);

            const fresh = readLedgerEntries(meshId);
            // Active file now has only the retained count worth of entries
            expect(fresh).toHaveLength(result.retainedCount);
        });
    });

    describe('readLedgerSlice summary matches getLedgerSummary for same mesh', () => {
        it('readLedgerSlice summary matches getLedgerSummary for same mesh', () => {
            const meshId = `slice-summary-${randomUUID().slice(0, 8)}`;
            appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: {} });
            appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: {} });
            appendLedgerEntry(meshId, { kind: 'task_completed', payload: {} });
            appendLedgerEntry(meshId, { kind: 'task_completed', payload: {} });
            appendLedgerEntry(meshId, { kind: 'task_failed', payload: {} });

            const slice = readLedgerSlice(meshId);
            const summary = getLedgerSummary(meshId);

            expect(slice.summary.totalEntries).toBe(summary.totalEntries);
            expect(slice.summary.taskDispatched).toBe(summary.taskDispatched);
            expect(slice.summary.taskCompleted).toBe(summary.taskCompleted);
            expect(slice.summary.taskFailed).toBe(summary.taskFailed);
            expect(slice.summary.meshId).toBe(meshId);
        });
    });

    describe('appendRemoteLedgerEntries dedup tail', () => {
        it('accepts entries that are outside the dedup tail window', () => {
            const meshId = `dedup-tail-${randomUUID().slice(0, 8)}`;

            // Write 5 entries directly to the ledger file (simulating existing history)
            const existingEntries: MeshLedgerEntry[] = Array.from({ length: 5 }, (_, i) => ({
                id: `existing-${randomUUID()}`,
                meshId,
                timestamp: new Date().toISOString(),
                kind: 'task_dispatched' as MeshLedgerKind,
                payload: { index: i },
            }));
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const ledgerPath = join(getLedgerDir(), `${safe}.jsonl`);
            writeFileSync(ledgerPath, existingEntries.map(e => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf-8' });

            // Re-submit the first existing entry — should be caught as a duplicate (within tail-1000)
            const dupResult = appendRemoteLedgerEntries(meshId, [existingEntries[0]]);
            expect(dupResult.skippedDuplicate).toBe(1);
            expect(dupResult.accepted).toBe(0);

            // Submit a brand-new remote entry — should be accepted
            const newRemoteEntry: MeshLedgerEntry = {
                id: `remote-new-${randomUUID()}`,
                meshId,
                timestamp: new Date().toISOString(),
                kind: 'task_completed',
                nodeId: 'node_remote',
                payload: { result: 'ok' },
            };
            // Note: the tail is 1000, so all 5 existing entries are within the dedup window
            const newResult = appendRemoteLedgerEntries(meshId, [newRemoteEntry]);
            expect(newResult.accepted).toBe(1);
            expect(newResult.skippedDuplicate).toBe(0);
        });
    });

    describe('G2 read cutover — SQLite primary, JSONL export/debug only', () => {
        it('reads from SQLite even when the JSONL file is deleted after append', () => {
            const meshId = `g2-cutover-${randomUUID().slice(0, 8)}`;
            appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: { n: 1 } });
            appendLedgerEntry(meshId, { kind: 'task_completed', payload: { n: 2 } });

            // Delete the JSONL artifact — runtime reads must survive on SQLite alone.
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            rmSync(join(getLedgerDir(), `${safe}.jsonl`), { force: true });

            const entries = readLedgerEntries(meshId);
            expect(entries).toHaveLength(2);
            expect(entries.map(e => e.kind)).toEqual(['task_dispatched', 'task_completed']);
        });

        it('one-time imports legacy JSONL entries without duplicating dual-written ones', () => {
            const meshId = `g2-import-${randomUUID().slice(0, 8)}`;

            // Legacy JSONL written before the cutover (not in SQLite).
            const legacy: MeshLedgerEntry = {
                id: `legacy-${randomUUID()}`,
                meshId,
                timestamp: new Date(Date.now() - 60_000).toISOString(),
                kind: 'task_dispatched',
                payload: { legacy: true },
            };
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            writeFileSync(join(getLedgerDir(), `${safe}.jsonl`), JSON.stringify(legacy) + '\n', { encoding: 'utf-8' });

            // Dual-written entry after the cutover.
            appendLedgerEntry(meshId, { kind: 'task_completed', payload: { fresh: true } });

            const entries = readLedgerEntries(meshId);
            expect(entries).toHaveLength(2);
            expect(entries[0].id).toBe(legacy.id);
            expect(entries[1].kind).toBe('task_completed');

            // Re-reading must not re-import or duplicate.
            const again = readLedgerEntries(meshId);
            expect(again).toHaveLength(2);
        });

        it('compactLedger removes archived entries from SQLite as well as JSONL', () => {
            const meshId = `g2-compact-${randomUUID().slice(0, 8)}`;
            const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

            // Old terminal entry (archivable) + fresh entry, written to both stores.
            const oldEntry: MeshLedgerEntry = {
                id: `old-${randomUUID()}`,
                meshId,
                timestamp: oldTimestamp,
                kind: 'task_completed',
                payload: { old: true },
            };
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            writeFileSync(join(getLedgerDir(), `${safe}.jsonl`), JSON.stringify(oldEntry) + '\n', { encoding: 'utf-8' });
            appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: { fresh: true } });

            const result = compactLedger(meshId);
            expect(result.archivedCount).toBe(1);

            // SQLite runtime view mirrors the compacted active set.
            const entries = readLedgerEntries(meshId);
            expect(entries).toHaveLength(1);
            expect(entries[0].kind).toBe('task_dispatched');
            expect(MeshRuntimeStore.getInstance().hasLedgerEntry(meshId, oldEntry.id)).toBe(false);
        });

        it('appendRemoteLedgerEntries lands remote entries in SQLite', () => {
            const meshId = `g2-remote-${randomUUID().slice(0, 8)}`;
            const remote: MeshLedgerEntry = {
                id: `remote-${randomUUID()}`,
                meshId,
                timestamp: new Date().toISOString(),
                kind: 'task_completed',
                nodeId: 'node_remote',
                payload: { remote: true },
            };
            const result = appendRemoteLedgerEntries(meshId, [remote]);
            expect(result.accepted).toBe(1);
            expect(MeshRuntimeStore.getInstance().hasLedgerEntry(meshId, remote.id)).toBe(true);

            // Delete JSONL — remote entry must still be readable from SQLite.
            const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
            rmSync(join(getLedgerDir(), `${safe}.jsonl`), { force: true });
            const entries = readLedgerEntries(meshId);
            expect(entries.map(e => e.id)).toContain(remote.id);
        });
    });
});
