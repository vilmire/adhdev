import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
    enqueueTask,
    recordDirectDispatchTask,
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
            const high = enqueueTask(meshId, 'urgent', { priority: 'high',
    difficulty: 'medium',
});
            expect(high.priority).to.equal('high');
            const normal = enqueueTask(meshId, 'ordinary', { priority: 'normal',
    difficulty: 'medium',
});
            expect(normal.priority).to.equal(undefined); // normal is the default → not stored
            const legacy = enqueueTask(meshId, 'legacy', { difficulty: 'medium' });
            expect(legacy.priority).to.equal(undefined);
            // Round-trips through the SQLite payload JSON.
            expect(getQueue(meshId).find(t => t.id === high.id)?.priority).to.equal('high');
        });

        it('claims a higher-priority task ahead of an older normal task', () => {
            const older = enqueueTask(meshId, 'older normal task', { difficulty: 'medium' });
            const urgent = enqueueTask(meshId, 'urgent fix', { priority: 'high',
    difficulty: 'medium',
});
            expect(older.createdAt <= urgent.createdAt).to.equal(true);
            // High priority is pulled first despite being enqueued later.
            const first = claimNextTask(meshId, 'node1', 'session1');
            expect(first?.id).to.equal(urgent.id);
            updateSessionTaskStatus(meshId, 'session1', 'completed');
            const second = claimNextTask(meshId, 'node1', 'session1');
            expect(second?.id).to.equal(older.id);
        });

        it('keeps FIFO order among equal-priority tasks (stable)', () => {
            const a = enqueueTask(meshId, 'A high', { priority: 'high',
    difficulty: 'medium',
});
            const b = enqueueTask(meshId, 'B high', { priority: 'high',
    difficulty: 'medium',
});
            const first = claimNextTask(meshId, 'node1', 'session1');
            expect(first?.id).to.equal(a.id); // older high wins the tie-break
            updateSessionTaskStatus(meshId, 'session1', 'completed');
            const second = claimNextTask(meshId, 'node1', 'session1');
            expect(second?.id).to.equal(b.id);
        });

        it('pulls a low-priority task last', () => {
            const low = enqueueTask(meshId, 'low task', { priority: 'low',
    difficulty: 'medium',
});
            const normal = enqueueTask(meshId, 'normal task', { difficulty: 'medium' });
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
            const delayed = enqueueTask(meshId, 'delayed task', { notBefore: future,
    difficulty: 'medium',
});
            expect(delayed.notBefore).to.not.equal(undefined);
            expect(meshTaskNotBeforeReady(delayed)).to.equal(false);
            // Not claimable while held.
            expect(claimNextTask(meshId, 'node1', 'session1')).to.be.null;
            // Simulate the gate passing: a not_before already in the past is ready.
            const readyNow = enqueueTask(meshId, 'ready task', { notBefore: Date.now() - 1_000,
    difficulty: 'medium',
});
            expect(meshTaskNotBeforeReady(readyNow)).to.equal(true);
            const claimed = claimNextTask(meshId, 'node1', 'session1');
            expect(claimed?.id).to.equal(readyNow.id); // the ready one is pulled; the delayed one stays pending
            expect(getQueue(meshId).find(t => t.id === delayed.id)?.status).to.equal('pending');
        });

        it('a task with no not_before is immediately claimable', () => {
            const t = enqueueTask(meshId, 'immediate', { difficulty: 'medium' });
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
            const capped = enqueueTask(meshId, 'capped task', { maxRetries: 3,
    difficulty: 'medium',
});
            expect(capped.maxRetries).to.equal(3);
            expect(getQueue(meshId).find(t => t.id === capped.id)?.maxRetries).to.equal(3);
            const legacy = enqueueTask(meshId, 'legacy task', { difficulty: 'medium' });
            expect(legacy.maxRetries).to.equal(undefined);
        });

        it('floors and rejects negative/invalid maxRetries', () => {
            expect(enqueueTask(meshId, 't1', { maxRetries: 2.9,
    difficulty: 'medium',
}).maxRetries).to.equal(2);
            expect(enqueueTask(meshId, 't2', { maxRetries: -1,
    difficulty: 'medium',
}).maxRetries).to.equal(undefined);
            expect(enqueueTask(meshId, 't3', { maxRetries: NaN,
    difficulty: 'medium',
}).maxRetries).to.equal(undefined);
            expect(enqueueTask(meshId, 't4', { maxRetries: 0,
    difficulty: 'medium',
}).maxRetries).to.equal(0);
        });
    });

    // DELIVERY-MSG-GUARD: upstream defence against a message-less task reaching the
    // queue/ledger and later crashing insertSessionDelivery's NOT NULL at claim/dispatch.
    // enqueueTask + recordDirectDispatchTask both normalize + hard-reject a blank message.
    describe('DELIVERY-MSG-GUARD — non-empty message required', () => {
        it('enqueueTask rejects undefined / null / blank messages', () => {
            expect(() => enqueueTask(meshId, undefined as unknown as string, { difficulty: 'medium' })).to.throw(/non-empty string/);
            expect(() => enqueueTask(meshId, null as unknown as string, { difficulty: 'medium' })).to.throw(/non-empty string/);
            expect(() => enqueueTask(meshId, '' as string, { difficulty: 'medium' })).to.throw(/non-empty string/);
            expect(() => enqueueTask(meshId, '   ' as string, { difficulty: 'medium' })).to.throw(/non-empty string/);
            // The crash class is undefined/blank; a non-string that stringifies to a
            // non-empty value (e.g. a number) is coerced to that string rather than rejected —
            // it never reaches insertSessionDelivery as a NULL, which is the invariant we protect.
            expect(getQueue(meshId).length).to.equal(0);
        });

        it('enqueueTask accepts a valid message and trims surrounding whitespace', () => {
            const t = enqueueTask(meshId, '  real work  ', { difficulty: 'medium' });
            expect(t.message).to.equal('real work');
            expect(getQueue(meshId).find(e => e.id === t.id)?.message).to.equal('real work');
        });

        it('recordDirectDispatchTask rejects blank/undefined messages', () => {
            expect(() => recordDirectDispatchTask(meshId, undefined as unknown as string, {
                id: `dd_${Date.now()}_a`, missionId: 'mission_x',
                difficulty: 'medium',
            })).to.throw(/non-empty string/);
            expect(() => recordDirectDispatchTask(meshId, '   ' as string, {
                id: `dd_${Date.now()}_b`, missionId: 'mission_x',
                difficulty: 'medium',
            })).to.throw(/non-empty string/);
            expect(getQueue(meshId).length).to.equal(0);
        });

        it('recordDirectDispatchTask accepts and trims a valid message', () => {
            const taskId = `dd_${Date.now()}_ok`;
            const entry = recordDirectDispatchTask(meshId, '  direct dispatch  ', {
                id: taskId, missionId: 'mission_y', assignedNodeId: 'node1', assignedSessionId: 'session1',
                difficulty: 'medium',
            });
            expect(entry?.message).to.equal('direct dispatch');
            expect(getQueue(meshId).find(e => e.id === taskId)?.message).to.equal('direct dispatch');
        });
    });
});
