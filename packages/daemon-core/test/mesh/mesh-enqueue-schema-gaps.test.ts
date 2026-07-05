import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
    enqueueTask,
    getQueue,
    claimNextTask,
    updateSessionTaskStatus,
    meshTaskPriorityRank,
    normalizeMeshTaskPriority,
    resolveNotBefore,
    meshTaskNotBeforeReady,
    NOT_BEFORE_RELATIVE_THRESHOLD_MS,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js';

// MESH-PRIMITIVES-GAPS WT-C: enqueue schema bundle — G6 (task priority), G7 (not_before
// delayed execution), P3 (maxRetries exposure). G4 (duplicate detection) lives in the
// mcp-server enqueue handler and is exercised at that layer; the pieces it reuses from
// daemon-core (queue introspection) are covered by the existing work-queue suite.
describe('mesh enqueue schema gaps (WT-C: G6/G7/P3)', () => {
    const meshId = `test_mesh_gaps_${Date.now()}`;
    const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`);

    beforeEach(() => {
        __clearMeshQueueForTests(meshId);
        if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
    });
    afterEach(() => {
        __clearMeshQueueForTests(meshId);
        __resetMeshRuntimeStoreForTests();
        if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
    });

    describe('G6 — task-level priority', () => {
        it('normalizes priority input and ranks high > normal > low', () => {
            expect(normalizeMeshTaskPriority('high')).to.equal('high');
            expect(normalizeMeshTaskPriority('low')).to.equal('low');
            expect(normalizeMeshTaskPriority('normal')).to.equal('normal');
            expect(normalizeMeshTaskPriority('urgent')).to.equal(undefined);
            expect(normalizeMeshTaskPriority(undefined)).to.equal(undefined);
            expect(meshTaskPriorityRank('high')).to.be.greaterThan(meshTaskPriorityRank('normal'));
            expect(meshTaskPriorityRank('normal')).to.be.greaterThan(meshTaskPriorityRank('low'));
            // Absent/unknown → normal rank.
            expect(meshTaskPriorityRank(undefined)).to.equal(meshTaskPriorityRank('normal'));
        });

        it('persists a non-default priority and omits normal to keep rows minimal', () => {
            const high = enqueueTask(meshId, 'urgent', { priority: 'high' });
            expect(high.priority).to.equal('high');
            const normal = enqueueTask(meshId, 'ordinary', { priority: 'normal' });
            expect(normal.priority).to.equal(undefined); // normal is the default → not stored
            const legacy = enqueueTask(meshId, 'legacy');
            expect(legacy.priority).to.equal(undefined);
            // Round-trips through the SQLite payload JSON.
            expect(getQueue(meshId).find(t => t.id === high.id)?.priority).to.equal('high');
        });

        it('claims a higher-priority task ahead of an older normal task', () => {
            const older = enqueueTask(meshId, 'older normal task');
            const urgent = enqueueTask(meshId, 'urgent fix', { priority: 'high' });
            expect(older.createdAt <= urgent.createdAt).to.equal(true);
            // High priority is pulled first despite being enqueued later.
            const first = claimNextTask(meshId, 'node1', 'session1');
            expect(first?.id).to.equal(urgent.id);
            updateSessionTaskStatus(meshId, 'session1', 'completed');
            const second = claimNextTask(meshId, 'node1', 'session1');
            expect(second?.id).to.equal(older.id);
        });

        it('keeps FIFO order among equal-priority tasks (stable)', () => {
            const a = enqueueTask(meshId, 'A high', { priority: 'high' });
            const b = enqueueTask(meshId, 'B high', { priority: 'high' });
            const first = claimNextTask(meshId, 'node1', 'session1');
            expect(first?.id).to.equal(a.id); // older high wins the tie-break
            updateSessionTaskStatus(meshId, 'session1', 'completed');
            const second = claimNextTask(meshId, 'node1', 'session1');
            expect(second?.id).to.equal(b.id);
        });

        it('pulls a low-priority task last', () => {
            const low = enqueueTask(meshId, 'low task', { priority: 'low' });
            const normal = enqueueTask(meshId, 'normal task');
            const first = claimNextTask(meshId, 'node1', 'session1');
            expect(first?.id).to.equal(normal.id);
            updateSessionTaskStatus(meshId, 'session1', 'completed');
            const second = claimNextTask(meshId, 'node1', 'session1');
            expect(second?.id).to.equal(low.id);
        });
    });

    describe('G7 — not_before delayed execution', () => {
        it('resolveNotBefore handles absolute epoch-ms, relative-ms, ISO, and past values', () => {
            const now = 1_000_000_000_000; // fixed base for determinism
            // Relative offset (below the ~1yr threshold) → now + offset.
            const rel = resolveNotBefore(60_000, now);
            expect(Date.parse(rel!)).to.equal(now + 60_000);
            // Absolute epoch-ms (above the threshold) → that timestamp.
            const absMs = now + NOT_BEFORE_RELATIVE_THRESHOLD_MS + 5_000;
            const abs = resolveNotBefore(absMs, now);
            expect(Date.parse(abs!)).to.equal(absMs);
            // ISO string.
            const iso = new Date(now + 120_000).toISOString();
            expect(Date.parse(resolveNotBefore(iso, now)!)).to.equal(now + 120_000);
            // Past / negative → clamped to now (immediately claimable).
            expect(Date.parse(resolveNotBefore(-5_000, now)!)).to.equal(now);
            // Absent / invalid.
            expect(resolveNotBefore(undefined, now)).to.equal(undefined);
            expect(resolveNotBefore('not-a-date', now)).to.equal(undefined);
        });

        it('holds a task pending until not_before, then allows the claim', () => {
            const future = Date.now() + 60_000;
            const delayed = enqueueTask(meshId, 'delayed task', { notBefore: future });
            expect(delayed.notBefore).to.not.equal(undefined);
            expect(meshTaskNotBeforeReady(delayed)).to.equal(false);
            // Not claimable while held.
            expect(claimNextTask(meshId, 'node1', 'session1')).to.be.null;
            // Simulate the gate passing: a not_before already in the past is ready.
            const readyNow = enqueueTask(meshId, 'ready task', { notBefore: Date.now() - 1_000 });
            expect(meshTaskNotBeforeReady(readyNow)).to.equal(true);
            const claimed = claimNextTask(meshId, 'node1', 'session1');
            expect(claimed?.id).to.equal(readyNow.id); // the ready one is pulled; the delayed one stays pending
            expect(getQueue(meshId).find(t => t.id === delayed.id)?.status).to.equal('pending');
        });

        it('a task with no not_before is immediately claimable', () => {
            const t = enqueueTask(meshId, 'immediate');
            expect(t.notBefore).to.equal(undefined);
            expect(meshTaskNotBeforeReady(t)).to.equal(true);
            expect(claimNextTask(meshId, 'node1', 'session1')?.id).to.equal(t.id);
        });

        it('fails open on an unparseable notBefore (never strands work)', () => {
            expect(meshTaskNotBeforeReady({ notBefore: 'garbage' })).to.equal(true);
        });
    });

    describe('P3 — maxRetries exposure', () => {
        it('persists an explicit maxRetries and omits it when absent', () => {
            const capped = enqueueTask(meshId, 'capped task', { maxRetries: 3 });
            expect(capped.maxRetries).to.equal(3);
            expect(getQueue(meshId).find(t => t.id === capped.id)?.maxRetries).to.equal(3);
            const legacy = enqueueTask(meshId, 'legacy task');
            expect(legacy.maxRetries).to.equal(undefined);
        });

        it('floors and rejects negative/invalid maxRetries', () => {
            expect(enqueueTask(meshId, 't1', { maxRetries: 2.9 }).maxRetries).to.equal(2);
            expect(enqueueTask(meshId, 't2', { maxRetries: -1 }).maxRetries).to.equal(undefined);
            expect(enqueueTask(meshId, 't3', { maxRetries: NaN }).maxRetries).to.equal(undefined);
            expect(enqueueTask(meshId, 't4', { maxRetries: 0 }).maxRetries).to.equal(0);
        });
    });
});
