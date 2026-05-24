import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
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
} from '../../src/mesh/mesh-ledger.js';
import type { MeshLedgerEntry, MeshLedgerKind } from '../../src/mesh/mesh-ledger.js';

describe('mesh-ledger', () => {
    const testMeshId = `test-mesh-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
    });

    afterEach(() => {
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
});
