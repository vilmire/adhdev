import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// LEDGER-TASK-TRACEABILITY regression suite. Covers B (taskId base-field promotion +
// kind+taskId join) and the back-compat invariant that legacy entries — written with
// taskId only inside payload, or with no taskId at all — still parse and join.

const testTmpDir = join(tmpdir(), `adhdev-ledger-trace-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    appendLedgerEntry,
    readLedgerEntries,
    ledgerEntryTaskId,
    getLedgerDir,
} from '../../src/mesh/mesh-ledger.js';
import type { MeshLedgerEntry } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('ledger task traceability', () => {
    const meshId = `test-mesh-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('(B) promotes payload.taskId to the base taskId field for task-lifecycle kinds', () => {
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node_a',
            sessionId: 'sess_1',
            providerType: 'claude-cli',
            payload: { taskId: 'task-42', routingDecision: { source: 'queue' } },
        });
        const [entry] = readLedgerEntries(meshId, { kind: ['task_dispatched'] });
        expect(entry.taskId).toBe('task-42');
        // payload copy is untouched (back-compat readers that key off payload still work).
        expect((entry.payload as any).taskId).toBe('task-42');
    });

    it('(B) does NOT invent a taskId for non-lifecycle kinds without one', () => {
        appendLedgerEntry(meshId, {
            kind: 'coordinator_started',
            payload: { note: 'boot' },
        });
        const [entry] = readLedgerEntries(meshId, { kind: ['coordinator_started'] });
        expect(entry.taskId).toBeUndefined();
    });

    it('(C) records a distinct task_claimed kind that joins task_dispatched by taskId', () => {
        appendLedgerEntry(meshId, {
            kind: 'task_claimed',
            nodeId: 'node_a', sessionId: 'sess_1', providerType: 'codex-cli',
            payload: { taskId: 'task-99', claimedAt: '2026-07-25T00:00:00.000Z' },
        });
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node_a', sessionId: 'sess_1', providerType: 'codex-cli',
            payload: { taskId: 'task-99', routingDecision: { source: 'autoLaunch' } },
        });
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node_a', sessionId: 'sess_1',
            payload: { taskId: 'task-99' },
        });

        // Join the full lifecycle by base taskId without scanning payloads.
        const all = readLedgerEntries(meshId);
        const lifecycle = all.filter(e => e.taskId === 'task-99').map(e => e.kind);
        expect(lifecycle).toEqual(expect.arrayContaining(['task_claimed', 'task_dispatched', 'task_completed']));
        expect(lifecycle.length).toBe(3);
    });

    it('(A/D) preserves the routingDecision sub-object through append+read', () => {
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node_b', sessionId: 'sess_2', providerType: 'claude-cli',
            taskId: 'task-7',
            payload: {
                taskId: 'task-7',
                missionId: 'm1',
                routingDecision: {
                    source: 'autoLaunch',
                    selectedNodeId: 'node_b',
                    fitnessScore: 121,
                    resolvedProviderType: 'claude-cli',
                    resolvedModel: 'opus',
                    resolvedThinkingLevel: 'high',
                    skippedCandidates: [{ nodeId: 'node_c', reason: 'dirty_workspace' }],
                    requiredTagsResult: { required: ['provider=claude-cli'], satisfied: true, missing: [] },
                },
            },
        });
        const [entry] = readLedgerEntries(meshId, { kind: ['task_dispatched'] });
        const rd = (entry.payload as any).routingDecision;
        expect(rd.source).toBe('autoLaunch');
        expect(rd.fitnessScore).toBe(121);
        expect(rd.resolvedModel).toBe('opus');
        expect(rd.resolvedThinkingLevel).toBe('high');
        expect(rd.skippedCandidates).toEqual([{ nodeId: 'node_c', reason: 'dirty_workspace' }]);
    });

    it('(back-compat) a legacy JSONL entry with taskId only in payload still resolves via fallback', () => {
        // Fresh meshId so the one-time JSONL→SQLite import for it hasn't run yet.
        const meshId = `legacy-mesh-${randomUUID().slice(0, 8)}`;
        // Simulate a pre-migration ledger file: an entry whose top-level has NO taskId,
        // written directly to the JSONL export artifact before the store imports it.
        const legacy: MeshLedgerEntry = {
            id: randomUUID(),
            meshId,
            timestamp: '2026-01-01T00:00:00.000Z',
            kind: 'task_dispatched',
            nodeId: 'node_legacy',
            payload: { taskId: 'legacy-task-1' },
        } as MeshLedgerEntry;
        // Strip the base field to mimic an old writer (defensive — it isn't set here anyway).
        delete (legacy as any).taskId;
        const filePath = join(getLedgerDir(), `${meshId}.jsonl`);
        if (!existsSync(getLedgerDir())) mkdirSync(getLedgerDir(), { recursive: true });
        appendFileSync(filePath, JSON.stringify(legacy) + '\n', { encoding: 'utf-8', mode: 0o600 });

        // First read triggers the one-time JSONL→SQLite import; the base taskId is
        // backfilled from payload.taskId so the join works for legacy rows too.
        const entries = readLedgerEntries(meshId, { kind: ['task_dispatched'] });
        const found = entries.find(e => e.id === legacy.id);
        expect(found).toBeDefined();
        expect(ledgerEntryTaskId(found!)).toBe('legacy-task-1');
    });

    it('(back-compat) a legacy entry with NO taskId anywhere parses without error', () => {
        const meshId = `legacy-mesh-${randomUUID().slice(0, 8)}`;
        const legacy: MeshLedgerEntry = {
            id: randomUUID(),
            meshId,
            timestamp: '2026-01-01T00:00:00.000Z',
            kind: 'checkpoint_created',
            payload: { note: 'legacy' },
        } as MeshLedgerEntry;
        const filePath = join(getLedgerDir(), `${meshId}.jsonl`);
        if (!existsSync(getLedgerDir())) mkdirSync(getLedgerDir(), { recursive: true });
        appendFileSync(filePath, JSON.stringify(legacy) + '\n', { encoding: 'utf-8', mode: 0o600 });

        const entries = readLedgerEntries(meshId);
        const found = entries.find(e => e.id === legacy.id);
        expect(found).toBeDefined();
        expect(found!.taskId).toBeUndefined();
        expect(ledgerEntryTaskId(found!)).toBeUndefined();
    });

    it('ledgerEntryTaskId prefers the base field over payload.taskId', () => {
        expect(ledgerEntryTaskId({ taskId: 'base', payload: { taskId: 'payload' } })).toBe('base');
        expect(ledgerEntryTaskId({ payload: { taskId: 'payload' } })).toBe('payload');
        expect(ledgerEntryTaskId({ taskId: '  ', payload: { taskId: 'payload' } })).toBe('payload');
        expect(ledgerEntryTaskId({ payload: {} })).toBeUndefined();
    });
});
